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
      - `done: <text>` → find the best-matching open task in `tasks.md`, tick it
        `- [x]` and append ` ✅ <today>`. If no confident match, add a note instead.
      - mentions a known person (a `people/*.md` exists, or an obvious new one) →
        append a dated fragment to that person's `## Log` (create the note from the
        template in CLAUDE.md if new).
      - an action ± a date → add an inline checkbox to `tasks.md` (`📅` date, `#tag`).
      - about a known project → append to `projects/*.md`.
      - else → a note in `notes/` (journal-ish → `daily/<today>.md`).
      - genuinely unsure → `notes/unsorted/<today>.md`, original line preserved.
3. Refresh `_meta/index.md` (active people/projects/open threads) and
   `_meta/hot-cache.md` (the captures you just filed + what changed).
4. Report a one-line-per-capture summary of where each went.

## Rules
- Never delete or reword a capture's meaning. Preserve wikilinks; add `[[links]]`
  where a person/project is named.
- Dates: resolve "Friday"/"tomorrow" relative to today, Europe/London.
- Be conservative creating new people — only when a name is clearly a person.
