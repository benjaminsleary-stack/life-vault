# Skill: interest-scout

Weekly scout of genuinely new music / film / TV (and gigs near Rochdale) matched to
Ben's interests. Needs web access in the environment.

## Steps
1. Read Ben's interests from `_meta/identity.md` (and any `notes/interests.md`).
2. Web-search for: newly released or newly announced **music**, **film**, **TV**
   that fit those interests this week; and **concerts/gigs near Rochdale** in the
   next ~3 months by artists he likes. Prefer specifics (title, date, where, a link).
3. Keep only genuinely new, genuinely relevant items (2–3 per category max). If a
   category has nothing worth it, say "nothing new" — do not pad.
4. Write `digests/<year>-W<week>-interests.md` with a short section per category.
5. Commit + push. Then `bash scripts/notify.sh "Weekly interests" digests/<file>`.
6. Assert the file exists + non-trivial; notify failure otherwise.

No hallucinated releases or dates — everything must trace to a real search result
with a link. When unsure, drop it.
