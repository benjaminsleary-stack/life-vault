# Skill: ask

Answer a question from the vault. This is the 90% on-demand path — used in Claude
Desktop chat, and read-only from mobile via the GitHub MCP connector.

## Steps
1. Start from `_meta/index.md` and `_meta/hot-cache.md` for orientation, then read
   the specific `people/` `projects/` `notes/` files the question needs. Follow
   `[[wikilinks]]`. Don't read the whole vault — target the relevant notes.
2. Answer concisely and **only from what the files say**. Prefer dated fragments over
   summaries; if they conflict, trust the fragments and note the discrepancy.
3. Cite which notes you drew on. If the vault doesn't know, say so — don't guess.
4. If asked to add/update/complete something, make the smallest correct edit per
   `CLAUDE.md` (append a fragment, add/tick a task) — never delete, never rewrite a log.

Examples: "what should I be on top of for Charlotte this week?", "what's open for
the house?", "what did I note about the plumber?", "add: bins out Thursday".

## Non-interactive (dashboard) mode
When run by the skill-runner with a question under `## Input from the dashboard`,
answer as above but **write the answer to `_meta/last-answer.md`** (title it with
the question, then the answer, then the notes you cited), and commit. That file is
a transient scratch answer — overwrite it each time; it is not a capture or a
fragment, so replacing it is fine. The dashboard opens it automatically.
