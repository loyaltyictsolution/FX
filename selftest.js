// Offline check of the signal engine with made-up prices. Run: npm test
const { createEngine } = require("./engine");
const eng = createEngine({ THR: 0.6 });
eng.setPairs(["BTC/USD"]); // crypto is always open, so the test works on weekends too
const now = Math.floor(Date.now() / 1000), cd = [];
let p = 100;
for (let i = 1500; i > 0; i--) { p += Math.sin(i / 40) * 0.05 + 0.02; cd.push({ t: now - i * 60, o: p, h: p + 0.05, l: p - 0.05, c: p }); }
eng.load("BTC/USD", cd);
let n = 0;
const changed = eng.compute({ wsLive: () => true, pollMs: 675e3, onSignal: () => n++, onCharts: () => n++ });
const d = eng.data["BTC/USD"];
const ok = changed && d && ["BUY", "SELL", "WAIT", "DANGER"].includes(d.signal) && d.spark.length === 60 && d.lv && Number.isFinite(d.lv.t1);
console.log(ok ? "PASS" : "FAIL", d && { signal: d.signal, bid: d.bid, trend: d.trend, volatility: d.volatility });
process.exit(ok ? 0 : 1);
