#!/usr/bin/env node
/**
 * One-off helper: turn a Strava API application into a refresh token for
 * scripts/fetch-strava.mjs. Run it twice — once for the consent URL, once with
 * the code Strava hands back.
 *
 *   # 1. print the URL to open in a browser
 *   STRAVA_CLIENT_ID=… node scripts/strava-auth.mjs
 *
 *   # 2. exchange the code from the redirect
 *   STRAVA_CLIENT_ID=… STRAVA_CLIENT_SECRET=… node scripts/strava-auth.mjs <code>
 *
 * Full setup, including the one setting that will otherwise silently hide every
 * private run, is in docs/strava.md.
 *
 * Nothing is written to disk. The token is printed once, to paste into GitHub
 * Actions secrets and .env. Treat it as a password.
 */

const ID = process.env.STRAVA_CLIENT_ID;
const SECRET = process.env.STRAVA_CLIENT_SECRET;
// activity:read_all, not activity:read. The narrower scope silently omits any
// activity marked private, and a run you forgot was private just never appears —
// which looks exactly like the integration being broken.
const SCOPE = "activity:read_all";
const REDIRECT = "http://localhost/exchange_token";

if (!ID) {
  console.error("Set STRAVA_CLIENT_ID first — see docs/strava.md.");
  process.exit(3);
}

const code = process.argv[2];

if (!code) {
  const url = "https://www.strava.com/oauth/authorize?" + new URLSearchParams({
    client_id: ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    approval_prompt: "force",     // always re-consent, so a token is always issued
    scope: SCOPE,
  });
  console.log(`
1. Open this in a browser, signed in as yourself:

${url}

2. Approve it — make sure the "View data about your private activities" box is
   ticked, or private runs will silently never appear.

3. The browser will fail to load http://localhost/exchange_token?...&code=…
   That is expected; nothing is listening. Copy the value of "code" out of the
   address bar (between "code=" and the next "&").

4. Run this again with that code, in THIS SAME terminal — the client id and
   secret are already set here:

   node scripts/strava-auth.mjs <the code>
`);
  process.exit(0);
}

if (!SECRET) {
  console.error("Set STRAVA_CLIENT_SECRET too for the exchange step.");
  process.exit(3);
}

const r = await fetch("https://www.strava.com/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: ID, client_secret: SECRET, code, grant_type: "authorization_code" }),
});
const j = await r.json().catch(() => ({}));

if (!r.ok || !j.refresh_token) {
  console.error(`Exchange failed: ${r.status} ${j.message || j.error || ""}`);
  if (String(j.message || "").toLowerCase().includes("invalid")) {
    console.error("An authorisation code is single-use and expires quickly — get a fresh one by running this with no argument again.");
  }
  process.exit(1);
}

const granted = String(j.scope || "");
console.log(`
STRAVA_REFRESH_TOKEN=${j.refresh_token}

Granted scope: ${granted || "(not reported)"}`);
if (granted && !granted.includes("activity:read_all")) {
  console.log(`
WARNING: activity:read_all was NOT granted. Private activities will be invisible
and there will be no error to tell you so. Re-run this and tick the private
activities box.`);
}
console.log(`
Store it as a GitHub Actions secret (and in .env for desktop runs), alongside
STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.

Check it end to end:
  node scripts/fetch-strava.mjs 30
`);
