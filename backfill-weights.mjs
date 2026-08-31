// backfill-weights.mjs — ONE-TIME: fill Weight (kg) on Banzuke entries that were created without it
// (e.g. Aki 2026, made by the pre-fix setup-basho). Idempotent + SAFE: only writes Weight (kg), only
// where it is currently EMPTY, never overwrites an existing value, touches no other property.
//
// Weight source = the per-rikishi detail endpoint /rikishi/{id} (sumo-api refreshes it from the
// posted banzuke measurements) — the SAME source + field name ("Weight (kg)") sync-notion uses for
// Juryo visitors. Honors the weigh-in rule: writes only when sourced; leaves blank (never faked)
// when the API has no weight, and reports every blank so it can be sourced by hand.
//
// Runs in GitHub Actions (Node 20 fetch). NEEDS the WRITE token (it PATCHes pages) — wire
// NOTION_TOKEN: ${{ secrets.NOTION_TOKEN_WRITE }} in the workflow, same as setup-basho.
//
// SAFETY: DRY_RUN defaults to "1" — the dry run is a census (which entries WOULD get filled, and
//   the resolved kg) and writes NOTHING. Read it, then re-run with DRY_RUN=0.
//
// ENV: NOTION_TOKEN (write-scoped) · DRY_RUN (default "1") ·
//      BASHO / BASHO_LABEL / TOURNAMENT_PAGE_ID (default Aki 2026; override per basho)

import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');

const BASHO             = process.env.BASHO || '202609';
const BASHO_LABEL       = process.env.BASHO_LABEL || 'Aki 2026';
const TOURNAMENT_PAGE_ID= process.env.TOURNAMENT_PAGE_ID || '3351ade1-241f-8011-8987-d959538f54a0';

const DIVISION = 'Makuuchi';
const NOTION_VERSION = '2022-06-28';
const API = 'https://www.sumo-api.com/api';
const UA = 'salt-stats-sumo-backfill/1.0 (+https://sumo.stavesandhoop.com; weight backfill)';
const WRITE_THROTTLE_MS = 350;
const API_THROTTLE_MS = 400;

const DB = { banzuke: '8e3457a9-2747-4275-9b91-7ac03fe18290' };

if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function notion(path, method = 'GET', body, attempt = 0) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status === 529) && attempt < 6) {
    const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
    console.warn(`  ${res.status} rate-limited on ${method} ${path} — waiting ${Math.round(wait/1000)}s`);
    await sleep(wait);
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
const titleOf = (page, prop) => { const p = page.properties?.[prop]; const arr = p?.title || p?.rich_text || []; return arr.map(t => t.plain_text).join('').trim(); };
const numberOf = (page, prop) => { const n = page.properties?.[prop]?.number; return (typeof n === 'number') ? n : null; };

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`sumo-api ${url} -> ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}
async function fetchWeight(sumoId) {
  if (!sumoId) return null;
  try {
    const r = await getJson(`${API}/rikishi/${sumoId}`);
    return (typeof r.weight === 'number' && r.weight > 0) ? Math.round(r.weight) : null;
  } catch (e) { console.warn(`  rikishi ${sumoId} detail failed: ${e.message}`); return null; }
}

async function main() {
  console.log(`backfill-weights: ${BASHO_LABEL} (${BASHO}) · DRY_RUN=${DRY ? 'ON (census, no writes)' : 'OFF (WRITING)'}`);

  // 1) sumo-api banzuke → name -> rikishiID (the only place shikonaEn maps to a sumo ID).
  const bz = await getJson(`${API}/basho/${BASHO}/banzuke/${DIVISION}`);
  const roster = [...(bz.east || []), ...(bz.west || [])];
  if (!roster.length) { console.error(`✗ sumo-api has no ${DIVISION} banzuke for ${BASHO}. Nothing to do.`); process.exit(1); }
  const idByName = new Map(roster.map(r => [r.shikonaEn, r.rikishiID]));
  console.log(`  sumo-api roster: ${roster.length} wrestlers.`);

  // 2) Notion Banzuke entries for THIS tournament that are missing Weight (kg).
  const entries = (await queryAll(DB.banzuke)).filter(p => {
    const rel = p.properties?.['Tournament']?.relation || [];
    return rel.some(x => x.id?.replace(/-/g, '') === TOURNAMENT_PAGE_ID.replace(/-/g, ''));
  });
  const missing = entries.filter(p => numberOf(p, 'Weight (kg)') == null);
  console.log(`  ${BASHO_LABEL} Banzuke entries: ${entries.length} · already have weight: ${entries.length - missing.length} · missing: ${missing.length}`);

  let filled = 0; const blanks = [], unmatched = [];
  for (const p of missing) {
    const entryTitle = titleOf(p, 'Entry');            // "Name — Aki 2026"
    const name = entryTitle.split(' — ')[0].trim();
    const sumoId = idByName.get(name);
    if (!sumoId) { unmatched.push(entryTitle); continue; }
    const kg = await fetchWeight(sumoId);   // fetched even in DRY so the census shows the real kg
    await sleep(API_THROTTLE_MS);
    if (!kg) { blanks.push(name); continue; }
    console.log(`  ${DRY ? 'would fill' : 'fill'}: ${name} → ${kg} kg`);
    if (!DRY) {
      await notion(`/pages/${p.id}`, 'PATCH', { properties: { 'Weight (kg)': { number: kg } } });
      await sleep(WRITE_THROTTLE_MS);
    }
    filled++;
  }

  console.log(`\n──────── ${DRY ? 'CENSUS (nothing written)' : 'DONE'} ────────`);
  console.log(`Weights ${DRY ? 'to fill' : 'filled'}: ${filled} · left blank (no sumo-api weight): ${blanks.length} · name-unmatched: ${unmatched.length}`);
  if (blanks.length) { console.log(`\n⚖️  BLANK — no weight from sumo-api (left blank, NOT faked — source by hand):`); for (const n of blanks) console.log('  - ' + n); }
  if (unmatched.length) { console.log(`\n⚠️  NAME-UNMATCHED — entry title didn't map to a sumo-api name (check spelling):`); for (const n of unmatched) console.log('  - ' + n); }
  if (DRY) console.log('\nDRY RUN. Review, then re-run with DRY_RUN=0.');
}

main().catch(e => { console.error(e); process.exit(1); });
