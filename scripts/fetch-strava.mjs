#!/usr/bin/env node
/**
 * Print recent runs as JSON, for the harvest skill.
 *
 *   node scripts/fetch-strava.mjs           # last 14 days
 *   node scripts/fetch-strava.mjs 30        # last 30 days
 *
 * Garmin has no free personal API — the Health API is a partner programme and
 * personal applications are routinely refused. Garmin Connect does have a
 * built-in auto-sync to Strava, and Strava's API is free, official, OAuth-based
 * and documented. So the watch syncs to Strava and the vault reads Strava, and
 * no Garmin password is stored anywhere.
 *
 * Env (see docs/strava.md):
 *   STRAVA_CLIENT_ID       from the Strava API application page
 *   STRAVA_CLIENT_SECRET   ditto
 *   STRAVA_REFRESH_TOKEN   long-lived, with the activity:read_all scope
 *
 * Exit codes match calendar-add.mjs, because the caller has to tell them apart:
 *   0  ran fine (zero runs is a valid, quiet answer)
 *   3  not configured — a credential is unset. Expected, not an alarm
 *   1  configured but broken — this one is loud
 *
 * WHY THE WEEKLY TOTALS ARE HERE. Ben has had three injuries since restarting
 * running (Achilles, knees, ankle) and a half-marathon goal. The single most
 * useful thing this can say is not "you ran 5k" — it is how this week's volume
 * compares to last week's, because ramping too fast is the thing that keeps
 * costing him three weeks off. Reported as a number, never as advice.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// .env at the vault root, so a desktop run needs no exported variables.
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* no .env is fine — CI supplies real env vars */ }

/* --------------------------------------------------------------- shaping */

// Strava calls a lot of things a run. All of these are feet on ground.
const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

const km = (m) => Math.round((m / 1000) * 10) / 10;

/** Pace as mm:ss per km — the number a runner actually reads. */
export function pace(meters, seconds) {
  if (!meters || !seconds) return null;
  const secPerKm = seconds / (meters / 1000);
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Turn Strava's activity list into the shape the vault wants, plus the
 * week-on-week comparison. Pure, so it can be tested without the network.
 *
 * `todayISO` is passed in rather than read from the clock so the tests are not
 * a lottery.
 */
export function summariseRuns(activities, todayISO) {
  const runs = (activities || [])
    .filter((a) => RUN_TYPES.has(a.sport_type || a.type))
    .map((a) => ({
      id: a.id,
      date: String(a.start_date_local || "").slice(0, 10),
      name: a.name || "Run",
      km: km(a.distance),
      minutes: Math.round((a.moving_time || 0) / 60),
      pace: pace(a.distance, a.moving_time),
      elevation: Math.round(a.total_elevation_gain || 0),
      avgHr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      maxHr: a.max_heartrate ? Math.round(a.max_heartrate) : null,
    }))
    .filter((r) => r.date)
    .sort((a, b) => b.date.localeCompare(a.date));

  const day = (n) => {
    const d = new Date(`${todayISO}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const inRange = (from, to) => runs.filter((r) => r.date > from && r.date <= to);
  const thisWeek = inRange(day(-7), day(0));
  const lastWeek = inRange(day(-14), day(-7));

  const sum = (rs) => Math.round(rs.reduce((n, r) => n + r.km, 0) * 10) / 10;
  const thisKm = sum(thisWeek);
  const lastKm = sum(lastWeek);

  // Only meaningful with a real base to compare against — a jump from 2km to
  // 4km is 100% and means nothing.
  const changePct = lastKm >= 5 ? Math.round(((thisKm - lastKm) / lastKm) * 100) : null;

  return {
    runs,
    weeks: {
      thisWeek: { runs: thisWeek.length, km: thisKm },
      lastWeek: { runs: lastWeek.length, km: lastKm },
      changePct,
      // A statement of fact, for the skill to report. Not a recommendation, and
      // deliberately not a warning — the vault does not do sports medicine.
      note: changePct != null && changePct >= 25
        ? `weekly distance up ${changePct}% on last week (${lastKm}km → ${thisKm}km)`
        : null,
    },
  };
}

/* ------------------------------------------------------------------- main */

// Only when run directly. Importing this for `summariseRuns` (the tests do)
// must not fire the CLI and exit the process.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function out(o) { console.log(JSON.stringify(o, null, 2)); }
function die(code, error, extra = {}) { out({ ok: false, error, ...extra }); process.exit(code); }

if (isMain) {
const days = Math.max(1, parseInt(process.argv[2] || "14", 10));

const ID = process.env.STRAVA_CLIENT_ID;
const SECRET = process.env.STRAVA_CLIENT_SECRET;
const REFRESH = process.env.STRAVA_REFRESH_TOKEN;

const missing = Object.entries({ STRAVA_CLIENT_ID: ID, STRAVA_CLIENT_SECRET: SECRET, STRAVA_REFRESH_TOKEN: REFRESH })
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  die(3, `Strava is not configured: ${missing.join(", ")} unset. See docs/strava.md.`, { configured: false, runs: [] });
}

let token, rotated = null;
try {
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ID, client_secret: SECRET,
      grant_type: "refresh_token", refresh_token: REFRESH,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(`token refresh failed: ${r.status} ${j.message || j.error || ""}`.trim());
  }
  token = j.access_token;
  // Strava MAY hand back a new refresh token. Nothing here can rewrite a
  // GitHub secret, so the only honest thing to do is shout — silently carrying
  // on would work until the old token expired and then fail for a reason
  // nobody could find.
  if (j.refresh_token && j.refresh_token !== REFRESH) rotated = j.refresh_token;
} catch (e) {
  die(1, String((e && e.message) || e), { configured: true, runs: [] });
}

const after = Math.floor((Date.now() - days * 864e5) / 1000);
let activities;
try {
  const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 429) throw new Error("rate limited by Strava (100 requests per 15 min) — try later");
  if (!r.ok) throw new Error(`activities: ${r.status} ${(await r.text()).slice(0, 160)}`);
  activities = await r.json();
} catch (e) {
  die(1, String((e && e.message) || e), { configured: true, runs: [] });
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.TZ_NAME || "Europe/London" }).format(new Date());
const summary = summariseRuns(activities, today);

out({
  ok: true,
  configured: true,
  from: new Date(after * 1000).toISOString().slice(0, 10),
  to: today,
  ...summary,
  // Surfaced at the top level so a skill cannot miss it.
  refreshTokenRotated: rotated
    ? "Strava issued a NEW refresh token. Update the STRAVA_REFRESH_TOKEN secret or this will stop working: " + rotated
    : null,
});
}
