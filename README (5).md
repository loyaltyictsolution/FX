# Steve FX Radar engine (24/7)

Runs the same signal maths as the web page on a server, so signals, levels, the 24-hour analysis and the live results log keep running when your admin page is closed.

## One-time setup
1. Firebase Console > Project settings > Service accounts > Generate new private key.
   Save the file as `serviceAccount.json` next to `radar-engine.js` on the SERVER.
   Never put this file in your GitHub Pages repo. Anyone who has it controls your database.
2. Save your Twelve Data key once in the admin page (Settings). The engine reads it from the database.
3. On the server (Node 18 or newer):
   ```
   cd engine
   npm install
   export GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json
   node radar-engine.js
   ```
   You should see "loaded EUR/USD 1440 candles" for each pair, then "Steve FX Radar engine is running".

## Keep it running
```
npm i -g pm2
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json pm2 start radar-engine.js --name radar
pm2 save
pm2 startup      # then run the command it prints
pm2 logs radar
```

## How it works with the web page
- The engine writes `feed` with `src: "server"` and refreshes it every 20 seconds.
- When your admin page sees a fresh server feed it stops its own engine and just displays the feed.
- If the server stops for more than 2 minutes, the admin page takes over again by itself.
- Change markets or strength in the admin page. The engine picks it up within a minute.

## Notes
- Use ONE engine at a time. Do not run two servers.
- The Twelve Data plan sets the limits. Without live WebSocket access it falls back to polling, which on the free plan is too slow for 1-minute signals.

## Charts for members
- The engine also writes candles to `feed/ch/<pair>/<timeframe>` once a minute (1m, 5m, 15m, 1h), so members see the same charts as the admin page.
- Members already read `feed`, so no new database rule is needed if your rule is on `feed` itself. If you gave read access to `feed/pairs` only, extend it to `feed/ch`.

## Plans and levels
- Admin page, Settings: add one plan per line as `Name | Price | Length | Level`. Lengths: `30min`, `2h`, `1d`, `1w`, `1mo`, `1y`. Levels: Basic, Pro, VIP.
- The engine also removes access when a timed plan runs out (checked every minute), so hourly plans end on time even when no admin page is open.

## Locking the site to paying members
- `database.rules.json` is the server-side lock (admins and superadmins lists are readable by admins only). Firebase Console > Realtime Database > Rules: compare it with your current rules, paste it in, then test with the Rules Playground before you click Publish.
- Without these rules the page hides things but Firebase will still hand the data to anyone with an account. The rules make prices, signals, results, news and the member chat unreadable unless the account is approved and not expired. Admins and super admins are always allowed.
- Only super admins (and the owner email) can write `approved` and `memberships`, so only they can confirm payments.
- The Firebase web key is public, so anyone can create an account through the API. With these rules a new account sees only the payment page.

## CBK official shilling rates
- The engine reads the public Central Bank of Kenya forex page on start and every 6 hours, keeps only the newest day, and writes it to `feed/cbk`. Paid members and admins see it as a panel with an "as of" date.
- Watch the log: `CBK rates updated: 10 currencies, as of 2026-...` means it works. `no rate rows were found` means CBK changed the page layout: send me the page source and I will fix the parser.

## Terminating a subscription and member rules
- Admin page, Team, roles & access: super admins see a red **Terminate** button on every paid member. It ends access immediately, signs the member out, and shows them your reason on their Membership panel. A later payment or approval clears the notice.
- Admin page, Settings: the **Membership rules** box is shown to every member and must be ticked before they can send a payment code. Acceptance is saved on the payment record (`rulesOk`).
- Publish the updated `database.rules.json` so only super admins can change the rules text.
