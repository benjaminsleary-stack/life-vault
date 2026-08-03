# Runs, via Strava

The vault reads runs from **Strava**, and the Garmin watch feeds Strava.

```
Garmin watch → Garmin Connect → (auto-sync) → Strava → fetch-strava.mjs → running-fitness.md
```

## Why not Garmin directly

Garmin's Health API is a **partner programme**. You apply as a company, personal
applications are routinely refused, and there is no free personal tier. The only
direct routes are unofficial libraries that log in with your Garmin password and
break whenever Garmin ships a release.

Strava, by contrast, has a free, official, documented OAuth API, and Garmin
Connect will push every activity to it automatically. Two hops instead of one,
but both are supported paths and **no Garmin credential is stored anywhere**.

Optional, like everything else: unset, `fetch-strava.mjs` exits 3 ("not
configured") and `harvest` mentions it once and carries on.

## Setup, once

**1. Turn on the Garmin → Strava sync.** In Garmin Connect: **Settings →
Account Settings → Partner Connections → Strava → Connect**. From then on every
activity appears in Strava within a minute or two of syncing your watch.

**2. Make a Strava API application.**
[strava.com/settings/api](https://www.strava.com/settings/api) → create one.
Name it anything. Set **Authorization Callback Domain** to `localhost`. Copy the
**Client ID** and **Client Secret**.

**3. Get a refresh token.** From the vault root:

```bash
export STRAVA_CLIENT_ID='…'
export STRAVA_CLIENT_SECRET='…'
node scripts/strava-auth.mjs            # prints a URL
```

Open it, approve, then:

```bash
node scripts/strava-auth.mjs '<code from the address bar>'
```

> **Tick the private activities box.** The scope requested is
> `activity:read_all`. If you approve without it, private activities are
> silently omitted — no error, they simply never appear, which looks exactly
> like the integration being broken. `strava-auth.mjs` warns if the granted
> scope comes back without it.

**4. Store three secrets.** GitHub → **Settings → Secrets and variables →
Actions**: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN`.
Optionally the same three in `.env` for desktop runs.

## Check it

```bash
node scripts/fetch-strava.mjs 30
```

You should get JSON with a `runs` array and a `weeks` block. Exit code 0 is
fine, 3 means a credential is missing, 1 means it is configured but broken.

## What gets recorded

`harvest` runs weekly (Sunday) and writes one dated fragment per run to
`projects/running-fitness.md`:

```
- 2026-08-14 — Ran 8km in 40 min (5:00/km), avg HR 152. _(from Strava)_
```

Plus, **only when the week-on-week distance changed by 25% or more**, one
further fragment stating the change:

```
- 2026-08-15 — Weekly distance up 60% on last week (10km → 16km). _(from Strava)_
```

That comparison is the reason this integration is worth having. Three injuries
since restarting running — Achilles, knees, ankle — against a half-marathon
goal, and no record anywhere of what the training load actually was. The number
goes in the vault; what to do about it is between Ben and his own judgement. The
skill is explicitly told to state it and stop: no warnings, no rest advice, no
mentioning the Achilles.

A jump measured off a base under 5km is not reported at all — 2km to 4km is
+100% and means nothing. A fortnight with no runs writes nothing, because
filing "no runs" every week he is injured would read as a reproach.

## When it stops working

**`token refresh failed`** — the usual cause is that Strava rotated the refresh
token. Nothing in a GitHub Action can rewrite its own secret, so the script
detects rotation and reports the new token in `refreshTokenRotated`. Paste that
into the `STRAVA_REFRESH_TOKEN` secret and it works again. If the token was
revoked instead (you removed the app from your Strava settings), redo step 3.

**Runs are missing but the script says ok.** Almost always the private-activity
scope. Check `activity:read_all` at
[strava.com/settings/apps](https://www.strava.com/settings/apps), and redo
step 3 if it isn't there.

**`rate limited by Strava`** — 100 requests per 15 minutes, 1000 a day. A weekly
harvest uses two. If you see this, something is looping.

## Weight

Not covered. The watch reports runs, not body weight, and there is no Garmin
Index scale in the picture — so weight stays a manual number, asked for by the
evening brief through `_meta/gaps.md`.
