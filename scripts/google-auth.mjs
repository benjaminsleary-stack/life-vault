#!/usr/bin/env node
/**
 * One-off helper: turn a Google OAuth client into a refresh token for
 * scripts/calendar-add.mjs. Run it twice — once to get the consent URL, once
 * with the code Google hands back.
 *
 *   # 1. print the URL to open in a browser
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google-auth.mjs
 *
 *   # 2. exchange the code from the redirect for a refresh token
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google-auth.mjs 4/0AX4…
 *
 * The full setup, including where to get the client id and secret and the one
 * trap that will otherwise cost you a week, is in docs/google-calendar.md.
 *
 * Nothing is written to disk: the token is printed once, for you to paste into
 * GitHub Actions secrets and .env. It is a credential with write access to your
 * calendar — treat it like a password and never commit it.
 */

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Narrowest scope that can create events. NOT calendar.readonly (can't write),
// and NOT the full calendar scope (can delete calendars, which this never needs).
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const REDIRECT = "http://localhost";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first — see docs/google-calendar.md.");
  process.exit(3);
}

const code = process.argv[2];

if (!code) {
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    // Both are required to be handed a refresh token: offline asks for one,
    // and consent forces a fresh one even if you have authorised before —
    // without it a second run silently returns no refresh_token at all.
    access_type: "offline",
    prompt: "consent",
  });
  console.log(`
1. Open this in a browser, signed in as the account that owns the calendar:

${url}

2. Approve it. The browser will fail to load a page at http://localhost/?code=…
   — that is expected, nothing is listening. Copy the value of "code" out of
   the address bar (everything between "code=" and the next "&").

3. Run this again with that code as the argument:

   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google-auth.mjs <code>
`);
  process.exit(0);
}

const r = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT, grant_type: "authorization_code",
  }),
});
const j = await r.json().catch(() => ({}));

if (!r.ok) {
  console.error(`Exchange failed: ${r.status} ${j.error || ""} ${j.error_description || ""}`);
  if (j.error === "invalid_grant") {
    console.error("An authorisation code is single-use and expires in minutes — get a fresh one by running this with no argument again.");
  }
  process.exit(1);
}
if (!j.refresh_token) {
  console.error("Google returned no refresh_token. That happens when the account has already granted this client and consent wasn't forced — run this with no argument again (it sends prompt=consent), and re-approve.");
  process.exit(1);
}

console.log(`
GOOGLE_REFRESH_TOKEN=${j.refresh_token}

Store that as a GitHub Actions secret (and in .env for desktop runs), alongside
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALENDAR_ID.

Check it end to end before relying on it:
  node scripts/calendar-add.mjs --dry-run <<< '[{"summary":"test","date":"2026-12-25"}]'
then drop --dry-run to write a real event, and delete it from the calendar.
`);
