// gen-drinking-game.mjs — rebuild drinking-game.html straight from Notion, per basho, per day.
// Runs in GitHub Actions (Node 20 fetch, NOTION_TOKEN), same pattern as gen-gumbai-snapshot.mjs.
//
// SELF-CONTAINED (2026-09-13 rebuild): the page template is baked into this file (TEMPLATE_HTML below),
// so the ONLY committable artifact is this .mjs plus the publish.yml wiring. There is no separate
// drinking-game.template.html to accidentally commit as the live page — the earlier "committed the raw
// template, /*__GAME__*/ blanked the board" bust is designed out. This script always emits a complete,
// GAME-filled drinking-game.html.
//
// WHY THIS EXISTS: the drinking game was a hand-built static page frozen on Nagoya. This generator makes
// it a living board like standings — it reads the three catchphrase tables and emits a single GAME data
// block into the baked template that renders the board client-side. Each basho/day fills itself in from
// the tracker; no hand editing, and it can never sit on a stale basho again.
//
// DATA MODEL:
//   🎙️ Catchphrase Sightings = per-day FACT table (one row per phrase-heard-on-a-day):
//       Phrase (→ Library, carries the announcer), Day (→ Days), Times Today, Giggle Rank, Jewel.
//   🗣️ Catchphrases = the LIBRARY (one row per announcer-phrase): Phrase (title), Announcer (rel),
//       and a Sightings back-relation we count for the house-isms.
//   📅 Days: Day # (number), Announcer (rel), Basho (rel → the tournament page).  ·  🎙️ Announcers: Announcer (title).
//
// GAME ALGORITHM (v3):
//   1 sip  (house-isms): the day's announcer's top Library phrases by lifetime sighting count → 5 candidates,
//          today-heard flagged; the client shows 3 (today-first, else random). Lifetime count is spoiler-free.
//   2 sips (the day's funniest): that day's NON-jewel Sightings, multiples-first (Times Today desc, giggle desc).
//   Jewel  (the shot): the day's Jewel sighting (or the top auto-seed if none crowned).
//   Per-day status: "reviewed" if any of the day's sightings carries a human giggle of 5, else "auto";
//          a day with no sightings and no known announcer is "pending" (fills in when the transcript drops).
//
// BETWEEN-BASHO STATES (Jennie's decision, 2026-09-13):
//   1) live    — basho in progress: live board, no closed banner. (GAME_CLOSED unset/0)
//   2) between — basho over / next not started: the most-recently-completed basho's board stays playable
//                for reruns, with a "closed" banner naming the next basho + return date. (GAME_CLOSED=1,
//                NEXT_BASHO_LABEL + NEXT_BASHO_DATE — banzuke-drop sets these when it flips BASHO.)
//   3) pending — a day inside the live basho not yet transcribed: "fills in when the transcript drops."
//
// SPOILER FIREWALL: only the TEMPLATED phrase text ever enters GAME — never the Sighting Subject (the
//   proper noun that would spoil). Later days are soft-locked client-side by the same watched-day gate as
//   the rest of the site. The whole board is spoiler-safe by construction, every day present.
//
// ENV: NOTION_TOKEN (required) · BASHO (default 202609) · BASHO_LABEL (default "Aki 2026")
//      TOURNAMENT_PAGE_ID (scopes Days to this basho) · OUT (default drinking-game.html)
//      GAME_CLOSED (1 = between-basho closed banner) · NEXT_BASHO_LABEL · NEXT_BASHO_DATE
//      MOCK (test hook: path to a JSON of {library,sightings,days,announcers})
import fs from 'node:fs';
import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const TOTAL_DAYS = 15;

// ─── PER-BASHO CONFIG — change with the others each tournament (build-standings, gen-gumbai-snapshot) ───
const BASHO = process.env.BASHO || '202609';
const BASHO_LABEL = process.env.BASHO_LABEL || 'Aki 2026';
const TOURNAMENT_PAGE_ID = process.env.TOURNAMENT_PAGE_ID || '3351ade1-241f-8011-8987-d959538f54a0';
const OUT = process.env.OUT || 'drinking-game.html';
// between-basho banner (banzuke-drop sets these at the drop; unset = live, no banner)
const GAME_CLOSED = process.env.GAME_CLOSED === '1' || process.env.GAME_CLOSED === 'true';
const NEXT_BASHO_LABEL = process.env.NEXT_BASHO_LABEL || '';
const NEXT_BASHO_DATE = process.env.NEXT_BASHO_DATE || '';
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
export function buildGame({ library, sightings, days, announcers }, { label = BASHO_LABEL, closed = null } = {}) {
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

  // Library: phrase id -> { phrase(title), announcer }. Also count lifetime sightings per phrase.
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
    L.allTime++;                          // EVERY sighting (all basho) counts toward the phrase's lifetime
                                          // frequency → house-isms rank by the announcer's signature history,
                                          // so they play from Day 1 before this basho has a transcript.
    const dId = rel1(s, 'Day');
    const day = dId && dayNumById.get(dId);
    if (!Number.isInteger(day)) continue; // not one of THIS basho's days → counts lifetime only, not on the board
    const times = numOf(s, 'Times Today');
    const giggle = numOf(s, 'Giggle Rank');
    const rec = { phrase: L.phrase, announcer: L.announcer, times: (times && times > 1 ? times : null), giggle: giggle || 0, jewel: boolOf(s, 'Jewel'), pid };
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(rec);
  }

  // house-isms per announcer: their Library phrases ranked by lifetime sightings, then name (stable).
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

  return { game: { label, basho: label, maxDayAvailable, closed, days: gameDays }, warn };
}

// ---------- template injection (baked template; no external file) ----------
function render(game) {
  if (!/\/\*__GAME__\*\//.test(TEMPLATE_HTML)) throw new Error('baked TEMPLATE_HTML missing the /*__GAME__*/ injection marker');
  return TEMPLATE_HTML
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
    // Days are scoped to this basho via the "Basho" relation (property is named Basho on 📅 Days).
    // Sightings inherit basho via their Day, so we scope sightings by keeping only those whose Day
    // resolves to this basho's Days (done in buildGame).
    const scopedBasho = { property: 'Basho', relation: { contains: TOURNAMENT_PAGE_ID } };
    const [library, days, announcers] = await Promise.all([
      queryLane('catchphrases', DB.catchphrases, undefined, warn),
      queryLane('days', DB.days, scopedBasho, warn),
      queryLane('announcers', DB.announcers, undefined, warn),
    ]);
    const sightings = await queryLane('sightings', DB.sightings, undefined, warn);
    raw = { library, sightings, days, announcers };
    console.log(`pulled: library=${library.length} sightings=${sightings.length} days=${days.length} announcers=${announcers.length}`);
    // last-good guard (matches gen-gumbai-snapshot): the Library is basho-independent and always
    // populated, so an empty Library or any FAILED lane means the pull hiccuped. Do NOT overwrite the
    // live board with an empty shell — leave the last good drinking-game.html and exit non-fatally.
    const pullFailed = warn.some(w => w.includes('pull FAILED'));
    if (pullFailed || library.length === 0) {
      console.error(`✗ catchphrase pull incomplete (library=${library.length}, warnings=${warn.length}) — leaving the last good ${OUT} in place, nothing rewritten.`);
      for (const w of [...new Set(warn)]) console.log('  - ' + w);
      process.exit(0);
    }
  }

  const closed = GAME_CLOSED ? { next: NEXT_BASHO_LABEL || null, back: NEXT_BASHO_DATE || null } : null;
  const { game, warn: bwarn } = buildGame(raw, { label: BASHO_LABEL, closed });
  warn.push(...bwarn);

  const html = render(game);
  fs.writeFileSync(OUT, html);

  const filled = Object.values(game.days).filter(d => d.count > 0).length;
  console.log(`✓ wrote ${OUT}  basho=${game.label} daysWithSightings=${filled}/${TOTAL_DAYS} maxDayAvailable=${game.maxDayAvailable} closed=${!!closed}`);
  if (!filled) console.log('ℹ️ no sightings yet for this basho — board renders as a shell (house-isms where the announcer is known, days fill in as transcripts land).');
  if (warn.length) { console.log('⚠️ warnings:'); for (const w of [...new Set(warn)]) console.log('  - ' + w); }
}

// ---------- baked page template (String.raw preserves \d, \' etc. verbatim; no backtick / ${ inside) ----------
const TEMPLATE_HTML = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Salt Stats &amp; Sumo · Catchphrase Drinking Game</title>
<!-- AUTO-GENERATED from Notion by gen-drinking-game.mjs — do not hand-edit drinking-game.html.
     The template is baked into gen-drinking-game.mjs; the GAME data comes from the tracker. -->
<style>
:root{--bg:#efe1c2;--bg2:#e6d3ab;--panel:#fdf7e9;--card:#fbf1d9;--line:#c9b184;--ink:#3d2713;
--muted:#8c7550;--liq1:#6f9a4d;--liq2:#8a5cc0;--liq3:#cf4b2a;--purple:#8a5cc0;--vermilion:#cf4b2a;--gold:#c8912b;}
*{box-sizing:border-box}
body{margin:0;background:linear-gradient(160deg,var(--bg),var(--bg2));color:var(--ink);
font-family:'Trebuchet MS',Verdana,sans-serif;line-height:1.4;min-height:100vh}
.wrap{max-width:1000px;margin:0 auto;padding:22px 16px 60px}
header.site{background:
  repeating-linear-gradient(178deg, rgba(0,0,0,.14) 0 1px, transparent 1px 4px),
  repeating-linear-gradient(90deg, rgba(0,0,0,.05) 0 2px, transparent 2px 44px),
  linear-gradient(160deg,#6e4826,#432a15);
  color:#fff;border-radius:14px;padding:20px 22px;border:1px solid #38230f;
  box-shadow:0 8px 22px rgba(50,30,10,.28);text-align:left;margin-bottom:4px}
.hbrand{display:flex;align-items:center;gap:14px}
.hdicon{width:52px;height:52px;flex:0 0 auto;filter:drop-shadow(0 2px 5px rgba(0,0,0,.3))}
header.site h1{margin:0 0 2px;font-size:24px;color:#fff}
header.site p{margin:0;color:#f0e6d0;opacity:.9;font-size:13.5px}
.homecrest{width:34px;height:34px;border-radius:50%;flex:0 0 auto;margin-left:auto;overflow:hidden;
  background:#efe7d5;box-shadow:0 0 0 1px rgba(255,255,255,.30),0 2px 6px rgba(0,0,0,.28);
  transition:transform .12s ease, box-shadow .12s ease}
.homecrest:hover{transform:translateY(-1px);box-shadow:0 0 0 1px rgba(255,255,255,.55),0 5px 13px rgba(0,0,0,.34)}
.homecrest img{width:100%;height:100%;object-fit:cover;display:block}
.betweenbasho{margin:12px 0;padding:14px 18px;background:linear-gradient(160deg,#f7edd3,#f0e0b8);border:1px solid var(--gold);border-left:6px solid var(--vermilion);border-radius:12px;font-size:14px;line-height:1.5}
.betweenbasho b{color:var(--vermilion)}
.betweenbasho .bb-emoji{font-size:18px;margin-right:4px}
.drinknote{margin:12px 0;padding:9px 14px;background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--gold);border-radius:10px;font-size:13.5px}
.drinknote b{color:var(--vermilion)}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0}
.tab{background:var(--panel);color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:7px 13px;font:inherit;font-weight:700;font-size:13px;cursor:pointer}
.tab:hover{border-color:var(--gold);color:var(--ink)} .tab.active{background:var(--gold);color:#38240c;border-color:var(--gold)}
.dayhead{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:8px 0 6px;padding-bottom:10px;border-bottom:2px dashed var(--line)}
.dnum{font-size:22px;font-weight:800}
.ann{background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-weight:700;color:var(--purple)}
.cnt{margin-left:auto;color:var(--muted);font-size:12.5px}
.lvl{margin:18px 0} .lvl h3{margin:0 0 10px;font-size:16px} .lvl h3 em{color:var(--muted);font-weight:400;font-size:12.5px}
.shelf{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;justify-content:center;background:var(--panel);border:1px solid var(--line);border-bottom:5px solid var(--line);border-radius:12px;padding:16px}
.shelf.center{justify-content:center}
.card{position:relative;width:160px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 10px 12px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:5px}
.card.l3{width:230px;border-color:var(--gold);box-shadow:0 0 0 2px var(--gold) inset,0 6px 18px rgba(180,120,20,.25)}
.stein{width:58px;height:78px} .card.l3 .stein{width:74px;height:96px}
.crown{font-size:11px;font-weight:800;letter-spacing:.08em;color:var(--vermilion);text-transform:uppercase}
.phrase{font-weight:800;font-size:14px;line-height:1.25} .card.l3 .phrase{font-size:18px}
.sub{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.mult{position:absolute;top:-8px;right:-7px;background:var(--vermilion);color:#fff;font-size:11px;font-weight:800;padding:2px 7px;border-radius:999px}
.st{font-size:11px;font-weight:700;border-radius:999px;padding:3px 9px}
.st.ok{background:#e2efd4;color:#3f6b1f;border:1px solid #a9c98a} .st.auto{background:#f3e2bf;color:#8a6a1e;border:1px solid #d8b874}
.st.pending{background:#eee7db;color:#8c7550;border:1px solid #d9ccb3}
.empty{color:var(--muted);font-style:italic;padding:8px}
.pendingnote{margin:14px 0;padding:14px 16px;background:var(--panel);border:1px dashed var(--line);border-radius:12px;color:var(--muted);font-size:13.5px}
.mine .addrow{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.mine input{flex:1;min-width:220px;font:inherit;font-size:14px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:#fff}
.mine button{font:inherit;font-weight:700;background:var(--purple);color:#fff;border:0;border-radius:9px;padding:9px 16px;cursor:pointer}
.tabwrap{display:flex;flex-direction:column;align-items:center;gap:8px;margin:16px 0}
.tabwrap .tabs{margin:0;justify-content:center}
.changewatch{margin-top:2px;background:transparent;border:1px dashed var(--line);color:var(--muted);border-radius:999px;padding:6px 12px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer}
.changewatch:hover{border-color:var(--gold);color:var(--ink)}
.tab.locked{opacity:.42;cursor:not-allowed;pointer-events:none}
.nextday{display:block;margin:24px auto 4px;background:var(--gold);color:#38240c;border:0;border-radius:999px;padding:12px 24px;font:inherit;font-weight:800;font-size:14px;cursor:pointer;box-shadow:0 4px 12px rgba(180,120,20,.25)}
.nextday:hover{filter:brightness(1.05);transform:translateY(-1px)}
.doneall{text-align:center;margin:24px 0 4px;color:var(--muted);font-weight:800;font-size:15px}
.vote{margin-top:2px;background:#fff;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font:inherit;font-size:11.5px;font-weight:700;color:var(--purple);cursor:pointer}
.vote:hover{border-color:var(--purple)} .vote.voted{background:var(--purple);color:#fff;border-color:var(--purple)}
.wctl{position:absolute;top:5px;right:6px;display:flex;gap:2px;z-index:2}
.mine .mini{background:transparent;border:0;color:var(--muted);font-size:13px;line-height:1;padding:2px 3px;cursor:pointer;opacity:.5;font-weight:700}
.mine .mini:hover{opacity:1;color:var(--purple)}
.editin{width:100%;font:inherit;font-size:13px;padding:5px 7px;border:1px solid var(--purple);border-radius:7px;margin-bottom:4px}
.gate{position:fixed;inset:0;background:rgba(61,39,19,.55);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50}
.gatecard{background:var(--panel);border:1px solid var(--line);border-top:6px solid var(--gold);border-radius:16px;max-width:520px;padding:22px 24px;box-shadow:0 18px 50px rgba(40,25,8,.35)}
.gatecard h2{margin:0 0 8px;font-size:21px} .gatecard p{margin:0 0 14px;color:var(--muted);font-size:14px}
.gatefoot{margin:14px 0 0!important;font-size:12.5px;font-style:italic}
.gaterow{display:flex;flex-wrap:wrap;gap:7px}
.gaterow button{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:8px 12px;font:inherit;font-weight:700;font-size:13px;cursor:pointer}
.gaterow button:hover{border-color:var(--gold);background:#fff}
</style></head><body><div class="wrap">
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<filter id="inkS" x="-6%" y="-6%" width="112%" height="112%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.3" xChannelSelector="R" yChannelSelector="G"/></filter>
<clipPath id="coinClip"><circle cx="60" cy="60" r="55"/></clipPath>
<symbol id="ic-catchphrase" viewBox="0 0 120 120">
  <circle cx="60" cy="60" r="58" fill="#efe7d5"/>
  <circle cx="60" cy="60" r="55.5" fill="none" stroke="#c06a34" stroke-width="4.5"/>
  <circle cx="60" cy="60" r="49" fill="none" stroke="#c06a34" stroke-width="1.3"/>
  <g clip-path="url(#coinClip)" filter="url(#inkS)">
    <path d="M40 39 H80 a7 7 0 0 1 7 7 V57 a7 7 0 0 1 -7 7 H54 L44 73 V64 H40 a7 7 0 0 1 -7 -7 V46 a7 7 0 0 1 7 -7 Z" fill="#211a12"/>
    <g stroke="#efe7d5" stroke-width="2.6" stroke-linecap="round">
      <line x1="46" y1="46" x2="46" y2="58"/><line x1="52" y1="46" x2="52" y2="58"/>
      <line x1="58" y1="46" x2="58" y2="58"/><line x1="64" y1="46" x2="64" y2="58"/>
    </g>
    <line x1="43" y1="58" x2="67" y2="46" stroke="#b23a2e" stroke-width="2.8" stroke-linecap="round"/>
  </g>
</symbol>
</defs></svg>
<header class="site">
  <div class="hbrand">
    <svg class="hdicon" viewBox="0 0 120 120" aria-hidden="true"><use href="#ic-catchphrase"/></svg>
    <div><h1>Catchphrase Drinking Game</h1>
    <p>__BASHO_LABEL__ · pick a day, pour along with the booth.</p></div>
    <a class="homecrest" href="/" title="Salt Stats &amp; Sumo · home" aria-label="Home"><img src="/salt-stats-sumo-badgeold.png" alt=""></a>
  </div>
</header>
<div id="betweenBasho" class="betweenbasho" hidden></div>
<div class="drinknote">🥤 <b>Your pour, your rules.</b> The glasses show <b>how much</b>: a sip, two, or bottoms-up.
Fill them with water, iced tea, beer, sake, barley tea, your legal beverage of choice. Play kind, play hydrated.</div>
<div class="drinknote" style="border-left-color:var(--liq2)">👑 <b>Cast your vote.</b> Think a Two Sips call out-funnied the day's Jewel? Tap <b>👑 my pick</b> on it (one pick per day). Heard a good one we missed? Drop it in <b>Your Favorite Quote of the Day</b>. Your picks help crown the real Jewels.</div>
<div class="drinknote" style="border-left-color:var(--purple)">📅 Living board. Each day fills in when its transcript drops, and can change after footage review. Days still on machine seeds show <span class="st auto">⏳ auto</span>; hand-reviewed days show <span class="st ok">✓ reviewed</span>.</div>
<div class="tabwrap">
  <div class="tabs" id="tabs"></div>
  <div class="tabs" id="tabs2"></div>
  <button class="changewatch" onclick="openGate()">⟲ change day</button>
</div>
<div id="board"></div>
</div>
<div id="gate" class="gate"><div class="gatecard">
  <h2>🍶 What day are you watching?</h2>
  <p>We'll open that day's board and keep the later days tucked away. Spoiler-safe either way.</p>
  <div class="gaterow" id="gaterow"></div>
  <p class="gatefoot">Change it any time: pick the next day when you sit down, or jump ahead as you binge to catch up!</p>
</div></div>
<script>
var GAME = /*__GAME__*/;
var TOTAL_DAYS = 15;

// ── stein SVGs (fill level = sips) ──
function stein(kind){
  if(kind==='l1') return '<svg viewBox="0 0 70 92" class="stein"><clipPath id="cL1"><path d="M12 16 h44 v60 a8 8 0 0 1 -8 8 h-28 a8 8 0 0 1 -8 -8 z"/></clipPath><rect x="12" y="60" width="44" height="20" fill="var(--liq1)" clip-path="url(#cL1)" opacity="0.9"/><path d="M12 16 h44 v60 a8 8 0 0 1 -8 8 h-28 a8 8 0 0 1 -8 -8 z" fill="none" stroke="var(--ink)" stroke-width="2.5"/><path d="M56 30 h7 a6 6 0 0 1 6 6 v14 a6 6 0 0 1 -6 6 h-7" fill="none" stroke="var(--ink)" stroke-width="2.5"/></svg>';
  if(kind==='l2') return '<svg viewBox="0 0 70 92" class="stein"><clipPath id="cL2"><path d="M12 16 h44 v60 a8 8 0 0 1 -8 8 h-28 a8 8 0 0 1 -8 -8 z"/></clipPath><rect x="12" y="40" width="44" height="40" fill="var(--liq2)" clip-path="url(#cL2)" opacity="0.9"/><path d="M12 16 h44 v60 a8 8 0 0 1 -8 8 h-28 a8 8 0 0 1 -8 -8 z" fill="none" stroke="var(--ink)" stroke-width="2.5"/><path d="M56 30 h7 a6 6 0 0 1 6 6 v14 a6 6 0 0 1 -6 6 h-7" fill="none" stroke="var(--ink)" stroke-width="2.5"/></svg>';
  return '<svg viewBox="0 0 70 92" class="stein"><clipPath id="cL3"><path d="M12 16 h44 v60 a8 8 0 0 1 -8 8 h-28 a8 8 0 0 1 -8 -8 z"/></clipPath><rect x="12" y="20" width="44" height="66" fill="var(--liq3)" clip-path="url(#cL3)" opacity="0.9"/><path d="M12 16 h44 v60 a8 8 0 0 1 -8 8 h-28 a8 8 0 0 1 -8 -8 z" fill="none" stroke="var(--ink)" stroke-width="2.5"/><path d="M56 30 h7 a6 6 0 0 1 6 6 v14 a6 6 0 0 1 -6 6 h-7" fill="none" stroke="var(--ink)" stroke-width="2.5"/><ellipse cx="34" cy="19" rx="21" ry="7" fill="#fff7e6" stroke="var(--liq3)" stroke-width="1.5"/></svg>';
}
var WMUG='<svg viewBox="0 0 70 92" class="stein"><path d="M12 16 h44 v60 a8 8 0 0 1 -8 8 h-28 a8 8 0 0 1 -8 -8 z" fill="none" stroke="var(--ink)" stroke-width="2.5"/><rect x="12" y="46" width="44" height="34" fill="var(--purple)" opacity="0.85"/></svg>';
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}

// ── between-basho closed banner (state 2) ──
function renderClosed(){
  if(!GAME.closed) return;
  var c=GAME.closed;
  var tail = c.next ? ('until '+c.next+(c.back?(', back '+c.back):'')) : 'until the next basho';
  var el=document.getElementById('betweenBasho'); if(!el) return;
  el.innerHTML='<span class="bb-emoji">🎐</span><b>That’s a wrap on '+esc(GAME.label)+'.</b> '+
    'The game’s closed '+esc(tail)+'. Rewatching? The board’s still here to play along.';
  el.hidden=false;
}

// ── build the board (all days rendered once; show() toggles + fills house-isms) ──
function statusChip(s){
  if(s==='reviewed') return '<span class="st ok">✓ reviewed</span>';
  if(s==='auto') return '<span class="st auto">⏳ auto</span>';
  return '<span class="st pending">⏳ not in yet</span>';
}
function twoSipCard(c){
  return '<div class="card l2" data-pid="'+esc(c.pid||'')+'">'+stein('l2')+
    (c.times?('<span class="mult">×'+c.times+'</span>'):'')+
    '<div class="phrase">'+esc(c.phrase)+'</div><div class="sub">2 sips</div>'+
    '<button class="vote" onclick="crown(this)" title="crown this call as your Jewel (one pick per day)">👑 my pick</button></div>';
}
function sectionHTML(n){
  var g=GAME.days[n]||{}; var h='';
  h+='<div class="dayhead"><span class="dnum">Day '+n+'</span>';
  if(g.announcer) h+='<span class="ann">Announcer 🎙 '+esc(g.announcer)+'</span>';
  if(g.count) h+='<span class="cnt">'+g.count+' call'+(g.count===1?'':'s')+' logged</span>';
  h+=(g.count?'':'<span class="cnt"></span>')+statusChip(g.status)+'</div>';

  var hasHouse=(g.houseIsms&&g.houseIsms.length);
  var hasTwo=(g.twoSips&&g.twoSips.length);
  var hasJewel=!!g.jewel;

  if(!hasHouse && !hasTwo && !hasJewel){
    h+='<div class="pendingnote">This day fills in when its transcript drops. Check back after the broadcast — the booth’s house-isms and the day’s funniest calls land here, spoiler-safe.</div>';
  } else {
    // 1 sip — house-isms (filled by renderL1 on show)
    if(hasHouse){
      h+='<div class="lvl"><h3>🍺 One Sip <em>· '+esc((g.announcer||'the booth'))+'’s house-isms</em></h3><div class="shelf" id="l1s'+n+'"></div></div>';
    }
    // 2 sips
    h+='<div class="lvl"><h3>🍺🍺 Two Sips <em>· the day’s funniest · 👑 crown the one you’d promote over the Jewel</em></h3>';
    h+='<div class="shelf">'+(hasTwo?g.twoSips.map(twoSipCard).join(''):'<div class="empty">no calls logged for this day yet</div>')+'</div></div>';
    // jewel
    h+='<div class="lvl"><h3>🍺🍺🍺 The Jewel</h3><div class="shelf center">';
    h+=(hasJewel?('<div class="card l3">'+stein('l3')+'<div class="crown">finish it</div><div class="phrase">'+esc(g.jewel.phrase)+'</div></div>'):'<div class="empty">the day’s Jewel lands here once the transcript’s in</div>');
    h+='</div></div>';
  }
  // your quote of the day (always available)
  h+='<div class="lvl mine"><h3>Your Favorite Quote of the Day <em>· heard a better one? add it</em></h3>'+
     '<div class="addrow"><input id="in'+n+'" type="text" placeholder="e.g. &ldquo;down goes Frazier!&rdquo;" onkeydown="if(event.key===\'Enter\')addcall('+n+')">'+
     '<button onclick="addcall('+n+')">Add to the board</button></div>'+
     '<div class="shelf" id="mine'+n+'"><div class="empty">your write-ins land here (this session)</div></div></div>';
  // next-day / done
  h+=(n<TOTAL_DAYS?('<button class="nextday" onclick="nextFrom('+n+')">✓ Finished Day '+n+' · open Day '+(n+1)+' →</button>')
                  :'<div class="doneall">🏆 That’s the whole basho. Kanpai!</div>');
  return '<section class="panel" id="day'+n+'" style="display:none">'+h+'</section>';
}
function buildBoard(){
  var tabs='',tabs2='';
  for(var d=1; d<=7; d++)  tabs +='<button class="tab" data-d="'+d+'" onclick="show('+d+')">Day '+d+'</button>';
  for(var d=8; d<=15; d++) tabs2+='<button class="tab" data-d="'+d+'" onclick="show('+d+')">Day '+d+'</button>';
  document.getElementById('tabs').innerHTML=tabs;
  document.getElementById('tabs2').innerHTML=tabs2;
  var b=''; for(var n=1;n<=TOTAL_DAYS;n++) b+=sectionHTML(n);
  document.getElementById('board').innerHTML=b;
}
// 1 sip: today-heard first, then a random fill, capped at 3
function renderL1(n){
  var g=GAME.days[n]||{}; var el=document.getElementById('l1s'+n); if(!el) return;
  var pool=(g.houseIsms||[]).slice();
  var today=pool.filter(function(x){return x.today>0;});
  var rest=pool.filter(function(x){return !x.today;});
  for(var i=rest.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=rest[i];rest[i]=rest[j];rest[j]=t;}
  var pick=today.concat(rest).slice(0,3);
  el.innerHTML=pick.map(function(x){
    return '<div class="card l1">'+stein('l1')+'<div class="phrase">'+esc(x.t)+'</div><div class="sub">1 sip · house-ism</div></div>';
  }).join('')||'<div class="empty">·</div>';
}

// ── write-ins (session only) + crown vote ──
function addcall(n){var i=document.getElementById('in'+n);var v=(i.value||'').trim();if(!v)return;
  var box=document.getElementById('mine'+n);var em=box.querySelector('.empty');if(em)em.remove();
  var c=document.createElement('div');c.className='card l2';
  c.innerHTML='<div class="wctl"><button class="mini edit" title="edit" onclick="editcall(this)">✎</button>'+
  '<button class="mini" title="remove" onclick="delcall(this)">✕</button></div>'+WMUG+
  '<div class="phrase">'+esc(v)+'</div><div class="sub">your quote</div>'+
  '<button class="vote" onclick="crown(this)" title="crown this as your Jewel (one pick per day)">👑 my pick</button>';
  box.appendChild(c);i.value='';postFan({type:'write-in',day:n,text:v});}
function editcall(btn){var card=btn.closest('.card');var ph=card.querySelector('.phrase');
  var inp=document.createElement('input');inp.className='editin';inp.value=ph.textContent;
  inp.onkeydown=function(e){if(e.key==='Enter')savecall(card);if(e.key==='Escape'){inp.remove();ph.style.display='';reset(btn);}};
  ph.style.display='none';card.insertBefore(inp,ph);inp.focus();inp.select();
  btn.textContent='✓';btn.title='save';btn.onclick=function(){savecall(card);};}
function savecall(card){var inp=card.querySelector('.editin');var ph=card.querySelector('.phrase');
  var v=(inp.value||'').trim();if(v)ph.textContent=v;inp.remove();ph.style.display='';
  reset(card.querySelector('.mini.edit'));}
function reset(btn){btn.textContent='✎';btn.title='edit';btn.onclick=function(){editcall(btn);};}
function delcall(btn){var box=btn.closest('.shelf');btn.closest('.card').remove();
  if(!box.querySelector('.card'))box.innerHTML='<div class="empty">your write-ins land here (this session)</div>';}
function crown(btn){var panel=btn.closest('.panel');var day=+panel.id.replace('day','');
  var already=btn.classList.contains('voted');
  panel.querySelectorAll('.vote').forEach(function(b){b.classList.remove('voted');b.textContent='👑 my pick';});
  if(!already){btn.classList.add('voted');btn.textContent='👑 your pick ✓';
    var card=btn.closest('.card');var pid=card.getAttribute('data-pid')||'';
    var ph=card.querySelector('.phrase');var text=ph?ph.textContent:'';
    postFan({type:'jewel-vote',day:day,pid:pid,text:text,reason:'promote-to-jewel'});}}

// ── spoiler gateway + binge advance (same mechanic as the rest of the site) ──
var watchedDay=0, current=1;
function openGate(){document.getElementById('gate').style.display='flex';}
function setCurrentDay(d){current=Math.min(Math.max(d,1),TOTAL_DAYS);watchedDay=current-1;
  document.getElementById('gate').style.display='none';applyGate();show(current);persistWatched(watchedDay);}
function nextFrom(d){var t=Math.min(d+1,TOTAL_DAYS);current=Math.max(current,t);watchedDay=current-1;
  applyGate();show(t);persistWatched(watchedDay);}
function applyGate(){document.querySelectorAll('.tab').forEach(function(t){
  var d=+t.dataset.d;var locked=d>current;
  t.classList.toggle('locked',locked);
  t.textContent='Day '+d+(locked?' 🔒':'');});}
function show(n){if(n>current)return;
  document.querySelectorAll('.panel').forEach(function(p){p.style.display='none';});
  var el=document.getElementById('day'+n); if(el) el.style.display='';
  document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('active',+t.dataset.d===n);});
  renderL1(n);}
var FAN_KEY='ss_watched_day', SESS_KEY='ss_fan_session';
function sess(){try{var s=localStorage.getItem(SESS_KEY);if(!s){s='s'+Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem(SESS_KEY,s);}return s;}catch(e){return 'anon';}}
function postFan(p){try{p.source=sess();p.basho=GAME.basho;fetch('/api/fan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)}).catch(function(){});}catch(e){}}
function persistWatched(d){try{if(d)localStorage.setItem(FAN_KEY,String(d));}catch(e){}}
function buildGate(){var row=document.getElementById('gaterow');var h='';
  for(var d=1;d<=TOTAL_DAYS;d++) h+='<button onclick="setCurrentDay('+d+')">Day '+d+'</button>';
  row.innerHTML=h;}
function initWatched(){buildBoard();buildGate();renderClosed();var d=null;
  try{var m=location.search.match(/[?&]d=(\d+)/);if(m)d=+m[1];}catch(e){}
  if(d===null){try{var s=localStorage.getItem(FAN_KEY);if(s!==null&&s!=='')d=+s;}catch(e){}}
  if(d!==null){setCurrentDay(d+1);}else{openGate();}}
initWatched();
</script>
<script>
/* surface-aware home crest: "home" follows the surface you're browsing (app hub vs public site). */
(function(){
  var s=null;
  try{ if(document.referrer){ var u=new URL(document.referrer);
    if(u.origin===location.origin && u.pathname!==location.pathname)
      s = u.pathname.indexOf('/app')===0 ? 'app' : 'site'; } }catch(e){}
  if(s){ try{ sessionStorage.setItem('ss_surface', s); }catch(e){} }
  else { try{ s = sessionStorage.getItem('ss_surface'); }catch(e){} }
  if(s==='app'){ var c=document.querySelector('.homecrest'); if(c){ c.setAttribute('href','/app'); c.setAttribute('title','Crew home'); } }
})();
</script></body></html>`;

// Only run main() when invoked directly (not when imported by the test).
if (!process.env.NO_MAIN && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
