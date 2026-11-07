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

# Install on phones (Android and iPhone)

Upload these files next to `index.html`: `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, and the updated `firebase-messaging-sw.js`. The site must use https.

Send members this link: `https://YOUR-SITE/?install=1`
- Android (Chrome): an Install button appears. If it does not, the page explains Menu, Install app.
- iPhone: the page shows Share, Add to Home Screen. It must be opened in Safari (links opened inside WhatsApp or Instagram should be copied into Safari).
- Once installed it opens like an app and phone alerts work on iPhone too.

# Extra protection

- Firebase App Check: Firebase console, App Check, register the web app with reCAPTCHA v3, then paste the site key into `window.APPCHECK_KEY` at the top of `index.html`. Watch the metrics for a few days, then switch on enforcement for Realtime Database.
- Google Cloud console, APIs and Services, Credentials: restrict the browser API key to your site address (HTTP referrers).
- `pushCleanup` runs daily and removes old push log entries. `settings/newsErr` shows the last news fetch error.
- Redeploy functions after updating: `firebase deploy --only functions`. Publish the new `database_rules.json`.
