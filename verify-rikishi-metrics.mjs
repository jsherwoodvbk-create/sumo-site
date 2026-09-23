// verify-rikishi-metrics.mjs — the INDEPENDENT dashboard publish gate.
//
// The per-rikishi dashboard renders client-side from rikishi-metrics.json (one record per current-
// banzuke wrestler). This script is the adversarial second pass on that artifact: it re-derives the
// hard facts from SOURCE (never trusts the generator), reconciles them against what the dashboard
// will show, checks the structural invariants + firewall + house style, and — when a key is present —
// runs a fresh-context model pass over the soft copy. It emits a PASS or an exception report naming
// each failed check, and EXITS NON-ZERO on any blocking exception so publish.yml can refuse to stage
// a bad rikishi-metrics.json (the last good dashboard stays live; the rest of the site still ships).
//
// WHY a separate pull, not a shared import: the point is to catch a generator that read the wrong
// source key or mislabeled a window. Re-implementing the reconciliation independently is the check.
// Two of the generator's real early bugs were exactly this shape (the makuuchi split mis-keyed; yusho
// all-division vs makuuchi) — an independent re-pull is what would have caught them before publish.
//
// LAYERS
//   1. Deterministic gate (ALWAYS runs): source reconciliation (when NOTION_TOKEN + sumo-api reachable)
//      + cross-field invariants (no pull needed) + firewall/house-style string checks. This is the
//      load-bearing gate — numbers are code's job, never a model's.
//   2. Adversarial model pass (ONLY when ANTHROPIC_API_KEY is set): a fresh Claude instance reads each
//      wrestler's soft copy (story/bio/note) beside the verified hard facts and flags the judgment-class
//      problems code can't — an age-relative claim the birth date won't support, a soft fact stated as
//      hard, an AI tell. Real contradictions BLOCK; style nits WARN. Bounded to wrestlers with a real
//      (non-placeholder) story, Haiku, small max_tokens.
//
// SEVERITY (echoing the fan's review-severity tier so genuine failures stay loud without false-reding
// on soft nits): BLOCK = a wrong/leaked/fabricated hard fact, a firewall breach, a macron, the sample
// shipped as real, a broken sum. WARN = freshness (expiring portrait), an AI-ish phrasing, a soft-copy
// style note. Exit code is 1 iff any BLOCK survives; WARNs are reported but never block.
//
// ENV: METRICS_IN (default rikishi-metrics.json) · NOTION_TOKEN (enables source reconciliation) ·
//   BASHO / BASHO_LABEL / TOURNAMENT_PAGE_ID (default Aki 2026 — the banzuke-drop trio) ·
//   ANTHROPIC_API_KEY (optional, enables the model pass) · VERIFY_MODEL (default a cheap Haiku) ·
//   VERIFY_MODEL_MAX (cap the model pass to N wrestlers, default 12) · STRICT_SOURCE ("1" = a source
//   pull that can't run becomes a BLOCK instead of a WARN; default off so a sumo-api outage doesn't
//   wedge publish — the invariant + string checks still gate).

import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';

const IN = process.env.METRICS_IN || 'rikishi-metrics.json';
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const BASHO = process.env.BASHO || '202609';
const BASHO_LABEL = process.env.BASHO_LABEL || 'Aki 2026';
const TOURNAMENT_PAGE_ID = process.env.TOURNAMENT_PAGE_ID || '3351ade1-241f-8011-8987-d959538f54a0';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VERIFY_MODEL = process.env.VERIFY_MODEL || 'claude-haiku-4-5';
const VERIFY_MODEL_MAX = Number(process.env.VERIFY_MODEL_MAX || 12);
const STRICT_SOURCE = (process.env.STRICT_SOURCE === '1' || String(process.env.STRICT_SOURCE).toLowerCase() === 'true');
const ANTHROPIC_VERSION = '2023-06-01';

const API = 'https://www.sumo-api.com/api';
const UA = 'salt-stats-sumo-verify/1.0 (+https://sumo.stavesandhoop.com; dashboard publish gate)';
const API_THROTTLE_MS = 400;
const DIVISION = 'Makuuchi';

const DB = {
  masterRikishi: 'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
  banzuke:       '8e3457a9-2747-4275-9b91-7ac03fe18290',
  matchLog:      '1a2bad82-ebf5-4472-87ea-cb2c2481f9f1',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v == null || v === '' || isNaN(+v)) ? null : +v;
const idNoDash = s => String(s || '').replace(/-/g, '');
const nkey = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const pctStr = (w, l) => (w + l > 0) ? ('.' + String(Math.round(w / (w + l) * 1000)).padStart(3, '0')) : null;

// ── exception ledger ─────────────────────────────────────────────────────────
const findings = []; // { sev:'BLOCK'|'WARN', who, check, detail }
function block(who, check, detail){ findings.push({ sev: 'BLOCK', who, check, detail }); }
function warn(who, check, detail){ findings.push({ sev: 'WARN', who, check, detail }); }

// ── Notion REST (same idiom as the generators) ───────────────────────────────
async function notion(path, method = 'GET', body, attempt = 0){
  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status === 529) && attempt < 6) {
    const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
    await sleep(wait); return notion(path, method, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
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
const titleOf = (p, prop) => { const x = p.properties?.[prop]; const a = x?.title || x?.rich_text || []; return a.map(t => t.plain_text).join('').trim(); };
const selOf   = (p, prop) => p.properties?.[prop]?.select?.name ?? null;
const multiOf = (p, prop) => (p.properties?.[prop]?.multi_select || []).map(o => o.name);
const numOf   = (p, prop) => (typeof p.properties?.[prop]?.number === 'number' ? p.properties[prop].number : null);
const boolOf  = (p, prop) => p.properties?.[prop]?.checkbox === true;
const relIds  = (p, prop) => (p.properties?.[prop]?.relation || []).map(r => idNoDash(r.id));
const rel1    = (p, prop) => { const a = relIds(p, prop); return a[0] || null; };

// ── sumo-api ─────────────────────────────────────────────────────────────────
async function getJson(url){
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
function rankShort(rankStr){
  const parts = String(rankStr || '').split(' '); const w = parts[0];
  if (['Yokozuna','Ozeki','Sekiwake','Komusubi'].includes(w)) return w;
  if (w === 'Maegashira') return 'M' + parts[1];
  return rankStr;
}
const rankTier = r => (['Yokozuna','Ozeki','Sekiwake','Komusubi'].includes(r) ? r : (/^M\d{1,2}$/.test(r) ? 'Maegashira' : null));
// INDEPENDENT peak: lowest rankValue in the rank history → its tier (or M# inside makuuchi).
async function sourceHighest(id){
  const r = await getJson(`${API}/rikishi/${id}?ranks=true`);
  if (!r) return { ok: false };
  const hist = Array.isArray(r.rankHistory) ? r.rankHistory : (Array.isArray(r.ranks) ? r.ranks : []);
  if (!hist.length) return { ok: false };
  let peak = null;
  for (const h of hist) { const rv = num(h.rankValue); if (rv != null && (peak == null || rv < peak.rv)) peak = { rv, rank: h.rank }; }
  if (!peak) return { ok: false };
  const short = rankShort(peak.rank);
  return { ok: true, highest: rankTier(short) === 'Maegashira' ? short : (rankTier(short) || short) };
}
async function sourceCareer(id){
  const s = await getJson(`${API}/rikishi/${id}/stats`);
  if (!s) return { ok: false };
  const total = (s.totalWins != null) ? { w: num(s.totalWins), l: num(s.totalLosses) } : null;
  const winsDiv = s.winsByDivision || s.totalByDivision || {};
  const lossDiv = s.lossByDivision || s.lossesByDivision || {};
  const mkW = num(winsDiv.Makuuchi ?? winsDiv.makuuchi);
  const mkL = num(lossDiv.Makuuchi ?? lossDiv.makuuchi);
  const mak = (mkW != null || mkL != null) ? { w: mkW ?? 0, l: mkL ?? 0 } : null;
  const yushoByDiv = s.yushoByDivision || {};
  const yushoMak = num(yushoByDiv.Makuuchi ?? yushoByDiv.makuuchi) ?? 0;
  return { ok: true, allDivision: total, makuuchi: mak, yushoMak };
}
async function sourceRoster(){
  const j = await getJson(`${API}/basho/${BASHO}/banzuke/${DIVISION}`);
  if (!j) return { ok: false };
  const all = [...(j.east || []), ...(j.west || [])];
  if (!all.length) return { ok: false, notPosted: true };
  const byKey = new Map();
  for (const r of all) byKey.set(nkey(r.shikonaEn), { sumoId: r.rikishiID, rank: rankShort(r.rank) });
  return { ok: true, byKey };
}

// ── macron / house-style detectors ────────────────────────────────────────────
const MACRON = /[ĀāĒēĪīŌōŪūÂÊÎÔÛ]|[aeiouAEIOU]̄/;
const AI_TELLS = [/\bdelve\b/i, /\btapestry\b/i, /at the end of the day/i, /it'?s not just [^.]*, it'?s/i, /\bunpack\b/i, /\bleverage\b/i, / — /];
const ALLOWED_BIO_SRC = /^(sumo-api|crew|crew-curated|human-owned|crew · \(J\)|crew · \(J\) official)/;

function stripHtml(s){ return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim(); }

// ── the per-record deterministic checks that need no source pull ──────────────
function invariantChecks(id, rec){
  const who = rec.name || id;

  if (rec.sample === true) block(who, 'sample-shipped', 'record has sample:true — the embedded template sample must never publish as real data');
  if (rec.id !== id) warn(who, 'key-mismatch', `record.id "${rec.id}" != map key "${id}"`);

  const r = rec.records || {};
  // pct strings recompute
  for (const [k, w] of [['allDivision', r.allDivision], ['makuuchi', r.makuuchi], ['crew', r.crew]]) {
    if (w && w.w != null && w.l != null) {
      const expect = pctStr(w.w, w.l);
      if (w.pct !== expect) block(who, `pct-${k}`, `${k} pct "${w.pct}" != recomputed "${expect}" from ${w.w}-${w.l}`);
    }
  }
  // window sanity: a division subset can't exceed the whole career
  if (r.makuuchi && r.allDivision && r.makuuchi.w != null && r.allDivision.w != null) {
    if (r.makuuchi.w > r.allDivision.w) block(who, 'window-makuuchi>career-wins', `makuuchi wins ${r.makuuchi.w} > all-division ${r.allDivision.w}`);
    if (r.makuuchi.l > r.allDivision.l) block(who, 'window-makuuchi>career-losses', `makuuchi losses ${r.makuuchi.l} > all-division ${r.allDivision.l}`);
  }
  // note present iff makuuchi==crew
  const mkEqCrew = r.makuuchi && r.crew && r.crew.w != null && r.makuuchi.w === r.crew.w && r.makuuchi.l === r.crew.l;
  if (mkEqCrew && !r.note) warn(who, 'note-missing', 'makuuchi == crew but the reconciliation note is absent');
  if (!mkEqCrew && r.note) warn(who, 'note-spurious', 'a makuuchi==crew note is present but the records do not match');
  // newToTracking consistency
  const crewBouts = (r.crew && r.crew.w != null) ? (r.crew.w + r.crew.l) : 0;
  if (rec.newToTracking && crewBouts > 0) block(who, 'newToTracking-wrong', `flagged newToTracking but crew shows ${crewBouts} bouts`);
  if (!rec.newToTracking && crewBouts === 0) warn(who, 'newToTracking-maybe', 'not flagged newToTracking yet crew record is empty');

  // kimarite: slices sum ~100, and crew-era total matches crew wins
  const kim = rec.kimarite;
  if (kim && Array.isArray(kim.slices) && kim.slices.length) {
    const sum = kim.slices.reduce((a, s) => a + (num(s.pct) || 0), 0);
    if (sum < 97 || sum > 103) block(who, 'kimarite-sum', `pie slices sum to ${sum}% (should be ~100)`);
    if (r.crew && r.crew.w != null && kim.totalWins != null && kim.totalWins !== r.crew.w)
      block(who, 'kimarite-total', `kimarite.totalWins ${kim.totalWins} != crew wins ${r.crew.w}`);
  }

  // caliber: summed per-basho W-L over all bashos must equal the crew record (every crew bout has a tier)
  const cal = rec.caliber;
  if (cal && cal.bashos && Object.keys(cal.bashos).length && r.crew && r.crew.w != null) {
    let cw = 0, cl = 0;
    for (const rows of Object.values(cal.bashos)) for (const row of rows) { cw += num(row[2]) || 0; cl += num(row[3]) || 0; }
    if (cw !== r.crew.w) block(who, 'caliber-wins', `caliber wins sum ${cw} != crew wins ${r.crew.w}`);
    if (cl !== r.crew.l) block(who, 'caliber-losses', `caliber losses sum ${cl} != crew losses ${r.crew.l}`);
  }

  // specials: count >= its basho chips; era in {crew,career}; pre = count - chips (career)
  for (const sp of (rec.specials || [])) {
    const chips = Array.isArray(sp.basho) ? sp.basho.length : 0;
    if (num(sp.count) != null && chips > sp.count) block(who, `special-${sp.en}`, `${sp.en} count ${sp.count} < its ${chips} basho chips`);
    if (!['crew', 'career'].includes(sp.era)) warn(who, `special-era-${sp.en}`, `unexpected era "${sp.era}"`);
    if (sp.era === 'career' && num(sp.count) != null) {
      const expectPre = Math.max(0, sp.count - chips);
      if ((sp.pre ?? 0) !== expectPre) warn(who, `special-pre-${sp.en}`, `pre ${sp.pre} != count-chips ${expectPre}`);
    }
  }

  // FIREWALL + house style on every string the dashboard renders
  const strings = [];
  if (rec.story?.html) strings.push(['story', stripHtml(rec.story.html)]);
  if (r.note) strings.push(['records.note', r.note]);
  for (const b of (rec.bio || [])) { strings.push([`bio:${b.k}`, stripHtml(b.v)]); if (b.src && !ALLOWED_BIO_SRC.test(b.src)) warn(who, 'bio-src', `bio "${b.k}" src "${b.src}" not in the allowed provenance set`); }
  for (const [where, s] of strings) {
    if (MACRON.test(s)) block(who, 'macron', `macron in ${where}: "${s.slice(0, 60)}"`);
    if (/\btranscript\b/i.test(s) && /result|beat|defeated|won|record/i.test(s)) warn(who, 'firewall-word', `${where} mentions a transcript near a result word — confirm no transcript-sourced hard fact`);
    for (const tell of AI_TELLS) if (tell.test(s)) { warn(who, 'ai-tell', `${where} reads AI-written (${String(tell)}): "${s.slice(0, 60)}" — de-AI it`); break; }
  }

  // freshness: an expiring Notion signed URL committed as the live portrait
  if (rec.photo && /amazonaws\.com|prod-files-secure|X-Amz-|\?.*Signature=/.test(String(rec.photo)))
    warn(who, 'portrait-expiring', 'photo is a Notion signed URL (~1h expiry) — commit a durable img/portraits/ asset instead');

  // spoiler-gate structural: no baked-in current-basho RESULT / champion field that bypasses the render gate
  for (const key of Object.keys(rec)) if (/^(champion|winner|result|yushoWinner|todayResult)$/i.test(key))
    block(who, 'spoiler-field', `record carries a "${key}" field — a current result must never live in the metrics (the template gates by watched day)`);
}

// ── the per-record source reconciliation (needs the pulls) ────────────────────
function reconcile(id, rec, src){
  const who = rec.name || id;
  const r = rec.records || {};
  const eq = (a, b) => (a == null && b == null) || (a != null && b != null && +a === +b);

  // sumo-api career (all-division + makuuchi + yusho)
  if (src.career && src.career.ok) {
    const c = src.career;
    if (c.allDivision && r.allDivision) {
      if (!eq(c.allDivision.w, r.allDivision.w) || !eq(c.allDivision.l, r.allDivision.l))
        block(who, 'career-alldiv', `all-division ${r.allDivision.w}-${r.allDivision.l} != sumo-api ${c.allDivision.w}-${c.allDivision.l}`);
    } else if (c.allDivision && !r.allDivision) {
      block(who, 'career-alldiv-blank', `dashboard shows blank all-division but sumo-api has ${c.allDivision.w}-${c.allDivision.l}`);
    }
    if (c.makuuchi && r.makuuchi) {
      if (!eq(c.makuuchi.w, r.makuuchi.w) || !eq(c.makuuchi.l, r.makuuchi.l))
        block(who, 'career-makuuchi', `makuuchi ${r.makuuchi.w}-${r.makuuchi.l} != sumo-api ${c.makuuchi.w}-${c.makuuchi.l}`);
    }
    const yuSpecial = (rec.specials || []).find(s => s.en === "Emperor's Cup" || s.jp === 'Yusho');
    if (yuSpecial && num(yuSpecial.count) != null && !eq(c.yushoMak, yuSpecial.count))
      block(who, 'yusho-makuuchi', `Yusho count ${yuSpecial.count} != sumo-api makuuchi yusho ${c.yushoMak}`);
  } else if (STRICT_SOURCE) block(who, 'career-source', 'could not reach sumo-api /stats (STRICT_SOURCE)');
    else warn(who, 'career-source', 'sumo-api /stats unreachable — career figures not reconciled this run');

  // highest rank
  if (src.highest && src.highest.ok) {
    if (rec.highestRank && src.highest.highest && String(rec.highestRank) !== String(src.highest.highest))
      warn(who, 'highest-rank', `highestRank "${rec.highestRank}" != sumo-api peak "${src.highest.highest}" (generator may have fallen back to a Notion/current value — confirm)`);
  } else if (STRICT_SOURCE) block(who, 'highest-source', 'could not reach sumo-api ?ranks (STRICT_SOURCE)');

  // crew record vs an INDEPENDENT Match Log tally
  if (src.crewByMaster) {
    const masterId = src.masterIdByKey ? src.masterIdByKey.get(nkey(rec.name)) : null;
    if (masterId) {
      const t = src.crewByMaster.get(masterId) || { w: 0, l: 0 };
      if (r.crew && r.crew.w != null) {
        if (!eq(t.w, r.crew.w) || !eq(t.l, r.crew.l))
          block(who, 'crew-record', `crew ${r.crew.w}-${r.crew.l} != independent Match Log tally ${t.w}-${t.l}`);
      } else if (t.w + t.l > 0) {
        block(who, 'crew-blank', `dashboard shows blank crew record but the Match Log has ${t.w}-${t.l} for this wrestler`);
      }
    }
  }
}

// ── layer 2: adversarial model pass over the soft copy ─────────────────────────
async function modelPass(records){
  const withStory = records.filter(([, rec]) => rec.story?.html && !/story is not written yet/i.test(rec.story.html));
  const pick = withStory.slice(0, VERIFY_MODEL_MAX);
  if (!pick.length) { console.log('  model pass: no non-placeholder stories to review — skipped.'); return; }
  console.log(`  model pass: ${pick.length} wrestler(s) with a real story (of ${withStory.length}) via ${VERIFY_MODEL}`);
  for (const [id, rec] of pick) {
    const who = rec.name || id;
    const facts = {
      name: rec.name, rank: rec.rank?.current, highestRank: rec.highestRank,
      born: rec.bio?.find(b => b.k === 'Born')?.v || null, age: rec.vitals?.age ?? null,
      records: rec.records, specials: (rec.specials || []).map(s => ({ prize: s.en, count: s.count })),
    };
    const soft = { story: stripHtml(rec.story.html), bio: (rec.bio || []).map(b => `${b.k}: ${stripHtml(b.v)} [src:${b.src}]`), note: rec.records?.note || null };
    const ask = `You are an adversarial fact-checker for a sumo wrestler's dashboard. Below are the VERIFIED HARD FACTS (numbers, dates, ranks — treat these as ground truth) and the SOFT COPY (human-written prose the dashboard shows). Find only real problems in the SOFT COPY, judged against the hard facts:
- any claim the hard facts contradict or do not support (especially age-relative or count-relative claims, e.g. "won three cups before he was 22" when the dates/counts say otherwise),
- a soft/opinion claim stated as if it were a hard verified fact with no hedge,
- a macron on a romanized Japanese term (the house style forbids macrons),
- an obvious AI-writing tell (em dash as a connector, "delve", "tapestry", "it's not just X, it's Y").
Output STRICT JSON: {"findings":[{"severity":"BLOCK"|"WARN","issue":"<short>"}]}. BLOCK = a factual contradiction or a fabricated hard claim or a macron. WARN = style/tone only. If nothing is wrong, output {"findings":[]}. No prose outside the JSON.

HARD FACTS:
${JSON.stringify(facts)}

SOFT COPY:
${JSON.stringify(soft)}`;
    let data;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify({ model: VERIFY_MODEL, max_tokens: 400, messages: [{ role: 'user', content: ask }] }),
      });
      const text = await res.text();
      if (!res.ok) { warn(who, 'model-pass', `model call ${res.status} — soft copy not model-reviewed`); continue; }
      data = JSON.parse(text);
    } catch (e) { warn(who, 'model-pass', `model call error (${e.message}) — soft copy not model-reviewed`); continue; }
    const out = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    let parsed; try { parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch { warn(who, 'model-pass', `could not parse model reply: "${out.slice(0, 80)}"`); continue; }
    for (const f of (parsed.findings || [])) {
      if (String(f.severity).toUpperCase() === 'BLOCK') block(who, 'model-adversarial', f.issue);
      else warn(who, 'model-adversarial', f.issue);
    }
  }
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main(){
  console.log(`verify-rikishi-metrics: ${BASHO_LABEL} (${BASHO}) · in=${IN} · notion=${NOTION_TOKEN ? 'yes' : 'no'} · model=${ANTHROPIC_API_KEY ? 'yes' : 'no'}`);
  if (!existsSync(IN)) {
    // No metrics file = nothing to publish; not a failure (a fan run that didn't rebuild metrics leaves it absent).
    console.log(`  ${IN} not present — nothing to verify (dashboard data unchanged). PASS.`);
    process.exit(0);
  }
  let data;
  try { data = JSON.parse(readFileSync(IN, 'utf8')); }
  catch (e) { console.error(`FATAL: ${IN} is not valid JSON (${e.message}) — a corrupt metrics file must NOT publish.`); process.exit(1); }
  const records = Object.entries(data);
  if (!records.length) { console.error('FATAL: metrics file has zero records — refusing to publish an empty dashboard set.'); process.exit(1); }
  console.log(`  ${records.length} rikishi record(s) to verify`);

  // invariant + firewall + house-style checks (always)
  for (const [id, rec] of records) invariantChecks(id, rec);

  // source reconciliation (when Notion + sumo-api are reachable)
  if (NOTION_TOKEN) {
    const src = {};
    // independent Match Log crew tally
    try {
      const [ml, mr] = await Promise.all([queryAll(DB.matchLog), queryAll(DB.masterRikishi)]);
      const crewByMaster = new Map();
      for (const p of ml) {
        const w = rel1(p, 'Winner'), l = rel1(p, 'Loser');
        if (!w || !l) continue;
        const W = crewByMaster.get(w) || { w: 0, l: 0 }; W.w++; crewByMaster.set(w, W);
        const L = crewByMaster.get(l) || { w: 0, l: 0 }; L.l++; crewByMaster.set(l, L);
      }
      const masterIdByKey = new Map();
      for (const p of mr) { const nm = titleOf(p, 'Ring Name'); if (nm) masterIdByKey.set(nkey(nm), idNoDash(p.id)); }
      src.crewByMaster = crewByMaster; src.masterIdByKey = masterIdByKey;
      console.log(`  ✓ independent Match Log tally: ${crewByMaster.size} wrestlers, ${ml.length} rows`);
    } catch (e) {
      if (STRICT_SOURCE) { console.error(`FATAL: Notion pull failed under STRICT_SOURCE (${e.message})`); process.exit(1); }
      console.warn(`  ⚠️  Notion pull failed (${e.message}) — crew records not reconciled this run.`);
    }
    // sumo-api roster → per-wrestler career + peak (independent)
    const roster = await sourceRoster();
    if (roster.ok) {
      for (const [id, rec] of records) {
        const meta = roster.byKey.get(nkey(rec.name));
        if (!meta) { warn(rec.name || id, 'roster', 'not found in the sumo-api banzuke roster (name-key miss) — sumo-api figures not reconciled'); continue; }
        const [career, highest] = [await sourceCareer(meta.sumoId), await (async () => { await sleep(API_THROTTLE_MS); return sourceHighest(meta.sumoId); })()];
        await sleep(API_THROTTLE_MS);
        reconcile(id, rec, { career, highest, crewByMaster: src.crewByMaster, masterIdByKey: src.masterIdByKey });
      }
    } else {
      if (STRICT_SOURCE) { console.error('FATAL: sumo-api roster unreachable under STRICT_SOURCE'); process.exit(1); }
      console.warn('  ⚠️  sumo-api roster unreachable — career/peak not reconciled; running crew + invariant checks only.');
      // still reconcile crew (no sumo-api needed)
      for (const [id, rec] of records) reconcile(id, rec, { crewByMaster: src.crewByMaster, masterIdByKey: src.masterIdByKey });
    }
  } else {
    warn('(all)', 'no-notion', 'NOTION_TOKEN not set — ran invariant + house-style checks only (no source reconciliation). Set it in the Action to enable the full gate.');
  }

  // layer 2: adversarial model pass (optional)
  if (ANTHROPIC_API_KEY) { try { await modelPass(records); } catch (e) { warn('(all)', 'model-pass', `model layer errored (${e.message}) — deterministic gate still applied`); } }

  // ── report ─────────────────────────────────────────────────────────────────
  const blocks = findings.filter(f => f.sev === 'BLOCK');
  const warns = findings.filter(f => f.sev === 'WARN');
  console.log(`\n${'─'.repeat(60)}`);
  if (!findings.length) console.log('✅ PASS — every dashboard record reconciles to source and holds the invariants, firewall, and house style.');
  else {
    if (blocks.length) {
      console.log(`❌ ${blocks.length} BLOCKING exception(s) — rikishi-metrics.json must NOT publish:`);
      for (const f of blocks) console.log(`   ✗ [${f.who}] ${f.check}: ${f.detail}`);
    }
    if (warns.length) {
      console.log(`\n⚠️  ${warns.length} warning(s) (non-blocking, review):`);
      for (const f of warns) console.log(`   · [${f.who}] ${f.check}: ${f.detail}`);
    }
  }
  console.log(`${'─'.repeat(60)}`);
  console.log(`Result: ${blocks.length ? 'FAIL (' + blocks.length + ' blocking)' : 'PASS'}${warns.length ? ' · ' + warns.length + ' warning(s)' : ''}`);
  process.exit(blocks.length ? 1 : 0);
}

main().catch(e => { console.error('verify-rikishi-metrics crashed:', e); process.exit(1); });
