# Skill: evening-brief

A light end-of-day note. A soft close, not a second morning brief. No task
nagging.

`CLAUDE.md` is already loaded as project instructions — don't open it.

## Step 1 — file, then preflight

1. Run `file-inbox` first, to clear anything captured during the day.
2. Then, one command:

```
node scripts/brief-context.mjs evening
```

That JSON holds tomorrow's calendar with every source's health, the inbox state,
the Charlotte shortlist, the next gap question, and today's counts for the day
log — all of it computed rather than discovered.

**Do not re-read what it gives you**: not `tasks.md`, not `people/charlotte.md`,
not `_meta/gaps.md`, not the calendar. The bundle is authoritative. **Budget: 8
turns**, the file-inbox pass aside. Discovery one file at a time is what made the
briefs cost $22 in a fortnight.

## Step 2 — compose `digests/<today>-evening.md`

- **Tomorrow** — from `calendar.tomorrow`, labelled by which calendar each came
  from. Name any source with `ok: false` rather than printing an empty evening.
- **Filed today** — one line on what `file-inbox` routed (counts + notable items).
- **## Charlotte** — anything captured or logged about her *today*, with its
  capture date. Only real, captured facts, never inferred. If nothing, "—".
- **## Advice** — 1–3 short, **specific** suggestions for the relationship this
  week, each grounded in a fragment from the bundle (not platitudes). One bullet
  each, so a single item can be saved.
- **## One question** — exactly one line, ending in a question mark. See below.

## Step 3 — the one question

`gaps.next` in the bundle is already the right question: the oldest open gap not
asked in the last 14 days and not already asked three times. Ask it **as
written**, one line. Don't stack a second question on it, don't preface it with
why you're asking, don't apologise for asking.

- Then stamp that gap `_(asked: <today>)_` in `_meta/gaps.md` — one exact-match
  edit against its `raw` line. If that takes it to three asks, move it to
  `## Parked` instead.
- If `gaps.next` is null, write "—". An empty question beats a manufactured one,
  and rule 3 outranks filling the section.

This replaced the old open-ended "Anything to log?", which produced nine captures
in seventeen days. Specific questions get answered.

## Step 4 — score the day

Append **one line** to `_meta/day-log.jsonl` (append-only, golden rule 1). The
counts are in the bundle's `day` block — `tasksCompleted`, `captures`, `habits`,
`fragments` — already counted, so don't re-derive them:

```json
{"date":"2026-08-01","tasksCompleted":2,"captures":1,"habits":3,"fragments":1,"goodDay":true,"note":"…"}
```

- `goodDay` — Ben's own bar from `_meta/identity.md`: at least one task completed
  **and** something positive written down. Both, or it is false. His definition,
  not a generic productivity score, and not to be softened.
- `note` — at most eight words, factual, drawn from what was actually captured.
  No mood inference.

Never surface the score in the brief or in a nudge. It is data for later: after a
fortnight it is the first thing in the vault describing a *trend* rather than a
fact, which is what makes "you've completed nothing and captured nothing for four
days" possible to say truthfully.

## Step 5 — ship

1. `git add -A && git commit && git push`
2. `bash scripts/notify.sh "Evening" digests/<today>-evening.md`
3. Assert the file exists and is non-trivial; on failure, notify the failure
   instead. Delivery is checked for you — `notify.sh` writes a receipt and the
   runner records it — so don't report a brief as delivered on the strength of
   having called the script.
