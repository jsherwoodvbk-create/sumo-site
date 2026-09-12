// gen-rikishi-metrics.mjs — the per-rikishi METRICS LAYER generator.
//
// Runs in the GitHub Action (Node 20 fetch, NOTION_TOKEN) — NOT the Cowork sandbox, where sumo-api
// is egress-blocked (the same wall build-standings / setup-basho / gen-gumbai-snapshot work around).
// Produces ONE record per current-banzuke (Makuuchi) rikishi, keyed by NAME-SLUG so the standings
// name-links resolve (?r=<slug>), matching the contract rikishi-dashboard.html renders. Build the
// layer once; the dashboard is face #1 over it (leaderboard + Gumbai fan-out read the same shape).
//
// SOURCES (each in the role where it is authoritative):
//   A. sumo-api  (HARD, full career = the AUTHORITY for background history):
//      - /basho/{BASHO}/banzuke/Makuuchi   the roster + each wrestler's sumo-api rikishiID + rank
//                                          (the SAME endpoint build-standings/setup-basho trust;
//                                          gives shikonaEn → the exact name the standings slug uses,
//                                          so link parity is structural, not a second lookup)
//      - /rikishi/{id}                     profile: shusshin, height, weight, birthDate, heya
//      - /rikishi/{id}?ranks=true          full rank history → arc + true career-peak tier
//      - /rikishi/{id}/stats               career W-L (all-division + makuuchi split), yusho
//   B. Notion  (system of record where the crew is the authority — Jan 2025+ tracked era):
//      - Banzuke        current-basho weight; crew-era honors + provenance: Yusho (checkbox/basho),
//                       Special Prizes (multi-select/basho), Gold Stars (kinboshi rollup/basho)
//      - Match Log      crew record (W-L), kimarite mix, henka, birthday bouts, opponent-tier caliber
//      - Master Rikishi FULL PORTRAIT (the "Photo" file property — the standing shot, NOT the
//                       img/headshots head-crops), soft bio (Nicknames/Known For/Mawashi/Translation/
//                       Notes/Country), authoritative Birthday
//      - Kimarite       technique-id → Japanese name
//
// DISCIPLINE (carried from setup-basho's Highest-Rank refresh + the house firewall):
//   - DEFENSIVE + SELF-DIAGNOSING: on a sumo-api field we can't find, log the response keys ONCE and
//     leave the value blank. A schema mismatch is a logged no-op, NEVER a fabricated number.
//     Blank-not-faked. The sumo-api /stats + ?ranks shapes are the two we could not verify from the
//     sandbox — they carry diag() and degrade to blank, so the FIRST Action run's log is the fix list.
//   - Windows are labeled distinctly: all-division + makuuchi = full career (sumo-api); crew = the
//     tracked Jan-2025+ era (Match Log). Honors (kinboshi/sansho/yusho) = crew-era with basho
//     provenance (Banzuke) — that is what the tracker authoritatively owns; never claimed "career".
//   - Master Rikishi SOFT data is never auto-invented: the story stays a human-owned draft, the bio
//     emits only fields that exist. Fan-out is to the current banzuke only.
//   - Nothing is sourced from a transcript. No macrons. Never "all-time" bare downstream (the
//     template labels the three records).
//
// PORTRAIT (resolved 2026-09-11): confirmed that GitHub holds ONLY the head-crops
//   (/img/headshots/<slug>.png, 200px, from build-headshots.mjs) — the small standings avatars. The
//   FULL standing-shot portrait the dashboard wants lives ONLY in the Notion "Photo" field, whose
//   signed file URL EXPIRES (~1h): fine right after each daily regen, stale by evening. So the
//   generator resolves the portrait in priority order:
//     1. a COMMITTED /img/portraits/<slug>.{jpg,jpeg,png,webp} if present in the repo checkout
//        (durable, cache-friendly — the head-crop pattern applied to the full portrait; needs a
//        sibling build step, e.g. build-portraits.mjs, to populate it — NOT built yet);
//     2. an EXTERNAL Photo url (stable — used as-is);
//     3. a Notion FILE url (works this regen, expires — emitted + FLAGGED so a stale image is seen);
//     4. null → the template's placeholder.
//   Because (1) is checked against the live checkout, "are the portraits in GitHub yet?" answers
//   itself per-run: committed ones win, everyone else falls back gracefully.
//
// OUTPUT: rikishi-metrics.json = { "<slug>": <record>, ... }. The template fetches it and picks by
//   ?r=<slug>, falling back to its embedded sample if the file is absent. Regenerated on the banzuke
//   drop (rides banzuke-drop) and daily during a basho (day-gated caliber / current pieces).
//
// ENV: NOTION_TOKEN (required) · BASHO / BASHO_LABEL / TOURNAMENT_PAGE_ID (default Aki 2026 — the
//   banzuke-drop cascade flips these three, exactly as in setup-basho / gen-gumbai-snapshot) ·
//   METRICS_OUT (default rikishi-metrics.json) · DRY_RUN ("1" = pull + report, write nothing).

import { writeFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const OUT = process.env.METRICS_OUT || 'rikishi-metrics.json';
const DRY = (process.env.DRY_RUN === '1' || String(process.env.DRY_RUN).toLowerCase() === 'true');

// ─── PER-BASHO CONFIG — the three values the banzuke-drop cascade flips each tournament ───────────
//   (BASHO / BASHO_LABEL / TOURNAMENT_PAGE_ID change together in setup-basho, sync-notion,
//    build-standings and gen-gumbai-snapshot — keep them char-for-char in step with those.)
const BASHO              = process.env.BASHO || '202609';
const BASHO_LABEL        = process.env.BASHO_LABEL || 'Aki 2026';
const TOURNAMENT_PAGE_ID = process.env.TOURNAMENT_PAGE_ID || '3351ade1-241f-8011-8987-d959538f54a0';
// ──────────────────────────────────────────────────────────────────────────────────────────────

const DIVISION = 'Makuuchi';
const API = 'https://www.sumo-api.com/api';
const UA = 'salt-stats-sumo-metrics/1.0 (+https://sumo.stavesandhoop.com; per-rikishi dashboard metrics)';
const API_THROTTLE_MS = 400;   // polite pacing on the free one-person sumo-api

// Verified DB ids (gen-gumbai-snapshot.mjs / setup-basho.mjs / State §4).
const DB = {
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
  matchLog:      '1a2bad82-ebf5-4472-87ea-cb2c2481f9f1',
  kimarite:      '2591d1eb-2146-4745-ab0a-72ba57bfd213',
};

if (!NOTION_TOKEN) { console.error('FATAL: NOTION_TOKEN not set'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── helpers ───────────────────────────────────────────────────────────────────
const num = v => (v == null || v === '' || isNaN(+v)) ? null : +v;
// URL slug for ?r=<id> — MUST match slug() in standings.html so the name-links resolve.
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// looser key for joining sumo-api shikonaEn ↔ Notion "Ring Name" (guards stray punctuation/case).
const nkey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const pctStr = (w, l) => (w + l > 0) ? ('.' + String(Math.round(w / (w + l) * 1000)).padStart(3, '0')) : null;

// basho label ("Kyushu 2025") → template code ("25Ky"); and a sort key for provenance ordering.
const MONTH2 = { Hatsu:['Ht',1], Haru:['Hr',3], Natsu:['Nt',5], Nagoya:['Ng',7], Aki:['Ak',9], Kyushu:['Ky',11] };
function labelToCode(label){
  const m = String(label || '').trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m || !MONTH2[m[1]]) return { code: String(label || '').trim() || null, sort: 0 };
  const [code, mon] = MONTH2[m[1]];
  return { code: m[2].slice(2) + code, sort: (+m[2]) * 100 + mon };
}

const seenDiag = new Set();
function diag(where, obj){
  if (seenDiag.has(where)) return; seenDiag.add(where);
  console.warn(`[diag] ${where}: expected field not found; response keys = ${obj && typeof obj === 'object' ? Object.keys(obj).join(',') : typeof obj}`);
}

// ── Notion REST (verbatim idiom from gen-gumbai-snapshot / setup-basho) ─────────
async function notion(path, method = 'GET', body, attempt = 0){
  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status === 529) && attempt < 6) {
    const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
    console.warn(`  ${res.status} rate-limited on ${method} ${path} — waiting ${Math.round(wait/1000)}s`);
    await sleep(wait); return notion(path, method, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}
async function queryAll(dbId, filter){
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
// property readers (same shapes as gen-gumbai-snapshot)
const idNoDash = s => String(s || '').replace(/-/g, '');
const titleOf = (p, prop) => { const x = p.properties?.[prop]; const a = x?.title || x?.rich_text || []; return a.map(t => t.plain_text).join('').trim(); };
const textOf  = (p, prop) => (p.properties?.[prop]?.rich_text || []).map(t => t.plain_text).join('').trim();
const selOf   = (p, prop) => p.properties?.[prop]?.select?.name ?? null;
const multiOf = (p, prop) => (p.properties?.[prop]?.multi_select || []).map(o => o.name);
const numOf   = (p, prop) => (typeof p.properties?.[prop]?.number === 'number' ? p.properties[prop].number : null);
const boolOf  = (p, prop) => p.properties?.[prop]?.checkbox === true;
const dateOf  = (p, prop) => p.properties?.[prop]?.date?.start ? String(p.properties[prop].date.start).slice(0, 10) : null;
const relIds  = (p, prop) => (p.properties?.[prop]?.relation || []).map(r => idNoDash(r.id));
const rel1    = (p, prop) => { const a = relIds(p, prop); return a[0] || null; };
// Photo file property → first usable URL (external = stable; file = signed/expiring — flagged).
function photoOf(p){
  const files = p.properties?.['Photo']?.files || [];
  for (const f of files) {
    const url = f?.external?.url || f?.file?.url || null;
    if (url) return { url, expiring: !!(f?.file?.url) && !f?.external?.url };
  }
  return null;
}
// A committed full portrait, if one exists in the repo checkout (durable, cache-friendly). Checked on
// the Action where the repo is checked out, so it self-answers "is this wrestler's portrait in GitHub?".
const PORTRAIT_EXTS = ['jpg','jpeg','png','webp'];
function committedPortrait(sl){
  for (const ext of PORTRAIT_EXTS) if (existsSync(`img/portraits/${sl}.${ext}`)) return `/img/portraits/${sl}.${ext}`;
  return null;
}

// ── sumo-api (Action-only) ──────────────────────────────────────────────────────
async function getJson(url){
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) { console.warn(`[api] ${url} -> ${r.status}`); return null; }
  try { return await r.json(); } catch { console.warn(`[api] ${url} -> non-JSON`); return null; }
}
// roster + sumo-api id, from the SAME banzuke endpoint build-standings/setup-basho read.
async function getBanzukeRoster(){
  const j = await getJson(`${API}/basho/${BASHO}/banzuke/${DIVISION}`);
  if (!j) return { error: 'could not reach sumo-api banzuke endpoint' };
  const all = [...(j.east || []), ...(j.west || [])];
  if (!all.length) return { notPosted: true };
  return { all: all.map(r => ({ name: r.shikonaEn, sumoId: r.rikishiID, rank: rankShort(r.rank), rankValue: num(r.rankValue) })) };
}
// "Maegashira 1 East" → "M1" (rankInfo, verbatim from build-standings/setup-basho).
function rankShort(rankStr){
  const parts = String(rankStr || '').split(' '); const w = parts[0];
  if (w === 'Yokozuna') return 'Yokozuna';
  if (w === 'Ozeki') return 'Ozeki';
  if (w === 'Sekiwake') return 'Sekiwake';
  if (w === 'Komusubi') return 'Komusubi';
  if (w === 'Maegashira') return 'M' + parts[1];
  return rankStr;
}
const rankTier = r => (['Yokozuna','Ozeki','Sekiwake','Komusubi'].includes(r) ? r : (/^M\d{1,2}$/.test(r) ? 'Maegashira' : (r === 'J' ? 'Juryo' : null)));
// arc y-value + short label the template plots. Makuuchi: Y=1 … M17=21. Lower divisions live in a
// compressed band below (Juryo=23, Makushita=25 … Jonokuchi=28) so a fall OUT of makuuchi shows as a
// real plunge, not a gap (template draws a "lower divisions" zone below M17).
function rankToArc(rankStr){
  const s = rankShort(rankStr);
  if (s === 'Yokozuna') return { v: 1, r: 'Y' };
  if (s === 'Ozeki')    return { v: 2, r: 'O' };
  if (s === 'Sekiwake') return { v: 3, r: 'S' };
  if (s === 'Komusubi') return { v: 4, r: 'K' };
  const m = s.match(/^M(\d+)$/); if (m) return { v: 4 + Math.min(+m[1], 17), r: 'M' + m[1] };
  const raw = String(rankStr || '');
  if (s === 'J' || /^Juryo\b/i.test(raw))  return { v: 23, r: 'J' };
  if (/Makushita/i.test(raw)) return { v: 25, r: 'Ms' };
  if (/Sandanme/i.test(raw))  return { v: 26, r: 'Sd' };
  if (/Jonidan/i.test(raw))   return { v: 27, r: 'Jd' };
  if (/Jonokuchi/i.test(raw)) return { v: 28, r: 'Jk' };
  return null; // unknown → not plotted
}
// sumo-api rankHistory basho code (YYYYMM) → arc x-label ("202509" → "Aki25").
const CODE2 = { '01':['Hts','Ht'], '03':['Hru','Hr'], '05':['Ntu','Nt'], '07':['Ngy','Ng'], '09':['Aki','Ak'], '11':['Kyu','Ky'] };
function arcLabel(code){ const m = String(code).match(/^(\d{4})(\d{2})$/); return m && CODE2[m[2]] ? CODE2[m[2]][0] + m[1].slice(2) : String(code || ''); }

async function fetchProfile(id){
  const p = await getJson(`${API}/rikishi/${id}`); if (!p) return {};
  const out = { heightCm: num(p.height), weightKg: num(p.weight), birthDate: p.birthDate ? String(p.birthDate).slice(0,10) : null, shusshin: p.shusshin || null, heya: p.heya || null };
  if (out.heightCm == null && out.birthDate == null) diag('rikishi/{id}', p);
  return out;
}
async function fetchArc(id){
  const r = await getJson(`${API}/rikishi/${id}?ranks=true`); if (!r) return { points: [], highest: null, fromJuryo: false };
  const hist = Array.isArray(r.rankHistory) ? r.rankHistory : (Array.isArray(r.ranks) ? r.ranks : []);
  if (!hist.length) { diag('rikishi/{id}?ranks', r); return { points: [], highest: null, fromJuryo: false }; }
  const rows = hist.map(h => ({ code: h.bashoId ?? h.basho ?? h.id ?? null, rank: h.rank, rankValue: num(h.rankValue) }))
                   .sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const points = rows.map(r2 => { const a = rankToArc(r2.rank); return a ? { b: arcLabel(r2.code), v: a.v, r: a.r } : null; }).filter(Boolean);
  let peak = null; for (const r2 of rows) { if (r2.rankValue != null && (peak == null || r2.rankValue < peak.rankValue)) peak = r2; }
  const highest = peak ? (rankTier(rankShort(peak.rank)) === 'Maegashira' ? rankShort(peak.rank) : rankTier(rankShort(peak.rank))) : null;
  const fromJuryo = rows.some(r2 => /Juryo|Makushita|Sandanme|Jonidan|Jonokuchi/i.test(String(r2.rank)));
  return { points, highest, fromJuryo };
}
let _statsDumped = false;
// sansho lookup across the shape variants sumo-api might use.
function sanshoCount(obj, keys){ if (!obj || typeof obj !== 'object') return 0; for (const k of keys) if (obj[k] != null) return num(obj[k]) || 0; return 0; }
async function fetchCareer(id){
  const s = await getJson(`${API}/rikishi/${id}/stats`); if (!s) return { allDivision: null, makuuchi: null, yushoAll: null, sansho: {} };
  // One-time raw dump on a DRY run so a wrong shape is a one-glance fix (the makuuchi split was
  // mis-keyed on the first live run: it lives under winsByDivision/lossByDivision, not totalByDivision).
  if (DRY && !_statsDumped) { _statsDumped = true;
    console.log(`[stats keys] ${Object.keys(s).join(', ')}`);
    console.log(`[stats sample] ${JSON.stringify(s).slice(0, 700)}`); }
  const total = (s.totalWins != null || s.absenceByDivision) ? { w: num(s.totalWins), l: num(s.totalLosses) } : null;
  // makuuchi career split — sumo-api keys it winsByDivision / lossByDivision (a number per division).
  const winsDiv = s.winsByDivision || s.totalByDivision || {};
  const lossDiv = s.lossByDivision || s.lossesByDivision || {};
  const mkW = num(winsDiv.Makuuchi ?? winsDiv.makuuchi);
  const mkL = num(lossDiv.Makuuchi ?? lossDiv.makuuchi);
  const mak = (mkW != null || mkL != null) ? { w: mkW ?? 0, l: mkL ?? 0 } : null;
  const yushoAll = num(s.yusho ?? s.yushoCount);
  const sansho = {
    shukun: sanshoCount(s.sansho, ['Shukun-sho','Shukunsho','shukun','Outstanding Performance']),
    kanto:  sanshoCount(s.sansho, ['Kanto-sho','Kantosho','kanto','Fighting Spirit']),
    gino:   sanshoCount(s.sansho, ['Gino-sho','Ginosho','gino','Technique']),
  };
  if (total == null) diag('rikishi/{id}/stats', s);
  else if (mak == null) diag('rikishi/{id}/stats:winsByDivision', s);
  return {
    allDivision: total ? { w: total.w, l: total.l, pct: pctStr(total.w, total.l) } : null,
    makuuchi:    mak   ? { w: mak.w,   l: mak.l,   pct: pctStr(mak.w, mak.l) }     : null,
    yushoAll, sansho,
  };
}

// small date helpers
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function ageFrom(bd){ if (!bd) return null; const b = new Date(bd); if (isNaN(b)) return null;
  const n = new Date(); let a = n.getUTCFullYear() - b.getUTCFullYear();
  const m = n.getUTCMonth() - b.getUTCMonth(); if (m < 0 || (m === 0 && n.getUTCDate() < b.getUTCDate())) a--; return (a >= 0 && a < 100) ? a : null; }
function bdayParts(bd){ if (!bd) return null; const b = new Date(bd); if (isNaN(b)) return null;
  return { mon: MON[b.getUTCMonth()], day: b.getUTCDate(), yy: '’' + String(b.getUTCFullYear()).slice(2) }; }
function parseShusshin(s){ if (!s) return { city: null, country: null, flag: '' };
  const parts = String(s).split(',').map(x => x.trim()); return { city: parts[0] || null, country: parts[1] || parts[0] || null, flag: '' }; }

// mawashi color-name → hex (soft, best-effort; unknown names fall back to a neutral clay).
const MAWA_HEX = { navy:'#2b3a67', blue:'#3a5a8f', royal:'#3a5a8f', maroon:'#6a2f2f', red:'#8a2f2f', crimson:'#7a2230',
  green:'#3a5a40', forest:'#2f4a36', gold:'#8a6d2f', yellow:'#b59b3a', mustard:'#9a7d2e', purple:'#5b3a7a', violet:'#5b3a7a',
  black:'#222222', white:'#e7ddc8', pink:'#c96f8a', 'sakura':'#ffb7c5', orange:'#c2662f', brown:'#6b4a2b', teal:'#2f6f6f',
  gray:'#7b7264', grey:'#7b7264', silver:'#b8b0a2', 'sky':'#6f97c2', 'light blue':'#6f97c2' };
function mawaHex(name){ const k = String(name || '').trim().toLowerCase(); return MAWA_HEX[k] || '#8a7a5a'; }
// "Navy → Maroon → Green" or comma/newline list → ordered [{b:'',c:hex,chg}] (b left blank: Notion
// holds no per-basho stamp for mawashi; the crew fills basho labels when known).
function buildMawashi(currentColor, pastText){
  const seq = [];
  if (pastText) for (const part of String(pastText).split(/[,\n→>]+/)) { const t = part.trim(); if (t) seq.push(t); }
  if (currentColor && String(currentColor).trim()) seq.push(String(currentColor).trim());
  const out = []; let prev = null;
  for (const c of seq) { const hex = mawaHex(c); out.push({ b: c, c: hex, chg: prev !== null && hex !== prev ? 1 : 0 }); prev = hex; }
  return out;
}

const KIM_PALETTE = ['#cf5a2c','#2f8f5b','#7a4fb0','#4a7fb5','#c99a2e','#b5566f','#3a9aa0','#8a7a3a','#5a8f6a','#9a5aa0','#c2662f','#4a6a8f'];
const OTHER_HEX = '#8a8168';

// ── main ───────────────────────────────────────────────────────────────────────
async function main(){
  console.log(`gen-rikishi-metrics: ${BASHO_LABEL} (${BASHO}) · ${DRY ? 'DRY (pull + report, no write)' : 'WRITE'} → ${OUT}`);
  const flags = [];

  // 1) roster + sumo-api ids from the banzuke endpoint (the standings' own source).
  const rb = await getBanzukeRoster();
  if (rb.error) { console.error(`✗ ${rb.error}. Nothing written; re-run.`); process.exit(1); }
  if (rb.notPosted) { console.log(`⏸  Banzuke not posted yet for ${BASHO_LABEL}. Nothing to build. STOP.`); process.exit(0); }
  const roster = rb.all;
  console.log(`  ✓ banzuke roster: ${roster.length} Makuuchi wrestlers`);

  // 2) Notion pulls (one query each; joined in memory).
  const [mrPages, bzPages, mlPages, kmPages] = await Promise.all([
    queryAll(DB.masterRikishi),
    queryAll(DB.banzuke),
    queryAll(DB.matchLog),
    queryAll(DB.kimarite),
  ]);
  console.log(`  ✓ notion: master=${mrPages.length} banzuke=${bzPages.length} matchlog=${mlPages.length} kimarite=${kmPages.length}`);

  // Master Rikishi: by name-key → page (portrait, soft bio, birthday).
  const mrByKey = new Map(), mrIdByKey = new Map(), mrKeyById = new Map();
  for (const p of mrPages) { const nm = titleOf(p, 'Ring Name'); if (!nm) continue;
    const k = nkey(nm); mrByKey.set(k, p); mrIdByKey.set(k, idNoDash(p.id)); mrKeyById.set(idNoDash(p.id), k); }
  // Kimarite id → JP name.
  const kmById = new Map(); for (const p of kmPages) { const n = textOf(p, 'Kimarite'); if (n) kmById.set(idNoDash(p.id), n); }

  // Banzuke: rank per (masterId, tournamentId) for the caliber opponent-tier join; honors per masterId;
  // current-basho weight per masterId.
  const rankByRikishiTourney = new Map();  // `${masterId}|${tourneyId}` → short rank
  const honorsByMaster = new Map();        // masterId → { kinboshi, yusho, sansho{OP,FS,TE}, provenance }
  const weightByMaster = new Map();        // masterId → current-basho Weight (kg)
  const H0 = () => ({ kinboshi:0, yusho:0, OP:0, FS:0, TE:0, kb:[], yu:[], op:[], fs:[], te:[] });
  for (const p of bzPages) {
    const rid = rel1(p, 'Rikishi'); if (!rid) continue;
    const tid = rel1(p, 'Tournament');
    const rank = selOf(p, 'Rank');
    if (tid && rank) rankByRikishiTourney.set(`${rid}|${tid}`, rank);
    // basho code from the Entry title suffix ("Name — Aki 2026")
    const label = titleOf(p, 'Entry').split(' — ')[1] || '';
    const { code, sort } = labelToCode(label);
    if (tid === idNoDash(TOURNAMENT_PAGE_ID) || tid === TOURNAMENT_PAGE_ID.replace(/-/g,'')) {
      const w = numOf(p, 'Weight (kg)'); if (w != null) weightByMaster.set(rid, w);
    }
    const H = honorsByMaster.get(rid) || H0();
    const gs = numOf(p, 'Gold Stars') || 0;
    if (gs > 0) { H.kinboshi += gs; H.kb.push({ code, sort }); }
    if (boolOf(p, 'Yusho')) { H.yusho += 1; H.yu.push({ code, sort }); }
    const sp = multiOf(p, 'Special Prizes');
    if (sp.includes('Outstanding Performance')) { H.OP += 1; H.op.push({ code, sort }); }
    if (sp.includes('Fighting Spirit'))        { H.FS += 1; H.fs.push({ code, sort }); }
    if (sp.includes('Technique'))              { H.TE += 1; H.te.push({ code, sort }); }
    honorsByMaster.set(rid, H);
  }
  const prov = arr => [...new Set(arr.slice().sort((a,b)=>a.sort-b.sort).map(x=>x.code).filter(Boolean))];

  // Match Log: per-master tallies (crew W-L, kimarite wins, henka, birthday bouts) + per-tournament
  // opponent list for the caliber join. Full DB = the tracked Jan-2025+ crew era.
  const ML = new Map(); // masterId → { w,l, kim:Map, henkaFull, henkaPartial, bouts:[{tid,day,date,oppId,won}] }
  const M0 = () => ({ w:0, l:0, kim:new Map(), henkaFull:0, henkaPartial:0, bouts:[] });
  let mlUsed = 0;
  for (const p of mlPages) {
    const wId = rel1(p, 'Winner'), lId = rel1(p, 'Loser');
    if (!wId || !lId) continue;
    mlUsed++;
    const tid = rel1(p, 'Tournament'); const day = numOf(p, 'Day #'); const date = dateOf(p, 'Date');
    const tId = rel1(p, 'Technique'); const kim = tId && kmById.get(tId);
    const henka = selOf(p, 'Henka'); // "Full" | "Partial" | null — attributed to the bout WINNER (a henka is a winning sidestep; see HENKA note)
    const W = ML.get(wId) || M0(); W.w++; if (kim) W.kim.set(kim, (W.kim.get(kim) || 0) + 1);
    if (henka === 'Full') W.henkaFull++; else if (henka === 'Partial') W.henkaPartial++;
    W.bouts.push({ tid, day, date, oppId: lId, won: true }); ML.set(wId, W);
    const L = ML.get(lId) || M0(); L.l++;
    L.bouts.push({ tid, day, date, oppId: wId, won: false }); ML.set(lId, L);
  }
  // field henka baseline (makuuchi average, tracked era): total henka bouts / total bouts, ×100.
  const totalHenka = [...ML.values()].reduce((a, m) => a + m.henkaFull + m.henkaPartial, 0);
  const totalBouts = mlUsed; // each bout counted once (from the winner's henka flag)
  const fieldFullAvg    = totalBouts ? +( [...ML.values()].reduce((a,m)=>a+m.henkaFull,0)    / totalBouts * 100).toFixed(1) : null;
  const fieldPartialAvg = totalBouts ? +( [...ML.values()].reduce((a,m)=>a+m.henkaPartial,0) / totalBouts * 100).toFixed(1) : null;

  const tierBucket = rank => { const t = rankTier(rank); if (t === 'Yokozuna'||t==='Ozeki'||t==='Sekiwake'||t==='Komusubi') return 'Named';
    if (t === 'Maegashira') { const n = +String(rank).replace('M',''); return n <= 8 ? 'HighM' : 'LowM'; } return 'LowM'; };

  // 3) assemble one record per roster wrestler.
  const out = {};
  for (const entry of roster) {
    const k = nkey(entry.name);
    const masterId = mrIdByKey.get(k) || null;
    const mp = mrByKey.get(k) || null;
    if (!masterId) flags.push(`${entry.name}: no Master Rikishi match — soft bio/portrait/crew tallies blank (sumo-api hard data still fills).`);

    // sumo-api (hard) — throttled, defensive
    const prof = await fetchProfile(entry.sumoId); await sleep(API_THROTTLE_MS);
    const arc  = await fetchArc(entry.sumoId);     await sleep(API_THROTTLE_MS);
    const car  = await fetchCareer(entry.sumoId);  await sleep(API_THROTTLE_MS);

    const ml = masterId ? ML.get(masterId) : null;
    const H  = masterId ? honorsByMaster.get(masterId) : null;

    // records
    const crew = ml ? { w: ml.w, l: ml.l, pct: pctStr(ml.w, ml.l) } : { w: null, l: null, pct: null };
    const records = { allDivision: car.allDivision, makuuchi: car.makuuchi, crew, note: null };
    if (records.makuuchi && records.crew && records.makuuchi.w === records.crew.w && records.makuuchi.l === records.crew.l && records.crew.w != null)
      records.note = `For ${entry.name}, Makuuchi and Crew match, since he reached makuuchi after our Jan 2025 epoch; the three-way split matters most for veterans who fought before it.`;

    // specials — COUNTS are all-time (sumo-api career), so pre-crew honors count too (e.g. a 2019 yusho);
    // basho CHIPS are crew-era only (the Banzuke is all we have per-basho provenance for). era='career'
    // where the count spans the whole career, 'crew' for kinboshi (no all-time source → crew-era count).
    // `pre` = honors with no chip (count minus what we can chip) so the template can show "+N earlier".
    const yuChips = H ? prov(H.yu) : [], opChips = H ? prov(H.op) : [], fsChips = H ? prov(H.fs) : [], teChips = H ? prov(H.te) : [], kbChips = H ? prov(H.kb) : [];
    const mkSpecial = (jp, en, count, chips, era) => ({ jp, en, count: count || 0, basho: chips, era, pre: era === 'career' ? Math.max(0, (count || 0) - chips.length) : 0 });
    const specials = [
      mkSpecial('Kinboshi',   'Gold Star',         H ? H.kinboshi : 0,   kbChips, 'crew'),
      mkSpecial('Shukun-sho', 'Outstanding Perf.', car.sansho?.shukun,   opChips, 'career'),
      mkSpecial('Kanto-sho',  'Fighting Spirit',   car.sansho?.kanto,    fsChips, 'career'),
      mkSpecial('Gino-sho',   'Technique',         car.sansho?.gino,     teChips, 'career'),
      mkSpecial('Yusho',      "Emperor's Cup",     car.yushoAll,         yuChips, 'career'),
    ];

    // kimarite mix (crew-era wins). Promote techniques largest-first into their own slice until the
    // leftover tail is ≤10% of wins, then fold that tail into "Other" — so Other never exceeds ~10%.
    let kimarite = { window: 'since Jan 2025', totalWins: ml ? ml.w : 0, slices: [] };
    if (ml && ml.w > 0) {
      const rows = [...ml.kim.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
      const total = rows.reduce((a, r) => a + r.n, 0) || 1;
      const MAX_NAMED = 7;   // readable pie ceiling (≈ the strawman: 7 named + Other)
      const slices = []; let acc = 0;
      for (const r of rows) {
        slices.push({ name: r.name, pct: Math.round(r.n / total * 100), color: KIM_PALETTE[slices.length % KIM_PALETTE.length] });
        acc += r.n;
        const tail = total - acc;                       // sum of everything not yet promoted
        if (tail <= 0.10 * total) break;                // remaining tail ≤10% → fold into Other (the common case)
        if (slices.length >= MAX_NAMED) break;          // readability wins over a strict 10% cap for a flat spread
      }
      const promoted = slices.length;
      const tailRows = rows.slice(promoted);
      const otherN = tailRows.reduce((a, r) => a + r.n, 0);
      if (otherN > 0) {
        const sumPct = slices.reduce((a, s) => a + s.pct, 0);
        // Keep the pie readable (one Other wedge) BUT name every folded technique in `tail`, so a
        // technician's full repertoire stays visible in the legend instead of vanishing into gray.
        const tail = tailRows.map(r => ({ name: r.name, n: r.n, pct: Math.round(r.n / total * 100) }));
        slices.push({ name: 'Other', pct: Math.max(0, 100 - sumPct), color: OTHER_HEX, moves: tailRows.length, tail });
      }
      kimarite.slices = slices;
    }

    // arc: fall back current point if sumo-api gave nothing
    const arcPoints = arc.points.length ? arc.points : [];
    const arcBlock = { fromJuryo: arc.fromJuryo, from: 'from Juryo', points: arcPoints };

    // caliber (member): opponent-tier W-L per basho the wrestler fought (Match Log × Banzuke ranks)
    const caliber = { default: null, bashos: {} };
    if (ml && ml.bouts.length) {
      const byTourney = new Map(); // tid → { code, sort, Named:[w,l], HighM:[w,l], LowM:[w,l] }
      for (const b of ml.bouts) {
        if (!b.tid) continue;
        const oppRank = rankByRikishiTourney.get(`${b.oppId}|${b.tid}`);
        const bucket = tierBucket(oppRank);
        // tournament code from any Banzuke entry we saw for this tourney (via the subject's own entry label)
        let meta = byTourney.get(b.tid);
        if (!meta) { const lbl = tourneyLabel(bzPages, b.tid); const lc = labelToCode(lbl); meta = { code: lc.code, sort: lc.sort, Named:[0,0], HighM:[0,0], LowM:[0,0] }; byTourney.set(b.tid, meta); }
        meta[bucket][b.won ? 0 : 1]++;
      }
      const ordered = [...byTourney.values()].filter(m => m.code).sort((a, b) => b.sort - a.sort);
      for (const m of ordered) caliber.bashos[m.code] = [
        ['Named', 'Y·O·S·K', m.Named[0], m.Named[1]],
        ['High M', 'M1–8',    m.HighM[0], m.HighM[1]],
        ['Low M', 'M9+ · Juryo', m.LowM[0], m.LowM[1]],
      ];
      caliber.default = ordered.length ? ordered[0].code : null;
    }

    // henka: him vs field (winner-attributed; blank when no henka bouts so the tile shows nothing false)
    const henka = [];
    if (ml && totalBouts) {
      const boutsFor = ml.w + ml.l;
      const fullPct = boutsFor ? +(ml.henkaFull / boutsFor * 100).toFixed(1) : 0;
      const partPct = boutsFor ? +(ml.henkaPartial / boutsFor * 100).toFixed(1) : 0;
      if (ml.henkaFull > 0 && fieldFullAvg != null)    henka.push({ label:'Full',    his: fullPct, avg: fieldFullAvg,    n: `${ml.henkaFull} in ${boutsFor} bouts` });
      if (ml.henkaPartial > 0 && fieldPartialAvg != null) henka.push({ label:'Partial', his: partPct, avg: fieldPartialAvg, n: `${ml.henkaPartial} in ${boutsFor} bouts` });
    }

    // birthday: bouts fought on the wrestler's birth month-day, inside a basho (crew-tracked)
    let birthday = { inWindow: false };
    if (mp && ml) {
      const bd = dateOf(mp, 'Birthday');
      const bp = bdayParts(bd);
      if (bd && bp) {
        const md = bd.slice(5); // MM-DD
        const bdayBouts = ml.bouts.filter(b => b.date && b.date.slice(5) === md);
        if (bdayBouts.length) {
          const w = bdayBouts.filter(b => b.won).length, l = bdayBouts.length - w;
          birthday = { inWindow: true, record: `${w}–${l}`, n: bdayBouts.length, on: `${bp.mon} ${bp.day}` };
        }
      }
    }

    // portrait — committed repo asset first (durable), then Notion (external stable / file expiring), then placeholder
    let photo = committedPortrait(slug(entry.name));
    if (!photo && mp) { const ph = photoOf(mp); if (ph) { photo = ph.url; if (ph.expiring) flags.push(`${entry.name}: portrait is a Notion-hosted file (signed URL EXPIRES ~1h) — no committed img/portraits/${slug(entry.name)}.* found. Durable fix: a build-portraits.mjs sibling to build-headshots that commits the full Photo.`); } }

    // vitals + origin + bio (soft, emit-what-exists)
    const birthDate = (mp && dateOf(mp, 'Birthday')) || prof.birthDate || null;
    const stable = (mp && selOf(mp, 'Stable')) || prof.heya || null; // Stable is a relation on Master; heya is the sumo-api fallback string
    const vitals = { heightCm: prof.heightCm ?? (mp ? numOf(mp, 'Height (cm)') : null), weightKg: (masterId && weightByMaster.get(masterId)) ?? prof.weightKg ?? null,
      age: ageFrom(birthDate), bday: bdayParts(birthDate) || { mon:'', day:'', yy:'' }, stable: stable || '—' };
    const origin = parseShusshin(prof.shusshin || (mp ? selOf(mp, 'Country of Origin') : null));

    const bio = [];
    if (prof.shusshin) bio.push({ k:'Shusshin', v: esc(prof.shusshin), src:'sumo-api' });
    if (birthDate && vitals.age != null) { const bp = bdayParts(birthDate); bio.push({ k:'Born', v:`${bp.day} ${bp.mon} ${birthDate.slice(0,4)} · age ${vitals.age}`, src:'sumo-api' }); }
    if (mp) {
      const knownFor = multiOf(mp, 'Known For'); if (knownFor.length) bio.push({ k:'Known for', v: esc(knownFor.join(', ')), src:'crew-curated' });
      const kfn = textOf(mp, 'Known For Notes'); if (kfn) bio.push({ k:'Notes', v: esc(kfn), src:'crew' });
      const tr = textOf(mp, 'Translation'); if (tr) bio.push({ k:'Shikona meaning', v: esc(tr), src:'crew' });
      const nick = textOf(mp, 'Nicknames'); bio.push({ k:'Nicknames', v: nick ? esc(nick) : 'None on file yet', src: nick ? 'crew · (J) official / (O) ours' : 'human-owned field' });
    }

    const rec = {
      id: slug(entry.name), name: entry.name, sample: false,
      // new to the crew's tracking (no logged bouts) → the template collapses empty crew panels into
      // one honest "limited crew history" banner and leans on the sumo-api career data that's always there.
      newToTracking: !ml || (ml.w + ml.l) === 0,
      rank: { current: entry.rank, basho: BASHO_LABEL },
      highestRank: arc.highest || (mp ? selOf(mp, 'Highest Rank') : null) || entry.rank,
      photo, origin,
      vitals, birthday, records, specials,
      story: { html: `<span class="who">${esc(entry.name)}</span> — story drafted from the tracker's banzuke + yusho records. Crew edits the prose.`, source: 'Built from our records (no web). Crew edits the prose.' },
      arc: arcBlock,
      kimarite,
      mawashi: mp ? buildMawashi(textOf(mp, 'Mawashi Color'), textOf(mp, 'Past Mawashi Colors')) : [],
      caliber,
      henka,
      bio,
    };
    out[rec.id] = rec;
    console.log(`  · ${entry.name} (${entry.rank}) → crew ${crew.w ?? '—'}-${crew.l ?? '—'} · career ${records.allDivision ? records.allDivision.w+'-'+records.allDivision.l : 'blank'} · arc ${arcPoints.length}pts · kim ${kimarite.slices.length} · caliber ${Object.keys(caliber.bashos).length}b`);
  }

  // 4) write
  if (DRY) { console.log(`\nDRY RUN — would write ${Object.keys(out).length} rikishi. Nothing written.`); }
  else { writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(`\n✓ wrote ${Object.keys(out).length} rikishi → ${OUT}`); }
  if (flags.length) { console.log('\n⚠️  FLAGS:'); for (const f of [...new Set(flags)]) console.log('  - ' + f); }
  else console.log('No flags.');
  console.log('\nReminder: the two sumo-api shapes we could not verify from the sandbox are /stats and');
  console.log('?ranks — if the diag lines above fired for everyone, the field name differs; adjust');
  console.log('fetchCareer / fetchArc (blank-not-faked means no bad number was written meanwhile).');
}

// tournament page id → its label, by scanning any Banzuke Entry that links it.
function tourneyLabel(bzPages, tid){
  for (const p of bzPages) { const t = rel1(p, 'Tournament'); if (t === tid) return titleOf(p, 'Entry').split(' — ')[1] || ''; }
  return '';
}
// escape for the strings we drop into the template's innerHTML (bio/story values render as HTML)
function esc(s){ return String(s ?? '').replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c])); }

main().catch(e => { console.error(e); process.exit(1); });
