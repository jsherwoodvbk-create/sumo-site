// gen-merge-renames.mjs — fold rename-duplicate wrestlers into their current entry.
//
// PROBLEM it fixes: the historical backfill matches wrestlers by their CURRENT shikona, but
// historical bouts carry the name-at-the-time. A wrestler who has since RENAMED (e.g. Kusano →
// Yoshinofuji) got created as a separate "orphan" under the old name, splitting his record.
//
// DETECTION (no guessing): Master Rikishi already records renames in "Past Ring Names". So any
// Master entry whose Ring Name appears in ANOTHER entry's "Past Ring Names" is a rename duplicate.
// This script finds those pairs, re-points the duplicate's Match Log bouts (Winner/Loser) and
// Banzuke entries (Rikishi) to the real wrestler, and archives the now-empty duplicate.
//
// Runs in GitHub Actions (Node 20 fetch). Needs NOTION_TOKEN. Touches only Notion (no sumo-api).
//
// SAFETY: DRY_RUN defaults to "1" — prints every merge it WOULD do (dup → target, bout + banzuke
//   counts) and writes NOTHING. Review, then re-run with DRY_RUN=0. Idempotent (archived dups drop
//   out of detection), so it's safe to re-run and safe to run again after you log a NEW rename.
//
// ENV: NOTION_TOKEN (required) · DRY_RUN (default "1")

import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');
const NOTION_VERSION = '2022-06-28';
const THROTTLE_MS = 350;

const DB = {
  matchLog:      '1a2bad82-ebf5-4472-87ea-cb2c2481f9f1',
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
};

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
    console.warn(`  ${res.status} rate-limited — waiting ${Math.round(wait/1000)}s`); await sleep(wait);
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
const relIds  = (page, prop) => (page.properties?.[prop]?.relation || []).map(r => r.id);

async function main() {
  console.log(`merge-renames: DRY_RUN=${DRY ? 'ON (no writes)' : 'OFF (WRITING)'}`);

  const mrPages = await queryAll(DB.masterRikishi);
  const byName = new Map(mrPages.map(p => [titleOf(p, 'Ring Name'), p.id]));

  // Build: past ring name -> current wrestler {id, name}. Past Ring Names is comma-separated.
  const pastToCurrent = new Map();
  for (const p of mrPages) {
    const cur = titleOf(p, 'Ring Name');
    for (const past of textOf(p, 'Past Ring Names').split(',').map(s => s.trim()).filter(Boolean)) {
      pastToCurrent.set(past, { id: p.id, name: cur });
    }
  }

  // Duplicates = Master entries whose Ring Name is someone's past name, pointing at a different page.
  const dups = [];
  for (const p of mrPages) {
    const name = titleOf(p, 'Ring Name');
    const tgt = pastToCurrent.get(name);
    if (tgt && tgt.id !== p.id) dups.push({ dupId: p.id, dupName: name, targetId: tgt.id, targetName: tgt.name });
  }

  if (!dups.length) { console.log('No rename duplicates found. Nothing to merge.'); return; }
  console.log(`Found ${dups.length} rename duplicate(s): ${dups.map(d => `${d.dupName}→${d.targetName}`).join(', ')}\n`);

  let totBouts = 0, totBz = 0;
  for (const d of dups) {
    // Match Log bouts on either side
    const bouts = await queryAll(DB.matchLog, { or: [
      { property: 'Winner', relation: { contains: d.dupId } },
      { property: 'Loser',  relation: { contains: d.dupId } },
    ] });
    // Banzuke entries pointing at the dup
    const bz = await queryAll(DB.banzuke, { property: 'Rikishi', relation: { contains: d.dupId } });
    console.log(`${d.dupName} → ${d.targetName}: ${bouts.length} bouts, ${bz.length} banzuke entr${bz.length===1?'y':'ies'}${DRY ? ' (would re-point + archive dup)' : ''}`);

    if (!DRY) {
      for (const b of bouts) {
        const props = {};
        if (relIds(b, 'Winner').includes(d.dupId)) props['Winner'] = { relation: [{ id: d.targetId }] };
        if (relIds(b, 'Loser').includes(d.dupId))  props['Loser']  = { relation: [{ id: d.targetId }] };
        await notion(`/pages/${b.id}`, 'PATCH', { properties: props }); await sleep(THROTTLE_MS);
      }
      for (const e of bz) {
        await notion(`/pages/${e.id}`, 'PATCH', { properties: { 'Rikishi': { relation: [{ id: d.targetId }] } } }); await sleep(THROTTLE_MS);
      }
      // archive the now-empty duplicate wrestler
      await notion(`/pages/${d.dupId}`, 'PATCH', { archived: true }); await sleep(THROTTLE_MS);
      console.log(`  ✓ merged and archived "${d.dupName}"`);
    }
    totBouts += bouts.length; totBz += bz.length;
  }

  console.log(`\n──────── ${DRY ? 'DRY RUN (nothing written)' : 'DONE'} ────────`);
  console.log(`${dups.length} duplicate(s) · ${totBouts} bouts re-pointed · ${totBz} banzuke re-pointed`);
  if (DRY) console.log('Review, then re-run with DRY_RUN=0.');
}
main().catch(e => { console.error(e); process.exit(1); });
