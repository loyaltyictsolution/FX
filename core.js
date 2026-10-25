"use strict";
// The always-on engine. Everything outside the process (database, price API, WebSocket, clock) is passed in,
// so the same code runs for real in server.js and against fakes in test/.
const E = require("./engine");

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));
const DEFAULT_WATCH = "EUR/USD,GBP/USD,USD/JPY,AUD/USD,USD/CAD";

class Radar {
  constructor(o) {
    this.db = o.db; this.TS = o.TS; this.fetchCandles = o.fetchCandles; this.openSocket = o.openSocket;
    this.now = o.now || Date.now; this.sleep = o.sleep || defaultSleep; this.log = o.log || (() => {});
    this.publishMs = (o.publishSeconds || 15) * 1000;          // quiet-time publish gap; a changed signal goes out after 3 s
    this.P = {}; this.data = {}; this.pairs = []; this.key = ""; this.thr = .6; this.pollGap = 1500; this.pollEvery = E.pollMs(5);
    this.loaded = 0; this.loadErr = ""; this.booting = false; this.polling = false; this.gen = 0;
    this.ws = null; this.wsUp = false; this.wsRetryAt = 0; this.wsStartedAt = 0; this.lastHb = 0; this.lastAny = 0; this.lastPoll = 0;
    this.lastPub = 0; this.lastBeat = 0; this.lastResolve = 0; this.dirtyPub = false; this.sigChanged = false;
    this.open = new Map(); this.jobs = new Set(); this.pending = null; this.settingsSig = null;
  }

  // ---- lifecycle ----
  async start() {
    await this.loadOpenResults();
    this.db.ref("settings").on("value", snap => {
      const s = snap.val() || {}, sig = JSON.stringify([s.dataKey || "", s.threshold || null, s.watch || ""]);
      if (sig !== this.settingsSig) { this.settingsSig = sig; this.pending = s; }
    }, e => this.log("cannot read settings: " + e.message));
  }
  async stop() {
    this.gen++; this.closeSocket(); this.pending = null;
    try { await this.db.ref("feed").update({ src: "stopped" }); } catch {}   // tells the admin page to take over straight away
  }
  job(fn) {
    const p = (async () => { try { await fn(); } catch (e) { this.log("error: " + e.message); } })();
    this.jobs.add(p); p.then(() => this.jobs.delete(p)); return p;
  }
  async idle() { while (this.jobs.size) await Promise.all([...this.jobs]); }
  ready() { return !this.booting && this.loaded > 0; }
  wsLive() { return this.wsUp && this.now() - this.lastAny < 30000; }
  status() {
    const t = this.now();
    return { ready: this.ready(), loaded: this.loaded, pairs: this.pairs.length, wsLive: this.wsLive(), wsUp: this.wsUp, lastTickSecondsAgo: this.lastAny ? Math.round((t - this.lastAny) / 1000) : null,
      lastPublishSecondsAgo: this.lastPub ? Math.round((t - this.lastPub) / 1000) : null, openResults: this.open.size, error: this.loadErr || null };
  }

  // ---- settings and price history ----
  async reload(s) {
    const gen = ++this.gen; this.booting = true; this.closeSocket();
    this.P = {}; this.data = {}; this.loaded = 0; this.loadErr = ""; this.dirtyPub = false;
    this.key = String(s.dataKey || "").trim();
    this.thr = s.threshold >= .4 && s.threshold <= .9 ? s.threshold : .6;
    this.pairs = E.parseWatch(s.watch || DEFAULT_WATCH);
    this.pollEvery = E.pollMs(this.pairs.length); this.pollGap = this.pairs.length > 8 ? 7600 : 1500;
    if (!this.key) { this.log("No Twelve Data key saved yet. Waiting."); this.booting = false; return; }
    this.log("loading " + this.pairs.join(", "));
    for (const sym of this.pairs) {
      if (gen !== this.gen) return;
      try { const cd = await this.fetchCandles(sym, 1440, this.key); this.P[sym] = E.newPair(cd, this.thr, this.now()); this.loaded++; }
      catch (e) { this.loadErr = e.message; this.log("could not load " + sym + ": " + e.message); if (/key|api|credit|limit/i.test(e.message)) break; }
      await this.sleep(this.pollGap);
    }
    if (gen !== this.gen) return;
    this.lastPoll = this.now(); this.booting = false; this.wsRetryAt = 0;
    this.log("engine ready: " + this.loaded + "/" + this.pairs.length + " pairs");
  }

  // ---- live prices ----
  connect() {
    if (!this.key || this.ws) return;
    const ws = this.openSocket("wss://ws.twelvedata.com/v1/quotes/price?apikey=" + encodeURIComponent(this.key)); this.ws = ws; this.wsStartedAt = this.now();
    ws.onopen = () => { this.wsUp = true; this.lastHb = this.now(); ws.send(JSON.stringify({ action: "subscribe", params: { symbols: this.pairs.join(",") } })); };
    ws.onmessage = e => { try { const m = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)); if (m.event === "price") this.onTick(m.symbol, +m.price, m.timestamp); } catch {} };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.wsUp = false; this.wsRetryAt = this.now() + 8000; } };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  closeSocket() { const w = this.ws; this.ws = null; this.wsUp = false; if (w) { w.onclose = null; try { w.close(); } catch {} } }
  onTick(sym, price, tsSec) {
    const p = this.P[sym]; if (!p || !(price > 0)) return;
    const t = this.now(); E.applyTick(p, price, tsSec || t / 1000, t); this.lastAny = t;
  }
  async pollOnce() {                                          // fallback when the live stream is not available
    const gen = this.gen; this.polling = true; this.lastPoll = this.now();
    try {
      for (const sym of this.pairs.filter(s => E.isOpen(s, this.now()))) {
        if (gen !== this.gen) return;
        try { const p = this.P[sym]; if (p) E.mergeCandles(p, await this.fetchCandles(sym, 5, this.key), this.now()); } catch (e) { this.loadErr = e.message; }
        await this.sleep(this.pollGap);
      }
    } finally { this.polling = false; }
  }

  // ---- signals ----
  staleFor(s, p, t) { return !E.isOpen(s, t) ? true : this.wsLive() ? t - p.tickAt > 120000 : t - this.lastPoll > this.pollEvery * 2.2; }
  compute(t) {
    let changed = false;
    for (const s of this.pairs) {
      const p = this.P[s]; if (!p || !p.dirty || p.candles.length < 130) continue; p.dirty = false; changed = true;
      const { d, log, prevSig } = E.evaluate(p, s, this.thr, t, this.staleFor(s, p, t));
      this.data[s] = d;
      if (d.signal !== prevSig) this.sigChanged = true;
      if (log) this.logSignal(s, d.signal, d, t);
    }
    if (changed) this.dirtyPub = true;
  }

  // ---- publishing to the page and to members ----
  refreshFlags(t) {
    for (const [s, d] of Object.entries(this.data)) { const p = this.P[s]; d.open = E.isOpen(s, t); d.age = Math.round((t - p.tickAt) / 1000); d.stale = this.staleFor(s, p, t); }
  }
  async publish(t, withTs) {                                  // ts = when new data last arrived, beat = the engine is alive
    this.refreshFlags(t);
    const pairs = {}; for (const [k, v] of Object.entries(this.data)) pairs[E.safeKey(k)] = v;
    const doc = { beat: this.TS, src: "server", pairs }; if (withTs) doc.ts = this.TS;
    const clean = JSON.parse(JSON.stringify(doc));
    if (withTs) await this.db.ref("feed").set(clean); else await this.db.ref("feed").update(clean);
    this.lastPub = t; this.lastBeat = t; if (withTs) { this.dirtyPub = false; this.sigChanged = false; }
  }
  async beat(t) { await this.db.ref("feed").update({ beat: this.TS, src: "server" }); this.lastBeat = t; }

  // ---- results log (same records the page writes) ----
  async loadOpenResults() {
    const s = await this.db.ref("results").limitToLast(300).once("value");
    s.forEach(c => { const r = c.val(); if (r && r.status === "open") this.open.set(c.key, r); });
  }
  logSignal(s, sig, d, t) {
    const L = d.lv; if (!L || ![L.entry, L.t1, L.t2, L.stop, L.atr].every(Number.isFinite)) return;
    const key = String(Math.floor(t / 60000)).padStart(10, "0") + "_" + E.safeKey(s);
    const rec = { pair: s, sig, entry: L.entry, t1: L.t1, t2: L.t2, stop: L.stop, atr: L.atr, src: L.src, ts: t, due: t + 600000, status: "open" };
    this.open.set(key, rec);
    this.job(() => this.db.ref("results/" + key).set(rec));
  }
  async resolveOpen(t) {
    for (const [id, r] of [...this.open]) {
      if (t < r.due) continue;
      const stale = t > r.due + 1800000, voidIt = async () => { await this.db.ref("results/" + id).update({ status: "void", closedAt: this.TS }); this.open.delete(id); };
      const p = this.P[r.pair]; if (!p) { if (stale) await voidIt(); continue; }
      const t0 = Math.floor(r.ts / 1000), t1 = Math.floor(r.due / 1000), sg = r.sig === "BUY" ? 1 : -1;
      const cs = p.candles.filter(c => c.t > t0 && c.t < t1);
      if (cs.length < 5 || cs[cs.length - 1].t < t1 - 120) { if (stale) await voidIt(); continue; }
      let mf = 0, ma = 0; for (const c of cs) { const e = (c.c - r.entry) / r.atr * sg; if (e > mf) mf = e; if (-e > ma) ma = -e; }
      const end = cs[cs.length - 1].c, mv = (end - r.entry) / r.atr * sg;
      const k1 = Math.abs(r.t1 - r.entry) / r.atr, k2 = Math.abs(r.t2 - r.entry) / r.atr, ks = Math.abs(r.stop - r.entry) / r.atr;
      await this.db.ref("results/" + id).update({ status: mv > .3 ? "win" : mv < -.3 ? "loss" : "flat", end, move: Math.round(mv * 100) / 100, t1hit: mf >= k1, t2hit: mf >= k2, stophit: ma >= ks, closedAt: this.TS });
      this.open.delete(id);
    }
  }

  // ---- one pass, called about once a second ----
  async tick() {
    const t = this.now();
    if (this.pending && !this.booting) { const s = this.pending; this.pending = null; this.job(() => this.reload(s)); }
    if (!this.ready()) return;                                 // not ready: no heartbeat, so the admin page keeps running if it has to
    if (!this.ws && this.key && t >= this.wsRetryAt) this.connect();
    if (this.ws && !this.wsUp && t - this.wsStartedAt > 20000) { this.log("stream did not connect, retrying"); this.closeSocket(); this.wsRetryAt = t + 8000; }   // connection hung
    if (this.ws && this.wsUp && t - this.lastAny > 600000 && this.pairs.some(s => E.isOpen(s, t))) { this.log("stream went silent, reconnecting"); this.closeSocket(); this.wsRetryAt = t + 8000; }
    if (this.ws && this.wsUp && t - this.lastHb >= 10000) { this.lastHb = t; try { this.ws.send(JSON.stringify({ action: "heartbeat" })); } catch {} }
    if (!this.polling && !this.wsLive() && this.pairs.some(s => E.isOpen(s, t)) && t - this.lastPoll > this.pollEvery) this.job(() => this.pollOnce());
    this.compute(t);
    if (this.dirtyPub && t - this.lastPub >= (this.sigChanged ? 3000 : this.publishMs)) this.job(() => this.publish(t, true));
    else if (t - this.lastBeat >= 30000) this.job(() => t - this.lastPub >= 120000 && Object.keys(this.data).length ? this.publish(t, false) : this.beat(t));
    if (t - this.lastResolve >= 20000) { this.lastResolve = t; this.job(() => this.resolveOpen(t)); }
  }
}

module.exports = { Radar };
