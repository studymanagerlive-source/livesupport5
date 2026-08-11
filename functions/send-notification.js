export async function onRequestPost(context) {
    const { request, env } = context;

    // CORS headers
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const payload = await request.json();
        const { key, message, type } = payload;

        if (!key || !message) {
            return new Response(JSON.stringify({ error: "Missing data" }), { status: 400, headers: corsHeaders });
        }

        if (!env.FIREBASE_SERVICE_ACCOUNT) {
            return new Response(JSON.stringify({ error: "Missing Firebase Credentials" }), { status: 500, headers: corsHeaders });
        }

        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);

        // 🚨 1. PROJECT MISMATCH CHECKER (यह बताएगा कि JSON सही है या गलत)
        if (serviceAccount.project_id !== "livesupports-65142") {
            return new Response(JSON.stringify({
                error: `WRONG FIREBASE JSON! Aapne '${serviceAccount.project_id}' ka JSON daal diya hai. Kripya Firebase Console se 'livesupports-65142' wale project ki nai Private Key (JSON) download karke Cloudflare me daalein.`
            }), { status: 500, headers: corsHeaders });
        }

        const projectId = serviceAccount.project_id;
        const accessToken = await getGoogleAuthToken(serviceAccount);

        // 🚨 2. FETCH FCM TOKENS (Using correct access_token URL parameter for strict RTDB Auth)
        const dbUrl = `https://${projectId}-default-rtdb.firebaseio.com/admin_settings/fcm_tokens.json?access_token=${accessToken}`;
        const dbResponse = await fetch(dbUrl);

        if (dbResponse.status === 401) {
            return new Response(JSON.stringify({ error: "Firebase DB Unauthorized. Your Service Account lacks 'Firebase Realtime Database Admin' permission." }), { status: 500, headers: corsHeaders });
        }

        const tokensObj = await dbResponse.json();

        if (tokensObj && tokensObj.error) {
            return new Response(JSON.stringify({ error: "Firebase DB error: " + JSON.stringify(tokensObj.error) }), { status: 500, headers: corsHeaders });
        }

        if (!tokensObj) {
            return new Response(JSON.stringify({ success: true, message: "No tokens found to send notification." }), { headers: corsHeaders });
        }

        const tokens = Object.values(tokensObj);
        let successCount = 0;
        let errors = [];

        // 3. Send Notification to all tokens
        for (const token of tokens) {
            const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
            const notifTitle = type === 'new_session' ? `Student Online (Key: ${key})` : `New Message (Key: ${key})`;

            const fcmPayload = {
                message: {
                    token: token,
                    data: { title: notifTitle, body: message, key: key },
                    webpush: { fcm_options: { link: `https://${request.headers.get("host")}/admin.html?key=${key}` } }
                }
            };

            const fcmResponse = await fetch(fcmUrl, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(fcmPayload)
            });

            if (fcmResponse.ok) {
                successCount++;
            } else {
                const errText = await fcmResponse.text();
                errors.push({ token: token.slice(0, 12) + "...", error: errText });
            }
        }

        return new Response(JSON.stringify({ success: true, sent: successCount, total: tokens.length, errors }), { headers: corsHeaders });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
}

// --- Helper Function: Generate Google OAuth Token using Web Crypto API ---
async function getGoogleAuthToken(credentials) {
    const header = { alg: "RS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const claim = {
        iss: credentials.client_email,
        // 🚨 REQUIRED SCOPES FOR FIREBASE DB + FCM (Sabse zaruri hissa)
        scope: "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now
    };

    const base64UrlEncode = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const signatureInput = `${base64UrlEncode(header)}.${base64UrlEncode(claim)}`;

    const pem = credentials.private_key.replace(/(?:-----(?:BEGIN|END) PRIVATE KEY-----|\s)/g, "");
    const binaryDerString = atob(pem);
    const binaryDer = new Uint8Array(binaryDerString.length);
    for (let i = 0; i < binaryDerString.length; i++) binaryDer[i] = binaryDerString.charCodeAt(i);

    const key = await crypto.subtle.importKey(
        "pkcs8",
        binaryDer.buffer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signatureInput));
    const signatureBytes = new Uint8Array(signatureBuffer);
    let binarySignature = "";
    for (let i = 0; i < signatureBytes.byteLength; i++) binarySignature += String.fromCharCode(signatureBytes[i]);
    
    const jwt = `${signatureInput}.${btoa(binarySignature).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;

    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt })
    });

    const data = await response.json();
    if (!data.access_token) throw new Error("Google auth failed: " + JSON.stringify(data));
    return data.access_token;
}
