// Put this file next to index.html (same folder, same site). It receives phone alerts while the app is closed.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js", "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyCKACM1fsSOqTiRfCc10Lr0f2oaLEv2k-Q", authDomain: "loyalty-fx.firebaseapp.com", databaseURL: "https://loyalty-fx-default-rtdb.firebaseio.com",
  projectId: "loyalty-fx", appId: "1:754089568350:web:6258778a93f4c941c16ccf", messagingSenderId: "754089568350"
});
firebase.messaging();   // notification messages are shown automatically by the browser

// ---- installable app shell: open the last good page when offline ----
const SHELL = "lfx-shell-v1";
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then(c => c.addAll(["./", "manifest.webmanifest", "icon-192.png"])).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== SHELL).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET" || r.mode !== "navigate") return;
  e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(SHELL).then(c => c.put("./", cp)); } return res; }).catch(() => caches.match("./")));
});
