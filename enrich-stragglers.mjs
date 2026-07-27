// enrich-stragglers.mjs — authoritative enrichment for name-only "straggler" wrestlers.
// These Juryo visitors were created name-only because the backfill had no wrestler-ID for them and
// the name-search failed. This recovers their real sumo-api ID from the BANZUKE (where their names
// came from — guaranteed to find them), fetches the profile, and writes Height / Birthday / Country /
// JSA ID onto their EXISTING Master Rikishi page. Source of truth = sumo-api, not a web guess.
//
// Runs in GitHub Actions (sumo-api reachable only there). Needs NOTION_TOKEN.
// SAFETY: DRY_RUN defaults to "1" — prints exactly what it WOULD set, writes nothing. Then DRY_RUN=0.
//         Fills only the four profile fields; touches nothing else. Idempotent.
// ENV: NOTION_TOKEN (required) · DRY_RUN (default "1") · STRAGGLERS (default "Shiden,Hidenoumi")

import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');
const NAMES = (process.env.STRAGGLERS || 'Shiden,Hidenoumi').split(',').map(s => s.trim()).filter(Boolean);
const NOTION_VERSION = '2022-06-28';
const API = 'https://www.sumo-api.com/api';
const UA = 'salt-stats-sumo/1.0 (+https://sumo.stavesandhoop.com; straggler enrichment)';
const DIV = 'Makuuchi';
const BASHO = ['202501','202503','202505','202507','202509','202511','202601','202603','202605'];
const MR_DB = 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9';
const COUNTRIES = ['Japan','Bulgaria','Egypt','Georgia','Kazakhstan','Kyrgyzstan','Mongolia','Russia','Ukraine','China'];

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
const titleOf = (p, k) => { const x = p.properties?.[k]; const a = x?.title || x?.rich_text || []; return a.map(t => t.plain_text).join('').trim(); };
async function getJson(u) { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }); if (!r.ok) throw new Error(`${u} -> ${r.status}`); return r.json(); }
function mapCountry(s) {
  if (!s) return null; const t = String(s);
  for (const c of COUNTRIES) if (t.toLowerCase().includes(c.toLowerCase())) return c;
  if (/japan/i.test(t) || /-(ken|to|fu|shi|ku|gun|machi|cho)\b/i.test(t) || /prefecture/i.test(t)) return 'Japan';
  return 'Other';
}

async function main() {
  console.log(`enrich-stragglers: DRY_RUN=${DRY ? 'ON (no writes)' : 'OFF (WRITING)'} · ${NAMES.join(', ')}\n`);

  // recover sumo-api IDs from the banzuke opponent records
  const idOf = new Map(NAMES.map(n => [n, null]));
  for (const code of BASHO) {
    if ([...idOf.values()].every(Boolean)) break;
    let bz; try { bz = await getJson(`${API}/basho/${code}/banzuke/${DIV}`); } catch (e) { console.warn(`  ${code} banzuke failed: ${e.message}`); continue; }
    for (const w of [...(bz.east || []), ...(bz.west || [])]) for (const rec of (w.record || [])) {
      const on = rec.opponentShikonaEn; if (on && idOf.has(on) && !idOf.get(on)) idOf.set(on, rec.opponentID);
    }
    await sleep(1200);
  }

  const mr = await queryAll(MR_DB);
  const pageOf = new Map(mr.map(p => [titleOf(p, 'Ring Name'), p.id]));

  for (const [name, id] of idOf) {
    if (!id) { console.log(`✗ ${name}: no ID found in banzuke — skipped.`); continue; }
    const pageId = pageOf.get(name);
    if (!pageId) { console.log(`✗ ${name}: no Master Rikishi page — skipped.`); continue; }
    let d; try { d = await getJson(`${API}/rikishi/${id}`); await sleep(1000); } catch (e) { console.log(`✗ ${name}: rikishi ${id} fetch failed: ${e.message}`); continue; }

    const props = {};
    if (typeof d.height === 'number' && d.height > 0) props['Height (cm)'] = { number: Math.round(d.height) };
    if (d.birthDate) props['Birthday'] = { date: { start: String(d.birthDate).slice(0, 10) } };
    const country = mapCountry(d.shusshin); if (country) props['Country of Origin'] = { select: { name: country } };
    if (d.nskId) props['JSA ID'] = { rich_text: [{ text: { content: String(d.nskId) } }] };

    console.log(`${name} (id ${id}): JSA ${d.nskId ?? '—'} · ${d.height ?? '—'}cm · ${d.birthDate ? String(d.birthDate).slice(0,10) : '—'} · ${country ?? '—'} (from "${d.shusshin ?? '—'}")`);
    if (!DRY) { await notion(`/pages/${pageId}`, 'PATCH', { properties: props }); await sleep(350); console.log('  ✓ written'); }
  }
  console.log(`\n${DRY ? 'DRY RUN — nothing written. Review, then re-run with DRY_RUN=0.' : 'DONE — enrichment written.'}`);
}
main().catch(e => { console.error(e); process.exit(1); });
