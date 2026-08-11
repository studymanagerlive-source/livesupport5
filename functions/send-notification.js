// Cloudflare Pages Function for Firebase Cloud Messaging (FCM) v1
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

        // Environment Variable se Firebase credentials nikalna
        if (!env.FIREBASE_SERVICE_ACCOUNT) {
            return new Response(JSON.stringify({ error: "Missing Firebase Credentials in Cloudflare" }), { status: 500, headers: corsHeaders });
        }

        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const projectId = serviceAccount.project_id;

        // 1. Get OAuth 2.0 Access Token
        const accessToken = await getGoogleAuthToken(serviceAccount);

        // 2. Fetch FCM Tokens from Firebase Realtime Database
        const dbUrl = `https://${projectId}-default-rtdb.firebaseio.com/admin_settings/fcm_tokens.json?access_token=${accessToken}`;
        const dbResponse = await fetch(dbUrl);
        const tokensObj = await dbResponse.json();

        if (!tokensObj) {
            return new Response(JSON.stringify({ success: true, message: "No tokens found" }), { headers: corsHeaders });
        }

        const tokens = Object.values(tokensObj);
        let successCount = 0;

        // 3. Send Notification to all tokens
        for (const token of tokens) {
            const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
            const fcmPayload = {
                message: {
                    token: token,
                    notification: {
                        title: type === 'new_session' ? `Student Online (Key: ${key})` : `New Message (Key: ${key})`,
                        body: message
                    },
                    webpush: {
                        fcm_options: { link: `https://${request.headers.get("host")}/admin.html?key=${key}` }
                    }
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

            if (fcmResponse.ok) successCount++;
        }

        return new Response(JSON.stringify({ success: true, sent: successCount }), { headers: corsHeaders });

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
        scope: "https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase.database",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now
    };

    const base64UrlEncode = (obj) => btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const encodedHeader = base64UrlEncode(header);
    const encodedClaim = base64UrlEncode(claim);
    const signatureInput = `${encodedHeader}.${encodedClaim}`;

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
    const encodedSignature = btoa(binarySignature).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

    const jwt = `${signatureInput}.${encodedSignature}`;

    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt })
    });

    const data = await response.json();
    return data.access_token;
}
