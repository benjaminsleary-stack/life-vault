# Skill: evening-brief

A light end-of-day note. Read `CLAUDE.md`.

## Steps
1. Run `file-inbox` first (clear anything captured during the day).
2. Compose `digests/<today>-evening.md`:
   - **Tomorrow** — tomorrow's calendar from `scripts/fetch-ics.py`.
   - **Filed today** — one line on what `file-inbox` routed (counts + notable items).
   - **## Charlotte** — surface anything captured or logged about Charlotte today
     (from today's filed inbox and the recent `## Log` fragments in her people note),
     with the capture dates. Only real, captured facts — never infer. If nothing, "—".
   - **## Advice** — 1–3 short, **specific** suggestions for nurturing the relationship
     this week, each grounded in what's actually been logged about Charlotte (not
     generic platitudes). One bullet each so a single item can be saved. If nothing
     specific is warranted, give one gentle, concrete idea.
   - **Anything to log?** — a single gentle nudge. One line, never a chore.
3. Commit + push.
4. `bash scripts/notify.sh "Evening" digests/<today>-evening.md`.
5. Assert the file exists and is non-trivial; on failure, notify the failure instead.

Keep it short — this is a soft close, not a second morning brief. No task nagging.
