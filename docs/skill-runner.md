# Skill runner — three ways skills execute

Skills can run three ways; all share one implementation (`scripts/run-skill.sh`)
and all write the same `inbox/_runs/<skill>.status` the dashboard reads.

| Path | When | Speed | File |
|---|---|---|---|
| **Local watcher** | On-demand, desktop on | Fast (seconds) | `scripts/skill-runner-local.py` |
| **Cloud on-demand** | On-demand, desktop off | Slow (~2 min setup) | `.github/workflows/skill-runner.yml` |
| **Cloud scheduled** | On a timer (morning, etc.) | Runs unattended | `.github/workflows/scheduled-skills.yml` |

The dashboard **Run** button always just drops a `inbox/_runs/<skill>-<ts>.run`
trigger. Whoever grabs it first runs it: the local watcher when it's up
(it claims the trigger and pushes, so the cloud stays idle), otherwise the cloud
Action. Scheduled runs are separate — they run the skill directly on a cron and
never touch the trigger queue, so they can't double-run with the watcher.

## Scheduled runs (laptop-off)

**The clock is in Cloudflare, not GitHub.** Times live in
`worker/wrangler.toml` (`[triggers] crons`) and the cron→skill map is
`CRON_SKILL` in `worker/worker.js`. The Worker dispatches
`scheduled-skills.yml`; the workflow itself has no `schedule:` trigger.

| Skill | Cron (UTC) | ≈ London |
|---|---|---|
| morning-brief | `45 4 * * *` | 05:45 BST / 04:45 GMT |
| evening-brief | `45 19 * * *` | 20:45 BST / 19:45 GMT |
| interest-scout | `0 8 * * 6` | Sat 09:00 BST |
| harvest | `0 9 * * 0` | Sun 10:00 BST |
| family-events | `0 10 1 * *` | 1st of the month, 11:00 BST |

To change a time, edit **both** `wrangler.toml` and `CRON_SKILL`, then
`cd worker && npx wrangler deploy`. Trigger one by hand from **Actions →
scheduled-skills → Run workflow** (pick the skill) — that path is unchanged.

### Why it moved off GitHub cron

GitHub's `schedule:` trigger was firing 2½–3¼ hours late, every day. Measured
from the commit timestamps of five consecutive runs of a `45 4 * * *` cron:

| Date | Scheduled | Committed | Late by |
|---|---|---|---|
| 26 Jul | 04:45 | 07:22 | ~2h 30m |
| 27 Jul | 04:45 | 08:11 | ~3h 20m |
| 30 Jul | 04:45 | 07:19 | ~2h 30m |
| 31 Jul | 04:45 | 07:37 | ~2h 50m |
| 01 Aug | 04:45 | 07:20 | ~2h 30m |

GitHub documents scheduled workflows as "may be delayed" and offers no
guarantee; a brief meant to be waiting at 06:30 was arriving mid-morning.
Cloudflare cron triggers fire within about a minute, and a `workflow_dispatch`
run starts immediately where a `schedule` run queues behind GitHub's shared
scheduler — so the Worker keeps time and GitHub only does the work.

**Setup this needs, once:** `GH_TOKEN` (the Worker's existing PAT) gains
`actions: write` alongside its contents RW. The Worker also needs the VAPID
secrets (`docs/push-notifications.md`), so a failed dispatch can still reach the
phone — it is the only part of the system still able to speak when the runner
never started.

## Delivery is checked, not assumed

`notify.sh` writes a receipt to `LV_DELIVERY_RECEIPT`; `run-skill.sh` folds it
into `<skill>.status` as `delivered` / `deliveryError`, and `health()` treats a
brief that was written but never sent as a **failed** check with its own line in
the summary.

This exists because it happened. From 20 July to 1 August 2026 every brief was
composed, committed and pushed correctly, and delivered to nobody — the delivery
secret was set but **empty**, which tripped the old `${VAR:?}` guard exactly like
an unset variable. The dashboard reported "all routines on schedule" throughout.
Green ≠ done (CLAUDE.md rule 5).

Delivery is now the vault's own Web Push (`docs/push-notifications.md`). If the
Routines card shows **· not delivered**, open the app's System panel: the usual
cause is that no device is registered, and push is the only channel there is.

## Local watcher (fast, desktop on)

One-time setup on the desktop:

```powershell
npm install -g @anthropic-ai/claude-code   # you have Node; installs the CLI
claude                                       # sign in once (or set CLAUDE_CODE_OAUTH_TOKEN)
```

Run it — either a single pass or a continuous watch:

```powershell
# from the vault root
python scripts/skill-runner-local.py            # one pass, then exit
python scripts/skill-runner-local.py --watch 15 # keep watching, poll every 15s
```

It needs `git`, `bash` (Git Bash provides it), and `claude` on PATH.

### Keep it running (Task Scheduler)
For "always on while the desktop is", run one pass every minute:
- Task Scheduler → Create Task → Trigger: **Daily**, repeat **every 1 minute**.
- Action: `pythonw.exe` with argument the full path to
  `scripts\skill-runner-local.py` (pythonw = no console window).
- Start in: the vault root.

Or run the `--watch` form once at logon and leave it. Either way, when the
desktop sleeps the cloud fallback takes over — nothing to switch.

## Notes
- `.status` files record `{skill, ok, when, outputs, delivered, deliveryError}`.
  `outputs` is measured from the commit the run started on, unioned with the
  dirty tree, minus bookkeeping paths — the briefs commit their own work, so a
  dirty-tree diff alone recorded nothing for them and four rows of housekeeping
  for `file-inbox`. `digests/` sorts first, so `outputs[0]` is the artefact and
  the dashboard hangs **Open** on it.
- Triggers are archived to `inbox/_runs/_archive/`, never deleted.
- All three paths run the skill with `--dangerously-skip-permissions` (unattended,
  no approver) — every run can edit anything in the vault; git makes it revertable.
