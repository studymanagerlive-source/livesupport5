// Cloudflare Worker for Firebase Cloud Messaging (FCM) v1
// NOTE: Ye "Worker" format hai (Pages Functions nahi) - poora export default { fetch() } hona zaroori hai

export default {
    async fetch(request, env, ctx) {
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        if (request.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
        }

        try {
            const payload = await request.json();
            const { key, message, type } = payload;

            if (!key) {
                console.log("❌ Missing key in request");
                return new Response(JSON.stringify({ error: "Missing key" }), { status: 400, headers: corsHeaders });
            }

            if (!env.FIREBASE_SERVICE_ACCOUNT) {
                console.log("❌ FIREBASE_SERVICE_ACCOUNT environment variable missing in Cloudflare Worker settings!");
                return new Response(JSON.stringify({ error: "Missing Firebase Credentials in Worker env vars" }), { status: 500, headers: corsHeaders });
            }

            let serviceAccount;
            try {
                serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
            } catch (e) {
                console.log("❌ FIREBASE_SERVICE_ACCOUNT JSON parse failed:", e.message);
                return new Response(JSON.stringify({ error: "Invalid FIREBASE_SERVICE_ACCOUNT JSON" }), { status: 500, headers: corsHeaders });
            }

            const projectId = serviceAccount.project_id;
            const accessToken = await getGoogleAuthToken(serviceAccount);

            if (!accessToken) {
                console.log("❌ Failed to get Google OAuth access token - check private_key/client_email in service account");
                return new Response(JSON.stringify({ error: "Auth token generation failed" }), { status: 500, headers: corsHeaders });
            }

            const dbUrl = `https://${projectId}-default-rtdb.firebaseio.com/admin_settings/fcm_tokens.json?access_token=${accessToken}`;
            const dbResponse = await fetch(dbUrl);
            const tokensObj = await dbResponse.json();

            if (!tokensObj) {
                console.log("⚠️ No FCM tokens registered yet (admin never granted notification permission)");
                return new Response(JSON.stringify({ success: true, sent: 0, note: "No tokens found" }), { headers: corsHeaders });
            }

            const tokenEntries = Object.entries(tokensObj);
            const seen = new Set();
            const uniqueEntries = tokenEntries.filter(([, token]) => {
                if (seen.has(token)) return false;
                seen.add(token);
                return true;
            });

            const title = type === 'new_session' ? `🟢 ${key}` : `💬 ${key}`;
            const body = type === 'new_session' ? 'is live now' : 'New Update';

            let successCount = 0;
            const invalidPushIds = [];

            for (const [pushId, token] of uniqueEntries) {
                const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
                const fcmPayload = {
                    message: {
                        token: token,
                        data: {
                            title,
                            body,
                            key: String(key),
                            click_action: `/admin.html?key=${key}`
                        },
                        webpush: {
                            fcm_options: { link: `https://${request.headers.get("host")}/admin.html?key=${key}` }
                        }
                    }
                };
                const fcmResponse = await fetch(fcmUrl, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                    body: JSON.stringify(fcmPayload)
                });

                if (fcmResponse.ok) {
                    successCount++;
                } else {
                    const errBody = await fcmResponse.text();
                    console.log(`⚠️ FCM send failed for token ${pushId}:`, errBody);
                    if (fcmResponse.status === 404 || fcmResponse.status === 400) {
                        invalidPushIds.push(pushId);
                    }
                }
            }

            for (const pushId of invalidPushIds) {
                await fetch(`https://${projectId}-default-rtdb.firebaseio.com/admin_settings/fcm_tokens/${pushId}.json?access_token=${accessToken}`, { method: "DELETE" });
            }

            console.log(`✅ Notification sent: ${successCount}/${uniqueEntries.length}`);
            return new Response(JSON.stringify({ success: true, sent: successCount, total: uniqueEntries.length }), { headers: corsHeaders });

        } catch (error) {
            console.log("❌ send-notification error:", error.message);
            return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
        }
    }
};

async function getGoogleAuthToken(credentials) {
    try {
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
        const signatureInput = `${base64UrlEncode(header)}.${base64UrlEncode(claim)}`;
        const pem = credentials.private_key.replace(/(?:-----(?:BEGIN|END) PRIVATE KEY-----|\s)/g, "");
        const binaryDerString = atob(pem);
        const binaryDer = new Uint8Array(binaryDerString.length);
        for (let i = 0; i < binaryDerString.length; i++) binaryDer[i] = binaryDerString.charCodeAt(i);
        const key = await crypto.subtle.importKey("pkcs8", binaryDer.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
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
        if (!data.access_token) { console.log("❌ OAuth token response:", JSON.stringify(data)); }
        return data.access_token;
    } catch (e) {
        console.log("❌ getGoogleAuthToken error:", e.message);
        return null;
    }
}
