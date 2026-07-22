// Mirror sumo-api results into the Notion master DB (Match Log + master data),
// AND auto-enrich any newly-created wrestler from sumo-api's rikishi endpoint.
// Runs in GitHub Actions (Node 20 fetch). sumo-api is only reachable from Actions, not locally.
//
// EACH RUN:
//   1. Reads the sumo-api banzuke for BASHO (roster + each wrestler's day-by-day record).
//   2. Backfills only the tournament days NOT yet in Match Log (dedup read is scoped to the
//      current basho via the Tournament relation, so it stays flat as history grows — and so
//      Day # 1–15 never collides across basho).
//   3. Creates missing master data first (new Juryo visitors -> Master Rikishi + a "J" Banzuke
//      entry) so bout relations never dangle -- and ENRICHES them from sumo-api's rikishi
//      endpoint (height, weight, birthday, country, kanji shikona, real name, IDs).
//   4. Writes each bout to Match Log with resolved relations + Day #, Date, and machine-derived
//      Gold Star (kinboshi).
//
// SINGLE SOURCE: everything machine-owned comes from sumo-api. The only genuinely JSA-only
//   items are the official PHOTO (and sometimes the birth-name kanji); those are never fetched
//   here -- they're logged as a FLAG for an occasional manual add. No JSA scraping, ever.
//
// NEVER TOUCHES (human-owned): Henka, Monoii, Rematch, Notes-on-bouts. The sync only CREATES
//   bouts; it never edits an existing one. (It does set the auto Notes on a *newly created*
//   wrestler -- that record didn't exist before, so nothing human is overwritten.)
//
// SAFETY: DRY_RUN defaults to "1" -> logs what it WOULD do, writes nothing.
// PROBE:  set input/env PROBE_NAME=<shikonaEn> to fetch that wrestler from sumo-api and print
//   the enrichment mapping WITHOUT writing -- use it to sanity-check the field mapping against a
//   known wrestler (e.g. PROBE_NAME=Aonishiki should show 182 cm, 2004-03-23, Ukraine).
//
// ENV: NOTION_TOKEN (write key) · BASHO (default 202607) · DRY_RUN (default "1") · PROBE_NAME (opt)

import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;

// ─── PER-BASHO CONFIG — change these THREE together at the start of each tournament ───
// (BASHO also has to change in sync-notion.yml AND in build-standings.mjs.)
//   BASHO             : sumo-api basho code YYYYMM. Comes from the workflow env; this default
//                       is just a fallback. The workflow (sync-notion.yml) sets the live value.
//   TOURNAMENT_PAGE_ID: the Notion Tournament page for THIS basho. MUST exist before the first
//                       sync — the scoped dedup read and every bout write both point at it.
//   BASHO_LABEL       : exact text used in Banzuke "Entry" titles, e.g. "Aonishiki — Nagoya 2026".
// Full step-by-step: see the "Tournament Rollover" checklist in the project.
const BASHO = process.env.BASHO || '202607';
const TOURNAMENT_PAGE_ID = '3351ade1-241f-80fb-b4ef-d2bef497b295';
const BASHO_LABEL = 'Nagoya 2026';
// ─────────────────────────────────────────────────────────────────────────────────────

const DIVISION = 'Makuuchi';
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');
const PROBE_NAME = (process.env.PROBE_NAME || '').trim();
const NOTION_VERSION = '2022-06-28';
const TOTAL_DAYS = 15;
const API = 'https://www.sumo-api.com/api';

const DB = {
  matchLog:      '1a2bad82-ebf5-4472-87ea-cb2c2481f9f1',
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
  kimarite:      '2591d1eb-2146-4745-ab0a-72ba57bfd213',
};

const IS_WIN = new Set(['win', 'fusen win']);
const IS_BOUT = new Set(['win', 'loss', 'fusen win', 'fusen loss']);

// Country of Origin select options that exist in Master Rikishi
const COUNTRIES = ['Japan','Bulgaria','Egypt','Georgia','Kazakhstan','Kyrgyzstan','Mongolia','Russia','Ukraine','China'];

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
const titleOf = (page, prop) => {
  const p = page.properties?.[prop]; const arr = p?.title || p?.rich_text || [];
  return arr.map(t => t.plain_text).join('').trim();
};
const textOf = (page, prop) => (page.properties?.[prop]?.rich_text || []).map(t => t.plain_text).join('').trim();

// ---------- sumo-api ----------
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`sumo-api ${url} -> ${r.status}: ${await r.text()}`);
  return r.json();
}
const getBanzuke = () => getJson(`${API}/basho/${BASHO}/banzuke/${DIVISION}`);
async function getBashoStart() {
  try { const b = await getJson(`${API}/basho/${BASHO}`); const s = b.startDate || b.date; if (s) return new Date(s); }
  catch (e) { console.warn('basho info fetch failed, deriving start:', e.message); }
  const y = +BASHO.slice(0, 4), m = +BASHO.slice(4, 6);
  return new Date(Date.UTC(y, m - 1, 12));
}
// Pull a wrestler's profile from sumo-api. Returns a normalized object, or null on any failure.
async function fetchRikishiDetail(sumoId) {
  if (!sumoId) return null;
  try {
    const r = await getJson(`${API}/rikishi/${sumoId}`);
    return {
      sumoId: r.id ?? sumoId,
      nskId: r.nskId ?? null,       // candidate for "JSA ID" -- flagged for human verification
      sumodbId: r.sumodbId ?? null,
      shikonaJp: r.shikonaJp ?? null,   // kanji shikona (sumo-api DOES carry this)
      heya: r.heya ?? null,             // stable
      birthDate: r.birthDate ? String(r.birthDate).slice(0, 10) : null,
      shusshin: r.shusshin ?? null,     // hometown / origin
      heightCm: (typeof r.height === 'number' && r.height > 0) ? Math.round(r.height) : null,
      weightKg: (typeof r.weight === 'number' && r.weight > 0) ? Math.round(r.weight) : null,
    };
  } catch (e) { console.warn(`rikishi ${sumoId} enrichment fetch failed: ${e.message}`); return null; }
}
async function searchRikishiIdByName(name) {
  try {
    const r = await getJson(`${API}/rikishis?shikonaEn=${encodeURIComponent(name)}&limit=5`);
    const rec = (r.records || []).find(x => x.shikonaEn === name) || (r.records || [])[0];
    return rec ? (rec.id ?? rec.rikishiID) : null;
  } catch (e) { console.warn(`rikishi search "${name}" failed: ${e.message}`); return null; }
}
function mapCountry(shusshin) {
  if (!shusshin) return null;
  const s = String(shusshin);
  for (const c of COUNTRIES) if (s.toLowerCase().includes(c.toLowerCase())) return c;
  if (/japan/i.test(s) || /-ken\b/i.test(s) || /prefecture/i.test(s)) return 'Japan';
  return 'Other';
}

// ---------- probe mode ----------
async function probe(name) {
  console.log(`PROBE: fetching "${name}" from sumo-api (no writes)…`);
  const id = await searchRikishiIdByName(name);
  if (!id) { console.log(`  no sumo-api match for "${name}".`); return; }
  const d = await fetchRikishiDetail(id);
  if (!d) { console.log(`  detail fetch failed for id ${id}.`); return; }
  console.log('  sumo-api id:', d.sumoId, '| nskId(JSA?):', d.nskId, '| sumodbId:', d.sumodbId);
  console.log('  would map -> Height (cm):', d.heightCm, '| Weight (kg):', d.weightKg,
    '| Birthday:', d.birthDate, '| Country:', mapCountry(d.shusshin), `(from "${d.shusshin}")`);
  console.log('  kanji shikona:', d.shikonaJp, '| stable(heya):', d.heya);
  console.log('  NOTE: photo is JSA-only and never auto-fetched.');
}

// ---------- main ----------
async function main() {
  if (PROBE_NAME) { await probe(PROBE_NAME); return; }
  console.log(`sync-notion: BASHO=${BASHO} DRY_RUN=${DRY ? 'ON (no writes)' : 'OFF (writing!)'}`);

  // Dedup read is SCOPED to the current tournament (relation filter), not the whole Match Log.
  // Two reasons: (1) the read stays flat (~one basho of rows) no matter how many years accumulate,
  // so sync cost never grows with history; (2) correctness — "Day #" is 1–15 within EACH basho,
  // so an unscoped read would see last basho's Day 10 and wrongly skip this basho's Day 10.
  // NB: TOURNAMENT_PAGE_ID must point at the current basho's Tournament page (same constant the
  // writes already use), so it has to be updated each basho alongside BASHO.
  const thisBashoFilter = { property: 'Tournament', relation: { contains: TOURNAMENT_PAGE_ID } };
  const [bz, existing, mrPages, bzPages, kmPages, start] = await Promise.all([
    getBanzuke(), queryAll(DB.matchLog, thisBashoFilter), queryAll(DB.masterRikishi), queryAll(DB.banzuke), queryAll(DB.kimarite), getBashoStart(),
  ]);
  console.log(`start date = ${iso(start)} (Day 1)`);

  const roster = [...(bz.east || []), ...(bz.west || [])];
  const MR = new Map(mrPages.map(p => [titleOf(p, 'Ring Name'), p.id]));
  const bzThis = bzPages.filter(p => titleOf(p, 'Entry').includes(BASHO_LABEL));
  const BZ = new Map(bzThis.map(p => [titleOf(p, 'Entry').split(' — ')[0].trim(), p.id]));
  const KM = new Map(kmPages.map(p => [textOf(p, 'Kimarite').toLowerCase(), p.id]));
  const kimId = k => { const key = (k || '').trim().toLowerCase(); if (!key) return null; if (key === 'fusen') return KM.get('fusensho') || null; return KM.get(key) || null; };

  const daysPresent = new Set(existing.map(p => p.properties?.['Day #']?.number).filter(n => n != null));
  console.log(`this-basho Match Log rows: ${existing.length} | days already in: ${[...daysPresent].sort((a, b) => a - b).join(',') || '(none)'}`);

  function boutsForDay(dayNum) {
    const d = dayNum - 1; const seen = new Set(); const list = [];
    for (const w of roster) {
      const rec = w.record || []; if (d >= rec.length) continue;
      const r = rec[d]; if (!IS_BOUT.has(r.result)) continue;
      const oppId = String(r.opponentID);
      const key = [String(w.rikishiID), oppId].sort().join('|'); if (seen.has(key)) continue; seen.add(key);
      const won = IS_WIN.has(r.result);
      const winner = won ? { name: w.shikonaEn, id: String(w.rikishiID) } : { name: r.opponentShikonaEn, id: oppId };
      const loser  = won ? { name: r.opponentShikonaEn, id: oppId } : { name: w.shikonaEn, id: String(w.rikishiID) };
      list.push({ winner, loser, kim: r.result.startsWith('fusen') ? 'fusen' : (r.kimarite || '') });
    }
    return list;
  }

  const flags = [];
  const rankOf = name => { const w = roster.find(r => r.shikonaEn === name); return w ? w.rank : 'Juryo'; };

  // create + enrich a wrestler if missing; return {mrId, bzId}
  async function ensureWrestler(name, sumoId) {
    let mrId = MR.get(name);
    let bzId = BZ.get(name);
    if (mrId && bzId) return { mrId, bzId };

    // only fetch enrichment when we actually need to create something
    const d = (!mrId || !bzId) ? await fetchRikishiDetail(sumoId) : null;

    if (!mrId) {
      const noteBits = [`Juryo visitor auto-created by sync at basho ${BASHO}.`];
      if (d?.shikonaJp) noteBits.push(`Kanji: ${d.shikonaJp}.`);
      if (d?.heya) noteBits.push(`Stable (heya): ${d.heya} — relation not auto-linked; link by hand.`);
      if (d?.sumoId || d?.sumodbId) noteBits.push(`sumo-api id ${d?.sumoId ?? '?'} / sumodb ${d?.sumodbId ?? '?'}.`);
      noteBits.push('Photo pending (JSA-only, not auto-fetched).');
      if (!d) { noteBits.push('sumo-api enrichment unavailable — profile fields blank.'); flags.push(`"${name}": enrichment fetch failed; created with name only.`); }

      const props = {
        'Ring Name': { title: [{ text: { content: name } }] },
        'Active': { checkbox: true },
        'Highest Rank': { select: { name: 'Juryo' } },
        'Notes': { rich_text: [{ text: { content: noteBits.join(' ') } }] },
      };
      if (d?.heightCm) props['Height (cm)'] = { number: d.heightCm };
      if (d?.birthDate) props['Birthday'] = { date: { start: d.birthDate } };
      const country = mapCountry(d?.shusshin);
      if (country) { props['Country of Origin'] = { select: { name: country } }; if (country === 'Other') flags.push(`"${name}": origin "${d?.shusshin}" didn't map to a known country — set to "Other", verify.`); }
      if (d?.nskId) { props['JSA ID'] = { rich_text: [{ text: { content: String(d.nskId) } }] }; flags.push(`"${name}": JSA ID auto-set to ${d.nskId} from sumo-api nskId — VERIFY against the official number.`); }
      else flags.push(`"${name}": no JSA ID from sumo-api — tag it by hand.`);
      flags.push(`"${name}": photo not fetched (JSA-only) — add manually if wanted.`);

      if (DRY) { console.log(`  [dry] would CREATE+ENRICH Master Rikishi "${name}"`, JSON.stringify(enrichPreview(d))); mrId = `dry-mr-${name}`; }
      else { const p = await notion('/pages', 'POST', { parent: { database_id: DB.masterRikishi }, properties: props }); mrId = p.id; }
      MR.set(name, mrId);
    }
    if (!bzId) {
      const props = {
        'Entry': { title: [{ text: { content: `${name} — ${BASHO_LABEL}` } }] },
        'Rank': { select: { name: 'J' } },
        'Rikishi': { relation: [{ id: mrId }] },
        'Tournament': { relation: [{ id: TOURNAMENT_PAGE_ID }] },
        'Notes': { rich_text: [{ text: { content: 'Juryo visitor entry auto-created for referential integrity.' } }] },
      };
      if (d?.weightKg) props['Weight (kg)'] = { number: d.weightKg };
      if (DRY) { console.log(`  [dry] would CREATE Banzuke "${name} — ${BASHO_LABEL}" (J, ${d?.weightKg ?? '?'} kg)`); bzId = `dry-bz-${name}`; }
      else { const p = await notion('/pages', 'POST', { parent: { database_id: DB.banzuke }, properties: props }); bzId = p.id; }
      BZ.set(name, bzId);
    }
    return { mrId, bzId };
  }

  const maxDayInData = Math.max(0, ...roster.map(w => { const rec = w.record || []; let m = 0; rec.forEach((r, i) => { if (IS_BOUT.has(r.result) && i + 1 > m) m = i + 1; }); return m; }));
  console.log('max completed day in sumo-api data:', maxDayInData);

  // COMPLETENESS GUARD: only write a day whose slate looks FINAL. This is what makes it safe to
  // run the sync many times across the morning (resilient to a dropped cron) — an early run that
  // fires while sumo-api is still posting a day's bouts will SKIP that day rather than write a
  // half-populated one, and a later run writes it once the slate is complete. A day is "final" if
  // its decided-bout count is within tolerance of the fullest day seen (self-calibrates to roster
  // size), OR the next day already has bouts (which means this day is definitively over).
  const boutCount = {};
  for (let d = 1; d <= Math.min(maxDayInData, TOTAL_DAYS); d++) boutCount[d] = boutsForDay(d).length;
  // Expected full slate = the fullest day seen, floored by roster/2 (a full Makuuchi day is ~roster/2
  // bouts; a wrestler sitting out still yields a counted fusen bout for the opponent). The roster floor
  // is what protects the very first run of a tournament, when a mid-populated Day 1 has no complete
  // prior day to calibrate against and would otherwise look "full."
  const fullSlate = Math.max(0, ...Object.values(boutCount));
  const rosterFloor = Math.floor(roster.length / 2);
  const expectedFull = Math.max(fullSlate, rosterFloor);
  const DAY_TOLERANCE = 3; // slack for the rare double-absence bye; still far below a mid-posting day
  const isFinal = d => (boutCount[d] || 0) > 0 && ((boutCount[d] >= expectedFull - DAY_TOLERANCE) || ((boutCount[d + 1] || 0) > 0));

  let created = 0;
  for (let day = 1; day <= Math.min(maxDayInData, TOTAL_DAYS); day++) {
    if (daysPresent.has(day)) continue;
    if (!isFinal(day)) { console.log(`Day ${day}: ${boutCount[day]} bouts vs full slate ~${fullSlate} — looks incomplete, skipping until final.`); continue; }
    const bouts = boutsForDay(day); const dt = dayDate(start, day);
    console.log(`Day ${day} (${iso(dt)}): ${bouts.length} bouts to write`);
    for (const b of bouts) {
      const W = await ensureWrestler(b.winner.name, b.winner.id);
      const L = await ensureWrestler(b.loser.name, b.loser.id);
      const tId = kimId(b.kim);
      if (!tId) flags.push(`Day ${day}: unmatched kimarite "${b.kim}" for ${b.winner.name} vs ${b.loser.name}.`);
      const props = {
        'Match': { title: [{ text: { content: `${b.winner.name} vs ${b.loser.name} · Day ${day} · ${short(dt)}` } }] },
        'Day #': { number: day }, 'Date': { date: { start: iso(dt) } },
        'Winner': { relation: [{ id: W.mrId }] }, 'Loser': { relation: [{ id: L.mrId }] },
        'Winner Banzuke': { relation: [{ id: W.bzId }] }, 'Loser Banzuke': { relation: [{ id: L.bzId }] },
        'Tournament': { relation: [{ id: TOURNAMENT_PAGE_ID }] },
      };
      if (tId) props['Technique'] = { relation: [{ id: tId }] };
      if (isMaegashira(rankOf(b.winner.name)) && isYokozuna(rankOf(b.loser.name))) props['Gold Star'] = { checkbox: true };
      if (DRY) console.log(`  [dry] would CREATE bout: ${b.winner.name} vs ${b.loser.name} · Day ${day}`);
      else await notion('/pages', 'POST', { parent: { database_id: DB.matchLog }, properties: props });
      created++;
    }
  }

  console.log(`\nDONE. ${DRY ? 'Would create' : 'Created'} ${created} bout(s).`);
  if (flags.length) { console.log('\n⚠️  FLAGS FOR JENNIE:'); for (const f of [...new Set(flags)]) console.log('  - ' + f); }
  else console.log('No flags.');
}

// small helpers
const iso = d => d.toISOString().slice(0, 10);
const short = d => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCFullYear()).slice(2)}`;
function dayDate(start, dayNum) { const d = new Date(start.getTime()); d.setUTCDate(d.getUTCDate() + (dayNum - 1)); return d; }
const isYokozuna = r => String(r || '').startsWith('Yokozuna');
const isMaegashira = r => String(r || '').startsWith('Maegashira');
const enrichPreview = d => d ? { ht: d.heightCm, wt: d.weightKg, bday: d.birthDate, country: mapCountry(d.shusshin), kanji: d.shikonaJp, heya: d.heya } : null;

main().catch(e => { console.error(e); process.exit(1); });
