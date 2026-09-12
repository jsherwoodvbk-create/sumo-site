// build-portraits.mjs — turn each Master Rikishi's formal portrait (the Photo field in Notion) into a
// downscaled FULL-BODY portrait committed to /img/portraits/{slug}.jpg, for the per-rikishi dashboard's
// photo panel. The sibling of build-headshots.mjs: same Notion Photo source, same "commit a repo asset
// so the page never depends on Notion (expiring signed URLs) at display time" idea — but the WHOLE
// standing shot, not a head-crop. gen-rikishi-metrics.mjs prefers a committed /img/portraits/<slug>.*
// over the Notion URL, so once these exist the dashboard portraits are stable and cache-friendly.
//
// Runs in GitHub Actions (needs NOTION_TOKEN — read is enough; only reads Photo, writes repo files).
// Only dependency: sharp. DRY_RUN=1 (default) logs the plan and writes nothing; DRY_RUN=0 writes the
// JPGs (the workflow commits). NAMES: blank/ALL = whole roster, else comma-separated Ring Names —
// the SAME semantics as build-headshots / enrich, so one onboard dispatch drives all of them.
//
// SLUG NOTE (important): the filename uses the DASHBOARD slug — lowercased, every non-alphanumeric
// stripped — which is exactly what gen-rikishi-metrics.mjs looks up and what the standings ?r=<id>
// link uses, so a committed portrait always resolves. This is deliberately NOT the accent-folding
// slug build-headshots uses for /img/headshots; the two coincide for every current shikona (all
// romanized, no macrons/accents) and only ever diverge on an accented name — at which point the
// portrait must match the generator, so the generator's slug wins here.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');
const _rawNames = (process.env.NAMES || '').trim();
const ONLY = /^all$/i.test(_rawNames) ? [] : _rawNames.split(',').map(s => s.trim()).filter(Boolean);
const NOTION_VERSION = '2022-06-28';
const MR_DB = 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9';
const OUT_DIR = 'img/portraits';
const MAX_W = 480, MAX_H = 720, JPEG_Q = 82;   // downscale ceiling; the panel shows ~150×200 (retina-safe)

if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function notion(p, method = 'GET', body, attempt = 0) {
  const res = await fetch('https://api.notion.com/v1' + p, {
    method, headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status === 529) && attempt < 6) {
    const w = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000; await sleep(w); return notion(p, method, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${p} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}
async function queryAll(dbId) {
  const out = []; let cursor;
  do { const b = { page_size: 100 }; if (cursor) b.start_cursor = cursor;
    const r = await notion(`/databases/${dbId}/query`, 'POST', b); out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor); return out;
}
const nameOf = p => (p.properties?.['Ring Name']?.title || []).map(t => t.plain_text).join('').trim();
const photoUrl = p => {
  const f = (p.properties?.['Photo']?.files || [])[0];
  if (!f) return null;
  return f.type === 'external' ? (f.external?.url || null) : (f.file?.url || null);
};
// DASHBOARD slug — matches gen-rikishi-metrics.mjs and the standings ?r= link (see SLUG NOTE above).
const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Downscale the full portrait — auto-orient from EXIF, fit inside the ceiling (never enlarge), JPEG.
async function makePortrait(buf) {
  return sharp(buf)
    .rotate()
    .resize(MAX_W, MAX_H, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_Q })
    .toBuffer();
}

async function main() {
  console.log(`build-portraits: DRY_RUN=${DRY ? 'ON (no writes)' : 'OFF (WRITING)'}${ONLY.length ? `  subset=${ONLY.join(',')}` : ''}\n`);
  if (!DRY) fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = await queryAll(MR_DB);
  let made = 0, skippedNoPhoto = 0, failed = 0;
  for (const p of rows) {
    const name = nameOf(p);
    if (!name) continue;
    if (ONLY.length && !ONLY.includes(name)) continue;
    const url = photoUrl(p);
    if (!url) { skippedNoPhoto++; console.log(`  – ${name}: no Photo — skipped`); continue; }
    const slug = slugify(name);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const out = await makePortrait(buf);
      const dest = path.join(OUT_DIR, `${slug}.jpg`);
      console.log(`  ▣ ${name} → ${dest}  (${(out.length / 1024).toFixed(0)} KB)`);
      if (!DRY) fs.writeFileSync(dest, out);
      made++;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
    await sleep(120);
  }
  console.log(`\n${DRY ? 'DRY RUN — nothing written.' : 'DONE.'}  portraits ${DRY ? 'to make' : 'made'}: ${made} · no photo: ${skippedNoPhoto} · failed: ${failed}`);
}
main().catch(e => { console.error(e); process.exit(1); });
