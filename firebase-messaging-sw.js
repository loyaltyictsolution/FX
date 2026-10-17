// Receives alerts while the dashboard is closed. Use the SAME values as index.html.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({ apiKey: "AIzaSyCKACM1fsSOqTiRfCc10Lr0f2oaLEv2k-Q", projectId: "loyalty-fx", messagingSenderId: "754089568350", appId: "1:754089568350:web:6258778a93f4c941c16ccf" });
firebase.messaging();   // shows notifications that include a title/body automatically
