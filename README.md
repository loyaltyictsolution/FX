# Loyalty FX Radar: Signal Server

A small always-on program that fetches prices, works out signals with the **same engine as the app**,
and publishes the shared feed marked as `server`. Users stay green even when every admin is offline.
Admin pages step back while the feed is fresh and take over again if the server is silent for 2 minutes.

It signs in to your database with a **service account key** (full access), so it needs no login account,
no roles and no database-rule changes. It has its own status page (the live icon, last publish time, pairs).

## What it does
- Reads your Twelve Data key and tracked markets from the app's saved settings (or from environment variables).
- Loads 1 day of history per pair, then follows the live price stream (polls if the stream is quiet).
- Every 5 seconds recomputes signals, then publishes the feed (at most once per 4 seconds), plus the charts
  and the signal-results records the app already uses.

## Set up (once)
1. Firebase console > Project settings > Service accounts > **Generate new private key**. Keep the file private.
2. Pick a host that stays on (Render, Railway, Fly.io, or a small VPS). Deploy this folder with the Dockerfile.
3. Add the key as a **secret** named `FIREBASE_SERVICE_ACCOUNT` (paste the whole JSON). Nothing else is required.
4. Open the host's address: you should see the live icon turn green and your pairs listed.
5. Optional: run `npm install && npm test` first to check the engine on your own computer.

## Notes
- Price source: Twelve Data (the free plan is enough for about 5 pairs). Other sources are not in this version.
- The public landing-page preview and win-rate stats that the admin page writes are not included yet.
  The signal results records are written, so results tracking keeps working.
- The `loyaltyitsolutionss@gmail.com` Server account in the app is no longer needed to keep things running;
  it can stay as the owner-only label.
- Never put the key in the web page or in a public repository.
