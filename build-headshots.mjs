// build-headshots.mjs — turn each Master Rikishi's formal portrait (the Photo field in Notion) into a
// small, face-centered square head-crop, committed to /img/headshots/{slug}.png. Standings rounds it
// with CSS. Runs in GitHub Actions (needs NOTION_TOKEN). Only dependency: sharp.
//
// Framing = head+shoulders scaled to IMAGE HEIGHT (~0.22 H), centered on the face. JSA formal portraits
// share one standardized full-body framing, so a height fraction lands the head consistently across
// resolutions and tight snips. (v1 used per-image jaw/neck detection; it grabbed the whole body on
// thick-necked rikishi whose neck never narrowed — height-scaling is the robust replacement.)
//
// DRY_RUN=1 (default) logs the plan and writes nothing. DRY_RUN=0 writes the PNGs (the workflow commits).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');
// Optional subset by Ring Name. Blank OR "ALL" (case-insensitive) = whole roster — so this shares the
// exact name semantics enrich-rikishi.mjs uses, letting one workflow drive both with the same input.
const _rawNames = (process.env.NAMES || '').trim();
const ONLY = /^all$/i.test(_rawNames) ? [] : _rawNames.split(',').map(s => s.trim()).filter(Boolean);
const NOTION_VERSION = '2022-06-28';
const MR_DB = 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9';
const OUT_DIR = 'img/headshots';
const OUT_SIZE = 200; // stored square px; standings shows it ~28px round

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
const slugify = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// --- head-box detection: height-scaled, neck-independent ---
function detectHeadBox(rgba, W, H) {
  const WHITE = 690; // sum(r,g,b) at/above this = white studio bg; below = subject
  const at = (x, y) => { const i = (y * W + x) * 4; return rgba[i] + rgba[i + 1] + rgba[i + 2]; };
  const rowSpan = y => { let lo = -1, hi = -1; for (let x = 0; x < W; x++) { if (at(x, y) < WHITE) { if (lo < 0) lo = x; hi = x; } } return lo < 0 ? null : [lo, hi]; };
  let HT = -1; for (let y = 0; y < H; y++) { if (rowSpan(y)) { HT = y; break; } }   // hair top = first subject row
  if (HT < 0) return null;
  // Center-x = MEDIAN of row-centers in the head zone only (top ~10% of the image, above the shoulders).
  // Reliable even when the neck doesn't narrow — that's the case the old jaw/neck detection failed on.
  const centers = [];
  const zone = Math.min(H, HT + Math.round(H * 0.10));
  for (let y = HT; y < zone; y++) { const s = rowSpan(y); if (s) centers.push((s[0] + s[1]) / 2); }
  centers.sort((a, b) => a - b);
  const cx = Math.round(centers.length ? centers[Math.floor(centers.length / 2)] : W / 2);
  // Crop scaled to image height: standardized full-body framing → head+shoulders at a consistent fraction.
  const side = Math.round(0.22 * H);
  const top = Math.round(HT - 0.12 * side);
  const left = Math.round(cx - side / 2);
  return { left, top, side };
}

async function cropHead(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = detectHeadBox(data, info.width, info.height);
  if (!box) throw new Error('no subject detected (non-white background?)');
  const PAD = box.side; // white margin so an off-edge box is always safe
  const padded = await sharp(buf).extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 255, g: 255, b: 255, alpha: 1 } }).toBuffer();
  return sharp(padded)
    .extract({ left: box.left + PAD, top: box.top + PAD, width: box.side, height: box.side })
    .resize(OUT_SIZE, OUT_SIZE, { fit: 'cover' })
    .png().toBuffer();
}

async function main() {
  console.log(`build-headshots: DRY_RUN=${DRY ? 'ON (no writes)' : 'OFF (WRITING)'}${ONLY.length ? `  subset=${ONLY.join(',')}` : ''}\n`);
  if (!DRY) fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = await queryAll(MR_DB);
  let made = 0, skippedNoPhoto = 0, failed = 0;
  for (const p of rows) {
    const name = nameOf(p);
    if (!name) continue;
    if (ONLY.length && !ONLY.includes(name)) continue;
    const url = photoUrl(p);
    if (!url) { skippedNoPhoto++; continue; }
    const slug = slugify(name);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const out = await cropHead(buf);
      const dest = path.join(OUT_DIR, `${slug}.png`);
      console.log(`  ✂ ${name} → ${dest}  (${(out.length / 1024).toFixed(0)} KB)`);
      if (!DRY) fs.writeFileSync(dest, out);
      made++;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
    await sleep(120);
  }
  console.log(`\n${DRY ? 'DRY RUN — nothing written.' : 'DONE.'}  crops ${DRY ? 'to make' : 'made'}: ${made} · no photo: ${skippedNoPhoto} · failed: ${failed}`);
}
main().catch(e => { console.error(e); process.exit(1); });
