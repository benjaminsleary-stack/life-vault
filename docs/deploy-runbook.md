# Deploy runbook — 2026-08-01 changes

Everything from the codebase review, the push rewrite and the Strava wiring is
merged to `main`. None of it is live until the steps below are done.

> **Read this first.** The merge **removed GitHub's cron**, because the schedule
> moved to Cloudflare. Right now nothing fires and nothing is delivered. Step 2
> is what turns the routines back on — until it is done, there is no morning
> brief at all. Do steps 1–5 in one sitting.

Steps 1–5 are required. 6 and 7 are optional integrations that can wait.

## 0. Pull first, and check you're in the right repo

Every script this runbook uses was committed today. A checkout that has not been
pulled will fail with `Cannot find module` and it will look like a broken
instruction rather than a stale working copy.

```powershell
cd <your life-vault checkout>
git remote -v          # must end in life-vault.git — NOT the old life-os repo
git pull origin main
```

The local folder may not be named after the repo. Confirm with `git remote -v`
rather than the folder name — an old `life-os` checkout will look plausible,
sit at the same kind of path, and be the wrong thing.

The commands below are written for **PowerShell on Windows**, which is where
this actually gets run. Where a command differs on bash it says so. Note that
PowerShell aliases `curl` to `Invoke-WebRequest` — always type `curl.exe`.

Run scripts **from the repo root**, not from inside `worker/`:

```powershell
node scripts\vapid-keygen.mjs        # correct
node ..\scripts\vapid-keygen.mjs    # only if you are already inside worker\
```

---

## 1. Give the Worker's GitHub token `actions: write`

**Why:** the Worker's new job is to wake up on a cron and tell GitHub to run a
workflow. That is a `POST .../actions/workflows/scheduled-skills.yml/dispatches`
call, and it needs **Actions: write**. The token currently only has Contents,
because until now the Worker only ever read and wrote vault files. Without this
the cron fires, the dispatch is refused with a 403, and nothing runs.

### 1a. Find the token

Go to **https://github.com/settings/personal-access-tokens** (Settings →
Developer settings → Personal access tokens → **Fine-grained tokens**).

You are looking for the one scoped to `benjaminsleary-stack/life-vault` — the
setup docs call it "a fine-grained PAT scoped to the single life-vault repo".
If several look plausible, check the **Last used** column; the Worker uses it on
every dashboard load, so it should show recent activity.

> **You cannot read the token back from Cloudflare** — secrets are write-only
> there. If you genuinely can't tell which one it is, don't guess: skip to
> **1d** and make a new one.

### 1b. Add the permission

Click the token → **Repository permissions**. Set:

| Permission | Setting | Why |
|---|---|---|
| **Actions** | **Read and write** | dispatch the scheduled-skills workflow |
| Contents | Read and write | read and write vault files (already set) |
| Metadata | Read-only | mandatory, selects itself |

Check **Repository access** still says *Only select repositories* with
`life-vault` listed. Then **Update token** at the bottom.

> **Editing permissions does not change the token value.** The same secret keeps
> working and gains the new permission — you do **not** need to touch Cloudflare.
> This is the easy path, which is why it is worth finding the right token.

### 1c. Check it before you rely on it

Prove the permission works, from the desktop, before deploying anything:

**PowerShell — use `curl.exe`, not `curl`.** In PowerShell `curl` is an alias
for `Invoke-WebRequest`, which takes entirely different flags and will fail
confusingly:

```powershell
curl.exe -i -X POST `
  -H "Authorization: Bearer <the token>" `
  -H "Accept: application/vnd.github+json" `
  https://api.github.com/repos/benjaminsleary-stack/life-vault/actions/workflows/scheduled-skills.yml/dispatches `
  -d '{\"ref\":\"main\",\"inputs\":{\"skill\":\"morning-brief\"}}'
```

bash / WSL:

```bash
curl -i -X POST \
  -H "Authorization: Bearer <the token>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/benjaminsleary-stack/life-vault/actions/workflows/scheduled-skills.yml/dispatches \
  -d '{"ref":"main","inputs":{"skill":"morning-brief"}}'
```

- **`204 No Content`** — correct. It has also just started a real morning-brief
  run, which is a useful side effect: watch it in the Actions tab.
- **`403`** — the Actions permission didn't save, or you used the wrong token.
- **`404`** — the token can't see the repo at all. Check Repository access.

### 1d. If you can't find or edit it, make a new one

**Generate new token** → fine-grained:

- **Resource owner:** `benjaminsleary-stack`
- **Repository access:** Only select repositories → `life-vault`
- **Repository permissions:** Actions **Read and write**, Contents **Read and
  write** (Metadata comes along automatically)
- **Expiration:** see below

Copy it — GitHub shows it once. Then in step 2, also run:

```bash
npx wrangler secret put GH_TOKEN     # paste the new token
```

before `npx wrangler deploy`.

### 1e. Expiry — the thing that will bite you in a year

Fine-grained tokens expire. When this one does, the cron will fire, the dispatch
will 403, and **every routine stops** — with no notification, because the Worker
is what sends notifications and the failure is upstream of that. The Worker does
push an alert on a failed dispatch, but only if it can reach your device.

So: whatever expiry you pick, **write the date down**. Either pick *No
expiration* and accept a long-lived credential, or set a date and put it in the
vault as a task now:

```
- [ ] Renew the GitHub PAT the Worker uses — everything stops when it expires 📅 <date> #admin
```

A classic token instead of fine-grained also works — it needs the `repo` scope —
but fine-grained is better here because it can be locked to this one repo.

## 2. Deploy the Worker

Generate the keypair **from the repo root**, then set the secrets from `worker/`:

```bash
node scripts/vapid-keygen.mjs           # run ONCE, ever. Keep the output.

cd worker
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

> **Never paste a key from anywhere but that command's output.** `wrangler
> secret put` accepts whatever you type — there is no validation, and a wrong
> key fails silently at send time rather than at upload. A private key that has
> appeared in a chat window, a terminal you screen-shared, or a support thread
> is compromised: anyone holding it can push notifications to your phone.
> Generate a fresh pair and set all three secrets again.

If you set a secret wrongly, just run the same `secret put` again — it
overwrites. Nothing needs deleting first.

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

### 3a. Rotating the unlock token (when you've forgotten it)

`wrangler secret put` is write-only and the app keeps its copy in the phone's
`localStorage`, so a forgotten token cannot be read back from anywhere. Set a
fresh one in all three places instead. Registered devices survive this — push
subscriptions live in `_meta/push-subscriptions.json` and are not keyed to the
token — so you do **not** have to re-enable notifications afterwards.

**1. Generate one and save it somewhere you'll find it** (a password manager,
not a note in this repo). In PowerShell:

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
```

Alphanumeric only — no spaces, quotes or URL-unsafe characters to go wrong.

**2. The Worker**, from the repo root:

```powershell
cd worker
npx wrangler secret put UNLOCK_TOKEN
```

Paste at the prompt, press Enter once. Then `cd ..`.

**3. The Actions secret**: Settings → Secrets and variables → Actions →
`UNLOCK_TOKEN` → **Update**. Paste the same value.

**4. The phone**: open the app. It will 401 and show the unlock gate — enter the
new token. If it doesn't prompt, System → Disconnect this device, then re-enter.

Then run `morning-brief` from Actions. The **Check delivery works** step reports
the verdict before the skill runs, so you'll know within seconds.

Both sides trim surrounding whitespace (`tokenOk()` in `worker/worker.js`,
`notify.sh`, and the workflow preflight), so a trailing newline picked up while
pasting is no longer fatal. It used to be: the length check ran first, and one
invisible character produced a 401 identical to an entirely wrong token.

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
