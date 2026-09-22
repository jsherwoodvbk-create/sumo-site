// gen-torikumi.mjs — pull the makuuchi CARDS (torikumi) from sumo-api and write a small, ungated
// tomorrow-card.json. This is the "matchups" layer.
//
// SCHEMA tomorrow-card/2 (2026-09-22): now writes a `cards` MAP of EVERY published day's card, plus a
// `today` real-world anchor — not just the single next day.
//   WHY: matchups are result-free, so a card is NEVER a spoiler (Jennie: "matchups do not need to be
//   gated, results do"). The old single-card design only ever carried the tournament's next REAL
//   scheduled day, so a crew member watching on delay (a) could never pull their OWN next day's card
//   (it had already been fought in real life, so it lived only in the gated match log), and (b) got
//   handed a card further ahead than their next day. Now we carry every published day's pairings and
//   the engine serves the viewer's next day by default, or ANY published day on request. RESULTS stay
//   gated in the match log exactly as before.
//   The single next-day card (`day`/`date`/`matchups`/`empty`) is still written for back-compat.
//   `today = { date, tournamentDay }` gives the model a real-world anchor (it has no clock), so
//   "who does X fight today" resolves against a fact instead of a guess. Neither is a result.
//
// WHY A SEPARATE JSON (not Notion Match Log rows)  ── read before "improving" this ──
//   Upcoming matchups are result-free AND ephemeral. If we wrote placeholder rows into the Match Log,
//   they'd collide with sync-notion.mjs's dedup: that sync SKIPS any Day # already present
//   (`daysPresent.has(day)`), so a Day-N+1 placeholder would make the result sync think Day N+1 is
//   "already done" and NEVER write the real results. So this lives in its own file, never touches
//   Notion, and the result sync is left completely untouched. gen-gumbai folds this file in as an
//   UNGATED `cards` map + `upcoming` card (like it folds in sumo-history.json).
//
// SPOILER-SAFE: a matchup has no winner / no kimarite — there is nothing to gate. (One caveat,
//   handled downstream at display time: the senshuraku card composition hints at the yusho race.
//   This pull just fetches the cards; it does not decide how to show them.)
//
// GOOD-CITIZEN: descriptive User-Agent, throttled, and INCREMENTAL — a past day's card is immutable,
//   so once it is in the file we don't refetch it; each run fetches only the days it's missing plus a
//   refresh of the top two (in case a card posts late or is corrected). Steady state ~2-3 calls/run.
//
// sumo-api is only reachable from GitHub Actions. Run daily (rides the publish flow) or by hand.
//
// ── PER-BASHO CONFIG — bump BASHO every tournament, WITH the other generators ──────────────────
//   FIX (2026-09-22): BASHO defaulted to '202607' (Nagoya, a FINISHED basho) and publish.yml runs
//   `node gen-torikumi.mjs` with no BASHO env — so every run pulled Nagoya, saw Day 15 complete, and
//   wrote an empty "basho over" card. Now in the banzuke-drop config-flip cascade (bump it here each
//   basho, with gen-gumbai-snapshot / build-standings / gen-rikishi-metrics).
// ENV: BASHO (default 202609 = Aki 2026) · OUT (default tomorrow-card.json) · FORCE_DAY (optional test override)
import fs from 'node:fs';
import process from 'node:process';

const API = 'https://www.sumo-api.com/api';
const DIVISION = 'Makuuchi';
const TOTAL_DAYS = 15;
const BASHO = process.env.BASHO || '202609';   // ← Aki 2026 (bump each tournament, with the other generators)
const OUT = process.env.OUT || 'tomorrow-card.json';
const FORCE_DAY = parseInt(process.env.FORCE_DAY || '', 10); // NaN when unset
const UA = 'salt-stats-sumo-torikumi/1.0 (+https://sumo.stavesandhoop.com; daily card pull)';
const THROTTLE_MS = 1200;

// ── SOURCE FRAMEWORK (2026-09-22): the lineup also lands in NOTION, on the day's cardinal Highlights row ──
//   Jennie: "torikumi should only live on the cardinal number/highlights as that's the constant." So the
//   card stops being a Notion-bypassing JSON exception — it upserts the 📅 Days/Transcripts `Lineup` field
//   on the (Basho, Day #) row, the SAME (Basho, Day #) key notion_push.py + sync-notion's ensureDayRow use,
//   so it converges to one clean row (the box's Highlights push later patches the transcript onto it). This
//   write is BEST-EFFORT: it never throws, never blocks the card, and `tomorrow-card.json` is still written
//   every run (the read side prefers Notion, falls back to the JSON) — so the daily pipeline can't break on it.
//   Needs a WRITE token (NOTION_TOKEN_WRITE, the sumo-notion-sync / a write integration with Days + Bashos
//   shared) in the torikumi step's env. Absent → the write is skipped with a note, JSON path unchanged.
//   PER-BASHO: TOURNAMENT_PAGE_ID + BASHO_LABEL bump with the other generators at the drop.
const NOTION_TOKEN_WRITE = process.env.NOTION_TOKEN_WRITE || '';
const TOURNAMENT_PAGE_ID = process.env.TOURNAMENT_PAGE_ID || '3351ade1-241f-8011-8987-d959538f54a0';  // Aki 2026 🏆 Bashos page
const DAYS_DB_ID = process.env.DAYS_DB_ID || 'eb0597c9-7259-49cd-babb-889f3b28f33d';   // 📅 Days/Transcripts
const NOTION_VERSION = '2022-06-28';

const LABEL = {
  '202501': 'Hatsu 2025', '202503': 'Haru 2025', '202505': 'Natsu 2025', '202507': 'Nagoya 2025',
  '202509': 'Aki 2025', '202511': 'Kyushu 2025', '202601': 'Hatsu 2026', '202603': 'Haru 2026',
  '202605': 'Natsu 2026', '202607': 'Nagoya 2026', '202609': 'Aki 2026', '202611': 'Kyushu 2026',
};
const BASHO_LABEL = process.env.BASHO_LABEL || LABEL[BASHO] || BASHO;   // for the Notion Day title

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 404 (day not posted yet) returns null rather than throwing, so a missing card never fails the run.
async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── Notion write path (best-effort — the card never depends on it) ──────────────
async function notion(path, method = 'GET', body, attempt = 0) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN_WRITE}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status === 529) && attempt < 5) {
    const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return notion(path, method, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const idNoDash = s => String(s || '').replace(/-/g, '');
// One line per bout: "East (Rank) vs West (Rank)" (rank omitted when unknown). THIS is the exact
// serialization gen-gumbai-snapshot parses back into matchups — keep the two in lockstep.
function serializeLineup(matchups) {
  return (matchups || []).map(m => {
    const e = m.eastRank ? `${m.eastName} (${m.eastRank})` : m.eastName;
    const w = m.westRank ? `${m.westName} (${m.westRank})` : m.westName;
    return `${e} vs ${w}`;
  }).join('\n');
}
// Find the (Basho, Day #) row — the SAME key notion_push.py / sync-notion's ensureDayRow use, so we
// converge onto the box's cardinal Highlights row instead of duplicating.
async function findDayRow(dayNum) {
  const r = await notion(`/databases/${DAYS_DB_ID}/query`, 'POST', {
    page_size: 5,
    filter: { and: [
      { property: 'Basho', relation: { contains: TOURNAMENT_PAGE_ID } },
      { property: 'Day #', number: { equals: dayNum } },
    ] },
  });
  return (r.results || [])[0] || null;
}
const lineupOf = p => (p?.properties?.Lineup?.rich_text || []).map(t => t.plain_text).join('');
// Upsert only the day's Lineup: PATCH the existing (Basho, Day #) row, or CREATE it (Type=Highlights) so
// the next scheduled day's shell exists early. NEVER touches any other field. Caller wraps it best-effort.
async function upsertDayLineup(dayNum, lineupText) {
  const lineup = String(lineupText || '').slice(0, 1990);
  const lineupProp = { Lineup: { rich_text: lineup ? [{ text: { content: lineup } }] : [] } };
  const existing = await findDayRow(dayNum);
  if (existing) {
    if (lineupOf(existing) === lineup) return 'unchanged';
    await notion(`/pages/${idNoDash(existing.id)}`, 'PATCH', { properties: lineupProp });
    return 'patched';
  }
  await notion('/pages', 'POST', {
    parent: { database_id: DAYS_DB_ID },
    properties: {
      Day: { title: [{ text: { content: `${BASHO_LABEL} · Day ${dayNum}` } }] },
      'Day #': { number: dayNum },
      Basho: { relation: [{ id: TOURNAMENT_PAGE_ID }] },
      Type: { select: { name: 'Highlights' } },
      ...lineupProp,
    },
  });
  return 'created';
}
// Best-effort: land every integer published day's lineup in Notion. Never throws; a hiccup on one day
// is logged and the rest continue. The card (tomorrow-card.json) is already written by the time this runs.
async function landLineupsInNotion(cards) {
  if (!NOTION_TOKEN_WRITE) { console.log('  (Notion Lineup write skipped — no NOTION_TOKEN_WRITE in env; tomorrow-card.json is the only sink this run)'); return; }
  const days = Object.keys(cards).map(Number).filter(d => Number.isInteger(d)).sort((a, b) => a - b);
  const tally = { created: 0, patched: 0, unchanged: 0, failed: 0 };
  for (const d of days) {
    const c = cards[d]; if (!c || !(c.matchups || []).length) continue;
    try { tally[await upsertDayLineup(d, serializeLineup(c.matchups))]++; }
    catch (e) { tally.failed++; console.warn(`  ⚠️ Lineup upsert Day ${d} failed (non-fatal): ${e.message}`); }
    await sleep(350);   // polite pacing on Notion writes
  }
  console.log(`  + Notion Lineup: created=${tally.created} patched=${tally.patched} unchanged=${tally.unchanged} failed=${tally.failed} (Days ${days.join(', ') || 'none'})`);
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
function maxCompletedDayFromBanzuke(bz) {
  if (!bz) return 0;
  const roster = [...(bz.east || []), ...(bz.west || [])];
  let m = 0;
  for (const w of roster) {
    (w.record || []).forEach((r, i) => { if (IS_BOUT.has(r.result) && i + 1 > m) m = i + 1; });
  }
  return m;
}

// Parse a torikumi response into matchups only: [{eastName,eastRank,eastId,westName,westRank,westId}].
// sumo-api field names are defended with fallbacks. east/west is the side of the dohyo (a scheduling
// attribute), NOT a result — so nothing here encodes who won.
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
      schema: 'tomorrow-card/2',
      note: 'Result-free CARDS (pairings), ungated. `cards` holds every published day; `day`/`matchups` is the next scheduled card (back-compat). Regenerated every run; not stored in Notion.',
    },
  };

  // ── the basho endpoint once: start date (for dating each day + the real-world `today` anchor) ──
  let startDate = null;
  try {
    const b = await getJson(`${API}/basho/${BASHO}`);
    startDate = (b && (b.startDate || b.date)) ? String(b.startDate || b.date).slice(0, 10) : null;
  } catch (e) { console.warn(`basho start fetch failed (dates left null): ${e.message}`); }
  const dateForDay = (d) => {
    if (!startDate) return null;
    const dt = new Date(startDate); if (isNaN(dt)) return null;
    dt.setUTCDate(dt.getUTCDate() + (d - 1));
    return dt.toISOString().slice(0, 10);
  };

  // ── real-world today anchor (calendar-derived, spoiler-free) ──
  const todayISO = new Date().toISOString().slice(0, 10);
  let tournamentDay = null;
  if (startDate) {
    const diff = Math.floor((Date.parse(todayISO) - Date.parse(startDate)) / 86400000) + 1;
    tournamentDay = Math.max(0, Math.min(TOTAL_DAYS, diff));   // 0 = before Day 1; capped at 15
  }
  const today = { date: todayISO, tournamentDay };

  // ── which days are PUBLISHED? 1 .. (maxCompletedDay + 1), capped at 15. The +1 is the next
  //    scheduled card (posted the evening before). A FORCE_DAY test override pulls just that day. ──
  let realNext, cap;
  if (Number.isInteger(FORCE_DAY) && FORCE_DAY >= 1 && FORCE_DAY <= TOTAL_DAYS) {
    realNext = FORCE_DAY; cap = FORCE_DAY;
    console.log(`${label} (${BASHO}): FORCE_DAY=${FORCE_DAY} (test override — cards = just Day ${FORCE_DAY})`);
  } else {
    let bz = null;
    try { bz = await getJson(`${API}/basho/${BASHO}/banzuke/${DIVISION}`); }
    catch (e) { console.warn(`banzuke fetch failed (assuming pre-start): ${e.message}`); }
    const done = maxCompletedDayFromBanzuke(bz);
    realNext = done + 1;
    cap = Math.min(realNext, TOTAL_DAYS);   // highest published day (next scheduled, capped at 15)
    console.log(`${label} (${BASHO}): max completed day = ${done}, next scheduled = ${realNext}, publishing cards Day 1..${cap}. Real-world today = ${todayISO} (Day ${tournamentDay ?? '?'}).`);
  }

  // ── carry forward immutable prior cards; refetch only the missing days + the top two ──
  let priorCards = {};
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (prev && prev.cards && typeof prev.cards === 'object') priorCards = prev.cards;
  } catch { /* first run / old shape — fetch everything below */ }
  const getPrior = (d) => priorCards[d] || priorCards[String(d)] || null;

  const wantDays = [];
  for (let d = (Number.isInteger(FORCE_DAY) && FORCE_DAY >= 1 ? FORCE_DAY : 1); d <= cap; d++) wantDays.push(d);
  const refresh = new Set(wantDays.filter(d => !getPrior(d)));
  if (cap >= 1) refresh.add(cap);              // frontier: the next scheduled day (posts late)
  if (cap - 1 >= 1) refresh.add(cap - 1);      // and the one before (late corrections)

  const cards = {};
  for (const d of wantDays) { const pc = getPrior(d); if (pc && !refresh.has(d)) cards[d] = pc; }   // reuse

  for (const d of [...refresh].sort((a, b) => a - b)) {
    await sleep(THROTTLE_MS);
    let data = null;
    try { data = await getJson(`${API}/basho/${BASHO}/torikumi/${DIVISION}/${d}`); }
    catch (e) { console.warn(`Day ${d} torikumi fetch failed (non-fatal): ${e.message}`); }
    const rows = (data && (data.torikumi || data.matches || data.bouts)) || [];
    const mus = parseCard(rows);
    if (rows.length && !mus.length) {
      console.warn(`⚠️ Day ${d}: rows present but none parsed — check field names. Raw sample:`);
      console.warn('  ' + JSON.stringify(rows[0]));
    }
    if (mus.length) cards[d] = { day: d, date: dateForDay(d), matchups: mus };
    else console.log(`  Day ${d}: no card (not published yet / 404) — left out of the map.`);
  }

  // ── the single next-day card (back-compat with the old `upcoming` fold) ──
  const nextDayNum = realNext <= TOTAL_DAYS ? realNext : null;
  const nextCard = nextDayNum ? cards[nextDayNum] : null;

  writeCard({
    ...base,
    today,
    nextDay: nextDayNum,
    day: nextCard ? nextCard.day : null,
    date: nextCard ? nextCard.date : null,
    matchups: nextCard ? nextCard.matchups : [],
    empty: !nextCard,
    cards,
  });

  const dayList = Object.keys(cards).map(Number).sort((a, b) => a - b);
  console.log(`✓ wrote ${OUT}: ${dayList.length} published card(s) [Days ${dayList.join(', ') || 'none'}]; next scheduled = ${nextCard ? `Day ${nextCard.day} (${nextCard.matchups.length} matchups)` : 'none (empty)'}.`);

  // ── land the lineups in Notion too (Source Framework) — BEST-EFFORT, after the JSON is safely written,
  //    so a Notion hiccup can never break the card or the publish. tomorrow-card.json remains the fallback.
  try { await landLineupsInNotion(cards); }
  catch (e) { console.warn(`  (Notion Lineup landing failed entirely — non-fatal, JSON card unaffected): ${e.message}`); }
}

main().catch(e => { console.error(e); process.exit(1); });
