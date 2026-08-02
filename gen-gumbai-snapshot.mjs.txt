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
// SAFETY: validates the CORE (bouts/rikishi/banzuke) before writing; a broken core pull
// exits non-zero and writes nothing. The four soft-data pulls are each wrapped so a missing
// integration share (the classic Kimarite 404) degrades that ONE lane to empty + a warning,
// never aborting the snapshot.
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
const BASHO_STAMP = '26Ng';   // severity-log / catchphrase day stamp prefix (26<Basho>D#). Ht/Hr/Nt/Ng/Ak/Ky.
// ──────────────────────────────────────────────────────────────────────────────

const DB = {
  matchLog:      '1a2bad82-ebf5-4472-87ea-cb2c2481f9f1',
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
  kimarite:      '2591d1eb-2146-4745-ab0a-72ba57bfd213',
  // soft-data lanes (schema/4) — each must be shared with the sumo-site-publisher integration:
  days:          'eb0597c9-7259-49cd-babb-889f3b28f33d',
  injuryLog:     '7a44f06d-389d-4bd6-aa84-314225d06085',
  catchphrases:  '4d95409b-12f5-45ca-bc4d-b308c94f7576',
  announcers:    '0dff86b0-5a19-462f-a5ef-10f46af12e5a',
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

async function main() {
  const warn = [];
  const scopedTournament = { property: 'Tournament', relation: { contains: TOURNAMENT_PAGE_ID } };
  const scopedBasho      = { property: 'Basho',      relation: { contains: TOURNAMENT_PAGE_ID } };

  // CORE pull (standings-critical — a failure here SHOULD abort). Same as /3.
  const [mrPages, bzPages, kmPages, mlPages] = await Promise.all([
    queryAll(DB.masterRikishi),
    queryAll(DB.banzuke, scopedTournament),
    queryAll(DB.kimarite),
    queryAll(DB.matchLog, scopedTournament),
  ]);
  console.log(`pulled CORE: rikishi=${mrPages.length} banzuke=${bzPages.length} kimarite=${kmPages.length} matchlog=${mlPages.length}`);

  // SOFT-DATA pull (schema/4) — each resilient (empty + warn on failure).
  const dayPages   = await queryLane('days', DB.days, scopedBasho, warn);
  const injPages   = await queryLane('injuries', DB.injuryLog, undefined, warn);   // no basho field; scoped below by 26Ng stamp
  const cpPages    = await queryLane('catchphrases', DB.catchphrases, undefined, warn);
  const annPages   = await queryLane('announcers', DB.announcers, undefined, warn);
  console.log(`pulled SOFT: days=${dayPages.length} injuries=${injPages.length} catchphrases=${cpPages.length} announcers=${annPages.length}`);

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
  // Days page id -> Day # (drives every soft-data day stamp), and Announcer page id -> name
  const dayNumById = new Map();
  for (const p of dayPages) { const n = numOf(p, 'Day #'); if (Number.isInteger(n)) dayNumById.set(idNoDash(p.id), n); }
  const annNameById = new Map();
  for (const p of annPages) { const n = titleOf(p, 'Announcer'); if (n) annNameById.set(idNoDash(p.id), n); }

  // ── bouts (scoped to this basho) + per-bout NETS ──
  const participants = new Set();
  const bouts = [];
  for (const p of mlPages) {
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

  // ── kimarite glossary ──
  const kimarite = kmPages.map(p => {
    const name = textOf(p, 'Kimarite'); if (!name) return null;
    const description = textOf(p, 'Description');
    return description ? { name, description } : { name };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));

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
    const severity = parseSeverity(textOf(p, 'Severity Log'), BASHO_STAMP);
    if (!severity.length) continue;               // no current-basho stamp → not this tournament
    const rId = rel1(p, 'Rikishi');
    const rikishiName = (rId && mrNameById.get(rId)) || null;
    const onsetRel = rel1(p, 'Onset Day');
    const onsetDay = (onsetRel && dayNumById.get(onsetRel)) ?? severity[0].day;   // Onset Day rel, else earliest stamp
    const fullMaxDay = Math.max(onsetDay, ...severity.map(s => s.day));
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
      severity,                                    // [{day, text}] sorted
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

  const maxDay = Math.max(0, ...bouts.map(b => b.day));

  // ── validate CORE before writing (fail safe: never commit a broken snapshot) ──
  const problems = [];
  if (!bouts.length) problems.push('0 bouts');
  if (!rikishi.length) problems.push('0 rikishi');
  if (!banzuke.length) problems.push('0 banzuke');
  if (maxDay < 1) problems.push('maxDay < 1');
  if (problems.length) { console.error('ABORT — core snapshot looks broken: ' + problems.join(', ')); process.exit(1); }
  // Soft-data lanes are advisory: warn if empty but DO NOT abort (Gumbai still runs on results).
  if (!days.length) warn.push('days[] empty (storylines/scorekeeper notes absent)');
  if (!injuries.length) warn.push('injuries[] empty');
  if (!catchphrases.length) warn.push('catchphrases[] empty');

  // ── fold in the static historical layer (past basho; NEVER gated) ──
  let history = null;
  try {
    const h = JSON.parse(fs.readFileSync('sumo-history.json', 'utf8'));
    history = { meta: h.meta || {}, basho: h.basho || {} };
    console.log(`  + history: ${Object.keys(history.basho).length} past basho folded in`);
  } catch (e) { console.warn('  (no sumo-history.json — Gumbai runs without history):', e.message); }

  // ── fold in the next-day card (UNGATED — a scheduled bout has no result) ──
  let upcoming = null;
  try {
    const u = JSON.parse(fs.readFileSync('tomorrow-card.json', 'utf8'));
    upcoming = (u && !u.empty && Array.isArray(u.matchups) && u.matchups.length)
      ? { meta: u.meta || {}, day: u.day, date: u.date, matchups: u.matchups }
      : { empty: true, day: (u && u.day) || null };
    console.log(upcoming.empty ? '  + upcoming: none' : `  + upcoming: Day ${upcoming.day} card, ${upcoming.matchups.length} matchups`);
  } catch (e) { console.warn('  (no tomorrow-card.json — Gumbai runs without upcoming):', e.message); }

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
      maxDay, schema: 'gumbai-snapshot/5', source: 'notion',
    },
    rikishi, banzuke, kimarite, bouts,
    days, injuries, catchphrases,     // schema/4 soft-data lanes
    champion,                          // schema/5: current-basho yusho (null until complete; engine gates reveal)
    history,
    upcoming,
  };

  const banner = `// AUTO-GENERATED by gen-gumbai-snapshot.mjs from Notion — do not edit by hand.
// Server-side only (Cloudflare Pages excludes /functions from static assets).
// Holds every day; the Function gates it per-viewer before Claude ever sees it.
`;
  fs.mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(OUT, banner + 'export default ' + JSON.stringify(snapshot) + ';\n');

  console.log(`✓ wrote ${OUT}`);
  console.log(`  basho=${BASHO_LABEL} maxDay=${maxDay} rikishi=${rikishi.length} banzuke=${banzuke.length} kimarite=${kimarite.length} bouts=${bouts.length}`);
  console.log(`  soft: days=${days.length} injuries=${injuries.length} catchphrases=${catchphrases.length}`);
  if (warn.length) { console.log('⚠️ warnings:'); for (const w of [...new Set(warn)]) console.log('  - ' + w); }
}
main().catch(e => { console.error(e); process.exit(1); });
