"use strict";
// Loyalty FX Radar: M-Pesa (Daraja) STK Push engine.
// Needs Node 18+, express and firebase-admin (already initialised).
// Use in your server file:
//   require("./mpesa-engine").init({ admin, app, express });
// Render environment variables:
//   ALLOWED_ORIGINS  your site address(es), comma separated, e.g. https://yourname.github.io
//   OWNER_EMAIL      your owner email (optional, same one used in your database rules)
// Keys are read from the database path settings/daraja, which only a superadmin can read.

const crypto = require("crypto");
const BASES = { sandbox: "https://sandbox.safaricom.co.ke", live: "https://api.safaricom.co.ke" };

function init({ admin, app, express }) {
  const db = admin.database();
  const OWNER = (process.env.OWNER_EMAIL || "").toLowerCase();
  const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  let cfg = null, cfgAt = 0, tok = null;
  const recent = new Map();

  async function getCfg(force) {
    if (!force && cfg && Date.now() - cfgAt < 6e4) return cfg;
    cfg = (await db.ref("settings/daraja").get()).val() || null;
    cfgAt = Date.now();
    return cfg;
  }
  const ready = c => c && c.key && c.secret && c.pass && c.shortcode && BASES[c.env];
  const stamp = () => new Date(Date.now() + 3 * 3600e3).toISOString().replace(/[-:T]/g, "").slice(0, 14);

  async function token(c) {
    const k = c.env + ":" + c.key;
    if (tok && tok.k === k && Date.now() < tok.exp) return tok.v;
    const r = await fetch(BASES[c.env] + "/oauth/v1/generate?grant_type=client_credentials", {
      headers: { Authorization: "Basic " + Buffer.from(c.key + ":" + c.secret).toString("base64") }
    });
    if (!r.ok) throw new Error("Safaricom refused the keys (" + r.status + ")");
    const j = await r.json();
    tok = { k, v: j.access_token, exp: Date.now() + (Number(j.expires_in || 3599) - 60) * 1000 };
    return tok.v;
  }

  async function callbackUrl(c) {
    const base = ((await db.ref("settings/serverUrl").get()).val() || process.env.PUBLIC_URL || "").replace(/\/$/, "");
    if (!/^https:\/\//.test(base)) throw new Error("Server address is missing");
    return base + "/mpesa/callback/" + c.cb;
  }

  async function stkPush(c, phone, amount) {
    const ts = stamp(), till = c.type === "till";
    const r = await fetch(BASES[c.env] + "/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: "Bearer " + (await token(c)), "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: c.shortcode,
        Password: Buffer.from(c.shortcode + c.pass + ts).toString("base64"),
        Timestamp: ts,
        TransactionType: till ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: till ? (c.partyb || c.shortcode) : c.shortcode,
        PhoneNumber: phone,
        CallBackURL: await callbackUrl(c),
        AccountReference: "LoyaltyFX",
        TransactionDesc: "Membership"
      })
    });
    return r.json().catch(() => ({}));
  }

  // The server decides the price. It never trusts the amount sent by the browser.
  async function priceFor(plan, days) {
    const v = (await db.ref("site/plans").get()).val();
    const list = Array.isArray(v) ? v : Object.values(v || {});
    const p = list.find(x => x && x.name === plan && Number(x.days) === Number(days));
    if (!p) return null;
    const m = /(\d[\d,]*)(\.\d+)?/.exec(String(p.price || ""));
    if (!m) return null;
    const n = Math.round(Number(m[1].replace(/,/g, "") + (m[2] || "")));
    return n >= 1 ? n : null;
  }

  async function handle(uid, snap) {
    const r = snap.val();
    if (!r || r.status !== "queued") return;
    const claim = await snap.ref.child("status").transaction(cur => (cur === "queued" ? "sending" : undefined));
    if (!claim.committed) return;
    const fail = m => snap.ref.update({ status: "failed", msg: m }).catch(() => {});
    try {
      if (Date.now() - Number(r.ts || 0) > 12e4) return fail("The request expired. Please try again.");
      const q = (recent.get(uid) || []).filter(t => Date.now() - t < 6e5);
      if (q.length >= 5) return fail("Too many requests. Please wait a few minutes.");
      q.push(Date.now()); recent.set(uid, q);
      if ((await db.ref("site/stk").get()).val() !== true) return fail("The M-Pesa prompt is not switched on.");
      const c = await getCfg();
      if (!ready(c)) return fail("M-Pesa is not set up yet.");
      if (!/^254[17]\d{8}$/.test(String(r.phone))) return fail("That phone number is not valid.");
      const amt = await priceFor(r.plan, r.days);
      if (!amt) return fail("This plan is not set up for the M-Pesa prompt yet.");
      const j = await stkPush(c, String(r.phone), amt);
      if (String(j.ResponseCode) !== "0") return fail(j.errorMessage || j.ResponseDescription || "Safaricom did not accept the request.");
      await db.ref("mpesa_pending/" + j.CheckoutRequestID).set({ uid, id: snap.key, amt, t: Date.now(), phone: String(r.phone), plan: String(r.plan), days: Number(r.days), email: String(r.email || "").slice(0, 120) });
      await snap.ref.update({ status: "sent", amountDue: amt, checkoutId: j.CheckoutRequestID });
    } catch (e) {
      console.error("stk error:", e.message);
      fail("The prompt could not be sent. Please pay manually.");
    }
  }

  db.ref("stkreq").on("child_added", u => {
    u.ref.on("child_added", s => { handle(u.key, s).catch(e => console.error("stk error:", e.message)); });
  });

  const same = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  // Safaricom sends the payment result here. The secret in the address keeps strangers out.
  app.post("/mpesa/callback/:t", express.json({ limit: "20kb" }), async (req, res) => {
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    try {
      const c = await getCfg();
      if (!c || !c.cb || !same(req.params.t, c.cb)) return;
      const cb = req.body && req.body.Body && req.body.Body.stkCallback;
      if (!cb || !cb.CheckoutRequestID) return;
      const pRef = db.ref("mpesa_pending/" + cb.CheckoutRequestID);
      const p = (await pRef.get()).val();
      if (!p) return;
      const rRef = db.ref("stkreq/" + p.uid + "/" + p.id);
      if (Number(cb.ResultCode) === 0) {
        const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
        const g = n => (items.find(i => i.Name === n) || {}).Value;
        const paid = Number(g("Amount"));
        if (paid >= p.amt) {
          const receipt = String(g("MpesaReceiptNumber") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          const up = {};
          up["stkreq/" + p.uid + "/" + p.id + "/status"] = "paid";
          up["stkreq/" + p.uid + "/" + p.id + "/receipt"] = receipt;
          up["stkreq/" + p.uid + "/" + p.id + "/paidAmount"] = paid;
          if (receipt) {
            // Shows up in your Payments tab with the real receipt code, waiting for you to approve.
            const pid = db.ref("payments/" + p.uid).push().key;
            up["payments/" + p.uid + "/" + pid] = { method: "mpesa", code: receipt, status: "pending", ts: Date.now(), email: p.email || "", payer: p.phone, amount: paid, plan: p.plan, days: p.days, via: "stk" };
            if (!(await db.ref("paycodes/" + receipt).get()).exists()) up["paycodes/" + receipt] = p.uid;
          }
          await db.ref().update(up);
        } else {
          await rRef.update({ status: "failed", msg: "The amount paid did not match the plan." });
        }
      } else {
        await rRef.update({ status: "failed", msg: String(cb.ResultDesc || "The payment was not completed.").slice(0, 120) });
      }
      await pRef.remove();
    } catch (e) { console.error("callback error:", e.message); }
  });

  function cors(req, res) {
    const o = req.headers.origin;
    if (o && ORIGINS.includes(o)) {
      res.setHeader("Access-Control-Allow-Origin", o);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
  }
  app.options("/mpesa/test", (req, res) => { cors(req, res); res.sendStatus(204); });

  // The admin page's "Test connection" button calls this. Superadmin only.
  app.post("/mpesa/test", async (req, res) => {
    cors(req, res);
    try {
      const h = req.headers.authorization || "";
      const d = await admin.auth().verifyIdToken(h.startsWith("Bearer ") ? h.slice(7) : "");
      const isSuper = (await db.ref("superadmins/" + d.uid).get()).val() === true ||
        (OWNER && d.email_verified === true && String(d.email || "").toLowerCase() === OWNER);
      if (!isSuper) return res.status(403).json({ error: "Superadmin only." });
      const c = await getCfg(true);
      if (!ready(c)) return res.status(400).json({ error: "Save your keys first." });
      await token(c);
      res.json({ ok: true, env: c.env });
    } catch (e) {
      res.status(400).json({ error: /refused/.test(e.message) ? e.message : "Test failed." });
    }
  });

  setInterval(async () => {
    try {
      const s = await db.ref("mpesa_pending").orderByChild("t").endAt(Date.now() - 864e5).get();
      s.forEach(c => { c.ref.remove(); });
    } catch (e) { /* ignore */ }
  }, 36e5);
}

module.exports = { init };
