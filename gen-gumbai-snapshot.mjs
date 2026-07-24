// gen-gumbai-snapshot.mjs — rebuild Gumbai's data snapshot straight from Notion.
// Runs in GitHub Actions (Node 20 fetch, NOTION_TOKEN). This is what makes Gumbai
// "hands off": every morning it re-reads the four Notion DBs (which the daily sync has
// already refreshed) and rewrites functions/api/_snapshot.js, so the oracle is never a
// day behind again. Same source of truth as the rest of the tracker — Notion.
//
// Emits the SAME shape as build-gumbai-snapshot.mjs (meta / rikishi / banzuke / kimarite
// / bouts), server-side only under /functions (never fetchable, so spoiler-safe).
//
// SAFETY: validates before writing. If the pull looks empty/broken (no bouts, no roster)
// it EXITS NON-ZERO and writes nothing, so a bad run can never commit a broken snapshot.
//
// ENV: NOTION_TOKEN (required) · BASHO (default 202607) · OUT (default functions/api/_snapshot.js)
import fs from 'node:fs';
import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const OUT = process.env.OUT || 'functions/api/_snapshot.js';

// ─── PER-BASHO CONFIG — change these with the others each tournament ───────────
// (BASHO also changes in sync-notion.mjs/.yml and build-standings.mjs.)
const BASHO = process.env.BASHO || '202607';
const TOURNAMENT_PAGE_ID = '3351ade1-241f-80fb-b4ef-d2bef497b295';
const BASHO_LABEL = 'Nagoya 2026';
// ──────────────────────────────────────────────────────────────────────────────

const DB = {
  matchLog:      '1a2bad82-ebf5-4472-87ea-cb2c2481f9f1',
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
  kimarite:      '2591d1eb-2146-4745-ab0a-72ba57bfd213',
};

if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }

// ---------- Notion REST ----------
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
const idNoDash = s => String(s || '').replace(/-/g, '');
const titleOf = (p, prop) => { const x = p.properties?.[prop]; const a = x?.title || x?.rich_text || []; return a.map(t => t.plain_text).join('').trim(); };
const textOf  = (p, prop) => (p.properties?.[prop]?.rich_text || []).map(t => t.plain_text).join('').trim();
const selOf   = (p, prop) => p.properties?.[prop]?.select?.name ?? null;
const numOf   = (p, prop) => (typeof p.properties?.[prop]?.number === 'number' ? p.properties[prop].number : null);
const boolOf  = (p, prop) => p.properties?.[prop]?.checkbox === true;
const dateOf  = (p, prop) => p.properties?.[prop]?.date?.start ? String(p.properties[prop].date.start).slice(0, 10) : null;
const relIds  = (p, prop) => (p.properties?.[prop]?.relation || []).map(r => idNoDash(r.id));
const rel1    = (p, prop) => { const a = relIds(p, prop); return a[0] || null; };

// "AO (O)" / "Sleepy (O), Itchy (O)" / "Battle Pug (J)"  ->  [{nick, tag}]
function parseNicknames(text) {
  if (!text) return [];
  return text.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(.*?)\s*\(([JO])\)\s*$/i);
    return m ? { nick: m[1].trim(), tag: m[2].toUpperCase() } : { nick: s, tag: '' };
  }).filter(n => n.nick);
}

async function main() {
  const scoped = { property: 'Tournament', relation: { contains: TOURNAMENT_PAGE_ID } };
  const [mrPages, bzPages, kmPages, mlPages] = await Promise.all([
    queryAll(DB.masterRikishi),
    queryAll(DB.banzuke, scoped),
    queryAll(DB.kimarite),
    queryAll(DB.matchLog, scoped),
  ]);
  console.log(`pulled: rikishi=${mrPages.length} banzuke(scoped)=${bzPages.length} kimarite=${kmPages.length} matchlog(scoped)=${mlPages.length}`);

  // id -> canonical shikona (Master Rikishi), and id -> full profile
  const mrNameById = new Map();
  const mrProfById = new Map();
  for (const p of mrPages) {
    const name = titleOf(p, 'Ring Name'); if (!name) continue;
    mrNameById.set(idNoDash(p.id), name);
    mrProfById.set(idNoDash(p.id), {
      name,
      nicknames: parseNicknames(textOf(p, 'Nicknames')),
      country: selOf(p, 'Country of Origin'),
      birthday: dateOf(p, 'Birthday'),
      highestRank: selOf(p, 'Highest Rank'),
      heightCm: numOf(p, 'Height (cm)'),
      injuryNotes: textOf(p, 'Notes') || null,
      shikonaMeaning: textOf(p, 'Translation') || null,
    });
  }
  // kimarite page id -> Japanese name (matches bout.kimarite)
  const kmNameById = new Map();
  for (const p of kmPages) { const n = textOf(p, 'Kimarite'); if (n) kmNameById.set(idNoDash(p.id), n); }

  // ── bouts (scoped to this basho; Match Log only holds completed days) ──
  const participants = new Set();
  const bouts = [];
  const warn = [];
  for (const p of mlPages) {
    const day = numOf(p, 'Day #');
    const wId = rel1(p, 'Winner'), lId = rel1(p, 'Loser');
    const winner = wId && mrNameById.get(wId), loser = lId && mrNameById.get(lId);
    if (!Number.isInteger(day) || !winner || !loser) { warn.push(`bout skipped (day/winner/loser missing): ${titleOf(p, 'Match')}`); continue; }
    if (winner) participants.add(wId); if (loser) participants.add(lId);
    const tId = rel1(p, 'Technique');
    bouts.push({
      day, date: dateOf(p, 'Date'),
      winner, loser,
      kimarite: (tId && kmNameById.get(tId)) || null,
      goldStar: boolOf(p, 'Gold Star'),
      henka: selOf(p, 'Henka'),      // "Full" | "Partial" | null
      monoii: selOf(p, 'Monoii'),    // "Reversed (-R)" | "Stands (-S)" | "Rematch (-M)" | null
    });
  }
  bouts.sort((a, b) => a.day - b.day || String(a.winner).localeCompare(String(b.winner)));

  // ── banzuke (this basho): resolve Rikishi relation -> name ──
  const banzuke = [];
  for (const p of bzPages) {
    const rid = rel1(p, 'Rikishi');
    const name = (rid && mrNameById.get(rid)) || titleOf(p, 'Entry').split(' — ')[0].trim();
    if (!name) continue;
    banzuke.push({ name, rank: selOf(p, 'Rank'), weightKg: numOf(p, 'Weight (kg)') });
  }

  // ── rikishi[] = everyone on this banzuke OR who fought this basho (roster + visitors) ──
  const rosterIds = new Set(participants);
  for (const p of bzPages) { const rid = rel1(p, 'Rikishi'); if (rid) rosterIds.add(rid); }
  const rikishi = [...rosterIds].map(id => mrProfById.get(id)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── kimarite glossary (name + optional description) ──
  const kimarite = kmPages.map(p => {
    const name = textOf(p, 'Kimarite'); if (!name) return null;
    const description = textOf(p, 'Description');
    return description ? { name, description } : { name };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));

  const maxDay = Math.max(0, ...bouts.map(b => b.day));

  // ── validate before writing (fail safe: never commit a broken snapshot) ──
  const problems = [];
  if (!bouts.length) problems.push('0 bouts');
  if (!rikishi.length) problems.push('0 rikishi');
  if (!banzuke.length) problems.push('0 banzuke');
  if (maxDay < 1) problems.push('maxDay < 1');
  if (problems.length) { console.error('ABORT — snapshot looks broken: ' + problems.join(', ')); process.exit(1); }

  const snapshot = {
    meta: {
      basho: BASHO_LABEL, bashoId: BASHO,
      horizon: 'Data covers matches since Jan 2025 (when tracking began); career/historical totals before that are not in the data.',
      maxDay, schema: 'gumbai-snapshot/1', source: 'notion',
    },
    rikishi, banzuke, kimarite, bouts,
  };

  const banner = `// AUTO-GENERATED by gen-gumbai-snapshot.mjs from Notion — do not edit by hand.
// Server-side only (Cloudflare Pages excludes /functions from static assets).
// Holds every day; the Function gates it per-viewer before Claude ever sees it.
`;
  fs.mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(OUT, banner + 'export default ' + JSON.stringify(snapshot) + ';\n');

  console.log(`✓ wrote ${OUT}`);
  console.log(`  basho=${BASHO_LABEL} maxDay=${maxDay} rikishi=${rikishi.length} banzuke=${banzuke.length} kimarite=${kimarite.length} bouts=${bouts.length}`);
  if (warn.length) { console.log('⚠️ warnings:'); for (const w of [...new Set(warn)]) console.log('  - ' + w); }
}
main().catch(e => { console.error(e); process.exit(1); });
