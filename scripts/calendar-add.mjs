#!/usr/bin/env node
/**
 * Add events to Google Calendar. The vault's only WRITE path to a calendar —
 * everything else here (CAL_WORK, CAL_PERSONAL, CAL_FAMILY, the dashboard
 * agenda, fetch-calendar.mjs) is a read-only .ics subscription.
 *
 *   node scripts/calendar-add.mjs events.json
 *   echo '[{...}]' | node scripts/calendar-add.mjs
 *   node scripts/calendar-add.mjs events.json --dry-run
 *
 * Input is a JSON array. Each event:
 *
 *   {
 *     "summary":     "Wimpole Estate: Farm Festival",   // required
 *     "date":        "2026-08-16",                      // all-day; or use start/end
 *     "start":       "2026-08-16T10:00:00",             // optional timed form
 *     "end":         "2026-08-16T15:00:00",
 *     "location":    "Wimpole Estate, Arrington, SG8 0BW",
 *     "description": "From £8, free for members. https://…"
 *   }
 *
 * Env (all four required; see docs/google-calendar.md for how to get them):
 *   GOOGLE_CLIENT_ID       OAuth client id
 *   GOOGLE_CLIENT_SECRET   OAuth client secret
 *   GOOGLE_REFRESH_TOKEN   long-lived refresh token for Ben's account
 *   GOOGLE_CALENDAR_ID     which calendar to write to (e.g. the family one).
 *                          "primary" is accepted but rarely what you want.
 *
 * IDEMPOTENCY. A monthly routine re-runs, and search results repeat. Every
 * event written carries a private extended property `lifeVaultKey`, derived
 * from its title and date, and the calendar is queried for that key before
 * inserting. Re-running the same month is therefore safe and adds nothing —
 * without this, "find events every month" quietly becomes "duplicate August
 * every month".
 *
 * Exit codes, because the caller needs to tell these apart:
 *   0  everything created or already present
 *   3  not configured (a credential is missing) — NOT a failure to shout about
 *   1  configured, but something went wrong — this one is loud
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// .env at the vault root, so a desktop run needs no exported variables (same
// convention as fetch-calendar.mjs).
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* no .env is fine — CI supplies real env vars */ }

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--"));

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

function out(obj) { console.log(JSON.stringify(obj, null, 2)); }
function die(code, error, extra = {}) { out({ ok: false, error, ...extra }); process.exit(code); }

/* ------------------------------------------------------------------- input */

let raw;
try {
  raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
} catch (e) {
  die(1, `could not read events: ${e.message}`);
}
let events;
try {
  events = JSON.parse(raw);
} catch (e) {
  die(1, `events input is not valid JSON: ${e.message}`);
}
if (!Array.isArray(events)) die(1, "events input must be a JSON array");
if (!events.length) { out({ ok: true, created: 0, skipped: 0, note: "no events supplied" }); process.exit(0); }

// Validate before touching the network — a half-written month is worse than a
// refusal, and the caller is an LLM that can and will hand over a malformed date.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
for (const [i, e] of events.entries()) {
  if (!e || typeof e.summary !== "string" || !e.summary.trim()) die(1, `event ${i}: missing summary`);
  if (e.date != null && !DATE_RE.test(e.date)) die(1, `event ${i}: date must be YYYY-MM-DD, got ${JSON.stringify(e.date)}`);
  if (e.date == null && !(e.start && e.end)) die(1, `event ${i}: needs either "date" or both "start" and "end"`);
}

// A stable identity for an event: what it is, and when. Re-running the routine
// must recognise the same event, so this must not include anything volatile
// like the description or the price.
const keyFor = (e) =>
  createHash("sha256")
    .update(`${e.summary.trim().toLowerCase()}|${e.date || e.start}`)
    .digest("hex")
    .slice(0, 32);

const body = (e) => {
  const b = {
    summary: e.summary.trim(),
    extendedProperties: { private: { lifeVaultKey: keyFor(e), lifeVaultSource: e.source || "family-events" } },
  };
  if (e.location) b.location = e.location;
  if (e.description) b.description = e.description;
  if (e.date) {
    // All-day. Google's `end.date` is exclusive, so a single day ends the next.
    const next = new Date(`${e.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    b.start = { date: e.date };
    b.end = { date: next.toISOString().slice(0, 10) };
  } else {
    b.start = { dateTime: e.start, timeZone: process.env.TZ_NAME || "Europe/London" };
    b.end = { dateTime: e.end, timeZone: process.env.TZ_NAME || "Europe/London" };
  }
  return b;
};

if (dryRun) {
  out({ ok: true, dryRun: true, calendar: CALENDAR_ID || "(unset)", events: events.map(body) });
  process.exit(0);
}

/* ------------------------------------------------------------------- auth */

// Exit 3, distinctly: "you have not set this up" is a different message from
// "this is broken", and the skill is told to report them differently.
const missing = Object.entries({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN, GOOGLE_CALENDAR_ID: CALENDAR_ID })
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  die(3, `Google Calendar write is not configured: ${missing.join(", ")} unset. See docs/google-calendar.md.`, { configured: false });
}

async function accessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    // invalid_grant means the refresh token is revoked or expired — a real
    // human action, so name it rather than printing a bare 400.
    const hint = j.error === "invalid_grant"
      ? " (the refresh token has been revoked or expired — generate a new one)" : "";
    throw new Error(`token refresh failed: ${r.status} ${j.error || ""}${hint}`);
  }
  return j.access_token;
}

const CAL = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;

async function alreadyThere(token, key) {
  const url = `${CAL}?privateExtendedProperty=${encodeURIComponent(`lifeVaultKey=${key}`)}&maxResults=1&showDeleted=false`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`lookup failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return (j.items || []).length > 0;
}

async function insert(token, e) {
  const r = await fetch(CAL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body(e)),
  });
  if (!r.ok) throw new Error(`insert "${e.summary}" failed: ${r.status} ${await r.text()}`);
  return r.json();
}

/* ------------------------------------------------------------------- main */

let token;
try {
  token = await accessToken();
} catch (e) {
  die(1, String(e.message || e), { configured: true });
}

const created = [];
const skipped = [];
const failed = [];
for (const e of events) {
  try {
    if (await alreadyThere(token, keyFor(e))) { skipped.push(e.summary); continue; }
    const made = await insert(token, e);
    created.push({ summary: e.summary, date: e.date || e.start, link: made.htmlLink });
  } catch (err) {
    // Keep going: one bad event must not cost the rest of the month.
    failed.push({ summary: e.summary, error: String(err.message || err) });
  }
}

out({ ok: failed.length === 0, calendar: CALENDAR_ID, created, skipped, failed });
process.exit(failed.length ? 1 : 0);
