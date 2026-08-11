# Skill: digest-improvements

Tighten digest output and add interactivity.

## Captured
2026-08-07 — "The digests have too much text, lots of 'I looked for this and that and found nothing'. Say nothing instead. Let's tighten these up. Can we also look at adding check boxes to each item so I can acknowledge them and they don't resurface."

## Improvements to implement
1. **Remove narrative about failed searches** — never report "searched X and found nothing". Just emit the results you have. If a section is empty (no results), skip it or write "—".
2. **Tighten language** — one-line summaries only. Remove unnecessary words. No preamble.
3. **Add checkboxes to digest items** — each item in a digest should be acknowledgable; when acknowledged, it should not resurface in future digests (prevents duplicate alerts, same news item resurfacing, etc.).

## What's implemented
- Tightening: morning-brief already says "Keep it scannable. If a section is empty, write '—'."
- Narrative removal: morning-brief currently writes longer descriptions in some sections (News has multi-line summaries, Email includes full sender/summary).

## What's missing
- Checkbox acknowledgment feature requires backend storage (which digest items have been seen/acked by Ben). This needs:
  - A `digests/_acked.jsonl` or similar to track `{date, section, item_id, acked_at}`
  - Each digest item needs a stable `item_id` (not just the text, which changes)
  - The digest generator needs to skip items in the acked list
  - A way for Ben to acknowledge items (UI, command, or checkbox in the markdown)

## Next steps
- **Immediate**: tighten language in `morning-brief` and `evening-brief` skills; remove narrative about searches.
- **Blocked**: checkbox acknowledgment needs a backend mechanism to track seen items.
