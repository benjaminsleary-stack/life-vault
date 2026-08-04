# Deploy runbook — 2026-08-01 changes

Everything from the codebase review, the push rewrite and the Strava wiring is
merged to `main`. None of it is live until the steps below are done.

> **Read this first.** The merge **removed GitHub's cron**, because the schedule
> moved to Cloudflare. Right now nothing fires and nothing is delivered. Step 2
> is what turns the routines back on — until it is done, there is no morning
> brief at all. Do steps 1–5 in one sitting.

Steps 1–5 are required. 6 and 7 are optional integrations that can wait.

---

## 1. Give the Worker's GitHub token `actions: write`

GitHub → **Settings → Developer settings → Personal access tokens →
Fine-grained tokens** → the token the Worker uses → **Repository permissions**:

| Permission | Was | Needs to be |
|---|---|---|
| Contents | Read and write | Read and write |
| **Actions** | *(none)* | **Read and write** |

Without this the Cloudflare cron cannot dispatch the workflow and the schedule
will not fire at all. If you regenerate the token rather than edit it, re-run
`npx wrangler secret put GH_TOKEN` in step 2.

## 2. Deploy the Worker

```bash
cd worker
node ../scripts/vapid-keygen.mjs        # run ONCE, ever. Keep the output.

npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT   # mailto:benjaminsleary@gmail.com

npx wrangler deploy
```

The deploy registers the cron triggers from `wrangler.toml`, which is what
restarts the schedule. Confirm in the Cloudflare dashboard: **Workers &
Pages → life-vault → Settings → Triggers** should list five crons.

> Generate the VAPID pair **once**. A push subscription is bound to the key it
> was created with, so regenerating invalidates every registered device and each
> one has to be re-enabled by hand.

## 3. Two GitHub Actions secrets

GitHub → the repo → **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `WORKER_URL` | `https://life-vault.<your-subdomain>.workers.dev` (no trailing slash) |
| `UNLOCK_TOKEN` | the same unlock token the app uses |

`notify.sh` POSTs the brief to the Worker, which signs, encrypts and delivers it.
Without these the brief is written and pushed to git but reaches nobody, and the
workflow log says so at the top.

You can **delete `NTFY_TOPIC`** at the same time — nothing reads it any more.

## 4. Deploy the app

```bash
cd dashboard
npx wrangler pages deploy . --project-name life-vault-app
```

This ships the notification reply handler, the share target, the Remember card's
open loops, and the weather location fix.

## 5. Turn on notifications, on the phone

1. Open the dashboard. **Force-close and reopen it first** — the service worker
   is cached and needs to pick up the new version (`lv-shell-v6`).
2. Status pill → **System** → **Notifications** → **Turn on notifications**.
3. Accept the browser prompt.
4. Tap **Send a test**. A notification titled *Test* should arrive in a second
   or two.
5. **Pull down its Reply box, type anything, and send it.** Check it appears in
   `inbox/`. That proves the whole delivery-and-capture loop end to end.

> This is the step that actually verifies the push crypto. It was written
> against the RFCs and unit-tested, but nothing in the build container could
> reach Google's push service, so **this tap is the first real proof**. If it
> fails, say so and I'll debug against the real error.

If the permission prompt never appears, you denied it at some point and Chrome
won't re-ask — re-allow notifications for the site in Chrome's site settings.

### While you're there

Tap the weather card's place name → **Use my current location**. It was pinned
to Cambridge by a cache that never expired; this clears it. Or pin
Île d'Oléron directly if the browser won't give a fix.

---

## 6. Google Calendar write *(optional)*

Lets `family-events` put the monthly shortlist straight into the family
calendar. Full walkthrough: **`docs/google-calendar.md`**.

The one step people skip and regret: on the OAuth consent screen, **Publish
app**. Left in *Testing*, the refresh token expires every 7 days and the routine
dies quietly each week.

## 7. Strava *(optional)*

Brings your Garmin runs into the vault. Full walkthrough: **`docs/strava.md`**.

The one step people skip and regret: when approving, **tick the private
activities box** (`activity:read_all`). Without it, private runs are silently
omitted — no error, they just never appear.

---

## Verifying it worked

**Immediately:** the app's System panel should show *On for this device*, and
the Routines card should stop saying *· not delivered* after the next run.

**Force a run now** rather than waiting for the morning: GitHub → **Actions →
scheduled-skills → Run workflow** → pick `morning-brief`. It should complete in
a few minutes and the brief should arrive on your phone.

**Tomorrow at 05:45 BST**, the brief should arrive on time rather than two and a
half hours late. That is the whole point of the Cloudflare move — GitHub's cron
was firing 2½–3¼ hours late every day, measured across five consecutive days.

**Sunday 10:00**, `harvest` runs for the first time and turns last week's
calendar — and, if step 7 is done, your runs — into dated fragments.

## If something is wrong

| Symptom | Cause |
|---|---|
| No brief at all, ever | Worker not deployed, or cron triggers missing (step 2) |
| Workflow runs but nothing arrives | `WORKER_URL`/`UNLOCK_TOKEN` missing (step 3), or no device registered (step 5) |
| "no devices are registered" on the Routines card | Step 5 not done, or the subscription expired — re-enable it |
| Schedule still late | The workflow's own `schedule:` block is gone; check Cloudflare triggers, not GitHub |
| Weather still says Cambridge | App not redeployed (step 4), or force-close and reopen so the new service worker loads |
| `family-events` says calendar-adding isn't set up | Step 6 not done — expected, not a failure |
| `harvest` mentions Strava once and moves on | Step 7 not done — expected, not a failure |

Everything else — a routine that stops running, a brief that goes undelivered —
now surfaces in the System panel rather than being silent. That was the point of
half the work.
