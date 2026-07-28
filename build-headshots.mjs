// build-headshots.mjs — turn each Master Rikishi's formal portrait (the Photo field in Notion) into a
// small, face-centered square head-crop, committed to /img/headshots/{slug}.png. Standings rounds it
// with CSS. Runs in GitHub Actions (needs NOTION_TOKEN). Only dependency: sharp.
//
// Framing: crop size scaled to IMAGE HEIGHT (~0.22 H), centered horizontally on the HAIR. Centering on
// the hair (reliably dark) survives portraits shot against a colored wall or dark floor — unlike v1/v2.
//   v1: per-image jaw/neck detection → grabbed the whole body on thick-necked rikishi (no neck to find).
//   v2: height-scaled + centered on "non-white pixels" → correct size, but a room background (tan wall /
//       dark floor) read as subject and dragged the center sideways, pushing the head out of frame.
//   v3 (this): height-scaled size + hair-centered → robust to any background. Small headroom keeps the
//       topknot near the top of the round crop (less white cap on the circle).
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

// --- head-box detection: hair-centered, height-scaled (background-robust) ---
function detectHeadBox(rgba, W, H) {
  const HAIR = 300; // sum(r,g,b) below this = very dark = hair/topknot; robust to any background color
  const dark = (x, y) => { const i = (y * W + x) * 4; return (rgba[i] + rgba[i + 1] + rgba[i + 2]) < HAIR; };
  const rowHair = y => { const xs = []; for (let x = 0; x < W; x++) if (dark(x, y)) xs.push(x); return xs; };
  let HT = -1; for (let y = 0; y < H; y++) { if (rowHair(y).length >= 3) { HT = y; break; } } // top of the topknot
  const side = Math.round(0.22 * H);
  let cx;
  if (HT < 0) { HT = 0; cx = Math.round(W / 2); } // no hair found (bald? odd source) → center fallback
  else {
    // cx = horizontal MEDIAN of hair pixels in the crown+topknot zone = the head's true center,
    // regardless of what the background is doing on the sides.
    const band = Math.min(H, HT + Math.round(H * 0.14));
    const xs = []; for (let y = HT; y < band; y++) for (const x of rowHair(y)) xs.push(x);
    xs.sort((a, b) => a - b);
    cx = Math.round(xs[Math.floor(xs.length / 2)]);
  }
  const top = Math.round(HT - 0.06 * side); // small headroom above the topknot
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
