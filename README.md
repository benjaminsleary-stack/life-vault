# Life-Vault

A personal "second brain" that is a **markdown vault + Claude**, not an app.
Phone ⇄ desktop by **Obsidian Sync**; the desktop mirrors the vault to this
**private GitHub repo**; a **Cloudflare Worker** is the clock and the API, and
**GitHub Actions** runs the scheduled skills against the mirror and delivers
briefings to your phone as **Web Push straight from your own PWA** (no
third-party app).

Built to `design/plan-life-vault-2026-07.md` **v2.0**. Read that spec for the why;
this README is the operator's build guide.

## Topology (what talks to what)

```
 PHONE                          DESKTOP (laptop, ~5/7 days)        CLOUD
 Obsidian mobile  ◀─Obsidian──▶ Obsidian desktop                  GitHub repo (mirror)
 (review, edit)      Sync       vault folder = git repo  ◀──push──▶      ▲
 HTTP Shortcuts ───── Contents API PUT ─────────────────────────────────┤
 (capture, laptop-independent)                                          │
 your PWA     ◀── Web Push (VAPID, encrypted) ─────── GitHub Actions (cloud clone/run)
                                                          ▲ dispatched by
                                                     Cloudflare Worker cron
```

**Accepted lag:** a *note edit* made on the phone while the laptop is off reaches
the routines only when the laptop next syncs+pushes. **Captures don't lag** (they
PUT straight to GitHub). **Briefings don't lag** (the push carries the content).

## What's in this repo (built for you)

- `CLAUDE.md` — vault conventions every agent obeys. `.claudeignore` / `.gitignore`.
- `_meta/skills/*.md` — the 13 skills (file-inbox, email-digest, morning-brief,
  evening-brief, interest-scout, refresh-summaries, charlotte-surfacer, harvest,
  family-events, digest-improvements, ask, weave, onboard). A standing
  instruction from Ben becomes one of these, never a task — see `CLAUDE.md`.
- `maps/*.md` — one MOC per life area; the ordering layer over the flat folders.
- `worker/` — the Cloudflare Worker: the clock, the API, and Web Push.
  `vault.js` is the one domain layer, shared with `dev/server.mjs`.
- `dashboard/` — the PWA. No build step; `dev/server.mjs` serves it locally
  against the real vault files.
- `routines/*.md` — saved prompts from the superseded Routines setup. Kept for
  reference; the live schedule is `worker/wrangler.toml`.
- `scripts/` — `run-skill.sh` (the one runner), `brief-context.mjs` (briefing
  preflight), `fetch-calendar.mjs`, `fetch-strava.mjs`, `fetch-mail.py`,
  `notify.sh`, `bridge.sh`, `setup.sh`, and `migrate-from-life-os.mjs`.
- `test/` — `node --test test/*.test.mjs`. Runs on every push.
- Folder skeleton: `inbox/ people/ projects/ notes/ daily/ digests/ _meta/`.

## Setup checklist (do in order — maps to spec §11 phases)

> Anything marked **[you]** is manual / off-device and can't be scripted from here.

### Phase 0 — onboard (fresh start; the old life-os database is scrapped)
- [x] **[you]** Run the guided interview on a low-cost model from the vault root:
      `claude --model haiku` → "run the onboarding interview in _meta/skills/onboard.md"
      (or Claude Desktop/Cowork with the model switched to Haiku, folder = this vault).
- [x] **[you]** Review the seeded notes; confirm `_meta/identity.md` is non-empty
      and every entity appears in its `maps/*.md`.
- [x] Run "weave the network" (`_meta/skills/weave.md`) on a capable model; check
      the Obsidian graph for orphans and tenuous links.

### Phase 1 — vault + sync + bridge
- [x] **[you]** Open this folder as an Obsidian vault; install plugins: **Tasks**,
      **Dataview**. (Optional dashboard later.)
- [x] **[you]** Turn on **Obsidian Sync**; confirm it does **not** sync `.git/`
      (spec §13.2). Install kepano's `obsidian-skills` into `.claude/`.
- [x] **[you]** Install the desktop **bridge** as an OS-scheduled job (launchd / Task
      Scheduler / cron) running `scripts/bridge.sh` every 10 min. NOT the
      obsidian-git plugin as the mechanism of record.
- [x] Accept: a phone edit reaches GitHub within one bridge cycle; `.git` untouched
      by Sync; no conflict in 3 days.

### Phase 2 — capture
- [ ] **[you]** Create a fine-grained **PAT**, *Contents read/write on this repo only*.
- [ ] **[you]** Android **HTTP Shortcuts**: a share-sheet + home-screen + voice
      shortcut doing the `PUT` in `scripts/capture-shortcut.md`. Record PAT expiry in
      the vault.
- [ ] Accept: 10 captures (voice + share) land in `inbox/`, zero failures, laptop-off.

### Phase 3 — filing (local first)
- [ ] Dry-run the filing skill on your laptop: `claude -p "$(cat _meta/skills/file-inbox.md)"`
      from the vault root, on a 30-capture batch. Accept: routed correctly, all raw
      files in `inbox/_archive/`, a `done:` capture ticked a task.

### Phase 4 — secrets and delivery
- [x] Worker secrets via `wrangler secret put`: `GH_TOKEN` (contents RW +
      **actions RW**, needed to dispatch the workflow), `UNLOCK_TOKEN`,
      `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- [x] Actions secrets on the repo: `CLAUDE_CODE_OAUTH_TOKEN`, `WORKER_URL`,
      `UNLOCK_TOKEN`, `CAL_WORK` / `CAL_PERSONAL` / `CAL_FAMILY`, Strava, Google.
- [ ] **[you]** `GMAIL_ADDRESS` / `GMAIL_APP_PASSWORD` — **still unset.** Every
      brief since setup has reported mail as unchecked. Needs 2FA on the account
      to mint an app password.
- [ ] **[you]** Record the `GH_TOKEN` expiry date as a dated task. When it passes,
      every routine stops and the only symptom is silence.

### Phase 5–8 — the routines — **SUPERSEDED**
The plan was Claude Code Routines at claude.ai/code/routines. That is not what
runs. The fallback below became the architecture, and has been the architecture
since 25 July 2026 — see **How it actually runs**.

### Decommission
- [x] Railway + Supabase shut down. The vault has no database and no third-party
      backend: `CLAUDE.md` — *"There is no app, no database, no API — the files
      are the system."*

## Verify-before-trusting (spec §13)
Don't take these from memory — test each at build time: Obsidian Sync pricing +
`.git` behaviour; Contents API create-vs-update SHA rules; PAT max lifetime;
Web Push payload limits; Gmail app-password availability (needs 2FA); the Gmail
`rfc822msgid` deep-link; kepano skills install path.

Two were verified the hard way and are worth keeping in mind: **Cloudflare's cron
day-of-week is 1–7, not 0–6** (a `0` for Sunday silently failed the whole schedule
update), and the **VAPID keys belong to the Worker, not to Actions** — they were
documented in the wrong place and delivery failed until they moved.

The Routines-era items are gone from this list: the Pro routine cap, the one-off
exemption, whether `ANTHROPIC_API_KEY` blocks `/schedule`, and the cloud
allowlist. None of them constrain a system that runs on Actions and Cloudflare.

## How it actually runs

This section used to be called "Fallback" and described GitHub Actions as the
thing to retreat to if Routines proved unreliable. They did, so it is not a
fallback any more — it is the system, and has been since 25 July 2026.

**The clock is Cloudflare, not GitHub.** `worker/wrangler.toml` holds the cron
lines and `CRON_SKILL` in `worker/worker.js` maps each tick to a skill; the
Worker dispatches `scheduled-skills.yml` via `workflow_dispatch`. GitHub's own
`schedule:` trigger was firing 2½–3¼ hours late every day — a 04:45 UTC cron
landing between 07:19 and 08:11 across five consecutive days — so a brief meant
for 06:30 arrived mid-morning. A dispatched run starts immediately.
**Change the times in `wrangler.toml`, not in the workflow.**

| Piece | Where | What it does |
|---|---|---|
| Clock | `worker/wrangler.toml` `[triggers]` + `CRON_SKILL` | fires each skill on time |
| Runner | `.github/workflows/scheduled-skills.yml` → `scripts/run-skill.sh` | runs it, records status + cost |
| API + push | `worker/worker.js`, `worker/vault.js`, `worker/push.js` | the app's backend, VAPID delivery |
| App | `dashboard/` (PWA, zero build) | read briefs, tasks, habits, capture, reply |
| Preflight | `scripts/brief-context.mjs` | the briefs' mechanical input, in one call |

Secrets live in two separate places and it matters: the **Worker's** secrets
(`GH_TOKEN`, `UNLOCK_TOKEN`, VAPID keys) are set with `wrangler secret put`, and
the **Actions** secrets (calendar feeds, `WORKER_URL`, Gmail) are set on the
repo. A calendar the dashboard can show is not necessarily one the brief can
read. See `docs/deploy-runbook.md` and `docs/skill-runner.md`.
