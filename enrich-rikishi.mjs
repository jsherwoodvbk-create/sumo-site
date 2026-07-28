// enrich-rikishi.mjs (v6) — full rikishi enrichment PROBE + writer, sourced from sumo-api.
// For each target Ring Name it:
//   1) resolves the sumo-api id — via JSA ID (nskId) / shikona search (active wrestlers),
//      then, for anyone that fails (retirees), recovers the id from PAST BANZUKE,
//   2) fetches the FULL profile incl. rank + shikona history, and
//   3) PRINTS a complete field inventory, then maps:
//        Height, Birthday, Country, JSA ID, Highest Rank (from rank history),
//        Debut (first pro basho -> date), Retirement (intai date; blank if active), Active (checkbox wired to intai: on iff not retired),
//        Past Ring Names (prior shikona; SHIKONA-ONLY; fill-if-blank so curated entries aren't clobbered),
//        Stable — CHANGE-AWARE: sets on first assignment; if sumo-api's current heya differs from the
//        stable on the Notion page, it logs the OLD stable into "Past Stables" and updates the current.
//      (sumo-api carries NO real/birth name — that stays JSA hand-entry.)
//
// Runs in GitHub Actions (sumo-api reachable only there). Needs NOTION_TOKEN.
// DRY_RUN defaults "1" — prints everything, writes NOTHING. Re-run with DRY_RUN=0 to write. Idempotent.
// ENV: NOTION_TOKEN (req) · DRY_RUN (default "1") · NAMES (comma list; blank = retired 20 + Tomokaze; "ALL" = every row)
// NOTE: requires "Past Stables", "Debut" (date), "Retirement" (date) properties on Master Rikishi.

import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');
const DEFAULT_NAMES = ['Endo','Hatsuyama','Hidenoumi','Hitoshi','Hokutofuji','Kagayaki','Kayo','Kitanowaka','Meisei','Mita','Nabatame','Nishikigi','Nishinoryu','Shiden','Shirokuma','Shonannoumi','Takarafuji','Tamashoho','Terunofuji','Tochitaikai','Tomokaze'];
const rawNames = String(process.env.NAMES || '').trim();
const ALL = /^(all|\*)$/i.test(rawNames);                 // NAMES=ALL -> enrich every Master Rikishi row
const NAMES = ALL ? [] : (rawNames || DEFAULT_NAMES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const NOTION_VERSION = '2022-06-28';
const API = 'https://www.sumo-api.com/api';
const UA = 'salt-stats-sumo/1.0 (+https://sumo.stavesandhoop.com; rikishi enrichment)';
const MR_DB = 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9';
const STABLE_DB = 'eff4e763-c792-422d-9c90-943f9315cb41';
const COUNTRIES = ['Japan','Bulgaria','Egypt','Georgia','Kazakhstan','Kyrgyzstan','Mongolia','Russia','Ukraine','China'];
const RANK_TIERS = [['yokozuna','Yokozuna'],['ozeki','Ozeki'],['sekiwake','Sekiwake'],['komusubi','Komusubi'],['maegashira','Maegashira'],['juryo','Juryo']];
const TIER_ORDER = { Yokozuna:0, Ozeki:1, Sekiwake:2, Komusubi:3, Maegashira:4, Juryo:5 };
const RECOVER_BASHO = ['202311','202401','202403','202405','202407','202409','202411','202501','202503','202505','202507','202509'];
const RECOVER_DIVS = ['Makuuchi','Juryo','Makushita'];
const normHeya = s => String(s || '').toLowerCase().replace(/-?beya$/, '').replace(/[^a-z0-9]/g, '');
const idEq = (a, b) => String(a || '').replace(/-/g, '').toLowerCase() === String(b || '').replace(/-/g, '').toLowerCase();

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
const relIdsOf = (p, k) => (p.properties?.[k]?.relation || []).map(r => r.id);
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
// sumo-api's shikonaEn bundles the given name ("Endo Shota"), so take only the SHIKONA (first token)
// and collect distinct prior shikona, excluding the current one. Clean, name-only history.
function pastRingNames(shikonaHistory, currentEn) {
  const cur = String(currentEn || '').trim().split(/\s+/)[0].toLowerCase();
  const seen = new Set(), out = [];
  for (const e of (shikonaHistory || [])) {
    const shikona = String(e.shikonaEn || e.shikona || e.name || '').trim().split(/\s+/)[0];
    const key = shikona.toLowerCase();
    if (shikona && key !== cur && !seen.has(key)) { seen.add(key); out.push(shikona); }
  }
  return out;
}
function appendUnique(existing, name) {
  const list = String(existing || '').split(',').map(s => s.trim()).filter(Boolean);
  if (name && !list.some(x => x.toLowerCase() === name.toLowerCase())) list.push(name);
  return list.join(', ');
}
// debut basho code "YYYYMM" -> ISO date on the 1st of that month
function debutDate(debut) {
  const s = String(debut || '');
  return /^\d{6}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-01` : null;
}
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
async function recoverFromBanzuke(names) {
  const found = new Map();
  const want = new Set(names);
  for (const code of RECOVER_BASHO) {
    if (found.size >= want.size) break;
    for (const div of RECOVER_DIVS) {
      let bz; try { bz = await getJson(`${API}/basho/${code}/banzuke/${div}`); await sleep(500); } catch (e) { continue; }
      for (const w of [...(bz.east || []), ...(bz.west || [])]) {
        const sn = w.shikonaEn || w.shikona;
        const rid = w.rikishiID ?? w.rikishiId ?? w.id;
        if (sn && want.has(sn) && !found.has(sn) && rid) found.set(sn, rid);
      }
    }
  }
  return found;
}

async function main() {
  console.log(`enrich-rikishi v6: DRY_RUN=${DRY ? 'ON (no writes)' : 'OFF (WRITING)'}\n`);
  const mr = await queryAll(MR_DB);
  const info = new Map();
  for (const p of mr) {
    const rn = textOf(p, 'Ring Name');
    if (rn) info.set(rn, { pageId: p.id, jsaId: textOf(p, 'JSA ID'), stableRelIds: relIdsOf(p, 'Stable'), pastStables: textOf(p, 'Past Stables'), curPastNames: textOf(p, 'Past Ring Names') });
  }
  const targets = ALL ? [...info.keys()] : NAMES;
  console.log(`targets: ${targets.length}${ALL ? ' (ALL Master Rikishi)' : ''}\n`);

  const stableRows = await queryAll(STABLE_DB);
  const stableMap = new Map();   // normalized name -> page id
  const idToName = new Map();    // page id -> display name
  for (const p of stableRows) { const n = textOf(p, 'Name'); if (n) { stableMap.set(normHeya(n), p.id); idToName.set(p.id, n); } }
  console.log(`loaded ${stableMap.size} stables for relation matching\n`);

  // pass 1 — resolve via active search
  const idByName = new Map();
  for (const name of targets) {
    const rec = info.get(name);
    if (!rec) { console.log(`✗ ${name}: no Master Rikishi page — skipped.`); continue; }
    const id = await resolveId(name, rec.jsaId); await sleep(800);
    idByName.set(name, id);
  }
  // pass 2 — recover retirees from past banzuke
  const unresolved = targets.filter(n => info.get(n) && !idByName.get(n));
  if (unresolved.length) {
    console.log(`\nrecovering ${unresolved.length} unresolved via past banzuke: ${unresolved.join(', ')}`);
    const rec = await recoverFromBanzuke(unresolved);
    for (const [n, id] of rec) { idByName.set(n, id); console.log(`  ↳ recovered ${n} -> sumo-api id ${id}`); }
    const still = unresolved.filter(n => !idByName.get(n));
    if (still.length) console.log(`  still unresolved (hand-entry): ${still.join(', ')}`);
    console.log('');
  }

  // pass 3 — fetch, print, map + (write)
  for (const name of targets) {
    const rec = info.get(name); if (!rec) continue;
    const id = idByName.get(name);
    if (!id) { console.log(`✗ ${name}: unresolved (JSA ${rec.jsaId || '—'}) — hand-entry.`); continue; }
    let d; try { d = await getJson(`${API}/rikishi/${id}?ranks=true&measurements=true&shikonas=true`); await sleep(900); } catch (e) { console.log(`✗ ${name}: profile ${id} failed: ${e.message}`); continue; }

    const hr = highestRank(d.rankHistory);
    const past = pastRingNames(d.shikonaHistory, d.shikonaEn);
    const deb = debutDate(d.debut);
    console.log(`\n▼ ${name} (id ${id}) · rank ${hr || '?'} · heya ${d.heya || '—'} · debut ${deb || '—'} · intai ${d.intai ? String(d.intai).slice(0,10) : '—'} · past [${past.join(', ') || '—'}]`);

    const props = {};
    if (typeof d.height === 'number' && d.height > 0) props['Height (cm)'] = { number: Math.round(d.height) };
    if (d.birthDate) props['Birthday'] = { date: { start: String(d.birthDate).slice(0, 10) } };
    const country = mapCountry(d.shusshin); if (country) props['Country of Origin'] = { select: { name: country } };
    if (d.nskId) props['JSA ID'] = { rich_text: [{ text: { content: String(d.nskId) } }] };
    if (hr) props['Highest Rank'] = { select: { name: hr } };
    if (deb) props['Debut'] = { date: { start: deb } };
    if (d.intai) props['Retirement'] = { date: { start: String(d.intai).slice(0, 10) } };
    props['Active'] = { checkbox: !d.intai };   // Active iff NOT officially retired (no intai) — wired to the retire date
    // Past Ring Names: fill-if-blank only (never clobber a curated value)
    if (past.length && !rec.curPastNames) props['Past Ring Names'] = { rich_text: [{ text: { content: past.join(', ') } }] };

    // Stable — change-aware
    const newStableId = d.heya ? stableMap.get(normHeya(d.heya)) : null;
    const curIds = rec.stableRelIds || [];
    if (newStableId) {
      if (!curIds.length) {
        props['Stable'] = { relation: [{ id: newStableId }] };                 // first assignment, no history
      } else if (!idEq(curIds[0], newStableId)) {
        const oldName = idToName.get(curIds[0]) || '(unknown stable)';
        props['Past Stables'] = { rich_text: [{ text: { content: appendUnique(rec.pastStables, oldName) } }] };
        props['Stable'] = { relation: [{ id: newStableId }] };
        console.log(`    ⚑ STABLE CHANGE: "${oldName}" -> "${d.heya}"  (old logged to Past Stables)`);
      }
    } else if (d.heya) {
      console.log(`    NOTE: stable "${d.heya}" not in Stable DB — Stable untouched.`);
    }

    console.log(`    would write: ${Object.keys(props).join(', ') || '(nothing new)'}`);
    if (!DRY) { await notion(`/pages/${rec.pageId}`, 'PATCH', { properties: props }); await sleep(350); console.log('    ✓ written'); }
  }
  console.log(`\n${DRY ? 'DRY RUN — nothing written. Review (watch for any ⚑ STABLE CHANGE), then re-run with DRY_RUN=0.' : 'DONE — enrichment written.'}`);
}
main().catch(e => { console.error(e); process.exit(1); });
