// gen-history.mjs — ONE-TIME historical backfill pull from sumo-api.
// Pulls the crew's fandom era (Jan 2025 → May 2026, the 9 basho before Nagoya 2026)
// and writes a static sumo-history.json. Runs in GitHub Actions (sumo-api is only
// reachable there). Modeled on the proven build-standings.mjs / sync-notion.mjs parsing.
//
// GOOD-CITIZEN NOTES (sumo-api is a free, one-person, Ko-fi-funded API):
//   - Descriptive User-Agent so the maintainer can see/contact us.
//   - Throttled: a pause between every request. This pull is TINY anyway (~2 calls per
//     basho × 9 = ~18 calls), so it's a feather-touch on their server.
//   - History is STATIC — run this ONCE and commit the output. Never re-pull.
//
// OUTPUT: sumo-history.json — per basho: rikishi (rank + final W-L), yusho, and every
//   makuuchi bout (day/date/winner/loser/kimarite/goldStar). No day-gating: past basho
//   are not spoilers.
//
// USAGE (Actions): node gen-history.mjs   [OUT=sumo-history.json]
import fs from 'node:fs';

const API = 'https://www.sumo-api.com/api';
const DIVISION = 'Makuuchi';
const TOTAL_DAYS = 15;
const OUT = process.env.OUT || 'sumo-history.json';
const UA = 'salt-stats-sumo-backfill/1.0 (+https://sumo.stavesandhoop.com; one-time historical pull)';
const THROTTLE_MS = 1500; // pause between requests — polite to a free API

// The crew's fandom era: Jan 2025 through May 2026 (the 9 basho before Nagoya 2026).
const BASHO = ['202501','202503','202505','202507','202509','202511','202601','202603','202605'];
const LABEL = {
  '202501':'Hatsu 2025','202503':'Haru 2025','202505':'Natsu 2025','202507':'Nagoya 2025',
  '202509':'Aki 2025','202511':'Kyushu 2025','202601':'Hatsu 2026','202603':'Haru 2026','202605':'Natsu 2026',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url){
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if(!res.ok) throw new Error(`${url} -> ${res.status}: ${(await res.text()).slice(0,200)}`);
  return res.json();
}

// same rank parsing as build-standings.mjs → "Yokozuna"/"Ozeki"/"Sekiwake"/"Komusubi"/"M<n>"
function shortRank(rankStr){
  const parts = String(rankStr||'').split(' ');
  const w = parts[0];
  if(w==='Yokozuna'||w==='Ozeki'||w==='Sekiwake'||w==='Komusubi') return w;
  if(w==='Maegashira') return 'M'+parts[1];
  return rankStr || null;
}
const isYokozuna  = r => String(r||'').startsWith('Yokozuna');
const isMaegashira= r => String(r||'').startsWith('M');

const IS_WIN  = new Set(['win','fusen win']);
const IS_BOUT = new Set(['win','loss','fusen win','fusen loss']);

// basho start date (to date bouts). Falls back to ~day 8 of the month if the endpoint is thin.
async function bashoStart(code){
  try{
    const b = await getJson(`${API}/basho/${code}`);
    const s = b.startDate || b.date;
    if(s){ const d = new Date(s); if(!isNaN(d)) return { start:d, info:b }; }
    return { start: fallbackStart(code), info:b };
  }catch(e){
    console.warn(`  basho info ${code} failed (${e.message}); using fallback start`);
    return { start: fallbackStart(code), info:null };
  }
}
function fallbackStart(code){ const y=+code.slice(0,4), m=+code.slice(4,6); return new Date(Date.UTC(y, m-1, 8)); }
function dayDate(start, day){ const d=new Date(start.getTime()); d.setUTCDate(d.getUTCDate()+(day-1)); return d.toISOString().slice(0,10); }

// derive the deduped bouts of one day from the roster's record arrays (like sync-notion.boutsForDay)
function boutsForDay(roster, rankByName, day, dateStr){
  const d = day-1, seen = new Set(), out = [];
  for(const w of roster){
    const rec = w.record || []; if(d >= rec.length) continue;
    const r = rec[d]; if(!IS_BOUT.has(r.result)) continue;
    const key = [String(w.rikishiID), String(r.opponentID)].sort().join('|'); if(seen.has(key)) continue; seen.add(key);
    const won = IS_WIN.has(r.result);
    const winner = won ? w.shikonaEn : r.opponentShikonaEn;
    const loser  = won ? r.opponentShikonaEn : w.shikonaEn;
    const goldStar = isMaegashira(rankByName[winner]) && isYokozuna(rankByName[loser]);
    out.push({ day, date: dateStr, winner, loser, kimarite: r.result.startsWith('fusen') ? 'fusen' : (r.kimarite || null), goldStar });
  }
  return out;
}

async function pullBasho(code){
  const bz = await getJson(`${API}/basho/${code}/banzuke/${DIVISION}`);
  await sleep(THROTTLE_MS);
  const { start, info } = await bashoStart(code);

  const roster = [...(bz.east||[]), ...(bz.west||[])];
  if(!roster.length) throw new Error('empty roster');
  const rankByName = {}; for(const w of roster) rankByName[w.shikonaEn] = shortRank(w.rank);

  // final records
  const rikishi = roster.map(w=>{
    let wins=0, losses=0;
    for(const r of (w.record||[])){ if(r.result==='win'||r.result==='fusen win') wins++; else if(r.result==='loss'||r.result==='fusen loss') losses++; }
    return { id: w.rikishiID, name:w.shikonaEn, rank: shortRank(w.rank), wins, losses };
  });

  // bouts across the tournament
  let bouts = [];
  const maxDay = Math.max(0, ...roster.map(w => (w.record||[]).length));
  for(let day=1; day<=Math.min(maxDay, TOTAL_DAYS); day++)
    bouts = bouts.concat(boutsForDay(roster, rankByName, day, dayDate(start, day)));

  // yusho: prefer an explicit field from the basho endpoint if present, else derive from top wins
  let yusho = [], yushoSource = 'derived (top makuuchi wins; playoffs not captured)';
  const explicit = info && (info.yusho || info.champion || info.makuuchiYusho);
  if(explicit){ yusho = [].concat(explicit).map(x => (x && (x.shikonaEn || x.name)) || x).filter(Boolean); yushoSource='sumo-api basho field'; }
  if(!yusho.length){ const top = Math.max(0, ...rikishi.map(r=>r.wins)); yusho = rikishi.filter(r=>r.wins===top && r.wins>0).map(r=>r.name); }

  return { bashoId: code, label: LABEL[code]||code, startDate: start.toISOString().slice(0,10),
           days: Math.min(maxDay, TOTAL_DAYS), rikishi, yusho, yushoSource, bouts };
}

async function main(){
  console.log(`Historical backfill: ${BASHO.length} basho (${LABEL[BASHO[0]]} … ${LABEL[BASHO.at(-1)]})`);
  const out = { meta:{ schema:'sumo-history/1', division:DIVISION, bashoCount:BASHO.length, window:'Jan 2025 – May 2026' }, basho:{} };
  const flags = [];
  for(const code of BASHO){
    try{
      const b = await pullBasho(code);
      out.basho[code] = b;
      console.log(`  ✓ ${b.label} (${code}): ${b.rikishi.length} rikishi, ${b.bouts.length} bouts, ${b.days} days, yusho=${b.yusho.join('/')||'?'} [${b.yushoSource}]`);
    }catch(e){ flags.push(`${code}: ${e.message}`); console.error(`  ✗ ${code}: ${e.message}`); }
    await sleep(THROTTLE_MS);
  }

  const got = Object.keys(out.basho).length;
  if(!got){ console.error('ABORT — pulled 0 basho, writing nothing.'); process.exit(1); }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  const totalBouts = Object.values(out.basho).reduce((n,b)=>n+b.bouts.length,0);
  console.log(`\n✓ wrote ${OUT}: ${got}/${BASHO.length} basho, ${totalBouts} total bouts.`);
  if(flags.length){ console.log('⚠️ basho that failed (re-run to retry just these):'); flags.forEach(f=>console.log('  - '+f)); }
}
main().catch(e=>{ console.error(e); process.exit(1); });
