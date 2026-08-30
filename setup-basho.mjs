// setup-basho.mjs — NEW-BASHO SETUP: pull the announced banzuke from sumo-api and create the
// ranked Banzuke entries (+ any newcomer Master Rikishi pages) in Notion. Collapses Rollover
// Part A / Phase 1 of the Banzuke-Drop Runbook into one idempotent run.
//
// Runs in GitHub Actions (Node 20 fetch, NOTION_TOKEN). Point it at the new basho code once the
// banzuke drops (~2 weeks before Day 1); it does NOT write bouts (there are none yet) — banzuke
// roster only. The daily sync + publish pipeline take over from there.
//
// Modeled 1:1 on gen-backfill-pass2.mjs house style (same notion()/queryAll()/ensure() shape) and
// reuses build-standings.mjs's proven banzuke endpoint + rankInfo(). ADDITIVE + idempotent: skips
// any Master Rikishi or Banzuke entry already present; deletes nothing; re-runnable.
//
// SAFETY: DRY_RUN defaults to "1". The dry run IS the census — it fetches the banzuke, prints how
//   many Banzuke entries + newcomer Master pages it WOULD create (and names the newcomers), makes
//   ZERO enrichment calls and writes NOTHING. Read it, then re-run with DRY_RUN=0.
//
// SCOPE / RAILS:
//   - Makuuchi only (the division we track). Juryo visitors are NOT created here — the live sync
//     auto-creates them on the fly when their bouts land, exactly as today.
//   - Newcomer Master pages get sumo-api enrichment (height/birthday/country, JSA ID flagged) +
//     a "Photo pending (JSA-only)" note. Real Name + Photo stay HUMAN-owned (pull from JSA, run
//     onboard-rikishi for the head-crop). Enrichment NEVER overwrites an existing Master page.
//   - The Tournament page must already exist in the Bashos DB (it does for all 2026 basho).
//
// ENV: NOTION_TOKEN (required) · DRY_RUN (default "1") ·
//      BASHO / BASHO_LABEL / TOURNAMENT_PAGE_ID (default to Aki 2026 below; override per basho)

import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');

// ─── PER-BASHO CONFIG — the three values that change each tournament ──────────────────
//   BASHO             : sumo-api basho code YYYYMM (the announced banzuke).
//   BASHO_LABEL       : exact text used in Banzuke "Entry" titles, e.g. "Onosato — Aki 2026".
//                       MUST match what sync-notion.mjs / build-standings use, char-for-char.
//   TOURNAMENT_PAGE_ID: the Notion Bashos page for THIS basho (dashed UUID). Already exists.
const BASHO             = process.env.BASHO || '202609';
const BASHO_LABEL       = process.env.BASHO_LABEL || 'Aki 2026';
const TOURNAMENT_PAGE_ID= process.env.TOURNAMENT_PAGE_ID || '3351ade1-241f-8011-8987-d959538f54a0';
// ─────────────────────────────────────────────────────────────────────────────────────

const DIVISION = 'Makuuchi';
const NOTION_VERSION = '2022-06-28';
const API = 'https://www.sumo-api.com/api';
const UA = 'salt-stats-sumo-setup/1.0 (+https://sumo.stavesandhoop.com; new-basho banzuke setup)';
const WRITE_THROTTLE_MS = 350; // polite pacing on Notion writes
const API_THROTTLE_MS = 400;   // polite pacing on sumo-api (free, one-person API)

const DB = {
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
};

const COUNTRIES = ['Japan','Bulgaria','Egypt','Georgia','Kazakhstan','Kyrgyzstan','Mongolia','Russia','Ukraine','China'];
const validRank = r => /^(Yokozuna|Ozeki|Sekiwake|Komusubi|M\d{1,2})$/.test(String(r || ''));

if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Notion REST (mirrors gen-backfill-pass2.mjs) ----------
async function notion(path, method = 'GET', body, attempt = 0) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status === 529) && attempt < 6) {
    const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
    console.warn(`  ${res.status} rate-limited on ${method} ${path} — waiting ${Math.round(wait/1000)}s (try ${attempt + 1})`);
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

// ---------- sumo-api ----------
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`sumo-api ${url} -> ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}
// The banzuke endpoint — the SAME one build-standings.mjs reads live. east/west arrays,
// each entry: { rikishiID, shikonaEn, rank ("Maegashira 1 East" / "Yokozuna 1 East"), rankValue }.
// PREFLIGHT-AWARE: distinguishes "banzuke not posted yet" (404, or 200-with-empty-roster — a benign
// STOP-and-wait) from an actual fetch failure. Never throws; returns a tagged result the caller gates on.
async function getBanzuke() {
  const url = `${API}/basho/${BASHO}/banzuke/${DIVISION}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  } catch (e) {
    return { error: `network error reaching sumo-api: ${e.message}` };
  }
  if (res.status === 404) return { notPosted: true };
  if (!res.ok) return { error: `sumo-api ${res.status}: ${(await res.text()).slice(0, 200)}` };
  let j;
  try { j = await res.json(); } catch (e) { return { error: `sumo-api returned non-JSON: ${e.message}` }; }
  const all = [...(j.east || []), ...(j.west || [])];
  return { all };
}
// rankInfo — verbatim from build-standings.mjs. Returns the Notion short rank in .rank.
function rankInfo(rankStr) {
  const parts = String(rankStr || '').split(' ');
  const w = parts[0];
  if (w === 'Yokozuna') return { rank: 'Yokozuna' };
  if (w === 'Ozeki')    return { rank: 'Ozeki' };
  if (w === 'Sekiwake') return { rank: 'Sekiwake' };
  if (w === 'Komusubi') return { rank: 'Komusubi' };
  if (w === 'Maegashira') return { rank: 'M' + parts[1] };
  return { rank: rankStr };
}
async function fetchRikishiDetail(sumoId) {
  if (!sumoId) return null;
  try {
    const r = await getJson(`${API}/rikishi/${sumoId}`);
    return {
      nskId: r.nskId ?? null, shikonaJp: r.shikonaJp ?? null, heya: r.heya ?? null,
      birthDate: r.birthDate ? String(r.birthDate).slice(0,10) : null,
      shusshin: r.shusshin ?? null,
      heightCm: (typeof r.height === 'number' && r.height > 0) ? Math.round(r.height) : null,
      weightKg: (typeof r.weight === 'number' && r.weight > 0) ? Math.round(r.weight) : null,
    };
  } catch (e) { console.warn(`  rikishi ${sumoId} enrichment failed: ${e.message}`); return null; }
}
function mapCountry(shusshin) {
  if (!shusshin) return null;
  const s = String(shusshin);
  for (const c of COUNTRIES) if (s.toLowerCase().includes(c.toLowerCase())) return c;
  if (/japan/i.test(s) || /-(ken|to|fu|shi|ku|gun|machi|cho)\b/i.test(s) || /prefecture/i.test(s)) return 'Japan';
  return 'Other';
}

// ---------- main ----------
async function main() {
  console.log(`setup-basho: ${BASHO_LABEL} (${BASHO}) · DRY_RUN=${DRY ? 'ON (census only, no writes, no enrichment)' : 'OFF (WRITING)'}`);
  console.log(`  Tournament page: ${TOURNAMENT_PAGE_ID}`);

  // ── PREFLIGHT: is the banzuke even posted? Runs BEFORE any Notion query or write. ──
  const b = await getBanzuke();
  if (b.error) {
    console.error(`\n✗ Could NOT reach sumo-api — this is a fetch problem, not a "banzuke missing" result:`);
    console.error(`    ${b.error}`);
    console.error(`  Nothing was done. Wait a moment and re-run.`);
    process.exit(1);
  }
  if (b.notPosted || !b.all || !b.all.length) {
    console.log(`\n⏸  BANZUKE NOT POSTED YET — ${BASHO_LABEL} (${BASHO}).`);
    console.log(`   sumo-api has no Makuuchi banzuke for this basho yet — it hasn't dropped.`);
    console.log(`   ✋ This is NOT an error. Nothing was written and no Notion call was made.`);
    console.log(`   STOP HERE. Do not run any other banzuke-drop step. Re-run this once the banzuke is up.`);
    process.exit(0);   // clean exit: the check ran fine; the answer is "not yet."
  }
  const all = b.all;
  all.sort((x, y) => (x.rankValue - y.rankValue) || String(x.shikonaEn).localeCompare(String(y.shikonaEn)));
  console.log(`  ✓ banzuke IS posted: ${all.length} Makuuchi wrestlers.`);

  const [mrPages, bzPages] = await Promise.all([queryAll(DB.masterRikishi), queryAll(DB.banzuke)]);
  const MR = new Map(mrPages.map(p => [titleOf(p, 'Ring Name'), p.id]));
  const BZ = new Set(bzPages.map(p => titleOf(p, 'Entry')));

  const flags = [];
  const newcomers = [];
  let bzCreate = 0, mrCreate = 0, skipEntry = 0;

  for (const r of all) {
    const name = r.shikonaEn;
    const rank = rankInfo(r.rank).rank;
    if (!validRank(rank)) { flags.push(`${name}: unexpected rank "${r.rank}" -> "${rank}" — VERIFY (entry still created).`); }

    // 1) Master Rikishi — create + enrich only if the wrestler is new. Never touch an existing page.
    let mrId = MR.get(name);
    if (!mrId) {
      mrCreate++; newcomers.push(`${name} (${rank})`);
      if (DRY) { mrId = `dry-mr-${name}`; }
      else {
        const d = await fetchRikishiDetail(r.rikishiID); await sleep(API_THROTTLE_MS);
        const notes = [`New Makuuchi entrant — added by setup-basho (first seen ${BASHO_LABEL}).`];
        if (d?.shikonaJp) notes.push(`Kanji: ${d.shikonaJp}.`);
        if (d?.heya) notes.push(`Stable (heya): ${d.heya} — link by hand.`);
        if (!d) { notes.push('sumo-api enrichment unavailable — profile blank.'); flags.push(`"${name}": enrichment failed; created name-only.`); }
        notes.push('Real Name + Photo pending (JSA-only); run onboard-rikishi for the head-crop.');
        const props = {
          'Ring Name': { title: [{ text: { content: name } }] },
          'Active': { checkbox: true },
          'Notes': { rich_text: [{ text: { content: notes.join(' ') } }] },
        };
        if (d?.heightCm) props['Height (cm)'] = { number: d.heightCm };
        if (d?.birthDate) props['Birthday'] = { date: { start: d.birthDate } };
        const country = mapCountry(d?.shusshin);
        if (country) { props['Country of Origin'] = { select: { name: country } }; if (country === 'Other') flags.push(`"${name}": origin "${d?.shusshin}" -> Other, verify.`); }
        if (d?.nskId) { props['JSA ID'] = { rich_text: [{ text: { content: String(d.nskId) } }] }; flags.push(`"${name}": JSA ID ${d.nskId} from sumo-api nskId — VERIFY.`); }
        const p = await notion('/pages', 'POST', { parent: { database_id: DB.masterRikishi }, properties: props });
        mrId = p.id; await sleep(WRITE_THROTTLE_MS);
      }
      MR.set(name, mrId);
    }

    // 2) Banzuke entry for THIS basho — idempotent on the entry title.
    const entryTitle = `${name} — ${BASHO_LABEL}`;
    if (BZ.has(entryTitle)) { skipEntry++; continue; }
    bzCreate++;
    if (!DRY) {
      const props = {
        'Entry': { title: [{ text: { content: entryTitle } }] },
        'Rank': { select: { name: rank } },
        'Rikishi': { relation: [{ id: mrId }] },
        'Tournament': { relation: [{ id: TOURNAMENT_PAGE_ID }] },
      };
      await notion('/pages', 'POST', { parent: { database_id: DB.banzuke }, properties: props });
      await sleep(WRITE_THROTTLE_MS);
    }
    BZ.add(entryTitle);
  }

  console.log(`\n──────── ${DRY ? 'CENSUS (nothing written)' : 'DONE'} ────────`);
  console.log(`Banzuke entries to create: ${bzCreate} · already present (skipped): ${skipEntry} · newcomer Master pages: ${mrCreate}`);
  if (newcomers.length) { console.log(`\nNEWCOMERS (new Master Rikishi — pull Real Name + Photo from JSA, run onboard-rikishi):`); for (const n of newcomers) console.log('  - ' + n); }
  if (flags.length) { console.log('\n⚠️  FLAGS:'); for (const f of [...new Set(flags)]) console.log('  - ' + f); }
  else console.log('No flags.');
  if (DRY) console.log('\nDRY RUN. Review the census + newcomers, then re-run with DRY_RUN=0.');
  else console.log(`\n✓ ${BASHO_LABEL} banzuke roster is in Notion. Next: flip the config (Phase 2) and dry-run the sync.`);
}

main().catch(e => { console.error(e); process.exit(1); });
