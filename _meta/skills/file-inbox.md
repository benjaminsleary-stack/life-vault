# Skill: file-inbox

Route every raw capture in `inbox/` into the right note, losing nothing. Read
`CLAUDE.md` first — its routing table and golden rules are binding.

## Steps
1. List `inbox/*.md` (ignore `inbox/_archive/`), **oldest first**. Handle the whole
   batch — an admin day can produce 30+ files. If none, say so and stop.
2. For each capture, in order:
   a. **Archive the raw file first**: move it verbatim to `inbox/_archive/` (same
      filename). Only after it's safely archived do you route its content. If a run
      crashes, nothing is lost and re-running is safe (idempotent on already-archived).
   b. Route the text per `CLAUDE.md`:
      - **a standing instruction to the system** ("monthly", "automatically",
        "keep an eye on", "from now on", "add a check…") → this is a **routine,
        not a task**. Follow the "Standing instructions are routines" section of
        `CLAUDE.md`: write the skill, wire its cadence, and leave nothing in
        `tasks.md`. If you cannot wire it yourself, write the skill file anyway
        and say clearly in your report what still needs doing — never fall back
        to a checkbox. Ben asking the system to do something recurring is the
        opposite of Ben taking on a chore.
      - `done: <text>` → find the best-matching open task in `tasks.md`, tick it
        `- [x]` and append ` ✅ <today>`. If no confident match, add a note instead.
      - mentions a known person (a `people/*.md` exists, or an obvious new one) →
        append a dated fragment to that person's `## Log` (create the note from the
        template in CLAUDE.md if new).
        **[[Charlotte]] is the priority case.** Ben's stated single biggest problem
        is that he cannot track what is on her mind. So: capture anything about her,
        however small — half a sentence beats nothing — and if it carries a date or
        a deadline of hers, keep that date *in the fragment text* so
        `charlotte-surfacer` can find it later as an open loop. A fragment logged
        without its date is a fragment that can never be surfaced at the right
        moment, which is the only moment that matters.
      - **several items in one capture** (`list - a, b, c`, `shopping: x, y, z`, or
        one item per line) → split them. Comma-separated only counts when the
        capture reads as a list, not as prose containing commas.
        - errands/things to buy, i.e. consumed once then meaningless → a **list
          note**: a `notes/*.md` with `type: list` in its frontmatter and one
          `- [ ]` per item. Append to the matching list if one exists (match on
          the name after `list -` / `shopping:`), else create it.
        - durable jobs → one checkbox each in `tasks.md`, same `#tag`, and a
          `[[project]]` wikilink if they clearly belong to one.
        Never write a multi-item capture as a single task — "tidy living room,
        tidy kitchen, do dishes" is three things, and one checkbox can only be
        half-true.
      - an action ± a date → add an inline checkbox to `tasks.md` (`📅` date, `#tag`).
      - about a known project → append to `projects/*.md`.
      - else → a note in `notes/` (journal-ish → `daily/<today>.md`).
      - genuinely unsure → `notes/unsorted/<today>.md`, original line preserved.
3. **Cross off any gap this batch answered.** If a capture answers an open
   question in `_meta/gaps.md` (the evening brief asks one a day), move that
   line to `## Answered` with today's date. Move it, never delete it. Route the
   capture itself normally as well — the answer is content, not just a tick.
4. **Sweep completed tasks.** Any `- [x]` line in `tasks.md` whose `✅ <date>` is
   more than **3 days** old moves to `notes/completed-tasks.md` as
   `- <date> — <task text>`. Moved, never deleted (golden rule 1); a ticked task
   with no `✅` date is left alone, since there is nothing to age it against.

   This is here because the dashboard's own decay only fires on writes that go
   through its API, and skills edit `tasks.md` directly with file tools — so the
   sweep was simply never happening. Four tasks ticked on 24–25 July were still
   sitting in the open list on 1 August.
5. Refresh `_meta/index.md` (active people/projects/open threads) and
   `_meta/hot-cache.md` (the captures you just filed + what changed).
6. Report a one-line-per-capture summary of where each went.

## Rules
- Never delete or reword a capture's meaning. Preserve wikilinks; add `[[links]]`
  where a person/project is named.
- Dates: resolve "Friday"/"tomorrow" relative to today, Europe/London.
- Be conservative creating new people — only when a name is clearly a person.
