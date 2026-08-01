# Skill: harvest

Turn the week that actually happened into dated fragments. Read `CLAUDE.md`
first — the golden rules and the anti-tenuous-link rules are binding here, and
this skill writes to more notes than any other.

**Why this exists.** The calendar is fetched every single morning, read for
"what's on today", and thrown away. Three feeds' worth of factual evidence about
who Ben saw and what he did, discarded daily, while `people/` sat full of
one-line stubs and the briefs re-quoted the same July fragments because nothing
newer was grounded. Captures run at roughly one every other day; a week of
calendar is worth more than a fortnight of them, and costs Ben nothing.

**What it is not.** Not a diary, not a summary, not a second brief. It writes
fragments and stops. Nothing it produces is delivered to the phone.

## Steps

1. **Read the week.** `node scripts/fetch-calendar.mjs 7 --back` — the last
   seven days, ending today. If a source reports `ok: false`, say so in your
   summary and carry on with the sources that worked; do not silently harvest a
   partial week and call it the week.

2. **Discard the noise before you write anything.** Drop:
   - anything already filtered as private (`That week` — the script does this,
     do not re-add it by hand from another source),
   - recurring admin with no content (standups, "focus time", "lunch", blocked
     -out placeholder blocks, declined events),
   - all-day markers that are context rather than events (e.g. a "France" span
     is background for the week, not a fragment about anyone).

   What survives is what a person would mention if asked how their week went.

3. **Route what's left**, using the same conservatism as `file-inbox`:
   - **Names a person with an existing `people/*.md`** → append one dated
     fragment to their `## Log`: `- <YYYY-MM-DD> — <what happened>. _(from calendar)_`
     Match on the name as written. Do **not** create new people notes from
     calendar attendees or titles — a name in a meeting title is not evidence
     that someone belongs in the vault, and this skill running weekly would
     otherwise fill `people/` with colleagues by Christmas.
   - **Names an existing project** → append a dated line to that
     `projects/*.md` log.
   - **Work events with no person or project** → do not write them one by one.
     Instead append a single weekly line to `projects/jgc-director-path.md`
     only if the week genuinely contained something that bears on it (a
     directors' meeting, a client win, a presentation). A list of site visits
     is not a fragment; it is a diary, and nobody reads it.
   - **Anything else** → leave it. A quiet week should produce a short harvest,
     and an empty one should produce nothing at all. Padding this note with
     tenuously-relevant lines is the exact failure mode CLAUDE.md's linking
     rules exist to prevent.

4. **Tick off answered gaps.** Read `_meta/gaps.md`. If this week's calendar
   answered one of the open questions (a run appearing on the calendar answers
   "no recorded runs", a GP appointment answers a health gap), mark it answered
   with today's date rather than leaving the evening brief to ask something the
   vault now knows.

5. **Update `_meta/hot-cache.md`** with one line: how many fragments you wrote,
   to which notes, and anything that looked worth a human's attention.

6. **Assert (green ≠ done).** State plainly in your output how many fragments
   you wrote and where. If the calendar returned zero events across all sources
   for a full week, that is far more likely to be a broken feed than a week in
   which nothing happened — treat it as a failure and say so loudly, naming the
   source. Do not write "quiet week".

## Rules

- **Only real, captured facts** (golden rule 4). Write what the calendar says
  happened. Never infer how it went, whether it was enjoyable, or what it meant.
  "2026-07-25 — JGC monthly drinks." is a fragment. "Seemed like a good night"
  is an invention.
- Append only. Never rewrite an existing fragment, never touch a `## What to
  know` summary — `refresh-summaries` owns those.
- One fragment per event, at most. A recurring weekly meeting produces one line
  for the week, not five.
- Never write to `tasks.md`. Nothing here is an action.
- Idempotent: re-running for the same week must not duplicate fragments. Check
  the target `## Log` for a line already carrying that date and substance before
  appending.
