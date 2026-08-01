/**
 * Web Push — the vault's own notification channel.
 *
 * Briefs used to go out through ntfy, which meant a third-party app on the
 * phone and a topic whose only protection was being hard to guess, carrying
 * the evening brief's Charlotte section in cleartext. This replaces it: the
 * Worker signs and encrypts pushes itself, straight to the PWA.
 *
 * Two specs, both implemented here with nothing but WebCrypto (which Workers
 * and Node 20+ both provide, so this file is testable outside the Worker):
 *
 *   RFC 8292 — VAPID. An ES256 JWT that identifies *this* application server
 *              to Apple/Google, so nobody else holding a subscription endpoint
 *              can push to Ben's phone.
 *   RFC 8291 — aes128gcm payload encryption. The push service relays the
 *              message but cannot read it; only the subscribed browser holds
 *              the key. This is the property that makes it safe to send the
 *              relationship advice at all.
 *
 * The one thing this file cannot prove about itself is that Apple and Google
 * accept its output — that needs a real device. See docs/push-notifications.md.
 */

const te = new TextEncoder();

/* --------------------------------------------------------------- encoding */

export function b64urlToBytes(s) {
  const norm = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(b) {
  const bytes = new Uint8Array(b);
  let bin = "";
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on a
  // 4KB payload, which is exactly the size we send.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/* ------------------------------------------------------------------ VAPID */

// The private key is stored as the raw 32-byte scalar `d`, and the public key
// as the uncompressed point 0x04||x||y. WebCrypto will only import a private
// EC key as JWK or PKCS#8, so the point is split back into x and y here.
async function importVapidKey(publicKeyB64, privateKeyB64) {
  const pub = b64urlToBytes(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(`VAPID public key must be a 65-byte uncompressed P-256 point, got ${pub.length} bytes`);
  }
  return crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", ext: true,
    d: privateKeyB64,
    x: bytesToB64url(pub.subarray(1, 33)),
    y: bytesToB64url(pub.subarray(33, 65)),
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function vapidJwt(endpoint, publicKeyB64, privateKeyB64, subject) {
  const enc = (o) => bytesToB64url(te.encode(JSON.stringify(o)));
  // `aud` is the push service's origin, never the endpoint path — Apple
  // rejects the token outright if the whole URL is used.
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,   // spec caps this at 24h
    sub: subject,
  };
  const signingInput = `${enc({ typ: "JWT", alg: "ES256" })}.${enc(payload)}`;
  const key = await importVapidKey(publicKeyB64, privateKeyB64);
  // WebCrypto ECDSA emits raw r||s, which is what JWS ES256 wants — no DER
  // unwrapping needed here (unlike Node's crypto.sign).
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(signingInput));
  return `${signingInput}.${bytesToB64url(sig)}`;
}

/* ------------------------------------------------------------ encryption */

// WebCrypto's HKDF does Extract-then-Expand in one call, which is exactly the
// `HKDF(salt, ikm, info, len)` the RFC uses throughout.
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// Header is salt(16) || record size(4) || key id length(1) || key id(65), so a
// single-record message can carry this much plaintext inside 4096 bytes:
// 4096 - 86 header - 1 delimiter - 16 GCM tag.
export const MAX_PAYLOAD = 4096 - 86 - 17;

/**
 * RFC 8291 §3.4. Returns the complete aes128gcm body.
 * `salt` and `asKeyPair` are injectable so tests can pin them; production
 * always generates fresh ones, and reusing either would be a real break.
 */
export async function encryptPayload(plaintext, p256dhB64, authB64, opts = {}) {
  const uaPublic = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  if (uaPublic.length !== 65) throw new Error(`subscription p256dh must be 65 bytes, got ${uaPublic.length}`);
  if (authSecret.length !== 16) throw new Error(`subscription auth must be 16 bytes, got ${authSecret.length}`);

  const as = opts.asKeyPair || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  // The order of the two public keys in key_info is load-bearing: user agent
  // first, then application server. Swapping them still "works" on both sides
  // of a round-trip test and fails against every real browser.
  const keyInfo = concat(te.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, concat(te.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(te.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const body = typeof plaintext === "string" ? te.encode(plaintext) : plaintext;
  if (body.length > MAX_PAYLOAD) throw new Error(`payload ${body.length} exceeds ${MAX_PAYLOAD} bytes`);
  // 0x02 is the last-record delimiter; 0x01 would mean "more records follow".
  const padded = concat(body, new Uint8Array([2]));

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/* ------------------------------------------------------------------ send */

/**
 * Push one message to one subscription.
 *
 * `gone` is the field that matters operationally: a 404 or 410 means the
 * browser threw the subscription away (app deleted, permission revoked, push
 * service rotated it). Those must be pruned, or a dead device sits in the list
 * absorbing every send and the failure count never returns to zero.
 */
export async function sendPush(sub, payload, env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return { ok: false, status: 0, gone: false, error: "VAPID keys not configured" };
  }
  try {
    const jwt = await vapidJwt(sub.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY,
      env.VAPID_SUBJECT || "mailto:benjaminsleary@gmail.com");
    const body = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
    const r = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",          // hold for a day if the phone is off
        Urgency: "normal",
      },
      body,
    });
    if (r.ok) return { ok: true, status: r.status, gone: false };
    return {
      ok: false, status: r.status,
      gone: r.status === 404 || r.status === 410,
      error: (await r.text().catch(() => "")).slice(0, 200),
    };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: String((e && e.message) || e) };
  }
}

/**
 * Fan out to every registered device, and report per-device.
 *
 * Push is now the ONLY delivery channel — there is no ntfy fallback — so the
 * caller has to be able to tell "sent to two phones" from "sent to nothing".
 * A send that reached zero devices is a failed delivery, including the case
 * where no device has ever subscribed, and run-skill.sh records it as such.
 */
export async function sendToAll(subs, payload, env) {
  const results = await Promise.all((subs || []).map(async (s) => ({ sub: s, ...(await sendPush(s, payload, env)) })));
  return {
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.gone).map((r) => ({ endpoint: r.sub.endpoint, status: r.status, error: r.error })),
    gone: results.filter((r) => r.gone).map((r) => r.sub.endpoint),
    total: results.length,
  };
}
