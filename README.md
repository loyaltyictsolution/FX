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
