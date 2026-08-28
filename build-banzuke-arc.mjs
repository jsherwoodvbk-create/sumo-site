// build-banzuke-arc.mjs — regenerates the Banzuke Arc report (banzuke-arc.html) from Notion.
//
// Reads the whole 📋 Banzuke database (every wrestler, every tournament) and rewrites the
// `const BANZUKE_DATA = {...};` line inside banzuke-arc.html. Fully dynamic: the tournament
// columns and the current roster are DERIVED from the data, so when a new basho is added to
// Notion the report grows a column and re-anchors to the new banzuke with NO code edit here.
// (Unlike build-standings.mjs, there is no per-basho TOURNAMENT_ID to flip.)
//
// Mirrors the build-standings.mjs pipeline: Node fetch, Notion REST classic endpoint,
// NOTION_TOKEN from GitHub Actions Secrets, in-place regex swap, count-only logging.

import { readFileSync, writeFileSync } from 'node:fs';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) { console.error('Missing NOTION_TOKEN'); process.exit(1); }

const BANZUKE_DB = '8e3457a9274742759b917ac03fe18290';   // 📋 Banzuke  (stable ID)
const PAGE = 'banzuke-arc.html';

// basho calendar → month, for chronological sort (Hatsu Jan … Kyushu Nov)
const MONTH = { Hatsu:1, Haru:3, Natsu:5, Nagoya:7, Aki:9, Kyushu:11 };
function tKey(t){ const m = /^(\w+)\s+(\d{4})$/.exec(t); return m ? (+m[2])*100 + (MONTH[m[1]]||0) : 0; }

async function queryAll(dbId){
  const rows = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!res.ok) throw new Error(`Notion query ${res.status}: ${await res.text()}`);
    const j = await res.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return rows;
}

function titleText(prop){
  if (!prop || !Array.isArray(prop.title)) return '';
  return prop.title.map(t => t.plain_text).join('').trim();
}

const results = await queryAll(BANZUKE_DB);

const data = {};       // { tournament: { name: rank } }
const yusho = {};      // { tournament: winnerName }
for (const row of results) {
  const p = row.properties || {};
  const entry = titleText(p['Entry']);                 // "Name — Tournament"
  const rank  = p['Rank'] && p['Rank'].select ? p['Rank'].select.name : null;
  const won   = !!(p['Yusho'] && p['Yusho'].checkbox);
  if (!entry || !rank) continue;
  const parts = entry.split(/\s+[—–-]\s+/);            // em-, en-, or hyphen-dash separator
  if (parts.length < 2) continue;
  const name = parts[0].trim();
  const tournament = parts.slice(1).join(' ').trim();
  if (!name || !tournament) continue;
  (data[tournament] || (data[tournament] = {}))[name] = rank;
  if (won) yusho[tournament] = name;
}

const tournaments = Object.keys(data).sort((a,b) => tKey(a) - tKey(b));   // chronological

const out = { tournaments, yusho, data };

// in-place swap of the single BANZUKE_DATA line (one line, so a line-anchored replace is safe)
let html = readFileSync(PAGE, 'utf8');
const line = `const BANZUKE_DATA = ${JSON.stringify(out)};`;
const re = /^(\s*)const BANZUKE_DATA = .*;\s*$/m;
if (!re.test(html)) { console.error('BANZUKE_DATA line not found in ' + PAGE); process.exit(1); }
html = html.replace(re, (_m, indent) => indent + line);
writeFileSync(PAGE, html);

// count-only logging (no records, keeps logs clean)
console.log(`banzuke-arc: tournaments=${tournaments.length} entries=${results.length} current=${tournaments[tournaments.length-1]||'none'}`);
