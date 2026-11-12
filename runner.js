// Keeps the "Server" account of Loyalty FX Radar signed in and running 24/7.
// It opens the app in a headless browser, logs in, and restarts itself if anything stalls.
const { chromium } = require("playwright");
const http = require("http");

const APP_URL = process.env.APP_URL;
const EMAIL = process.env.SERVER_EMAIL || "loyaltyitsolutionss@gmail.com";
const PASSWORD = process.env.SERVER_PASSWORD;
const PORT = +process.env.PORT || 3000;
const STALL_MS = 4 * 60 * 1000;      // reload if "Synced" has not refreshed for 4 minutes
const REFRESH_MS = 6 * 60 * 60 * 1000; // fresh page every 6 hours

if (!APP_URL || !PASSWORD) {
  console.error("Set APP_URL and SERVER_PASSWORD environment variables.");
  process.exit(1);
}

let status = { ok: false, note: "starting", at: Date.now() };
const log = (m) => console.log(new Date().toISOString(), m);

// Tiny health endpoint so hosts like Render/Railway keep the service alive.
http.createServer((_, res) => {
  res.writeHead(status.ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify(status));
}).listen(PORT, () => log("health endpoint on :" + PORT));

async function login(page) {
  await page.waitForSelector("#em, #syncinfo", { timeout: 60000 });
  if (await page.locator("#em").isVisible().catch(() => false)) {
    await page.fill("#em", EMAIL);
    await page.fill("#pw", PASSWORD);
    await page.locator("#lf").evaluate((f) => f.requestSubmit());
    await page.waitForTimeout(12000);
    if (await page.locator("#pw").isVisible().catch(() => false)) {
      const err = await page.locator("#err").textContent().catch(() => "");
      throw new Error("Login failed: " + (err || "unknown"));
    }
  }
}

async function syncAge(page) {
  const t = await page.locator("#syncinfo").textContent().catch(() => "");
  const m = /Synced\s+(\d+)(s|m)/.exec(t || "");
  if (!m) return null;
  return m[2] === "m" ? +m[1] * 60000 : +m[1] * 1000;
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  let dead = false;
  page.on("crash", () => (dead = true));
  page.on("close", () => (dead = true));
  browser.on("disconnected", () => (dead = true));

  const start = Date.now();
  let lastGood = Date.now();
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await login(page);
  log("signed in as " + EMAIL);

  while (!dead) {
    await new Promise((r) => setTimeout(r, 30000));
    if (dead) break;
    if (Date.now() - start > REFRESH_MS) { log("scheduled refresh"); break; }
    if (await page.locator("#em").isVisible().catch(() => false)) {
      log("signed out, logging in again");
      await login(page);
    }
    const age = await syncAge(page);
    if (age !== null && age < STALL_MS) lastGood = Date.now();
    status = { ok: Date.now() - lastGood < STALL_MS, note: age === null ? "waiting" : "synced " + Math.round(age / 1000) + "s ago", at: Date.now() };
    if (Date.now() - lastGood > STALL_MS * 2) { log("stalled, restarting"); break; }
  }
  await browser.close().catch(() => {});
}

(async () => {
  for (;;) {
    try { await run(); } catch (e) { log("error: " + e.message); status = { ok: false, note: e.message, at: Date.now() }; }
    await new Promise((r) => setTimeout(r, 15000));
  }
})();
