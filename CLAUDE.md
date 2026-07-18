# CLAUDE.md — Life-Vault

This repo **is** an Obsidian vault and the single source of truth for Ben's
personal "second brain". Any Claude session (Desktop chat, a headless `claude -p`
run, or a Claude Code Routine) reads and writes these markdown files directly.
There is no app, no database, no API — the files are the system.

Read this before touching anything. Conventions here are binding.

## Golden rules

1. **Never delete a capture or a fragment.** Processed captures move to
   `inbox/_archive/`; they are never removed. Prefer append over rewrite.
2. **Prefer fragments over summaries.** A note's top summary is a convenience;
   the dated fragments below it are the truth. If they conflict, the fragments win
   and the summary is wrong — fix the summary, never the fragments.
3. **No nagging.** Surface tasks only in the morning brief (due/overdue) and when
   asked. An overdue item appears in at most **3 consecutive** morning briefs, then
   demotes to a weekly "stale — decide or delete" line. The list is consulted, not
   enforced.
4. **Only real, captured facts.** Especially for people-memory: surface things that
   were actually written down, with their capture dates. Never infer or invent.
5. **Green ≠ done.** Every scheduled run must assert its own output exists and is
   non-trivial, and shout (via ntfy) if not. Silence must be loud.

## Folder map

| Path | What it holds | Who writes it |
|---|---|---|
| `inbox/` | one file per raw capture (`<ISO>-<rand>.md`); phone PUTs land here | phone → filing skill archives |
| `inbox/_archive/` | processed captures, kept forever | `file-inbox` |
| `people/` | one note per person; summary-at-top + append-only dated fragments | you + skills |
| `projects/` | one note per project | you + skills |
| `notes/` | topics, lists, journal entries | you + skills |
| `daily/` | optional daily log (`YYYY-MM-DD.md`) | you |
| `maps/` | one MOC per life area (links only, never content) | `weave` + you |
| `tasks.md` | ALL open tasks, inline checkboxes, nowhere else | `file-inbox` + you |
| `digests/` | scheduled outputs (`YYYY-MM-DD-morning.md`, `…-evening.md`, `…-W##-interests.md`) | routines |
| `routines/` | the saved prompts pasted into each scheduled Routine | humans |
| `docs/` | operator/setup documentation, not vault content | humans |
| `attachments/` | binary files referenced by notes | you |
| `_meta/identity.md` | "about Ben" profile (seeded by onboarding) | you + refresh |
| `_meta/lessons.md` | routing/preference lessons | you |
| `_meta/index.md` | map-of-content; refreshed by the morning routine | `file-inbox` |
| `_meta/hot-cache.md` | recent-context digest; a cheap stand-in for embeddings | each run |
| `_meta/skills/` | the skill prompt files themselves | humans |
| `scripts/` | fetch-mail, fetch-calendar, notify, bridge | humans |

## Areas & linking (the ordered network)

The vault is organised as **shallow folders by entity type** (the map above) with
**MOCs as the ordering layer** and a **closed tag list** for areas. Folders are
never subdivided by topic.

**The six areas (closed list — never invent a new tag):**
`#family` (incl. friends) · `#house` · `#work` · `#health` · `#interests` · `#admin`

Every entity note and task carries one or more area tags. "People" is not an
area — it's the `people/` folder; a person is tagged with the areas they relate to.

**Linking rules (anti-tenuous-link — these are binding):**
- Link (`[[wikilink]]`) ONLY where text genuinely refers to that entity, and only
  to notes that exist. Never link on theme, keyword coincidence, or "might be
  related". First mention per note is enough.
- Order lives in `maps/*.md` and `_meta/index.md`, not in cross-note link spam.
  Hub-and-spoke: detail notes link to entities and appear in maps; no "Related"
  sections of speculative links.
- Maps contain links + one-line context only. Content in a map is a bug.

**Token economy (keep sessions cheap):**
- Cold-session orientation = `_meta/index.md` + `_meta/hot-cache.md` ONLY. Read a
  full note only when routing to it or asked about it. Never crawl the vault.
- Summaries at the top of entity notes exist so the note rarely needs a full read.
- Split any note that exceeds ~200 lines; archive stale log years to a linked
  `<name>-archive.md`.

**Restructure permission:** the "smallest correct edit" rule binds scheduled
routines. An explicit human request to reorganise, merge, or re-link overrides
it — restructure freely when asked; git makes it revertable.

## Frontmatter schema (entity notes)

```yaml
---
type: person        # person | project | topic
name: Charlotte
tags: [family]        # area tags only, from the closed list
updated: 2026-07-12
---
```

## People notes: append-with-summary

Structure every `people/*.md` and `projects/*.md` as:

```markdown
---
type: person
name: Charlotte
tags: [family]        # area tags only, from the closed list
updated: 2026-07-12
---

## What to know
<2–5 line rolling summary. Rewritten only by `refresh-summaries` (weekly) or a human.>

## Log
- 2026-07-11 — Stressed about her work presentation Thursday. _(surfaced: —)_
- 2026-07-10 — Her mum's operation is on the 14th.
```

Capture appends a dated line to `## Log`. The surfacer stamps a fragment
`surfaced: <date>` once it's used, and won't reuse it for 14 days.

## Tasks

Inline Obsidian-Tasks checkboxes, nowhere else:

```markdown
- [ ] Call the plumber about the leak 📅 2026-07-15 #house
- [x] Order washing machine
```

`📅 YYYY-MM-DD` = due date. `#tag` = domain/area. The Tasks plugin renders the
global list; the morning brief pulls "due/overdue" per rule 3.

## The `done:` capture convention

A capture whose text starts with `done:` is an instruction, not a note — the
`file-inbox` skill finds the best-matching open task and ticks it (`- [x]`),
recording the completion date. Example capture: `done: ordered the washing machine`.

## Capture routing (what `file-inbox` does)

For each file in `inbox/` (oldest first): **archive the raw file first**, then route:
- mentions a known person → append a dated fragment to that `people/*.md`
- clearly a task (has an action + optional date) → add an inline checkbox to `tasks.md`
- about a project → append to the `projects/*.md`
- `done:` prefix → tick the matching task
- otherwise → a note under `notes/` (or `daily/` if it's a journal-style entry)
Never lose text: if unsure, file under `notes/unsorted/` with the original line.

## Style

Plain British English. Wikilinks (`[[Charlotte]]`) between related notes. Keep
summaries tight. Don't restructure the whole vault; make the smallest correct edit.
