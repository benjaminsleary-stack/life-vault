# Google Calendar write access

Everything else in this vault reads calendars: `CAL_WORK`, `CAL_PERSONAL` and
`CAL_FAMILY` are private `.ics` subscription URLs, and a subscription cannot
write. This is the one credential that lets a routine **create** events —
currently used by `family-events` to put the monthly shortlist of days out
straight into the family calendar.

It is optional. Without it, `scripts/calendar-add.mjs` exits 3 ("not
configured") and `family-events` falls back to writing the digest and an `.ics`
file, which still reaches your phone. Nothing else in the vault depends on it.

## What you end up with

Four values, stored as **GitHub Actions secrets** (and in `.env` if you want
desktop runs to work too):

| Name | What it is |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client id |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | long-lived token for your account |
| `GOOGLE_CALENDAR_ID` | which calendar to write to |

The refresh token is a credential with write access to your calendar. It is
never committed, never printed by any routine, and only ever lives in secrets
and `.env` (which is gitignored).

## Setup, once

**1. Make a project and turn the API on.**
[console.cloud.google.com](https://console.cloud.google.com) → create a project
(call it anything) → **APIs & Services → Library** → search "Google Calendar
API" → **Enable**.

**2. Configure the consent screen.** Choose **External**, and fill in the app
name and your own email where required.

> Google has renamed this. In the current **Google Auth Platform** console there
> is no "OAuth consent screen" page: the app name and support email live under
> **Branding**, and the publishing status under **Audience**.

> **The trap.** Leave the app in **Testing** and your refresh token expires
> after **7 days**, every time — the routine will work all week and then die
> quietly each Monday. Go to **Audience → Publishing status → Publish app** so
> it reads *In production*. You will see a warning about verification: it does
> not apply here, because the only user is you and the app is not public. Do not
> skip this step.

**3. Create the OAuth client.**
**Clients → Create client** → application type **Desktop app**. Copy the
**client ID** and **client secret**.

> **Desktop app, not Web application.** `scripts/google-auth.mjs` redirects to
> exactly `http://localhost`, and a Desktop client accepts that loopback with no
> redirect URIs to register — the "Authorized redirect URIs" section does not
> even appear. Pick Web application and you get a redirect-mismatch error, and
> the fix is a URI list you then have to keep in step with the script.
>
> If an unrelated OAuth client already exists in the account — an old project's,
> say, with a `http://localhost:3000/api/auth/...` callback — make a new one
> rather than adding `http://localhost` to it. Two apps sharing a client means
> deleting either one breaks the other.

**4. Get a refresh token.** From the vault root:

```bash
export GOOGLE_CLIENT_ID='…'
export GOOGLE_CLIENT_SECRET='…'
node scripts/google-auth.mjs            # prints a URL
```

Open the URL, sign in as the account that owns the calendar, approve. The
browser will fail to load `http://localhost/?code=…` — that is expected, nothing
is listening there. Copy the `code` value out of the address bar and run:

```bash
node scripts/google-auth.mjs '4/0AX4…'  # prints GOOGLE_REFRESH_TOKEN=…
```

The scope requested is `calendar.events` only — enough to create events, not
enough to delete a calendar.

**5. Find the calendar id.**
In Google Calendar, hover the calendar in the left sidebar → **⋮ → Settings and
sharing → Integrate calendar → Calendar ID**. For a shared family calendar it
looks like `…@group.calendar.google.com`. Use that, not `primary`, unless you
really do want these landing in your personal calendar.

**6. Store the four secrets.** GitHub → repo **Settings → Secrets and variables
→ Actions → New repository secret**, one for each. Optionally add the same four
to `.env` locally.

## Check it works

```bash
# nothing leaves the machine — just shows what would be sent
node scripts/calendar-add.mjs --dry-run <<< '[{"summary":"test","date":"2026-12-25"}]'

# for real; then delete the event from your calendar
node scripts/calendar-add.mjs <<< '[{"summary":"test","date":"2026-12-25"}]'

# run it a second time — it should report skipped: ["test"], not create a duplicate
node scripts/calendar-add.mjs <<< '[{"summary":"test","date":"2026-12-25"}]'
```

That third command is the one worth running. A monthly routine re-runs and
search results repeat, so every event carries a private `lifeVaultKey` property
derived from its title and date, and the calendar is checked for that key before
inserting. Without it, "find events every month" becomes "add August again every
month".

## Exit codes

`calendar-add.mjs` distinguishes three outcomes on purpose, because a routine
has to report them differently:

| Code | Meaning |
|---|---|
| `0` | created, or already present |
| `3` | not configured — a credential is unset. Expected, not an alarm |
| `1` | configured but broken — say so loudly |

The most likely cause of a sudden `1` after months of working is
`invalid_grant`: the refresh token was revoked or expired. Revisit step 2 (is
the app still *In production*?), then regenerate with step 4. Changing your
Google password revokes it too.
