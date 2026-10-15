"""Forex Radar backend. READ-ONLY: reads MT5 data, writes signals to Firebase.
There is no order_send anywhere in this project. Keep it that way."""
import os, time, queue
import numpy as np
import pandas as pd
import MetaTrader5 as mt5
import lightgbm as lgb
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import TimeSeriesSplit
import firebase_admin
from firebase_admin import credentials, db
from dotenv import load_dotenv

load_dotenv()
PAIRS = [p.strip() for p in os.getenv("PAIRS", "EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD").split(",")]
SUFFIX = os.getenv("SYMBOL_SUFFIX", "")          # e.g. "m" or ".r" if your broker adds one
THR = float(os.getenv("CONF_THRESHOLD", "0.55"))  # min probability to call BUY/SELL
H, K = 10, 0.6                                    # label: move > K*ATR within H bars
TFS = {"M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15,
       "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4}


CFG = {"threshold": THR, "paused": False}      # admin can change these live from the dashboard
CMDS = queue.Queue()


def on_config(ev):
    if ev.data is None: return
    if ev.path == "/" and isinstance(ev.data, dict):
        CFG.update({k: v for k, v in ev.data.items() if k in CFG})
    elif ev.path.strip("/") in CFG:
        CFG[ev.path.strip("/")] = ev.data


def on_cmd(ev):
    if ev.path == "/": return                  # ignore anything queued before startup
    if isinstance(ev.data, dict) and ev.data.get("type") in ("refresh", "retrain"):
        CMDS.put((ev.path.strip("/"), ev.data))


def init_mt5():
    login = os.getenv("MT5_LOGIN")
    if login:
        return mt5.initialize(login=int(login), password=os.getenv("MT5_INVESTOR_PASSWORD"),
                              server=os.getenv("MT5_SERVER"))
    return mt5.initialize()


def ema(s, n): return s.ewm(span=n, adjust=False).mean()

def rsi(c, n=14):
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1/n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1/n, adjust=False).mean()
    return 100 - 100 / (1 + up / (dn + 1e-12))

def atr(df, n=14):
    tr = pd.concat([df.high - df.low, (df.high - df.close.shift()).abs(),
                    (df.low - df.close.shift()).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1/n, adjust=False).mean()

def to_df(rates):
    df = pd.DataFrame(rates)
    df["time"] = pd.to_datetime(df["time"], unit="s")
    return df.set_index("time")

def features(df):
    c, a = df.close, atr(df)
    f = pd.DataFrame(index=df.index)
    f["r1"], f["r5"], f["r15"] = [(c - c.shift(n)) / a for n in (1, 5, 15)]
    f["ema"] = (ema(c, 9) - ema(c, 21)) / a
    f["rsi"] = rsi(c)
    f["vol"] = a / c
    f["volr"] = a / a.rolling(100).mean()
    f["hour"] = df.index.hour
    return f

def train(sym):
    df = to_df(mt5.copy_rates_from_pos(sym, mt5.TIMEFRAME_M1, 0, 40000))
    f, a = features(df), atr(df)
    fut = (df.close.shift(-H) - df.close) / a
    y = pd.Series(0, index=df.index)
    y[fut > K], y[fut < -K] = 1, 2                # 0 wait, 1 buy, 2 sell
    ok = f.dropna().index.intersection(fut.dropna().index)
    X, y = f.loc[ok], y.loc[ok]
    cut = int(len(X) * 0.8)                       # time-ordered split, no shuffling
    base = lgb.LGBMClassifier(n_estimators=200, learning_rate=0.05, num_leaves=15,
                              min_child_samples=100, subsample=0.8,
                              colsample_bytree=0.8, verbose=-1)
    cal = CalibratedClassifierCV(base, method="sigmoid", cv=TimeSeriesSplit(3), ensemble=False)
    cal.fit(X.iloc[:cut], y.iloc[:cut])
    p = cal.predict_proba(X.iloc[cut:])
    yt = y.iloc[cut:].values
    pred = p.argmax(1)
    strong = (p[:, 1:].max(1) >= THR) & (pred > 0)
    hit = float((pred[strong] == yt[strong]).mean()) if strong.sum() else None
    stats = {"holdout_hit_rate": hit, "holdout_signals": int(strong.sum()),
             "holdout_bars": int(len(yt))}
    print(sym, stats)
    return cal, stats

def tf_trends(sym):
    out = {}
    for name, tf in TFS.items():
        r = mt5.copy_rates_from_pos(sym, tf, 0, 100)
        if r is None or len(r) < 30: out[name] = 0; continue
        c = pd.DataFrame(r).close
        out[name] = 1 if ema(c, 9).iloc[-1] > ema(c, 21).iloc[-1] else -1
    return out


def main():
    if not init_mt5(): raise SystemExit(f"MT5 init failed: {mt5.last_error()}")
    firebase_admin.initialize_app(
        credentials.Certificate(os.getenv("FIREBASE_KEY", "serviceAccount.json")),
        {"databaseURL": os.environ["FIREBASE_DB_URL"]})
    root = db.reference("/")
    root.child("commands").delete()
    if root.child("config").get() is None: root.child("config").set(CFG)
    root.child("config").listen(on_config)
    root.child("commands").listen(on_cmd)
    meta = {"startedAt": db.ServerValue.TIMESTAMP}

    syms = [p + SUFFIX for p in PAIRS]
    for s in syms: mt5.symbol_select(s, True)
    models = {s: train(s) for s in syms}
    st = {s: {"sig": "WAIT", "conf": 0.0, "danger_until": 0, "reason": "",
              "msec": 0, "msec_at": time.time(), "tf": {}, "tf_at": 0, "w": 0}
          for s in syms}

    last_status = 0
    while True:
        t0 = time.time()
        ti = mt5.terminal_info()
        if not (ti and ti.connected):                    # auto-reconnect keeps the feed alive
            mt5.shutdown()
            if not init_mt5():
                root.child("status").update({"mt5Connected": False})
                time.sleep(3); continue
            for s in syms: mt5.symbol_select(s, True)
        while not CMDS.empty():
            cid, cmd = CMDS.get()
            if cmd["type"] == "retrain":
                models = {s: train(s) for s in syms}
                meta["lastRetrain"] = db.ServerValue.TIMESTAMP
            for d in st.values(): d["w"], d["tf_at"] = 0, 0     # force a fresh write for every pair
            meta["lastRefresh"] = db.ServerValue.TIMESTAMP
            root.child("commands").child(cid).delete()
        for s in syms:
            try:
                r = mt5.copy_rates_from_pos(s, mt5.TIMEFRAME_M1, 0, 600)
                tick, info = mt5.symbol_info_tick(s), mt5.symbol_info(s)
                if r is None or tick is None: continue
                d = st[s]
                if tick.time_msc != d["msec"]: d["msec"], d["msec_at"] = tick.time_msc, t0
                age = t0 - d["msec_at"]
                df = to_df(r); f = features(df).iloc[[-1]]
                if f.isna().any(axis=None): continue
                pw, pb, ps = models[s][0].predict_proba(f)[0]
                sig = "WAIT"
                if max(pb, ps) >= CFG["threshold"] and abs(pb - ps) >= 0.15:
                    sig = "BUY" if pb > ps else "SELL"
                conf = float(max(pb, ps))
                prev, reason = d["sig"], ""
                if f["volr"].iloc[0] > 2.0: reason = "Volatility spike"
                elif prev in ("BUY", "SELL") and sig in ("BUY", "SELL") and sig != prev:
                    reason = "Momentum reversed"
                elif prev in ("BUY", "SELL") and d["conf"] - conf > 0.15:
                    reason = "Confidence collapsed"
                if reason: d["danger_until"], d["reason"] = t0 + 60, reason
                if t0 < d["danger_until"]: sig = "DANGER"
                else: d["reason"] = ""
                if CFG["paused"]: sig, d["reason"] = "PAUSED", "Paused by admin"
                if t0 - d["tf_at"] > 15: d["tf"], d["tf_at"] = tf_trends(s), t0
                changed = sig != prev
                payload = {
                    "pair": s[:len(s) - len(SUFFIX)] if SUFFIX else s,
                    "bid": tick.bid, "ask": tick.ask,
                    "spread": info.spread if info else None,
                    "signal": sig, "reason": d["reason"], "ts": db.ServerValue.TIMESTAMP,
                    "pBuy": round(float(pb), 3), "pSell": round(float(ps), 3),
                    "pWait": round(float(pw), 3),
                    "trend": "BULLISH" if f["ema"].iloc[0] > 0.3 else "BEARISH" if f["ema"].iloc[0] < -0.3 else "FLAT",
                    "volatility": "HIGH" if f["volr"].iloc[0] > 1.5 else "LOW" if f["volr"].iloc[0] < 0.7 else "NORMAL",
                    "tf": d["tf"], "spark": [round(x, 5) for x in df.close.tail(60)],
                    "tickAgeSec": round(age, 1), "stale": age > 30,
                    "model": models[s][1],
                }
                if changed or t0 - d["w"] >= 2:
                    root.child("signals").child(payload["pair"]).set(payload)
                    d["w"] = t0
                if changed and (sig in ("BUY", "SELL", "DANGER") or prev in ("BUY", "SELL", "DANGER")):
                    root.child("alerts").push({"pair": payload["pair"], "from": prev, "to": sig,
                                               "reason": d["reason"], "conf": round(conf, 2),
                                               "ts": db.ServerValue.TIMESTAMP})
                d["sig"], d["conf"] = sig, conf if sig in ("BUY", "SELL") else d["conf"]
            except Exception as e:
                print("loop error", s, e)
        root.child("heartbeat").set(db.ServerValue.TIMESTAMP)
        if t0 - last_status > 5:
            root.child("status").update({**meta, "mt5Connected": True, "paused": CFG["paused"],
                                         "threshold": CFG["threshold"]})
            last_status = t0
        time.sleep(max(0.0, 1.0 - (time.time() - t0)))


if __name__ == "__main__":
    main()
