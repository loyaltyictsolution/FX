"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { makeWorld } = require("./helpers");
const WED = Date.UTC(2026, 9, 21, 15, 0, 0), SAT = Date.UTC(2026, 9, 24, 12, 0, 0);
const flat = w => (s, ms) => w.baseOf(s);

test("starts from the saved settings and publishes a server feed with every market", async () => {
  const w = makeWorld({ start: WED });
  await w.setSettings({ dataKey: "k", threshold: .6, watch: "EUR/USD,BTC/USD,AAPL" });
  await w.boot();
  assert.deepEqual(w.fetches.map(f => [f.sym, f.n, f.key]), [["EUR/USD", 1440, "k"], ["BTC/USD", 1440, "k"], ["AAPL", 1440, "k"]], "loads a full 24 hours for each pair");
  assert.match(w.sockets[0].url, /apikey=k$/); assert.deepEqual(w.sockets[0].sent[0], { action: "subscribe", params: { symbols: "EUR/USD,BTC/USD,AAPL" } });
  await w.run(40, flat(w));
  const f = w.feed(); assert.equal(f.src, "server"); assert.equal(f.ts, w.T - (w.T - f.ts)); assert.ok(f.beat >= f.ts && w.T - f.beat < 20000);
  assert.deepEqual(Object.keys(f.pairs).sort(), ["AAPL", "BTC_USD", "EUR_USD"]);
  for (const [k, d] of Object.entries(f.pairs)) {
    assert.ok(["BUY", "SELL", "WAIT", "DANGER"].includes(d.signal), k); assert.ok([-1, 0, 1].includes(d.tf.H1), k + " H1"); assert.equal(d.day.hours, 24, k + " 24h box");
    assert.ok(Number.isFinite(d.lv.entry) && Number.isFinite(d.lv.atr), k + " levels"); assert.equal(d.spark.length, 60); assert.ok(d.bt && d.bt.n > 100, k + " backtest");
    assert.equal(d.open, true, k + " open on a Wednesday at 15:00 UTC"); assert.equal(d.pair, k === "EUR_USD" ? "EUR/USD" : k === "BTC_USD" ? "BTC/USD" : "AAPL");
  }
  assert.equal(f.pairs.EUR_USD.type, "forex"); assert.equal(f.pairs.BTC_USD.type, "crypto"); assert.equal(f.pairs.AAPL.type, "stocks");
});

test("the first pass after a start never logs old setups as new signals", async () => {
  const w = makeWorld({ start: WED }); await w.setSettings({ dataKey: "k", watch: "EUR/USD,BTC/USD" }); await w.boot();
  await w.run(10, flat(w)); assert.equal(w.db.get("results"), undefined);
});

test("closed markets are flagged closed and stale, open ones are not", async () => {
  const w = makeWorld({ start: SAT }); await w.setSettings({ dataKey: "k", watch: "EUR/USD,BTC/USD,AAPL" }); await w.boot();
  await w.run(40, (s, ms) => s === "BTC/USD" ? w.baseOf(s) : null);
  const p = w.feed().pairs; assert.equal(p.BTC_USD.open, true); assert.equal(p.BTC_USD.stale, false);
  for (const k of ["EUR_USD", "AAPL"]) { assert.equal(p[k].open, false, k); assert.equal(p[k].stale, true, k); }
});

test("a new BUY is logged once with its levels and scored after 10 minutes", async () => {
  const w = makeWorld({ start: WED, noise: { "EUR/USD": 0.00005 } }); await w.setSettings({ dataKey: "k", threshold: .6, watch: "EUR/USD" }); await w.boot();
  await w.run(600, flat(w));
  const T0 = w.T, base = w.baseOf("EUR/USD"), ramp = (s, ms) => base + ((ms - T0) / 60000) * 0.00004;
  await w.run(25 * 60, ramp);
  const rs = Object.entries(w.db.get("results") || {}); assert.ok(rs.length >= 1, "a signal was logged");
  assert.ok(rs.some(([, r]) => r.sig === "BUY"), "at least one BUY");
  for (const [id, r] of rs) {
    assert.match(id, /^\d{10}_EUR_USD$/); assert.equal(r.pair, "EUR/USD"); assert.equal(r.due - r.ts, 600000);
    assert.ok(r.t1 > r.entry && r.t2 > r.t1 && r.stop < r.entry || r.sig === "SELL", "levels point the right way");
    assert.ok(["win", "loss", "flat"].includes(r.status), "scored: " + r.status); assert.ok(r.closedAt >= r.due, "scored only after the 10 minutes");
  }
  const last = rs.map(([, r]) => r).filter(r => r.sig === "BUY").pop(); assert.equal(last.status, "win"); assert.ok(last.move > .3);
  assert.equal(w.radar.open.size, 0, "nothing left open");
});

test("a sudden jump gives DANGER with a reason, and it reaches the feed within seconds", async () => {
  const w = makeWorld({ start: WED, noise: { "EUR/USD": 0.00005 } }); await w.setSettings({ dataKey: "k", watch: "EUR/USD" }); await w.boot();
  await w.run(120, flat(w)); assert.notEqual(w.feed().pairs.EUR_USD.signal, "DANGER");
  const base = w.baseOf("EUR/USD"); await w.run(20, () => base + 0.012);
  const d = w.feed().pairs.EUR_USD; assert.equal(d.signal, "DANGER"); assert.equal(d.reason, "Volatility spike");
});

test("heartbeat keeps going while nothing changes, without pretending there is new data", async () => {
  const w = makeWorld({ start: WED }); await w.setSettings({ dataKey: "k", watch: "EUR/USD" }); await w.boot();
  await w.run(40, flat(w)); const a = w.feed(); await w.run(100, null);
  const b = w.feed(); assert.ok(b.beat > a.beat, "beat moved"); assert.equal(b.ts, a.ts, "ts (new data) did not"); assert.equal(b.src, "server");
});

test("no key, or a bad key, means no heartbeat so the admin page keeps running", async () => {
  let w = makeWorld({ start: WED }); await w.setSettings({ watch: "EUR/USD" }); await w.boot(); await w.run(60, flat(w));
  assert.equal(w.feed(), undefined); assert.equal(w.radar.ready(), false);
  w = makeWorld({ start: WED }); await w.setSettings({ dataKey: "BAD", watch: "EUR/USD" }); await w.boot(); await w.run(60, flat(w));
  assert.equal(w.feed(), undefined); assert.match(w.radar.status().error, /apikey/); assert.equal(w.sockets.length, 0, "does not open a stream without data");
});

test("saving new markets in the admin page reloads the engine", async () => {
  const w = makeWorld({ start: WED }); await w.setSettings({ dataKey: "k", watch: "EUR/USD" }); await w.boot(); await w.run(30, flat(w));
  assert.deepEqual(Object.keys(w.feed().pairs), ["EUR_USD"]);
  await w.db.ref("settings").update({ watch: "GBP/USD,BTC/USD", threshold: .75 });
  await w.radar.tick(); await w.radar.idle(); await w.radar.tick(); await w.radar.idle();
  assert.equal(w.sockets.length, 2); assert.equal(w.sockets[0].readyState, 3, "old stream closed"); w.sockets[1].open();
  await w.run(40, flat(w)); assert.deepEqual(Object.keys(w.feed().pairs).sort(), ["BTC_USD", "GBP_USD"]); assert.equal(w.radar.thr, .75);
  assert.deepEqual(w.sockets[1].sent[0].params, { symbols: "GBP/USD,BTC/USD" });
});

test("a dropped stream reconnects after 8 seconds and a hung one after 20", async () => {
  const w = makeWorld({ start: WED }); await w.setSettings({ dataKey: "k", watch: "EUR/USD" }); const s = await w.boot(); await w.run(20, flat(w));
  s.close(); await w.run(5, null); assert.equal(w.sockets.length, 1, "waits"); await w.run(10, null); assert.equal(w.sockets.length, 2, "reconnected");
  await w.run(25, null); assert.equal(w.sockets.length, 3, "second one never opened, so it was replaced");
});

test("without a live stream it falls back to refreshing every few minutes, open markets only", async () => {
  const w = makeWorld({ start: SAT }); await w.setSettings({ dataKey: "k", watch: "EUR/USD,BTC/USD" }); await w.boot();   // stream never opens
  w.fetches.length = 0; await w.run(20 * 60, null);
  const polled = w.fetches.filter(f => f.n === 5).map(f => f.sym); assert.ok(polled.length >= 1, "it polled"); assert.ok(polled.every(s => s === "BTC/USD"), "never polls a closed market");
});

test("leftover open results from before a restart are scored when due", async () => {
  const w = makeWorld({ start: WED }); await w.setSettings({ dataKey: "k", watch: "EUR/USD" });
  const t0 = w.T - 30 * 60 * 1000; await w.db.ref("results/" + String(Math.floor(t0 / 60000)).padStart(10, "0") + "_EUR_USD").set({ pair: "EUR/USD", sig: "BUY", entry: 1.0795, t1: 1.0805, t2: 1.0815, stop: 1.0785, atr: .0004, src: "default", ts: t0, due: t0 + 600000, status: "open" });
  await w.boot(); await w.run(30, flat(w));
  const r = Object.values(w.db.get("results"))[0]; assert.ok(["win", "loss", "flat", "void"].includes(r.status), "closed: " + r.status);
});

test("a clean shutdown hands control back at once", async () => {
  const w = makeWorld({ start: WED }); await w.setSettings({ dataKey: "k", watch: "EUR/USD" }); await w.boot(); await w.run(30, flat(w));
  await w.radar.stop(); assert.equal(w.feed().src, "stopped");
});

test("nothing it writes would be refused by the real database (no undefined or NaN)", async () => {
  const w = makeWorld({ start: WED }); await w.setSettings({ dataKey: "k", watch: "EUR/USD,BTC/USD,AAPL" }); await w.boot();
  await w.run(120, (s, ms) => w.baseOf(s) * (1 + Math.sin(ms / 20000) * 1e-4));
  assert.ok(w.db.writes.length > 5); assert.equal(w.logs.filter(l => /error/.test(l)).length, 0, w.logs.join("\n"));
});
