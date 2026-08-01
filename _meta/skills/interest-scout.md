# Skill: interest-scout

Weekly scout of genuinely new music / film / TV (and gigs near Cambridge) matched to
Ben's interests. Needs web access in the environment.

## Steps
1. Read Ben's taste profile from `maps/interests.md` and the notes it links
   (music-taste, film-tv-anime, media-consumption, outdoors-adventure).
2. Web-search for: newly released or newly announced **music**, **film**, **TV**
   that fit those interests this week; and **concerts/gigs near Cambridge** in the
   next ~3 months by artists he likes. Prefer specifics (title, date, where, a link).
3. Keep only genuinely new, genuinely relevant items (2–3 per category max). If a
   category has nothing worth it, say "nothing new" — do not pad.
4. Write `digests/<year>-W<week>-interests.md` with a short section per category.
5. Commit + push. Then `bash scripts/notify.sh "Weekly interests" digests/<file>`.
6. Assert the file exists + non-trivial; notify failure otherwise.

No hallucinated releases or dates — everything must trace to a real search result
with a link. When unsure, drop it.

## Never write to tasks.md

The digest is the output. This skill has previously filed its own findings into
`tasks.md` as checkboxes — four of them, each a full paragraph:

```
- [ ] Jujutsu Kaisen Season 4 — first trailer revealed 19 June 2026 at MAPPA's
      15th-anniversary livestream, covering the second half of the Culling Game
      arc. No release window yet. Crunchyroll
```

That is not a task. It has no action and no completion, so it can never be
ticked honestly, and it sits in the list forever pushing real work down the
page — the same failure CLAUDE.md describes for shopping lists ("permanent
noise that never leaves"). A media item is a thing to read about, not a thing
to do.

- Write **only** to `digests/`. Nothing here goes to `tasks.md`.
- If an item genuinely needs an action, that action is short and separate:
  `- [ ] Book Faithless tickets (Audley End, 9 Aug) 📅 <date> #interests` — an
  imperative verb and a date, never the description.
- Durable taste signals belong in the interest notes (`music-taste`,
  `film-tv-anime`) as dated log lines, not in the task list.
