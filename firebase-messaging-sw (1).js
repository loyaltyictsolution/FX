// Put this file next to index.html (same folder, same site). It receives phone alerts while the app is closed.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js", "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyCKACM1fsSOqTiRfCc10Lr0f2oaLEv2k-Q", authDomain: "loyalty-fx.firebaseapp.com", databaseURL: "https://loyalty-fx-default-rtdb.firebaseio.com",
  projectId: "loyalty-fx", appId: "1:754089568350:web:6258778a93f4c941c16ccf", messagingSenderId: "754089568350"
});
firebase.messaging();   // notification messages are shown automatically by the browser
