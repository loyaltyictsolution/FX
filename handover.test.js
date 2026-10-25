"use strict";
// Runs the page's own hand-over code (guard, srvUp, setSrv, loadSrv) with stand-ins for the rest of the page.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), vm = require("vm");
const PAGE = process.env.PAGE_FILE || path.join(__dirname, "..", "..", "index.html");

function load() {
  const html = fs.readFileSync(PAGE, "utf8"), js = html.match(/<script type="text\/plain" id="mainjs">([\s\S]*?)<\/script>/)[1];
  const line = re => { const m = js.match(re); assert.ok(m, "missing in page: " + re); return m[0]; };
  const code = [line(/^let asViewer = false, SRV = .*$/m), line(/^const srvUp = .*$/m), line(/^function guard\(\) \{[\s\S]*?^}\n/m), line(/^function setSrv\(f\) \{[\s\S]*?^}\n/m), line(/^async function loadSrv\(\) \{[\s\S]*?^}\n/m)].join("\n");
  const calls = [], feed = {};
  const ctx = vm.createContext({
    isAdmin: true, demo: false, KEY: "key", auth: { currentUser: { uid: "a" } }, now: 1e12, calls,
    rt() { return this.now; }, stop() { calls.push("stop"); }, start() { calls.push("start"); }, startFeed() { calls.push("startFeed"); }, stopFeed() { calls.push("stopFeed"); }, status() {},
    dbr: { ref: p => ({ get: async () => ({ val: () => feed[p.split("/")[1]] ?? null }) }) }, feed,
  });
  vm.runInContext(code + ";this.api={srvUp,guard,setSrv,loadSrv,get asViewer(){return asViewer},get SRV(){return SRV}};", ctx);
  return { ctx, calls, feed, api: ctx.api };
}

test("a fresh server heartbeat hands the page over to watching", () => {
  const { ctx, calls, api } = load();
  api.setSrv({ src: "server", beat: ctx.now - 5000, ts: ctx.now - 60000 });
  assert.equal(api.asViewer, true); assert.deepEqual(calls, ["stop", "startFeed"]);
});
test("the page keeps running while the feed comes from the page itself", () => {
  const { ctx, calls, api } = load();
  api.setSrv({ src: "page", ts: ctx.now - 1000 }); assert.equal(api.asViewer, false); assert.deepEqual(calls, []);
});
test("when the server goes quiet for 2 minutes the page takes over again", () => {
  const { ctx, calls, api } = load();
  api.setSrv({ src: "server", beat: ctx.now - 1000 }); assert.equal(api.asViewer, true);
  ctx.now += 119000; api.guard(); assert.equal(api.asViewer, true, "still alive at 119 s");
  ctx.now += 2000; api.guard(); assert.equal(api.asViewer, false, "gone at 121 s");
  assert.deepEqual(calls, ["stop", "startFeed", "stopFeed", "start"]);
});
test("a server that shut down cleanly (src stopped) is dropped at once", () => {
  const { ctx, calls, api } = load();
  api.setSrv({ src: "server", beat: ctx.now - 1000 }); api.setSrv({ src: "stopped" });
  assert.equal(api.asViewer, false); assert.deepEqual(calls.slice(-2), ["stopFeed", "start"]);
});
test("heartbeat or data time, whichever is newer, counts", () => {
  const { ctx, api } = load();
  api.setSrv({ src: "server", beat: ctx.now - 500000, ts: ctx.now - 1000 }); assert.equal(api.asViewer, true);
});
test("members and demo mode never hand over", () => {
  let t = load(); t.ctx.isAdmin = false; t.api.setSrv({ src: "server", beat: t.ctx.now }); assert.equal(t.api.asViewer, false);
  t = load(); t.ctx.demo = true; t.api.setSrv({ src: "server", beat: t.ctx.now }); assert.equal(t.api.asViewer, false);
});
test("loadSrv reads the three small fields before the page decides to load prices", async () => {
  const { ctx, feed, api } = load();
  Object.assign(feed, { src: "server", beat: ctx.now - 2000, ts: ctx.now - 90000 });
  await api.loadSrv(); assert.equal(api.srvUp(), true); assert.equal(api.SRV.ts, ctx.now - 2000);
});
