/**
 * Minimal iCalendar reader — enough of RFC 5545 to read a real Outlook feed.
 *
 * Written against the actual JGC work feed rather than the spec in the
 * abstract, because that is where the awkward parts are:
 *
 *  - Times carry Windows timezone names (`TZID=GMT Standard Time`), not IANA
 *    ones, so they need mapping before Intl will touch them.
 *  - Outlook exports a modified instance of a recurring meeting as its own
 *    VEVENT with a RECURRENCE-ID. Expand the series naively and you get the
 *    original AND the moved copy — the same meeting twice, at two times.
 *  - VTIMEZONE blocks contain their own RRULEs (the DST changeover rules). Parse
 *    RRULE without tracking which component you are inside and every calendar
 *    sprouts two yearly events in March and October.
 *
 * No dependencies: this has to run in a Cloudflare Worker.
 */

// Windows timezone names → IANA. Only the ones a UK/EU calendar produces; an
// unmapped zone falls back to London rather than throwing, since a meeting an
// hour out is better than no calendar at all.
const WIN_TZ = {
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Etc/GMT",
  "Romance Standard Time": "Europe/Paris",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Helsinki",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "India Standard Time": "Asia/Kolkata",
  UTC: "UTC",
};
const DEFAULT_TZ = "Europe/London";

function ianaZone(tzid) {
  if (!tzid) return DEFAULT_TZ;
  if (WIN_TZ[tzid]) return WIN_TZ[tzid];
  // Already IANA? Let Intl decide; fall back rather than throw.
  try { new Intl.DateTimeFormat("en-US", { timeZone: tzid }); return tzid; }
  catch { return DEFAULT_TZ; }
}

// Offset of `zone` from UTC at a given instant, in ms.
function zoneOffset(utcMs, zone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - utcMs;
}

// A wall-clock time in `zone` → the UTC instant. Two passes converge across a
// DST boundary, where the first guess uses the wrong side's offset.
function wallToUTC(y, mo, d, h, mi, s, zone) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = naive;
  for (let i = 0; i < 2; i++) ms = naive - zoneOffset(ms, zone);
  return ms;
}

/* ------------------------------------------------------------------ parsing */

// Unfold continuation lines (a leading space/tab continues the previous line).
function unfold(text) {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").replace(/\r/g, "");
}

// "DTSTART;TZID=GMT Standard Time:20260718T090000" -> { name, params, value }
function parseLine(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(";");
  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

function unescapeText(v) {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

// A DTSTART/DTEND/EXDATE value → { ms, allDay }.
function parseDate(value, params) {
  const v = value.trim();
  if (params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    const y = +v.slice(0, 4), mo = +v.slice(4, 6), d = +v.slice(6, 8);
    // All-day: anchor at local midnight so it lands on the right calendar day.
    return { ms: wallToUTC(y, mo, d, 0, 0, 0, DEFAULT_TZ), allDay: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const ms = z
    ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
    : wallToUTC(+y, +mo, +d, +h, +mi, +s, ianaZone(params.TZID));
  return { ms, allDay: false };
}

/**
 * Parse an .ics document into VEVENTs.
 * Components other than VEVENT are skipped entirely — importantly VTIMEZONE,
 * whose RRULEs describe DST changeovers and are not events.
 */
export function parseICS(text) {
  const lines = unfold(text).split("\n");
  const events = [];
  let cur = null;
  let depth = 0;          // nesting inside a non-VEVENT component we're ignoring

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line === "BEGIN:VEVENT") { cur = { exdates: [] }; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.start && cur.summary) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) {
      // Track other components so their properties never leak into an event.
      if (line.startsWith("BEGIN:")) depth++;
      else if (line.startsWith("END:")) depth = Math.max(0, depth - 1);
      continue;
    }

    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case "UID": cur.uid = p.value; break;
      case "SUMMARY": cur.summary = unescapeText(p.value).trim(); break;
      case "LOCATION": cur.location = unescapeText(p.value).trim() || null; break;
      case "STATUS": cur.status = p.value; break;
      case "DTSTART": {
        const d = parseDate(p.value, p.params);
        if (d) { cur.start = d.ms; cur.allDay = d.allDay; cur.tzid = p.params.TZID || null; }
        break;
      }
      case "DTEND": { const d = parseDate(p.value, p.params); if (d) cur.end = d.ms; break; }
      case "RRULE": cur.rrule = p.value; break;
      case "RECURRENCE-ID": { const d = parseDate(p.value, p.params); if (d) cur.recurrenceId = d.ms; break; }
      case "EXDATE":
        for (const v of p.value.split(",")) {
          const d = parseDate(v, p.params);
          if (d) cur.exdates.push(d.ms);
        }
        break;
      case "X-MICROSOFT-CDO-ALLDAYEVENT":
        if (p.value.toUpperCase() === "TRUE") cur.allDay = true;
        break;
      default: break;
    }
  }
  return events;
}

/* --------------------------------------------------------------- recurrence */

const DAY_MS = 864e5;
const BYDAY_NUM = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRule(rrule) {
  const out = {};
  for (const part of rrule.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
}

/**
 * Occurrence start times for one event within [from, to].
 * Guarded by a hard iteration cap: a malformed rule with no UNTIL or COUNT
 * must not spin a Worker until it is killed.
 */
function occurrences(ev, from, to) {
  if (!ev.rrule) return (ev.start >= from && ev.start <= to) ? [ev.start] : [];
  const r = parseRule(ev.rrule);
  const interval = Math.max(1, parseInt(r.INTERVAL || "1", 10));
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  let until = Infinity;
  if (r.UNTIL) { const d = parseDate(r.UNTIL, {}); if (d) until = d.ms; }
  const hardStop = Math.min(to, until);

  const byDay = (r.BYDAY || "").split(",").filter(Boolean)
    .map((d) => BYDAY_NUM[d.replace(/^[-+]?\d+/, "")])
    .filter((d) => d !== undefined);

  const out = [];
  let emitted = 0;
  const zone = ianaZone(ev.tzid);
  // Keep the wall-clock time of day stable across DST rather than drifting an
  // hour: rebuild each occurrence from the original local time-of-day.
  const startParts = localParts(ev.start, zone);

  const push = (ms) => {
    if (ms >= from && ms <= hardStop) out.push(ms);
  };

  let cursor = ev.start;
  for (let i = 0; i < 4000 && cursor <= hardStop && emitted < count; i++) {
    if (r.FREQ === "WEEKLY" && byDay.length) {
      // Each qualifying weekday within this week-block.
      const weekStart = cursor - ((dayOfWeek(cursor, zone) - 1 + 7) % 7) * DAY_MS;
      for (const wd of byDay) {
        const offset = (wd - 1 + 7) % 7;
        const day = weekStart + offset * DAY_MS;
        if (day < ev.start) continue;
        const p = localParts(day, zone);
        const ms = wallToUTC(p.y, p.mo, p.d, startParts.h, startParts.mi, 0, zone);
        if (ms > hardStop) break;
        if (emitted >= count) break;
        emitted++;
        push(ms);
      }
      cursor += 7 * interval * DAY_MS;
      continue;
    }

    emitted++;
    push(cursor);

    const p = localParts(cursor, zone);
    if (r.FREQ === "DAILY") cursor = wallToUTC(p.y, p.mo, p.d + interval, startParts.h, startParts.mi, 0, zone);
    else if (r.FREQ === "WEEKLY") cursor = wallToUTC(p.y, p.mo, p.d + 7 * interval, startParts.h, startParts.mi, 0, zone);
    else if (r.FREQ === "MONTHLY") cursor = wallToUTC(p.y, p.mo + interval, startParts.d, startParts.h, startParts.mi, 0, zone);
    else if (r.FREQ === "YEARLY") cursor = wallToUTC(p.y + interval, startParts.mo, startParts.d, startParts.h, startParts.mi, 0, zone);
    else break;                                   // unknown FREQ: treat as single
  }
  return out;
}

function localParts(ms, zone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}
function dayOfWeek(ms, zone) {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(new Date(ms));
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[s];
}

/**
 * Expand a parsed calendar into dated occurrences between two YYYY-MM-DD days.
 *
 * Modified instances (RECURRENCE-ID) replace the generated occurrence they
 * override, which is the difference between seeing a moved meeting once at its
 * new time and seeing it twice at two different times.
 */
export function expandEvents(events, fromDay, toDay, opts = {}) {
  const zone = opts.zone || DEFAULT_TZ;
  const from = wallToUTC(+fromDay.slice(0, 4), +fromDay.slice(5, 7), +fromDay.slice(8, 10), 0, 0, 0, zone);
  const to = wallToUTC(+toDay.slice(0, 4), +toDay.slice(5, 7), +toDay.slice(8, 10), 23, 59, 59, zone);

  // Instances that override a specific occurrence of a series.
  //
  // RFC 5545 says RECURRENCE-ID identifies the occurrence by its original start
  // instant, and matching on that alone is what you would write first. This feed
  // does not do that: Outlook emits RECURRENCE-ID at MIDNIGHT of the occurrence
  // day while DTSTART carries the real time —
  //
  //   RECURRENCE-ID;TZID=GMT Standard Time:20260721T000000
  //   DTSTART;TZID=GMT Standard Time:20260721T090000
  //
  // so an instant match never fires and every modified instance appears twice:
  // once from the series, once from the override. Match on the instant first
  // for well-formed feeds, then fall back to the local date.
  //
  // The fallback suppresses at day granularity, so a series occurring twice in
  // one day with an override on one of them would lose the other. No feed here
  // does that, and a missing duplicate beats a phantom meeting.
  const byInstant = new Set();
  const byDate = new Set();
  for (const ev of events) {
    if (ev.recurrenceId == null || !ev.uid) continue;
    byInstant.add(`${ev.uid}|${ev.recurrenceId}`);
    const p = localParts(ev.recurrenceId, zone);
    byDate.add(`${ev.uid}|${p.y}-${p.mo}-${p.d}`);
  }

  const out = [];
  const emit = (ev, startMs) => {
    if (ev.status === "CANCELLED") return;
    const p = localParts(startMs, zone);
    const dur = ev.end && ev.end > ev.start ? ev.end - ev.start : 0;
    out.push({
      uid: ev.uid || null,
      title: ev.summary,
      location: ev.location || null,
      date: `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`,
      time: ev.allDay ? null : `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`,
      allDay: !!ev.allDay,
      minutes: ev.allDay ? null : Math.round(dur / 60000),
      start: new Date(startMs).toISOString(),
    });
  };

  for (const ev of events) {
    // Overrides are emitted on their own terms, not as part of the series.
    if (ev.recurrenceId != null) {
      if (ev.start >= from && ev.start <= to) emit(ev, ev.start);
      continue;
    }
    for (const ms of occurrences(ev, from, to)) {
      if (ev.exdates.some((x) => Math.abs(x - ms) < 60000)) continue;
      if (ev.uid) {
        const p = localParts(ms, zone);
        if (byInstant.has(`${ev.uid}|${ms}`)) continue;
        if (byDate.has(`${ev.uid}|${p.y}-${p.mo}-${p.d}`)) continue;
      }
      emit(ev, ms);
    }
  }

  out.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.allDay === b.allDay ? String(a.time).localeCompare(String(b.time)) : (a.allDay ? -1 : 1))
  );
  return out;
}
