# Loyalty FX Radar: Server account runner

Keeps the hidden **Server** account (loyaltyitsolutionss@gmail.com) signed in 24/7 so users get
live signals even when every admin is offline. It publishes the feed marked as "server"; admin pages
step back while it is fresh and take over again automatically if it goes quiet for 2 minutes.

## 1. Create the account (once)
1. As owner or super admin, add a user with email loyaltyitsolutionss@gmail.com and a strong password
   (Admin panel, Add user), or sign up on the login page.
2. Open that Gmail inbox and confirm the verification email. The page only treats the account as Server
   once the email is verified.
3. As owner, make it **Admin** and **Super admin** in the users list. The page labels it "Server" and hides
   it from normal admins; only super admins and the owner can see it.

## 2. Host the runner (any always-on host)
Render, Railway, Fly.io or any VPS. Use the Dockerfile in this folder. Set these environment variables
(never put the password in a file or in the page):

| Variable | Value |
| --- | --- |
| APP_URL | the web address where your index.html is hosted |
| SERVER_PASSWORD | the Server account password |
| SERVER_EMAIL | optional, defaults to loyaltyitsolutionss@gmail.com |

Run as a Web Service (the runner answers a health check on $PORT) or a Background Worker.

## 3. Check it works
- Super admin: the users list shows loyaltyitsolutionss@gmail.com with a "Server" label and online.
- Users: status bar is green and stays green with all admins offline.
- Health endpoint of the runner returns {"ok":true,...}.

The price source key and the database rules are unchanged: the Server account needs the same Admin and
Super admin access in the database that your current super admin has.
