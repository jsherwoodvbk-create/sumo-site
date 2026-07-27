// gen-backfill-pass2.mjs — Historical enrichment (PASS 2) into Notion.
// Reads the static sumo-history.json (Pass 1 output) and folds the 9 historical basho
// (Jan 2025 → May 2026) into the Notion master DBs, so the WHOLE fandom era is visible
// and relational in Notion — Tournament ← Banzuke → Master Rikishi, and every bout in Match Log
// (which is what makes the historical Wins/Losses/Gold-Star rollups actually fill in).
//
// Runs in GitHub Actions (Node 20 fetch). Needs the repo's sumo-history.json + NOTION_TOKEN,
// and hits sumo-api ONLY to enrich orphan (retired) wrestlers — reachable only from Actions.
//
// Modeled 1:1 on sync-notion.mjs house style (same notion()/queryAll()/ensureWrestler helpers).
//
// SAFETY: DRY_RUN defaults to "1". The dry run IS the census — it prints, per basho, how many
//   orphan wrestlers are missing, how many Banzuke entries + bouts it would write, and which
//   kimarite aren't in the Kimarite DB yet — and writes NOTHING. Read that report, fill any
//   kimarite gaps by hand, THEN run with DRY_RUN=0.
//
// SCOPE / SAFETY RAILS:
//   - ADDITIVE ONLY. Idempotent: skips any Master Rikishi / Banzuke entry / bout that already
//     exists. Re-runnable. Does NOT delete anything (delete-and-rebuild is a separate, explicit
//     future flag once the census shows what's stale).
//   - Does NOT touch Tournament dates/location (Jennie-owned; the census prints each basho's
//     JSON startDate for reference). Does NOT touch the live Nagoya 2026 data (not in history).
//   - Human-owned bout fields (Henka, Monoii, Rematch, bout Notes) are never set — history has none.
//
// ENV: NOTION_TOKEN (required) · DRY_RUN (default "1") · HISTORY (default sumo-history.json)
//      ONLY_BASHO (optional CSV of bashoIds to limit the run, e.g. "202601,202603")

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

const DB = {
  matchLog:      '1a2bad82-ebf5-4472-87ea-cb2c2481f9f1',
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
  kimarite:      '2591d1eb-2146-4745-ab0a-72ba57bfd213',
  bashos:        '9a33998f-9f28-4b24-8196-e8c907ccf80a',
};

// bashoId month -> Basho select value (fixed calendar)
const MONTH_BASHO = { '01': 'Hatsu', '03': 'Haru', '05': 'Natsu', '07': 'Nagoya', '09': 'Aki', '11': 'Kyushu' };
const COUNTRIES = ['Japan','Bulgaria','Egypt','Georgia','Kazakhstan','Kyrgyzstan','Mongolia','Russia','Ukraine','China'];
// Banzuke Rank select accepts these verbatim; history rank is already short form (Yokozuna/Ozeki/Sekiwake/Komusubi/M1..M17)
const RANK_OK = new Set(['Yokozuna','Ozeki','Sekiwake','Komusubi','J', ...Array.from({length:17},(_,i)=>'M'+(i+1))]);

if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Notion REST (mirrors sync-notion.mjs) ----------
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
const titleOf = (page, prop) => { const p = page.properties?.[prop]; const arr = p?.title || p?.rich_text || []; return arr.map(t => t.plain_text).join('').trim(); };
const textOf  = (page, prop) => (page.properties?.[prop]?.rich_text || []).map(t => t.plain_text).join('').trim();
const numOf   = (page, prop) => page.properties?.[prop]?.number ?? null;
const selOf   = (page, prop) => page.properties?.[prop]?.select?.name ?? null;

// ---------- sumo-api (orphan enrichment only) ----------
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`sumo-api ${url} -> ${r.status}: ${(await r.text()).slice(0,200)}`);
  return r.json();
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
  if (/japan/i.test(s) || /-ken\b/i.test(s) || /prefecture/i.test(s)) return 'Japan';
  return 'Other';
}

// small date helpers
const short = iso => { const d = new Date(iso); return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCFullYear()).slice(2)}`; };

// ---------- main ----------
async function main() {
  console.log(`backfill-pass2: DRY_RUN=${DRY ? 'ON (census only, no writes)' : 'OFF (WRITING)'} · history=${HISTORY}`);
  if (ONLY.length) console.log(`  limited to basho: ${ONLY.join(', ')}`);

  const hist = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
  const bashoList = Object.values(hist.basho || {}).filter(b => !ONLY.length || ONLY.includes(b.bashoId));
  if (!bashoList.length) { console.error('No basho to process (check HISTORY / ONLY_BASHO).'); process.exit(1); }

  // Pull the Notion side once and index it.
  const [mrPages, bzPages, kmPages, boPages, mlPages] = await Promise.all([
    queryAll(DB.masterRikishi), queryAll(DB.banzuke), queryAll(DB.kimarite), queryAll(DB.bashos), queryAll(DB.matchLog),
  ]);
  const MR = new Map(mrPages.map(p => [titleOf(p, 'Ring Name'), p.id]));                 // name -> master rikishi page id
  const BZ = new Map(bzPages.map(p => [titleOf(p, 'Entry'), p.id]));                      // "Name — Label" -> banzuke page id
  const KM = new Map(kmPages.map(p => [textOf(p, 'Kimarite').toLowerCase(), p.id]));      // kimarite (jp) -> kimarite page id
  const kimId = k => { const key = (k || '').trim().toLowerCase(); if (!key) return null; if (key === 'fusen') return KM.get('fusensho') || null; return KM.get(key) || null; };
  // Tournament page by "Basho|Year"
  const TOUR = new Map(boPages.map(p => [`${selOf(p, 'Basho')}|${numOf(p, 'Year')}`, p.id]));
  // Existing Match Log titles (idempotency for bouts)
  const ML = new Set(mlPages.map(p => titleOf(p, 'Match')));

  const flags = [];
  const missingKimAll = new Set();
  let totOrphan = 0, totBz = 0, totBout = 0;

  for (const b of bashoList) {
    const label = b.label;                                  // "Hatsu 2025"
    const yr = +b.bashoId.slice(0, 4);
    const basho = MONTH_BASHO[b.bashoId.slice(4, 6)];
    const tourId = TOUR.get(`${basho}|${yr}`);
    console.log(`\n=== ${label} (${b.bashoId}) — ${basho} ${yr} · startDate ${b.startDate} · ${b.rikishi.length} rikishi · ${b.bouts.length} bouts ===`);
    if (!tourId) { flags.push(`${label}: no Tournament page for ${basho} ${yr} — create it first, then re-run.`); console.log('  ✗ no Tournament page — skipping this basho.'); continue; }

    // ---- Phase 2+3: rikishi (enrich orphans) + banzuke entries ----
    const bzByName = new Map();   // name -> banzuke page id (this basho)
    let orphanN = 0, bzN = 0;
    for (const r of b.rikishi) {
      // ensure Master Rikishi
      let mrId = MR.get(r.name);
      if (!mrId) {
        orphanN++;
        const d = await fetchRikishiDetail(r.id);
        const notes = [`Historical entry — added by backfill-pass2 (first seen ${label}). Likely retired/dropped from makuuchi.`];
        if (d?.shikonaJp) notes.push(`Kanji: ${d.shikonaJp}.`);
        if (d?.heya) notes.push(`Stable (heya): ${d.heya} — link by hand.`);
        if (!d) notes.push('sumo-api enrichment unavailable — profile blank.');
        notes.push('Photo pending (JSA-only, not auto-fetched).');
        const props = {
          'Ring Name': { title: [{ text: { content: r.name } }] },
          'Active': { checkbox: false },
          'Notes': { rich_text: [{ text: { content: notes.join(' ') } }] },
        };
        if (d?.heightCm) props['Height (cm)'] = { number: d.heightCm };
        if (d?.birthDate) props['Birthday'] = { date: { start: d.birthDate } };
        const country = mapCountry(d?.shusshin);
        if (country) { props['Country of Origin'] = { select: { name: country } }; if (country === 'Other') flags.push(`"${r.name}": origin "${d?.shusshin}" -> Other, verify.`); }
        if (d?.nskId) { props['JSA ID'] = { rich_text: [{ text: { content: String(d.nskId) } }] }; flags.push(`"${r.name}": JSA ID ${d.nskId} from sumo-api nskId — VERIFY.`); }
        if (DRY) { console.log(`  [dry] CREATE Master Rikishi "${r.name}" (orphan${d ? ', enriched' : ', blank'})`); mrId = `dry-mr-${r.name}`; }
        else { const p = await notion('/pages', 'POST', { parent: { database_id: DB.masterRikishi }, properties: props }); mrId = p.id; await sleep(WRITE_THROTTLE_MS); }
        MR.set(r.name, mrId);
      }
      // ensure Banzuke entry for this basho
      const entryTitle = `${r.name} — ${label}`;
      let bzId = BZ.get(entryTitle);
      if (!bzId) {
        bzN++;
        const rank = RANK_OK.has(r.rank) ? r.rank : null;
        if (!rank) flags.push(`${label}: unknown rank "${r.rank}" for ${r.name} — Banzuke Rank left blank.`);
        const props = {
          'Entry': { title: [{ text: { content: entryTitle } }] },
          'Rikishi': { relation: [{ id: mrId }] },
          'Tournament': { relation: [{ id: tourId }] },
        };
        if (rank) props['Rank'] = { select: { name: rank } };
        if ((b.yusho || []).includes(r.name)) props['Yusho'] = { checkbox: true };
        if (DRY) { bzId = `dry-bz-${entryTitle}`; }
        else { const p = await notion('/pages', 'POST', { parent: { database_id: DB.banzuke }, properties: props }); bzId = p.id; await sleep(WRITE_THROTTLE_MS); }
        BZ.set(entryTitle, bzId);
      }
      bzByName.set(r.name, bzId);
    }
    console.log(`  rikishi: ${orphanN} orphan${orphanN === 1 ? '' : 's'} to create · banzuke: ${bzN} entr${bzN === 1 ? 'y' : 'ies'} to create (of ${b.rikishi.length})`);

    // ---- Phase 4: bouts into Match Log ----
    let boutN = 0; const missKim = new Set();
    for (const bt of b.bouts) {
      const title = `${bt.winner} vs ${bt.loser} · Day ${bt.day} · ${short(bt.date)}`;
      if (ML.has(title)) continue;                       // idempotent skip
      const wMr = MR.get(bt.winner), lMr = MR.get(bt.loser);
      const wBz = bzByName.get(bt.winner), lBz = bzByName.get(bt.loser);
      if (!wMr || !lMr || !wBz || !lBz) { flags.push(`${label} D${bt.day}: unresolved relation for ${bt.winner} vs ${bt.loser} — bout skipped.`); continue; }
      const tId = kimId(bt.kimarite);
      if (!tId && bt.kimarite) { missKim.add(bt.kimarite); missingKimAll.add(bt.kimarite); }
      boutN++;
      if (DRY) { ML.add(title); continue; }
      const props = {
        'Match': { title: [{ text: { content: title } }] },
        'Day #': { number: bt.day },
        'Date': { date: { start: bt.date } },
        'Winner': { relation: [{ id: wMr }] }, 'Loser': { relation: [{ id: lMr }] },
        'Winner Banzuke': { relation: [{ id: wBz }] }, 'Loser Banzuke': { relation: [{ id: lBz }] },
        'Tournament': { relation: [{ id: tourId }] },
      };
      if (tId) props['Technique'] = { relation: [{ id: tId }] };
      if (bt.goldStar) props['Gold Star'] = { checkbox: true };
      await notion('/pages', 'POST', { parent: { database_id: DB.matchLog }, properties: props });
      ML.add(title); await sleep(WRITE_THROTTLE_MS);
    }
    console.log(`  bouts: ${boutN} to write${missKim.size ? ` · ${missKim.size} kimarite not in DB: ${[...missKim].join(', ')}` : ''}`);
    totOrphan += orphanN; totBz += bzN; totBout += boutN;
  }

  console.log(`\n──────── ${DRY ? 'CENSUS (nothing written)' : 'DONE'} ────────`);
  console.log(`orphan rikishi: ${totOrphan} · banzuke entries: ${totBz} · bouts: ${totBout}`);
  if (missingKimAll.size) {
    console.log(`\n⚠️  KIMARITE MISSING FROM DB (${missingKimAll.size}) — add these to 🥋 Kimarite before the real run so bouts link their technique:`);
    console.log('  ' + [...missingKimAll].sort().join(', '));
  }
  if (flags.length) { console.log('\n⚠️  FLAGS:'); for (const f of [...new Set(flags)]) console.log('  - ' + f); }
  else console.log('No flags.');
  if (DRY) console.log('\nThis was a DRY RUN. Review the counts, fill any kimarite gaps, then re-run with DRY_RUN=0.');
}

main().catch(e => { console.error(e); process.exit(1); });
