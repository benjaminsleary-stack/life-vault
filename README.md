# Life-Vault

A personal "second brain" that is a **markdown vault + Claude**, not an app.
Phone ⇄ desktop by **Obsidian Sync**; the desktop mirrors the vault to this
**private GitHub repo**; **Claude Code Routines** (Anthropic cloud) run the
scheduled skills against the mirror and push briefings to your phone via **ntfy**.

Built to `design/plan-life-vault-2026-07.md` **v2.0**. Read that spec for the why;
this README is the operator's build guide.

## Topology (what talks to what)

```
 PHONE                          DESKTOP (laptop, ~5/7 days)        CLOUD
 Obsidian mobile  ◀─Obsidian──▶ Obsidian desktop                  GitHub repo (mirror)
 (review, edit)      Sync       vault folder = git repo  ◀──push──▶      ▲
 HTTP Shortcuts ───── Contents API PUT ─────────────────────────────────┤
 (capture, laptop-independent)                                          │
 ntfy client  ◀──────────── push (allowlisted) ─────── Claude Code Routine (cloud clone/run)
```

**Accepted lag:** a *note edit* made on the phone while the laptop is off reaches
the routines only when the laptop next syncs+pushes. **Captures don't lag** (they
PUT straight to GitHub). **Briefings don't lag** (ntfy carries the content).

## What's in this repo (built for you)

- `CLAUDE.md` — vault conventions every agent obeys. `.claudeignore` / `.gitignore`.
- `_meta/skills/*.md` — the 10 skills (file-inbox, email-digest, morning-brief,
  evening-brief, interest-scout, refresh-summaries, charlotte-surfacer, ask,
  weave, onboard).
- `maps/*.md` — one MOC per life area; the ordering layer over the flat folders.
- `routines/*.md` — the thin saved-prompts you paste into each Routine.
- `scripts/` — `fetch-mail.py`, `fetch-calendar.mjs`, `notify.sh`, `bridge.sh`,
  `setup.sh`, `requirements.txt`, and `migrate-from-life-os.mjs`.
- Folder skeleton: `inbox/ people/ projects/ notes/ daily/ digests/ _meta/`.

## Setup checklist (do in order — maps to spec §11 phases)

> Anything marked **[you]** is manual / off-device and can't be scripted from here.

### Phase 0 — onboard (fresh start; the old life-os database is scrapped)
- [x] **[you]** Run the guided interview on a low-cost model from the vault root:
      `claude --model haiku` → "run the onboarding interview in _meta/skills/onboard.md"
      (or Claude Desktop/Cowork with the model switched to Haiku, folder = this vault).
- [x] **[you]** Review the seeded notes; confirm `_meta/identity.md` is non-empty
      and every entity appears in its `maps/*.md`.
- [x] Run "weave the network" (`_meta/skills/weave.md`) on a capable model; check
      the Obsidian graph for orphans and tenuous links.

### Phase 1 — vault + sync + bridge
- [x] **[you]** Open this folder as an Obsidian vault; install plugins: **Tasks**,
      **Dataview**. (Optional dashboard later.)
- [x] **[you]** Turn on **Obsidian Sync**; confirm it does **not** sync `.git/`
      (spec §13.2). Install kepano's `obsidian-skills` into `.claude/`.
- [x] **[you]** Install the desktop **bridge** as an OS-scheduled job (launchd / Task
      Scheduler / cron) running `scripts/bridge.sh` every 10 min. NOT the
      obsidian-git plugin as the mechanism of record.
- [x] Accept: a phone edit reaches GitHub within one bridge cycle; `.git` untouched
      by Sync; no conflict in 3 days.

### Phase 2 — capture
- [ ] **[you]** Create a fine-grained **PAT**, *Contents read/write on this repo only*.
- [ ] **[you]** Android **HTTP Shortcuts**: a share-sheet + home-screen + voice
      shortcut doing the `PUT` in `scripts/capture-shortcut.md`. Record PAT expiry in
      the vault.
- [ ] Accept: 10 captures (voice + share) land in `inbox/`, zero failures, laptop-off.

### Phase 3 — filing (local first)
- [ ] Dry-run the filing skill on your laptop: `claude -p "$(cat _meta/skills/file-inbox.md)"`
      from the vault root, on a 30-capture batch. Accept: routed correctly, all raw
      files in `inbox/_archive/`, a `done:` capture ticked a task.

### Phase 4 — cloud environment (prove the allowlist BEFORE routines)
- [ ] **[you]** Create a **Custom** cloud environment (not Default). Network access:
      allowlist `ntfy.sh`, `imap.gmail.com`, `calendar.google.com`, `hc-ping.com`
      (healthchecks), your web-search hosts, + keep package registries. See §6.
- [ ] **[you]** Env vars (NOT in prompts): `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`,
      `ICS_URL`, `NTFY_TOPIC`, `HEALTHCHECK_URL`. Setup script: `scripts/setup.sh`.
- [ ] **[you]** Enable **Allow unrestricted branch pushes** on this repo.
- [ ] Accept: a one-off "Run now" routine POSTs a test ntfy message **and** fetches
      mail. This phase exists solely to prove the allowlist — do not skip it.

### Phase 5–8 — the routines
- [ ] **[you]** Create Routines at claude.ai/code/routines, pasting `routines/morning.md`
      etc. as each prompt, pointing at this repo + the custom environment. Schedules:
      morning ~06:45, evening ~20:45 (daily); interest-scout weekly; refresh-summaries
      Sun 03:00. **2 daily + 2 weekly — inside the Pro 5/day cap.**
- [ ] Accept each per spec §11 (7 mornings, laptop-off day included, assertions never
      false-fire, cap not breached).

### Decommission
- [ ] Only after Phase 7 has held **14 days**: shut down Railway + Supabase.

## Verify-before-trusting (spec §13)
Don't take these from memory — test each at build time: cloud allowlist hostnames;
Obsidian Sync pricing + `.git` behaviour; Contents API create-vs-update SHA rules;
PAT max lifetime; GitHub hosted MCP on Pro+Android; the Pro routine cap + one-off
exemption; whether `ANTHROPIC_API_KEY` in the shell blocks `/schedule`; ntfy size
limit + protected topic; Gmail app-password availability (needs 2FA); the Gmail
`rfc822msgid` deep-link; kepano skills install path.

## Fallback
If Routines prove unreliable in Phase 5 (they're a research preview), fall back to
the v1.1 **GitHub Actions** scheduler (needs `ANTHROPIC_API_KEY` reinstated). That
section is retained in the spec on purpose.
