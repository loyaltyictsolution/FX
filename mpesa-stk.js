// M-Pesa (Daraja STK push).
//  - Page writes stkreq/<uid>/<id> with status "queued".
//  - This engine sends the prompt, then marks it sent -> paid / failed.
//  - On paid it records a confirmed payment and gives the member their days.
// Settings come from the database path settings/daraja (saved by the super admin in the page).
// Needs env: PUBLIC_URL (your Render address, https://...)
const BASE = { sandbox: "https://sandbox.safaricom.co.ke", live: "https://api.safaricom.co.ke" };
const pad = n => String(n).padStart(2, "0");
const stamp = () => { const d = new Date(Date.now() + 3 * 36e5); return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()); };

module.exports = function installMpesa(app, ctx) {
  const { db } = ctx;
  const cfgGet = async () => { const c = (await db.ref("settings/daraja").get()).val(); if (!c || !c.key || !c.secret || !c.pass || !c.shortcode) throw new Error("M-Pesa settings are not saved yet."); return c; };
  const token = async c => {
    const r = await fetch(BASE[c.env === "live" ? "live" : "sandbox"] + "/oauth/v1/generate?grant_type=client_credentials", {
      headers: { Authorization: "Basic " + Buffer.from(c.key + ":" + c.secret).toString("base64") }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error("Safaricom refused the keys (" + r.status + "). Check the Consumer Key and Secret and the environment.");
    return j.access_token;
  };
  const api = async (c, path, body) => {
    const r = await fetch(BASE[c.env === "live" ? "live" : "sandbox"] + path, { method: "POST", signal: AbortSignal.timeout(25000),
      headers: { Authorization: "Bearer " + await token(c), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
  };

  app.post("/mpesa/test", ctx.auth, async (req, res) => {
    try {
      if (!(await ctx.isSuper(req.user))) return res.status(403).json({ error: "Only a super admin can test this." });
      const c = await cfgGet(); await token(c);
      res.json({ ok: true, env: c.env === "live" ? "live" : "sandbox" });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  async function settle(uid, id, ok, info) {
    const ref = db.ref("stkreq/" + uid + "/" + id);
    const tx = await ref.child("status").transaction(cur => (cur === "sent" || cur === "queued") ? (ok ? "paid" : "failed") : undefined);
    if (!tx.committed) return; // already handled
    const k = (await ref.get()).val() || {};
    if (!ok) { await ref.update({ error: String(info.desc || "Not paid").slice(0, 120), doneAt: Date.now() }); return; }
    const now = Date.now(), days = +k.days || 0, receipt = info.receipt || ("STK" + String(info.checkout || id).slice(-8).toUpperCase());
    const code = String(receipt).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || "MPESA";
    const mem = (await db.ref("memberships/" + uid).get()).val() || {};
    const until = Math.max(now, mem.until || 0) + Math.round(days * 864e5);
    const pid = db.ref("payments/" + uid).push().key, up = {};
    up["payments/" + uid + "/" + pid] = { method: "M-Pesa", code, amount: info.amount || k.amount, status: "confirmed", ts: now, days, receipt: "RC" + new Date(now).toISOString().slice(2, 10).replace(/-/g, "") + "-" + code.slice(-4),
      by: "M-Pesa prompt", decidedAt: now, email: k.email || "", payer: info.phone || k.phone || "", auto: true };
    up["paycodes/" + code] = uid;
    up["approved/" + uid] = true;
    up["users/" + uid + "/terminated"] = null;
    if (days > 0) up["memberships/" + uid] = { until, plan: String(k.plan || "M-Pesa").slice(0, 20) + " " + days + "d" };
    await db.ref().update(up);
    await ref.update({ receipt: code, doneAt: now });
  }

  async function push(uid, id) {
    const ref = db.ref("stkreq/" + uid + "/" + id);
    const tx = await ref.child("status").transaction(cur => cur === "queued" ? "sent" : undefined);
    if (!tx.committed) return;
    try {
      const c = await cfgGet(), k = (await ref.get()).val(), ts = stamp(), till = c.type === "till";
      if (!/^254[17]\d{8}$/.test(k.phone) || !(k.amount >= 1)) throw new Error("Bad phone or amount.");
      const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
      if (!base) throw new Error("PUBLIC_URL is not set on the server.");
      const r = await api(c, "/mpesa/stkpush/v1/processrequest", {
        BusinessShortCode: c.shortcode, Password: Buffer.from(c.shortcode + c.pass + ts).toString("base64"), Timestamp: ts,
        TransactionType: till ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline", Amount: Math.round(k.amount),
        PartyA: k.phone, PartyB: till ? (c.partyb || c.shortcode) : c.shortcode, PhoneNumber: k.phone,
        CallBackURL: base + "/mpesa/callback/" + c.cb, AccountReference: "LoyaltyFX", TransactionDesc: String(k.plan || "Plan").slice(0, 20) });
      if (!r.ok || String(r.j.ResponseCode) !== "0") throw new Error(r.j.errorMessage || r.j.ResponseDescription || "Safaricom refused (" + r.status + ").");
      await ref.update({ checkout: r.j.CheckoutRequestID, merchant: r.j.MerchantRequestID, sentAt: Date.now() });
      await db.ref("stkidx/" + r.j.CheckoutRequestID).set(uid + "/" + id);
    } catch (e) {
      console.error("stk push", e.message);
      await ref.update({ status: "failed", error: String(e.message).slice(0, 120), doneAt: Date.now() });
    }
  }

  // Safaricom calls this with the result
  app.post("/mpesa/callback/:cb", async (req, res) => {
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    try {
      const c = (await db.ref("settings/daraja").get()).val();
      if (!c || !c.cb || req.params.cb !== c.cb) return console.warn("callback with wrong key");
      const s = req.body && req.body.Body && req.body.Body.stkCallback; if (!s) return;
      const loc = (await db.ref("stkidx/" + s.CheckoutRequestID).get()).val(); if (!loc) return;
      const [uid, id] = loc.split("/"), item = {};
      ((s.CallbackMetadata && s.CallbackMetadata.Item) || []).forEach(i => { item[i.Name] = i.Value; });
      const k = (await db.ref("stkreq/" + uid + "/" + id).get()).val() || {};
      if (+s.ResultCode === 0 && +item.Amount >= (+k.amount || 0)) await settle(uid, id, true, { receipt: item.MpesaReceiptNumber, amount: item.Amount, phone: String(item.PhoneNumber || ""), checkout: s.CheckoutRequestID });
      else if (+s.ResultCode === 0) await settle(uid, id, false, { desc: "Amount paid was less than the price." });
      else await settle(uid, id, false, { desc: s.ResultDesc });
    } catch (e) { console.error("callback", e.message); }
  });

  // Backup: ask Safaricom if the callback never arrived
  async function sweep() {
    try {
      const all = (await db.ref("stkreq").get()).val() || {}, now = Date.now();
      for (const [uid, m] of Object.entries(all)) for (const [id, k] of Object.entries(m || {})) {
        if (k.status === "queued" && now - (k.ts || now) < 36e5) push(uid, id);
        else if (k.status === "sent" && k.checkout && now - (k.sentAt || 0) > 45e3) {
          if (now - (k.sentAt || 0) > 6e5) { await settle(uid, id, false, { desc: "No reply from M-Pesa." }); continue; }
          try {
            const c = await cfgGet(), ts = stamp();
            const r = await api(c, "/mpesa/stkpushquery/v1/query", { BusinessShortCode: c.shortcode, Password: Buffer.from(c.shortcode + c.pass + ts).toString("base64"), Timestamp: ts, CheckoutRequestID: k.checkout });
            if (r.j.ResultCode === undefined) continue; // still processing
            if (+r.j.ResultCode === 0) await settle(uid, id, true, { amount: k.amount, phone: k.phone, checkout: k.checkout });
            else await settle(uid, id, false, { desc: r.j.ResultDesc });
          } catch (e) { /* try again next sweep */ }
        }
      }
    } catch (e) { console.error("sweep", e.message); }
  }
  db.ref("stkreq").on("value", () => sweep(), () => {});
  setInterval(sweep, 20000);
};
