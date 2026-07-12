# Skill: refresh-summaries

Rebuild the `## What to know` summary atop each `people/*.md` and `projects/*.md`
from its `## Log` fragments. This is the ONLY skill that rewrites existing prose, so
it runs in a quiet weekly slot (Sun 03:00) to avoid sync conflicts.

## Steps
1. For each entity note:
   - Read the full `## Log` (the fragments are the source of truth — CLAUDE.md rule 2).
   - Rewrite `## What to know` as a tight 2–5 line summary that reflects the *current*
     state: keep durable facts, drop resolved/stale ones, surface open threads and
     what's coming up. **Where the old summary conflicts with the fragments, the
     fragments win.**
   - Update the frontmatter `updated:` date. Do not touch the `## Log`.
2. This exists because life-os summaries drifted (a live query once claimed a
   completed task was still pending). Correct drift; never invent facts not in the log.
3. Commit + push once, at the end. Then `bash scripts/notify.sh "Summaries refreshed" -`
   with a one-line count. Assert you edited ≥1 file; notify failure otherwise.

Make the smallest correct edit — do not restructure notes or reorder logs.
