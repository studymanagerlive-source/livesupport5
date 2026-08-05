// netlify/functions/send-notification.js
// Ye function wahi "missing piece" hai jo actually FCM ko bolta hai
// ki registered token(s) pe push notification bhej do.
//
// Trigger hota hai: student jab "key" enter karke chat shuru kare, ya
// koi bhi message/media bheje.

const admin = require('firebase-admin');

// Firebase Admin SDK - sirf ek baar initialize hoga (cold start pe)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://livesupports-65142-default-rtdb.firebaseio.com'
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { key, message, type } = JSON.parse(event.body || '{}');
    if (!key) {
      return { statusCode: 400, body: JSON.stringify({ error: 'key is required' }) };
    }

    const db = admin.database();

    // Registered admin devices (phone/laptop) ke saare FCM tokens uthao
    const tokensSnap = await db.ref('admin_settings/fcm_tokens').once('value');
    const tokensObj = tokensSnap.val() || {};
    const tokenEntries = Object.entries(tokensObj); // [ [pushId, token], ... ]

    // 🆕 Duplicate tokens (agar purane data me ban gaye the) sirf ek baar bhejenge
    const seen = new Set();
    const uniqueTokenEntries = tokenEntries.filter(([, token]) => {
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    });

    if (uniqueTokenEntries.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ sent: 0, note: 'Abhi koi admin device registered nahi hai (notification permission allow nahi hui)' })
      };
    }

    const title = type === 'new_session'
      ? `🟢 ${key}`
      : `💬 ${key}`;

    // 🆕 Privacy: message ka actual content kabhi notification me nahi dikhाya jayega,
    // sirf key aur generic status dikhega
    const body = type === 'new_session'
      ? 'is live now'
      : 'New Update';

    // 🆕 Sirf "data" bhej rahe hain (notification field nahi) - isse Chrome/Android
    // apni marzi se notification nahi dikhayega, hamara service worker khud
    // poori notification banayega (icon, vibrate, click-action sab control me rahega)
    const messagePayload = {
      data: {
        title,
        body,
        key: String(key),
        click_action: `/admin.html?key=${key}`
      },
      tokens: uniqueTokenEntries.map(([, token]) => token)
    };

    const response = await admin.messaging().sendEachForMulticast(messagePayload);

    // Expired/invalid tokens ko Firebase se saaf kar do taaki list saaf rahe
    const removals = [];
    response.responses.forEach((res, idx) => {
      if (!res.success) {
        const [pushId] = uniqueTokenEntries[idx];
        removals.push(db.ref('admin_settings/fcm_tokens/' + pushId).remove());
      }
    });
    await Promise.all(removals);

    return {
      statusCode: 200,
      body: JSON.stringify({ sent: response.successCount, failed: response.failureCount })
    };
  } catch (err) {
    console.error('send-notification error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
