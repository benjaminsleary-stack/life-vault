# Dashboard — cloud (laptop-free)

The always-on version of the dashboard. Unlike `scripts/dashboard-server.py` (a
LAN server that needs the desktop awake), this runs entirely off GitHub, so it
works from your phone whether or not the laptop is on.

## How it fits together

```
Phone PWA ──▶ Cloudflare Worker  ──▶  GitHub (life-vault repo)  ◀── bridge.sh (laptop, when on)
 (Pages)      holds the GH token       always on                 ◀── skill-runner Action (cloud)
              + unlock gate            = one source of truth
```

- **`dashboard/`** — the PWA (static). Hosted on Cloudflare Pages.
- **`worker/`** — the Cloudflare Worker. The only holder of the GitHub token; the
  browser never sees it. Reads the vault via the GitHub API, turns writes into commits.
- **`.github/workflows/skill-runner.yml`** — runs a skill in the cloud when the
  dashboard queues one (a `.run` file), then writes back its status.

The desktop bridge and the cloud routines already sync through the same repo, so
the dashboard is just another writer. Rare collisions are parked on a
`conflict/*` branch by `bridge.sh`, exactly as today.

## Security model (read this)

The Pages URL is public. Two things keep the vault safe:

1. **The unlock token.** Every request must carry it; the Worker refuses anything
   without it. You enter it once on the phone; it is stored on-device only.
2. **The GitHub token lives only in the Worker**, as an encrypted secret. It is a
   *fine-grained* PAT scoped to the single `life-vault` repo — it can touch nothing
   else in your account.

Claude never sees either token — you create them and paste them into
Cloudflare/GitHub yourself in the steps below.

---

## Setup (one-time)

### 1. Fine-grained GitHub token (for the Worker)
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new.
- **Repository access:** Only select repositories → `life-vault`.
- **Permissions:** Repository → **Contents: Read and write**. Nothing else.
- Copy the token (starts `github_pat_…`). You'll paste it in step 3.

### 2. Choose an unlock token
Any long random string (e.g. `openssl rand -hex 24`). This is what you type into
the phone to connect. Keep it somewhere safe.

### 3. Deploy the Worker
```
cd worker
# edit wrangler.toml: set GH_OWNER and GH_REPO to your values
npx wrangler login
npx wrangler secret put GH_TOKEN        # paste the fine-grained PAT from step 1
npx wrangler secret put UNLOCK_TOKEN    # paste your unlock token from step 2
npx wrangler deploy
```
Wrangler prints the Worker URL, e.g. `https://life-vault.<you>.workers.dev`.
(Optional: set `ALLOW_ORIGIN` in `wrangler.toml` to your Pages URL once you have
it in step 4, then redeploy, to lock CORS to just the dashboard.)

### 4. Deploy the PWA to Cloudflare Pages
The PWA is static files — don't use the "import a repository / Workers Builds"
wizard (that's for building a Worker and will clash with the Worker's name). Just
direct-upload the folder:
```
cd dashboard
npx wrangler pages deploy . --project-name life-vault-app
```
This creates a **Pages** project `life-vault-app` (a different name from the
Worker, so no collision) and prints a URL like `https://life-vault-app.pages.dev`.
Re-run the same command any time you change the dashboard.

On your phone, open that URL, enter the **Worker URL**
(`https://life-vault.<subdomain>.workers.dev`) and your **unlock token** once,
then **Add to Home Screen** for the app icon.

> Prefer auto-deploy on every push? You can connect the repo in the Pages UI
> later with build output dir `dashboard` and no build command — but direct
> upload is the quickest way to get it live now.

### 5. Skill runner secret (for tap-to-run skills)
Get a long-lived Claude Code token on the desktop:
```
claude setup-token
```
Then GitHub → the repo → Settings → Secrets and variables → **Actions** → New:
- `CLAUDE_CODE_OAUTH_TOKEN` = the token from `claude setup-token`.
- *(optional)* `NTFY_TOPIC` = your ntfy topic, to get pinged if a run fails.

Now the **Run** buttons work end to end: the button commits a `.run` file, the
Action executes the skill and writes its status, and the dashboard shows it.

---

### 6. Push notifications (optional — brief ready / ask answered / skill failed)
Generate a VAPID key pair once (any machine with Node):
```
npx web-push generate-vapid-keys
```
Add them to the Worker:
```
cd worker
npx wrangler secret put VAPID_PUBLIC_KEY    # the Public Key line
npx wrangler secret put VAPID_PRIVATE_KEY   # the Private Key line
npx wrangler secret put VAPID_SUBJECT       # e.g. mailto:you@example.com
npx wrangler deploy
```
And two GitHub Actions secrets so runs can trigger the push:
- `WORKER_URL` = `https://life-vault.<subdomain>.workers.dev`
- `UNLOCK_TOKEN` = the same unlock token the dashboard uses

Then on each device: open the dashboard → tap **🔔 Alerts** → allow.
Subscriptions are stored in `_meta/push-subs.json` in the vault (private repo);
dead subscriptions are pruned automatically.

## Everyday use
Nothing to start. Open the installed app; it reads the current vault and every
change is a commit. Skills run in the cloud on tap or on their schedule.

## Limits & notes
- **On-demand runs** go through GitHub Actions (generous free minutes), separate
  from the Pro routine cap. Scheduled routines are unchanged.
- **Fonts:** the PWA uses system fallbacks (Georgia + system-ui). To ship the real
  Newsreader + Hanken Grotesk faces, drop the `.woff2` files into `dashboard/` and
  add `@font-face` rules — optional polish.
- **The LAN server still works** for when you're at the desk; both read/write the
  same files. This just removes the "laptop must be on" requirement.
