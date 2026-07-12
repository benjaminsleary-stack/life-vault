# Android capture — HTTP Shortcuts recipe

One shortcut = one atomic capture that PUTs a new file into `inbox/` on GitHub.
Works with the laptop off (it talks to GitHub, not your desktop). No append, no SHA,
no 409 — every capture is a brand-new file, so collisions are impossible.

## App
[HTTP Shortcuts](https://http-shortcuts.rmy.ch/) (Android). Create one shortcut,
add it to the home screen, and register it as a **share-sheet** target. Voice =
your keyboard's dictation into the text field.

## Request
- **Method:** `PUT`
- **URL:** `https://api.github.com/repos/<OWNER>/<REPO>/contents/inbox/{{timestamp}}-{{uuid}}.md`
  - `{{timestamp}}` → a variable formatted `yyyy-MM-dd'T'HHmmss`
  - `{{uuid}}` → HTTP Shortcuts' built-in UUID/random variable (collision guard)
- **Headers:**
  - `Authorization: Bearer <FINE_GRAINED_PAT>`  ← Contents: Read/Write, **this repo only**
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
- **Body (JSON):**
  ```json
  {
    "message": "capture",
    "content": "{{base64(text)}}"
  }
  ```
  where `text` is the captured note (the share-sheet payload or the typed/dictated
  input). HTTP Shortcuts can base64-encode a variable; the Contents API requires the
  file `content` to be base64.

## Notes
- **PAT scope:** fine-grained, single repo, Contents read/write only. It lives in the
  shortcut in ~plaintext — narrow scope is the mitigation. **Record its expiry in the
  vault and diarise rotation** (fine-grained PATs can't be non-expiring on some orgs;
  verify max lifetime — spec §13.4).
- **`done:` convention:** to tick a task from your phone, capture text starting with
  `done: ` (e.g. `done: ordered the washing machine`). The morning `file-inbox` ticks
  the matching task.
- These captures appear in your Obsidian view only after: a routine files them → the
  desktop bridge pulls → Obsidian Sync propagates. That lag is by design (spec §1b).
