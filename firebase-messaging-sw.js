// Receives alerts while the dashboard is closed. Use the SAME values as index.html.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({ apiKey: "PASTE", projectId: "loyalty-fx", messagingSenderId: "754089568350", appId: "PASTE" });
firebase.messaging();   // shows notifications that include a title/body automatically
