# Codebase review — 2026-08-01

A read of the whole repo (worker, dashboard, runner scripts, workflows, skills)
plus the vault's own run history as evidence. Findings are ordered by how much
they cost you, not by how hard they are to fix.

---

## 1. Verdict

The architecture is sound and unusually disciplined for a personal system. Three
things in particular are right:

- **One domain layer.** `worker/vault.js` holds every rule about what a task,
  habit, list or person note *means*, and both the Cloudflare Worker and
  `dev/server.mjs` import it. That is the correct seam, and the comments explain
  why it exists (a Python reimplementation had drifted).
- **One runner.** `scripts/run-skill.sh` is shared by the local watcher and both
  workflows, so the three execution paths can't diverge.
- **Honesty checks.** `/api/health`, the `.status` files and the "assert your own
  output" step in each skill are a real implementation of golden rule 5.

The problems below are all at the edges: bookkeeping that leaks into the UI,
scheduling that was trusted without being measured, and a `people/` folder with
no data in it.

---

## 2. The routines card lists every touched file

**Root cause is in the runner, not the UI.** `scripts/run-skill.sh:20-25` defines
a run's "outputs" as *every dirty `.md` file in `git status`*:

```bash
dirty_md() {
  git status --porcelain --untracked-files=all | sed -E 's/^.{3}//' \
    | grep -E '\.md$' | grep -v -E '^inbox/_runs/' | sort -u
}
```

and `run-skill.sh:87` diffs that set before/after the run. Two consequences, both
visible in the live status files:

- **Skills that commit their own work report nothing.** `morning-brief`,
  `evening-brief` and `interest-scout` all `git commit && git push` as a step
  (see `_meta/skills/morning-brief.md` step 7), so by the time the runner
  measures, the tree is clean — every one of those `.status` files has
  `"outputs":[]`. `worker/vault.js:299-330` (`SKILL_OUTPUT`) exists purely to
  paper over this by guessing the file back from `digests/`.
- **Skills that don't commit report everything.** `file-inbox`'s last run
  recorded four paths — `_meta/hot-cache.md`, the raw capture, its archive copy,
  and `tasks.md` — of which exactly zero are things you'd want to open.

So the list is long *and* wrong: it shows housekeeping for the skills that do
housekeeping, and nothing for the skills that produce the artefact you care about.

**Fix (two small changes):**

1. In `run-skill.sh`, record outputs from a commit boundary rather than the dirty
   tree, and filter bookkeeping:
   ```bash
   start_sha="$(git rev-parse HEAD)"
   # …after the run…
   changed="$( { git diff --name-only "$start_sha" HEAD -- '*.md'; dirty_md; } | sort -u \
     | grep -vE '^(_meta/(hot-cache|skill-usage)|inbox/(_runs|_archive)/|tasks\.md)' )"
   ```
   Then sort so `digests/` leads. That alone makes `SKILL_OUTPUT`'s backfill
   redundant and cuts `file-inbox`'s four entries to zero-or-one.
2. In `dashboard/index.html:1033-1039`, stop rendering the tail. Show the primary
   output on the **Open** button (already there) and collapse the rest to
   `+3 more` behind a `<details>`, or drop them entirely — a run that touched six
   files is a fact for the git log, not for a phone screen.

**Related:** `run-skill.sh:87` uses `comm -13` against process substitutions, and
`sed -E 's/^.{3}//'` mangles rename entries (`R  old -> new`) into a single bogus
path. The commit-boundary approach above removes both problems.

---

## 3. The People section

The card isn't the problem — the data behind it is. Of 17 notes in `people/`,
**12 are 12-line stubs with a single log line** ("Marine's partner.", "Cat."),
and only `charlotte.md` (60 lines) carries anything a system could act on. The
card is therefore a directory of names with "nothing captured yet" beside most of
them, which is exactly the "poster" its own comment at
`dashboard/index.html:1338` says it must not be.

Two honest options:

- **Cut it and re-home the two useful signals.** Occasions inside 45 days belong
  in the agenda card next to calendar events (they're already computed —
  `worker/vault.js:192`); "quiet for N days" belongs in the health/system panel
  as a nudge, not a permanent list. Person notes stay reachable through the graph
  view and the file modal.
- **Or repurpose it as a capture surface.** Replace the list with 1–2 rows:
  the person with a near occasion, and the person whose note is oldest, each with
  a one-tap "note something" box wired to the existing `/api/append`. That turns
  a read-only directory into the thing that would actually fill the notes.

I'd do the first now and the second only if §5 below lands — a capture surface
with nothing prompting it will sit as unused as the card does.

---

## 4. Scheduled routines — the laptop is not the cause

Worth correcting the premise: **the cloud schedule is already running and has
been since 25 July**. `.github/workflows/scheduled-skills.yml` fires
`run-skill.sh` directly on a cron, with no laptop involved. Every morning and
evening brief since then was produced in GitHub Actions. Two other things are
going wrong instead.

### 4a. GitHub cron is firing hours late

Cron says `45 4 * * *` (04:45 UTC). Actual commit times, from the git log:

| Date | Scheduled | Committed | Late by |
|---|---|---|---|
| 26 Jul | 04:45 | 07:22 | ~2h 30m |
| 27 Jul | 04:45 | 08:11 | ~3h 20m |
| 30 Jul | 04:45 | 07:19 | ~2h 30m |
| 31 Jul | 04:45 | 07:37 | ~2h 50m |
| 01 Aug | 04:45 | 07:20 | ~2h 30m |

Subtract a few minutes of run time and the schedule is landing 2½–3¼ hours late,
every day. `docs/skill-runner.md` says "may fire up to ~15 min late" — that is
GitHub's own optimistic figure and it is not what this repo is getting. The
06:30 BST target is being missed by two hours; the brief arrives mid-morning.
Evening (`45 19`) is better but still 30–50 min late, and Saturday's
`interest-scout` ran 2h late on 1 Aug.

**Fix: drive the schedule from Cloudflare, not GitHub.** You already run a Worker
holding a GitHub PAT (`worker/worker.js`, `GH_TOKEN`). Cloudflare cron triggers
fire on time — and `workflow_dispatch` runs start immediately, unlike `schedule`
runs. Concretely:

```toml
# worker/wrangler.toml
[triggers]
crons = ["45 4 * * *", "45 19 * * *", "0 8 * * 6"]
```

```js
// worker/worker.js — add alongside fetch()
async scheduled(event, env) {
  const skill = { "45 4 * * *": "morning-brief",
                  "45 19 * * *": "evening-brief",
                  "0 8 * * 6":  "interest-scout" }[event.cron];
  await gh(env, "/actions/workflows/scheduled-skills.yml/dispatches", {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { skill } }),
  });
}
```

The workflow already accepts a `skill` input via `workflow_dispatch`, so the only
change on the GitHub side is deleting the `schedule:` block. The PAT needs
`actions: write` adding to its existing `contents: read/write`.

(Cheaper interim mitigation if you don't want to touch the Worker: move the cron
off the popular slot and set it much earlier — `15 3 * * *` — accepting that you
are compensating for latency rather than removing it.)

### 4b. Nothing has been delivered to your phone since 20 July

This is the larger problem and it is independent of timing. Every entry in
`_meta/hot-cache.md` for the last twelve days ends the same way:

> Delivery to phone failed — `NTFY_TOPIC` not set in this run's environment
> (same recurring issue since 20 Jul, unresolved); git push succeeded.

`scripts/notify.sh:11` guards with `${NTFY_TOPIC:?}`, which trips on both unset
and empty. The 21 July retry entry diagnosed it precisely: the secret is
*present but blank*. So the briefs are being written and pushed correctly, and
then going nowhere. **Set the `NTFY_TOPIC` repository secret** — that is a
one-minute fix and it is the actual reason you aren't getting them.

### 4c. Health reports green while delivery is failing

`worker/vault.js:1264-1326` checks that each cadenced skill *ran* recently and
didn't exit non-zero. It has no notion of delivery, and `run-skill.sh` exits 0
when the brief was written but `notify.sh` failed. Twelve consecutive days of
undelivered briefs and the dashboard has said "all routines on schedule"
throughout. That is precisely the failure mode golden rule 5 exists to prevent.

**Fix:** have `run-skill.sh` record `"delivered": true|false` in the `.status`
file (it can capture `notify.sh`'s exit code), and add it to the `checks` array
in `health()` as its own row. A brief that exists but never reached you is not a
successful run.

---

## 5. Other findings

**Completed-task decay never fires for skill-authored edits.**
`splitStaleDone()` (`worker/vault.js:913`) is only ever called from
`writeTasks()` (`:938`), i.e. only on dashboard API writes. Skills edit
`tasks.md` directly with the file tools, so the sweep is skipped. Evidence in the
live file: four tasks ticked on 24–25 July are still sitting in `tasks.md` on
1 August, well past `RETAIN_DONE_DAYS = 3`. Either run the sweep as a step in
`file-inbox`, or add it to the weekly housekeeping skill.

**Digest content is leaking into `tasks.md`.** Four lines in `tasks.md` are
`interest-scout` output filed as tasks:

```
- [ ] Jujutsu Kaisen Season 4 — first trailer revealed 19 June 2026 … Crunchyroll
- [x] Dune: Part Three — new full trailer dropped 8 July 2026 … ✅ 2026-07-24
```

These are media items, not actions. This is the same failure CLAUDE.md warns
about for shopping lists ("permanent noise that never leaves"). `interest-scout`
should write only to `digests/`; if an item deserves an action it should be one
short task ("Book Faithless tickets"), never the paragraph. Worth adding an
explicit "never write to tasks.md" line to `_meta/skills/interest-scout.md`.

**Duplicated workflow logic.** The "process queued runs" and "commit results with
rebase-retry" blocks are ~45 lines duplicated near-verbatim between
`skill-runner.yml` and `scheduled-skills.yml` (the sweep step in the latter is a
third copy of the first). Extract to `scripts/process-queue.sh` and
`scripts/commit-and-push.sh`, or a composite action. The env-var block is a
fourth duplication — that one can move to a job-level `env:`.

**`dashboard/index.html` is 2,180 lines** of HTML, CSS and JS in one file. That
was a reasonable call for a zero-build PWA and I wouldn't add a bundler, but the
CSS (~450 lines) and the JS (~1,400) can each move to a sibling file served from
the same directory with no toolchain at all. The `sw.js` cache list is the only
thing that needs updating.

**Test coverage is narrow.** `test/vault.test.mjs` is good — 17 tests, and the
wikilink-preservation guard is exactly right for a system that edits prose. But
it covers *tasks only*. Habits (`toggleHabit`, streaks, the lazy day reset),
lists (`clearListDone`), `health()`, and the private-event filter
(`PRIVATE_EVENT`, `worker/vault.js:751`) are all untested. The private-event
filter especially — it's a binding rule in CLAUDE.md enforced by one regex in two
places, with nothing asserting either.

**Two calendar filters, one rule.** `PRIVATE_EVENT` is implemented separately in
`worker/vault.js:751` and `scripts/fetch-calendar.mjs`. CLAUDE.md names both, so
the duplication is deliberate and documented — but it's still two places to
change one rule, and one has tests available and the other doesn't. A shared
constant would be safer.

---

## 6. Three ways to improve the data held on you

The binding constraint is not the schema, the skills or the UI. It is volume:
**9 captures in 17 days**, 8 habit ticks (none since 27 July), 1 lesson recorded
in two weeks despite 👍/👎 buttons on every brief line. The system's own hot-cache
says it out loud on 23 July — *"Advice repeats the 19 Jul fight log … since
nothing newer is grounded."* It is re-quoting a fortnight-old interview because
nothing has arrived since. All three suggestions below attack volume rather than
structure.

### 1. Harvest the streams you already have, instead of asking for more captures

Three calendar feeds are fetched every morning, read for "today's events", and
thrown away. Gmail has printed *"Email skipped (Gmail creds unset)"* in the brief
every single day for two weeks. That is a large amount of factual, zero-effort
data about what you actually did and who you actually saw, currently discarded.

A weekly `harvest` skill that reads the *past* seven days of calendar (not the
next) and writes dated fragments — "2026-07-25 — JGC monthly drinks", "2026-07-27
— PEM site visit" — into the relevant `people/`, `projects/` and `notes/` files
would produce more real fragments in one run than manual capture has produced in
a fortnight. And it needs no behaviour change from you at all. Wiring the Gmail
credentials does the same for correspondence.

This is also the thing that would make §3's People card worth keeping.

### 2. Replace the open-ended nudge with one specific question a day

`evening-brief` currently ends with *"Anything to log?"* — a soft, open prompt.
It has yielded 9 captures in 17 days, which is what open prompts yield. Specific
questions get answered; open ones get scrolled past.

Keep a `_meta/gaps.md` list of what the vault demonstrably doesn't know — Milo
and Jasper have one log line each; you have a half-marathon goal and a sore
Achilles with no recorded run, weight or resting HR anywhere; `house-retrofit` is
stalled with no note on *what the next physical step is*. Have the evening brief
ask **one** of them, rotating, and have `file-inbox` cross the gap off when it's
answered. The reply path already exists — the file modal has a reply box wired
to `/api/append`, so answering is one tap from the notification.

This respects rule 3 (no nagging): it's one line replacing a line that's already
there, not a new prompt.

### 3. Start scoring days against your own definition, and record outcomes

`_meta/identity.md` defines a good day and explicitly calls it countable:
*"tasks completed, and something positive written."* Nothing counts it. There is
no record anywhere of whether a day met that bar, whether the relationship advice
was acted on, or whether a suggestion landed — so every brief starts from zero
and reasons from the same July fragments.

Add one append-only line per day to a `_meta/day-log.jsonl` at the end of
`evening-brief`: tasks completed, captures filed, habits ticked, whether the day
met the bar, and a single free-text word from you. Two weeks of that is the first
data the system would hold about *trends* rather than *facts* — enough to say
"you've completed nothing for four days and captured nothing, and the last three
times that happened it preceded a bad week", which is the coaching you asked for
and the one thing it currently cannot do.

It also gives the 👍/👎 lessons somewhere to attach. One lesson in two weeks
isn't a UI problem; it's that a thumbs-down currently changes nothing you can
observe.

---

## 7. Suggested order

1. Set the `NTFY_TOPIC` secret. Nothing else matters while delivery is dead. (§4b)
2. Add the delivery check to `health()`. (§4c)
3. Cloudflare-driven schedule. (§4a)
4. Fix `outputs` in `run-skill.sh`, trim the routines card. (§2)
5. The `harvest` skill and the daily gap question. (§6.1, §6.2)
6. Decide on the People card once §6.1 has run for a fortnight. (§3)
7. Cleanups: task decay, interest-scout leakage, workflow deduplication, tests. (§5)
