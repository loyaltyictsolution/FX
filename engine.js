"use strict";
// Signal engine shared with the web page (index.html).
// The blocks marked "copied from the page" are the page's own code, so the server and the page give the same answers.
// test/parity.test.js compares them with the page on every run. Do not hand-edit the copied blocks.

// ---- copied from the page: indicators, signal strength, backtest ----
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
function dirAt(S, i) {                       // -1 (strong sell) .. +1 (strong buy)
  const { c, e9, e21, e50, atr, rs } = S, a = atr[i] || 1e-9;
  const trend = e9[i] > e21[i] && e21[i] > e50[i] ? 1 : e9[i] < e21[i] && e21[i] < e50[i] ? -1 : (e9[i] > e21[i] ? .3 : -.3);
  const mom = clamp((c[i] - c[i - 5]) / a, -2, 2) / 2 * .8, r = rs[i];
  const rt = r >= 75 ? -.5 : r > 55 ? .5 : r <= 25 ? .5 : r < 45 ? -.5 : 0;
  return Math.tanh((trend + mom + rt) / 1.5);
}
function volRatio(S, i) { let m = 0, k = 0; for (let j = Math.max(0, i - 100); j <= i; j++) { m += S.atr[j]; k++; } return S.atr[i] / (m / k || 1e-9); }
function backtest(S, thr, H = 10) {          // hit = price moved >0.3 ATR our way within 10 bars; miss = against
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
  // t1/t2 = median and 75th percentile of the best move our way within H bars; sl = 75th percentile of the worst move against us; all in ATR units (closes only)
  return { hit, miss, rate: hit + miss ? hit / (hit + miss) : null, n: fav.length, t1: q(fav, .5), t2: q(fav, .75), sl: q(adv, .75), swing: q(sw, .5) };
}
function tfTrend(c, step) {
  const r = []; for (let i = c.length - 1; i >= 0 && r.length < 60; i -= step) r.unshift(c[i]);
  if (r.length < 22) return 0; const a = ema(r, 9), b = ema(r, 21); return a[a.length - 1] > b[b.length - 1] ? 1 : -1;
}

// ---- copied from the page: start / target / stop levels and 24-hour statistics ----
function levels(p, atr, dir) {                       // price levels from how far past signals on this pair actually moved
  const bt = p.bt, ok = !!(bt && bt.n >= 8 && bt.t1 != null), sg = dir >= 0 ? 1 : -1, e = p.price;
  let k1 = ok ? bt.t1 : 1, k2 = ok ? bt.t2 : 1.8, ks = ok ? bt.sl : 1;
  k1 = clamp(k1, .3, 3); k2 = Math.max(clamp(k2, .5, 4), k1 + .3); ks = clamp(ks, .5, 3);
  return { entry: e, atr, t1: e + sg * k1 * atr, t2: e + sg * k2 * atr, stop: e - sg * ks * atr, src: ok ? "history" : "default", n: ok ? bt.n : 0, swing: bt && bt.swing != null ? bt.swing : atr * 2 };
}
// entry / targets / stop stay fixed while a BUY or SELL call is active (same as the page)
function tradeLv(p, sig, atr, dir) {
  if (sig === "BUY" || sig === "SELL") {
    if (!p.lvF || p.lvF.sig !== sig) p.lvF = { sig, L: levels(p, atr, dir) };
    return p.lvF.L;
  }
  p.lvF = null;
  return levels(p, atr, dir);
}

function dayStats(S, price) {                        // what the last ~24 hours of 1-minute data show
  const c = S.c, n = Math.min(c.length, 1440), w = c.slice(-n), hi = Math.max(...w), lo = Math.min(...w), op = w[0], rng = hi - lo || 1e-9;
  const h1 = tfTrend(c, 60), m30 = tfTrend(c, 30), m15 = tfTrend(c, 15), ups = [h1, m30, m15].filter(v => v > 0).length;
  return { hi, lo, chg: (price - op) / op * 100, pos: clamp((price - lo) / rng, 0, 1), hours: Math.round(n / 60), h1, m30, m15, bias: ups === 3 ? "UP" : ups === 0 ? "DOWN" : "MIXED", vr: volRatio(S, c.length - 1) };
}

// ---- markets (the page versions use its own clock; these take the time as an argument) ----
const CRYPTO = new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "BNB", "LTC", "DOT", "AVAX", "LINK", "MATIC", "TRX", "SHIB", "BCH", "XLM"]);
const typeOf = x => !x.includes("/") ? "stocks" : CRYPTO.has(x.split("/")[0]) ? "crypto" : "forex";
function weekend(ms) { const d = new Date(ms), w = d.getUTCDay(), h = d.getUTCHours(); return w === 6 || (w === 5 && h >= 22) || (w === 0 && h < 22); }
function nyOpen(ms) {                                  // US stock hours in New York time (holidays not included)
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const g = k => (f.find(x => x.type === k) || {}).value, t = (+g("hour") % 24) * 60 + +g("minute");
  return !["Sat", "Sun"].includes(g("weekday")) && t >= 570 && t < 960;
}
const isOpen = (sym, ms) => { const t = typeOf(sym); return t === "crypto" ? true : t === "stocks" ? nyOpen(ms) : !weekend(ms); };
const SYM_OK = /^[A-Z0-9.\-]{1,12}(\/[A-Z0-9]{2,6})?$/;
function parseWatch(v) {
  const a = (Array.isArray(v) ? v : String(v || "").split(",")).map(x => x.trim().toUpperCase()).filter(x => SYM_OK.test(x));
  const p = [...new Set(a)].slice(0, 12); return p.length ? p : ["EUR/USD"];
}
const pollMs = n => Math.ceil(n * 86400 / (800 * .8)) * 1000;       // keeps an 800-credit/day plan under budget
const safeKey = s => s.replace(/[.#$\[\]\/]/g, "_");

// ---- per-pair state ----
function newPair(candles, thr, now) {
  return { candles, price: candles[candles.length - 1].c, tickAt: now, dirty: true, sig: "WAIT", str: 0, dangerUntil: 0, reason: "", bt: backtest(series(candles), thr), seen: false, lastLog: 0 };
}
function applyTick(p, price, tsSec, now) {
  const m = Math.floor(tsSec / 60) * 60, c = p.candles, last = c[c.length - 1];
  if (last.t === m) { last.c = price; last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); }
  else if (m > last.t) { c.push({ t: m, o: price, h: price, l: price, c: price }); if (c.length > 1700) c.shift(); }
  p.price = price; p.tickAt = now; p.dirty = true;
}
function mergeCandles(p, fresh, now) {
  for (const f of fresh) { const last = p.candles[p.candles.length - 1];
    if (last && f.t === last.t) Object.assign(last, f); else if (!last || f.t > last.t) p.candles.push(f); }
  if (p.candles.length > 1700) p.candles.splice(0, p.candles.length - 1700);
  p.price = p.candles[p.candles.length - 1].c; p.tickAt = now; p.dirty = true;
}

// one pass of the page's compute() for a single pair
function evaluate(p, s, THR, t, stale) {
  const S = series(p.candles), i = S.c.length - 1, ic = i - 1;          // ic = last CLOSED candle
  const dir = dirAt(S, ic), str = Math.abs(dir), vr = volRatio(S, i);
  let sig = str >= THR ? (dir > 0 ? "BUY" : "SELL") : "WAIT", reason = "";

  // keep an active call steady: ends only when strength < 60% of THR, and lasts at least 5 minutes
  if (p.call) {
    const same = (p.call === "BUY") === (dir > 0);
    if (same && str >= THR * .6) sig = p.call;
    else if (!(str >= THR) && t - (p.callAt || 0) < 300000) sig = p.call;
  }

  if (vr > 2) reason = "Volatility spike";
  else if ((p.sig === "BUY" || p.sig === "SELL") && (sig === "BUY" || sig === "SELL") && sig !== p.sig) reason = "Momentum reversed";
  else if ((p.sig === "BUY" || p.sig === "SELL") && p.str - str > .25) reason = "Strength collapsed";
  if (reason) { p.dangerUntil = t + 60000; p.reason = reason; }
  if (t < p.dangerUntil) sig = "DANGER"; else p.reason = "";

  // remember the active call, and explain a WAIT that follows one
  if (sig === "BUY" || sig === "SELL") { if (p.call !== sig) { p.call = sig; p.callAt = t; } }
  else if (p.call) { p.exitFrom = p.call; p.exitUntil = t + 300000; p.call = null; }
  if (sig === "WAIT" && t < (p.exitUntil || 0))
    p.reason = "Earlier " + p.exitFrom + " call has ended. If you are already in that trade, close it or let your stop handle it";

  const prevSig = p.sig; p.sig = sig; if (sig === "BUY" || sig === "SELL") p.str = str; else p.str = p.str || 0;
  const d = { pair: s, type: typeOf(s), open: isOpen(s, t), bid: p.price, signal: sig, reason: p.reason, pBuy: Math.max(0, dir), pSell: Math.max(0, -dir), pWait: 1 - str,
    trend: S.e9[i] > S.e21[i] ? "BULLISH" : "BEARISH", volatility: vr > 1.5 ? "HIGH" : vr < .7 ? "LOW" : "NORMAL",
    tf: { M5: tfTrend(S.c, 5), M15: tfTrend(S.c, 15), M30: tfTrend(S.c, 30), H1: tfTrend(S.c, 60) }, spark: S.c.slice(-60), age: Math.round((t - p.tickAt) / 1000), stale, bt: p.bt, lv: tradeLv(p, sig, S.atr[ic], dir), day: dayStats(S, p.price) };
  const log = !!(p.seen && !stale && (sig === "BUY" || sig === "SELL") && prevSig !== sig && t - (p.lastLog || 0) > 300000);
  if (log) p.lastLog = t;
  p.seen = true;                                       // the first pass never logs, so old setups are not counted as new
  return { d, log, prevSig };
}

module.exports = { clamp, ema, series, dirAt, volRatio, backtest, tfTrend, levels, tradeLv, dayStats, CRYPTO, typeOf, weekend, nyOpen, isOpen, SYM_OK, parseWatch, pollMs, safeKey, newPair, applyTick, mergeCandles, evaluate };
