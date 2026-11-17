"use strict";
// Ask AI + M-Pesa routes, served from the same port as the signal server.
// Env: ALLOWED_ORIGINS (your site, e.g. https://loyaltyictsolution.github.io), ANTHROPIC_API_KEY, PUBLIC_URL (this server's https address)
const express = require("express");
module.exports = function buildApi({ admin, db }) {
  const OWNER = "wanjohisteve85@gmail.com";
  const toOrigin = v => { try { return new URL(v.trim()).origin.toLowerCase(); } catch { return v.trim().replace(/\/+$/, "").toLowerCase(); } };
  const origins = (process.env.ALLOWED_ORIGINS || "").split(/[\s,]+/).filter(Boolean).map(toOrigin);
  console.log("API allowed origins:", origins.length ? origins.join(", ") : "(none set)");
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
  require("./ai-engine")(app, ctx);
  require("./mpesa-stk")(app, ctx);
  return app;
};
