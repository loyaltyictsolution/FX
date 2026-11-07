# Test before you send the link to members

Use a staging Firebase project first (see README, "Staging"), then repeat the key checks on the live site.

## Android (Chrome)
1. Open `https://YOUR-SITE/?install=1`. The Install button should appear. Install it.
2. Open the app from the Home Screen: it should open full screen with the Loyalty FX Radar icon.
3. Sign in as a member. Notification settings, then Turn on phone alerts. Allow notifications.
4. Close the app completely. Create a price alert that will trigger soon. You should get ONE phone alert. Tap it: the app opens on that pair.
5. Open the app while another alert triggers: you should get the in-app alert only, not a second phone alert.
6. Set quiet hours to include the current time. No phone alerts should arrive (renewals and price alerts still do).
7. Mute one pair, switch off DANGER signals: no phone alerts for those.

## iPhone (Safari)
1. Open the link in Safari (not inside WhatsApp). Share, Add to Home Screen.
2. Open it from the Home Screen, then turn on phone alerts (this only works after the Home Screen install).
3. Repeat steps 4 to 7 above.

## Everyone
- Live signal light: green while the feed updates, yellow if it pauses, red on weekends with the opening time shown in the member's own time zone.
- A normal member must NOT see the BUY/SELL/WAIT/DANGER bar. An admin must see it.
- A membership expiring within 7 days: the reminder alert opens the renew box when tapped.
- Save push key as admin: the checklist row turns to a tick straight away.

## Server
- Firebase console, Functions, Logs: `radarPush` runs every minute, `newsRefresh` every 10 minutes, `pushCleanup` daily, `weeklyBackup` on Sundays.
- Realtime Database, `settings/newsErr` is empty when news is working.
