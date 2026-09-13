// gen-drinking-game.mjs — rebuild drinking-game.html straight from Notion, per basho, per day.
// Runs in GitHub Actions (Node 20 fetch, NOTION_TOKEN), same pattern as gen-gumbai-snapshot.mjs.
//
// WHY THIS EXISTS: the drinking game was a hand-built static page frozen on Nagoya. This generator
// makes it a living board like standings — it reads the three catchphrase tables and emits a single
// GAME data block into a static template that renders the board client-side. So each basho/day fills
// itself in from the tracker; no hand editing, and it can never sit on a stale basho again.
//
// DATA MODEL (state/catchphrase-restructure-design.md):
//   🎙️ Catchphrase Sightings = the per-day FACT table (one row per phrase-heard-on-a-day):
//       Phrase (→ Catchphrases/Library, carries the announcer), Day (→ Days), Times Today, Giggle Rank, Jewel.
//   🗣️ Catchphrases = the LIBRARY (one row per announcer-phrase): Phrase (title, X-templated), Announcer (rel),
//       and a Sightings back-relation we count for the all-time "house-isms".
//   📅 Days: Day # (number), Announcer (rel).  ·  🎙️ Announcers: Announcer (title).
//
// GAME ALGORITHM (v3 — state/catchphrase-game-autofill-and-mechanics.md):
//   1 sip  (house-isms): the day's announcer's top Library phrases by all-time count → 5 candidates,
//          today-heard flagged; the client shows 3 (today-first, else random). All-time = spoiler-free.
//   2 sips (the day's funniest): that day's NON-jewel Sightings, multiples-first (Times Today desc, giggle desc).
//   Jewel  (the shot): the day's Jewel sighting (or the top auto-seed if none crowned).
//   Per-day status: "reviewed" if any of the day's sightings carries a human giggle of 5, else "auto";
//          a day with no sightings and no known announcer is "pending" (fills in when the transcript drops).
//
// SPOILER FIREWALL: only the TEMPLATED phrase text ever enters GAME — never the Sighting Subject (the
//   proper noun that would spoil). Later days are soft-locked client-side by the same watched-day gate as
//   the rest of the site. So the whole board is spoiler-safe by construction, every day present.
//
// ENV: NOTION_TOKEN (required) · BASHO (default 202609) · BASHO_LABEL (default "Aki 2026")
//      TOURNAMENT_PAGE_ID (scopes Days to this basho) · TEMPLATE (default drinking-game.template.html)
//      OUT (default drinking-game.html) · MOCK (test hook: path to a JSON of {library,sightings,days,announcers})
import fs from 'node:fs';
import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const TOTAL_DAYS = 15;

// ─── PER-BASHO CONFIG — change with the others each tournament (build-standings, gen-gumbai-snapshot) ───
const BASHO = process.env.BASHO || '202609';
const BASHO_LABEL = process.env.BASHO_LABEL || 'Aki 2026';
const TOURNAMENT_PAGE_ID = process.env.TOURNAMENT_PAGE_ID || '3351ade1-241f-8011-8987-d959538f54a0';
const TEMPLATE = process.env.TEMPLATE || 'drinking-game.template.html';
const OUT = process.env.OUT || 'drinking-game.html';
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

const DB = {
  catchphrases: '4d95409b-12f5-45ca-bc4d-b308c94f7576',                       // 🗣️ Catchphrases (Library)
  sightings:    'a3cd5904-e534-45be-bf2d-cf4c46ea3b4f',                       // 🎙️ Catchphrase Sightings (fact)
  days:         'eb0597c9-7259-49cd-babb-889f3b28f33d',                       // 📅 Days
  announcers:   '0dff86b0-5a19-462f-a5ef-10f46af12e5a',                       // 🎙️ Announcers
};

// ---------- Notion REST (identical pattern to gen-gumbai-snapshot.mjs) ----------
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
async function queryLane(name, dbId, filter, warn) {
  try { return await queryAll(dbId, filter); }
  catch (e) { warn.push(`lane "${name}" pull FAILED (${String(e.message).slice(0,120)}) — shared with sumo-site-publisher? Lane emitted empty.`); return []; }
}

// ---------- property readers ----------
const idNoDash = s => String(s || '').replace(/-/g, '');
const titleOf = (p, prop) => { const x = p.properties?.[prop]; const a = x?.title || x?.rich_text || []; return a.map(t => t.plain_text).join('').trim(); };
const textOf  = (p, prop) => (p.properties?.[prop]?.rich_text || []).map(t => t.plain_text).join('').trim();
const numOf   = (p, prop) => (typeof p.properties?.[prop]?.number === 'number' ? p.properties[prop].number : null);
const boolOf  = (p, prop) => p.properties?.[prop]?.checkbox === true;
const relIds  = (p, prop) => (p.properties?.[prop]?.relation || []).map(r => idNoDash(r.id));
const rel1    = (p, prop) => { const a = relIds(p, prop); return a[0] || null; };

// ---------- the pure transform: raw Notion pages -> GAME (unit-tested with mock data) ----------
export function buildGame({ library, sightings, days, announcers }, { label = BASHO_LABEL } = {}) {
  const warn = [];

  // announcer id -> name; day id -> day #; day # -> announcer name
  const annNameById = new Map();
  for (const p of announcers) { const n = titleOf(p, 'Announcer'); if (n) annNameById.set(idNoDash(p.id), n); }
  const dayNumById = new Map();
  const announcerByDay = new Map();
  for (const p of days) {
    const n = numOf(p, 'Day #'); if (!Number.isInteger(n)) continue;
    dayNumById.set(idNoDash(p.id), n);
    const aId = rel1(p, 'Announcer');
    announcerByDay.set(n, (aId && annNameById.get(aId)) || null);
  }

  // Library: phrase id -> { phrase(title, X-templated), announcer }. Also count all-time sightings per phrase.
  const lib = new Map();
  for (const p of library) {
    const phrase = titleOf(p, 'Phrase'); if (!phrase) continue;
    const aId = rel1(p, 'Announcer');
    lib.set(idNoDash(p.id), { phrase, announcer: (aId && annNameById.get(aId)) || null, allTime: 0 });
  }

  // Sightings -> per-day buckets. Each sighting: phrase (via Library), day #, timesToday, giggle, jewel.
  const byDay = new Map();               // day# -> [{phrase, announcer, times, giggle, jewel, pid}]
  for (const s of sightings) {
    const pid = rel1(s, 'Phrase');
    const L = pid && lib.get(pid);
    if (!L) { warn.push(`sighting skipped (phrase unresolved)`); continue; }
    L.allTime++;                          // EVERY sighting (all basho) counts toward the phrase's all-time
                                          // frequency → house-isms rank by the announcer's signature history,
                                          // so they play from Day 1 before this basho has a transcript.
    const dId = rel1(s, 'Day');
    const day = dId && dayNumById.get(dId);
    if (!Number.isInteger(day)) continue; // not one of THIS basho's days → counts all-time only, not on the board
    const times = numOf(s, 'Times Today');
    const giggle = numOf(s, 'Giggle Rank');
    const rec = { phrase: L.phrase, announcer: L.announcer, times: (times && times > 1 ? times : null), giggle: giggle || 0, jewel: boolOf(s, 'Jewel'), pid };
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(rec);
  }

  // house-isms per announcer: their Library phrases ranked by all-time sightings, then name (stable).
  const houseByAnnouncer = new Map();
  for (const L of lib.values()) {
    if (!L.announcer) continue;
    if (!houseByAnnouncer.has(L.announcer)) houseByAnnouncer.set(L.announcer, []);
    houseByAnnouncer.get(L.announcer).push(L);
  }
  for (const arr of houseByAnnouncer.values()) arr.sort((a, b) => b.allTime - a.allTime || a.phrase.localeCompare(b.phrase));

  // assemble per-day GAME entries
  const gameDays = {};
  let maxDayAvailable = 0;
  for (let d = 1; d <= TOTAL_DAYS; d++) {
    const announcer = announcerByDay.get(d) || null;
    const sights = byDay.get(d) || [];
    const heardText = new Set(sights.map(s => s.phrase));

    // 1 sip — house-isms: top 5 of the day's announcer, flag any heard today (client shows 3, today-first)
    let houseIsms = [];
    if (announcer && houseByAnnouncer.has(announcer)) {
      houseIsms = houseByAnnouncer.get(announcer).slice(0, 5).map(L => ({ t: L.phrase, today: heardText.has(L.phrase) ? 1 : 0 }));
    }

    // jewel — the day's crowned sighting, else the top auto-seed (giggle desc, then times desc)
    const jewelSight = sights.find(s => s.jewel)
      || [...sights].sort((a, b) => (b.giggle - a.giggle) || ((b.times || 1) - (a.times || 1)))[0]
      || null;

    // 2 sips — the day's NON-jewel sightings, multiples-first (times desc, giggle desc); cap 3
    const twoSips = sights
      .filter(s => s !== jewelSight)
      .sort((a, b) => ((b.times || 1) - (a.times || 1)) || (b.giggle - a.giggle) || a.phrase.localeCompare(b.phrase))
      .slice(0, 3)
      .map(s => ({ phrase: s.phrase, times: s.times, pid: s.pid }));

    // status: reviewed if a human giggle-5 exists that day; auto if any sighting; pending if truly empty
    let status = 'pending';
    if (sights.length) status = sights.some(s => s.giggle === 5) ? 'reviewed' : 'auto';
    else if (announcer) status = 'auto';   // announcer known, house-isms play even before the transcript

    if (sights.length || announcer) maxDayAvailable = d;

    gameDays[d] = {
      announcer,
      status,
      count: sights.length,
      houseIsms,
      twoSips,
      jewel: jewelSight ? { phrase: jewelSight.phrase } : null,
    };
  }

  return { game: { label, basho: label, maxDayAvailable, days: gameDays }, warn };
}

// ---------- template injection ----------
function render(template, game) {
  if (!/\/\*__GAME__\*\//.test(template)) throw new Error(`template ${TEMPLATE} missing the /*__GAME__*/ injection marker`);
  return template
    .replace('/*__GAME__*/', JSON.stringify(game))
    .replace(/__BASHO_LABEL__/g, game.label);
}

async function main() {
  const warn = [];
  let raw;
  if (process.env.MOCK) {
    raw = JSON.parse(fs.readFileSync(process.env.MOCK, 'utf8'));
  } else {
    if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }
    const scopedBasho = { property: 'Tournament', relation: { contains: TOURNAMENT_PAGE_ID } };
    // Days are scoped to this basho via Tournament; sightings inherit basho via their Day, so we scope
    // sightings by keeping only those whose Day resolves to this basho's Days (done in buildGame).
    const [library, days, announcers] = await Promise.all([
      queryLane('catchphrases', DB.catchphrases, undefined, warn),
      queryLane('days', DB.days, scopedBasho, warn),
      queryLane('announcers', DB.announcers, undefined, warn),
    ]);
    const sightings = await queryLane('sightings', DB.sightings, undefined, warn);
    raw = { library, sightings, days, announcers };
    console.log(`pulled: library=${library.length} sightings=${sightings.length} days=${days.length} announcers=${announcers.length}`);
  }

  const { game, warn: bwarn } = buildGame(raw, { label: BASHO_LABEL });
  warn.push(...bwarn);

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const html = render(template, game);
  fs.writeFileSync(OUT, html);

  const filled = Object.values(game.days).filter(d => d.count > 0).length;
  console.log(`✓ wrote ${OUT}  basho=${game.label} daysWithSightings=${filled}/${TOTAL_DAYS} maxDayAvailable=${game.maxDayAvailable}`);
  if (!filled) console.log('ℹ️ no sightings yet for this basho — board renders as an Aki shell (house-isms where the announcer is known, days fill in as transcripts land).');
  if (warn.length) { console.log('⚠️ warnings:'); for (const w of [...new Set(warn)]) console.log('  - ' + w); }
}

// Only run main() when invoked directly (not when imported by the test).
if (!process.env.NO_MAIN && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
