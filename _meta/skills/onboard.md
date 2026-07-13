# Skill: onboard

A one-time guided interview that seeds the vault from scratch. Designed to run on
a low-cost model: follow the steps literally, in order, one area at a time. Do NOT
read the rest of the vault; the only files you touch are the ones named below.

## Ground rules

- Record ONLY what Ben tells you. Never infer, embellish, or invent a fact.
- Today's date stamps every fragment: `- YYYY-MM-DD — <fact>`.
- Area tags come from the closed list only: `family house work health interests admin`.
- Filenames: lowercase, hyphens (`people/john-smith.md`).
- Write files after EACH area, then confirm in one line and move to the next area.
  Never hold everything to the end.
- If an answer is ambiguous, ask one short follow-up. Do not guess.

## Templates (copy exactly)

Person (`people/<name>.md`):
```markdown
---
type: person
name: <Name>
tags: [<areas>]
updated: <today>
---

## What to know
<one-line relationship + anything standing, from Ben's words>

## Log
- <today> — <each fact Ben gave, one line each>
```

Project (`projects/<name>.md`): same shape, `type: project`.
Topic/reference (`notes/<name>.md`): same shape, `type: topic`, no Log needed —
plain content is fine.

Task (append to `tasks.md`): `- [ ] <action> 📅 YYYY-MM-DD #<area>` (date only if
Ben gave one).

## Interview order

1. **Identity** — ask: role/profession, where he lives (town is enough), household,
   anything an assistant should always know. Write `_meta/identity.md` (short
   paragraphs under `# About Ben`).
2. **Family & friends** (`#family`) — for each person: name, relationship, anything
   in flight, dates worth tracking (birthdays etc.). Create/update `people/*.md`.
   Birthdays: add a line under `## Dates & occasions` in `maps/family.md` AND a
   fragment on the person's note.
3. **House** (`#house`) — active projects (→ `projects/*.md`), standing facts
   (→ `notes/*.md`), tradespeople (→ `people/*.md` tagged `[house]`).
4. **Work** (`#work`) — career-level only (CPD, chartership, direction, key
   colleagues). Day-to-day work knowledge does NOT belong in this vault.
5. **Health** (`#health`) — routines, goals, ongoing threads, reference facts.
6. **Interests** (`#interests`) — genres/artists/directors he actually likes
   (this seeds `maps/interests.md` → `## Taste profile`), current queue, upcoming
   gigs/events.
7. **Admin** (`#admin`) — renewals with dates (→ tasks), providers/accounts
   (→ notes; NEVER credentials), open paperwork.
8. **Task sweep** — "anything else on your plate, any area?" → `tasks.md`.

## After each area

- Add every new entity to the matching `maps/<area>.md` section as
  `[[name]] — one-line context`. Links only; no content in maps.
- Add new people/projects to `_meta/index.md` under Active people / Active projects.

## Final verification (do not skip)

1. Every created note has valid frontmatter and at least one area tag from the
   closed list.
2. Every entity appears in exactly the maps matching its tags; every map line's
   target file exists.
3. `_meta/identity.md` is non-empty; `tasks.md` has every dated item mentioned.
4. Output a summary count: people / projects / notes / tasks created — and list
   anything Ben mentioned that you could NOT file, so a human can decide.
