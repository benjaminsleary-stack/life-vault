# Skill: evening-brief

A light end-of-day note. Read `CLAUDE.md`.

## Steps
1. Run `file-inbox` first (clear anything captured during the day).
2. Compose `digests/<today>-evening.md`:
   - **Tomorrow** — tomorrow's calendar from `scripts/fetch-ics.py`.
   - **Filed today** — one line on what `file-inbox` routed (counts + notable items).
   - **Anything to log?** — a single gentle nudge (e.g. "Worth noting anything from
     today about Charlotte or the kids?"). One line, no list, never a chore.
3. Commit + push.
4. `bash scripts/notify.sh "Evening" digests/<today>-evening.md`.
5. Assert the file exists and is non-trivial; on failure, notify the failure instead.

Keep it short — this is a soft close, not a second morning brief. No task nagging.
