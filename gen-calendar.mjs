// gen-calendar.mjs — build the Salt Stats & Sumo calendar snapshot straight from Notion.
// Runs in GitHub Actions (Node 20 fetch, NOTION_TOKEN), same pattern as gen-gumbai-snapshot.mjs.
//
// THREE EVENT CLASSES (calendar spec B1) -> one snapshot:
//   1. honbasho  — 🏆 Bashos where Type = Honbasho (the six grand tournaments). 15-day date span.
//   2. birthday  — EVERY 🤼 Master Rikishi with a Birthday (the full tracked set, not just the
//                  current 42). Recurring annual, all-day. Stored as {month, day, bornYear}.
//   3. special   — 🏆 Bashos where Type = Special Event (US Open, etc.). Untethered; carries its
//                  own Event Location / Event Link / Notes.
//
// TWO OUTPUTS from one pull (so we never read Notion at request time — the app-build-plan rule):
//   • calendar.json          — static asset the PUBLIC month-grid page fetches (client-side).
//   • functions/api/_calendar.js  — `export default <same data>` for the .ics feed Function to import.
//
// FIREWALL: dates + public birthdays only. No results, no records — nothing spoiler-sensitive — so
// the browse view is public and the feed carries no watched-day gate (the member wall is an access
// choice, not a spoiler gate).
//
// ENV: NOTION_TOKEN (required) · OUT_JSON (default calendar.json) · OUT_JS (default functions/api/_calendar.js)
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Make the PARENT directory of a target file, but never mkdir the file itself. path.dirname of a
// bare filename is '.', which we skip — the earlier bug was `mkdir calendar.json`, which created a
// DIRECTORY named calendar.json and made writeFileSync fail with EISDIR.
function ensureDir(file) {
  const dir = path.dirname(file);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
}

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const OUT_JSON = process.env.OUT_JSON || 'calendar.json';
const OUT_JS = process.env.OUT_JS || 'functions/api/_calendar.js';

const DB = {
  bashos:        'ae8b304d-8655-4072-934e-d01a43fe11ce',   // 🏆 Bashos (Honbasho + Special Event)
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',   // 🤼 Master Rikishi (Birthday)
};

// ---------- Notion REST (same shape as the other generators) ----------
async function notion(path, method = 'GET', body) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}
async function queryAll(dbId, filter) {
  const out = []; let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (filter) body.filter = filter;
    const r = await notion(`/databases/${dbId}/query`, 'POST', body);
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

// ---------- property readers ----------
const idShort = s => String(s || '').replace(/-/g, '').slice(0, 12);
const titleOf = (p, prop) => { const x = p.properties?.[prop]; const a = x?.title || x?.rich_text || []; return a.map(t => t.plain_text).join('').trim(); };
const textOf  = (p, prop) => (p.properties?.[prop]?.rich_text || []).map(t => t.plain_text).join('').trim();
const selOf   = (p, prop) => p.properties?.[prop]?.select?.name ?? null;
const numOf   = (p, prop) => (typeof p.properties?.[prop]?.number === 'number' ? p.properties[prop].number : null);
const dateOf  = (p, prop) => p.properties?.[prop]?.date?.start ? String(p.properties[prop].date.start).slice(0, 10) : null;
const urlOf   = (p, prop) => (p.properties?.[prop]?.url || '').trim() || null;

// ---------- pure shaping (exported for the unit test) ----------

// A 🏆 Bashos page -> a calendar event, or null if it has no usable date.
// Type === 'Special Event' -> special (untethered, free-text location/url); everything else -> honbasho.
export function bashoToEvent(p) {
  const type = selOf(p, 'Type');
  const start = dateOf(p, 'Start Date');
  const end = dateOf(p, 'End Date');
  if (!start) return null;                                   // no date, no calendar entry (blank-not-faked)
  if (type === 'Special Event') {
    return {
      id: 'se-' + idShort(p.id),
      kind: 'special',
      title: titleOf(p, 'Tournament Name') || 'Special Event',
      start, end: end || null,
      location: textOf(p, 'Event Location') || null,
      url: urlOf(p, 'Event Link'),
      notes: textOf(p, 'Notes') || null,
    };
  }
  const basho = selOf(p, 'Basho');
  const year = numOf(p, 'Year');
  const code = start.slice(0, 4) + start.slice(5, 7);        // YYYYMM
  return {
    id: 'hb-' + code,
    kind: 'honbasho',
    title: (basho && year) ? `${basho} ${year}` : (titleOf(p, 'Tournament Name') || 'Honbasho'),
    basho, year,
    start, end: end || null,
    location: selOf(p, 'Location') || null,
  };
}

// A 🤼 Master Rikishi page -> a recurring annual birthday, or null if no DOB.
export function rikishiToBirthday(p) {
  const dob = dateOf(p, 'Birthday');                          // "YYYY-MM-DD"
  const name = titleOf(p, 'Ring Name');
  if (!dob || !name) return null;
  const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return {
    id: 'bd-' + idShort(p.id),
    kind: 'birthday',
    name,
    month: parseInt(m[2], 10),   // 1-12
    day: parseInt(m[3], 10),     // 1-31
    bornYear: parseInt(m[1], 10),
  };
}

// Assemble the snapshot object from raw Notion pages (pure — the test drives this directly).
export function buildSnapshot(bashoPages, rikishiPages) {
  const events = [];
  for (const p of bashoPages) { const e = bashoToEvent(p); if (e) events.push(e); }
  events.sort((a, b) => String(a.start).localeCompare(String(b.start)));

  const birthdays = [];
  for (const p of rikishiPages) { const b = rikishiToBirthday(p); if (b) birthdays.push(b); }
  birthdays.sort((a, b) => (a.month - b.month) || (a.day - b.day) || a.name.localeCompare(b.name));

  const honbasho = events.filter(e => e.kind === 'honbasho');
  const special = events.filter(e => e.kind === 'special');
  return {
    meta: {
      generated: new Date().toISOString(),
      schema: 'calendar/1',
      source: 'notion',
      counts: { honbasho: honbasho.length, special: special.length, birthdays: birthdays.length },
    },
    events,       // honbasho + special, date-sorted (fixed-date spans)
    birthdays,    // recurring annual {name, month, day, bornYear}
  };
}

async function main() {
  if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }
  const [bashoPages, rikishiPages] = await Promise.all([
    queryAll(DB.bashos),
    queryAll(DB.masterRikishi),
  ]);
  console.log(`pulled: bashos=${bashoPages.length} masterRikishi=${rikishiPages.length}`);

  const snap = buildSnapshot(bashoPages, rikishiPages);
  const c = snap.meta.counts;
  console.log(`built: honbasho=${c.honbasho} special=${c.special} birthdays=${c.birthdays}`);

  // Validate before writing (never commit an empty calendar over a good one).
  const problems = [];
  if (!c.honbasho) problems.push('0 honbasho (is 🏆 Bashos shared / are any Type=Honbasho?)');
  if (!c.birthdays) problems.push('0 birthdays (is 🤼 Master Rikishi shared / any Birthday set?)');
  if (problems.length) { console.error('ABORT — calendar looks broken: ' + problems.join(', ')); process.exit(1); }

  // static JSON for the public month-grid page (client fetch)
  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, JSON.stringify(snap) + '\n');
  console.log(`✓ wrote ${OUT_JSON}`);

  // server module for the .ics feed Function (functions/ is excluded from static assets)
  const banner = `// AUTO-GENERATED by gen-calendar.mjs from Notion — do not edit by hand.\n// Server-side companion to the static calendar.json (same data), imported by the .ics feed.\n`;
  ensureDir(OUT_JS);
  fs.writeFileSync(OUT_JS, banner + 'export default ' + JSON.stringify(snap) + ';\n');
  console.log(`✓ wrote ${OUT_JS}`);
}

// Run only when invoked directly (node gen-calendar.mjs), not when imported by the test.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) main().catch(e => { console.error(e); process.exit(1); });
