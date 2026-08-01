# Skill: evening-brief

A light end-of-day note. Read `CLAUDE.md`.

## Steps
1. Run `file-inbox` first (clear anything captured during the day).
2. Compose `digests/<today>-evening.md`:
   - **Tomorrow** — tomorrow's calendar from `node scripts/fetch-calendar.mjs 2`
     (use the entries whose `when` is `tomorrow`), labelled by calendar.
   - **Filed today** — one line on what `file-inbox` routed (counts + notable items).
   - **## Charlotte** — surface anything captured or logged about Charlotte today
     (from today's filed inbox and the recent `## Log` fragments in her people note),
     with the capture dates. Only real, captured facts — never infer. If nothing, "—".
   - **## Advice** — 1–3 short, **specific** suggestions for nurturing the relationship
     this week, each grounded in what's actually been logged about Charlotte (not
     generic platitudes). One bullet each so a single item can be saved. If nothing
     specific is warranted, give one gentle, concrete idea.
   - **## One question** — see below. Exactly one line, ending in a question mark.
3. Score the day — see below. Append one line to `_meta/day-log.jsonl`.
4. Commit + push.
5. `bash scripts/notify.sh "Evening" digests/<today>-evening.md`.
6. Assert the file exists and is non-trivial; on failure, notify the failure instead.
   Delivery is checked for you now — `notify.sh` writes a receipt and the runner
   records it — so do not report a brief as delivered on the strength of having
   called the script.

Keep it short — this is a soft close, not a second morning brief. No task nagging.

## The one question

This replaces the old **"Anything to log?"** nudge, which was open-ended and
produced nine captures in seventeen days. Specific questions get answered.

- Read `_meta/gaps.md`. Take the **oldest open gap that isn't stamped
  `asked:` within the last 14 days**, and hasn't already been asked three times.
- Ask it as **one line**, phrased as written in the file. Don't stack it with a
  second question, don't preface it with why you're asking, don't apologise for
  asking. One line, a question mark, done.
- Stamp that gap `asked: <today>` in `_meta/gaps.md`. If it has now been asked
  three times, move it to `## Parked` instead.
- If every gap is parked or answered, write "—". An empty question is better
  than a manufactured one, and rule 3 (no nagging) outranks filling the section.
- Never ask about anything under a `## Private` heading.

He answers by replying to the brief in the app, which lands in `inbox/` as a
normal capture; `file-inbox` routes it and crosses the gap off.

## Scoring the day

`_meta/identity.md` defines a good day and calls it countable — *"tasks
completed, and something positive written"* — and until now nothing counted it.
So every brief started from zero and reasoned from the same July fragments,
which is why the advice kept repeating itself.

Append **one line** to `_meta/day-log.jsonl` (create it if absent, never rewrite
an existing line — it is append-only, golden rule 1):

```json
{"date":"2026-08-01","tasksCompleted":2,"captures":1,"habits":3,"fragments":1,"goodDay":true,"note":"…"}
```

- `tasksCompleted` — tasks that gained a `✅ <today>` in `tasks.md` today.
- `captures` — files `file-inbox` routed today.
- `habits` — items ticked in `habits-log.md` dated today.
- `fragments` — dated fragments written to any `people/` or `projects/` note today.
- `goodDay` — Ben's own bar: at least one task completed **and** something
  positive written down. Both, or it is false. This is his definition, not a
  generic productivity score, and it is not to be softened.
- `note` — at most eight words, factual, drawn from what was actually captured.
  No mood inference.

Do not surface the score in the brief, and never in a nudge. It is data for
later — after a fortnight it is the first thing in the vault that describes a
*trend* rather than a fact, which is what makes "you've completed nothing and
captured nothing for four days" possible to say truthfully. Nothing under a
`## Private` heading contributes to it.
