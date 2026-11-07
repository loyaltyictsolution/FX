# Server setup (phone alerts + 24/7 news)

The page works without this. Do this once if you want alerts when the app is closed and headlines that refresh without an admin page open.

Needs: Firebase **Blaze** (pay-as-you-go) plan. At this size the cost is usually a few cents a month, but check Firebase pricing.

1. Install tools:  `npm i -g firebase-tools`  then  `firebase login`
2. In an empty folder run `firebase init functions` (JavaScript, Node 20, project `loyalty-fx`). Replace the generated `functions/index.js` and `functions/package.json` with the ones here, then `cd functions && npm install`.
3. Open `functions/index.js` and set `SITE_URL` to your real site address (or deploy with `SITE_URL` as an environment variable).
4. Deploy:  `firebase deploy --only functions`
5. Upload `firebase-messaging-sw.js` to the **same folder as index.html** on your host.
6. Firebase console, Project settings, Cloud Messaging, Web Push certificates: Generate key pair, copy the public key. In the app, Admin settings, Phone push key: paste and Save.
7. Publish `database_rules.json` (it adds `fcmtokens` and `palerts`).
8. Members open Notification settings, then Turn on phone alerts.

What runs:
- `newsRefresh` every 10 min: uses the news key saved in Admin settings.
- `radarPush` every minute: news-event warnings, market opens, renewal reminders, price alerts, signal changes.

Notes:
- Phone alerts need the page opened over https and a browser that supports web push. On iPhone the app must be added to the Home Screen first.
- Price alerts are watched by the server only for members who turned on phone alerts.
- If the server and an open page both catch the same price alert, the member may get two notices.
