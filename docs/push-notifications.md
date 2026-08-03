# Notifications

Briefs are delivered by the vault's **own** Web Push — your PWA, your icon, no
third-party app. There is no ntfy any more.

```
run-skill.sh → notify.sh → POST $WORKER_URL/api/push/send
                              ↓  signs (VAPID) + encrypts (RFC 8291)
                           Google's push service (can't read it)
                              ↓
                           sw.js → showNotification()
```

The payload is encrypted end to end: Google relays the message but only your
browser holds the key. That is what makes it acceptable to send the evening
brief, which carries the `## Charlotte` section. The old ntfy topic was
protected only by being hard to guess, and sent everything in cleartext.

Android only, by choice — that is what the household runs.

## Setup, once

**1. Generate a VAPID keypair.** From the vault root:

```bash
node scripts/vapid-keygen.mjs
```

It prints `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and a `VAPID_SUBJECT`.

> Generate this **once** and keep it. A subscription is bound to the
> application-server key it was created with, so rotating the pair invalidates
> every registered device and each one has to be re-enabled by hand.

**2. Store them as Worker secrets:**

```bash
cd worker
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT      # mailto:you@example.com
npx wrangler deploy
```

The private key is a credential — anyone holding it can push to your phone.
Never commit it, never put it in `wrangler.toml`.

**3. Make sure the runner can reach the Worker.** `notify.sh` needs
`WORKER_URL` and `UNLOCK_TOKEN` as **GitHub Actions secrets**. `UNLOCK_TOKEN`
is the same value the app unlocks with; `WORKER_URL` is
`https://life-vault.<your-subdomain>.workers.dev`. Both are already listed in
the workflows' `env:` block — they just have to exist.

**4. Turn it on, on the phone.** Open the dashboard, tap the status pill →
**System** → **Notifications** → **Turn on notifications**, and accept the
browser prompt. Then tap **Send a test**. You should get a notification titled
*Test* within a second or two.

Adding the app to your home screen first is worth doing — it gets you the icon
and the standalone window — but on Android push works either way.

The permission prompt only appears in response to that tap. It is never
requested on page load, because a prompt you didn't ask for is the one you
reflexively deny, and a denial is sticky.

## Replying from the notification

Every notification carries a **Reply** box. Typing into it captures straight to
`inbox/` without opening the app — no unlock, no token, no window. The evening
brief's one question is answerable from the lock screen, which is the entire
reason it exists: the vault was getting nine captures a fortnight, and every one
of them cost opening the app first.

Mechanically: `sw.js` shows the notification with an action of `type: "text"`
(Chrome on Android; other browsers ignore the field and the notification still
works). The service worker cannot read `localStorage`, so the page hands it the
API base and unlock token via `postMessage` on every load and it keeps them in
the Cache API. Signing out clears them, or a "disconnected" device could still
write to the vault.

If a reply fails to send — no signal, usually — it is **re-notified with the text
still in it** and a "Send again" box, rather than being dropped. Golden rule 1
applies to a sentence typed at a lock screen as much as to anything else.

## Sharing into the vault

The manifest declares a `share_target`, so **Vault** appears in the Android share
sheet from any app. Share a link, a quote, a line of text, and it lands in the
capture box pre-filled. It is deliberately **not** sent automatically — a share
sheet fires by accident easily, and a capture you didn't mean is noise
`file-inbox` then has to route.

There are also two long-press shortcuts on the app icon: **Capture** (straight to
the box) and **Today's brief**.

## Checking it

The **System** panel tells you the truth about this device:

- *On for this device* — registered, with **Send a test** next to it.
- *Off for this device* — in red, saying that briefs go here and nowhere else,
  so nothing will reach you until it is on.
- *Blocked* — you denied the browser prompt at some point. The app cannot
  re-ask; you have to re-allow notifications for the site in Chrome's site
  settings.

The **Routines** card marks any run that was written but not delivered with
**· not delivered**, and `health()` counts that as a failed check with its own
line in the summary. A brief that reached nobody is not a successful run.

## When it stops working

**Nothing arrives, and the Routines card says "not delivered".** Check the
error on the row. `no devices are registered for notifications` means the
subscription is gone — re-enable it in the System panel. Anything else is the
push service's own rejection, passed through verbatim.

**One device stopped, the others are fine.** Android occasionally rotates a
subscription. `sw.js` listens for `pushsubscriptionchange` and asks the app to
re-register, but that only fires if the app gets opened. Failing that, the
Worker prunes any endpoint the push service reports as `404`/`410` on the next
send, so re-enabling in the System panel is the fix.

**Everything stopped at once.** Most likely the VAPID keys changed, or
`WORKER_URL`/`UNLOCK_TOKEN` is missing from Actions secrets. The scheduled
workflow prints a warning at the top of its log when those two are unset.

## No fallback, and what that means

Push is now the only channel. There is no second delivery route, so:

- **Registering at least one device is not optional.** With none registered,
  `/api/push/send` returns a failure and every brief records `delivered: false`.
- **If push breaks entirely, nothing pings you.** The backstops are the health
  chip in the app, and GitHub's own email when a workflow fails. Neither is a
  notification on your phone.

That is a deliberate trade for one app and encrypted delivery. If it ever bites,
the fix is a second registered device (an old phone, a desktop Chrome profile) —
`/api/push/send` fans out to all of them and reports how many it reached.

## Files

| Path | What it does |
|---|---|
| `worker/push.js` | VAPID JWT (RFC 8292) + aes128gcm encryption (RFC 8291) |
| `worker/worker.js` | `/api/push/{key,subscribe,unsubscribe,send,devices}` |
| `worker/vault.js` | subscription storage in `_meta/push-subscriptions.json` |
| `dashboard/sw.js` | `push`, `notificationclick`, `pushsubscriptionchange` |
| `dashboard/index.html` | the System-panel toggle and the test button |
| `scripts/notify.sh` | what every skill calls; unchanged interface |
| `scripts/vapid-keygen.mjs` | one-off key generation |

`test/push.test.mjs` covers the crypto: the JWT verifies, the body matches the
RFC's layout, and a message round-trips through an independently-written
decryptor. What those tests **cannot** prove is that Google accepts the output —
a round-trip passes even if both halves share a mistake. Step 4's real test on a
real phone is the only thing that proves delivery. Do it before you rely on this.
