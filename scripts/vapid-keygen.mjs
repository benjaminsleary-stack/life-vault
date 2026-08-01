#!/usr/bin/env node
/**
 * Generate a VAPID keypair for Web Push. Run once, ever.
 *
 *   node scripts/vapid-keygen.mjs
 *
 * Prints three values. The public key is not secret — the browser has to send
 * it to the push service when subscribing. The private key is: anyone holding
 * it can push notifications to every device subscribed to this vault.
 *
 * Rotating the keypair invalidates every existing subscription, because a
 * subscription is bound to the application server key it was created with.
 * Every device then has to re-enable notifications. Generate once and keep it.
 *
 * Setup: docs/push-notifications.md.
 */

const b64url = (b) => {
  const bytes = new Uint8Array(b);
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

// Public: the uncompressed point 0x04||x||y, which is the form
// pushManager.subscribe() expects as applicationServerKey.
const pub = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
// Private: just the scalar d, out of the JWK.
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

console.log(`
Store these as Cloudflare Worker secrets:

  cd worker
  npx wrangler secret put VAPID_PUBLIC_KEY
  npx wrangler secret put VAPID_PRIVATE_KEY
  npx wrangler secret put VAPID_SUBJECT      # mailto:you@example.com

VAPID_PUBLIC_KEY=${pub}

VAPID_PRIVATE_KEY=${jwk.d}

VAPID_SUBJECT=mailto:benjaminsleary@gmail.com

The public key is served to the app at GET /api/push/key, so it is NOT
hardcoded in the dashboard and rotating it needs no Pages redeploy.

The private key is a credential. Never commit it; never put it in wrangler.toml.
`);
