"use strict";
// Fakes used by the tests: an in-memory Realtime Database, a price source, a WebSocket and a clock.
const { Radar } = require("../core");
const SV = { ".sv": "timestamp" };

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

class Snap {
  constructor(key, v) { this.key = key; this.v = v === undefined ? null : v; }
  val() { return this.v === null ? null : JSON.parse(JSON.stringify(this.v)); }
  exists() { return this.v !== null; }
  forEach(fn) { if (this.v && typeof this.v === "object") for (const k of Object.keys(this.v).sort()) if (fn(new Snap(k, this.v[k])) === true) return true; return false; }
}

class MockDB {
  constructor(now) { this.now = now; this.root = {}; this.subs = []; this.ServerValue = { TIMESTAMP: SV }; this.writes = []; }
  ref(p = "") { return new Ref(this, p); }
  parts(p) { return String(p).split("/").filter(Boolean); }
  get(p) { let n = this.root; for (const k of this.parts(p)) { if (n == null || typeof n !== "object") return undefined; n = n[k]; } return n; }
  resolve(v, at) {
    if (v === undefined) throw new Error("Firebase would reject undefined at " + at);
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("Firebase would reject " + v + " at " + at);
    if (v && typeof v === "object") {
      if (v[".sv"] === "timestamp") return this.now();
      const o = Array.isArray(v) ? [] : {}; for (const k of Object.keys(v)) o[k] = this.resolve(v[k], at + "/" + k); return o;
    }
    return v;
  }
  put(p, v) {
    const ks = this.parts(p); if (!ks.length) { this.root = v == null ? {} : v; return; }
    let n = this.root; for (let i = 0; i < ks.length - 1; i++) { if (n[ks[i]] == null || typeof n[ks[i]] !== "object") n[ks[i]] = {}; n = n[ks[i]]; }
    if (v == null) delete n[ks[ks.length - 1]]; else n[ks[ks.length - 1]] = v;
    this.prune(ks);
  }
  prune(ks) { for (let i = ks.length; i > 0; i--) { const parent = this.get(ks.slice(0, i - 1).join("/")), k = ks[i - 1]; if (parent && parent[k] && typeof parent[k] === "object" && !Object.keys(parent[k]).length) delete parent[k]; else break; } }
  notify() { for (const s of [...this.subs]) s.cb(s.snap()); }
}
class Ref {
  constructor(db, p) { this.db = db; this.p = p; }
  async set(v) { const x = this.db.resolve(JSON.parse(JSON.stringify(v === undefined ? null : v, (k, val) => val === undefined ? "__undef__" : val)), this.p); this.db.writes.push(["set", this.p]); this.db.put(this.p, v == null ? null : this.db.resolve(v, this.p)); this.db.notify(); }
  async update(o) { this.db.writes.push(["update", this.p]); for (const [k, v] of Object.entries(o)) this.db.put(this.p + "/" + k, v == null ? null : this.db.resolve(v, this.p + "/" + k)); this.db.notify(); }
  async remove() { this.db.put(this.p, null); this.db.notify(); }
  async once() { return new Snap(this.p.split("/").pop(), this.db.get(this.p)); }
  on(ev, cb) { const s = { cb, snap: () => new Snap(this.p.split("/").pop(), this.db.get(this.p)) }; this.db.subs.push(s); cb(s.snap()); }
  limitToLast(n) {
    const self = this, pick = () => { const v = self.db.get(self.p); if (!v || typeof v !== "object") return null; const o = {}; for (const k of Object.keys(v).sort().slice(-n)) o[k] = v[k]; return o; };
    return { async once() { return new Snap(self.p.split("/").pop(), pick()); }, on(ev, cb) { const s = { cb, snap: () => new Snap(self.p.split("/").pop(), pick()) }; self.db.subs.push(s); cb(s.snap()); } };
  }
}

class FakeWS {
  constructor(url, world) { this.url = url; this.readyState = 0; this.sent = []; world.sockets.push(this); }
  send(m) { this.sent.push(JSON.parse(m)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  message(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
}

// A world with a clock you move by hand. Candles are a gentle random walk around a base price.
function makeWorld({ start = Date.UTC(2026, 9, 21, 15, 0, 0), bases = {}, noise = {}, history = {} } = {}) {
  const w = { T: start, sockets: [], fetches: [], now: () => w.T, logs: [] };
  w.db = new MockDB(w.now);
  const baseOf = s => bases[s] || (s === "BTC/USD" ? 60000 : s === "AAPL" ? 200 : s.includes("JPY") ? 150 : 1.08);
  const sigmaOf = s => noise[s] || baseOf(s) * 0.00006;
  w.baseOf = baseOf; w.sigmaOf = sigmaOf;
  w.fetchCandles = async (sym, n, key) => {
    w.fetches.push({ sym, n, key });
    if (key === "BAD") throw new Error("apikey is invalid");
    const rnd = mulberry32([...sym].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)), end = Math.floor(w.T / 60000) * 60, out = []; let px = baseOf(sym), sg = sigmaOf(sym);
    const drift = history[sym] || 0;
    for (let i = 0; i < n; i++) {
      const o = px, c = baseOf(sym) + (rnd() - .5) * 2 * sg + drift * i, h = Math.max(o, c) + rnd() * sg * .6, l = Math.min(o, c) - rnd() * sg * .6; px = c;
      out.push({ t: end - (n - 1 - i) * 60, o, h, l, c });
    }
    return out;
  };
  w.radar = new Radar({ db: w.db, TS: w.db.ServerValue.TIMESTAMP, fetchCandles: w.fetchCandles, openSocket: url => new FakeWS(url, w), now: w.now, sleep: () => Promise.resolve(), log: m => w.logs.push(m), publishSeconds: 15 });
  w.setSettings = o => w.db.ref("settings").set(o);
  w.boot = async () => {                                       // start, load history, connect the stream
    await w.radar.start(); await w.radar.tick(); await w.radar.idle(); await w.radar.tick(); await w.radar.idle();
    const s = w.sockets[w.sockets.length - 1]; if (s && s.readyState === 0) s.open(); return s;
  };
  // advance in 5 second steps; price(sym, ms) gives the next price for each symbol
  w.run = async (seconds, price, syms) => {
    const s = w.sockets[w.sockets.length - 1], list = syms || w.radar.pairs;
    for (let i = 0; i < seconds / 5; i++) {
      w.T += 5000;
      if (s && s.readyState === 1 && price) for (const sym of list) { const p = price(sym, w.T); if (p != null) s.message({ event: "price", symbol: sym, price: p, timestamp: w.T / 1000 }); }
      await w.radar.tick(); await w.radar.idle();
    }
  };
  w.feed = () => w.db.get("feed");
  return w;
}
module.exports = { MockDB, FakeWS, makeWorld, mulberry32 };
