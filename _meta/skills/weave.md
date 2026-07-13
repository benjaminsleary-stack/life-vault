# Skill: weave

Curate the vault's link network. Run on demand ("weave the network") or as the
final step of `refresh-summaries`. Read `CLAUDE.md` (Areas & linking) first.

## What it does, in order

1. **Inventory entities.** List every note in `people/`, `projects/` and `maps/`
   by `name` (and filename). These are the only valid link targets.
2. **Link real mentions.** Scan `notes/`, `daily/`, and the `## Log` sections of
   entity notes for plain-text mentions of a known entity that are not yet
   wikilinked. Wrap them: `Charlotte` → `[[Charlotte]]`. First mention per note
   only; leave code blocks, frontmatter and headings alone.
3. **Update the maps.** For each `maps/*.md`: ensure every entity tagged with
   that area appears in the right section with a one-line context. Remove lines
   whose target note no longer exists. Maps hold links only — never move content
   into a map.
4. **Refresh the master index.** `_meta/index.md`: areas list, active people,
   active projects (drop anything with no fragment in 60 days from "active" —
   the note itself is untouched), open threads.
5. **Report orphans.** End with a short list of notes having zero inbound and
   zero outbound links, and any dangling links pointing at non-existent notes.
   Recommend; don't auto-create or delete anything.

## Hard rules (anti-tenuous-link)

- Link ONLY where the text genuinely refers to that entity. Never link on
  keyword coincidence, theme, or "might be related".
- Never create a new note to satisfy a link. A dangling link is reported, not
  resolved by inventing content.
- Never add "Related" sections of speculative links to notes. Structure lives
  in the maps, not in cross-note link spam.
- Hub-and-spoke: detail notes link to entities and appear in maps; they do not
  need to link to each other unless one actually cites the other.
- Never edit fragment text beyond wrapping a mention in `[[ ]]`.
- Smallest correct edit; one commit at the end summarising counts
  (e.g. "weave: 14 links added, 2 orphans reported").
