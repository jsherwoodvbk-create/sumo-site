// clear-jsa-photos.mjs — one-time cleanup: clears the Photo field on Master Rikishi rows whose photo
// is an EXTERNAL JSA hot-link (source on sumo.or.jp, a fossil of the rejected JSA-scrape pass), so
// Jennie can re-upload real files onto a clean slate. UPLOADED attachments and empty photos are LEFT ALONE.
//
// Runs in GitHub Actions. Needs NOTION_TOKEN. DRY_RUN defaults "1" (prints the plan, writes nothing).
// Re-run with DRY_RUN=0 to actually clear. Idempotent (re-running finds nothing left to clear).

import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');
const NOTION_VERSION = '2022-06-28';
const MR_DB = 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9';

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
const nameOf = p => (p.properties?.['Ring Name']?.title || []).map(t => t.plain_text).join('').trim();
const urlOf = f => f?.type === 'external' ? (f.external?.url || '') : (f?.file?.url || '');

async function main() {
  console.log(`clear-jsa-photos: DRY_RUN=${DRY ? 'ON (no writes)' : 'OFF (WRITING)'}\n`);
  const rows = await queryAll(MR_DB);
  let cleared = 0, kept = 0, empty = 0;
  for (const p of rows) {
    const name = nameOf(p);
    const files = p.properties?.['Photo']?.files || [];
    if (!files.length) { empty++; continue; }

    const isJsaLink = files.some(f => f.type === 'external' && /sumo\.or\.jp/i.test(f.external?.url || ''));
    const hasUpload = files.some(f => f.type === 'file');

    if (isJsaLink && !hasUpload) {
      console.log(`  ✂ ${name}: JSA hot-link → CLEAR   ${urlOf(files[0])}`);
      cleared++;
      if (!DRY) { await notion(`/pages/${p.id}`, 'PATCH', { properties: { Photo: { files: [] } } }); await sleep(300); console.log('      ✓ cleared'); }
    } else if (hasUpload) {
      kept++;   // an uploaded file — leave it (this is the good methodology)
    } else {
      console.log(`  ? ${name}: external NON-JSA link → kept for review   ${urlOf(files[0])}`);
      kept++;
    }
  }
  console.log(`\n${DRY ? 'DRY RUN — nothing changed.' : 'DONE — cleared.'}  JSA-linked ${DRY ? 'to clear' : 'cleared'}: ${cleared} · kept (uploads/other): ${kept} · no photo: ${empty}`);
}
main().catch(e => { console.error(e); process.exit(1); });
