#!/usr/bin/env python3
"""Fetch a Google Calendar private .ics feed and print today's + tomorrow's events
as JSON. Read-only, unauthenticated URL held in the ICS_URL env var.

Env: ICS_URL, optional TZ (default Europe/London).
Deps: icalendar, requests  (installed by scripts/setup.sh).
"""
import json
import os
import sys
from datetime import date, datetime, timedelta

def _as_date(v):
    if isinstance(v, datetime):
        return v.date()
    return v

def main() -> int:
    url = os.environ.get("ICS_URL")
    if not url:
        print(json.dumps({"error": "ICS_URL not set", "events": []}))
        return 1
    try:
        import requests
        from icalendar import Calendar
    except ImportError:
        print(json.dumps({"error": "icalendar/requests not installed (run scripts/setup.sh)", "events": []}))
        return 1

    try:
        raw = requests.get(url, timeout=20).content
        cal = Calendar.from_ical(raw)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"ICS fetch/parse failed: {e}", "events": []}))
        return 1

    today = date.today()
    window = {today, today + timedelta(days=1)}
    events = []
    for comp in cal.walk("VEVENT"):
        start = comp.get("dtstart")
        if not start:
            continue
        sd = _as_date(start.dt)
        if sd in window:
            st = start.dt
            events.append({
                "date": sd.isoformat(),
                "when": "today" if sd == today else "tomorrow",
                "time": st.strftime("%H:%M") if isinstance(st, datetime) else "all-day",
                "title": str(comp.get("summary", "(no title)")),
                "location": str(comp.get("location", "")) or None,
            })
    events.sort(key=lambda e: (e["date"], e["time"]))
    print(json.dumps({"count": len(events), "events": events}, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
