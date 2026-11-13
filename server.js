"use strict";
// Loyalty FX Radar signal server: fetches prices, computes signals with the same engine as the app,
// and publishes the shared feed 24/7. No browser and no admin login needed.
const http = require("http");
const admin = require("firebase-admin");
const WebSocket = require("ws");
const { createEngine, CHTF, aggCandles, encC } = require("./engine");

const env = process.env;
const DB_URL = env.DATABASE_URL || "https://loyalty-fx-default-rtdb.firebaseio.com";
const PORT = +env.PORT || 3000;
const THR = +env.THRESHOLD || 0.6;
const DEFAULT_WATCH = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD"];
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- Firebase (Admin SDK: full access, so no server login account or database rules to fight) ----
let cred;
if (env.FIREBASE_SERVICE_ACCOUNT) cred = admin.credential.cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT));
else cred = admin.credential.applicationDefault(); // uses GOOGLE_APPLICATION_CREDENTIALS file
admin.initializeApp({ credential: cred, databaseURL: DB_URL });
const db = admin.database();
const TS = admin.database.ServerValue.TIMESTAMP;
const keyOf = (s) => s.replace(/[.#$\[\]\/]/g, "_");

// ---- State ----
const eng = createEngine({ THR });
const st = { startedAt: Date.now(), lastPublish: 0, publishes: 0, wsUp: false, lastTick: 0, loaded: 0, total: 0, note: "starting", error: "" };
let KEY = "", pairs = [], ws = null, hb = null, booting = false;
const wsLive = () => st.wsUp && Date.now() - st.lastTick < 3e4;
const pollMs = () => Math.ceil(Math.max(1, pairs.length) * 86400 / (800 * 0.8)) * 1000;
const ctx = {
  wsLive, get pollMs() { return pollMs(); },
  onSignal(s, sig, d) {
    const L = d.lv, t = Date.now();
    if (!L || ![L.entry, L.t1, L.t2, L.stop, L.atr].every(Number.isFinite)) return;
    const key = String(Math.floor(t / 6e4)).padStart(10, "0") + "_" + keyOf(s);
    db.ref("results/" + key).set({ pair: s, sig, entry: L.entry, t1: L.t1, t2: L.t2, stop: L.stop, atr: L.atr, src: L.src, ts: t, due: t + 6e5, status: "open" }).catch((e) => log("results write", e.message));
  },
  onCharts(s, candles) {
    const u = {};
    for (const [tf, m, n] of CHTF) u["feed/ch/" + keyOf(s) + "/" + tf] = { s: encC(aggCandles(candles, m, n)), t: TS };
    db.ref().update(u).catch((e) => log("chart write", e.message));
  },
};

// ---- Settings ----
async function loadSettings() {
  KEY = env.DATA_KEY || (await db.ref("settings/dataKey").get()).val() || "";
  const w = env.WATCH || (await db.ref("settings/watch").get()).val() || "";
  const a = (Array.isArray(w) ? w : String(w).split(",")).map((x) => x.trim().toUpperCase()).filter(Boolean);
  pairs = [...new Set(a.length ? a : DEFAULT_WATCH)].slice(0, 12);
  eng.setPairs(pairs);
  st.total = pairs.length;
}

// ---- Prices (Twelve Data) ----
async function fetchCandles(sym, n) {
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1min&outputsize=${n}&timezone=UTC&apikey=${encodeURIComponent(KEY)}`);
  const j = await r.json();
  if (j.status === "error" || !j.values) throw new Error(j.message || "No data");
  return j.values.reverse().map((v) => ({ t: Date.parse(v.datetime.replace(" ", "T") + "Z") / 1e3, o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootstrap() {
  if (booting) return; booting = true;
  try {
    let todo = pairs.filter((s) => !eng.P[s]);
    while (todo.length) {
      const batch = todo.splice(0, 6);
      let fatal = false, rate = false;
      await Promise.all(batch.map(async (s) => {
        try { const cd = await fetchCandles(s, 1440); if (cd.length < 2) throw new Error("Not enough history"); eng.load(s, cd); st.loaded = Object.keys(eng.P).length; st.error = ""; if (!ws) connectWS(); }
        catch (e) {
          st.error = s + ": " + e.message;
          if (/apikey|api key|invalid|incorrect|not valid|run out of|premium|daily limit/i.test(e.message) && !/minute|per minute/i.test(e.message)) fatal = true;
          else if (/minute|too many|rate/i.test(e.message)) rate = true;
        }
      }));
      if (fatal) break;
      if (rate) await sleep(62e3); else if (todo.length) await sleep(5e4);
    }
  } finally { booting = false; }
}

function connectWS() {
  if (!KEY) return;
  try { if (ws) ws.terminate(); } catch {}
  clearInterval(hb);
  const live = pairs.slice(0, eng.WS_MAX);
  ws = new WebSocket("wss://ws.twelvedata.com/v1/quotes/price?apikey=" + encodeURIComponent(KEY));
  ws.on("open", () => {
    st.wsUp = true;
    ws.send(JSON.stringify({ action: "subscribe", params: { symbols: live.join(",") } }));
    hb = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ action: "heartbeat" })), 1e4);
  });
  ws.on("message", (m) => {
    try {
      const j = JSON.parse(m);
      if (j.event === "price" && j.symbol && Number.isFinite(+j.price)) { if (eng.onTick(j.symbol, +j.price, j.timestamp || Date.now() / 1e3)) st.lastTick = Date.now(); }
    } catch {}
  });
  const down = () => { st.wsUp = false; clearInterval(hb); setTimeout(connectWS, 8e3); };
  ws.on("close", down);
  ws.on("error", () => { try { ws.terminate(); } catch {} });
}

// REST fallback for pairs without a live stream, or when the stream is quiet
let pollIdx = 0, lastPoll = 0;
async function pollOnce() {
  if (!KEY || booting || !pairs.length) return;
  const need = pairs.filter((s, i) => eng.P[s] && (!wsLive() || i >= eng.WS_MAX));
  if (!need.length || Date.now() - lastPoll < pollMs() / Math.max(1, need.length)) return;
  lastPoll = Date.now();
  const s = need[pollIdx++ % need.length];
  try { eng.merge(s, await fetchCandles(s, 5)); } catch (e) { st.error = s + ": " + e.message; }
}

// ---- Publish ----
async function publish() {
  const pairsOut = {};
  for (const [k, v] of Object.entries(eng.data)) pairsOut[keyOf(k)] = v;
  if (!Object.keys(pairsOut).length) return;
  await db.ref("feed").update({ ts: TS, src: "server", pairs: JSON.parse(JSON.stringify(pairsOut)) });
  st.lastPublish = Date.now(); st.publishes++;
}
let lastRefresh = 0;
async function tick() {
  try {
    await pollOnce();
    if (Date.now() - lastRefresh > 3e4) { lastRefresh = Date.now(); eng.markAllDirty(); } // keeps age/ts fresh, also when markets are closed
    if (eng.compute(ctx) && Date.now() - st.lastPublish > 4e3) await publish();
    st.note = !st.loaded ? "loading history" : wsLive() ? "live stream" : "polling";
  } catch (e) { st.error = e.message; log("tick", e.message); }
}

// ---- Status page ----
const level = () => (!st.lastPublish || Date.now() - st.lastPublish > 18e4 ? "r" : Date.now() - st.lastPublish > 9e4 || !st.loaded ? "y" : "g");
const statusJson = () => ({
  state: level(), note: st.note, uptimeMin: Math.round((Date.now() - st.startedAt) / 6e4), lastPublishSecAgo: st.lastPublish ? Math.round((Date.now() - st.lastPublish) / 1e3) : null,
  publishes: st.publishes, stream: wsLive(), loaded: st.loaded + "/" + st.total, error: st.error,
  pairs: Object.values(eng.data).map((d) => ({ pair: d.pair, signal: d.signal, bid: d.bid, open: d.open, stale: d.stale })),
});
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loyalty FX Server</title>
<style>body{margin:0;background:#0b1620;color:#e8eef5;font:15px system-ui,sans-serif;display:flex;justify-content:center;padding:24px}main{width:100%;max-width:560px}
.top{display:flex;align-items:center;gap:16px}h1{font-size:20px;margin:0}small{color:#8a97a6}.ic{width:72px;color:#8a97a6;transition:color .3s}.ic.g{color:#2ecc71}.ic.y{color:#f5b82e}.ic.r{color:#ef4444}
.w{opacity:.3}.g .w{animation:p 1.2s infinite}.g .w2{animation-delay:.4s}.y .w{animation:p 2.2s infinite}.r .w{animation:b 1.6s infinite}
@keyframes p{0%,100%{opacity:.18}45%{opacity:1}}@keyframes b{0%,100%{opacity:.15}50%{opacity:.75}}
.card{background:#12212e;border-radius:12px;padding:14px 16px;margin-top:16px}.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1d3042}.row:last-child{border:0}
.BUY{color:#2ecc71}.SELL{color:#ef4444}.DANGER{color:#f5b82e}.err{color:#f5b82e}</style></head><body><main>
<div class="top"><svg id="ic" class="ic" viewBox="0 0 120 104"><g class="w w1" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"><path d="M37 22.7A30 30 0 0 0 37 61.3"/><path d="M83 22.7A30 30 0 0 1 83 61.3"/></g><g class="w w2" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"><path d="M20.6 11.2A50 50 0 0 0 20.6 72.8"/><path d="M99.4 11.2A50 50 0 0 1 99.4 72.8"/></g><circle cx="60" cy="42" r="20" fill="currentColor"/><path d="M54 32.5v19l16.5-9.5z" fill="#fff"/><rect x="30" y="76" width="60" height="22" rx="3" fill="currentColor"/><text id="bt" x="60" y="92" fill="#fff" font-weight="700" font-size="16" text-anchor="middle">...</text></svg>
<div><h1>Loyalty FX Server</h1><small id="sub">starting</small></div></div>
<div class="card" id="info"></div><div class="card" id="pairs"></div></main>
<script>const L={g:"LIVE",y:"WAIT",r:"OFF"};async function u(){try{const j=await (await fetch("status.json")).json();ic.setAttribute("class","ic "+j.state);bt.textContent=L[j.state];sub.textContent=j.note+" · up "+j.uptimeMin+" min";
info.innerHTML=[["Last publish",j.lastPublishSecAgo==null?"never":j.lastPublishSecAgo+"s ago"],["Pairs loaded",j.loaded],["Live stream",j.stream?"connected":"polling"],["Publishes",j.publishes]].map(r=>'<div class="row"><span>'+r[0]+'</span><b>'+r[1]+'</b></div>').join("")+(j.error?'<div class="err">'+j.error+'</div>':"");
pairs.innerHTML=j.pairs.map(p=>'<div class="row"><span>'+p.pair+'</span><span class="'+p.signal+'">'+p.signal+(p.open?"":" (closed)")+'</span><span>'+p.bid+'</span></div>').join("")||"<small>No pairs yet</small>"}catch(e){}}u();setInterval(u,5000)</script></body></html>`;
http.createServer((req, res) => {
  if (req.url.startsWith("/status.json")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(statusJson())); }
  if (req.url.startsWith("/health")) { res.writeHead(st.lastPublish ? 200 : 503); return res.end(st.lastPublish ? "ok" : "starting"); }
  res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
}).listen(PORT, () => log("status page on :" + PORT));

// ---- Main ----
(async () => {
  for (;;) { try { await loadSettings(); if (KEY) break; st.error = "No Twelve Data key found (settings/dataKey or DATA_KEY)"; } catch (e) { st.error = e.message; } log(st.error); await sleep(3e4); }
  log("watching", pairs.join(", "));
  bootstrap();
  setInterval(tick, 5e3);
  setInterval(() => { loadSettings().then(() => { if (pairs.some((s) => !eng.P[s])) bootstrap(); }).catch(() => {}); }, 5 * 6e4);
})();
process.on("unhandledRejection", (e) => log("unhandled", e && e.message));
