// Mirror sumo-api results into the Notion master DB (Match Log + master data).
// Runs in GitHub Actions (Node 20 fetch). sumo-api is only reachable from Actions, not locally.
//
// WHAT IT DOES each run:
//   1. Reads the sumo-api banzuke for BASHO (roster + each wrestler's day-by-day record).
//   2. Finds which tournament days are NOT yet in Match Log and backfills only those.
//   3. Creates any missing master data first (new Juryo visitors -> Master Rikishi + a "J"
//      Banzuke entry) so bout relations never dangle. A new visitor with no known JSA ID is
//      created anyway and LOUDLY FLAGGED in the log for Jennie to tag later.
//   4. Writes each bout to Match Log with resolved relations
//      (Winner/Loser, Winner/Loser Banzuke, Technique, Tournament) + Day #, Date, and the
//      machine-derived Gold Star (kinboshi: a Maegashira beating a Yokozuna).
//
// WHAT IT NEVER TOUCHES (human-owned scorekeeper fields):
//   Henka, Monoii, Rematch, Notes. The sync only CREATES bouts; it never updates an existing
//   bout, so overlays Jennie adds by hand are safe forever.
//
// SAFETY: DRY_RUN defaults to "1". In dry-run it logs exactly what it WOULD create and writes
//   nothing. Set the env DRY_RUN=0 (or "false") only once the logs look right.
//
// ENV:
//   NOTION_TOKEN  (required) - a WRITE-scoped Notion internal integration token, shared with
//                 Match Log, Banzuke, Master Rikishi, Kimarite (+ Tournaments to read it).
//   BASHO         (default 202607) - the only per-basho knob.
//   DRY_RUN       (default "1") - "0"/"false" to actually write.

import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const BASHO = process.env.BASHO || '202607';
const DIVISION = 'Makuuchi';
const DRY = !(process.env.DRY_RUN === '0' || String(process.env.DRY_RUN).toLowerCase() === 'false');
const NOTION_VERSION = '2022-06-28';
const TOTAL_DAYS = 15;

// --- Notion database IDs (single-source databases; 2022-06-28 database_id parent works) ---
const DB = {
  matchLog:      '1a2bad82-ebf5-4472-87ea-cb2c2481f9f1',
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
  kimarite:      '2591d1eb-2146-4745-ab0a-72ba57bfd213',
};
// Nagoya 2026 tournament page (Tournament relation target). Update per basho if needed.
const TOURNAMENT_PAGE_ID = '3351ade1-241f-80fb-b4ef-d2bef497b295';

// sumo-api result string -> normalized
const IS_WIN = new Set(['win', 'fusen win']);
const IS_BOUT = new Set(['win', 'loss', 'fusen win', 'fusen loss']); // "absent"/"" => no bout

if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }

// ---------- Notion REST helpers ----------
async function notion(path, method = 'GET', body) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function queryAll(dbId, filter) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (filter) body.filter = filter;
    const r = await notion(`/databases/${dbId}/query`, 'POST', body);
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

const titleOf = (page, prop) => {
  const p = page.properties?.[prop];
  const arr = p?.title || p?.rich_text || [];
  return arr.map(t => t.plain_text).join('').trim();
};
const textOf = (page, prop) => {
  const arr = page.properties?.[prop]?.rich_text || [];
  return arr.map(t => t.plain_text).join('').trim();
};

// ---------- sumo-api ----------
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`sumo-api ${url} -> ${r.status}: ${await r.text()}`);
  return r.json();
}
async function getBanzuke() { return getJson(`https://www.sumo-api.com/api/basho/${BASHO}/banzuke/${DIVISION}`); }
async function getBashoStart() {
  try {
    const b = await getJson(`https://www.sumo-api.com/api/basho/${BASHO}`);
    const s = b.startDate || b.date;
    if (s) return new Date(s);
  } catch (e) { console.warn('basho info fetch failed, deriving start from BASHO:', e.message); }
  // fallback: nagoya-ish; better to have startDate. Derive from BASHO YYYYMM, assume day ~ around 12th.
  const y = +BASHO.slice(0, 4), m = +BASHO.slice(4, 6);
  return new Date(Date.UTC(y, m - 1, 12));
}
function dayDate(start, dayNum) {
  const d = new Date(start.getTime());
  d.setUTCDate(d.getUTCDate() + (dayNum - 1));
  return d;
}
const iso = d => d.toISOString().slice(0, 10);
const short = d => {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${mm}/${dd}/${yy}`;
};

// rank string ("Yokozuna 1 East", "Maegashira 3 West") -> Banzuke select value ("Yokozuna","M3","J")
function bzRank(rankStr) {
  const w = String(rankStr || '').split(' ');
  if (w[0] === 'Maegashira') return 'M' + w[1];
  if (['Yokozuna', 'Ozeki', 'Sekiwake', 'Komusubi'].includes(w[0])) return w[0];
  return 'J';
}
const isYokozuna = r => String(r || '').startsWith('Yokozuna');
const isMaegashira = r => String(r || '').startsWith('Maegashira');

// ---------- main ----------
async function main() {
  console.log(`sync-notion: BASHO=${BASHO} DRY_RUN=${DRY ? 'ON (no writes)' : 'OFF (writing!)'}`);

  const [bz, existing, mrPages, bzPages, kmPages, start] = await Promise.all([
    getBanzuke(),
    queryAll(DB.matchLog),
    queryAll(DB.masterRikishi),
    queryAll(DB.banzuke),
    queryAll(DB.kimarite),
    getBashoStart(),
  ]);
  console.log(`start date = ${iso(start)} (Day 1)`);

  const roster = [...(bz.east || []), ...(bz.west || [])];
  const byId = new Map(roster.map(r => [String(r.rikishiID), r]));

  // maps: name -> pageId
  const MR = new Map(mrPages.map(p => [titleOf(p, 'Ring Name'), p.id]));
  // Banzuke entries for THIS basho only, keyed by wrestler name (entry title = "Name — Tournament")
  const bzThis = bzPages.filter(p => titleOf(p, 'Entry').includes('Nagoya 2026') || (p.properties?.Tournament?.relation || []).some(r => r.id.replace(/-/g, '') === TOURNAMENT_PAGE_ID.replace(/-/g, '')));
  const BZ = new Map(bzThis.map(p => [titleOf(p, 'Entry').split(' — ')[0].trim(), p.id]));
  // Kimarite keyed by lowercase jp name; fusen alias -> Fusensho
  const KM = new Map(kmPages.map(p => [textOf(p, 'Kimarite').toLowerCase(), p.id]));
  const kimId = k => {
    const key = (k || '').trim().toLowerCase();
    if (!key) return null;
    if (key === 'fusen') return KM.get('fusensho') || null;
    return KM.get(key) || null;
  };

  // which days already in Match Log?
  const daysPresent = new Set(existing.map(p => p.properties?.['Day #']?.number).filter(n => n != null));
  console.log('days already in Match Log:', [...daysPresent].sort((a, b) => a - b).join(',') || '(none)');

  // reconstruct bouts for a day
  function boutsForDay(dayNum) {
    const d = dayNum - 1;
    const seen = new Set(); const list = [];
    for (const w of roster) {
      const rec = w.record || [];
      if (d >= rec.length) continue;
      const r = rec[d];
      if (!IS_BOUT.has(r.result)) continue;
      const oppId = String(r.opponentID);
      const key = [String(w.rikishiID), oppId].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const won = IS_WIN.has(r.result);
      const winner = won ? w : { shikonaEn: r.opponentShikonaEn, rikishiID: oppId, __opp: true };
      const loser  = won ? { shikonaEn: r.opponentShikonaEn, rikishiID: oppId, __opp: true } : w;
      list.push({ winner, loser, kim: r.result.startsWith('fusen') ? 'fusen' : (r.kimarite || '') });
    }
    return list;
  }

  const flags = [];
  // ensure a wrestler exists in Master Rikishi + this basho's Banzuke; return {mrId, bzId}
  async function ensureWrestler(name, rankStr) {
    let mrId = MR.get(name);
    if (!mrId) {
      flags.push(`NEW Juryo visitor "${name}" — created without a JSA ID. Please pull & tag its JSA ID.`);
      if (DRY) { console.log(`  [dry] would CREATE Master Rikishi "${name}" (Juryo, no JSA ID)`); mrId = `dry-mr-${name}`; }
      else {
        const p = await notion('/pages', 'POST', {
          parent: { database_id: DB.masterRikishi },
          properties: {
            'Ring Name': { title: [{ text: { content: name } }] },
            'Active': { checkbox: true },
            'Highest Rank': { select: { name: 'Juryo' } },
            'Notes': { rich_text: [{ text: { content: `Juryo visitor auto-created by sync at ${BASHO}. JSA ID pending — flag Jennie to tag it.` } }] },
          },
        });
        mrId = p.id;
      }
      MR.set(name, mrId);
    }
    let bzId = BZ.get(name);
    if (!bzId) {
      if (DRY) { console.log(`  [dry] would CREATE Banzuke "${name} — Nagoya 2026" (${bzRank(rankStr)})`); bzId = `dry-bz-${name}`; }
      else {
        const p = await notion('/pages', 'POST', {
          parent: { database_id: DB.banzuke },
          properties: {
            'Entry': { title: [{ text: { content: `${name} — Nagoya 2026` } }] },
            'Rank': { select: { name: bzRank(rankStr) } },
            'Rikishi': { relation: [{ id: mrId }] },
            'Tournament': { relation: [{ id: TOURNAMENT_PAGE_ID }] },
            'Notes': { rich_text: [{ text: { content: 'Juryo visitor entry auto-created by sync for referential integrity.' } }] },
          },
        });
        bzId = p.id;
      }
      BZ.set(name, bzId);
    }
    return { mrId, bzId };
  }

  // rank string for a name from the roster (opponents may be non-makuuchi => unknown => "J")
  const rankOf = name => {
    const w = roster.find(r => r.shikonaEn === name);
    return w ? w.rank : 'Juryo';
  };

  let created = 0;
  const maxDayInData = Math.max(0, ...roster.map(w => {
    const rec = w.record || [];
    let m = 0;
    rec.forEach((r, i) => { if (IS_BOUT.has(r.result) && i + 1 > m) m = i + 1; });
    return m;
  }));
  console.log('max completed day in sumo-api data:', maxDayInData);

  for (let day = 1; day <= Math.min(maxDayInData, TOTAL_DAYS); day++) {
    if (daysPresent.has(day)) continue; // already synced
    const bouts = boutsForDay(day);
    const dt = dayDate(start, day);
    console.log(`Day ${day} (${iso(dt)}): ${bouts.length} bouts to write`);
    for (const b of bouts) {
      const wn = b.winner.shikonaEn, ln = b.loser.shikonaEn;
      const wRank = rankOf(wn), lRank = rankOf(ln);
      const W = await ensureWrestler(wn, wRank);
      const L = await ensureWrestler(ln, lRank);
      const tId = kimId(b.kim);
      if (!tId) flags.push(`Day ${day}: unmatched kimarite "${b.kim}" for ${wn} vs ${ln} (Technique left blank).`);
      const props = {
        'Match': { title: [{ text: { content: `${wn} vs ${ln} · Day ${day} · ${short(dt)}` } }] },
        'Day #': { number: day },
        'Date': { date: { start: iso(dt) } },
        'Winner': { relation: [{ id: W.mrId }] },
        'Loser': { relation: [{ id: L.mrId }] },
        'Winner Banzuke': { relation: [{ id: W.bzId }] },
        'Loser Banzuke': { relation: [{ id: L.bzId }] },
        'Tournament': { relation: [{ id: TOURNAMENT_PAGE_ID }] },
      };
      if (tId) props['Technique'] = { relation: [{ id: tId }] };
      if (isMaegashira(wRank) && isYokozuna(lRank)) props['Gold Star'] = { checkbox: true };

      if (DRY) console.log(`  [dry] would CREATE bout: ${wn} vs ${ln} · Day ${day}`);
      else { await notion('/pages', 'POST', { parent: { database_id: DB.matchLog }, properties: props }); }
      created++;
    }
  }

  console.log(`\nDONE. ${DRY ? 'Would create' : 'Created'} ${created} bout(s).`);
  if (flags.length) {
    console.log('\n⚠️  FLAGS FOR JENNIE:');
    for (const f of [...new Set(flags)]) console.log('  - ' + f);
  } else {
    console.log('No flags.');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
