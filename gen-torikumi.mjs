// gen-torikumi.mjs — pull the NEXT day's makuuchi card (torikumi) from sumo-api and write a
// small, ungated tomorrow-card.json. This is the "upcoming matchups" layer.
//
// WHY A SEPARATE JSON (not Notion Match Log rows)  ── read before "improving" this ──
//   Upcoming matchups are result-free AND ephemeral: they get replaced by real results within a
//   day. If we wrote placeholder rows into the Match Log, they'd collide with sync-notion.mjs's
//   dedup: that sync SKIPS any Day # already present (`daysPresent.has(day)`), so a Day-N+1
//   placeholder would make the result sync think Day N+1 is "already done" and NEVER write the
//   real results. So upcoming lives in its own file, never touches Notion, and the result sync is
//   left completely untouched. gen-gumbai folds this file in as an UNGATED `upcoming` collection
//   (exactly like it folds in sumo-history.json).
//
// SPOILER-SAFE: a matchup has no winner / no kimarite — there is nothing to gate. (One caveat,
//   handled downstream at display time: the senshuraku card composition hints at the yusho race.
//   This pull just fetches the card; it does not decide how to show it.)
//
// WHICH DAY: nextDay = (max completed day in the banzuke) + 1, capped at 15. On senshuraku
//   (max completed = 15) there is no next day → writes an EMPTY card and exits 0. If the endpoint
//   404s or the card isn't posted yet → EMPTY card, logged, run still succeeds (a later run fills
//   it in). FORCE_DAY=<n> overrides the day for testing.
//
// GOOD-CITIZEN: descriptive User-Agent, throttled. This is ~1–3 calls per run.
//
// sumo-api is only reachable from GitHub Actions. Run daily (rides the publish flow) or by hand.
//
// ENV: BASHO (default 202607) · OUT (default tomorrow-card.json) · FORCE_DAY (optional test override)
import fs from 'node:fs';
import process from 'node:process';

const API = 'https://www.sumo-api.com/api';
const DIVISION = 'Makuuchi';
const TOTAL_DAYS = 15;
const BASHO = process.env.BASHO || '202607';
const OUT = process.env.OUT || 'tomorrow-card.json';
const FORCE_DAY = parseInt(process.env.FORCE_DAY || '', 10); // NaN when unset
const UA = 'salt-stats-sumo-torikumi/1.0 (+https://sumo.stavesandhoop.com; daily next-day card)';
const THROTTLE_MS = 1200;

const LABEL = {
  '202501': 'Hatsu 2025', '202503': 'Haru 2025', '202505': 'Natsu 2025', '202507': 'Nagoya 2025',
  '202509': 'Aki 2025', '202511': 'Kyushu 2025', '202601': 'Hatsu 2026', '202603': 'Haru 2026',
  '202605': 'Natsu 2026', '202607': 'Nagoya 2026', '202609': 'Aki 2026', '202611': 'Kyushu 2026',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 404 (day not posted yet) returns null rather than throwing, so a missing card never fails the run.
async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// same rank shortening as build-standings.mjs / gen-history.mjs
function shortRank(rankStr) {
  const parts = String(rankStr || '').split(' ');
  const w = parts[0];
  if (w === 'Yokozuna' || w === 'Ozeki' || w === 'Sekiwake' || w === 'Komusubi') return w;
  if (w === 'Maegashira') return 'M' + (parts[1] || '');
  if (w === 'Juryo') return 'J' + (parts[1] || '');
  return rankStr || null;
}

const IS_BOUT = new Set(['win', 'loss', 'fusen win', 'fusen loss']);

// max completed day = longest decided-bout streak across the roster (the signal sync-notion uses)
async function maxCompletedDay() {
  const bz = await getJson(`${API}/basho/${BASHO}/banzuke/${DIVISION}`);
  if (!bz) return 0;
  const roster = [...(bz.east || []), ...(bz.west || [])];
  let m = 0;
  for (const w of roster) {
    (w.record || []).forEach((r, i) => { if (IS_BOUT.has(r.result) && i + 1 > m) m = i + 1; });
  }
  return m;
}

// Parse a torikumi response into matchups only: [{eastName,eastRank,eastId,westName,westRank,westId}].
// sumo-api field names are defended with fallbacks; if rows exist but none parse, the caller logs a
// raw sample so we can lock the exact field names on the first live Actions run.
function parseCard(rows) {
  const out = [];
  const seen = new Set();
  for (const t of rows) {
    const eastName = t.eastShikona || t.eastShikonaEn || t.east || null;
    const westName = t.westShikona || t.westShikonaEn || t.west || null;
    if (!eastName || !westName) continue;
    const key = [String(t.eastId || eastName), String(t.westId || westName)].sort().join('|');
    if (seen.has(key)) continue; seen.add(key);
    out.push({
      eastName, eastRank: shortRank(t.eastRank), eastId: t.eastId ?? null,
      westName, westRank: shortRank(t.westRank), westId: t.westId ?? null,
    });
  }
  return out;
}

function writeCard(card) {
  fs.writeFileSync(OUT, JSON.stringify(card, null, 2) + '\n');
}

async function main() {
  const label = LABEL[BASHO] || BASHO;
  const base = {
    meta: {
      basho: label, bashoId: BASHO, division: DIVISION, source: 'sumo-api/torikumi',
      schema: 'tomorrow-card/1',
      note: 'Upcoming matchups only — result-free, ungated. Regenerated every run; not stored in Notion.',
    },
  };

  // Which day are we after?
  let nextDay;
  if (Number.isInteger(FORCE_DAY) && FORCE_DAY >= 1 && FORCE_DAY <= TOTAL_DAYS) {
    nextDay = FORCE_DAY;
    console.log(`${label} (${BASHO}): FORCE_DAY=${nextDay} (test override)`);
  } else {
    const done = await maxCompletedDay();
    nextDay = done + 1;
    console.log(`${label} (${BASHO}): max completed day = ${done}, next day = ${nextDay}`);
    // STOP CONDITION — senshuraku / basho over: no Day 16, nothing to pull.
    if (done >= TOTAL_DAYS || nextDay > TOTAL_DAYS) {
      console.log('Basho complete (Day 15 reached) — no next-day card. Writing empty.');
      writeCard({ ...base, day: null, date: null, matchups: [], empty: true });
      console.log(`✓ wrote ${OUT} (empty — basho over)`);
      return;
    }
    await sleep(THROTTLE_MS);
  }

  // Pull the card.
  let data = null;
  try { data = await getJson(`${API}/basho/${BASHO}/torikumi/${DIVISION}/${nextDay}`); }
  catch (e) { console.warn(`torikumi fetch failed (non-fatal): ${e.message}`); }

  const rows = (data && (data.torikumi || data.matches || data.bouts)) || [];
  const matchups = parseCard(rows);

  if (rows.length && !matchups.length) {
    // Rows came back but our field mapping missed — surface the raw shape to fix on first run.
    console.warn('⚠️ torikumi rows present but none parsed — check field names. Raw sample:');
    console.warn('  ' + JSON.stringify(rows[0]));
  }

  if (!matchups.length) {
    console.log(`Day ${nextDay} card not available yet (empty/404). Writing empty — a later run fills it.`);
    writeCard({ ...base, day: nextDay, date: null, matchups: [], empty: true });
    console.log(`✓ wrote ${OUT} (empty; retry next run)`);
    return;
  }

  // Date the day, if the basho endpoint gives a start date.
  let date = null;
  try {
    await sleep(THROTTLE_MS);
    const b = await getJson(`${API}/basho/${BASHO}`);
    const s = b && (b.startDate || b.date);
    if (s) { const d = new Date(s); if (!isNaN(d)) { d.setUTCDate(d.getUTCDate() + (nextDay - 1)); date = d.toISOString().slice(0, 10); } }
  } catch (e) { console.warn(`basho start fetch failed (date left null): ${e.message}`); }

  writeCard({ ...base, day: nextDay, date, matchups, empty: false });
  console.log(`✓ wrote ${OUT}: Day ${nextDay}${date ? ` (${date})` : ''}, ${matchups.length} matchups.`);
}

main().catch(e => { console.error(e); process.exit(1); });
