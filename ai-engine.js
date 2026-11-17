// Ask AI: POST /ai/explain  (members and admins only)
// Needs env: ANTHROPIC_API_KEY   Optional: AI_MODEL
const SYS = "You explain a forex/crypto trading signal to a beginner in Kenya. Use plain English, 4 to 6 short sentences, no jargon, no emojis. " +
  "Say what the signal means, why the radar gave it (use the reason, trend and volatility given), and what to do about the stop loss and targets if levels are given. " +
  "If the signal is DANGER or WAIT, say to stay out of new trades. A caution warning on an active trade is not an exit order: the stop loss is the exit. " +
  "Never promise profit. Never invent numbers that were not given.";
const hits = new Map();
const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const str = (v, n) => String(v == null ? "" : v).replace(/[\r\n]+/g, " ").slice(0, n);

module.exports = function installAI(app, ctx) {
  app.post("/ai/explain", ctx.auth, async (req, res) => {
    try {
      if (!(await ctx.canUseRadar(req.user))) return res.status(403).json({ error: "Your membership is not active." });
      if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "The AI key is not set on the server." });
      const now = Date.now(), arr = (hits.get(req.user.uid) || []).filter(t => now - t < 6e5);
      if (arr.length >= 15) return res.status(429).json({ error: "Too many questions. Try again in a few minutes." });
      arr.push(now); hits.set(req.user.uid, arr);
      const b = req.body || {};
      const facts = {
        pair: str(b.pair, 12), signal: str(b.signal, 8), price: num(b.price), reason: str(b.reason, 80),
        trend: str(b.trend, 10), volatility: str(b.volatility, 10),
        entry: num(b.entry), stop: num(b.stop), target1: num(b.t1), target2: num(b.t2),
        member_trade: b.trade && typeof b.trade === "object" ? { side: str(b.trade.side, 4), entry: num(b.trade.entry), stop: num(b.trade.stop), r_now: num(b.trade.r) } : null
      };
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: AbortSignal.timeout(25000),
        headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.AI_MODEL || "claude-haiku-5-5", max_tokens: 350, system: SYS,
          messages: [{ role: "user", content: "Explain this signal:\n" + JSON.stringify(facts) }] })
      });
      const j = await r.json().catch(() => ({}));
      const text = j && j.content && j.content[0] && j.content[0].text;
      if (!r.ok || !text) { console.error("AI error", r.status, JSON.stringify(j).slice(0, 300)); return res.status(502).json({ error: "The AI could not answer right now." }); }
      res.json({ text: text.trim() });
    } catch (e) { console.error("ai/explain", e.message); res.status(502).json({ error: "The AI could not answer right now." }); }
  });
};
