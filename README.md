# Forex Radar (browser only, alerts only, no orders)

Everything runs in the portal page. No Python, no Telegram, no MT5 terminal.
(The old `backend/` folder is optional and unused. Ignore it.)

## Setup
1. Firebase > Realtime Database > Rules: paste `database.rules.json`, Publish.
2. Authentication: Email/Password on, your user added, sign-ups off.
3. Database Data tab: `admins` > `<your UID>` = true (boolean).
4. Paste your Firebase web config into `index.html` (`firebaseConfig`).
5. Get a free key at twelvedata.com (check the plan's limits there).
6. Push to GitHub Pages, sign in, open **Admin settings**, paste the key, Save.

## Limits (read these)
- Alerts work only while the page is open in a browser tab. Closing it stops them.
- Use "Keep screen on" and keep the tab open on a laptop that is not asleep.
- Free price plans limit requests. If no live stream is allowed, the page refreshes every ~11 minutes.
- Prices come from a data provider, not your Exness account, so quotes can differ slightly.
- Signals are rule-based scores (trend, momentum, RSI, volatility), not trained AI.
- Forex is closed from Friday ~22:00 to Sunday ~22:00 UTC.
