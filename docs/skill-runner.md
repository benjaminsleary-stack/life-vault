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

Defined in `scheduled-skills.yml`. Times are **UTC** (GitHub cron has no DST) and
may fire up to ~15 min late, so each is set early with buffer:

| Skill | Cron (UTC) | ≈ London |
|---|---|---|
| morning-brief | `45 4 * * *` | 05:45 BST / 04:45 GMT — ready by 6:30 |
| evening-brief | `45 19 * * *` | 20:45 BST / 19:45 GMT |
| interest-scout | `0 8 * * 6` | Sat 09:00 BST |
| refresh-summaries | `0 2 * * 0` | Sun 03:00 BST |

Edit the `cron:` lines to change times. Uses the same `CLAUDE_CODE_OAUTH_TOKEN`
secret as the on-demand runner — nothing else to set up. Trigger one by hand from
**Actions → scheduled-skills → Run workflow** (pick the skill).

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
- `.status` files record `{skill, ok, when, outputs}`; `outputs` lists the `.md`
  files a run produced, which the dashboard turns into **Open** links.
- Triggers are archived to `inbox/_runs/_archive/`, never deleted.
- All three paths run the skill with `--dangerously-skip-permissions` (unattended,
  no approver) — every run can edit anything in the vault; git makes it revertable.
