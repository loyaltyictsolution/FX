# Forex Radar (alerts only, no orders)

## 1. Firebase setup (once)
1. Build > Realtime Database > Create. Paste `database.rules.json` into Rules, Publish.
2. Build > Authentication > Sign-in method > enable **Email/Password**.
3. Authentication > Settings > User actions > **untick "Enable create (sign-up)"**. Now only users you add can log in.
4. Authentication > Users > Add user (your email + a strong password). Copy that user's **UID**.
5. Realtime Database > Data > add: `admins` > `<your-UID>` = `true` (boolean). Only these UIDs get admin controls.
6. Project settings > Service accounts > Generate key. Save as `backend/serviceAccount.json`.
7. Project settings > Your apps > Web. Copy the config into `index.html` (firebaseConfig).
8. Google Cloud console > APIs & Services > Credentials > your Browser key > restrict to HTTP referrer `https://YOURNAME.github.io/*`.

## 2. Run the backend (Windows, MT5 open and logged in)
```
cd backend
pip install -r requirements.txt
copy .env.example .env      (fill it in; investor password only)
python main.py
```

## 3. Publish the dashboard
Push to GitHub. Settings > Pages > main branch, root.

## Staying live
- Backend writes every pair every 2 s and a heartbeat every second.
- It auto-reconnects to MT5 if the terminal drops.
- Dashboard: LIVE, STALE DATA (feed or writes older than 10 s), OFFLINE (no heartbeat for 15 s or browser disconnected).
- Admin buttons: Refresh now, Retrain, Pause, Min confidence. All enforced by database rules, not just the UI.
- Sessions end when the tab closes and after 30 minutes idle.

## Never commit
`.env`, `serviceAccount.json` (already in `.gitignore`).

## Phone alerts (no need to open the dashboard)
1. In Telegram, message @BotFather, send `/newbot`, follow the steps. Copy the token.
2. Open your new bot and send it any message (for example "hi").
3. In a browser open `https://api.telegram.org/bot<TOKEN>/getUpdates`. Copy the number under `"chat":{"id":...}`.
4. Put both values in `backend/.env` as TELEGRAM_TOKEN and TELEGRAM_CHAT_ID. Restart `main.py`.

## Start the backend automatically (Windows)
1. Create `backend/start.bat`:  
   `cd /d C:\path\to\forex-radar\backend` then `python main.py`
2. Task Scheduler > Create Task > Triggers: At log on > Actions: start `start.bat` > tick "Run whether user is logged on or not" only if MT5 also auto-starts.
3. Put MT5 in the Startup folder (Win+R, `shell:startup`) so it opens at login.

## Web push alerts (phone or PC browser, dashboard closed)
1. Firebase > Project settings > Cloud Messaging > Web Push certificates > **Generate key pair**. Copy it into `VAPID_KEY` in `index.html`.
2. Paste your Firebase config (apiKey, projectId, **messagingSenderId**, appId) into BOTH `index.html` and `firebase-messaging-sw.js`.
3. Set `DASHBOARD_URL` in `backend/.env`. Re-publish the rules. Restart `main.py`.
4. Open the dashboard on each device, sign in, tap **Enable phone alerts**, allow notifications.
- Android Chrome: works in the browser. iPhone (iOS 16.4+): first tap Share > Add to Home Screen, then open the app from the icon and enable alerts.
- Site must be HTTPS (GitHub Pages is).
