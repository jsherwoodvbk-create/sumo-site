// _engine.js — Gumbai's brain, minus the network.
// Pure logic: system prompt, the scoped query tools, the day-gate, and forgiving
// name resolution. No fetch, no secrets, so it's unit-testable with plain Node.
// The Function (gumbai.js) wires this to the Claude API.
//
// SCHEMA gumbai-snapshot/4: adds the soft-data lanes (days/injuries/catchphrases +
// per-bout nets). Every new lane is spoiler-gated here, the same discipline as bouts.

// ────────────────────────────────────────────────────────────────────────────
// DAY GATE — the structural spoiler guarantee.
// We build the gated view ONCE, server-side, before Claude is invoked. Every tool
// reads only from this gated view, so there is no code path by which a result past
// the viewer's day can reach the model. Banzuke/rikishi/kimarite are timeless; history
// and upcoming are never gated; bouts (and the nets riding them) filter by day; and the
// soft-data lanes each gate below.

// Injury conditions are the delicate lane: an injury/withdrawal is a spoiler, and the
// condition's TITLE and cause-track summaries can name future days (e.g. "played through
// to the yusho"). So: hide the whole condition until its onset day; filter the severity
// log to entries <= gate; and only expose the raw title, the terminal Status, and the
// three free-text cause tracks once the viewer is CAUGHT UP to the condition's latest
// logged day. Until then they get body-part + gated severity + status "ongoing".
// Bump this whenever the engine changes. Exposed at GET /api/gumbai so you can confirm, from a URL,
// exactly which engine is live (no more guessing whether a deploy took).
export const ENGINE_VERSION = 'gumbai-engine 2026-08-02 · champion-reveal + basho-complete + query_leaderboard';

function gateInjury(c, gate){
  const onset = Number.isInteger(c.onsetDay) ? c.onsetDay : (c.severity && c.severity[0] ? c.severity[0].day : 99);
  if(onset > gate) return null;                                   // not surfaced yet — fully hidden
  const sev = (c.severity || []).filter(e => e.day <= gate);      // each entry already day-scoped
  const asOfDay = sev.length ? Math.max(...sev.map(e => e.day)) : onset;
  const fullMax = Number.isInteger(c.fullMaxDay) ? c.fullMaxDay : asOfDay;
  const caughtUp = asOfDay >= fullMax;                            // no logged updates beyond the gate
  const base = {
    rikishi: c.rikishi || null,
    area: c.area || null,
    setting: c.setting || null,
    natureSticky: (c.nature || []).filter(n => /chronic|acute|suspected/i.test(n)),
    onsetDay: onset, asOfDay, caughtUp,
    severity: sev,
  };
  if(caughtUp){
    return {
      ...base,
      condition: c.condition || null,
      status: c.status || null,
      natureLive: (c.nature || []).filter(n => /flared|worsened/i.test(n)),
      officialReason: c.officialReason || null,   // a CLAIM, not truth
      boothRead: c.boothRead || null,
      scorekeeperEye: c.scorekeeperEye || null,   // Jennie's human eyewitness read
      source: c.source || [],
    };
  }
  return { ...base, status: 'ongoing', note: 'Later updates on this condition are past your day and not in view.' };
}

const FINAL_DAY = 15;   // an honbasho is 15 days; the yusho (playoff included) is settled on day 15.
export function gateSnapshot(snapshot, day, showFull){
  const ceiling = Number.isInteger(snapshot.meta?.maxDay) ? snapshot.meta.maxDay : 15;
  const gate = showFull ? ceiling : Math.max(0, Math.min(Number(day) || 0, ceiling));
  return {
    meta: { ...snapshot.meta },
    gate,
    showFull: !!showFull,
    rikishi: snapshot.rikishi,
    banzuke: snapshot.banzuke,
    kimarite: snapshot.kimarite,
    bouts: snapshot.bouts.filter(b => b.day <= gate),            // nets ride the bout, gated with it
    // ── soft-data lanes, each gated ──
    days: (snapshot.days || []).filter(d => d.day <= gate),
    injuries: (snapshot.injuries || []).map(c => gateInjury(c, gate)).filter(Boolean),
    catchphrases: (snapshot.catchphrases || []).map(cp => {
      if(!cp.days || !cp.days.length)
        return { phrase: cp.phrase, announcer: cp.announcer, count: null, timeless: true, giggle: cp.giggle ?? null, jewel: !!cp.jewel };
      const gd = cp.days.filter(d => d <= gate);
      if(!gd.length) return null;                                 // all its uses are past the gate
      return { phrase: cp.phrase, announcer: cp.announcer, count: gd.length, days: gd, giggle: cp.giggle ?? null, jewel: !!cp.jewel };
    }).filter(Boolean),
    // ── the current-basho yusho (champion) is itself a spoiler-gated RESULT ──
    // The yusho is decided ON the final day (day 15, playoff included), so it is revealed ONLY
    // when the basho is officially complete (snapshot.champion is set — the generator only fills it
    // from the sumo-api yusho, which is empty until the tournament is over) AND this viewer is caught
    // up to that final day. Mid-basho, or a viewer not yet through day 15, sees null: undecided in-view.
    // Same discipline, same source of truth, as the standings page's Emperor's Cup reveal.
    champion: (snapshot.champion && gate >= FINAL_DAY) ? snapshot.champion : null,
    // never gated:
    history: snapshot.history || null,
    upcoming: snapshot.upcoming || null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// NAME RESOLUTION — forgiving by design (exact / nickname / substring / fuzzy).
const NUMWORDS = {zero:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',ten:'10'};
const norm = s => String(s||'').toLowerCase()
  .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, m=>NUMWORDS[m])
  .replace(/[^a-z0-9]/g,'');

function editDistance(a,b){
  a=norm(a); b=norm(b);
  const m=a.length,n=b.length;
  if(!m) return n; if(!n) return m;
  let prev=Array.from({length:n+1},(_,i)=>i), cur=new Array(n+1);
  for(let i=1;i<=m;i++){
    cur[0]=i;
    for(let j=1;j<=n;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      cur[j]=Math.min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost);
    }
    [prev,cur]=[cur,prev];
  }
  return prev[n];
}

export function resolveName(query, rikishi){
  const q = norm(query);
  if(!q) return { name:null, matched:null, near:[] };
  const aliases = [];
  for(const r of rikishi){
    aliases.push({ key: norm(r.name), name: r.name, via: r.name, kind:'shikona' });
    for(const nk of (r.nicknames||[]))
      aliases.push({ key: norm(nk.nick), name: r.name, via: nk.nick, kind: nk.tag==='O'?'crew nickname':'nickname' });
  }
  let hit = aliases.find(a => a.key === q);
  if(hit) return { name: hit.name, matched: hit.via, how: hit.kind, near:[] };
  const contains = aliases.filter(a => a.key.length>=3 && (q.includes(a.key) || a.key.includes(q)));
  if(contains.length===1) return { name: contains[0].name, matched: contains[0].via, how:'partial: '+contains[0].kind, near:[] };
  if(contains.length>1){
    contains.sort((a,b)=> b.key.length - a.key.length);
    const uniq=[...new Set(contains.map(c=>c.name))];
    if(uniq.length===1) return { name: contains[0].name, matched: contains[0].via, how:'partial: '+contains[0].kind, near:[] };
  }
  let best=null;
  for(const a of aliases){
    const d = editDistance(q, a.key);
    const tol = Math.max(2, Math.floor(Math.max(q.length, a.key.length) * 0.34));
    if(d <= tol && (!best || d < best.d)) best={ ...a, d };
  }
  if(best) return { name: best.name, matched: best.via, how:'fuzzy: '+best.kind, near:[] };
  const near = rikishi.map(r => ({ name:r.name, d: editDistance(q, r.name) }))
    .sort((a,b)=>a.d-b.d).slice(0,4).map(x=>x.name);
  return { name:null, matched:null, near };
}

// ────────────────────────────────────────────────────────────────────────────
// DERIVED-STAT HELPERS — computed over the GATED bouts, so always spoiler-safe.
function ageFrom(bd){
  if(!bd) return null;
  const b=new Date(bd); if(isNaN(b)) return null;
  const n=new Date();
  let a=n.getUTCFullYear()-b.getUTCFullYear();
  const m=n.getUTCMonth()-b.getUTCMonth();
  if(m<0||(m===0&&n.getUTCDate()<b.getUTCDate())) a--;
  return (a>=0&&a<100)?a:null;
}
function summarize(name, bouts){
  const mine = bouts.filter(b => b.winner===name || b.loser===name);
  const wins = mine.filter(b => b.winner===name);
  const losses = mine.filter(b => b.loser===name);
  const byKimarite = {};
  for(const b of wins){ const k=b.kimarite||'unknown'; byKimarite[k]=(byKimarite[k]||0)+1; }
  const lostByKimarite = {};
  for(const b of losses){ const k=b.kimarite||'unknown'; lostByKimarite[k]=(lostByKimarite[k]||0)+1; }
  return {
    record: `${wins.length}-${losses.length}`,
    wins: wins.length, losses: losses.length, bouts: mine.length,
    winsByKimarite: byKimarite, lossesByKimarite: lostByKimarite,
    goldStarWins: wins.filter(b=>b.goldStar).length,
  };
}

// ── HISTORY HELPERS — past basho (Jan 2025 onward). NEVER gated. ──
function historyBashoList(gated){
  const h = gated.history && gated.history.basho; if(!h) return [];
  return Object.keys(h).sort().map(code => ({ code, ...h[code] }));
}
function careerFor(name, gated){
  const perBasho=[]; let hw=0, hl=0; const yusho=[];
  for(const b of historyBashoList(gated)){
    const r=(b.rikishi||[]).find(x=>x.name===name);
    if(r){ hw+=r.wins; hl+=r.losses; perBasho.push({ basho:b.label, rank:r.rank, record:`${r.wins}-${r.losses}` }); }
    if((b.yusho||[]).includes(name)) yusho.push(b.label);
  }
  const cur=summarize(name, gated.bouts);
  const curBz=gated.banzuke.find(x=>x.name===name);
  // "Basho complete" is a fact about the DAY, not about who won: once the viewer is caught up to the
  // final day (gate >= 15, so day 15 is logged and watched), EVERY wrestler's current record is FINAL,
  // champion or not. That is what tells Gumbai the basho is over. The yusho on top of that is only for
  // whoever actually won it (champion in view). Before day 15, it's genuinely in progress.
  const bashoComplete = gated.gate >= FINAL_DAY;
  const wonCurrent = !!(gated.champion && gated.champion.name===name);
  const curLabel = (gated.meta&&gated.meta.basho)||'current';
  if(wonCurrent) yusho.push(curLabel);
  if(cur.bouts>0) perBasho.push({ basho:curLabel, rank:curBz?curBz.rank:null, record:cur.record,
    ...(bashoComplete
        ? { final:true, ...(wonCurrent ? { yusho:true, playoff: !!gated.champion.playoff } : {}) }
        : { inProgress:true }) });
  return {
    name,
    bashoComplete,
    sinceTracking:{ record:`${hw+cur.wins}-${hl+cur.losses}`, wins:hw+cur.wins, losses:hl+cur.losses,
      note: bashoComplete
        ? 'since the crew got into sumo (Jan 2025); the current basho is COMPLETE in your view and fully counted (no "in progress" caveat needed)'
        : 'since the crew got into sumo (Jan 2025); the current basho counts only through your gated day' },
    yushoCount:yusho.length, yusho, perBasho,
  };
}
function historyH2H(a, b, gated){
  let aw=0, bw=0; const meetings=[];
  for(const bb of historyBashoList(gated)) for(const x of (bb.bouts||[])){
    if((x.winner===a&&x.loser===b)||(x.winner===b&&x.loser===a)){
      if(x.winner===a) aw++; else bw++;
      meetings.push({ basho:bb.label, day:x.day, winner:x.winner, kimarite:x.kimarite });
    }
  }
  return { [a]:aw, [b]:bw, meetings:meetings.length, bouts:meetings };
}

// ────────────────────────────────────────────────────────────────────────────
// THE TOOLS Claude may call. All read the gated view; none can see past the gate.
export const TOOLS = [
  {
    name: 'query_rikishi',
    description: "Look up one wrestler's profile: current rank & weight, country, age/birthday, height, highest rank, the crew's nicknames, the meaning of their shikona, their mawashi (belt) color, and any injury/condition the crew has logged this basho (spoiler-gated to your day, 3 provenance tracks kept separate). Accepts a shikona OR nickname OR mangled/voice-to-text spelling. Use for 'who is X', 'where's X from', 'is X hurt', 'what does X's name mean', 'how tall/old is X'.",
    input_schema: { type:'object', properties:{ name:{type:'string'} }, required:['name'] }
  },
  {
    name: 'query_banzuke',
    description: "Return the current tournament ranking (banzuke): wrestlers with rank and weight. Optional rankTier filters to a band ('Yokozuna','Ozeki','Sekiwake','Komusubi','sanyaku', or 'Maegashira'). Set before the tournament, so never a spoiler.",
    input_schema: { type:'object', properties:{ rankTier:{type:'string'} } }
  },
  {
    name: 'query_match_log',
    description: "Query the bout record for THIS tournament (spoiler-gated to your day). Filter by rikishi, opponent (for a head-to-head), a day or day range, kimarite, or flags: goldStarOnly (kinboshi), henkaOnly, monoiiOnly (drew a judges' conference), boutOfDayOnly (booth's pick of the day). Each bout also carries observed COLOR the booth added: bout-of-the-day, conduct tags + note, match length bucket, cushions thrown, rematch. When a single rikishi is given, also returns a computed win-loss summary. Use for records, head-to-heads, 'who beat X', 'how did X win', kinboshi, 'what happened on day N', 'any henka', 'bout of the day'.",
    input_schema: { type:'object', properties:{
      rikishi:{type:'string'}, opponent:{type:'string'},
      day:{type:'integer'}, dayFrom:{type:'integer'}, dayTo:{type:'integer'},
      kimarite:{type:'string'},
      goldStarOnly:{type:'boolean'}, henkaOnly:{type:'boolean'}, monoiiOnly:{type:'boolean'}, boutOfDayOnly:{type:'boolean'}
    } }
  },
  {
    name: 'query_kimarite',
    description: "Look up a kimarite (winning technique) in the glossary: its English gloss and how the move works. Omit name to list all. Timeless reference, never a spoiler.",
    input_schema: { type:'object', properties:{ name:{type:'string'} } }
  },
  {
    name: 'query_standings',
    description: "The current win-loss standings, gated to your day: every wrestler's W-L, sorted best-first, with rank and wins-behind-leader. Use for the championship picture; ground all race talk in these ACTUAL records and gaps, never rank alone.",
    input_schema: { type:'object', properties:{ top:{type:'integer'} } }
  },
  {
    name: 'query_career',
    description: "A wrestler's record across the tracked era (since Jan 2025): total W-L, record and rank basho-by-basho, yusho count. Current basho only through your gated day; past basho are never spoilers.",
    input_schema: { type:'object', properties:{ name:{type:'string'} }, required:['name'] }
  },
  {
    name: 'query_yusho',
    description: "Championship (yusho) history since Jan 2025. With a name: which basho that wrestler won + title count. Without: the champion of each past basho. The CURRENT basho's title is included ONLY once the viewer is caught up to the final day of a completed basho (spoiler-gated); until then it reads as undecided-in-view. Trust the tool's currentBasho / currentBashoInView fields — do not refuse to name a champion the tool has handed you.",
    input_schema: { type:'object', properties:{ name:{type:'string'} } }
  },
  {
    name: 'query_leaderboard',
    description: "Cross-wrestler win-loss leaderboard SUMMED over a whole calendar year (or all tracked time), ranked best-first. This is the tool for 'who had the best record in 2025', 'most wins in 2026 so far', 'top records this year', 'year-to-date leader'. Adds up each wrestler's W-L across every tracked basho in that year (makuuchi, since Jan 2025) and ranks by total wins (win pct breaks ties). A completed year (e.g. 2025) is exact; a current year includes the in-progress basho only through the viewer's gated day (flagged). Optional: year (e.g. 2025; defaults to all tracked), top (limit the list).",
    input_schema: { type:'object', properties:{ year:{type:'integer'}, top:{type:'integer'} } }
  },
  {
    name: 'query_upcoming',
    description: "The NEXT day's scheduled card (torikumi): who is slated to fight whom. Optional name filters to one wrestler. UPCOMING matchups have NO results, so they are NOT spoilers and are safe to share in full, even for a viewer behind on their days. Returns available:false when the next card is not posted yet or the basho is over.",
    input_schema: { type:'object', properties:{ name:{type:'string'} } }
  },
  {
    name: 'query_condition',
    description: "The crew's injury / condition board for THIS basho (spoiler-gated to your day). With a name: that wrestler's logged condition. Without: everyone currently carrying something in-view ('who's hurt', 'the DL'). Each condition keeps THREE separate provenance tracks that must never be merged: officialReason (a stated CLAIM, not truth), boothRead (announcer speculation), scorekeeperEye (Jennie's firsthand video read). A day-stamped severity log shows how it progressed through your day. If a condition is not yet caught up to its latest note, the arc-level detail is withheld and status shows 'ongoing'. Use for 'is X hurt', 'who's on the DL', 'what's wrong with X', 'who withdrew'.",
    input_schema: { type:'object', properties:{ name:{type:'string'} } }
  },
  {
    name: 'query_storylines',
    description: "The day's narrative color for THIS basho (spoiler-gated to your day): the storyline arcs the crew logged, plus the scorekeeper's own day-notes (Jennie's human take) and which announcer called that day. Optional day filters to one day. This is COLOR, not results; hedge any standings/leaderboard claim against query_standings. Use for 'what was the story on day N', 'what happened this basho', 'any drama'.",
    input_schema: { type:'object', properties:{ day:{type:'integer'} } }
  },
  {
    name: 'query_catchphrases',
    description: "The announcer catchphrase counter for THIS basho (spoiler-gated to your day). Optional announcer filters to one voice. Returns each phrase with the count of days it was heard THROUGH your day. IMPORTANT: the table under-captures, so every count is a FLOOR ('at least N'), never 'his most-used'. A giggle score (1-5) and a jewel flag are the crew's own human favorites and are sparse. Fun booth-personality color, never a result. Use for 'what does X always say', 'catchphrases', 'the announcers'.",
    input_schema: { type:'object', properties:{ announcer:{type:'string'} } }
  }
];

export function runTool(toolName, input, gated){
  input = input || {};
  switch(toolName){
    case 'query_rikishi': {
      const res = resolveName(input.name, gated.rikishi);
      if(!res.name) return { found:false, note:`No confident match for "${input.name}".`, didYouMean: res.near };
      const r = gated.rikishi.find(x=>x.name===res.name);
      const bz = gated.banzuke.find(x=>x.name===res.name);
      const conditions = (gated.injuries||[]).filter(c => c.rikishi===res.name);
      return {
        found:true, resolvedFrom: res.matched, resolvedHow: res.how,
        name: r.name,
        currentRank: bz ? bz.rank : (r.highestRank ? `(not in this banzuke; highest reached ${r.highestRank})` : null),
        weightKg: bz ? bz.weightKg : null,
        country: r.country ?? null,
        birthday: r.birthday ?? null,
        age: ageFrom(r.birthday),
        heightCm: r.heightCm ?? null,
        highestRank: r.highestRank ?? null,
        mawashi: r.mawashi ?? null,
        nicknames: (r.nicknames||[]).map(n=>({ nick:n.nick, kind:n.tag==='O'?'crew':'official' })),
        conditions: conditions.length ? conditions : null,      // gated 3-track condition(s), if any in view
        injuryNote: r.injuryNotes ?? null,                      // free-text master-data note (secondary)
        shikonaMeaning: r.shikonaMeaning ?? null,
      };
    }
    case 'query_banzuke': {
      let list = gated.banzuke.slice();
      const tier = (input.rankTier||'').toLowerCase();
      const isSanyaku = r => /^(Yokozuna|Ozeki|Sekiwake|Komusubi)/.test(r.rank);
      if(tier==='sanyaku') list = list.filter(isSanyaku);
      else if(tier) list = list.filter(r => r.rank.toLowerCase().startsWith(tier.slice(0,4)));
      return { count:list.length, ranking:list.map(r=>({ name:r.name, rank:r.rank, weightKg:r.weightKg })) };
    }
    case 'query_match_log': {
      let bouts = gated.bouts.slice();
      let focus=null, opp=null;
      if(input.rikishi){ const r=resolveName(input.rikishi, gated.rikishi); if(!r.name) return { found:false, note:`No match for "${input.rikishi}".`, didYouMean:r.near }; focus=r.name; }
      if(input.opponent){ const o=resolveName(input.opponent, gated.rikishi); if(!o.name) return { found:false, note:`No match for opponent "${input.opponent}".`, didYouMean:o.near }; opp=o.name; }
      if(focus) bouts = bouts.filter(b=> b.winner===focus || b.loser===focus);
      if(opp)   bouts = bouts.filter(b=> b.winner===opp || b.loser===opp);
      if(Number.isInteger(input.day)) bouts = bouts.filter(b=> b.day===input.day);
      if(Number.isInteger(input.dayFrom)) bouts = bouts.filter(b=> b.day>=input.dayFrom);
      if(Number.isInteger(input.dayTo))   bouts = bouts.filter(b=> b.day<=input.dayTo);
      if(input.kimarite) bouts = bouts.filter(b=> String(b.kimarite||'').toLowerCase()===String(input.kimarite).toLowerCase());
      if(input.goldStarOnly) bouts = bouts.filter(b=> b.goldStar);
      if(input.henkaOnly)    bouts = bouts.filter(b=> b.henka);
      if(input.monoiiOnly)   bouts = bouts.filter(b=> b.monoii);
      if(input.boutOfDayOnly) bouts = bouts.filter(b=> b.boutOfDay);
      const out = {
        gateDay: gated.gate, showFull: gated.showFull, count: bouts.length,
        bouts: bouts.map(b=>({
          day:b.day, date:b.date, winner:b.winner, loser:b.loser, kimarite:b.kimarite,
          goldStar:!!b.goldStar, henka:b.henka||null, monoii:b.monoii||null,
          boutOfDay:b.boutOfDay||null, conduct:b.conduct&&b.conduct.length?b.conduct:null,
          conductNote:b.conductNote||null, length:b.length||null, cushions:!!b.cushions, rematch:!!b.rematch,
        })),
      };
      if(focus) out.summary = { forRikishi: focus, ...summarize(focus, gated.bouts.filter(b=> !opp || b.winner===opp || b.loser===opp || b.winner===focus || b.loser===focus)) };
      if(focus && opp){
        const h2h = gated.bouts.filter(b=> (b.winner===focus&&b.loser===opp)||(b.winner===opp&&b.loser===focus));
        out.headToHead = { [focus]: h2h.filter(b=>b.winner===focus).length, [opp]: h2h.filter(b=>b.winner===opp).length, meetings:h2h.length, note:'this basho only' };
        out.historicalHeadToHead = { ...historyH2H(focus, opp, gated), note:'past basho since Jan 2025 (add to headToHead for the full rivalry)' };
      }
      return out;
    }
    case 'query_kimarite': {
      if(!input.name) return { count: gated.kimarite.length, kimarite: gated.kimarite };
      const q = norm(input.name);
      const entry = (gated.kimarite||[]).find(k => norm(k.name||k.kimarite||k.term)===q)
                 || (gated.kimarite||[]).find(k => norm(JSON.stringify(k)).includes(q));
      return entry ? { found:true, kimarite: entry } : { found:false, note:`"${input.name}" not in the kimarite glossary.` };
    }
    case 'query_standings': {
      const rows = gated.rikishi.map(r=>{
        const s = summarize(r.name, gated.bouts);
        const bz = gated.banzuke.find(x=>x.name===r.name);
        return { name:r.name, rank: bz?bz.rank:(r.highestRank||null), wins:s.wins, losses:s.losses, record:s.record, bouts:s.bouts };
      }).filter(x=>x.bouts>0).sort((a,b)=> b.wins-a.wins || a.losses-b.losses || a.name.localeCompare(b.name));
      const leaderWins = rows.length ? rows[0].wins : 0;
      const withGap = rows.map(x=>({ ...x, winsBehindLeader: leaderWins - x.wins }));
      const list = Number.isInteger(input.top) ? withGap.slice(0, input.top) : withGap;
      return { throughDay: gated.gate, daysRemaining: Math.max(0, 15 - gated.gate), leaderWins, standings: list };
    }
    case 'query_career': {
      const res = resolveName(input.name, gated.rikishi);
      const name = res.name || input.name;
      const c = careerFor(name, gated);
      if(!c.perBasho.length) return { found:false, note:`No tracked record for "${input.name}" since Jan 2025.`, didYouMean: res.near };
      return { found:true, resolvedFrom: res.matched || null, ...c };
    }
    case 'query_yusho': {
      const list = historyBashoList(gated).reverse();
      const curLabel = (gated.meta && gated.meta.basho) || 'current';
      // The current basho's champion is revealed ONLY when it is in view (basho complete AND the
      // viewer is caught up to the final day — gateSnapshot handles that). When it is, treat it as
      // the most-recent, decided yusho. Otherwise it is honestly undecided-in-view.
      const champ = gated.champion || null;
      if(input.name){
        const res = resolveName(input.name, gated.rikishi); const name = res.name || input.name;
        const won = list.filter(b => (b.yusho||[]).includes(name)).map(b=>b.label);
        const wonCurrent = !!(champ && champ.name===name);
        if(wonCurrent) won.unshift(curLabel + (champ.playoff ? ' (playoff)' : ''));
        return { name, yushoCount: won.length, yusho: won,
          currentBasho: wonCurrent
            ? { basho: curLabel, result:'won', playoff: !!champ.playoff, note:'decided — you are caught up to the final day' }
            : { basho: curLabel, result: champ ? 'won by someone else' : 'undecided in your view' },
          note:'since Jan 2025, most recent first.' };
      }
      const champions = [];
      if(champ) champions.push({ basho: curLabel, yusho:[champ.name], playoff: !!champ.playoff, note:'this basho — decided, you are caught up to the final day' });
      for(const b of list) champions.push({ basho:b.label, yusho:(b.yusho||[]) });
      return { champions,
        currentBashoInView: !!champ,
        note: champ
          ? 'most recent first; this basho\'s yusho is decided and in your view.'
          : 'past basho since Jan 2025, most recent first; the current basho is undecided in your view (not yet caught up to the final day, or still in progress).' };
    }
    case 'query_leaderboard': {
      // Year-spanning, cross-wrestler W-L sum + ranking. History (past basho) is never gated; the
      // current basho contributes ONLY its gated portion (through the viewer's day), and is flagged.
      const year = Number.isInteger(input.year) ? input.year : null;
      const bashoYear = b => {
        const c = String(b.code || '');
        if(/^\d{6}$/.test(c)) return +c.slice(0,4);
        const m = String(b.label || '').match(/(20\d{2})/); return m ? +m[1] : null;
      };
      const tally = new Map();
      const bump = (name, w, l, won) => {
        const t = tally.get(name) || { name, wins:0, losses:0, basho:0, yusho:0 };
        t.wins += (w||0); t.losses += (l||0); t.basho += 1; if(won) t.yusho += 1; tally.set(name, t);
      };
      const bashosCounted = [];
      for(const b of historyBashoList(gated)){
        if(year != null && bashoYear(b) !== year) continue;
        bashosCounted.push(b.label);
        for(const r of (b.rikishi || [])) bump(r.name, r.wins, r.losses, (b.yusho||[]).includes(r.name));
      }
      // fold in the current basho if it falls in the requested year (gated — partial until day 15)
      let currentBasho = null;
      const curYear = (() => {
        const c = String((gated.meta && gated.meta.bashoId) || '');
        if(/^\d{6}$/.test(c)) return +c.slice(0,4);
        const m = String((gated.meta && gated.meta.basho) || '').match(/(20\d{2})/); return m ? +m[1] : null;
      })();
      if(year == null || curYear === year){
        let counted = false;
        for(const r of gated.rikishi){
          const s = summarize(r.name, gated.bouts);
          if(s.bouts > 0){ bump(r.name, s.wins, s.losses, !!(gated.champion && gated.champion.name===r.name)); counted = true; }
        }
        if(counted) currentBasho = { basho:(gated.meta && gated.meta.basho) || 'current',
          throughDay: gated.gate, complete: gated.gate >= FINAL_DAY };
      }
      const rows = [...tally.values()].map(t => ({
        ...t, record:`${t.wins}-${t.losses}`,
        winPct: (t.wins + t.losses) ? +(t.wins / (t.wins + t.losses)).toFixed(3) : 0,
      })).sort((a,b) => b.wins - a.wins || b.winPct - a.winPct || a.losses - b.losses || a.name.localeCompare(b.name));
      if(!rows.length) return { found:false, year: year || 'all tracked',
        note: year ? `No tracked basho for ${year} yet (we track makuuchi from Jan 2025 on).` : 'No tracked records yet.' };
      const leaderboard = Number.isInteger(input.top) ? rows.slice(0, input.top) : rows;
      return { found:true, year: year || 'all tracked (Jan 2025 on)', bashosCounted, currentBasho,
        count: rows.length, leaderboard,
        note: 'Makuuchi wins summed across the year, most wins first (win pct breaks ties). A completed year is exact; a current year includes the in-progress basho only through your gated day (see currentBasho).' };
    }
    case 'query_upcoming': {
      const u = gated.upcoming;
      if(!u || u.empty || !Array.isArray(u.matchups) || !u.matchups.length){
        return { available:false, note: (u && u.day)
          ? `The Day ${u.day} card is not posted yet — sumo is scheduled one day at a time, so it lands the evening before.`
          : 'No upcoming card right now (the basho may be over, or the next card is not out yet).' };
      }
      let matchups = u.matchups, filteredFor = null;
      if(input.name){
        const res = resolveName(input.name, gated.rikishi);
        filteredFor = res.name || input.name;
        const nm = norm(filteredFor);
        matchups = matchups.filter(m => norm(m.eastName)===nm || norm(m.westName)===nm);
        if(!matchups.length) return { available:true, day:u.day, date:u.date, forRikishi:filteredFor, found:false,
          note:`${filteredFor} is not on the Day ${u.day} card (sitting out, or double-check the name).`, didYouMean: res.near };
      }
      return {
        available:true, resultFree:true, day:u.day, date:u.date, forRikishi:filteredFor, count: matchups.length,
        matchups: matchups.map(m=>({ east:m.eastName, eastRank:m.eastRank, west:m.westName, westRank:m.westRank })),
        note:'Upcoming matchups only, no results attached. NEVER a spoiler. Safe to share in full.',
      };
    }
    case 'query_condition': {
      const all = gated.injuries || [];
      if(input.name){
        const res = resolveName(input.name, gated.rikishi);
        const name = res.name || input.name;
        const mine = all.filter(c => c.rikishi===name);
        if(!mine.length) return { found:false, forRikishi:name, note:`Nothing logged for ${name} through day ${gated.gate} (either healthy, or any condition surfaced after your day).`, didYouMean: res.near };
        return { found:true, forRikishi:name, throughDay: gated.gate, conditions: mine,
          note:'Three provenance tracks (official / booth / scorekeeper) are separate on purpose. Official reason is a CLAIM, not a verdict; scorekeeper eye is Jennie\'s firsthand read. Never merge them into one cause.' };
      }
      return { throughDay: gated.gate, count: all.length, conditions: all,
        note:'Everyone carrying something in-view. Official reason is a stated claim, not truth; keep the three tracks separate.' };
    }
    case 'query_storylines': {
      let list = (gated.days||[]).slice();
      if(Number.isInteger(input.day)) list = list.filter(d => d.day===input.day);
      if(!list.length) return { found:false, throughDay: gated.gate, note: Number.isInteger(input.day) ? `Day ${input.day} is not in your view yet (or has no logged storyline).` : 'No storylines logged in your view yet.' };
      return { found:true, throughDay: gated.gate, count:list.length,
        days: list.map(d=>({ day:d.day, announcer:d.announcer||null, storylines:d.storylines||null, scorekeeperNotes:d.scorekeeperNotes||null })),
        note:'Color, not results. Scorekeeper notes are Jennie\'s own take. Hedge any standings/leaderboard claim against query_standings, which is the truth.' };
    }
    case 'query_catchphrases': {
      let list = (gated.catchphrases||[]).slice();
      if(input.announcer){
        const a = norm(input.announcer);
        const matched = list.filter(c => norm(c.announcer||'').includes(a) || a.includes(norm(c.announcer||'')));
        if(matched.length) list = matched;
      }
      list.sort((x,y)=> (y.count||0) - (x.count||0));
      return { throughDay: gated.gate, count:list.length,
        phrases: list.map(c=>({ phrase:c.phrase, announcer:c.announcer||null, daysHeard:c.count, timeless:!!c.timeless, giggle:c.giggle??null, jewel:!!c.jewel })),
        note:'Counts are a FLOOR (at least N days) — the table under-captures, so never claim "his most-used." Giggle (1-5) and jewel are the crew\'s sparse human favorites. Pure booth-personality fun.' };
    }
    default:
      return { error:`unknown tool ${toolName}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — identity, voice, the two lanes, spoiler discipline, tool rules.
// No em dashes / markdown (the model mirrors what it is shown; the chat renders raw).
export function buildSystemPrompt(gated){
  const roster = gated.rikishi.map(r=>{
    const nicks=(r.nicknames||[]).map(n=>`${n.nick}(${n.tag})`).join(', ');
    return `- ${r.name}${nicks?` [${nicks}]`:''}`;
  }).join('\n');
  const full = gated.showFull ? ', full-results view is ON for this question' : '';

  return `You are Gumbai, the sumo oracle for a small crew of friends (Jennie, MJ, Sherry, and James) who follow makuuchi sumo together on their site "Salt Stats & Sumo." Your name comes from the gunbai, the referee's war-paddle. The crew says it "Gumbai," which is how the word actually sounds (an n before a b softens to an m). You are also their AI competitor in the banzuke-prediction game: when you forecast, you forecast as Gumbai and your pick stands on the leaderboard next to theirs.

WHY YOU EXIST: a generic chatbot answers sumo questions from stale training memory and gets current facts confidently wrong. You don't. You answer from the CREW'S OWN VERIFIED DATA through your tools. Grounded, not remembered.

TWO LANES, the bright line.
LANE 1 is facts, stats, and current state: records, ranks, countries, matchups, who beat whom, kinboshi, kimarite, standings, injuries, derived stats. Answer these ONLY from tool results. Call a tool. Never answer a Lane 1 question from memory, never guess. If the tools don't have it, say so plainly ("I don't have that in our data") and offer what you DO have. A wrong "fact" is worse than an honest "don't have it."
LANE 2 is context, culture, history, meaning, and health: what a shikona means, salt-throwing and topknot lore, sumo history, a wrestler's background, injury or head-trauma science, "why do they do X." Draw on general sumo knowledge here, flagged lightly as background ("generally...", "as background..."). Follow the rabbit hole. For anything with no sumo connection, warmly say what you can help with.
LANES BLEND: pair a logged fact with general context. For health or medical, frame it as general understanding, not medical advice.

SOFT DATA is color, never truth. Alongside results you now have observed COLOR from the broadcast: match nets (bout-of-the-day, conduct, henka, monoii, match length, cushions), day storylines, an injury/condition board, and announcer catchphrases. Hard rules for it:
- Results are truth; color sits on top. A storyline or a booth read never overrides or restates a result. When they ever disagree, the result wins.
- INJURIES carry THREE separate tracks and you must NEVER collapse them into one cause: officialReason is a STATED CLAIM (say "officially cited as...," never "he is out because..."), boothRead is announcer speculation (hedge it), scorekeeperEye is Jennie's firsthand video read (attribute it as her human observation, not fact). The showcase case: an official "knee" versus an observed "head" read both exist, and you pick NEITHER as the reason.
- SCOREKEEPER anything (scorekeeper eye, scorekeeper notes) is Jennie's own human read. Always attribute it as such ("the scorekeeper's read was..."), never as booth or official fact.
- CATCHPHRASE counts are a FLOOR, not a total ("at least N days"); the table under-captures, so never say "his most-used phrase."
- MATCH LENGTH is an observed bucket, not a stopwatch ("a quick one," "a long grind"), never "it lasted 2 minutes."
- STORYLINES are color; hedge any standings or tie claim against query_standings, which is the truth.
- If any field reads like an unconfirmed guess, hedge hard or stay silent; never state an unconfirmed item as fact.

SPOILER SAFETY, absolute. The crew watches on delay, each at their own pace. Your tools already return ONLY what happened through the day this viewer is allowed to see (currently day ${gated.gate}${full}) — bouts AND all soft data (storylines, injuries, catchphrases) are gated the same way. NEVER reveal or reason from anything beyond that, and NEVER pull a current result from memory. If a condition or storyline is not in view, it has not happened for them yet. Timeless facts (country, height, shikona meaning, the banzuke, history) are never spoilers. UPCOMING matchups (query_upcoming) carry no results, so they are never spoilers; hand the whole card over freely.

GROUNDING THE RACE: for anything about the championship, call query_standings and reason from the ACTUAL records, the gap to the leader, and days remaining. Do not write anyone off by rank alone. For eve-of-day questions ("can X still win," playoff scenarios) pull query_standings AND query_upcoming and lay out the if/then. That is analysis, not a spoiler.

THE YUSHO (who won the basho) IS ANSWERABLE once the viewer is caught up. The championship is decided on the final day (day 15, playoff included). The DATA already enforces this: query_yusho and query_career reveal the current basho's champion ONLY when the viewer has watched through the final day of a completed basho, and stay silent otherwise. So TRUST THE TOOL: if query_yusho hands you a current-basho champion (currentBashoInView true, or a currentBasho result of "won"), that viewer HAS seen it, and you name the winner plainly and celebrate it. Do NOT invent a rule that the yusho is "never confirmable" or that it is "kept undecided in-view" when the tool has already given it to you. Only when the tool says undecided-in-view do you say you can't call it yet. A 12-3 (or any) final record is the regular schedule; the cup itself comes from query_yusho, so lean on that tool for the crown, not the raw record.

BASHO OVER vs IN PROGRESS: this is about the DAY, not the winner. When a tool marks the current basho complete (query_career returns bashoComplete true or a perBasho entry with final:true; standings show day 15 with 0 days remaining), the tournament is OVER for this viewer and every record in it is FINAL. Say so plainly, and do NOT tack on "in progress," "through your day," or "not final yet" caveats to that basho's numbers. Only add the in-progress caveat when the tool actually still marks it inProgress (viewer not yet through day 15). A wrestler can finish a completed basho without winning it: "Nagoya's done, he ended 7-7" is correct and is NOT the same as naming the champion.

VOICE: talk like an American sumo enthusiast texting the group chat mid-tournament: warm, hyped, a little funny, exclamation points, the occasional emoji. Short and punchy by default, deeper when someone is curious. Use the crew's nicknames. Gloss sumo terms in plain English.
WRITE LIKE A REAL PERSON, NOT AN AI. Hard rules: NO em dashes ever (use a period, comma, or parentheses). NO markdown at all (the chat prints raw, so asterisks and pound signs show up literally). For emphasis use CAPS or an exclamation point. NO filler ("Great question," "It's worth noting," "That said"). Contractions, plain words. BE BRIEF but FUN: default 2 to 4 sentences, a simple lookup is one or two; only go long or list when they EXPLICITLY ask. Cut padding, keep the personality.

HARD DON'TS: never curse. Never push Japanese-language learning (a standing crew boundary). Never go stiff or corporate. Never lecture. NEVER offer or tease a follow-up you can't actually deliver from a tool. Before you say "want me to pull X," be sure X is something a tool returns. When you're riffing on lore (Lane 2), do NOT imply the crew's data holds a stat it doesn't — there is no salt-throw distance, no "biggest salt thrower," etc. Only offer follow-ups you can genuinely produce.

TOOLS: query_rikishi, query_banzuke, query_match_log, query_standings, query_kimarite, query_career, query_yusho, query_leaderboard, query_upcoming, query_condition, query_storylines, query_catchphrases. For ANY Lane 1 question call the relevant tool before answering. For "is X hurt / who's on the DL" use query_condition (keep the 3 tracks separate). For "what was the story / any drama" use query_storylines. For "what does X always say / catchphrases" use query_catchphrases (counts are a floor). For ONE wrestler's history use query_career; for who WON a basho use query_yusho. For a cross-wrestler YEAR total or "who had the best record / most wins in 2025 / 2026 so far / this year," use query_leaderboard (it sums and ranks for you — do NOT say you can't total a year). Name resolution is forgiving, but if a tool returns didYouMean, ask which wrestler they meant rather than guessing. When a tool hands you a computed number, quote it directly.

HONESTY: our data spans Jan 2025 to the present, across many bashos. A date or year INSIDE that window (2025, 2026, any basho since) IS covered, so recognize it and answer. Never imply an in-window date is out of range. You now HAVE a year leaderboard: "who had the best record in 2025," "most wins in 2026 so far," "top records this year" all go to query_leaderboard, which sums and ranks across the year — so answer them for real, do not deflect or claim you can't total a year. A completed year (2025) is exact; the current year includes the in-progress basho only through the viewer's gated day, so flag that ("2026 so far, through your day"). If a specific cut genuinely isn't something any tool produces, say what you CAN give instead and frame it as a slice, never as the date being unavailable. The ONLY true edge is before Jan 2025, which is honestly outside what we track. Never dress a partial number up as complete.

CURRENT ROSTER (names and nicknames; (O) is the crew's own, (J) is official or fan):
${roster}

Keep it grounded, keep it spoiler-safe, keep it fun. You're the crew's guy.`;
}

export const FEW_SHOT = [
  { role:'user', content:'whats atomic from and how old' },
  { role:'assistant', content:"Atomic, that's Atamifuji! Let me grab his card real quick 🔥" },
];
