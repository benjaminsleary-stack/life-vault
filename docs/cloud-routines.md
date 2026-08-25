# Cloud routines — migration pack

Every scheduled routine for the vault, in one file, ready to recreate as cloud
agents on another Claude account. Each entry gives its **schedule**, the
**model** to run it on, whether it **delivers** to the phone, the **secrets** its
environment needs, and the **prompt** to paste.

This is the **faithful layout**: one routine per cron slot, mirroring the
`routines/*.md` wrappers — the simplest thing to stand up. Its one inefficiency is
that the morning and evening routines run `file-inbox` (a cheap mechanical
transform) inside a Sonnet session. If you'd rather pay Haiku for the mechanical
work, use the **cost-optimised split layout** in
[cloud-routines-split.md](cloud-routines-split.md) instead — same routines,
partitioned so nothing runs on a model bigger than it needs.

## Before you start — the one hard prerequisite

The routines are **not** self-contained: they read and write this vault (`people/`,
`tasks.md`, `digests/`, `_meta/`) and shell out to `scripts/*.mjs`. So the new
account's cloud agent **must clone this same repo** and run inside it, exactly as
the runner does today. This file is the schedule and the prompts; the behaviour
still lives in `_meta/skills/*.md` in the repo. Don't paste the skill bodies into
the prompts — that just re-sends them as tokens on every run.

**Auth:** the cloud agent needs repo write access (a PAT or the platform's git
integration) and Claude auth (`CLAUDE_CODE_OAUTH_TOKEN`).

## Schedule at a glance

| Routine | When (Europe/London) | Cron (UTC) | Model | Delivers |
|---|---|---|---|---|
| morning | daily 05:45 | `45 4 * * *` | **Sonnet** | yes |
| evening | daily 20:45 | `45 19 * * *` | **Sonnet** | yes |
| interest-scout | Sat 09:00 | `0 8 * * 6` | **Sonnet** | yes |
| harvest | Sun 10:00 | `0 9 * * 0` | **Sonnet** | no |
| family-events | 1st of month 11:00 | `0 10 1 * *` | **Sonnet** | yes |
| refresh-summaries | Sun 03:00 (optional) | `0 2 * * 0` | **Haiku** | no |

Two cron gotchas when you re-enter these:

- **Day-of-week convention.** The live schedule lives in Cloudflare, which numbers
  DOW 1–7 (so Sunday is `7`, and harvest is `0 9 * * 7` there). Standard cron —
  which most schedulers, including claude.ai, use — numbers 0–6 with Sunday `0`.
  The table above is standard cron. Saturday is `6` either way; only Sunday moves.
- **DST.** These UTC times are set for British Summer Time. In winter (GMT) every
  one fires an hour early. If the new platform lets you set a timezone, set
  **Europe/London** and use the wall-clock time instead — that deletes the drift
  the current UTC crons live with.

## Secrets, by routine

Set these in the cloud agent's environment (the repo's `.env` is git-ignored and
won't travel). The Cloudflare Worker keeps its own secrets (GitHub token, VAPID
keys, `CAL_*`) — those don't move; the routine account only needs what it reads
directly plus the two delivery secrets.

| Secret | Needed by |
|---|---|
| `WORKER_URL`, `UNLOCK_TOKEN` | every routine that delivers (morning, evening, interest-scout, family-events) — `notify.sh` posts to the Worker's push endpoint |
| `CAL_WORK`, `CAL_PERSONAL`, `CAL_FAMILY` | morning, evening, harvest, family-events (calendar reads) |
| `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD` | morning (email-digest) |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN` | harvest |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID` | family-events (writes to Google Calendar) |
| `HEALTHCHECK_URL` | optional, any routine — dead-man's-switch ping |

## House rules — true for every routine (stated once, don't repeat in prompts)

The prompts below assume all of this, so none of them restate it:

- **`CLAUDE.md` is auto-loaded** as project instructions. Do **not** open or read
  it — that buys a second ~11KB copy that is then re-sent as cache every turn.
- **Push straight to the default branch.** No PRs, no feature branches.
- **Secrets are environment variables. Never print them**, and never echo a feed
  URL or token.
- **Deliver via `bash scripts/notify.sh "<title>" <file>`** (Web Push through the
  Worker). Delivery is verified for you — `notify.sh` writes a receipt — so never
  report a brief as delivered just because you called the script.
- **Green ≠ done.** End every routine by asserting its output actually exists and
  is non-trivial; on any failure run
  `bash scripts/notify.sh "⚠️ <routine> FAILED" -` with a one-line reason.
- **Ping the healthcheck** last, if set: `curl -fsS "$HEALTHCHECK_URL" || true`.

---

## morning — daily 05:45, Sonnet, delivers

```
Morning routine. Run these in order, each exactly per its file in _meta/skills/:

1. file-inbox      — file everything in inbox/, archiving raws first.
2. email-digest    — build the "needs Ben" mail list; hand it to the brief.
3. morning-brief   — writes digests/<today>-morning.md, runs charlotte-surfacer,
                     commits, pushes, and delivers via notify.sh.

The brief's own preflight (node scripts/brief-context.mjs morning) is the whole
mechanical half — today's calendar with per-feed health, tasks due/overdue with
the nag arithmetic done, inbox state, the Charlotte shortlist. Do NOT re-read the
files it already gives you. Budget 10 turns for the brief; at most 3 news
searches and never fetch a full article.

Assert digests/<today>-morning.md exists, is >200 bytes, carries today's date and
all five ## headings. Notify failure otherwise.
```

## evening — daily 20:45, Sonnet, delivers

```
Evening routine — a soft close, no task nagging. Run in order:

1. file-inbox      — clear anything captured during the day.
2. evening-brief   — writes digests/<today>-evening.md, scores the day into
                     _meta/day-log.jsonl, asks the one gap question, commits,
                     pushes, delivers.

The brief's preflight (node scripts/brief-context.mjs evening) holds tomorrow's
calendar, inbox state, the Charlotte shortlist and the day-log counts already
computed — don't re-read those files. Budget 8 turns for the brief.

Assert digests/<today>-evening.md exists and is non-trivial; notify failure
otherwise.
```

## interest-scout — Sat 09:00, Sonnet, delivers

```
Run the interest-scout skill per _meta/skills/interest-scout.md: search for
genuinely new music / film / TV and gigs near Cambridge matched to Ben's taste
(maps/interests.md + the notes it links), write digests/<year>-W<week>-interests.md,
commit, push, deliver.

Budget: at most 6 searches, never fetch a full page, read the four taste notes
once and don't return to them; stop searching past 20 turns. Everything must
trace to a real search result with a link — no invented releases. Nothing in a
category is an allowed answer; don't pad, and never write findings to tasks.md.

Assert the file exists and is non-trivial; notify failure otherwise.
```

## harvest — Sun 10:00, Sonnet, no delivery

```
Run the harvest skill per _meta/skills/harvest.md: turn the week that happened
into dated fragments. Read the week's calendar (node scripts/fetch-calendar.mjs 7
--back) and runs (node scripts/fetch-strava.mjs 14), discard the noise, and append
one dated fragment per real thing to the right people/ or projects/ note — same
conservatism as file-inbox, never inventing people from meeting titles. Append
only; never touch a ## What to know summary or tasks.md. Commit and push.

Handle the fetch exit codes as the skill says (Strava 3 = not configured, quiet;
1 = broken, loud). If a whole week returns zero events across all feeds, treat it
as a broken feed and say so loudly — don't write "quiet week".
```

## family-events — 1st of month 11:00, Sonnet, delivers

```
Run the family-events skill per _meta/skills/family-events.md: a monthly shortlist
of family-friendly days out within an hour of Cambridge for a 5- and a 2-year-old,
weighted to National Trust. Check what's already on (node scripts/fetch-calendar.mjs
45), search, filter hard to 4–6 real dated items with links and drive times, write
digests/<YYYY-MM>-family-events.md, add them to Google Calendar
(node scripts/calendar-add.mjs events.json — idempotent), emit the .ics backup,
and deliver.

Every fact traces to a real search result — no invented dates, prices or events.
Handle calendar-add exit codes (3 = not configured, quiet + a digest line; 1 =
broken, loud). Never write to tasks.md. Assert the digest exists with ≥1 dated
linked item, or says the month was genuinely empty.
```

## refresh-summaries — Sun 03:00, Haiku, no delivery (optional)

Not in the live Cloudflare cron today — the wrapper exists but was never wired.
Include it if you want the weekly summary rebuild; the 03:00 slot is deliberate,
it is the only routine that rewrites existing prose and wants a quiet moment.

```
Run refresh-summaries per _meta/skills/refresh-summaries.md, then weave per
_meta/skills/weave.md.

refresh-summaries: rebuild the ## What to know summary atop each people/*.md and
projects/*.md FROM ITS ## Log (fragments win over the old summary); update the
frontmatter updated: date; never touch any ## Log. weave: link unlinked real
mentions of known entities, refresh maps/*.md and _meta/index.md, report orphans
— obey the anti-tenuous-link rules, first mention per note only, never invent a
note to satisfy a link. Commit and push once at the end with a one-line count.

Assert you edited ≥1 file; notify failure otherwise.
```

---

# Token review — where the spend is, and the levers

This system is **already heavily optimised** — the cost lessons are baked into the
skill files, and the migration's main risk is *undoing* them. Carry these over
unchanged:

1. **The `brief-context.mjs` preflight is the biggest single win.** It computes the
   mechanical half of each brief (calendar + health, tasks + nag arithmetic, inbox,
   Charlotte shortlist) into one ~1.8KB call, replacing ~26KB discovered a dozen
   files at a time. The prompts tell the model not to re-read what it returns — keep
   that line; it's what took the briefs from $22/fortnight down.
2. **Turn budgets and search caps** (morning ≤10 turns / ≤3 searches, evening ≤8,
   scout ≤6 searches, *never fetch full articles*). Fetching whole pages is the
   single most expensive thing these skills can do.
3. **skip-if-fresh** — the live runner won't regenerate a brief already written and
   delivered (seven dispatches on 4 Aug produced one brief and $4.55 before this
   existed).

The levers that actually matter when you move accounts:

1. **Set the model on every routine. This is the number-one spend lever.** The plan
   default is the most capable, most expensive model; a routine created without an
   explicit model inherits it, so a Haiku-suitable transform (file-inbox, weave,
   refresh-summaries) silently runs on Opus. Use the models in the table — Haiku for
   transforms, Sonnet for judgement (briefs, harvest, scout, family-events), **never
   Opus**. Getting this wrong is a several-× cost difference on its own.
2. **Don't let `CLAUDE.md` load twice.** It's ~11KB, auto-loaded as project
   instructions and re-sent as cache every turn. Any prompt that says "read
   CLAUDE.md" buys a second copy — the old routine wrappers did exactly that. The
   prompts above drop it (see House rules).
3. **Break the mechanical transforms onto Haiku.** In this faithful layout the
   morning and evening routines run `file-inbox` inside a Sonnet session, billing a
   Haiku-suitable transform at Sonnet rates. The split layout in
   [cloud-routines-split.md](cloud-routines-split.md) fixes exactly this — `file-inbox`
   becomes its own Haiku routine and the briefs run pure judgement on Sonnet. The
   small cold-start cost is dwarfed by the model price gap.
4. **Decide what you lose by leaving `run-skill.sh`.** Today that script does the
   model selection, skip-if-fresh, a delivery backstop (delivers the file if the
   skill forgot), and per-run usage logging to `_meta/skill-usage.jsonl`. If a cloud
   routine runs the skill prompt directly, you keep delivery (the skills call
   `notify.sh` themselves) but lose the other three. Don't "fix" this by having the
   routine run `bash scripts/run-skill.sh <skill>` — that nests a second `claude -p`
   inside the cloud session and bills you twice. Instead set the model in the
   platform, rely on the platform's own de-dup for skip-if-fresh, and keep an eye on
   spend through the platform's usage view.

One thing to reconcile before you migrate — a drift I found between the two
representations of "the routines":

- The live Cloudflare cron dispatches **`morning-brief` only** (via `CRON_SKILL`),
  and that skill does **not** file the inbox or fetch email.
- `routines/morning.md` chains **file-inbox → email-digest → morning-brief**.

So depending on which you copy, the morning brief either includes mail and filed
captures or doesn't. The prompt above follows the wrapper (all three), which is the
richer behaviour — but confirm that's what you actually want running daily, because
email-digest reads full message bodies and PDF attachments on Sonnet, and that is a
real recurring cost. If you don't read the morning brief for its mail section, drop
email-digest from the morning routine and save it every day.
