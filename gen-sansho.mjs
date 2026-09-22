// gen-sansho.mjs — pull the SANSHO (special prize) winners per basho from sumo-api, Jan 2025 → present.
// REPORT ONLY: prints a clean per-basho list and writes NOTHING — you fill the 📋 Banzuke `Special Prizes`
// from the log by hand (or we wire a diff-first writer later; that's the reconciliation-tool work).
//
// WHY A SCRIPT: sumo-api is reachable ONLY from GitHub Actions (403 from the Cowork sandbox + WebFetch),
// the same wall gen-history / build-standings / setup-basho work around. So this runs on the Action.
//
// SELF-DIAGNOSING: the exact sanshō field on sumo-api's /basho/{id} endpoint isn't verified from here, so
// this tries the likely field names and, on a MISS, prints the raw basho-endpoint keys + a sample so we
// can pin the shape and adjust in one pass (same posture as gen-rikishi-metrics / setup-basho — never fake).
//
// USAGE (Actions, manual): node gen-sansho.mjs        [BASHO_LIST=202501,202503,... to override]
import process from 'node:process';

const API = 'https://www.sumo-api.com/api';
const UA = 'salt-stats-sumo-sansho/1.0 (+https://sumo.stavesandhoop.com; one-off sansho report)';
const THROTTLE_MS = 1500;   // polite to a free, one-person API
// Completed basho since the crew's Jan-2025 era through Nagoya 2026 (Aki 202609 excluded — sanshō aren't
// awarded until senshuraku, and it's the live basho). Nagoya 2026 is already in Notion; kept here so you
// can spot-check the pull against what you already recorded.
const BASHO = (process.env.BASHO_LIST || '202501,202503,202505,202507,202509,202511,202601,202603,202605,202607').split(',').map(s => s.trim()).filter(Boolean);
const LABEL = {
  '202501': 'Hatsu 2025', '202503': 'Haru 2025', '202505': 'Natsu 2025', '202507': 'Nagoya 2025',
  '202509': 'Aki 2025', '202511': 'Kyushu 2025', '202601': 'Hatsu 2026', '202603': 'Haru 2026',
  '202605': 'Natsu 2026', '202607': 'Nagoya 2026', '202609': 'Aki 2026', '202611': 'Kyushu 2026',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Map sumo-api's prize-type string to the crew's Banzuke `Special Prizes` option names (exact match).
function toPrize(s) {
  const t = String(s || '').toLowerCase();
  if (/shukun|outstanding/.test(t)) return 'Outstanding Performance';
  if (/kant|fighting/.test(t))      return 'Fighting Spirit';
  if (/gin|techni/.test(t))         return 'Technique';
  return null;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// Pull the sanshō entries out of the basho payload, defending against field-name variants.
function extractSansho(j) {
  const arr = j.specialPrizes || j.sansho || j.prizes || j.specialPrize || [];
  const out = [];
  for (const x of (Array.isArray(arr) ? arr : [])) {
    const prize = toPrize(x.type || x.prize || x.name || x.award);
    const rawName = x.shikonaEn || x.shikona || x.rikishiEn || x.name || x.shikona_en || null;
    if (prize && rawName) out.push({ prize, who: String(rawName).split(' ')[0] });   // shikona first token
  }
  return out;
}

async function main() {
  console.log(`Sanshō report — ${BASHO.length} basho (${LABEL[BASHO[0]] || BASHO[0]} … ${LABEL[BASHO.at(-1)] || BASHO.at(-1)}). Source: sumo-api. REPORT ONLY — nothing written.\n`);
  let dumpedOnce = false;
  const flags = [];
  for (const code of BASHO) {
    try {
      const j = await getJson(`${API}/basho/${code}`);
      const sansho = extractSansho(j);
      if (!sansho.length && !dumpedOnce) {   // first miss → show the shape so we can adjust
        dumpedOnce = true;
        console.log(`  ⚠️ no sanshō parsed for ${code}. Raw basho-endpoint keys: [${Object.keys(j).join(', ')}]`);
        console.log(`  ⚠️ sample: ${JSON.stringify(j).slice(0, 700)}\n`);
      }
      const byPrize = { 'Outstanding Performance': [], 'Fighting Spirit': [], 'Technique': [] };
      for (const s of sansho) byPrize[s.prize].push(s.who);
      console.log(`${LABEL[code] || code} (${code}):`);
      for (const p of ['Outstanding Performance', 'Fighting Spirit', 'Technique'])
        console.log(`  ${p}: ${byPrize[p].join(', ') || '—'}`);
      console.log('');
      if (!sansho.length) flags.push(`${code}: 0 sanshō parsed`);
    } catch (e) { console.error(`  ✗ ${code}: ${e.message}`); flags.push(`${code}: ${e.message}`); }
    await sleep(THROTTLE_MS);
  }
  console.log('Done — REPORT ONLY, nothing written. Fill the Banzuke `Special Prizes` from the above, or say the word and I\'ll wire a diff-first writer that shows you every change before it touches Notion.');
  if (flags.length) { console.log('\n⚠️ flags (check the raw-shape dump above):'); for (const f of flags) console.log('  - ' + f); }
}
main().catch(e => { console.error(e); process.exit(1); });
