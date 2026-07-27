// gen-backfill-pass2.mjs — Historical enrichment (PASS 2) into Notion.
// Reads the static sumo-history.json (Pass 1 output) and folds the 9 historical basho
// (Jan 2025 → May 2026) into the Notion master DBs, so the WHOLE fandom era is visible
// and relational in Notion — Tournament ← Banzuke → Master Rikishi, and every bout in Match Log
// (which is what makes the historical Wins/Losses/Gold-Star rollups actually fill in).
//
// Runs in GitHub Actions (Node 20 fetch). Needs the repo's sumo-history.json + NOTION_TOKEN,
// and hits sumo-api ONLY (in a real run) to enrich wrestlers not yet in Master — Actions only.
//
// Modeled 1:1 on sync-notion.mjs house style (same notion()/queryAll()/ensureWrestler helpers).
//
// SAFETY: DRY_RUN defaults to "1". The dry run IS the census — it prints, per basho, how many
//   wrestlers + Banzuke entries + bouts it WOULD write and which kimarite aren't in the DB yet,
//   makes ZERO sumo-api calls, and writes NOTHING. Read it, fill kimarite gaps, then DRY_RUN=0.
//
// SCOPE / SAFETY RAILS:
//   - ADDITIVE ONLY + idempotent: skips any Master Rikishi / Banzuke entry / bout already present.
//     Re-runnable. Deletes nothing.
//   - Juryo visitors (opponents not in a basho's Makuuchi roster) get a "J" Banzuke entry so no
//     bout dangles — same as the live sync.
//   - Does NOT touch Tournament dates/location (Jennie-owned) or the live Nagoya 2026 data.
//   - Human-owned bout fields (Henka, Monoii, Rematch, bout Notes) are never set — history has none.
//
// ENV: NOTION_TOKEN (required) · DRY_RUN (default "1") · HISTORY (default sumo-history.json)
//      ONLY_BASHO (optional CSV of bashoIds, e.g. "202601,202603")

import fs from 'node:fs';
import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');
const HISTORY = process.env.HISTORY || 'sumo-history.json';
const ONLY = (process.env.ONLY_BASHO || '').split(',').map(s => s.trim()).filter(Boolean);
const NOTION_VERSION = '2022-06-28';
const API = 'https://www.sumo-api.com/api';
const UA = 'salt-stats-sumo-backfill/1.0 (+https://sumo.stavesandhoop.com; one-time historical enrichment)';
const WRITE_THROTTLE_MS = 350; // polite pacing on Notion writes
const API_THROTTLE_MS = 400;   // polite pacing on sumo-api (free, one-person API)

const DB = {
  matchLog:      '1a2bad82-ebf5-4472-87ea-cb2c2481f9f1',
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
  kimarite:      '2591d1eb-2146-4745-ab0a-72ba57bfd213',
  bashos:        'ae8b304d-8655-4072-934e-d01a43fe11ce', // Bashos DATABASE id (the /p/ url)
};

const MONTH_BASHO = { '01': 'Hatsu', '03': 'Haru', '05': 'Natsu', '07': 'Nagoya', '09': 'Aki', '11': 'Kyushu' };
const COUNTRIES = ['Japan','Bulgaria','Egypt','Georgia','Kazakhstan','Kyrgyzstan','Mongolia','Russia','Ukraine','China'];
// history rank is short form; accept sanyaku, any Maegashira M<n>, or Juryo J. Notion auto-creates
// a missing select option (e.g. M18) on write, so we don't need to pre-register ranks.
const validRank = r => /^(Yokozuna|Ozeki|Sekiwake|Komusubi|J|M\d{1,2})$/.test(String(r || ''));

if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Notion REST (mirrors sync-notion.mjs) ----------
async function notion(path, method = 'GET', body, attempt = 0) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Rate limited (429) or service overloaded (529): honor Retry-After and back off. Idempotent
  // work, so retrying is safe. Up to ~6 tries before giving up.
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
const textOf  = (page, prop) => (page.properties?.[prop]?.rich_text || []).map(t => t.plain_text).join('').trim();
const numOf   = (page, prop) => page.properties?.[prop]?.number ?? null;
const selOf   = (page, prop) => page.properties?.[prop]?.select?.name ?? null;

// ---------- sumo-api (real-run enrichment only; never called in DRY) ----------
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`sumo-api ${url} -> ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
}
async function searchRikishiIdByName(name) {
  try {
    const r = await getJson(`${API}/rikishis?shikonaEn=${encodeURIComponent(name)}&limit=5`);
    const rec = (r.records || []).find(x => x.shikonaEn === name) || (r.records || [])[0];
    return rec ? (rec.id ?? rec.rikishiID) : null;
  } catch (e) { console.warn(`  rikishi search "${name}" failed: ${e.message}`); return null; }
}
async function fetchRikishiDetail(sumoId) {
  if (!sumoId) return null;
  try {
    const r = await getJson(`${API}/rikishi/${sumoId}`);
    return {
      sumoId: r.id ?? sumoId, nskId: r.nskId ?? null, sumodbId: r.sumodbId ?? null,
      shikonaJp: r.shikonaJp ?? null, heya: r.heya ?? null,
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
  // Japanese hometowns come as "<Pref>-ken/to/fu, <City>-shi/ku/machi/gun" — all Japan.
  if (/japan/i.test(s) || /-(ken|to|fu|shi|ku|gun|machi|cho)\b/i.test(s) || /prefecture/i.test(s)) return 'Japan';
  return 'Other';
}
const short = iso => { const d = new Date(iso); return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCFullYear()).slice(2)}`; };

// ---------- main ----------
async function main() {
  console.log(`backfill-pass2: DRY_RUN=${DRY ? 'ON (census only, no writes, no sumo-api)' : 'OFF (WRITING)'} · history=${HISTORY}`);
  if (ONLY.length) console.log(`  limited to basho: ${ONLY.join(', ')}`);

  const hist = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
  const bashoList = Object.values(hist.basho || {}).filter(b => !ONLY.length || ONLY.includes(b.bashoId));
  if (!bashoList.length) { console.error('No basho to process.'); process.exit(1); }

  const [mrPages, bzPages, kmPages, boPages, mlPages] = await Promise.all([
    queryAll(DB.masterRikishi), queryAll(DB.banzuke), queryAll(DB.kimarite), queryAll(DB.bashos), queryAll(DB.matchLog),
  ]);
  const MR = new Map(mrPages.map(p => [titleOf(p, 'Ring Name'), p.id]));
  const BZ = new Map(bzPages.map(p => [titleOf(p, 'Entry'), p.id]));
  const KM = new Map(kmPages.map(p => [textOf(p, 'Kimarite').toLowerCase(), p.id]));
  const kimId = k => { const key = (k || '').trim().toLowerCase(); if (!key) return null; if (key === 'fusen') return KM.get('fusensho') || null; return KM.get(key) || null; };
  const TOUR = new Map(boPages.map(p => [`${selOf(p, 'Basho')}|${numOf(p, 'Year')}`, p.id]));
  const ML = new Set(mlPages.map(p => titleOf(p, 'Match')));

  const flags = [];
  const missingKimAll = new Set();
  let totRik = 0, totBz = 0, totBout = 0;

  for (const b of bashoList) {
    const label = b.label, yr = +b.bashoId.slice(0, 4), basho = MONTH_BASHO[b.bashoId.slice(4, 6)];
    const tourId = TOUR.get(`${basho}|${yr}`);
    console.log(`\n=== ${label} (${b.bashoId}) — ${basho} ${yr} · startDate ${b.startDate} · ${b.rikishi.length} rikishi · ${b.bouts.length} bouts ===`);
    if (!tourId) { flags.push(`${label}: no Tournament page for ${basho} ${yr}.`); console.log('  ✗ no Tournament page — skipping.'); continue; }

    const cache = new Map();     // name -> {mrId, bzId} for this basho
    let rikN = 0, bzN = 0;

    // ensure a wrestler has a Master record AND a Banzuke entry for THIS basho.
    // rankHint = roster rank for makuuchi wrestlers, else 'J' (Juryo visitor). sumoId from the
    // roster when known, else looked up by name (real run only).
    async function ensure(name, sumoId, rankHint) {
      if (cache.has(name)) return cache.get(name);

      let mrId = MR.get(name);
      if (!mrId) {
        rikN++;
        if (DRY) { console.log(`  [dry] would ensure Master "${name}" (${rankHint === 'J' ? 'juryo visitor' : 'orphan'})`); mrId = `dry-mr-${name}`; }
        else {
          const sid = sumoId || await searchRikishiIdByName(name);
          const d = await fetchRikishiDetail(sid); await sleep(API_THROTTLE_MS);
          const notes = [`Historical entry — added by backfill-pass2 (first seen ${label}).`];
          if (d?.shikonaJp) notes.push(`Kanji: ${d.shikonaJp}.`);
          if (d?.heya) notes.push(`Stable (heya): ${d.heya} — link by hand.`);
          if (!d) { notes.push('sumo-api enrichment unavailable — profile blank.'); flags.push(`"${name}": enrichment failed; created name-only.`); }
          notes.push('Photo pending (JSA-only).');
          const props = {
            'Ring Name': { title: [{ text: { content: name } }] },
            'Active': { checkbox: false },
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

      const entryTitle = `${name} — ${label}`;
      let bzId = BZ.get(entryTitle);
      if (!bzId) {
        bzN++;
        const rank = validRank(rankHint) ? rankHint : 'J';
        if (rankHint && !validRank(rankHint)) flags.push(`${label}: odd rank "${rankHint}" for ${name} -> filed as J.`);
        if (DRY) { bzId = `dry-bz-${name}`; }
        else {
          const props = {
            'Entry': { title: [{ text: { content: entryTitle } }] },
            'Rank': { select: { name: rank } },
            'Rikishi': { relation: [{ id: mrId }] },
            'Tournament': { relation: [{ id: tourId }] },
          };
          if ((b.yusho || []).includes(name)) props['Yusho'] = { checkbox: true };
          const p = await notion('/pages', 'POST', { parent: { database_id: DB.banzuke }, properties: props });
          bzId = p.id; await sleep(WRITE_THROTTLE_MS);
        }
        BZ.set(entryTitle, bzId);
      }
      const rec = { mrId, bzId }; cache.set(name, rec); return rec;
    }

    // Phase A: the Makuuchi roster (rank-carrying entries)
    for (const r of b.rikishi) await ensure(r.name, r.id, r.rank);

    // Phase B: bouts — ensure() covers any Juryo-visitor opponent with a J entry, so nothing dangles
    let boutN = 0; const missKim = new Set();
    for (const bt of b.bouts) {
      const title = `${bt.winner} vs ${bt.loser} · Day ${bt.day} · ${short(bt.date)}`;
      if (ML.has(title)) continue;
      const W = await ensure(bt.winner, null, 'J');
      const L = await ensure(bt.loser, null, 'J');
      const tId = kimId(bt.kimarite);
      if (!tId && bt.kimarite) { missKim.add(bt.kimarite); missingKimAll.add(bt.kimarite); }
      boutN++;
      if (DRY) { ML.add(title); continue; }
      const props = {
        'Match': { title: [{ text: { content: title } }] },
        'Day #': { number: bt.day }, 'Date': { date: { start: bt.date } },
        'Winner': { relation: [{ id: W.mrId }] }, 'Loser': { relation: [{ id: L.mrId }] },
        'Winner Banzuke': { relation: [{ id: W.bzId }] }, 'Loser Banzuke': { relation: [{ id: L.bzId }] },
        'Tournament': { relation: [{ id: tourId }] },
      };
      if (tId) props['Technique'] = { relation: [{ id: tId }] };
      if (bt.goldStar) props['Gold Star'] = { checkbox: true };
      await notion('/pages', 'POST', { parent: { database_id: DB.matchLog }, properties: props });
      ML.add(title); await sleep(WRITE_THROTTLE_MS);
    }
    console.log(`  wrestlers: ${rikN} to create · banzuke: ${bzN} entr${bzN===1?'y':'ies'} to create · bouts: ${boutN} to write${missKim.size ? ` · ${missKim.size} kimarite not in DB: ${[...missKim].join(', ')}` : ''}`);
    totRik += rikN; totBz += bzN; totBout += boutN;
  }

  console.log(`\n──────── ${DRY ? 'CENSUS (nothing written)' : 'DONE'} ────────`);
  console.log(`wrestlers to create: ${totRik} · banzuke entries: ${totBz} · bouts: ${totBout}`);
  if (missingKimAll.size) {
    console.log(`\n⚠️  KIMARITE MISSING FROM DB (${missingKimAll.size}) — add to 🥋 Kimarite before the real run so bouts link their technique:`);
    console.log('  ' + [...missingKimAll].sort().join(', '));
  }
  if (flags.length) { console.log('\n⚠️  FLAGS:'); for (const f of [...new Set(flags)]) console.log('  - ' + f); }
  else console.log('No flags.');
  if (DRY) console.log('\nDRY RUN. Review counts, fill kimarite gaps, then re-run with DRY_RUN=0.');
}

main().catch(e => { console.error(e); process.exit(1); });
