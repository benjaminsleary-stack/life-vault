#!/usr/bin/env node
// Migrate a life-os brain into this vault as markdown.
//
// Two sources:
//   node scripts/migrate-from-life-os.mjs --base https://<app> --token <t> --out .
//   node scripts/migrate-from-life-os.mjs --export ./life-brain-export.json --out .
//        [--profile ./profile.json] [--lessons ./lessons.json]
//
// Run it where the network reaches your app (laptop/browser) — this session's
// sandbox can't. It writes people/ projects/ notes/ tasks.md _meta/{identity,lessons}
// and a MIGRATION-REPORT.md flagging things a human must eyeball (spec §10).
//
// Golden rules honoured: nothing is deleted; a person note's LOG (from interactions)
// is the truth, the summary is marked "verify"; mangled notes are flagged, not fixed.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT = arg('out', '.');
const slug = (s) => String(s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
const esc = (s) => String(s == null ? '' : s);

async function getJSON(base, token, path) {
  const res = await fetch(base.replace(/\/$/, '') + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function load() {
  const base = arg('base');
  const token = arg('token');
  if (base && token) {
    const brain = await getJSON(base, token, '/api/export');
    // profile + lessons aren't in /api/export — fetch them too (tolerate absence).
    brain.user_profile = await getJSON(base, token, '/api/profile').catch(() => null);
    brain.lessons = await getJSON(base, token, '/api/lessons').catch(() => null);
    return brain;
  }
  const exp = arg('export');
  if (!exp) { console.error('need --base + --token, or --export <file>'); process.exit(2); }
  const brain = JSON.parse(await readFile(exp, 'utf8'));
  const p = arg('profile'); if (p) brain.user_profile = JSON.parse(await readFile(p, 'utf8'));
  const l = arg('lessons'); if (l) brain.lessons = JSON.parse(await readFile(l, 'utf8'));
  return brain;
}

// A note looks "mangled" if its content is a run of comma-split checkbox fragments —
// the routing damage the spec warns about (§10.2).
function looksMangled(text) {
  const t = String(text || '');
  const boxes = (t.match(/- \[[ x]\]/g) || []).length;
  return boxes >= 4 && t.length < boxes * 40;
}

async function run() {
  const b = await load();
  const report = [];
  const entities = b.entities || [];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const interactions = b.crm_interactions || b.interactions || [];
  const notes = b.journal_notes || b.notes || [];
  const tasks = b.tasks || [];

  await mkdir(join(OUT, 'people'), { recursive: true });
  await mkdir(join(OUT, 'projects'), { recursive: true });
  await mkdir(join(OUT, 'notes'), { recursive: true });
  await mkdir(join(OUT, '_meta'), { recursive: true });

  // --- People + projects + topics from entities ---
  const personByName = new Map(); // lowercased name -> filepath (for interaction routing)
  let nPeople = 0, nProj = 0, nTopic = 0;
  for (const e of entities) {
    if (e.type === 'area') continue; // Work/House/Life/Family are domains, not notes
    const s = slug(e.name);
    const fm = [
      '---',
      `type: ${e.type}`,
      `name: ${esc(e.name)}`,
      `tags: [${(e.attributes && e.attributes.tags) ? e.attributes.tags.join(', ') : ''}]`,
      `updated: ${day(e.updated_at || e.created_at) || new Date().toISOString().slice(0, 10)}`,
      '---',
      '',
    ].join('\n');
    const summaryNote = e.summary
      ? `## What to know\n_${e.summary_pinned ? 'Human-edited' : 'AI summary from life-os — verify against the log below'}._\n\n${esc(e.summary)}\n`
      : '## What to know\n<!-- no summary yet -->\n';
    const body = fm + summaryNote + '\n## Log\n';
    if (e.type === 'project') { await writeFile(join(OUT, 'projects', `${s}.md`), body); nProj++; }
    else if (e.type === 'topic') { await writeFile(join(OUT, 'notes', `${s}.md`), body); nTopic++; }
    else { await writeFile(join(OUT, 'people', `${s}.md`), body); personByName.set(e.name.toLowerCase(), join(OUT, 'people', `${s}.md`)); nPeople++; }
    if (!e.summary_pinned && e.summary) report.push(`- unpinned (AI) summary on **${e.type}/${e.name}** — verify.`);
  }

  // --- Interactions become the append-only LOG of the matching person ---
  const logByFile = new Map();
  let nIx = 0, nIxOrphan = 0;
  for (const i of interactions) {
    const line = `- ${day(i.created_at)} — ${esc(i.detail)}${i.follow_up_date ? ` _(follow-up ${day(i.follow_up_date)})_` : ''} _(surfaced: —)_`;
    let file = personByName.get(String(i.entity_type || '').toLowerCase());
    if (!file) { // no person entity for this subject (e.g. "Family") — make one
      const s = slug(i.entity_type || 'family');
      file = join(OUT, 'people', `${s}.md`);
      if (!personByName.has(String(i.entity_type || '').toLowerCase())) {
        personByName.set(String(i.entity_type || '').toLowerCase(), file);
        await writeFile(file, `---\ntype: person\nname: ${esc(i.entity_type || 'Family')}\ntags: [family]\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n## What to know\n<!-- no summary yet -->\n\n## Log\n`);
        nIxOrphan++;
      }
    }
    if (!logByFile.has(file)) logByFile.set(file, []);
    logByFile.get(file).push(line);
    nIx++;
  }
  for (const [file, lines] of logByFile) {
    lines.sort(); // chronological (ISO date prefix)
    const cur = await readFile(file, 'utf8');
    await writeFile(file, cur + lines.join('\n') + '\n');
  }

  // --- Journal / list notes ---
  let nNotes = 0, nMangled = 0;
  for (const n of notes) {
    const content = n.clean_content || n.raw_input || '';
    if (looksMangled(content)) { report.push(`- possibly **mangled note** "${esc(n.title || '(untitled)')}" (comma-split checkboxes) — review (§10.2).`); nMangled++; }
    const dir = n.note_type === 'journal' ? 'daily' : 'notes';
    await mkdir(join(OUT, dir), { recursive: true });
    const s = `${day(n.created_at)}-${slug(n.title || content.slice(0, 30))}`;
    const fm = `---\ntype: note\ntitle: ${esc(n.title || '')}\ncreated: ${day(n.created_at)}\n---\n\n`;
    await writeFile(join(OUT, dir, `${s}.md`), fm + esc(content) + '\n');
    nNotes++;
  }

  // --- Open tasks -> inline checkboxes in tasks.md ---
  const domainName = new Map((b.domains || []).map((d) => [d.id, d.name]));
  const open = tasks.filter((t) => t.status !== 'Complete' && !t.archived);
  const taskLines = open.map((t) => {
    const due = t.due_date ? ` 📅 ${day(t.due_date)}` : '';
    const tag = t.domain_id && domainName.get(t.domain_id) ? ` #${slug(domainName.get(t.domain_id))}` : '';
    const key = t.is_key ? ' ⭐' : '';
    return `- [ ] ${esc(t.title)}${due}${tag}${key}`;
  });
  await writeFile(join(OUT, 'tasks.md'),
    `# Tasks\n\nImported from life-os (${open.length} open). \`📅\`=due, \`#tag\`=area, \`⭐\`=key.\n\n${taskLines.join('\n')}\n`);

  // --- Profile + lessons ---
  const profile = b.user_profile && (b.user_profile.content || b.user_profile.profile || (typeof b.user_profile === 'string' ? b.user_profile : ''));
  await writeFile(join(OUT, '_meta', 'identity.md'), `# About Ben\n\n_Ported from life-os user_profile. Human-review after import._\n\n${esc(profile || '<!-- profile was empty in the export -->')}\n`);
  const lessons = Array.isArray(b.lessons) ? b.lessons : (b.lessons && b.lessons.lessons) || [];
  const lessonLines = (lessons || []).map((l) => `- ${esc(l.text || l)}`);
  if (!lessonLines.length) report.push('- **`lessons` export is EMPTY** — verify the brain actually had none, do not assume the exporter dropped them (§10.1).');
  await writeFile(join(OUT, '_meta', 'lessons.md'), `# Lessons & preferences\n\n_Ported from life-os. Verify non-empty (§10.1)._\n\n${lessonLines.join('\n') || '<!-- none exported -->'}\n`);

  // --- Interests (fuel for interest-scout) ---
  const interests = (b.interests || []).map((i) => `- ${esc(i.topic || i)}`);
  if (interests.length) await writeFile(join(OUT, 'notes', 'interests.md'), `---\ntype: note\ntitle: Interests\n---\n\n# Interests\n\n${interests.join('\n')}\n`);

  // --- Report ---
  const summary = [
    `# Migration report — ${new Date().toISOString()}`, '',
    `Imported: ${nPeople} people, ${nProj} projects, ${nTopic} topics, ${nIx} interactions`,
    `(${nIxOrphan} of which created a new "subject" person), ${nNotes} notes`,
    `(${nMangled} flagged as possibly mangled), ${open.length} open tasks, ${interests.length} interests.`, '',
    '## Human review needed (spec §10)', '',
    ...(report.length ? report : ['- nothing flagged — but still spot-check a few people notes.']), '',
    '## Then', '- reconcile any summary that disagrees with its log (fragments win).',
    '- decommission Railway + Supabase only after 14 days of §11 acceptance.',
  ].join('\n');
  await writeFile(join(OUT, 'MIGRATION-REPORT.md'), summary + '\n');

  console.log(summary);
}

run().catch((e) => { console.error('migration failed:', e.message); process.exit(1); });
