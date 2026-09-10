// gen-rikishi-metrics.mjs — the per-rikishi METRICS LAYER generator.
//
// Runs in the pipeline / GitHub Action (NOT the Cowork sandbox — sumo-api is egress-blocked there,
// the same wall the box works around). Produces ONE record per current-banzuke rikishi, keyed by
// sumo-api id, matching the contract the dashboard template (rikishi-dashboard.html) renders, and the
// same layer the leaderboard/reports face and the Gumbai snapshot read. Build the layer once; the
// dashboard is face #1 over it.
//
// SOURCES
//   A. sumo-api (HARD, background = full career; the AUTHORITY for background history):
//      - /api/rikishi/{id}                     profile: shusshin, height, weight, birthDate, heya, debut
//      - /api/rikishi/{id}?ranks=true          full rank history  -> arc + true highest rank
//      - /api/rikishi/{id}/stats               career W-L (all-division + makuuchi split), yusho, sansho
//      - /api/rikishi/{id}/matches (if needed) career-scoped counts (prefer the Match Log for crew tallies)
//   B. Notion (system of record where it IS authoritative):
//      - Banzuke (current entry)   current rank, current weight, yusho/sansho fields + provenance
//      - Match Log                 crew record (Jan2025+, makuuchi), kimarite, kinboshi, henka, birthday bouts
//      - Master Rikishi            SOFT fields (family/talents/fun-facts/nicknames/entry-path/mawashi), sumo-api id
//
// DISCIPLINE (carried from setup-basho's Highest Rank refresh):
//   - We could NOT verify the sumo-api response schema from the sandbox, so this is DEFENSIVE + SELF-
//     DIAGNOSING: on any field we can't find, log the actual response keys ONCE and leave the value
//     blank. A schema mismatch must be a logged no-op, never a fabricated number. Blank-not-faked.
//   - Firewall: nothing here is sourced from a transcript. HARD slots = sumo-api / Match Log / Banzuke only.
//   - Windows: all-division + makuuchi = full career (sumo-api); crew = Jan 2025+ makuuchi (Match Log).
//   - Never say "all-time" bare downstream; the three records are labeled distinctly by the template.
//
// OUTPUT: writes rikishi-metrics.json = { "<id>": <record>, ... }. The template loads it (or the
//   generator injects one record per page). Regenerated on the banzuke drop (rides banzuke-drop) and
//   daily during a basho for the day-gated caliber / current-W-L pieces.
//
// STATUS: first-cut Action-side scaffold (2026-09-10). sumo-api side is solid; the Notion reads are
//   written in the gen-gumbai-snapshot.mjs / build-standings.mjs idiom but the exact DB ids, property
//   names, and the sumo-api-id location on Master Rikishi are marked CONFIRM — align them to those
//   existing generators on the first Action run.

import { writeFileSync } from 'node:fs';

const SUMO_API = process.env.SUMO_API_BASE || 'https://sumo-api.com/api';
const NOTION_TOKEN = process.env.NOTION_TOKEN;                 // read token (same as the other generators)
const OUT = process.env.METRICS_OUT || 'rikishi-metrics.json';

// CONFIRM: data-source ids — copy from gen-gumbai-snapshot.mjs / build-standings.mjs (they already read these).
const DS = {
  banzuke:      process.env.DS_BANZUKE      || 'CONFIRM-banzuke-datasource',
  matchLog:     process.env.DS_MATCHLOG     || 'CONFIRM-matchlog-datasource',
  masterRikishi:process.env.DS_MASTER       || 'CONFIRM-master-datasource',
};

const seenKeyLogs = new Set();
function diag(where, obj){                                      // log response keys ONCE per shape, on a miss
  if(seenKeyLogs.has(where)) return; seenKeyLogs.add(where);
  console.warn(`[diag] ${where}: could not find expected field; response keys = ${obj && typeof obj==='object' ? Object.keys(obj).join(',') : typeof obj}`);
}
const num = v => (v==null || v==='' || isNaN(+v)) ? null : +v;
const pct = (w,l) => (w+l>0) ? ('.'+String(Math.round(w/(w+l)*1000)).padStart(3,'0')) : null;

// ── sumo-api ──────────────────────────────────────────────────────────────
async function apiGet(path){
  const r = await fetch(`${SUMO_API}${path}`, { headers:{ 'accept':'application/json' } });
  if(!r.ok){ console.warn(`[api] ${path} -> ${r.status}`); return null; }
  try { return await r.json(); } catch { console.warn(`[api] ${path} -> bad json`); return null; }
}

// TIER_ORDER + rank parsing shared with setup-basho's refresh (min rankValue = career peak).
const TIER_ORDER = { Yokozuna:6, Ozeki:5, Sekiwake:4, Komusubi:3, Maegashira:2, Juryo:1 };
function rankTier(rankStr){ const m=String(rankStr||'').match(/^[A-Za-z]+/); return m?m[0]:null; }
// Map a rank string to the arc y-value + short label the template expects.
function rankToArc(rankStr){
  const s=String(rankStr||''); const tier=rankTier(s);
  if(tier==='Yokozuna') return { v:1, r:'Y' };
  if(tier==='Ozeki')    return { v:2, r:'O' };
  if(tier==='Sekiwake') return { v:3, r:'S' };
  if(tier==='Komusubi') return { v:4, r:'K' };
  const m=s.match(/Maegashira\s*(\d+)/i); if(m) return { v:4+Math.min(+m[1],17), r:'M'+m[1] };
  return null; // Juryo/below -> not plotted (dashed lead-in handles the gap)
}
const bashoName = code => { const map={'01':'Ht','03':'Hr','05':'Nt','07':'Ng','09':'Ak','11':'Ky'};
  const m=String(code).match(/^(\d{4})(\d{2})$/); return m ? (m[1].slice(2)+map[m[2]]) : null; };  // 202609 -> 26Ak
const bashoArcLabel = code => { const map={'01':'Hts',' 03':'Hru','03':'Hru','05':'Ntu','07':'Ngy','09':'Aki','11':'Kyu'};
  const m=String(code).match(/^(\d{4})(\d{2})$/); return m ? (map[m[2]]+m[1].slice(2)) : String(code); };

async function fetchSumo(id){
  const profile = await apiGet(`/rikishi/${id}`) || {};
  const withRanks = await apiGet(`/rikishi/${id}?ranks=true`) || {};
  const stats = await apiGet(`/rikishi/${id}/stats`) || {};
  return { profile, withRanks, stats };
}

// Pull the pieces we need, defensively. CONFIRM field names on the first Action run (see diag logs).
function readProfile(p){
  const out = {
    heightCm: num(p.height), weightKg: num(p.weight),
    birthDate: p.birthDate || null, shusshin: p.shusshin || null, heya: p.heya || null,
    debutRank: p.debut || p.firstBasho || null,
  };
  if(out.heightCm==null && out.weightKg==null) diag('rikishi/{id}', p);
  return out;
}
function readCareerStats(s){
  // sumo-api stats commonly nests division splits; CONFIRM the exact shape and adjust.
  const total = s.totalWins!=null ? { w:num(s.totalWins), l:num(s.totalLosses) } : null;
  const byDiv = s.totalByDivision || s.divisionStats || null;
  const mak = byDiv && (byDiv.Makuuchi || byDiv.makuuchi) || null;
  const makWL = mak ? { w:num(mak.wins ?? mak.win ?? mak.w), l:num(mak.losses ?? mak.loss ?? mak.l) } : null;
  const yusho = num(s.yusho ?? s.yushoCount);
  const sansho = s.sansho || {};   // e.g. {"Gino-sho":n,"Kanto-sho":n,"Shukun-sho":n}
  if(total==null) diag('rikishi/{id}/stats', s);
  return { total, makWL, yusho, sansho };
}
function readRankHistory(withRanks){
  const hist = Array.isArray(withRanks.rankHistory) ? withRanks.rankHistory
             : Array.isArray(withRanks.ranks) ? withRanks.ranks : [];
  if(!hist.length){ diag('rikishi/{id}?ranks', withRanks); return { points:[], highest:null, fromJuryo:false }; }
  // each entry: { bashoId / basho, rank, rankValue } — CONFIRM.
  const rows = hist.map(h => ({ code:h.bashoId ?? h.basho ?? h.id, rank:h.rank, rankValue:num(h.rankValue) }))
                   .filter(r=>r.code).sort((a,b)=>String(a.code).localeCompare(String(b.code)));
  const points = rows.map(r => { const a=rankToArc(r.rank); return a ? { b:bashoArcLabel(r.code), v:a.v, r:a.r } : null; }).filter(Boolean);
  // true peak = min rankValue; its tier is the highest-rank label
  let peak=null; for(const r of rows){ if(r.rankValue!=null && (peak==null || r.rankValue<peak.rankValue)) peak=r; }
  const highest = peak ? (rankTier(peak.rank)==='Maegashira' ? peak.rank : rankTier(peak.rank)) : null;
  const fromJuryo = rows.some(r => /Juryo|Makushita|Sandanme|Jonidan|Jonokuchi/i.test(String(r.rank)));
  return { points, highest, fromJuryo };
}

// ── Notion (read) ────────────────────────────────────────────────────────────
// Idiom mirrors gen-gumbai-snapshot.mjs / build-standings.mjs. CONFIRM property names against those.
async function notionQuery(dsId, body={}){
  if(!NOTION_TOKEN || String(dsId).startsWith('CONFIRM')) return [];
  const out=[]; let cursor;
  do{
    const r = await fetch(`https://api.notion.com/v1/data_sources/${dsId}/query`, {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${NOTION_TOKEN}`, 'Notion-Version':'2022-06-28', 'content-type':'application/json' },
      body: JSON.stringify({ ...body, start_cursor: cursor }),
    });
    if(!r.ok){ console.warn(`[notion] ${dsId} query -> ${r.status}`); break; }
    const j = await r.json(); out.push(...(j.results||[])); cursor = j.has_more ? j.next_cursor : null;
  } while(cursor);
  return out;
}
const prop = (page, name) => page && page.properties && page.properties[name];
const pText = p => !p ? null : (p.title||p.rich_text||[]).map(t=>t.plain_text).join('') || null;
const pSelect = p => p && p.select ? p.select.name : null;
const pNum = p => p && p.number!=null ? p.number : null;

// The current banzuke roster = the source of who gets a dashboard. Each row should carry the
// wrestler's sumo-api id (CONFIRM the property that holds it — likely on Master Rikishi, joined here).
async function currentRoster(){
  const rows = await notionQuery(DS.banzuke, {});   // CONFIRM: filter to the current basho if the DB holds many
  return rows.map(r => ({
    name: pText(prop(r,'Name')) || pText(prop(r,'Rikishi')),        // CONFIRM property name
    rank: pText(prop(r,'Rank')) || pSelect(prop(r,'Rank')),        // CONFIRM
    weightKg: pNum(prop(r,'Weight (kg)')),                         // current-basho weight
    yusho: pNum(prop(r,'Yusho')),                                  // CONFIRM: Banzuke honor fields
    // sansho fields + sumo-api id resolved via Master Rikishi join below
    _page: r,
  })).filter(x=>x.name);
}

// ── assemble one record (the template contract) ──────────────────────────────
async function buildRecord(entry){
  // Resolve the sumo-api id for this wrestler. CONFIRM where it lives (Master Rikishi "Sumo API ID"?).
  const id = entry.sumoId; // set by the join step; falls back to slug if absent
  const S = id ? await fetchSumo(id) : { profile:{}, withRanks:{}, stats:{} };
  const prof = readProfile(S.profile);
  const career = readCareerStats(S.stats);
  const arc = readRankHistory(S.withRanks);

  // crew record (Jan 2025+, makuuchi) — from the Match Log tally for this wrestler. CONFIRM the query/props.
  const crew = entry.crew || null;   // { w, l } computed by tallyMatchLog(); null until wired

  const rec = {
    id: entry.slug || String(id||entry.name).toLowerCase().replace(/\s+/g,''),
    name: entry.name, sample:false,
    rank: { current: entry.rank || null, basho: entry.bashoLabel || null },
    highestRank: arc.highest,
    photo: entry.portrait || null,
    origin: parseShusshin(prof.shusshin),
    vitals: {
      heightCm: prof.heightCm, weightKg: entry.weightKg ?? prof.weightKg,
      age: ageFrom(prof.birthDate), bday: bdayParts(prof.birthDate), stable: prof.heya,
    },
    birthday: entry.birthday || { inWindow:false },              // computed from DOB + basho-day dates (Match Log)
    records: {
      allDivision: career.total ? { w:career.total.w, l:career.total.l, pct:pct(career.total.w,career.total.l) } : null,
      makuuchi:    career.makWL ? { w:career.makWL.w, l:career.makWL.l, pct:pct(career.makWL.w,career.makWL.l) } : null,
      crew:        crew ? { w:crew.w, l:crew.l, pct:pct(crew.w,crew.l) } : null,
      note: null,   // template shows the makuuchi==crew coincidence note when they match — set below
    },
    specials: buildSpecials(entry, career),
    story: entry.story || { html: `<span class="who">${entry.name}</span> — story drafted from tracker data at fan-out.`, source:'draft' },
    arc: { fromJuryo: arc.fromJuryo, from:'from Juryo', points: arc.points },
    kimarite: entry.kimarite || { window:'since Jan 2025', totalWins:null, slices:[] },   // from Match Log tally
    mawashi: entry.mawashi || [],                                                          // Master Rikishi soft
    caliber: entry.caliber || { default:null, bashos:{} },                                 // Match Log history join (member)
    henka: entry.henka || [],                                                              // Match Log henka tally vs field
    bio: entry.bio || [],                                                                  // Master Rikishi soft fields
  };
  if(rec.records.makuuchi && rec.records.crew &&
     rec.records.makuuchi.w===rec.records.crew.w && rec.records.makuuchi.l===rec.records.crew.l)
    rec.records.note = `For ${entry.name}, Makuuchi and Crew match, since he reached makuuchi after our Jan 2025 epoch; the three-way split matters most for veterans who fought before it.`;
  return rec;
}

function buildSpecials(entry, career){
  // Order fixed: Kinboshi, Shukun-sho, Kanto-sho, Gino-sho, Yusho (Yusho pinned far right).
  // Counts + provenance: yusho/sansho from Banzuke fields (entry.*), kinboshi from Match Log gold-star bouts.
  const s = entry.sansho || {};
  return [
    { jp:'Kinboshi',   en:'Gold Star',        count: entry.kinboshiCount ?? null, basho: entry.kinboshiBasho || [] },
    { jp:'Shukun-sho', en:'Outstanding Perf.', count: s.shukun?.count ?? null,     basho: s.shukun?.basho || [] },
    { jp:'Kanto-sho',  en:'Fighting Spirit',   count: s.kanto?.count ?? null,      basho: s.kanto?.basho || [] },
    { jp:'Gino-sho',   en:'Technique',         count: s.gino?.count ?? null,       basho: s.gino?.basho || [] },
    { jp:'Yusho',      en:"Emperor's Cup",     count: entry.yusho ?? career.yusho ?? null, basho: entry.yushoBasho || [] },
  ];
}

// small helpers
function ageFrom(bd){ if(!bd) return null; const b=new Date(bd); if(isNaN(b)) return null;
  const n=new Date(); let a=n.getUTCFullYear()-b.getUTCFullYear();
  const m=n.getUTCMonth()-b.getUTCMonth(); if(m<0||(m===0&&n.getUTCDate()<b.getUTCDate())) a--; return (a>=0&&a<100)?a:null; }
function bdayParts(bd){ if(!bd) return null; const b=new Date(bd); if(isNaN(b)) return null;
  const mon=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][b.getUTCMonth()];
  return { mon, day:b.getUTCDate(), yy:"’"+String(b.getUTCFullYear()).slice(2) }; }
function parseShusshin(s){ if(!s) return { city:null, country:null, flag:'' };
  const parts=String(s).split(',').map(x=>x.trim()); return { city:parts[0]||null, country:parts[1]||parts[0]||null, flag:'' }; }

// ── main ──────────────────────────────────────────────────────────────────────
async function main(){
  const roster = await currentRoster();
  if(!roster.length){ console.warn('[metrics] empty roster — CONFIRM the Banzuke data-source id + property names.'); }
  // NOTE (session 2 wiring): join each roster entry to Master Rikishi (sumo-api id, portrait, soft bio),
  // tally the Match Log for crew W-L / kimarite / kinboshi / henka / birthday / caliber, read the Banzuke
  // honor fields (yusho/sansho + provenance). Those tally functions are the remaining build — the sumo-api
  // side and the record assembly are here and matched to the template contract.
  const out = {};
  for(const entry of roster){
    try { const rec = await buildRecord(entry); out[rec.id] = rec; }
    catch(e){ console.warn(`[metrics] ${entry.name}: ${e && e.message || e}`); }
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[metrics] wrote ${Object.keys(out).length} rikishi -> ${OUT}`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
