"use strict";
// Steve FX Radar engine. Runs 24/7 on a server and writes the same feed and results the web page uses.
// The signal maths below is a copy of the page's engine, so both produce the same signals.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function ema(a, n) { const k = 2 / (n + 1), o = [a[0]]; for (let i = 1; i < a.length; i++) o.push(a[i] * k + o[i - 1] * (1 - k)); return o; }
function series(cd) {
  const c = cd.map(x => x.c), n = c.length, e9 = ema(c, 9), e21 = ema(c, 21), e50 = ema(c, 50);
  const atr = [cd[0].h - cd[0].l], rs = [50]; let g = 0, l = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(cd[i].h - cd[i].l, Math.abs(cd[i].h - c[i - 1]), Math.abs(cd[i].l - c[i - 1]));
    atr.push((atr[i - 1] * 13 + tr) / 14);
    const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14;
    rs.push(100 - 100 / (1 + g / (l || 1e-12)));
  }
  return { c, e9, e21, e50, atr, rs };
}
function dirAt(S, i) {
  const { c, e9, e21, e50, atr, rs } = S, a = atr[i] || 1e-9;
  const trend = e9[i] > e21[i] && e21[i] > e50[i] ? 1 : e9[i] < e21[i] && e21[i] < e50[i] ? -1 : (e9[i] > e21[i] ? .3 : -.3);
  const mom = clamp((c[i] - c[i - 5]) / a, -2, 2) / 2 * .8, r = rs[i];
  const rt = r >= 75 ? -.5 : r > 55 ? .5 : r <= 25 ? .5 : r < 45 ? -.5 : 0;
  return Math.tanh((trend + mom + rt) / 1.5);
}
function volRatio(S, i) { let m = 0, k = 0; for (let j = Math.max(0, i - 100); j <= i; j++) { m += S.atr[j]; k++; } return S.atr[i] / (m / k || 1e-9); }
function backtest(S, thr, H = 10) {
  let hit = 0, miss = 0, n = S.c.length; const fav = [], adv = [], sw = [];
  for (let i = 120; i < n - H; i++) {
    sw.push(Math.abs(S.c[i + H] - S.c[i]));
    const d = dirAt(S, i); if (Math.abs(d) < thr) continue;
    const sg = Math.sign(d); let mf = 0, ma = 0;
    for (let j = 1; j <= H; j++) { const e = (S.c[i + j] - S.c[i]) / S.atr[i] * sg; if (e > mf) mf = e; if (-e > ma) ma = -e; }
    fav.push(mf); adv.push(ma);
    const f = (S.c[i + H] - S.c[i]) / S.atr[i] * sg;
    if (f > .3) hit++; else if (f < -.3) miss++;
  }
  const q = (a, p) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
  return { hit, miss, rate: hit + miss ? hit / (hit + miss) : null, n: fav.length, t1: q(fav, .5), t2: q(fav, .75), sl: q(adv, .75), swing: q(sw, .5) };
}
function tfTrend(c, step) {
  const r = []; for (let i = c.length - 1; i >= 0 && r.length < 60; i -= step) r.unshift(c[i]);
  if (r.length < 22) return 0; const a = ema(r, 9), b = ema(r, 21); return a[a.length - 1] > b[b.length - 1] ? 1 : -1;
}
function levels(p, atr, dir) {
  const bt = p.bt, ok = !!(bt && bt.n >= 8 && bt.t1 != null), sg = dir >= 0 ? 1 : -1, e = p.price;
  let k1 = ok ? bt.t1 : 1, k2 = ok ? bt.t2 : 1.8, ks = ok ? bt.sl : 1;
  k1 = clamp(k1, .3, 3); k2 = Math.max(clamp(k2, .5, 4), k1 + .3); ks = clamp(ks, .5, 3);
  return { entry: e, atr, t1: e + sg * k1 * atr, t2: e + sg * k2 * atr, stop: e - sg * ks * atr, src: ok ? "history" : "default", n: ok ? bt.n : 0, swing: bt && bt.swing != null ? bt.swing : atr * 2 };
}
function dayStats(S, price) {
  const c = S.c, n = Math.min(c.length, 1440), w = c.slice(-n), hi = Math.max(...w), lo = Math.min(...w), op = w[0], rng = hi - lo || 1e-9;
  const h1 = tfTrend(c, 60), m30 = tfTrend(c, 30), m15 = tfTrend(c, 15), ups = [h1, m30, m15].filter(v => v > 0).length;
  return { hi, lo, chg: (price - op) / op * 100, pos: clamp((price - lo) / rng, 0, 1), hours: Math.round(n / 60), h1, m30, m15, bias: ups === 3 ? "UP" : ups === 0 ? "DOWN" : "MIXED", vr: volRatio(S, c.length - 1) };
}

const CHTF = [["m1", 1, 150], ["m5", 5, 150], ["m15", 15, 96], ["h1", 60, 24]];   // time frame, minutes per candle, candles kept
function aggCandles(cd, m, n) {
  const step = m * 60, out = []; let cur = null;
  for (const c of cd) { const k = Math.floor(c.t / step) * step; if (!cur || cur.t !== k) { cur = { t: k, o: c.o, h: c.h, l: c.l, c: c.c }; out.push(cur); } else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; } }
  return out.slice(-n);
}
const encC = a => a.map(c => [c.t, ...[c.o, c.h, c.l, c.c].map(v => +v.toPrecision(8))].join("|")).join(";");
const decC = s => String(s).split(";").map(z => { const v = z.split("|").map(Number); return { t: v[0], o: v[1], h: v[2], l: v[3], c: v[4] }; }).filter(c => Number.isFinite(c.c));

const CRYPTO = new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "BNB", "LTC", "DOT", "AVAX", "LINK", "MATIC", "TRX", "SHIB", "BCH", "XLM"]);
const typeOf = x => !x.includes("/") ? "stocks" : CRYPTO.has(x.split("/")[0]) ? "crypto" : "forex";
const SYM_OK = /^[A-Z0-9.\-]{1,12}(\/[A-Z0-9]{2,6})?$/;
function weekend(now) { const d = new Date(now), w = d.getUTCDay(), h = d.getUTCHours(); return w === 6 || (w === 5 && h >= 22) || (w === 0 && h < 22); }
function nyOpen(now) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(now));
  const g = k => (f.find(x => x.type === k) || {}).value, t = (+g("hour") % 24) * 60 + +g("minute");
  return !["Sat", "Sun"].includes(g("weekday")) && t >= 570 && t < 960;
}
const isOpen = (sym, now) => { const t = typeOf(sym); return t === "crypto" ? true : t === "stocks" ? nyOpen(now) : !weekend(now); };

async function main() {
  const admin = require("firebase-admin"), WebSocket = require("ws");
  admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: process.env.DATABASE_URL || "https://loyalty-fx-default-rtdb.firebaseio.com" });
  const db = admin.database(), TS = admin.database.ServerValue.TIMESTAMP;
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let KEY = "", THR = .6, PAIRS = [], POLL_MS = 600000, cfg = "", gen = 0, P = {}, data = {}, ws = null, hbT = null, wsUp = false, lastAny = 0, lastPoll = 0, loaded = 0, lastPub = 0, RES = {}, timers = [], resolving = false, loadErr = "";
  const wsLive = () => wsUp && Date.now() - lastAny < 30000;
  const every = (fn, ms) => timers.push(setInterval(() => { Promise.resolve().then(fn).catch(e => log("error:", e.message)); }, ms));

  async function loadSettings() {                    // returns true when key, threshold or markets changed
    const s = (await db.ref("settings").once("value")).val() || {};
    const watch = [...new Set(String(s.watch || "EUR/USD,GBP/USD,USD/JPY,AUD/USD,USD/CAD").split(",").map(x => x.trim().toUpperCase()).filter(x => SYM_OK.test(x)))].slice(0, 12);
    const next = JSON.stringify([s.dataKey || "", s.threshold || .6, watch]);
    if (next === cfg) return false;
    cfg = next; KEY = s.dataKey || ""; THR = s.threshold || .6; PAIRS = watch.length ? watch : ["EUR/USD"];
    POLL_MS = Math.ceil(PAIRS.length * 86400 / (800 * .8)) * 1000;
    return true;
  }
  async function fetchCandles(sym, n) {
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1min&outputsize=${n}&timezone=UTC&apikey=${encodeURIComponent(KEY)}`);
    const j = await r.json(); if (j.status === "error" || !j.values) throw new Error(j.message || "No data");
    return j.values.reverse().map(v => ({ t: Date.parse(v.datetime.replace(" ", "T") + "Z") / 1000, o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
  }
  function onTick(sym, price, ts) {
    const p = P[sym]; if (!p || !p.candles.length) return;
    const m = Math.floor(ts / 60) * 60, c = p.candles, last = c[c.length - 1];
    if (last.t === m) { last.c = price; last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); }
    else if (m > last.t) { c.push({ t: m, o: price, h: price, l: price, c: price }); if (c.length > 1700) c.shift(); }
    p.price = price; p.tickAt = lastAny = Date.now(); p.dirty = true;
  }
  function merge(p, fresh) {
    for (const f of fresh) { const last = p.candles[p.candles.length - 1]; if (last && f.t === last.t) Object.assign(last, f); else if (!last || f.t > last.t) p.candles.push(f); }
    p.price = p.candles[p.candles.length - 1].c; p.tickAt = Date.now(); p.dirty = true;
  }
  async function bootstrap(myGen) {
    loaded = 0; loadErr = "";
    for (const s of PAIRS) {
      if (myGen !== gen) return;
      try {
        const cd = await fetchCandles(s, 1440);
        P[s] = { candles: cd, price: cd[cd.length - 1].c, tickAt: 0, dirty: true, sig: "WAIT", dangerUntil: 0, reason: "", bt: null };
        P[s].bt = backtest(series(cd), THR); loaded++; log("loaded", s, cd.length, "candles");
      } catch (e) { loadErr = e.message; log("load failed", s, e.message); if (/key|api|credit|limit/i.test(e.message)) break; }
      await sleep(PAIRS.length > 8 ? 7600 : 1500);
    }
  }
  function connectWS(myGen) {
    if (!KEY || myGen !== gen) return;
    const sock = new WebSocket("wss://ws.twelvedata.com/v1/quotes/price?apikey=" + encodeURIComponent(KEY)); ws = sock;
    sock.on("open", () => { wsUp = true; sock.send(JSON.stringify({ action: "subscribe", params: { symbols: PAIRS.join(",") } })); clearInterval(hbT); hbT = setInterval(() => { if (sock.readyState === 1) sock.send(JSON.stringify({ action: "heartbeat" })); }, 10000); });
    sock.on("message", d => { try { const m = JSON.parse(d); if (m.event === "price") onTick(m.symbol, +m.price, m.timestamp || Date.now() / 1000); } catch {} });
    sock.on("close", () => { wsUp = false; clearInterval(hbT); if (myGen === gen) setTimeout(() => connectWS(myGen), 8000); });
    sock.on("error", () => { try { sock.close(); } catch {} });
  }
  async function pollOnce() {
    lastPoll = Date.now();
    for (const s of PAIRS.filter(x => isOpen(x, Date.now()))) { try { if (P[s]) merge(P[s], await fetchCandles(s, 5)); } catch (e) { loadErr = e.message; } await sleep(PAIRS.length > 8 ? 7600 : 1200); }
  }
  function stopEngine() {
    gen++; timers.forEach(clearInterval); timers = []; clearInterval(hbT);
    if (ws) { try { ws.removeAllListeners(); ws.on("error", () => {}); ws.close(); } catch {} ws = null; }
    wsUp = false; P = {}; data = {}; loaded = 0;
  }
  async function startEngine() {
    stopEngine(); const myGen = gen;
    if (!KEY) { log("No Twelve Data key in settings/dataKey yet. Save it in the admin page. Waiting."); return; }
    log("starting for", PAIRS.join(", "));
    await bootstrap(myGen); if (myGen !== gen) return;
    connectWS(myGen);
    every(() => { if (PAIRS.some(x => isOpen(x, Date.now())) && !wsLive() && loaded && Date.now() - lastPoll > POLL_MS) return pollOnce(); }, 15000);
    every(compute, 1000);
    every(heartbeat, 20000);
    every(resolveOpen, 20000);
  }

  function logSignal(s, sig, d) {
    const L = d.lv, t = Date.now(); if (!L || ![L.entry, L.t1, L.t2, L.stop, L.atr].every(Number.isFinite)) return;
    const key = String(Math.floor(t / 60000)).padStart(10, "0") + "_" + s.replace(/[.#$\[\]\/]/g, "_");
    db.ref("results/" + key).set({ pair: s, sig, entry: L.entry, t1: L.t1, t2: L.t2, stop: L.stop, atr: L.atr, src: L.src, ts: t, due: t + 600000, status: "open" }).catch(e => log("log failed", e.message));
  }
  async function resolveOpen() {
    if (resolving) return; resolving = true;
    try {
      const now = Date.now();
      for (const [id, r] of Object.entries(RES)) {
        if (!r || r.status !== "open" || now < r.due) continue;
        const p = P[r.pair]; if (!p) continue;
        const t0 = Math.floor(r.ts / 1000), t1 = Math.floor(r.due / 1000), sg = r.sig === "BUY" ? 1 : -1;
        const cs = p.candles.filter(c => c.t > t0 && c.t < t1);
        if (cs.length < 5 || cs[cs.length - 1].t < t1 - 120) {
          if (now > r.due + 1800000) await db.ref("results/" + id).update({ status: "void", closedAt: TS }).catch(() => {});
          continue;
        }
        let mf = 0, ma = 0; for (const c of cs) { const e = (c.c - r.entry) / r.atr * sg; if (e > mf) mf = e; if (-e > ma) ma = -e; }
        const end = cs[cs.length - 1].c, mv = (end - r.entry) / r.atr * sg;
        const k1 = Math.abs(r.t1 - r.entry) / r.atr, k2 = Math.abs(r.t2 - r.entry) / r.atr, ks = Math.abs(r.stop - r.entry) / r.atr;
        await db.ref("results/" + id).update({ status: mv > .3 ? "win" : mv < -.3 ? "loss" : "flat", end, move: Math.round(mv * 100) / 100, t1hit: mf >= k1, t2hit: mf >= k2, stophit: ma >= ks, closedAt: TS }).catch(() => {});
      }
    } finally { resolving = false; }
  }

  function pubCharts(s, cd) {                        // candles for the page's chart, once a minute per pair
    const k = s.replace(/[.#$\[\]\/]/g, "_"), u = {};
    for (const [tf, m, n] of CHTF) u["feed/ch/" + k + "/" + tf] = { s: encC(aggCandles(cd, m, n)), t: TS };
    db.ref().update(u).catch(e => log("chart publish failed", e.message));
  }
  function compute() {
    let changed = false;
    for (const s of PAIRS) {
      const p = P[s]; if (!p || !p.dirty || p.candles.length < 130) continue; p.dirty = false; changed = true;
      const S = series(p.candles), i = S.c.length - 1, dir = dirAt(S, i), str = Math.abs(dir), vr = volRatio(S, i), t = Date.now();
      let sig = str >= THR ? (dir > 0 ? "BUY" : "SELL") : "WAIT", reason = "";
      if (vr > 2) reason = "Volatility spike";
      else if ((p.sig === "BUY" || p.sig === "SELL") && (sig === "BUY" || sig === "SELL") && sig !== p.sig) reason = "Momentum reversed";
      else if ((p.sig === "BUY" || p.sig === "SELL") && p.str - str > .25) reason = "Strength collapsed";
      if (reason) { p.dangerUntil = t + 60000; p.reason = reason; }
      if (t < p.dangerUntil) sig = "DANGER"; else p.reason = "";
      const prevSig = p.sig; p.sig = sig; if (sig === "BUY" || sig === "SELL") p.str = str; else p.str = p.str || 0;
      const open = isOpen(s, t), stale = !open ? true : wsLive() ? t - p.tickAt > 120000 : t - lastPoll > POLL_MS * 2.2;
      data[s] = { pair: s, type: typeOf(s), open, bid: p.price, signal: sig, reason: p.reason, pBuy: Math.max(0, dir), pSell: Math.max(0, -dir), pWait: 1 - str,
        trend: S.e9[i] > S.e21[i] ? "BULLISH" : "BEARISH", volatility: vr > 1.5 ? "HIGH" : vr < .7 ? "LOW" : "NORMAL",
        tf: { M5: tfTrend(S.c, 5), M15: tfTrend(S.c, 15), M30: tfTrend(S.c, 30), H1: tfTrend(S.c, 60) }, spark: S.c.slice(-60), age: Math.round((t - p.tickAt) / 1000), stale, bt: p.bt, lv: levels(p, S.atr[i], dir), day: dayStats(S, p.price) };
      if (p.seen && !stale && (sig === "BUY" || sig === "SELL") && prevSig !== sig && t - (p.lastLog || 0) > 300000) { p.lastLog = t; logSignal(s, sig, data[s]); }
      p.seen = true;
      if (p.candles.length > 130 && Math.floor(t / 60000) !== p.chMin) { p.chMin = Math.floor(t / 60000); pubCharts(s, p.candles); }
    }
    if (changed) publish(false);
  }
  function heartbeat() {                             // keeps the feed fresh, and keeps open/closed and stale flags right when no ticks arrive
    const t = Date.now();
    for (const s of Object.keys(data)) {
      const p = P[s]; if (!p) continue; const open = isOpen(s, t);
      data[s].open = open; data[s].stale = !open ? true : wsLive() ? t - p.tickAt > 120000 : t - lastPoll > POLL_MS * 2.2; data[s].age = Math.round((t - p.tickAt) / 1000);
    }
    publish(true);
  }
  function publish(force) {
    if (!Object.keys(data).length) { db.ref("feed").update({ ts: TS, src: "server" }).catch(() => {}); return; }
    if (!force && Date.now() - lastPub < 4000) return; lastPub = Date.now();
    const pairs = {}; for (const [k, v] of Object.entries(data)) pairs[k.replace(/[.#$\[\]\/]/g, "_")] = v;
    db.ref("feed").update(JSON.parse(JSON.stringify({ ts: TS, src: "server", pairs }))).catch(e => log("publish failed", e.message));
  }

  db.ref("results").limitToLast(300).on("value", s => { RES = {}; s.forEach(c => { RES[c.key] = c.val(); }); });
  await loadSettings(); await startEngine();
  setInterval(async () => { try { if (await loadSettings()) { log("settings changed, restarting engine"); await startEngine(); } } catch (e) { log("settings check failed:", e.message); } }, 60000);
  const bye = async () => { log("stopping"); try { await db.ref("feed/src").set("stopped"); } catch {} process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
  process.on("unhandledRejection", e => log("unhandled:", e && e.message));
  log("Steve FX Radar engine is running");
}

module.exports = { aggCandles, encC, decC, series, dirAt, volRatio, backtest, tfTrend, levels, dayStats, isOpen, typeOf };
if (require.main === module) main().catch(e => { console.error("Fatal:", e); process.exit(1); });
