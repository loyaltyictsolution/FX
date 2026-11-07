// Loyalty FX Radar: server jobs (Firebase Cloud Functions, 2nd gen, Node 20).
// 1) newsRefresh : fetches market headlines every 10 minutes (no admin page needed)
// 2) radarPush   : every minute sends push alerts for news events, market opens,
//                  renewals, price alerts and signal changes
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onValueCreated } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.database(), fcm = admin.messaging();
const SITE_URL = process.env.SITE_URL || "https://loyalty-fx.web.app/";   // set this to your real site address
const DAY = 864e5, MIN = 6e4, SIG_GAP = 15 * MIN;
const deep = q => SITE_URL + (SITE_URL.includes("?") ? "&" : "?") + q;
const safe = k => String(k).replace(/[.#$\[\]\/]/g, "_");

// ---------- helpers ----------
async function once(key) {                                  // true only the first time a key is seen
  const r = await db.ref("pushlog/" + safe(key)).transaction(c => (c ? undefined : Date.now()));
  return r.committed;
}
async function activeUids() {                                // admins plus approved members whose time has not run out
  const now = Date.now(), [ap, ms, ad, sa] = await Promise.all(["approved", "memberships", "admins", "superadmins"].map(p => db.ref(p).get()));
  const out = new Set([...Object.keys(ad.val() || {}), ...Object.keys(sa.val() || {})]), m = ms.val() || {};
  Object.entries(ap.val() || {}).forEach(([id, v]) => { if (v === true && (!m[id] || !m[id].until || m[id].until > now)) out.add(id); });
  return out;
}
const inQuiet = (v, now) => {                               // member's quiet hours, using the offset their phone reported
  if (!v || !v.qn || v.qf == null || v.qt == null) return false;
  const m = (((Math.floor(now / MIN) - (v.qo || 0)) % 1440) + 1440) % 1440;
  return v.qf <= v.qt ? (m >= v.qf && m < v.qt) : (m >= v.qf || m < v.qt);
};
async function tokens(flag, only, pair, signal) {            // [{uid, tok}] for devices that want this kind of alert
  const snap = await db.ref("fcmtokens").get(), out = [], now = Date.now();
  let live = {}; if (flag === "pa" || flag === "sig" || flag === "ev") live = (await db.ref("presence").get()).val() || {};
  const here = id => { const p = live[id]; return !!p && p.online === true && now - (p.last || 0) < 150000; };   // page open now: it alerts on its own
  snap.forEach(u => { if (only && !only.has(u.key)) return; if (here(u.key)) return; u.forEach(t => {
    const v = t.val(); if (!v || v[flag] === false) return;
    if (flag !== "renew" && flag !== "pa" && inQuiet(v, now)) return;        // quiet hours mute everything except renewals and price alerts
    if (pair && v.mp && v.mp[safe(pair)]) return;                            // pair muted by the member
    if (signal && v.ty && v.ty[signal] === false) return;                    // signal type switched off by the member
    out.push({ uid: u.key, tok: t.key });
  }); });
  return out;
}
async function send(list, title, body, link) {
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const res = await fcm.sendEachForMulticast({ tokens: chunk.map(x => x.tok), notification: { title, body }, webpush: { fcmOptions: { link: link || SITE_URL } } });
    await Promise.all(res.responses.map((r, k) => (!r.success && r.error && /registration-token-not-registered|invalid-argument|invalid-registration/.test(r.error.code || "")) ? db.ref(`fcmtokens/${chunk[k].uid}/${chunk[k].tok}`).remove() : null));
  }
}
const wkAt = t => { const d = new Date(t), w = d.getUTCDay(), h = d.getUTCHours(); return w === 6 || (w === 5 && h >= 22) || (w === 0 && h < 22); };
const NYF = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
function nyAt(t) { const f = NYF.formatToParts(new Date(t)), g = k => (f.find(x => x.type === k) || {}).value, m = (+g("hour") % 24) * 60 + +g("minute"); return !["Sat", "Sun"].includes(g("weekday")) && m >= 570 && m < 960; }
const affects = (pair, ccy) => pair.split("/").includes(ccy) || (ccy === "USD" && !pair.includes("/"));

// ---------- 1) headlines ----------
async function pull(prov, key) {
  const j = async u => { const r = await fetch(u); if (!r.ok) throw new Error("provider " + r.status); return r.json(); };
  let out = [];
  if (prov === "finnhub") {
    const all = await Promise.all(["general", "forex", "crypto"].map(c => j(`https://finnhub.io/api/v1/news?category=${c}&token=${encodeURIComponent(key)}`)));
    out = all.flat().map(x => ({ h: x.headline, s: x.source, u: x.url, t: x.datetime }));
  } else {
    const r = await j(`https://api.marketaux.com/v1/news/all?language=en&limit=20&api_token=${encodeURIComponent(key)}`);
    out = (r.data || []).map(x => ({ h: x.title, s: x.source, u: x.url, t: Math.floor(Date.parse(x.published_at) / 1000) || 0 }));
  }
  const seen = new Set();
  return out.filter(x => x.h && !seen.has(x.h) && seen.add(x.h)).map(x => ({ h: String(x.h).slice(0, 180), s: String(x.s || "").slice(0, 40), u: /^https:\/\//i.test(x.u || "") ? String(x.u).slice(0, 400) : "", t: +x.t || 0 })).sort((a, b) => b.t - a.t).slice(0, 20);
}
exports.newsRefresh = onSchedule({ schedule: "every 10 minutes", region: "us-central1", timeoutSeconds: 60 }, async () => {
  const s = (await db.ref("settings").get()).val() || {}; if (!s.newsOn || !s.newsKey) return;
  try {
    const items = await pull(s.newsProv || "finnhub", s.newsKey); if (!items.length) return;
    await db.ref("feed/news").set({ ts: admin.database.ServerValue.TIMESTAMP, prov: s.newsProv || "finnhub", src: "server", items });
    await db.ref("settings/newsErr").remove();
  } catch (e) {                                                      // visible to admins at settings/newsErr in the console
    await db.ref("settings/newsErr").set({ ts: Date.now(), msg: String(e && e.message || e).slice(0, 200) }); throw e;
  }
});

// ---------- 3) housekeeping: delete old push log entries once a day ----------
exports.pushCleanup = onSchedule({ schedule: "every 24 hours", region: "us-central1", timeoutSeconds: 120, maxInstances: 1 }, async () => {
  const cut = Date.now() - 8 * DAY, snap = await db.ref("pushlog").get(), up = {};   // 8 days keeps every renewal window safe
  snap.forEach(c => { if (typeof c.val() === "number" && c.val() < cut) up[c.key] = null; });
  if (Object.keys(up).length) await db.ref("pushlog").update(up);
});

// ---------- 2) push alerts ----------
exports.radarPush = onSchedule({ schedule: "every 1 minutes", region: "us-central1", timeoutSeconds: 120, maxInstances: 1 }, async () => {
  const now = Date.now(), act = await activeUids();
  await db.ref("feed/pushbeat").set({ ts: now });                     // lets the admin checklist see that the server is alive

  // news events: 60 and 30 minutes before, and at release
  const evs = (await db.ref("feed/events").get()).val() || {};
  for (const [id, e] of Object.entries(evs)) {
    const d = e.t - now, stage = d > 30 * MIN && d <= 60 * MIN ? 60 : d > 0 && d <= 30 * MIN ? 30 : d <= 0 && d > -5 * MIN ? 0 : null;
    if (stage === null || !(await once(`ev/${id}_${stage}`))) continue;
    await send(await tokens("ev", act), `${e.ccy} news ${stage ? "in about " + stage + " min" : "is out now"}`, `${e.title}. Expect fast moves and wider spreads.`);
  }

  // market opens
  const st = (await db.ref("pushlog/state").get()).val() || {}, cur = { fx: !wkAt(now), us: nyAt(now) };
  if (st.fx === false && cur.fx) await send(await tokens("open", act), "Forex week is open", "Markets are live again. Check the radar.");
  if (st.us === false && cur.us) await send(await tokens("open", act), "US stocks are open", "The New York session has started.");
  await db.ref("pushlog/state").set(cur);

  // renewals: 7, 3, 1 days before and after expiry
  const ms = (await db.ref("memberships").get()).val() || {};
  for (const [uid, m] of Object.entries(ms)) {
    if (!m || !m.until) continue; const left = m.until - now; if (left > 7 * DAY || left < -2 * DAY) continue;
    const stg = left <= 0 ? "exp" : left <= DAY ? "1" : left <= 3 * DAY ? "3" : "7"; if (!(await once(`renew/${uid}_${m.until}_${stg}`))) continue;
    await send(await tokens("renew", new Set([uid])), left <= 0 ? "Your membership has expired" : "Your membership is ending soon", left <= 0 ? "Renew to unlock the radar again." : `About ${Math.max(1, Math.round(left / DAY))} day(s) left. Tap to renew.`, deep("renew=1"));
  }

  // live prices and signals from the feed
  const feed = (await db.ref("feed").get()).val() || {}, pairs = feed.pairs || {}, fresh = feed.ts && now - feed.ts < 5 * MIN;
  if (fresh) {
    const px = {};
    for (const [k, d] of Object.entries(pairs)) px[d.pair || k.replace("_", "/")] = d;
    // price alerts
    const pa = (await db.ref("palerts").get()).val() || {};
    for (const [uid, list] of Object.entries(pa)) for (const [id, a] of Object.entries(list || {})) {
      const d = px[a.pair]; if (!d || d.bid == null || d.open === false) continue;
      if (!(a.dir === "above" ? d.bid >= a.price : d.bid <= a.price)) continue;
      await db.ref(`palerts/${uid}/${id}`).remove();
      await send(await tokens("pa", new Set([uid])), `${a.pair} hit ${a.price}`, `Price is now ${d.bid}.${a.note ? " " + a.note : ""}`, deep("pair=" + encodeURIComponent(a.pair)));
    }
    // signal changes
    const prev = (await db.ref("pushlog/sig").get()).val() || {}, next = {}, sigT = (await db.ref("pushlog/sigt").get()).val() || {};
    for (const [p, d] of Object.entries(px)) {
      next[safe(p)] = d.signal;
      const was = prev[safe(p)]; if (!was || was === d.signal || d.signal === "WAIT") continue;
      if (now - (sigT[safe(p)] || 0) < SIG_GAP) continue;               // cooldown: at most one signal alert per pair per 15 minutes
      sigT[safe(p)] = now;
      await send(await tokens("sig", act, p, d.signal), `${p}: ${d.signal}`, d.signal === "DANGER" ? `${d.reason || "Danger"}. Do not enter.` : "Signal conditions changed.", deep("pair=" + encodeURIComponent(p)));
    }
    await db.ref("pushlog/sig").set(next); await db.ref("pushlog/sigt").set(sigT);
  }
});

// ---------- 4) weekly backup of key data to Cloud Storage ----------
// Set BACKUP_BUCKET (for example your-project.firebasestorage.app) when deploying. Without it this job does nothing.
exports.weeklyBackup = onSchedule({ schedule: "every sunday 03:00", timeZone: "Africa/Nairobi", region: "us-central1", timeoutSeconds: 300, memory: "512MiB", maxInstances: 1 }, async () => {
  const bucket = process.env.BACKUP_BUCKET; if (!bucket) { console.warn("BACKUP_BUCKET is not set, backup skipped"); return; }
  const out = {};
  for (const p of ["users", "approved", "memberships", "payments", "paycodes", "admins", "superadmins", "staff", "site", "fin", "hr", "pay"]) out[p] = (await db.ref(p).get()).val();
  await admin.storage().bucket(bucket).file(`backups/${new Date().toISOString().slice(0, 10)}.json`).save(JSON.stringify(out), { contentType: "application/json" });
});

// ---------- 5) hard caps per member (Firebase rules cannot count, so this keeps the newest) ----------
const MAX_DEVICES = 10, MAX_ALERTS = 30;
exports.capDevices = onValueCreated({ ref: "/fcmtokens/{uid}/{tok}", region: "us-central1" }, async ev => {
  const ref = db.ref("fcmtokens/" + ev.params.uid), all = (await ref.get()).val() || {}, keys = Object.keys(all);
  if (keys.length <= MAX_DEVICES) return;
  const old = keys.sort((a, b) => ((all[a] && all[a].t) || 0) - ((all[b] && all[b].t) || 0)).slice(0, keys.length - MAX_DEVICES), up = {};
  old.forEach(k => { up[k] = null; }); await ref.update(up);
});
exports.capAlerts = onValueCreated({ ref: "/palerts/{uid}/{id}", region: "us-central1" }, async ev => {
  const ref = db.ref("palerts/" + ev.params.uid), keys = Object.keys((await ref.get()).val() || {});
  if (keys.length <= MAX_ALERTS) return;
  const up = {}; keys.sort().slice(0, keys.length - MAX_ALERTS).forEach(k => { up[k] = null; }); await ref.update(up);   // ids start with a time stamp, so the oldest go first
});
