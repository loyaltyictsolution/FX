// Loyalty FX server: Ask AI + M-Pesa. Run with: node server.js
// If your Render service ALREADY publishes the signal feed, do not replace its server file.
// Instead copy ai-engine.js and mpesa-engine.js next to it and add the 3 lines marked MOUNT below.
const express = require("express");
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: process.env.FIREBASE_DB_URL || "https://loyalty-fx-default-rtdb.firebaseio.com"
});
const db = admin.database();
const OWNER = "wanjohisteve85@gmail.com";
// ALLOWED_ORIGINS may be typed with a path or trailing slash; only the scheme + host is used.
const toOrigin = v => { try { return new URL(v.trim()).origin.toLowerCase(); } catch { return v.trim().replace(/\/+$/, "").toLowerCase(); } };
const origins = (process.env.ALLOWED_ORIGINS || "").split(/[\s,]+/).filter(Boolean).map(toOrigin);
console.log("Allowed origins:", origins.length ? origins.join(", ") : "(none set)");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o) {
    if (origins.includes(toOrigin(o))) {
      res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    } else if (!/\/mpesa\/callback\//.test(req.path)) console.warn("Blocked origin: " + o + "  (add exactly this to ALLOWED_ORIGINS)");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const auth = async (req, res, next) => {
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ error: "Sign in again." });
    req.user = await admin.auth().verifyIdToken(m[1]); next();
  } catch { res.status(401).json({ error: "Sign in again." }); }
};
const isSuper = async u => (u.email || "").toLowerCase() === OWNER || (await db.ref("superadmins/" + u.uid).get()).val() === true;
const isAdmin = async u => (await isSuper(u)) || (await db.ref("admins/" + u.uid).get()).val() === true;
const canUseRadar = async u => {
  if (await isAdmin(u)) return true;
  if ((await db.ref("approved/" + u.uid).get()).val() !== true) return false;
  const until = (await db.ref("memberships/" + u.uid + "/until").get()).val();
  return !until || until > Date.now();
};
const ctx = { admin, db, auth, isSuper, isAdmin, canUseRadar };

app.get("/", (req, res) => res.json({ ok: true, name: "Loyalty FX server" }));
app.get("/health", (req, res) => res.json({ ok: true, engines: ["ai", "mpesa"], originAllowed: !req.headers.origin ? null : origins.includes(toOrigin(req.headers.origin)) }));

require("./ai-engine")(app, ctx);      // MOUNT 1
require("./mpesa-engine")(app, ctx);   // MOUNT 2

app.listen(process.env.PORT || 10000, () => console.log("Server running"));
