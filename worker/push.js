/**
 * Minimal Web Push sender for Cloudflare Workers — no dependencies.
 * Implements RFC 8291 (aes128gcm message encryption) + RFC 8292 (VAPID).
 *
 * VAPID keys are the standard `npx web-push generate-vapid-keys` pair:
 *   VAPID_PUBLIC_KEY  — base64url, 65-byte uncompressed P-256 point
 *   VAPID_PRIVATE_KEY — base64url, 32-byte scalar
 *   VAPID_SUBJECT     — "mailto:you@example.com"
 */

const te = new TextEncoder();

export function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// Import the VAPID private key (raw d + public x,y) as an ECDSA JWK.
async function importVapidKey(env) {
  const pub = b64urlDecode(env.VAPID_PUBLIC_KEY);   // 0x04 || x(32) || y(32)
  const d = b64urlDecode(env.VAPID_PRIVATE_KEY);
  return crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256",
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: b64urlEncode(d),
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// RFC 8292 VAPID Authorization header for the push endpoint's origin.
async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(te.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
  })));
  const signingInput = `${header}.${claims}`;
  const key = await importVapidKey(env);
  const sig = await crypto.subtle.sign(               // WebCrypto returns raw r||s — what JWS wants
    { name: "ECDSA", hash: "SHA-256" }, key, te.encode(signingInput));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// RFC 8291: encrypt a payload for one subscription (aes128gcm).
async function encryptPayload(sub, payload) {
  const uaPub = b64urlDecode(sub.keys.p256dh);        // 65-byte point
  const authSecret = b64urlDecode(sub.keys.auth);     // 16 bytes
  const asKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub,
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdh,
    concat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  const plaintext = concat(te.encode(payload), new Uint8Array([2]));  // 0x02 = last record
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  // Header block: salt(16) | rs(4) | idlen(1) | keyid(65) — then the ciphertext.
  const rs = new Uint8Array([0, 0, 16, 0]);           // 4096 record size
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/**
 * Send `payload` (object → JSON) to each subscription. Returns the endpoints
 * that are dead (404/410) so the caller can prune them.
 */
export async function sendPush(env, subs, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const dead = [];
  await Promise.all(subs.map(async (sub) => {
    try {
      const body = await encryptPayload(sub, payload);
      const r = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          "TTL": "86400",
          "Urgency": "normal",
          "Authorization": await vapidAuth(env, sub.endpoint),
        },
        body,
      });
      if (r.status === 404 || r.status === 410) dead.push(sub.endpoint);
    } catch (e) {
      // One bad subscription must not block the rest.
      console.log("push failed:", sub.endpoint, String(e));
    }
  }));
  return dead;
}
