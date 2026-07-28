// enrich-rikishi.mjs — full rikishi enrichment PROBE + writer, sourced from sumo-api.
// Supersedes the narrow enrich-stragglers pass. For each target Ring Name it:
//   1) resolves the sumo-api id (by the JSA ID / nskId already on the Notion page, with a
//      shikona-search fallback),
//   2) fetches the FULL profile incl. rank history, and
//   3) PRINTS a complete field inventory — so we can see exactly how rich sumo-api's rikishi
//      data is, including whether it carries anything like a real/birth name — then
//   4) maps the safe fields onto Master Rikishi: Height, Birthday, Country, JSA ID,
//      Highest Rank (computed from rank history), Stable (heya resolved to the Stable relation),
//      plus Real Name IF sumo-api exposes one.
//
// Runs in GitHub Actions (sumo-api reachable only there). Needs NOTION_TOKEN.
// DRY_RUN defaults "1" — prints everything, writes NOTHING. Re-run with DRY_RUN=0 to write. Idempotent.
// ENV: NOTION_TOKEN (req) · DRY_RUN (default "1") · NAMES (comma list; blank = retired 20 + Tomokaze)

import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');
const DEFAULT_NAMES = ['Endo','Hatsuyama','Hidenoumi','Hitoshi','Hokutofuji','Kagayaki','Kayo','Kitanowaka','Meisei','Mita','Nabatame','Nishikigi','Nishinoryu','Shiden','Shirokuma','Shonannoumi','Takarafuji','Tamashoho','Terunofuji','Tochitaikai','Tomokaze'];
const NAMES = (process.env.NAMES || DEFAULT_NAMES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const NOTION_VERSION = '2022-06-28';
const API = 'https://www.sumo-api.com/api';
const UA = 'salt-stats-sumo/1.0 (+https://sumo.stavesandhoop.com; rikishi enrichment)';
const MR_DB = 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9';
const STABLE_DB = 'eff4e763-c792-422d-9c90-943f9315cb41';
const normHeya = s => String(s || '').toLowerCase().replace(/-?beya$/, '').replace(/[^a-z0-9]/g, '');
const COUNTRIES = ['Japan','Bulgaria','Egypt','Georgia','Kazakhstan','Kyrgyzstan','Mongolia','Russia','Ukraine','China'];
const RANK_TIERS = [['yokozuna','Yokozuna'],['ozeki','Ozeki'],['sekiwake','Sekiwake'],['komusubi','Komusubi'],['maegashira','Maegashira'],['juryo','Juryo']];
const TIER_ORDER = { Yokozuna:0, Ozeki:1, Sekiwake:2, Komusubi:3, Maegashira:4, Juryo:5 };

if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function notion(path, method = 'GET', body, attempt = 0) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method, headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status === 529) && attempt < 6) {
    const w = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000; await sleep(w); return notion(path, method, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}
async function queryAll(dbId) {
  const out = []; let cursor;
  do { const b = { page_size: 100 }; if (cursor) b.start_cursor = cursor;
    const r = await notion(`/databases/${dbId}/query`, 'POST', b); out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor); return out;
}
const textOf = (p, k) => { const x = p.properties?.[k]; const a = x?.title || x?.rich_text || []; return a.map(t => t.plain_text).join('').trim(); };
async function getJson(u) { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }); if (!r.ok) throw new Error(`${u} -> ${r.status}`); return r.json(); }
function mapCountry(s) {
  if (!s) return null; const t = String(s);
  for (const c of COUNTRIES) if (t.toLowerCase().includes(c.toLowerCase())) return c;
  if (/japan/i.test(t) || /-(ken|to|fu|shi|ku|gun|machi|cho)\b/i.test(t) || /prefecture/i.test(t)) return 'Japan';
  return 'Other';
}
function highestRank(rankHistory) {
  let best = null;
  for (const e of (rankHistory || [])) {
    const t = String(e.rank || '').toLowerCase();
    for (const [needle, label] of RANK_TIERS) { if (t.includes(needle)) { if (best === null || TIER_ORDER[label] < TIER_ORDER[best]) best = label; break; } }
  }
  return best;
}
// resolve sumo-api id: prefer exact nskId (= our JSA ID) match, fall back to shikona search
async function resolveId(name, jsaId) {
  if (jsaId) {
    try { const q = await getJson(`${API}/rikishis?nskId=${encodeURIComponent(jsaId)}`); const arr = q.records || []; if (arr.length) return arr[0].id; } catch (e) { /* fall through */ }
  }
  try {
    const q = await getJson(`${API}/rikishis?shikonaEn=${encodeURIComponent(name)}&limit=20`);
    const arr = q.records || [];
    const m = arr.find(r => jsaId && String(r.nskId) === String(jsaId)) || arr.find(r => String(r.shikonaEn || '').toLowerCase() === name.toLowerCase());
    if (m) return m.id;
  } catch (e) { console.warn(`  ${name}: shikona search failed: ${e.message}`); }
  return null;
}

async function main() {
  console.log(`enrich-rikishi: DRY_RUN=${DRY ? 'ON (no writes)' : 'OFF (WRITING)'} · ${NAMES.length} targets\n`);
  const mr = await queryAll(MR_DB);
  const info = new Map();
  for (const p of mr) { const rn = textOf(p, 'Ring Name'); if (rn) info.set(rn, { pageId: p.id, jsaId: textOf(p, 'JSA ID') }); }

  // Stable relation resolver: normalized heya name -> Stable page id
  const stableRows = await queryAll(STABLE_DB);
  const stableMap = new Map();
  for (const p of stableRows) { const n = textOf(p, 'Name'); if (n) stableMap.set(normHeya(n), p.id); }
  console.log(`loaded ${stableMap.size} stables for relation matching\n`);

  for (const name of NAMES) {
    const rec = info.get(name);
    if (!rec) { console.log(`✗ ${name}: no Master Rikishi page — skipped.`); continue; }
    const id = await resolveId(name, rec.jsaId); await sleep(900);
    if (!id) { console.log(`✗ ${name}: could not resolve sumo-api id (JSA ${rec.jsaId || '—'}).`); continue; }
    let d; try { d = await getJson(`${API}/rikishi/${id}?ranks=true&measurements=true&shikonas=true`); await sleep(900); } catch (e) { console.log(`✗ ${name}: profile ${id} failed: ${e.message}`); continue; }

    // FULL inventory — this is the probe: print every top-level field sumo-api returns.
    const topKeys = Object.keys(d).filter(k => !['rankHistory', 'measurementHistory', 'shikonaHistory'].includes(k));
    console.log(`\n▼ ${name}  (sumo-api id ${id})`);
    for (const k of topKeys) console.log(`    ${k}: ${JSON.stringify(d[k])}`);
    const hr = highestRank(d.rankHistory);
    console.log(`    → computed Highest Rank: ${hr || '?'}  ·  heya(stable): ${d.heya || '—'}  ·  rankHistory entries: ${(d.rankHistory || []).length}`);

    // map the safe scalar fields
    const props = {};
    if (typeof d.height === 'number' && d.height > 0) props['Height (cm)'] = { number: Math.round(d.height) };
    if (d.birthDate) props['Birthday'] = { date: { start: String(d.birthDate).slice(0, 10) } };
    const country = mapCountry(d.shusshin); if (country) props['Country of Origin'] = { select: { name: country } };
    if (d.nskId) props['JSA ID'] = { rich_text: [{ text: { content: String(d.nskId) } }] };
    if (hr) props['Highest Rank'] = { select: { name: hr } };
    // Stable: resolve heya -> Stable relation page
    const stablePageId = d.heya ? stableMap.get(normHeya(d.heya)) : null;
    if (stablePageId) props['Stable'] = { relation: [{ id: stablePageId }] };
    // Real Name: only if sumo-api actually exposes a birth-name field. Unknown key until the probe shows us —
    // check the likely candidates; the inventory above reveals anything we should add here.
    const realName = d.realName || d.birthName || d.realNameEn || d.realNameJp || null;
    if (realName) props['Real Name'] = { rich_text: [{ text: { content: String(realName) } }] };

    console.log(`    would write: ${Object.keys(props).join(', ') || '(nothing new)'}${realName ? '' : '  · (no real-name field found in payload — see inventory)'}`);
    console.log(`    stable "${d.heya || '—'}" -> ${stablePageId ? 'Stable relation ' + stablePageId : 'NOT in Stable DB (skipped — add a Stable page if wanted)'}`);
    if (!DRY) { await notion(`/pages/${rec.pageId}`, 'PATCH', { properties: props }); await sleep(350); console.log('    ✓ written'); }
  }
  console.log(`\n${DRY ? 'DRY RUN — nothing written. Read the inventory above (esp. whether a real-name field exists), then re-run with DRY_RUN=0.' : 'DONE — enrichment written.'}`);
}
main().catch(e => { console.error(e); process.exit(1); });
