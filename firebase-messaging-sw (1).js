importScripts("https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging-compat.js");

firebase.initializeApp({
    apiKey: "AIzaSyBUPIULkKxZx0d7sX6kag2Fa-nmkgjnDA8",
    authDomain: "livesupports-65142.firebaseapp.com",
    databaseURL: "https://livesupports-65142-default-rtdb.firebaseio.com",
    projectId: "livesupports-65142",
    storageBucket: "livesupports-65142.firebasestorage.app",
    messagingSenderId: "697418784895",
    appId: "1:697418784895:web:c1f21e30d218a1cb3f9f4a"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    // 🆕 Ab hum "data" payload se khud notification bana rahe hain (notification field
    // nahi bhej rahe server se) - isse vibrate, icon sab hamesha lagu honge, chahe
    // Android/Chrome default behavior kuch bhi ho.
    const notificationTitle = payload.data && payload.data.title ? payload.data.title : 'Live Support';
    const notificationOptions = {
        body: (payload.data && payload.data.body) || '',
        icon: "https://cdn-icons-png.flaticon.com/512/8280/8280802.png",
        vibrate: [200, 100, 200, 100, 200],
        data: payload.data || {}
    };
    self.registration.showNotification(notificationTitle, notificationOptions);
});

// 🆕 Notification pe tap karne se seedhे admin dashboard (us student ki conversation) khulegi
self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    const key = event.notification.data && event.notification.data.key;
    const targetUrl = key ? `./admin.html?key=${key}` : './admin.html';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes('admin.html') && 'focus' in client) {
                    client.focus();
                    client.navigate(targetUrl);
                    return;
                }
            }
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});
