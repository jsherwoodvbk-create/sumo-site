// gen-gumbai-snapshot.mjs — rebuild Gumbai's data snapshot straight from Notion.
// Runs in GitHub Actions (Node 20 fetch, NOTION_TOKEN). Every morning it re-reads the
// Notion DBs (which the daily sync has already refreshed) and rewrites
// functions/api/_snapshot.js, so the oracle is never a day behind. Same source of truth
// as the rest of the tracker — Notion.
//
// SCHEMA gumbai-snapshot/4 (2026-07-30): adds the SOFT-DATA lanes on top of the /3 shape.
//   /3 gave: meta, rikishi, banzuke, kimarite, bouts, history, upcoming.
//   /4 ADDS: per-bout nets (boutOfDay/conduct/conductNote/length/cushions/rematch) on each
//   bout; plus days[] (storylines + scorekeeper notes), injuries[] (3-track, day-stamped
//   severity log), catchphrases[] (per announcer, day-tagged). The Function's gate
//   (_engine.js) filters all of it per-viewer-day — the snapshot holds every day.
//
// SCHEMA gumbai-snapshot/6 (2026-09-12): profiles now carry stable/hometown/knownFor/
//   realName/pastRingNames/active alongside mawashi; and a NEW top-level `master` lane holds
//   the WHOLE Master Rikishi roster (name + timeless background fields) so Gumbai can roll up
//   by stable/country/hometown/knownFor/highestRank across everyone, not just the current
//   banzuke. All of it is timeless background → the engine never gates it. Closes the
//   coverage gap that had Gumbai swearing it doesn't track stables (see
//   state/gumbai-coverage-audit.md). NEW rule: a Notion schema change triggers a snapshot
//   coverage check (state/naming-conventions.md).
//
// SCHEMA gumbai-snapshot/7 (2026-09-13): the completeness pass (Day-1, MJ). ADDS three timeless
//   reference lanes so Gumbai answers from the tracker, not from training memory:
//   bashos[] (venue/city + dates per tournament — the "which city was the July basho in" gap),
//   glossary[] (general sumo terms), library[] (books flagged "Gumbai May Cite"). ALSO projects the
//   last answerable Master Rikishi fields (story/debut/retirement/pastMawashi/family). Default flipped
//   from "add a table when someone hits the hole" to "project everything answerable." See
//   state/gumbai-coverage-audit.md.
//
// SCHEMA gumbai-snapshot/8 (2026-09-13): injuries CARRY OVER. Each condition now parses ALL its
//   Severity Log stamps (not just the current basho) and carries the most-recent PRIOR basho's
//   status as `priorCarry`. A condition left open last basho is treated as still real through the
//   intertournament gap; the engine surfaces `priorCarry` only before the viewer's Day 1 and expires
//   it once they've watched Day 1 (then the live board governs). We never infer "healed" — we can't
//   know until he fights. Prior basho is history, so this leaks nothing (Jennie's rule, 2026-09-13).
//
// SCHEMA gumbai-snapshot/9 (2026-09-22): the ANALYTICS registry. Emits a top-level `analytics` block
//   (dimensions + measures) that DECLARES, as DATA, what query_rollup can group by and compute — so a
//   new breakdown is one registry line RIGHT HERE next to the field projection, never a new engine
//   edit or a new tool. This replaces the hard-coded ROLLUP_FIELDS list in the engine, the thing that
//   silently lost the mawashi rollup in the schema/6 rewrite. A PARITY GUARD below fails the build
//   (red step, last-good snapshot kept) if an anchor dimension (mawashi/stable/country) stops
//   resolving — the tripwire that was missing when mawashi vanished. The engine also ships a fallback
//   default registry, so the two are belt-and-suspenders. See deliverables/Gumbai Analytical Layer —
//   Spec v1.md. Registry rule (state/naming-conventions.md): a clean new field → one dimension line
//   here; a new bout flag → one measure line; anything else is a genuinely new computation KIND (rare).
//
// SCHEMA gumbai-snapshot/10 (2026-09-22): the CARD layer. Folds tomorrow-card.json's `cards` MAP (every
//   PUBLISHED day's result-free pairings) and `today` ({date, tournamentDay}) into the snapshot. Matchups
//   are NOT results, so cards are UNGATED (Jennie: "matchups don't need gating, results do") — the engine
//   serves the viewer's own next day by default or ANY published day on request, while results stay gated
//   in `bouts`. `today` gives the model a real-world clock (it has none), so "who fights today" resolves
//   against a fact instead of a guess.
//
// SCHEMA gumbai-snapshot/11 (2026-09-22): HISTORY-SPANNING analytics. Adds the ungated `crewHistory` lane —
//   every PAST crew-tracked bout WITH its live nets (henka/kinboshi/boutOfDay/cushions/monoii), the SAME
//   data the rikishi dashboard reads for historical henka vs field-average. This is what lets the analytical
//   measures (and the new query_rate tool) span the WHOLE tracked history, not just this basho (Jennie:
//   "gumbai needs to glean and speak to ALL the historical information ... on the fly"). Past basho are not
//   spoilers, so crewHistory is ungated; the current basho stays gated in `bouts`. The large, relatively
//   static history pull rides its OWN resilient lane (empty + warn on failure) so it never breaks the small
//   dynamic daily snapshot; notion()'s 429/529 back-off lets that full pull complete.
//
// SCHEMA gumbai-snapshot/12 (2026-09-22): the SOURCE FRAMEWORK's historical partitions. Adds two lanes so
//   nearly every per-basho table now projects BOTH a current slice and a historical slice (not one table at
//   a time). `banzukeHistory` = the AUTHORITATIVE per-basho summary from the 📋 Banzuke table (rank, final
//   record, yusho = the champion with the playoff already resolved by whoever recorded it, special prizes,
//   gold stars, kyujo), past tournaments only, UNGATED + PUBLIC — so "who won X" and the per-basho career
//   read answer from Notion, not a sumo-api guess. `daysHistory` = past storylines/scorekeeper notes (the
//   Days table's historical partition), MEMBER + ungated. Both ride resilient unscoped pulls. The engine's
//   SOURCE_REGISTRY declares each lane's two-axis gate policy. See deliverables/Gumbai Source Framework —
//   Spec v1.md. (Note: Wins/Losses/Gold Stars are Match-Log ROLLUPS on the Banzuke row → rollNumOf.)
//
// SAFETY: validates the CORE (bouts/rikishi/banzuke) before writing; a broken core pull
// exits non-zero and writes nothing. The soft-data + stables pulls are each wrapped so a
// missing integration share (the classic Kimarite 404) degrades that ONE lane to empty +
// a warning, never aborting the snapshot.
//
// ENV: NOTION_TOKEN (required) · BASHO (default 202607) · OUT (default functions/api/_snapshot.js)
import fs from 'node:fs';
import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const OUT = process.env.OUT || 'functions/api/_snapshot.js';

// ─── PER-BASHO CONFIG — change these with the others each tournament ───────────
// (BASHO also changes in sync-notion.mjs/.yml and build-standings.mjs.)
const BASHO = process.env.BASHO || '202609';
const TOURNAMENT_PAGE_ID = '3351ade1-241f-8011-8987-d959538f54a0';
const BASHO_LABEL = 'Aki 2026';
const BASHO_STAMP = '26Ak';   // severity-log / catchphrase day stamp prefix (26<Basho>D#). Ht/Hr/Nt/Ng/Ak/Ky.
// ──────────────────────────────────────────────────────────────────────────────

const DB = {
  matchLog:      '1a2bad82-ebf5-4472-87ea-cb2c2481f9f1',
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
  kimarite:      '2591d1eb-2146-4745-ab0a-72ba57bfd213',
  stables:       'eff4e763-c792-422d-9c90-943f9315cb41',   // 🏠 Stables — resolves the Master Rikishi `Stable` relation to a name (schema/6)
  bashos:        'ae8b304d-8655-4072-934e-d01a43fe11ce',   // 🏆 Bashos — venue/city + dates per tournament (schema/7)
  glossary:      '3df93d5a-9566-41cf-b44b-59710622cfa7',   // 📖 Glossary — general sumo terms (schema/7)
  library:       '55cf6479-727e-46f5-a150-7bd0f710a93c',   // 📚 Library — books Gumbai May Cite (schema/7)
  // soft-data lanes (schema/4) — each must be shared with the sumo-site-publisher integration:
  days:          'eb0597c9-7259-49cd-babb-889f3b28f33d',
  injuryLog:     '7a44f06d-389d-4bd6-aa84-314225d06085',
  catchphrases:  '4d95409b-12f5-45ca-bc4d-b308c94f7576',
  announcers:    '0dff86b0-5a19-462f-a5ef-10f46af12e5a',
};

if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }

// ---------- Notion REST ----------
async function notion(path, method = 'GET', body, attempt = 0) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Rate-limit / overloaded → back off and retry (the bigger unscoped history pull can trip Notion's
  // per-token limit; the scoped pulls rarely did, which is why this was missing before).
  if ((res.status === 429 || res.status === 529) && attempt < 6) {
    const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return notion(path, method, body, attempt + 1);
  }
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
// Resilient soft-data pull: a missing share / 404 degrades this ONE lane to [] + warn.
async function queryLane(name, dbId, filter, warn) {
  try { return await queryAll(dbId, filter); }
  catch (e) { warn.push(`soft-data lane "${name}" pull FAILED (${String(e.message).slice(0,120)}) — is it shared with sumo-site-publisher? Lane emitted empty.`); return []; }
}

// ---------- property readers ----------
const idNoDash = s => String(s || '').replace(/-/g, '');
const titleOf = (p, prop) => { const x = p.properties?.[prop]; const a = x?.title || x?.rich_text || []; return a.map(t => t.plain_text).join('').trim(); };
const textOf  = (p, prop) => (p.properties?.[prop]?.rich_text || []).map(t => t.plain_text).join('').trim();
const selOf   = (p, prop) => p.properties?.[prop]?.select?.name ?? null;
const multiOf = (p, prop) => (p.properties?.[prop]?.multi_select || []).map(o => o.name);
const numOf   = (p, prop) => (typeof p.properties?.[prop]?.number === 'number' ? p.properties[prop].number : null);
// ROLLUP number reader (Banzuke Wins/Losses/Gold Stars are rollups from the Match Log, not plain numbers).
const rollNumOf = (p, prop) => { const r = p.properties?.[prop]?.rollup; return (r && typeof r.number === 'number') ? r.number : null; };
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

// Severity Log -> per-day entries. Only keeps lines carrying THIS basho's stamp (26NgD#),
// so it auto-scopes to the current tournament and gives the gate clean {day,text} rows.
function parseSeverity(text, stamp) {
  const out = [];
  if (!text) return out;
  const re = new RegExp(stamp + 'D(\\d+)');
  for (const raw of String(text).split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const m = line.match(re);
    if (!m) continue;                       // require a current-basho stamp
    out.push({ day: parseInt(m[1], 10), text: line });
  }
  return out.sort((a, b) => a.day - b.day);
}

// ── PRIOR-BASHO CARRY (schema/8) ──
// A basho stamp is <YY><Bb> (e.g. 26Ng). Order it so we can find the most-recent PRIOR basho in a
// Severity Log. An injury left open at the last basho is treated as still real through the
// intertournament gap and expires at the viewer's Day 1 (the engine's gate does the expiry).
const BASHO_IDX  = { Ht:0, Hr:1, Nt:2, Ng:3, Ak:4, Ky:5 };
const BASHO_FULL = { Ht:'Hatsu', Hr:'Haru', Nt:'Natsu', Ng:'Nagoya', Ak:'Aki', Ky:'Kyushu' };
const stampOrd   = s => { const m = String(s).match(/^(\d\d)(Ht|Hr|Nt|Ng|Ak|Ky)$/); return m ? (+m[1]) * 6 + BASHO_IDX[m[2]] : -1; };
const stampLabel = s => { const m = String(s).match(/^(\d\d)(Ht|Hr|Nt|Ng|Ak|Ky)$/); return m ? `${BASHO_FULL[m[2]]} 20${m[1]}` : String(s); };
const CUR_ORD    = stampOrd(BASHO_STAMP);
// Every stamped severity line, tagged with its basho stamp + ordinal (ALL bashos, not just current).
function parseAllSeverity(text) {
  const out = [];
  if (!text) return out;
  const re = /(\d\d(?:Ht|Hr|Nt|Ng|Ak|Ky))D(\d+)/;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const m = line.match(re);
    if (!m) continue;
    out.push({ stamp: m[1], day: parseInt(m[2], 10), text: line, ord: stampOrd(m[1]) });
  }
  return out;
}

async function main() {
  const warn = [];
  const scopedTournament = { property: 'Tournament', relation: { contains: TOURNAMENT_PAGE_ID } };
  const scopedBasho      = { property: 'Basho',      relation: { contains: TOURNAMENT_PAGE_ID } };
  const curTid = idNoDash(TOURNAMENT_PAGE_ID);   // current tournament id (partitions Match Log: current vs past)

  // CORE pull (standings-critical — a failure here SHOULD abort). The Match Log here is SCOPED to the
  // current basho: this is the small, dynamic, daily pull that MUST succeed. The much larger, relatively
  // static HISTORY (every past crew-tracked bout) is pulled SEPARATELY and RESILIENTLY below for the
  // ungated `crewHistory` lane (schema/11) — so a history hiccup degrades to empty + a warning and never
  // breaks the day's snapshot. (Jennie 2026-09-22: "history is relatively static, updated at the end of
  // every basho; this basho is dynamic daily" — so the two get different reliability contracts.)
  const [mrPages, bzPages, kmPages, mlPages] = await Promise.all([
    queryAll(DB.masterRikishi),
    queryAll(DB.banzuke, scopedTournament),
    queryAll(DB.kimarite),
    queryAll(DB.matchLog, scopedTournament),
  ]);
  console.log(`pulled CORE: rikishi=${mrPages.length} banzuke=${bzPages.length} kimarite=${kmPages.length} matchlog=${mlPages.length}`);

  // SOFT-DATA pull (schema/4) + Stables (schema/6) — each resilient (empty + warn on failure).
  const dayPages   = await queryLane('days', DB.days, scopedBasho, warn);
  const injPages   = await queryLane('injuries', DB.injuryLog, undefined, warn);   // no basho field; scoped below by 26Ng stamp
  const cpPages    = await queryLane('catchphrases', DB.catchphrases, undefined, warn);
  const annPages   = await queryLane('announcers', DB.announcers, undefined, warn);
  const stPages    = await queryLane('stables', DB.stables, undefined, warn);       // 🏠 Stables (schema/6) — resolves the Stable relation
  const bashoPages = await queryLane('bashos', DB.bashos, undefined, warn);         // 🏆 Bashos (schema/7) — venue/city + dates
  const glPages    = await queryLane('glossary', DB.glossary, undefined, warn);     // 📖 Glossary (schema/7) — general sumo terms
  const libPages   = await queryLane('library', DB.library, undefined, warn);       // 📚 Library (schema/7) — books Gumbai May Cite
  console.log(`pulled SOFT: days=${dayPages.length} injuries=${injPages.length} catchphrases=${cpPages.length} announcers=${annPages.length} stables=${stPages.length} bashos=${bashoPages.length} glossary=${glPages.length} library=${libPages.length}`);

  // Stable page id -> stable name (resolves Master Rikishi's `Stable` relation).
  const stableNameById = new Map();
  for (const p of stPages) { const n = titleOf(p, 'Name'); if (n) stableNameById.set(idNoDash(p.id), n); }

  // id -> canonical shikona (Master Rikishi), and id -> full profile
  const mrNameById = new Map();
  const mrProfById = new Map();
  for (const p of mrPages) {
    const name = titleOf(p, 'Ring Name'); if (!name) continue;
    mrNameById.set(idNoDash(p.id), name);
    const stId = rel1(p, 'Stable');
    mrProfById.set(idNoDash(p.id), {
      name,
      nicknames: parseNicknames(textOf(p, 'Nicknames')),
      country: selOf(p, 'Country of Origin'),
      hometown: textOf(p, 'Hometown') || null,       // ← schema/6: granular origin (city/prefecture)
      birthday: dateOf(p, 'Birthday'),
      highestRank: selOf(p, 'Highest Rank'),
      heightCm: numOf(p, 'Height (cm)'),
      mawashi: textOf(p, 'Mawashi Color') || null,   // current mawashi color (words), same field standings' hex map comes from
      stable: (stId && stableNameById.get(stId)) || null,   // ← schema/6: resolved stable name (the crew's Isegahama gap)
      knownFor: multiOf(p, 'Known For'),             // ← schema/6: curated trademarks (multi-select; [] when none)
      knownForNotes: textOf(p, 'Known For Notes') || null,  // ← schema/6
      realName: textOf(p, 'Real Name') || null,      // ← schema/6
      pastRingNames: textOf(p, 'Past Ring Names') || null,  // ← schema/6
      active: boolOf(p, 'Active'),                    // ← schema/6: still competing
      story: textOf(p, 'Story') || null,             // ← schema/7: the crew narrative (Lane-2 "tell me about X")
      debut: dateOf(p, 'Debut'),                     // ← schema/7
      retirement: dateOf(p, 'Retirement'),           // ← schema/7 (null = active)
      pastMawashi: textOf(p, 'Past Mawashi Colors') || null,  // ← schema/7
      familyIds: relIds(p, 'Family'),                // ← schema/7: resolved to names after the loop (self-relation)
      injuryNotes: textOf(p, 'Notes') || null,
      shikonaMeaning: textOf(p, 'Translation') || null,
    });
  }
  // Resolve the Family self-relation to canonical names now that every id→name is known (schema/7).
  for (const prof of mrProfById.values()) {
    prof.family = (prof.familyIds || []).map(id => mrNameById.get(id)).filter(Boolean);
    delete prof.familyIds;
  }
  // kimarite page id -> Japanese name (matches bout.kimarite)
  const kmNameById = new Map();
  for (const p of kmPages) { const n = textOf(p, 'Kimarite'); if (n) kmNameById.set(idNoDash(p.id), n); }
  // Days page id -> Day # (drives every soft-data day stamp), and Announcer page id -> name
  const dayNumById = new Map();
  for (const p of dayPages) { const n = numOf(p, 'Day #'); if (Number.isInteger(n)) dayNumById.set(idNoDash(p.id), n); }
  const annNameById = new Map();
  for (const p of annPages) { const n = titleOf(p, 'Announcer'); if (n) annNameById.set(idNoDash(p.id), n); }

  // ── bouts (scoped to this basho) + per-bout NETS ──
  const participants = new Set();
  const bouts = [];
  for (const p of mlPages) {   // mlPages is scoped to the current basho — every row is a gated live bout
    const day = numOf(p, 'Day #');
    const wId = rel1(p, 'Winner'), lId = rel1(p, 'Loser');
    const winner = wId && mrNameById.get(wId), loser = lId && mrNameById.get(lId);
    if (!Number.isInteger(day) || !winner || !loser) { warn.push(`bout skipped (day/winner/loser missing): ${titleOf(p, 'Match')}`); continue; }
    participants.add(wId); participants.add(lId);
    const tId = rel1(p, 'Technique');
    bouts.push({
      day, date: dateOf(p, 'Date'),
      winner, loser,
      kimarite: (tId && kmNameById.get(tId)) || null,
      goldStar: boolOf(p, 'Gold Star'),
      henka: selOf(p, 'Henka'),          // "Full" | "Partial" | null
      monoii: selOf(p, 'Monoii'),        // "Reversed (-R)" | "Stands (-S)" | "Rematch (-M)" | null
      // soft-data nets (all ride the bout, so already day-gated with it):
      boutOfDay: selOf(p, 'Bout of the Day'),   // "L" | "U" | null
      conduct: multiOf(p, 'Conduct'),           // [] or ["Crowd-pleaser", ...]
      conductNote: textOf(p, 'Conduct Note') || null,
      length: selOf(p, 'Length'),               // "*" | "1+ min" | "2+ min" | "3+ min" | "M" | null
      cushions: boolOf(p, 'Cushions'),
      rematch: boolOf(p, 'Rematch'),
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

  // ── rikishi[] = everyone on this banzuke OR who fought this basho ──
  const rosterIds = new Set(participants);
  for (const p of bzPages) { const rid = rel1(p, 'Rikishi'); if (rid) rosterIds.add(rid); }
  const rikishi = [...rosterIds].map(id => mrProfById.get(id)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── master[] : the WHOLE Master Rikishi roster (schema/6), slim + TIMELESS background only.
  //    Powers query_rollup's "master" scope and "on the master" questions beyond the current
  //    banzuke (retirees included). No results here, so the engine never gates it.
  const master = [...mrProfById.values()].map(r => ({
    name: r.name,
    stable: r.stable,
    country: r.country,
    hometown: r.hometown,
    knownFor: r.knownFor,
    highestRank: r.highestRank,
    active: r.active,
  })).sort((a, b) => a.name.localeCompare(b.name));

    // mawashi color must end in a family word (last-word convention) — warn on any that don't.
  const FAM_WORDS = ['purple','blue','red','green','teal','brown','black','grey','gray','pink'];
  for(const r of rikishi){
    if(!r.mawashi) continue;
    const last = String(r.mawashi).trim().split(/\s+/).pop().toLowerCase();
    if(!FAM_WORDS.includes(last)) warn.push(`mawashi color off-convention (last word "${last}"): ${r.name} = "${r.mawashi}"`);
  }

  // ── analytics[] (schema/9) : the DATA registry query_rollup executes. Declared HERE, next to the
  //    field projection above, so a dropped field drops its dimension line right beside it (this
  //    colocation is what prevents the mawashi-style silent loss). The engine (_engine.js) executes
  //    it and also carries a fallback default — the two are belt-and-suspenders. Every measure reads
  //    the ALREADY-GATED view in the engine, so nothing here is a spoiler.
  //    HOW TO EXTEND (state/naming-conventions.md): a clean new profile field → one `dimensions` line
  //    (add a `normalize` only for a family-bucket field like mawashi); a new bout flag → one
  //    `measures` line of kind 'bout'; a new per-wrestler number → kind 'num'. A genuinely new
  //    computation shape (a new `kind`) is the only thing that also touches the engine.
  const analytics = {
    dimensions: [
      { key:'stable',      label:'stable',        field:'stable',      audience:'public', defaultScope:'master' },
      { key:'country',     label:'country',       field:'country',     audience:'public', defaultScope:'master' },
      { key:'hometown',    label:'hometown',      field:'hometown',    audience:'public', defaultScope:'master' },
      { key:'highestRank', label:'highest rank',  field:'highestRank', audience:'public', defaultScope:'master' },
      { key:'knownFor',    label:'known for',     field:'knownFor',    audience:'member', defaultScope:'master', multi:true },
      { key:'mawashi',     label:'mawashi color', field:'mawashi',     audience:'public', defaultScope:'roster', normalize:'lastWord', rosterOnly:true },
    ],
    measures: [
      { key:'count',     label:'wrestlers',        kind:'count',  audience:'public' },
      { key:'wins',      label:'wins',             kind:'bout', attribution:'winner',                  audience:'public', defaultAgg:'sum' },
      { key:'losses',    label:'losses',           kind:'bout', attribution:'loser',                   audience:'public', defaultAgg:'sum' },
      { key:'kinboshi',  label:'kinboshi',         kind:'bout', attribution:'winner', flag:'goldStar', audience:'public', defaultAgg:'sum' },
      { key:'henka',     label:'henka',            kind:'bout', attribution:'winner', flag:'henka',    audience:'public', defaultAgg:'sum' },
      { key:'monoii',    label:'monoii',           kind:'bout', attribution:'either', flag:'monoii',   audience:'public', defaultAgg:'sum' },
      { key:'cushions',  label:'cushions thrown',  kind:'bout', attribution:'either', flag:'cushions', audience:'member', defaultAgg:'sum' },
      { key:'boutOfDay', label:'bouts of the day', kind:'bout', attribution:'either', flag:'boutOfDay',audience:'member', defaultAgg:'sum' },
      { key:'weight',    label:'weight (kg)',      kind:'num', source:'banzuke', field:'weightKg', audience:'public', defaultAgg:'avg' },
      { key:'height',    label:'height (cm)',      kind:'num', source:'profile', field:'heightCm', audience:'public', defaultAgg:'avg' },
      { key:'age',       label:'age',              kind:'num', source:'age',                       audience:'public', defaultAgg:'avg' },
    ],
  };

  // ── PARITY GUARD (schema/9) : the registry must actually resolve against the data we just built.
  //    This is the tripwire that was missing when the mawashi rollup silently vanished in the
  //    schema/6 rewrite: if an ANCHOR dimension (mawashi/stable/country) stops producing groups — a
  //    renamed/dropped field, or a dimension missing from the registry — the build goes RED HERE
  //    (exit 1, nothing written, last-good snapshot kept) instead of the oracle quietly forgetting
  //    how to answer. Anchors check against the rows they read from (mawashi → current roster;
  //    stable/country → master, falling back to roster if master is empty).
  {
    const lastWord = v => { const s = String(v || '').trim(); return s ? s.split(/\s+/).pop().toLowerCase() : null; };
    const distinct = (rows, get) => new Set(rows.map(get).filter(Boolean)).size;
    const stableSrc = master.length ? master : rikishi;
    const anchors = [
      { key:'mawashi', groups: distinct(rikishi,   r => lastWord(r.mawashi)), have: rikishi.length },
      { key:'stable',  groups: distinct(stableSrc, r => r.stable),            have: stableSrc.length },
      { key:'country', groups: distinct(stableSrc, r => r.country),           have: stableSrc.length },
    ];
    const declared = new Set(analytics.dimensions.map(d => d.key));
    const missing = ['mawashi', 'stable', 'country'].filter(k => !declared.has(k));
    const broken  = anchors.filter(a => a.have > 0 && a.groups === 0);
    if (missing.length || broken.length) {
      console.error('ABORT — analytics parity guard failed (a dimension that should resolve does not — the mawashi-style silent loss is back):');
      for (const k of missing) console.error(`  - anchor dimension "${k}" is MISSING from the analytics registry`);
      for (const b of broken)  console.error(`  - dimension "${b.key}" resolves to 0 groups over ${b.have} rows (field renamed/dropped?)`);
      process.exit(1);
    }
    console.log(`  ✓ analytics parity: ${analytics.dimensions.length} dimensions, ${analytics.measures.length} measures; anchors resolve (mawashi=${anchors[0].groups} families · stable=${anchors[1].groups} · country=${anchors[2].groups})`);
  }

  // ── kimarite glossary ──
  const kimarite = kmPages.map(p => {
    const name = textOf(p, 'Kimarite'); if (!name) return null;
    const description = textOf(p, 'Description');
    return description ? { name, description } : { name };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));

  // ── bashos[] (schema/7) : venue/city + dates per tournament. TIMELESS — set before the
  //    tournament, carries no results — so the engine never gates it. `code` (YYYYMM, derived
  //    from Start Date) matches meta.bashoId so "July 2026 / 202607 / Nagoya 2026" all resolve.
  //    NOTE: `Notes` (memorable storylines) is deliberately EXCLUDED — for the CURRENT basho it
  //    would be a spoiler; revisit with per-basho gating if the crew wants past-basho recaps here.
  const bashos = bashoPages.map(p => {
    const start = dateOf(p, 'Start Date');            // "YYYY-MM-DD"
    const code = start ? start.slice(0, 4) + start.slice(5, 7) : null;   // YYYYMM
    return {
      code,
      tournamentName: titleOf(p, 'Tournament Name') || null,   // e.g. "2026 September - Aki"
      basho: selOf(p, 'Basho'),                                // Hatsu | Haru | Natsu | Nagoya | Aki | Kyushu
      year: numOf(p, 'Year'),
      location: selOf(p, 'Location'),                          // "IG Arena - Nagoya", etc. (city + venue)
      startDate: start,
      endDate: dateOf(p, 'End Date'),
    };
  }).filter(b => b.location || b.startDate || b.basho)
    .sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));

  // ── glossary[] (schema/7) : general sumo vocabulary. Timeless reference, never gated.
  const glossary = glPages.map(p => {
    const term = titleOf(p, 'Term'); if (!term) return null;
    const definition = textOf(p, 'Definition');
    return { term, definition: definition || null, type: selOf(p, 'Type') };   // type: term | technique | name
  }).filter(Boolean).sort((a, b) => a.term.localeCompare(b.term));

  // ── library[] (schema/7) : books Gumbai is CLEARED to reference. Honor the "Gumbai May Cite"
  //    checkbox — only cite-approved books enter the snapshot; the File upload is never carried.
  const library = libPages.filter(p => boolOf(p, 'Gumbai May Cite')).map(p => ({
    title: titleOf(p, 'Title') || null,
    author: textOf(p, 'Author') || null,
    year: numOf(p, 'Year'),
    themes: multiOf(p, 'Themes'),           // Culture | History | Biography | Technique | Philosophy | Reference
    notes: textOf(p, 'Notes') || null,
  })).filter(b => b.title).sort((a, b) => a.title.localeCompare(b.title));

  // ── days[] : storylines + scorekeeper notes, one per day (color layer) ──
  const days = [];
  for (const p of dayPages) {
    const day = numOf(p, 'Day #');
    if (!Number.isInteger(day)) continue;         // skip untagged rows
    const aId = rel1(p, 'Announcer');
    days.push({
      day,
      storylines: textOf(p, 'Storylines') || null,
      scorekeeperNotes: textOf(p, 'Scorekeeper Notes') || null,   // Jennie's human day-notes
      announcer: (aId && annNameById.get(aId)) || null,
    });
  }
  days.sort((a, b) => a.day - b.day);

  // ── injuries[] : the 3-track repair-order board, day-stamped for the gate ──
  // Keep the three cause tracks SEPARATE (never collapse). severity[] is parsed to {day,text}
  // and the gate filters it per-viewer-day; onsetDay/fullMaxDay drive hide-until-onset + caught-up.
  const injuries = [];
  for (const p of injPages) {
    const allSev = parseAllSeverity(textOf(p, 'Severity Log'));
    const severity = allSev.filter(e => e.stamp === BASHO_STAMP).map(e => ({ day: e.day, text: e.text })).sort((a, b) => a.day - b.day);
    // Most-recent PRIOR basho present in this row → the carried assessment (schema/8). Prior basho is
    // over, so it's history: safe to surface, and the engine only shows it before the viewer's Day 1.
    const prior = allSev.filter(e => e.ord >= 0 && e.ord < CUR_ORD);
    let priorCarry = null;
    if (prior.length) {
      const pOrd = Math.max(...prior.map(e => e.ord));
      const pEntries = prior.filter(e => e.ord === pOrd).sort((a, b) => a.day - b.day);
      priorCarry = {
        basho: stampLabel(pEntries[0].stamp),                 // e.g. "Nagoya 2026"
        status: selOf(p, 'Status') || null,                   // last recorded status (carries from the prior basho if untouched since)
        note: pEntries[pEntries.length - 1].text || null,     // last severity line from that prior basho
      };
    }
    if (!severity.length && !priorCarry) continue;            // nothing this basho, nothing carried → not tracked
    const rId = rel1(p, 'Rikishi');
    const rikishiName = (rId && mrNameById.get(rId)) || null;
    const onsetRel = rel1(p, 'Onset Day');
    const onsetDay = severity.length ? ((onsetRel && dayNumById.get(onsetRel)) ?? severity[0].day) : 99;   // 99 = no current-basho onset (carry-only row)
    const fullMaxDay = severity.length ? Math.max(onsetDay, ...severity.map(s => s.day)) : onsetDay;
    injuries.push({
      rikishi: rikishiName,
      condition: titleOf(p, 'Condition'),          // may name a future day → gate withholds until caught-up
      area: textOf(p, 'Area') || null,
      setting: selOf(p, 'Setting'),
      nature: multiOf(p, 'Nature'),
      status: selOf(p, 'Status'),                  // gate masks this until caught-up
      officialReason: textOf(p, 'Official Reason') || null,   // a CLAIM, not truth
      boothRead: textOf(p, 'Booth Read') || null,
      scorekeeperEye: textOf(p, 'Scorekeeper Eye') || null,   // Jennie's human eyewitness read
      source: multiOf(p, 'Source'),
      onsetDay, fullMaxDay,
      severity,                                    // [{day, text}] sorted (current basho)
      priorCarry,                                  // schema/8: last basho's carried status (engine surfaces pre-Day-1, expires after)
    });
  }

  // ── catchphrases[] : per announcer, day-tagged (count is a FLOOR; giggle/jewel = human seed) ──
  const catchphrases = [];
  for (const p of cpPages) {
    const aId = rel1(p, 'Announcer');
    const daysSeen = relIds(p, 'Days Seen').map(id => dayNumById.get(id)).filter(n => Number.isInteger(n)).sort((a, b) => a - b);
    catchphrases.push({
      phrase: titleOf(p, 'Phrase'),
      announcer: (aId && annNameById.get(aId)) || null,
      days: daysSeen,                              // [] = timeless signature (e.g. sign-off); gate treats as ungated
      giggle: numOf(p, 'Giggle Rank'),      // 1-5 human seed (Notion property is "Giggle Rank"), often null (sparse)
      jewel: boolOf(p, 'Jewel'),
    });
  }

  // ── crewHistory[] (schema/11): every PAST crew-tracked bout WITH the crew's live nets — the SAME data
  //    the rikishi dashboard reads for its historical henka / field average. UNGATED (past basho are not
  //    spoilers); the current basho stays gated in `bouts`. This is what lets Gumbai glean + analyze
  //    across the whole tracked history on the fly.
  //    RESILIENT + SEPARATE (schema/11, 2026-09-22): this is the LARGE, relatively-static pull, so it
  //    rides its own resilient lane (empty + warn on failure) rather than the standings-critical CORE.
  //    History changes once per basho; the daily snapshot must never break because a big unscoped pull
  //    hiccuped. The notion() back-off (429/529 retry) lets this full pull actually complete.
  const mlAllPages = await queryLane('matchlog-all', DB.matchLog, undefined, warn);
  const bashoLabelById = new Map();   // tournament page id -> "Aki 2026" (the Bashos pages ARE the Tournament relation targets)
  for (const p of bashoPages) {
    const bn = selOf(p, 'Basho'); const yr = numOf(p, 'Year');
    const label = (bn && yr) ? `${bn} ${yr}` : (titleOf(p, 'Tournament Name') || null);
    if (label) bashoLabelById.set(idNoDash(p.id), label);
  }
  const crewHistory = [];
  for (const p of mlAllPages) {
    const tid = rel1(p, 'Tournament');
    if (!tid || tid === curTid) continue;             // current basho stays in the gated `bouts` lane
    const wId = rel1(p, 'Winner'), lId = rel1(p, 'Loser');
    const winner = wId && mrNameById.get(wId), loser = lId && mrNameById.get(lId);
    if (!winner || !loser) continue;
    const tId = rel1(p, 'Technique');
    crewHistory.push({
      basho: bashoLabelById.get(tid) || null,
      day: numOf(p, 'Day #'),
      winner, loser,
      kimarite: (tId && kmNameById.get(tId)) || null,
      goldStar: boolOf(p, 'Gold Star'),
      henka: selOf(p, 'Henka'),
      monoii: selOf(p, 'Monoii'),
      boutOfDay: selOf(p, 'Bout of the Day'),
      cushions: boolOf(p, 'Cushions'),
    });
  }
  if (crewHistory.length) console.log(`  + crewHistory: ${crewHistory.length} past crew-tracked bouts (with nets) — ungated`);
  else warn.push('crewHistory[] empty — no past crew-tracked bouts in the Match Log (or all rows are the current basho). History-spanning nets will be current-basho only until past basho accrue.');

  // tournament page id -> YYYYMM code (the Bashos pages ARE the Tournament relation targets). Keys the
  // per-basho history maps by code so they line up with the sumo-api `history` lane and meta.bashoId.
  const bashoCodeById = new Map();
  for (const p of bashoPages) {
    const start = dateOf(p, 'Start Date');
    const code = start ? start.slice(0, 4) + start.slice(5, 7) : null;
    if (code) bashoCodeById.set(idNoDash(p.id), code);
  }

  // ── banzukeHistory (schema/12, the Source Framework): the AUTHORITATIVE per-basho SUMMARY straight
  //    from the Notion 📋 Banzuke table — rank, final record, yusho (the champion, playoff already
  //    resolved by whoever recorded it), special prizes (sansho), gold stars, kyujo. PAST tournaments
  //    ONLY (the current basho's Yusho isn't set until senshuraku, so it stays in the gated `champion`
  //    lane — no spoiler). UNGATED + PUBLIC (officially-recorded). This is what lets "who won X" and the
  //    per-basho career read answer from Notion instead of a sumo-api guess or a bout-count derivation.
  //    Wins/Losses/Gold Stars are ROLLUPS from the Match Log (rollNumOf, not numOf). See the Source
  //    Framework spec. RESILIENT unscoped pull (empty + warn on failure, never breaks the daily snapshot).
  const bzAllPages = await queryLane('banzuke-all', DB.banzuke, undefined, warn);
  const banzukeHistory = {};   // YYYYMM code -> { label, rikishi:[{name,rank,wins,losses,yusho,prizes,goldStars,absences}], yusho:[names] }
  for (const p of bzAllPages) {
    const tid = rel1(p, 'Tournament');
    if (!tid || tid === curTid) continue;                          // current basho stays gated (champion lane)
    const rid = rel1(p, 'Rikishi');
    const name = (rid && mrNameById.get(rid)) || titleOf(p, 'Entry').split(' — ')[0].trim();
    if (!name) continue;
    const code = bashoCodeById.get(tid) || tid;
    const b = banzukeHistory[code] || (banzukeHistory[code] = { label: bashoLabelById.get(tid) || null, rikishi: [], yusho: [] });
    const won = boolOf(p, 'Yusho');
    b.rikishi.push({
      name,
      rank: selOf(p, 'Rank'),
      wins: rollNumOf(p, 'Wins'),
      losses: rollNumOf(p, 'Losses'),
      yusho: won,
      prizes: multiOf(p, 'Special Prizes'),                        // [] or ["Technique", "Fighting Spirit", ...]
      goldStars: rollNumOf(p, 'Gold Stars'),
      absences: numOf(p, 'Absences'),
    });
    if (won) b.yusho.push(name);
  }
  const bzHistN = Object.keys(banzukeHistory).length;
  if (bzHistN) console.log(`  + banzukeHistory: ${bzHistN} past basho (authoritative yusho/prizes/records from the Banzuke table)`);
  else warn.push('banzukeHistory empty — no PAST Banzuke entries resolved (unscoped 📋 Banzuke pull failed/unshared, or every entry is the current basho). "Who won X" falls back to the sumo-api history lane + the crewHistory derivation.');

  // ── daysHistory (schema/12): the PAST storylines + scorekeeper notes (the Days table's historical
  //    partition). MEMBER (crew-authored color), UNGATED (past basho are not spoilers). Mirrors the
  //    current `days` lane but for completed basho. Resilient unscoped pull.
  const dayAllPages = await queryLane('days-all', DB.days, undefined, warn);
  const daysHistory = [];
  for (const p of dayAllPages) {
    const bId = rel1(p, 'Basho');
    if (!bId || bId === curTid) continue;                          // current basho stays in the gated `days` lane
    const day = numOf(p, 'Day #');
    if (!Number.isInteger(day)) continue;
    const aId = rel1(p, 'Announcer');
    const storylines = textOf(p, 'Storylines') || null;
    const scorekeeperNotes = textOf(p, 'Scorekeeper Notes') || null;
    if (!storylines && !scorekeeperNotes) continue;                // nothing to carry
    daysHistory.push({
      basho: bashoLabelById.get(bId) || null,
      day, storylines, scorekeeperNotes,
      announcer: (aId && annNameById.get(aId)) || null,
    });
  }
  daysHistory.sort((a, b) => String(a.basho).localeCompare(String(b.basho)) || a.day - b.day);
  if (daysHistory.length) console.log(`  + daysHistory: ${daysHistory.length} past day notes (member, ungated)`);

  const maxDay = Math.max(0, ...bouts.map(b => b.day));

  // A brand-new basho (banzuke announced, Day 1 not yet fought) legitimately has 0 bouts / maxDay 0.
  // Detect that so the "no bouts = broken pull" guard doesn't misfire at the banzuke drop.
  const preStart = banzuke.length > 0 && bouts.length === 0;

  // ── validate CORE before writing (fail safe: never commit a broken snapshot) ──
  const problems = [];
  if (!banzuke.length) problems.push('0 banzuke');   // the true "is this basho set up" signal
  if (!rikishi.length) problems.push('0 rikishi');
  // Bouts/maxDay only matter once the basho is underway; a pre-start basho is a valid rosters-only snapshot.
  if (!preStart) {
    if (!bouts.length) problems.push('0 bouts');
    if (maxDay < 1) problems.push('maxDay < 1');
  }
  if (problems.length) { console.error('ABORT — core snapshot looks broken: ' + problems.join(', ')); process.exit(1); }
  if (preStart) console.log('ℹ️ pre-start basho: banzuke present, 0 bouts — rosters-only snapshot (results begin Day 1).');
  // Soft-data lanes are advisory: warn if empty but DO NOT abort (Gumbai still runs on results).
  if (!days.length) warn.push('days[] empty (storylines/scorekeeper notes absent)');
  if (!injuries.length) warn.push('injuries[] empty');
  if (!catchphrases.length) warn.push('catchphrases[] empty');
  if (!master.length) warn.push('master[] empty (Master Rikishi pull returned nothing?)');
  if (!stableNameById.size) warn.push('stables[] empty — Stable relation will not resolve (is 🏠 Stables shared with sumo-site-publisher?)');
  if (!bashos.length) warn.push('bashos[] empty — basho venue/date lane will not resolve (is 🏆 Bashos shared with sumo-site-publisher?)');
  if (!glossary.length) warn.push('glossary[] empty (📖 Glossary shared? — non-fatal)');
  if (!library.length) warn.push('library[] empty (no "Gumbai May Cite" books, or 📚 Library not shared — non-fatal)');

  // ── fold in the static historical layer (past basho; NEVER gated) ──
  let history = null;
  try {
    const h = JSON.parse(fs.readFileSync('sumo-history.json', 'utf8'));
    history = { meta: h.meta || {}, basho: h.basho || {} };
    console.log(`  + history: ${Object.keys(history.basho).length} past basho folded in`);
  } catch (e) { console.warn('  (no sumo-history.json — Gumbai runs without history):', e.message); }

  // ── fold in the CARDS (UNGATED — a scheduled bout has no result) + the real-world today anchor ──
  //    `upcoming` = the single next scheduled card (back-compat); `cards` = every PUBLISHED day's
  //    result-free pairings (schema/10) so the engine serves the viewer's own next day or ANY
  //    published day; `today` = { date, tournamentDay } so the model has a real-world clock. Matchups
  //    are not results, so none of this is gated (Jennie 2026-09-22: "matchups don't need gating").
  let upcoming = null, cards = null, today = null;
  try {
    const u = JSON.parse(fs.readFileSync('tomorrow-card.json', 'utf8'));
    upcoming = (u && !u.empty && Array.isArray(u.matchups) && u.matchups.length)
      ? { meta: u.meta || {}, day: u.day, date: u.date, matchups: u.matchups }
      : { empty: true, day: (u && u.day) || null };
    if (u && u.cards && typeof u.cards === 'object') cards = u.cards;
    if (u && u.today) today = u.today;
    const nCards = cards ? Object.keys(cards).length : 0;
    console.log(`  + upcoming: ${upcoming.empty ? 'none' : `Day ${upcoming.day} (${upcoming.matchups.length} matchups)`}; cards: ${nCards} published day(s); today: ${today ? `${today.date} (Day ${today.tournamentDay ?? '?'})` : 'none'}`);
  } catch (e) { console.warn('  (no tomorrow-card.json — Gumbai runs without cards/upcoming):', e.message); }

  // ── current-basho champion (yusho): sumo-api, the SAME source of truth as the standings page ──
  // The `yusho` array is EMPTY until the tournament is officially over (playoff included), so this stays
  // null mid-basho and no champion is ever baked in. The engine ALSO gates it behind the viewer's
  // final-day watch (defense in depth — see gateSnapshot). CHAMPION_NAME env is a test hook.
  let champion = null;
  try {
    let champName = null;
    if (process.env.CHAMPION_NAME !== undefined) {
      champName = process.env.CHAMPION_NAME || null;
    } else {
      const res = await fetch(`https://www.sumo-api.com/api/basho/${BASHO}`);
      if (res.ok) {
        const j = await res.json();
        const arr = Array.isArray(j.yusho) ? j.yusho : [];
        const mk = arr.find(y => /makuuchi/i.test(String((y && (y.type || y.division)) || '')));
        champName = mk ? (mk.shikonaEn || mk.shikona || mk.rikishiEn || null) : null;
      }
    }
    if (champName) {
      // normalize to the crew's canonical roster name so the engine's strict name match holds
      const nrm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
      const match = rikishi.find(r => nrm(r.name) === nrm(champName));
      const canonical = match ? match.name : champName;
      // playoff = more than one wrestler tied on the top win-count (records alone can't name the winner).
      // Safe even from partial logging: the champion only ever REVEALS at gate>=15, by when day 15 is logged.
      const winsOf = nm => bouts.filter(b => b.winner === nm).length;
      const names = [...new Set(bouts.flatMap(b => [b.winner, b.loser]))];
      const maxW = Math.max(0, ...names.map(winsOf));
      const tiedAtTop = names.filter(nm => winsOf(nm) === maxW).length;
      champion = { name: canonical, playoff: maxW > 0 && tiedAtTop > 1 };
      console.log(`  + champion: ${champion.name}${champion.playoff ? ' (playoff)' : ''}`);
    } else {
      console.log('  + champion: none yet (basho not complete / no yusho posted)');
    }
  } catch (e) { console.warn('  (champion fetch failed — Gumbai runs without a current champion):', e.message); }

  const snapshot = {
    meta: {
      basho: BASHO_LABEL, bashoId: BASHO,
      horizon: 'Live data is the current basho; history goes back to Jan 2025 (when the crew got into sumo).',
      maxDay, schema: 'gumbai-snapshot/12', source: 'notion',
    },
    rikishi, banzuke, kimarite, bouts,
    master,                            // schema/6: whole Master Rikishi roster (timeless) for rollups & "on the master"
    bashos, glossary, library,         // schema/7: venue/dates · general sumo terms · citable books (all timeless)
    analytics,                         // schema/9: registry (dimensions + measures) query_rollup executes (timeless metadata)
    days, injuries, catchphrases,     // schema/4 soft-data lanes
    champion,                          // schema/5: current-basho yusho (null until complete; engine gates reveal)
    history,
    upcoming,                          // schema/3: the single next scheduled card (back-compat)
    cards,                             // schema/10: every PUBLISHED day's result-free pairings (ungated — a matchup is not a result)
    today,                             // schema/10: real-world anchor { date, tournamentDay } so the model has a clock
    crewHistory,                       // schema/11: past crew-tracked bouts WITH nets (ungated) — history-spanning analytics + query_rate
    banzukeHistory,                    // schema/12: AUTHORITATIVE per-basho summary from Banzuke (yusho/prizes/record/rank), past only, public
    daysHistory,                       // schema/12: past storylines/scorekeeper notes (member, ungated) — the Days table's historical partition
  };

  const banner = `// AUTO-GENERATED by gen-gumbai-snapshot.mjs from Notion — do not edit by hand.
// Server-side only (Cloudflare Pages excludes /functions from static assets).
// Holds every day; the Function gates it per-viewer before Claude ever sees it.
`;
  fs.mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(OUT, banner + 'export default ' + JSON.stringify(snapshot) + ';\n');

  console.log(`✓ wrote ${OUT}`);
  console.log(`  basho=${BASHO_LABEL} maxDay=${maxDay} rikishi=${rikishi.length} master=${master.length} banzuke=${banzuke.length} kimarite=${kimarite.length} bouts=${bouts.length}`);
  console.log(`  ref: bashos=${bashos.length} glossary=${glossary.length} library=${library.length}  analytics: dims=${analytics.dimensions.length} measures=${analytics.measures.length}`);
  console.log(`  soft: days=${days.length} injuries=${injuries.length} catchphrases=${catchphrases.length}`);
  if (warn.length) { console.log('⚠️ warnings:'); for (const w of [...new Set(warn)]) console.log('  - ' + w); }
}
main().catch(e => { console.error(e); process.exit(1); });
