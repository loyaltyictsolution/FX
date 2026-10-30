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
