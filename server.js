"use strict";
// Runs the signal engine 24/7. It reads your Twelve Data key, markets and strength from the same
// database settings the admin page uses, then publishes the feed that members and the admin page read.
const http = require("http");
const admin = require("firebase-admin");
const { Radar } = require("./core");

const log = m => console.log(new Date().toISOString() + "  " + m);

// --- Firebase Admin credentials: a JSON string in FIREBASE_SERVICE_ACCOUNT, or a file path in GOOGLE_APPLICATION_CREDENTIALS ---
const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
admin.initializeApp({
  credential: raw ? admin.credential.cert(JSON.parse(raw)) : admin.credential.applicationDefault(),
  databaseURL: process.env.FIREBASE_DATABASE_URL || "https://loyalty-fx-default-rtdb.firebaseio.com",
});
const db = admin.database();

// --- Twelve Data (same request the page makes) ---
async function fetchCandles(sym, n, key) {
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1min&outputsize=${n}&timezone=UTC&apikey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (j.status === "error" || !j.values) throw new Error(j.message || "No data");
  return j.values.reverse().map(v => ({ t: Date.parse(v.datetime.replace(" ", "T") + "Z") / 1000, o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
}
const WS = globalThis.WebSocket || require("ws");        // Node 22 has WebSocket built in; older Node uses the "ws" package

const radar = new Radar({
  db, TS: admin.database.ServerValue.TIMESTAMP, fetchCandles, openSocket: url => new WS(url), log,
  publishSeconds: Math.max(5, +process.env.PUBLISH_SECONDS || 15),
});

radar.start().then(() => log("engine started, waiting for settings")).catch(e => { log("start failed: " + e.message); process.exit(1); });
const loop = setInterval(() => radar.tick().catch(e => log("tick error: " + e.message)), 1000);

// --- small health page (hosts that need an open port, and for you to check it is alive) ---
const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(radar.status())); });
server.listen(+process.env.PORT || 8080, () => log("health page on port " + (process.env.PORT || 8080)));

async function bye(sig) {
  log(sig + " received, handing back to the admin page");
  clearInterval(loop); server.close();
  await Promise.race([radar.stop(), new Promise(r => setTimeout(r, 4000))]);
  process.exit(0);
}
process.on("SIGTERM", () => bye("SIGTERM")); process.on("SIGINT", () => bye("SIGINT"));
process.on("unhandledRejection", e => log("unhandled: " + (e && e.message || e)));
