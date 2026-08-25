# Cloud routines — cost-optimised split layout

The same routines as [cloud-routines.md](cloud-routines.md), partitioned so **no
skill runs on a model bigger than it needs**. The faithful layout runs
`file-inbox` — a mechanical transform that belongs on Haiku — inside the Sonnet
brief sessions. Here it is its own Haiku routine, and the briefs run pure
judgement on Sonnet.

Everything else is identical to the faithful file and is **not repeated here**:
the [prerequisite](cloud-routines.md#before-you-start--the-one-hard-prerequisite)
(new account clones the repo), the [secrets table](cloud-routines.md#secrets-by-routine),
the [house rules](cloud-routines.md#house-rules--true-for-every-routine-stated-once-dont-repeat-in-prompts),
and the cron gotchas (Cloudflare Sunday `7` vs standard `0`; UTC-set-for-BST DST
drift). Read that file first; this one only spells out what changes.

## What changes, and why

| | Faithful | Split |
|---|---|---|
| `file-inbox` | runs inside the Sonnet briefs | **own Haiku routine**, before each brief |
| morning routine | file-inbox → email-digest → morning-brief (all Sonnet) | email-digest → morning-brief (Sonnet); no file-inbox |
| evening routine | file-inbox → evening-brief (all Sonnet) | evening-brief only (Sonnet); its file-inbox step **skipped** |

Everything mechanical is on Haiku; everything that involves judgement, web
synthesis or relationship recall stays on Sonnet. That per-skill model split is
the single biggest lever on weekly spend — it is exactly what `run-skill.sh` does
today, reproduced as separate cloud routines.

**The one dependency this introduces:** `file-inbox` must land **before** the
brief, so the brief sees filed captures and a swept task list. Give it a lead of
~15 minutes and let it push before the brief routine starts. (The briefs' own
`brief-context.mjs` reads raw `inbox/` state directly, so an unfiled capture still
*surfaces* — but people-notes and the completed-task sweep only happen once
file-inbox has run.)

## Schedule at a glance

| Routine | When (Europe/London) | Cron (UTC) | Model | Delivers |
|---|---|---|---|---|
| file-inbox (pre-morning) | daily 05:30 | `30 4 * * *` | **Haiku** | no |
| morning-brief | daily 05:45 | `45 4 * * *` | **Sonnet** | yes |
| file-inbox (midday) | daily 11:30 | `30 11 * * *` | **Haiku** | no |
| file-inbox (pre-evening) | daily 20:30 | `30 19 * * *` | **Haiku** | no |
| evening-brief | daily 20:45 | `45 19 * * *` | **Sonnet** | yes |
| interest-scout | Sat 09:00 | `0 8 * * 6` | **Sonnet** | yes |
| harvest | Sun 10:00 | `0 9 * * 0` | **Sonnet** | no |
| family-events | 1st 11:00 | `0 10 1 * *` | **Sonnet** | yes |
| refresh-summaries | Sun 03:00 (optional) | `0 2 * * 0` | **Haiku** | no |

The midday `file-inbox` is optional — it just keeps captures from sitting unfiled
between the evening and next morning runs. Drop it if two a day is enough.

`interest-scout`, `harvest`, `family-events` and `refresh-summaries` are **unchanged**
from the faithful file — copy their prompts from there. Only the three below differ.

---

## file-inbox — Haiku, no delivery (runs 2–3× daily)

One routine, scheduled at each slot above. Same prompt every time.

```
Run the file-inbox skill exactly per _meta/skills/file-inbox.md: route every raw
capture in inbox/ into the right note, archiving each raw file first, losing
nothing. Sweep completed tasks whose ✅ date is >3 days old into
notes/completed-tasks.md. Cross off any _meta/gaps.md question a capture answered.
Refresh _meta/index.md and _meta/hot-cache.md. Commit and push.

If inbox/ is empty, say so and stop — do not commit. Report one line per capture.
```

## morning-brief — Sonnet, delivers (file-inbox already ran)

```
Morning brief. file-inbox has already run as its own routine, so DO NOT run it
here. Run, in order, each per its file in _meta/skills/:

1. email-digest    — build the "needs Ben" mail list; hand it to the brief.
2. morning-brief   — writes digests/<today>-morning.md, runs charlotte-surfacer,
                     commits, pushes, delivers via notify.sh.

The brief's preflight (node scripts/brief-context.mjs morning) is the whole
mechanical half — calendar with per-feed health, tasks due/overdue with the nag
arithmetic done, inbox state, the Charlotte shortlist. Do NOT re-read the files it
gives you. Budget 10 turns; at most 3 news searches; never fetch a full article.

Assert digests/<today>-morning.md exists, is >200 bytes, carries today's date and
all five ## headings. Notify failure otherwise.
```

## evening-brief — Sonnet, delivers (file-inbox already ran)

```
Evening brief — a soft close, no task nagging. file-inbox has already run as its
own routine, so SKIP step 1 of the evening-brief skill (the "run file-inbox
first" step); go straight to the preflight and compose.

Run evening-brief per _meta/skills/evening-brief.md from the preflight onward:
node scripts/brief-context.mjs evening holds tomorrow's calendar, inbox state, the
Charlotte shortlist and the day-log counts already computed — don't re-read those
files. Write digests/<today>-evening.md, score the day into _meta/day-log.jsonl,
ask the one gap question, commit, push, deliver. Budget 8 turns.

Assert digests/<today>-evening.md exists and is non-trivial; notify failure
otherwise.
```

---

## Is the split worth it?

Yes, whenever there are captures to file. `file-inbox` on Haiku costs a fraction of
the same work inside a Sonnet brief, and its cold start is only the ~5KB skill file
(CLAUDE.md auto-loads in any routine regardless). On an empty inbox it exits in one
cheap turn. The trade you accept is more routines to manage and the 15-minute
ordering dependency above — worth it for daily work, which is where the spend is.

If you'd rather keep it simple, the faithful layout in
[cloud-routines.md](cloud-routines.md) is correct and complete; it just pays Sonnet
for the filing.
