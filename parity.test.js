"use strict";
// The server must give the same answers as the page. This loads the page's own engine code and compares it with engine.js.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), vm = require("vm");
const E = require("../engine"), { mulberry32 } = require("./helpers");
const PAGE = process.env.PAGE_FILE || path.join(__dirname, "..", "..", "index.html");
const plain = x => JSON.parse(JSON.stringify(x));

function pageApi() {
  const html = fs.readFileSync(PAGE, "utf8"), js = html.match(/<script type="text\/plain" id="mainjs">([\s\S]*?)<\/script>/)[1];
  const eng = js.slice(js.indexOf("// ENGINE START"), js.indexOf("// ENGINE END"));
  const grab = n => js.match(new RegExp("^function " + n + "\\(.*?^}\\n", "ms"))[0];
  const ctx = vm.createContext({});
  vm.runInContext(eng + grab("levels") + grab("dayStats") + ";this.api={clamp,ema,series,dirAt,volRatio,backtest,tfTrend,levels,dayStats};", ctx);
  return ctx.api;
}
function candles(seed, n, sigma, drift, spikes) {
  const r = mulberry32(seed), out = []; let px = 1.1;
  for (let i = 0; i < n; i++) {
    const o = px, step = (r() - .5) * 2 * sigma + drift * Math.sin(i / 90) + (spikes && r() < .004 ? (r() - .5) * sigma * 40 : 0), c = o + step;
    out.push({ t: 1.8e9 + i * 60, o, h: Math.max(o, c) + r() * sigma * .5, l: Math.min(o, c) - r() * sigma * .5, c }); px = c;
  }
  return out;
}
const SETS = [[11, 1440, 5e-5, 0, false], [22, 1440, 2e-4, 3e-5, true], [33, 1500, 1e-3, 1e-4, true], [44, 1440, 1e-5, 0, false]];

test("page file is present", () => assert.ok(fs.existsSync(PAGE), "index.html not found at " + PAGE + " (set PAGE_FILE)"));
for (const [seed, n, sg, dr, sp] of SETS) {
  test(`same results as the page (seed ${seed})`, () => {
    const pg = pageApi(), cd = candles(seed, n, sg, dr, sp);
    const S1 = pg.series(cd), S2 = E.series(cd);
    assert.deepEqual(plain(S2), plain(S1), "series");
    for (const i of [130, 400, 900, n - 1]) {
      assert.equal(E.dirAt(S2, i), pg.dirAt(S1, i), "dirAt " + i);
      assert.equal(E.volRatio(S2, i), pg.volRatio(S1, i), "volRatio " + i);
    }
    for (const thr of [.4, .6, .75]) assert.deepEqual(plain(E.backtest(S2, thr)), plain(pg.backtest(S1, thr)), "backtest " + thr);
    const c = cd.map(x => x.c);
    for (const step of [5, 15, 30, 60]) assert.equal(E.tfTrend(c, step), pg.tfTrend(c, step), "tfTrend " + step);
    const price = c[c.length - 1], bt = E.backtest(S2, .6), p = { bt, price };
    for (const dir of [.8, -.8]) assert.deepEqual(plain(E.levels(p, S2.atr[n - 1], dir)), plain(pg.levels(p, S1.atr[n - 1], dir)), "levels " + dir);
    assert.deepEqual(plain(E.dayStats(S2, price)), plain(pg.dayStats(S1, price)), "dayStats");
  });
}
test("market hours", () => {
  const wed = Date.UTC(2026, 9, 21, 15, 0), sat = Date.UTC(2026, 9, 24, 12, 0), sunEarly = Date.UTC(2026, 9, 25, 21, 0), sunLate = Date.UTC(2026, 9, 25, 22, 30), fri = Date.UTC(2026, 9, 23, 22, 30);
  assert.equal(E.isOpen("EUR/USD", wed), true); assert.equal(E.isOpen("AAPL", wed), true); assert.equal(E.isOpen("BTC/USD", sat), true);
  assert.equal(E.isOpen("EUR/USD", sat), false); assert.equal(E.isOpen("AAPL", sat), false);
  assert.equal(E.isOpen("EUR/USD", sunEarly), false); assert.equal(E.isOpen("EUR/USD", sunLate), true); assert.equal(E.isOpen("EUR/USD", fri), false);
  assert.equal(E.isOpen("AAPL", Date.UTC(2026, 9, 21, 13, 0)), false, "9:00 New York");   // EDT: 13:00 UTC is 9:00
  assert.equal(E.isOpen("AAPL", Date.UTC(2026, 9, 21, 13, 31)), true);
  assert.equal(E.isOpen("AAPL", Date.UTC(2026, 9, 21, 20, 1)), false, "16:01 New York");
  assert.equal(E.isOpen("AAPL", Date.UTC(2026, 10, 3, 14, 31)), true, "after clocks go back (EST), 9:31");
  assert.equal(E.isOpen("AAPL", Date.UTC(2026, 10, 3, 14, 29)), false, "after clocks go back (EST), 9:29");
});
test("symbol parsing", () => {
  assert.deepEqual(E.parseWatch("eur/usd, BTC/USD ,aapl,bad symbol,AAPL"), ["EUR/USD", "BTC/USD", "AAPL"]);
  assert.deepEqual(E.parseWatch(""), ["EUR/USD"]); assert.equal(E.parseWatch(Array.from({ length: 20 }, (_, i) => "S" + i).join(",")).length, 12);
  assert.equal(E.safeKey("BRK.B"), "BRK_B"); assert.equal(E.safeKey("EUR/USD"), "EUR_USD");
});
