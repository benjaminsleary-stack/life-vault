# Dashboard — running it locally

`dev/server.mjs` serves `dashboard/` and mounts the same API the Cloudflare
Worker does, backed by the vault files on disk instead of the GitHub Contents
API.

```
node dev/server.mjs          # http://localhost:8766
```

No build step, no dependencies. `LV_PORT` changes the port. Auth is off (it is
a localhost tool); set `LV_TOKEN` to require the same bearer token the Worker
expects.

## Why it exists

The dashboard has two hosts and one set of rules. Everything that knows what a
task, habit, occasion or person note *means* lives in `worker/vault.js` behind
a three-method `store`:

| | store | used by |
|---|---|---|
| `worker/worker.js` | GitHub Contents API | the deployed PWA |
| `dev/server.mjs` | local filesystem | development |

This matters because the previous local server (`scripts/dashboard-server.py`)
reimplemented the markdown parsing in Python and drifted three features behind
the Worker — no habits, no skill status, no priority, no reorder. Developing
against it meant developing against a different app. It has been removed.

## Working on the dashboard

Writes land in the working tree, so `git diff` shows exactly what a click did
before it goes anywhere. Revert a test with `git checkout tasks.md`.

The page detects localhost and skips the unlock gate, talking to the same
origin. Deployed, it still requires the token.

## Deploying

Unchanged — `cd worker && npx wrangler deploy` for the API, and Cloudflare Pages
for `dashboard/`. See [dashboard-cloud.md](dashboard-cloud.md).
