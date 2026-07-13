# Skill: email-digest

Turn the last day of inbox into a short "what needs Ben" list. Read-only on mail.

## Steps
1. Run `python scripts/fetch-mail.py` (needs env vars `GMAIL_ADDRESS`,
   `GMAIL_APP_PASSWORD`). It writes message bodies + attachments to `scripts/_work/`
   (git-ignored, never committed) and prints a JSON manifest to stdout.
2. Read the manifest. For each message read its body; **open PDF attachments and
   read them** (school letters etc. — this is a key win, use it).
3. Keep ONLY what genuinely needs action or awareness:
   - real people expecting a reply/decision; Jasper's school (Mayfield Primary
     `@mayfield.cambs.sch.uk`, Learning with Parents); anything with an action,
     deadline, form or appointment; financial items needing action.
   - DROP marketing/newsletters/promos, order/delivery/shipping confirmations and
     receipts, OTP/verification codes, "you signed in / shared data" notices, social.
4. Return a compact markdown list — one line each: `**<Sender>** — <what + any date>`
   with a Gmail deep link (`https://mail.google.com/mail/u/0/#search/rfc822msgid:<id>`
   — verify the id resolves). Note a PDF's gist in one clause.
5. Do NOT write files yourself — hand the list back to `morning-brief`, which places
   it. Delete nothing from `scripts/_work/` (the run is ephemeral anyway).

If `fetch-mail.py` errors or returns nothing, say so plainly (do not fabricate) —
the caller's assertion will turn that into a FAILURE notification.
