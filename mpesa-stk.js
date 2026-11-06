// mpesa-stk.js — M-Pesa prompt (STK Push) worker for Steve FX Radar. SKELETON: written from Safaricom's public Daraja
// documentation and NOT tested, because it needs your own Daraja credentials. Add to radar-engine.js with:
//     require("./mpesa-stk").start(db);          // db = admin.database()
// Needs env vars: DARAJA_KEY, DARAJA_SECRET, DARAJA_SHORTCODE, DARAJA_PASSKEY, DARAJA_CALLBACK (public https URL), DARAJA_ENV=sandbox|production
// Flow: a member taps "Send M-Pesa prompt" -> page writes stkreq/<uid>/<id> {status:"queued"} -> this worker calls Daraja and sets
// status "sent" (or "failed" + msg). When Safaricom calls DARAJA_CALLBACK with the result, call settle() below to mark it "paid" and
// create a pending payment with the real receipt number for you to approve (or auto-approve once you trust it).
// The callback needs a public https endpoint (a small server or a Cloud Function). This file cannot receive it on its own.
const BASE = process.env.DARAJA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
async function token() {
  const r = await fetch(BASE + "/oauth/v1/generate?grant_type=client_credentials", { headers: { Authorization: "Basic " + Buffer.from(process.env.DARAJA_KEY + ":" + process.env.DARAJA_SECRET).toString("base64") } });
  if (!r.ok) throw new Error("Daraja token " + r.status); return (await r.json()).access_token;
}
const stamp = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14);
async function push(req) {
  const ts = stamp(), sc = process.env.DARAJA_SHORTCODE, pw = Buffer.from(sc + process.env.DARAJA_PASSKEY + ts).toString("base64");
  const r = await fetch(BASE + "/mpesa/stkpush/v1/processrequest", { method: "POST", headers: { Authorization: "Bearer " + await token(), "Content-Type": "application/json" },
    body: JSON.stringify({ BusinessShortCode: sc, Password: pw, Timestamp: ts, TransactionType: "CustomerPayBillOnline", Amount: Math.round(req.amount), PartyA: req.phone, PartyB: sc, PhoneNumber: req.phone,
      CallBackURL: process.env.DARAJA_CALLBACK, AccountReference: ("FX" + req.plan).slice(0, 12), TransactionDesc: (req.plan + " " + req.days + "d").slice(0, 13) }) });
  const j = await r.json(); if (!r.ok || j.ResponseCode !== "0") throw new Error(j.errorMessage || j.ResponseDescription || "Daraja " + r.status); return j;   // j.CheckoutRequestID ties the callback to this request
}
exports.start = db => {
  db.ref("stkreq").on("child_added", usnap => usnap.ref.on("child_added", async s => {
    const q = s.val(); if (!q || q.status !== "queued") return;
    try { const j = await push(q); await s.ref.update({ status: "sent", checkout: j.CheckoutRequestID }); }
    catch (e) { await s.ref.update({ status: "failed", msg: String(e.message).slice(0, 120) }); }
  }));
};
exports.settle = async (db, checkoutId, ok, receipt, amount) => {      // call from your callback endpoint
  const all = (await db.ref("stkreq").once("value")).val() || {};
  for (const [uid, m] of Object.entries(all)) for (const [id, q] of Object.entries(m)) if (q.checkout === checkoutId) {
    if (!ok) return db.ref(`stkreq/${uid}/${id}`).update({ status: "failed", msg: "Payment was cancelled or failed." });
    await db.ref(`stkreq/${uid}/${id}`).update({ status: "paid", receipt });
    const pid = db.ref("payments/" + uid).push().key;     // shows up in your Payments tab with the real receipt code
    return db.ref().update({ [`payments/${uid}/${pid}`]: { method: "mpesa", code: receipt, status: "pending", ts: Date.now(), email: q.email || "", payer: q.phone, amount, via: "stk" }, ["paycodes/" + receipt]: uid });
  }
};
