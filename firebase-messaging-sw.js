// Receives alerts while the dashboard is closed. Paste the SAME values as index.html.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({ apiKey: "PASTE", projectId: "PASTE", messagingSenderId: "PASTE", appId: "PASTE" });
firebase.messaging();   // shows notifications that include a title/body automatically
