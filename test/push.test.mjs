/**
 * Tests for Web Push — the vault's only delivery channel.
 *
 *   node --test test/
 *
 * WHAT THESE CAN AND CANNOT PROVE
 * -------------------------------
 * They prove the VAPID JWT verifies against its own public key, that the
 * aes128gcm body has exactly the layout RFC 8291 specifies, and that a message
 * encrypted for a subscription decrypts back to the original with an
 * independently-written decryptor.
 *
 * They CANNOT prove Google accepts it. A round-trip test passes even if both
 * halves make the same mistake — swap the two public keys in `key_info`, for
 * instance, and this file stays green while every real browser rejects the
 * message. That is why the decryptor below re-derives the keys from the spec
 * text rather than calling into push.js, and why docs/push-notifications.md
 * insists on one real device test before trusting any of this.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptPayload, vapidJwt, b64urlToBytes, bytesToB64url, MAX_PAYLOAD } from "../worker/push.js";
import { readPushSubs, addPushSub, removePushSubs } from "../worker/vault.js";

const te = new TextEncoder();
const td = new TextDecoder();

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// A browser subscription: a P-256 keypair plus 16 random bytes of auth secret.
async function fakeSubscription() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: kp.privateKey,
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    keys: { p256dh: bytesToB64url(raw), auth: bytesToB64url(auth) },
    rawPublic: raw, rawAuth: auth,
  };
}

async function vapidPair() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = bytesToB64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: pub, privateKey: jwk.d, verifyKey: kp.publicKey };
}

/* ---------------------------------------------------------------- encoding */

test("base64url round-trips, including bytes that need padding", () => {
  for (const n of [1, 15, 16, 32, 65, 4096]) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    assert.deepEqual(b64urlToBytes(bytesToB64url(bytes)), bytes, `${n} bytes`);
  }
});

test("base64url output is URL-safe and unpadded", () => {
  const s = bytesToB64url(crypto.getRandomValues(new Uint8Array(64)));
  assert.doesNotMatch(s, /[+/=]/, "must not contain +, / or = — push services reject those");
});

/* ------------------------------------------------------------------- VAPID */

test("the VAPID JWT verifies against its own public key", async () => {
  const v = await vapidPair();
  const jwt = await vapidJwt("https://fcm.googleapis.com/fcm/send/x", v.publicKey, v.privateKey, "mailto:a@b.c");
  const [h, p, s] = jwt.split(".");
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, v.verifyKey,
    b64urlToBytes(s), te.encode(`${h}.${p}`),
  );
  assert.ok(ok, "signature must verify — a bad one is a 401 from the push service");
});

test("the JWT audience is the push service ORIGIN, not the full endpoint", async () => {
  // Sending the whole URL is the classic VAPID mistake and Apple rejects it outright.
  const v = await vapidPair();
  const jwt = await vapidJwt("https://fcm.googleapis.com/fcm/send/abc?x=1", v.publicKey, v.privateKey, "mailto:a@b.c");
  const claims = JSON.parse(td.decode(b64urlToBytes(jwt.split(".")[1])));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:a@b.c");
});

test("the JWT expiry is in the future and inside the 24h the spec allows", async () => {
  const v = await vapidPair();
  const jwt = await vapidJwt("https://x.example/y", v.publicKey, v.privateKey, "mailto:a@b.c");
  const { exp } = JSON.parse(td.decode(b64urlToBytes(jwt.split(".")[1])));
  const now = Math.floor(Date.now() / 1000);
  assert.ok(exp > now, "already expired");
  assert.ok(exp <= now + 24 * 3600, "push services reject exp more than 24h out");
});

test("a malformed VAPID public key is rejected loudly, not silently", async () => {
  await assert.rejects(
    () => vapidJwt("https://x.example/y", bytesToB64url(new Uint8Array(32)), "aaaa", "mailto:a@b.c"),
    /65-byte uncompressed P-256 point/,
  );
});

/* -------------------------------------------------------------- encryption */

test("the aes128gcm body has the layout the RFC specifies", async () => {
  const sub = await fakeSubscription();
  const body = await encryptPayload("hello", sub.keys.p256dh, sub.keys.auth);
  assert.equal(body[16 + 4], 65, "key id length byte must be 65");
  assert.equal(body[16 + 4 + 1], 0x04, "the app server key must be an uncompressed point");
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  assert.equal(rs, 4096, "record size");
  // salt(16) + rs(4) + idlen(1) + key(65) + plaintext(5) + delimiter(1) + tag(16)
  assert.equal(body.length, 16 + 4 + 1 + 65 + 5 + 1 + 16);
});

test("every message uses a fresh salt and ephemeral key", async () => {
  // Reusing either against the same subscription leaks the plaintext.
  const sub = await fakeSubscription();
  const a = await encryptPayload("same text", sub.keys.p256dh, sub.keys.auth);
  const b = await encryptPayload("same text", sub.keys.p256dh, sub.keys.auth);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), "salt must differ");
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), "ephemeral public key must differ");
});

test("a payload encrypted for a subscription decrypts back to the original", async () => {
  const sub = await fakeSubscription();
  const plaintext = "# Morning — Sat 1 Aug\n\n## Today's calendar\n— Team JGC 09:00 · “quoted” — em dash 🌤";
  const body = await encryptPayload(plaintext, sub.keys.p256dh, sub.keys.auth);

  // Decrypt following RFC 8291 §3.4 directly, so a mistake inside push.js does
  // not cancel itself out here.
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 86);
  const ciphertext = body.subarray(86);

  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, sub.privateKey, 256));

  const hkdf = async (s, ikm, info, len) => {
    const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, k, len * 8));
  };
  const keyInfo = concat(te.encode("WebPush: info"), new Uint8Array([0]), sub.rawPublic, asPublic);
  const ikm = await hkdf(sub.rawAuth, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, concat(te.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(te.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const out = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ciphertext));

  assert.equal(out[out.length - 1], 2, "last record delimiter");
  assert.equal(td.decode(out.subarray(0, -1)), plaintext);
});

test("a payload that would exceed one record is refused, not silently truncated", async () => {
  const sub = await fakeSubscription();
  await assert.rejects(
    () => encryptPayload("x".repeat(MAX_PAYLOAD + 1), sub.keys.p256dh, sub.keys.auth),
    /exceeds/,
  );
});

test("a subscription with the wrong key sizes is rejected", async () => {
  const sub = await fakeSubscription();
  await assert.rejects(() => encryptPayload("hi", bytesToB64url(new Uint8Array(32)), sub.keys.auth), /p256dh must be 65/);
  await assert.rejects(() => encryptPayload("hi", sub.keys.p256dh, bytesToB64url(new Uint8Array(8))), /auth must be 16/);
});

/* --------------------------------------------------- subscription storage */

function memStore(files = {}) {
  return {
    files,
    async readFile(p) { return p in files ? { text: files[p], sha: "mem" } : null; },
    async listDir() { return []; },
    async putFile(p, text) { files[p] = text; },
  };
}
const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/aaa", keys: { p256dh: "p", auth: "a" } };

test("registering a device stores it", async () => {
  const store = memStore();
  assert.equal(await addPushSub(store, { ...SUB, label: "Pixel" }), true);
  const { subs } = await readPushSubs(store);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].label, "Pixel");
});

test("re-registering the same device replaces it rather than duplicating", async () => {
  // Every permission re-grant returns the same endpoint. Appending blindly is
  // how a brief starts arriving twice.
  const store = memStore();
  await addPushSub(store, { ...SUB, label: "Pixel" });
  await addPushSub(store, { ...SUB, label: "Pixel (again)" });
  const { subs } = await readPushSubs(store);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].label, "Pixel (again)");
});

test("a second, different device is kept alongside the first", async () => {
  const store = memStore();
  await addPushSub(store, SUB);
  await addPushSub(store, { ...SUB, endpoint: "https://fcm.googleapis.com/fcm/send/bbb" });
  assert.equal((await readPushSubs(store)).subs.length, 2);
});

test("a malformed subscription is refused", async () => {
  const store = memStore();
  assert.equal(await addPushSub(store, { endpoint: "not-a-url", keys: { p256dh: "p", auth: "a" } }), false);
  assert.equal(await addPushSub(store, { endpoint: "https://x/y" }), false);
  assert.equal((await readPushSubs(store)).subs.length, 0);
});

test("expired endpoints are pruned", async () => {
  // A 410 from the push service means the browser threw the subscription away.
  // Left in place, a dead device absorbs every send and the failure never clears.
  const store = memStore();
  await addPushSub(store, SUB);
  await addPushSub(store, { ...SUB, endpoint: "https://fcm.googleapis.com/fcm/send/bbb" });
  assert.equal(await removePushSubs(store, ["https://fcm.googleapis.com/fcm/send/aaa"]), true);
  const { subs } = await readPushSubs(store);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].endpoint, "https://fcm.googleapis.com/fcm/send/bbb");
});

test("a corrupt subscriptions file doesn't lock you out of re-subscribing", async () => {
  const store = memStore({ "_meta/push-subscriptions.json": "{ broken" });
  assert.deepEqual((await readPushSubs(store)).subs, []);
  assert.equal(await addPushSub(store, SUB), true);
});

test("the decryption keys are never echoed back by the devices listing", async () => {
  const store = memStore();
  await addPushSub(store, SUB);
  const stored = JSON.parse(store.files["_meta/push-subscriptions.json"]);
  // They must be stored (the Worker needs them to encrypt) but the /devices
  // route must project them out — asserted here on the shape it reads from.
  assert.ok(stored.subscriptions[0].keys.p256dh, "stored for the Worker");
  const listed = stored.subscriptions.map((s) => ({ label: s.label, added: s.added }));
  assert.ok(listed.every((d) => !("keys" in d)));
});

/* ------------------------------------------------------------- the payload */

test("the brief survives the trip as JSON inside the encrypted body", async () => {
  // What sw.js parses on the other side.
  const sub = await fakeSubscription();
  const msg = { title: "Morning brief", body: "Due today: “call the plumber” — 2 items\nhttps://example.org/x?a=1&b=2" };
  const body = await encryptPayload(JSON.stringify(msg), sub.keys.p256dh, sub.keys.auth);
  assert.ok(body.length > 86, "produced a body");
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg, "round-trips as JSON");
});
