#!/usr/bin/env python3
"""Fetch the last 24h of Gmail inbox over IMAP (app-password auth), write bodies +
attachments to scripts/_work/ (git-ignored), and print a JSON manifest to stdout.

Read-only. No OAuth: uses GMAIL_ADDRESS + GMAIL_APP_PASSWORD (needs 2FA enabled on
the Google account). The routine reads the manifest, then reads the body/PDF files.

Env: GMAIL_ADDRESS, GMAIL_APP_PASSWORD, optional MAIL_SINCE_HOURS (default 24).
Deps: imap-tools  (installed by scripts/setup.sh).
"""
import base64
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

def main() -> int:
    addr = os.environ.get("GMAIL_ADDRESS")
    pw = os.environ.get("GMAIL_APP_PASSWORD")
    if not addr or not pw:
        print(json.dumps({"error": "GMAIL_ADDRESS / GMAIL_APP_PASSWORD not set", "messages": []}))
        return 1
    hours = int(os.environ.get("MAIL_SINCE_HOURS", "24"))

    try:
        from imap_tools import MailBox, AND
    except ImportError:
        print(json.dumps({"error": "imap-tools not installed (run scripts/setup.sh)", "messages": []}))
        return 1

    work = Path(__file__).resolve().parent / "_work"
    work.mkdir(exist_ok=True)
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).date()

    out = []
    try:
        with MailBox("imap.gmail.com").login(addr, pw, initial_folder="INBOX") as mb:
            for msg in mb.fetch(AND(date_gte=since), reverse=True, mark_seen=False, bulk=True):
                mid = (msg.headers.get("message-id", ("",))[0] or msg.uid or "").strip("<>")
                slug = base64.urlsafe_b64encode((mid or msg.uid or "x").encode()).decode()[:24]
                body = (msg.text or msg.html or "").strip()
                body_path = work / f"{slug}.body.txt"
                body_path.write_text(body[:20000], encoding="utf-8")
                atts = []
                for att in msg.attachments:
                    safe = "".join(c for c in (att.filename or "attachment") if c.isalnum() or c in "._- ")
                    p = work / f"{slug}__{safe}"
                    p.write_bytes(att.payload)
                    atts.append({"filename": att.filename, "path": str(p), "content_type": att.content_type})
                out.append({
                    "message_id": mid,
                    "from": msg.from_,
                    "subject": msg.subject,
                    "date": msg.date.isoformat() if msg.date else "",
                    "body_path": str(body_path),
                    "attachments": atts,
                    "gmail_link": f"https://mail.google.com/mail/u/0/#search/rfc822msgid:{mid}" if mid else "",
                })
    except Exception as e:  # noqa: BLE001 — surface the reason for the caller's assertion
        print(json.dumps({"error": f"IMAP fetch failed: {e}", "messages": []}))
        return 1

    print(json.dumps({"count": len(out), "messages": out}, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
