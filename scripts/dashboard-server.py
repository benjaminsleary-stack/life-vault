#!/usr/bin/env python3
"""
Life-Vault dashboard — a tiny local web server.

One file, standard library only. No framework, no build step, no service worker.
Serves a mobile-friendly page that reads the vault and lets you:
  - quick-capture a raw note into inbox/ (Claude files it later)
  - add a task directly to tasks.md (appears immediately, tickable)
  - tick/untick tasks (writes back to tasks.md with a completion date)

Run on the desktop that holds the vault:
    python scripts/dashboard-server.py
Then open http://<this-desktop-LAN-IP>:8765 from your phone (same Wi-Fi).
Set PORT with the LVDASH_PORT env var if 8765 is taken.
"""

import os
import re
import json
import zlib
import random
import string
import datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

VAULT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("LVDASH_PORT", "8765"))
TASKS_FILE = os.path.join(VAULT, "tasks.md")

DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
DUE_RE = re.compile(r"\U0001F4C5\s*(\d{4}-\d{2}-\d{2})")          # 📅 YYYY-MM-DD
DONE_RE = re.compile(r"✅\s*(\d{4}-\d{2}-\d{2})")            # ✅ YYYY-MM-DD
TAG_RE = re.compile(r"(?<!\S)#([A-Za-z0-9_/-]+)")
TASK_RE = re.compile(r"^(\s*)- \[( |x|X)\]\s+(.*)$")
OCCASION_RE = re.compile(r"\(occasion::\s*(\d{4}-\d{2}-\d{2})\)\s*(.*)")


def today():
    return dt.date.today().isoformat()


def core_text(text):
    """Task text stripped of due/done stamps and tags, used as a stable id."""
    t = DUE_RE.sub("", text)
    t = DONE_RE.sub("", t)
    t = TAG_RE.sub("", t)
    return " ".join(t.split()).strip().lower()


def task_id(text):
    # zlib.crc32, not hash(): str hashes are salted per process, so ids from
    # before a server restart would stop matching and toggles would no-op.
    core = core_text(text)
    return str(zlib.crc32(core.encode("utf-8")))


def read_tasks():
    if not os.path.exists(TASKS_FILE):
        return []
    out = []
    with open(TASKS_FILE, encoding="utf-8") as f:
        for line in f.read().split("\n"):
            m = TASK_RE.match(line)
            if not m:
                continue
            checked = m.group(2).lower() == "x"
            body = m.group(3)
            due_m = DUE_RE.search(body)
            due = due_m.group(1) if due_m else None
            tags = TAG_RE.findall(body)
            # display text: drop the stamps/tags for a clean label
            label = DUE_RE.sub("", body)
            label = DONE_RE.sub("", label)
            label = TAG_RE.sub("", label)
            label = re.sub(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", r"\1", label)  # wikilinks
            label = " ".join(label.split()).strip()
            overdue = bool(due and not checked and due <= today())
            out.append({
                "id": task_id(body),
                "text": label,
                "done": checked,
                "due": due,
                "tags": tags,
                "overdue": overdue,
            })
    return out


def toggle_task(tid):
    if not os.path.exists(TASKS_FILE):
        return False
    with open(TASKS_FILE, encoding="utf-8") as f:
        lines = f.read().split("\n")
    changed = False
    for i, line in enumerate(lines):
        m = TASK_RE.match(line)
        if not m or task_id(m.group(3)) != tid:
            continue
        indent, state, body = m.group(1), m.group(2), m.group(3)
        if state.lower() == "x":
            body = DONE_RE.sub("", body).rstrip()
            lines[i] = f"{indent}- [ ] {body}"
        else:
            body = body.rstrip() + f" ✅ {today()}"
            lines[i] = f"{indent}- [x] {body}"
        changed = True
        break
    if changed:
        with open(TASKS_FILE, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    return changed


def add_task(text, due, tag):
    text = text.strip()
    if not text:
        return False
    line = f"- [ ] {text}"
    if tag:
        tag = tag.lstrip("#").strip()
        if tag:
            line += f" #{tag}"
    if due and DATE_RE.fullmatch(due.strip()):
        line += f" \U0001F4C5 {due.strip()}"
    content = ""
    if os.path.exists(TASKS_FILE):
        with open(TASKS_FILE, encoding="utf-8") as f:
            content = f.read().rstrip("\n")
    else:
        content = "# Tasks"
    content += "\n" + line + "\n"
    with open(TASKS_FILE, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def capture(text):
    text = text.strip()
    if not text:
        return False
    os.makedirs(os.path.join(VAULT, "inbox"), exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%dT%H%M%S")
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    path = os.path.join(VAULT, "inbox", f"{stamp}-{rand}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    return True


def _frontmatter_and_summary(path):
    name, tags, updated, summary = None, [], None, ""
    try:
        with open(path, encoding="utf-8") as f:
            txt = f.read()
    except OSError:
        return name, tags, updated, summary
    fm = re.match(r"^---\n(.*?)\n---\n", txt, re.S)
    if fm:
        block = fm.group(1)
        nm = re.search(r"^name:\s*(.+)$", block, re.M)
        name = nm.group(1).strip() if nm else None
        tm = re.search(r"^tags:\s*\[(.*?)\]", block, re.M)
        if tm:
            tags = [t.strip() for t in tm.group(1).split(",") if t.strip()]
        um = re.search(r"^updated:\s*(.+)$", block, re.M)
        updated = um.group(1).strip() if um else None
    sm = re.search(r"## What to know\s*\n(.+)", txt)
    if sm:
        summary = sm.group(1).strip()
    return name, tags, updated, summary


def read_entities(folder):
    d = os.path.join(VAULT, folder)
    items = []
    if not os.path.isdir(d):
        return items
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".md") or fn.startswith("_"):
            continue
        name, tags, updated, summary = _frontmatter_and_summary(os.path.join(d, fn))
        items.append({
            "name": name or fn[:-3],
            "tags": tags,
            "updated": updated,
            "summary": summary,
        })
    return items


def read_occasions():
    d = os.path.join(VAULT, "people")
    out = []
    if not os.path.isdir(d):
        return out
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".md"):
            continue
        try:
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                txt = f.read()
        except OSError:
            continue
        for m in OCCASION_RE.finditer(txt):
            date, label = m.group(1), m.group(2).strip()
            if date >= today():
                out.append({"date": date, "text": label})
    out.sort(key=lambda x: x["date"])
    return out


def latest_brief():
    d = os.path.join(VAULT, "digests")
    if not os.path.isdir(d):
        return None
    files = [f for f in os.listdir(d) if f.endswith(".md")]
    if not files:
        return None
    newest = sorted(files)[-1]
    try:
        with open(os.path.join(d, newest), encoding="utf-8") as f:
            return {"name": newest, "text": f.read()}
    except OSError:
        return None


def build_data():
    return {
        "generated": dt.datetime.now().strftime("%a %d %b %H:%M"),
        "tasks": read_tasks(),
        "projects": read_entities("projects"),
        "people": read_entities("people"),
        "occasions": read_occasions(),
        "brief": latest_brief(),
    }


PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111417">
<link rel="manifest" href="/manifest.json">
<title>Life-Vault</title>
<style>
  :root{--bg:#0f1216;--card:#181c22;--line:#272d36;--txt:#e7ebf0;--mut:#9aa4b2;--acc:#5b9dff;--ok:#4ec97a;--warn:#e0a33a;--danger:#e5675f}
  @media (prefers-color-scheme: light){:root{--bg:#f4f6f9;--card:#fff;--line:#e2e6ec;--txt:#1a1f26;--mut:#69727f;--acc:#2f6fe0;--ok:#1f9d54;--warn:#b8791a;--danger:#c9433a}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px;max-width:720px;margin:0 auto}
  h1{font-size:19px;margin:4px 0 2px}
  .sub{color:var(--mut);font-size:13px;margin-bottom:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:14px}
  h2{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);margin:0 0 10px}
  textarea,input[type=text],input[type=date]{width:100%;background:var(--bg);color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:11px;font:inherit}
  textarea{min-height:64px;resize:vertical}
  .row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
  .row>*{flex:1;min-width:120px}
  button{background:var(--acc);color:#fff;border:0;border-radius:10px;padding:11px 14px;font:inherit;font-weight:600;cursor:pointer}
  button.ghost{background:transparent;color:var(--acc);border:1px solid var(--line)}
  .task{display:flex;align-items:flex-start;gap:11px;padding:9px 0;border-bottom:1px solid var(--line)}
  .task:last-child{border-bottom:0}
  .task input{width:22px;height:22px;margin-top:1px;accent-color:var(--ok);flex:none}
  .task .lbl{flex:1}
  .task.done .lbl{color:var(--mut);text-decoration:line-through}
  .meta{font-size:12px;color:var(--mut)}
  .pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:20px;border:1px solid var(--line);color:var(--mut);margin-left:6px}
  .pill.over{color:var(--danger);border-color:var(--danger)}
  .ent{padding:8px 0;border-bottom:1px solid var(--line)}
  .ent:last-child{border-bottom:0}
  .ent b{font-weight:600}
  .ent .s{font-size:13px;color:var(--mut);margin-top:2px}
  pre{white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace;color:var(--txt);margin:0}
  .toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--ok);color:#04120a;padding:9px 16px;border-radius:20px;font-weight:600;opacity:0;transition:.2s;pointer-events:none}
  .toast.show{opacity:1}
  .muted{color:var(--mut)}
</style>
</head>
<body>
<h1>Life-Vault</h1>
<div class="sub" id="gen">loading…</div>

<div class="card">
  <h2>Quick capture</h2>
  <textarea id="cap" placeholder="Dump a thought, note or 'done: ...'. Saved raw to inbox/ for Claude to file."></textarea>
  <div class="row"><button onclick="capture()">Capture to inbox</button></div>
</div>

<div class="card">
  <h2>Add task</h2>
  <input type="text" id="ttext" placeholder="What needs doing">
  <div class="row">
    <input type="date" id="tdue">
    <input type="text" id="ttag" placeholder="#area (house, work…)">
  </div>
  <div class="row"><button onclick="addTask()">Add to task list</button></div>
</div>

<div class="card">
  <h2>Due &amp; overdue</h2>
  <div id="due"></div>
</div>

<div class="card">
  <h2>Open tasks</h2>
  <div id="open"></div>
</div>

<div class="card">
  <h2>Upcoming</h2>
  <div id="occ"></div>
</div>

<div class="card">
  <h2>Projects</h2>
  <div id="proj"></div>
</div>

<div class="card">
  <h2>People</h2>
  <div id="ppl"></div>
</div>

<div class="card">
  <h2>Latest brief</h2>
  <pre id="brief" class="muted">—</pre>
</div>

<div class="toast" id="toast"></div>

<script>
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},1400)}
function esc(s){return (s||'').replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function taskRow(t){
  var pills='';
  if(t.due) pills+='<span class="pill'+(t.overdue?' over':'')+'">'+t.due+'</span>';
  (t.tags||[]).forEach(function(g){pills+='<span class="pill">#'+esc(g)+'</span>'});
  return '<div class="task'+(t.done?' done':'')+'">'+
    '<input type="checkbox" '+(t.done?'checked':'')+' onchange="toggle(\''+t.id+'\')">'+
    '<div class="lbl">'+esc(t.text)+pills+'</div></div>';
}
function render(d){
  document.getElementById('gen').textContent='Updated '+d.generated;
  var due=d.tasks.filter(function(t){return t.overdue});
  var open=d.tasks.filter(function(t){return !t.done && !t.overdue});
  document.getElementById('due').innerHTML=due.length?due.map(taskRow).join(''):'<div class="muted">Nothing due. Nice.</div>';
  document.getElementById('open').innerHTML=open.length?open.map(taskRow).join(''):'<div class="muted">No open tasks.</div>';
  document.getElementById('occ').innerHTML=d.occasions.length?d.occasions.map(function(o){return '<div class="ent"><b>'+o.date+'</b> — '+esc(o.text)+'</div>'}).join(''):'<div class="muted">—</div>';
  document.getElementById('proj').innerHTML=d.projects.map(function(p){return '<div class="ent"><b>'+esc(p.name)+'</b><div class="s">'+esc(p.summary)+'</div></div>'}).join('')||'<div class="muted">—</div>';
  document.getElementById('ppl').innerHTML=d.people.map(function(p){return '<div class="ent"><b>'+esc(p.name)+'</b><div class="s">'+esc(p.summary)+'</div></div>'}).join('')||'<div class="muted">—</div>';
  document.getElementById('brief').textContent=d.brief?d.brief.text:'—';
}
function load(){fetch('/api/data').then(function(r){return r.json()}).then(render).catch(function(){toast('Load failed')})}
function post(url,body,msg){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(){toast(msg);load()})}
function capture(){var e=document.getElementById('cap');if(!e.value.trim())return;post('/api/capture',{text:e.value},'Captured').then(function(){e.value=''})}
function addTask(){var t=document.getElementById('ttext');if(!t.value.trim())return;post('/api/task',{text:t.value,due:document.getElementById('tdue').value,tag:document.getElementById('ttag').value},'Task added').then(function(){t.value='';document.getElementById('tdue').value='';document.getElementById('ttag').value=''})}
function toggle(id){post('/api/toggle',{id:id},'Updated')}
load();
setInterval(load,60000);
</script>
</body>
</html>"""

MANIFEST = {
    "name": "Life-Vault", "short_name": "Vault",
    "start_url": "/", "display": "standalone",
    "background_color": "#0f1216", "theme_color": "#111417",
    "icons": [],
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            self._send(200, PAGE, "text/html; charset=utf-8")
        elif path == "/manifest.json":
            self._send(200, json.dumps(MANIFEST))
        elif path == "/api/data":
            self._send(200, json.dumps(build_data()))
        else:
            self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or "{}")
        except json.JSONDecodeError:
            payload = {}
        ok = False
        if path == "/api/capture":
            ok = capture(payload.get("text", ""))
        elif path == "/api/task":
            ok = add_task(payload.get("text", ""), payload.get("due", ""), payload.get("tag", ""))
        elif path == "/api/toggle":
            ok = toggle_task(str(payload.get("id", "")))
        else:
            return self._send(404, json.dumps({"error": "not found"}))
        self._send(200, json.dumps({"ok": ok}))


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Life-Vault dashboard on http://0.0.0.0:{PORT}  (vault: {VAULT})")
    print("Open http://<this-desktop-LAN-IP>:%d from your phone on the same Wi-Fi." % PORT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
