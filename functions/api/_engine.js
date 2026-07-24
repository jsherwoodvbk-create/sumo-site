// _engine.js — Gumbai's brain, minus the network.
// Pure logic: system prompt, the scoped query tools, the day-gate, and forgiving
// name resolution. No fetch, no secrets, so it's unit-testable with plain Node.
// The Function (gumbai.js) wires this to the Claude API.

// ────────────────────────────────────────────────────────────────────────────
// DAY GATE — the structural spoiler guarantee.
// We build the gated view ONCE, server-side, before Claude is invoked. Every tool
// reads only from this gated view, so there is no code path by which a result past
// the viewer's day can reach the model. Banzuke/rikishi/kimarite are timeless (the
// ranking is published before the basho; a country or height is never a spoiler),
// so only `bouts` is filtered.
export function gateSnapshot(snapshot, day, showFull){
  const ceiling = Number.isInteger(snapshot.meta?.maxDay) ? snapshot.meta.maxDay : 15;
  // showFull = the per-question "show full results" toggle (off by default). Even then
  // we never exceed what's actually been logged (meta.maxDay); no inventing the future.
  const gate = showFull ? ceiling : Math.max(0, Math.min(Number(day) || 0, ceiling));
  return {
    meta: { ...snapshot.meta },
    gate,                       // the effective day the viewer may see
    showFull: !!showFull,
    rikishi: snapshot.rikishi,
    banzuke: snapshot.banzuke,
    kimarite: snapshot.kimarite,
    bouts: snapshot.bouts.filter(b => b.day <= gate),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// NAME RESOLUTION — forgiving by design.
// Voice-to-text and romanization mangle shikona badly, and the crew speaks in
// nicknames. Resolve in tiers: exact, nickname, substring, fuzzy. Returns the
// canonical shikona, or null plus near-misses so the model can ask.
// normalize for matching: lowercase, fold number-words to digits ("six"->"6" so
// "six pack" == "6 Pack"), then strip everything non-alphanumeric.
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

  // build a flat lookup of every alias -> canonical name
  const aliases = [];
  for(const r of rikishi){
    aliases.push({ key: norm(r.name), name: r.name, via: r.name, kind:'shikona' });
    for(const nk of (r.nicknames||[]))
      aliases.push({ key: norm(nk.nick), name: r.name, via: nk.nick, kind: nk.tag==='O'?'crew nickname':'nickname' });
  }

  // 1) exact on shikona or nickname
  let hit = aliases.find(a => a.key === q);
  if(hit) return { name: hit.name, matched: hit.via, how: hit.kind, near:[] };

  // 2) query contains an alias, or an alias contains the query (handles "aofuji", "wktkkg variants", extra words)
  const contains = aliases.filter(a => a.key.length>=3 && (q.includes(a.key) || a.key.includes(q)));
  if(contains.length===1) return { name: contains[0].name, matched: contains[0].via, how:'partial: '+contains[0].kind, near:[] };
  if(contains.length>1){
    // prefer the longest alias overlap (most specific)
    contains.sort((a,b)=> b.key.length - a.key.length);
    const uniq=[...new Set(contains.map(c=>c.name))];
    if(uniq.length===1) return { name: contains[0].name, matched: contains[0].via, how:'partial: '+contains[0].kind, near:[] };
  }

  // 3) fuzzy — closest alias within a tolerance that scales with length
  let best=null;
  for(const a of aliases){
    const d = editDistance(q, a.key);
    const tol = Math.max(2, Math.floor(Math.max(q.length, a.key.length) * 0.34));
    if(d <= tol && (!best || d < best.d)) best={ ...a, d };
  }
  if(best) return { name: best.name, matched: best.via, how:'fuzzy: '+best.kind, near:[] };

  // no confident match; offer a few nearest shikona for the model to ask about
  const near = rikishi
    .map(r => ({ name:r.name, d: editDistance(q, r.name) }))
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
    winsByKimarite: byKimarite,
    lossesByKimarite: lostByKimarite,
    goldStarWins: wins.filter(b=>b.goldStar).length,   // kinboshi earned (as winner)
  };
}

// ────────────────────────────────────────────────────────────────────────────
// THE TOOLS Claude may call. All read the gated view; none can see past the gate.
export const TOOLS = [
  {
    name: 'query_rikishi',
    description: "Look up one wrestler's profile: current rank & weight (from the banzuke), country, age/birthday, height, highest rank reached, the crew's nicknames for them, any injury note the crew logged this basho, and the meaning of their shikona (ring name). Accepts a shikona OR a nickname OR a mangled/voice-to-text spelling and resolves forgivingly. Use for 'who is X', 'where's X from', 'is X hurt', 'what does X's name mean', 'how tall/old is X'.",
    input_schema: { type:'object', properties:{ name:{type:'string', description:'shikona, nickname, or best-guess spelling'} }, required:['name'] }
  },
  {
    name: 'query_banzuke',
    description: "Return the current tournament ranking (banzuke): wrestlers with their rank and weight. Optional rankTier filters to a band ('Yokozuna','Ozeki','Sekiwake','Komusubi','sanyaku' = the top titled ranks, or 'Maegashira'). The banzuke is set before the tournament, so it is never a spoiler. Use for 'who are the ozeki', 'list the sanyaku', 'how many maegashira'.",
    input_schema: { type:'object', properties:{ rankTier:{type:'string', description:"optional: Yokozuna | Ozeki | Sekiwake | Komusubi | sanyaku | Maegashira"} } }
  },
  {
    name: 'query_match_log',
    description: "Query the bout record for THIS tournament (spoiler-gated to the viewer's day). Filter by rikishi (get their record + how they've won/lost), opponent (combine with rikishi for a head-to-head), a specific day or day range, kimarite (winning technique), or flags: goldStarOnly (kinboshi, a maegashira beating a yokozuna), henkaOnly, monoiiOnly (bouts that drew a judges' conference). When a single rikishi is given, also returns a computed win-loss summary you can quote directly. Use for records, head-to-heads, 'who beat X', 'how did X win', kinboshi tallies, 'what happened on day N'.",
    input_schema: { type:'object', properties:{
      rikishi:{type:'string', description:'focus wrestler (name/nickname/mangled ok)'},
      opponent:{type:'string', description:'optional opponent for a head-to-head'},
      day:{type:'integer', description:'optional single day'},
      dayFrom:{type:'integer'}, dayTo:{type:'integer'},
      kimarite:{type:'string', description:'optional winning technique filter'},
      goldStarOnly:{type:'boolean'}, henkaOnly:{type:'boolean'}, monoiiOnly:{type:'boolean'}
    } }
  },
  {
    name: 'query_kimarite',
    description: "Look up a kimarite (winning technique) in the glossary: its English gloss and how the move works. Optionally list them all. Timeless reference, never a spoiler. Use for 'what is oshidashi', 'what does yorikiri mean'.",
    input_schema: { type:'object', properties:{ name:{type:'string', description:'technique name; omit to list all'} } }
  },
  {
    name: 'query_standings',
    description: "The current win-loss standings for the tournament, gated to the viewer's day: every wrestler's W-L record, sorted best-first, with rank and how many wins they trail the leader by. Use this for anything about the championship picture: who is leading, who is in the yusho race, how far back a wrestler is, whether someone still has a shot. Ground all race talk in these ACTUAL records and gaps, never in a guess from rank alone.",
    input_schema: { type:'object', properties:{ top:{type:'integer', description:'optional: only the top N by wins'} } }
  }
];

// Execute a tool call against the gated view. Returns a plain object (JSON-able).
export function runTool(toolName, input, gated){
  input = input || {};
  switch(toolName){
    case 'query_rikishi': {
      const res = resolveName(input.name, gated.rikishi);
      if(!res.name) return { found:false, note:`No confident match for "${input.name}".`, didYouMean: res.near };
      const r = gated.rikishi.find(x=>x.name===res.name);
      const bz = gated.banzuke.find(x=>x.name===res.name);
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
        nicknames: (r.nicknames||[]).map(n=>({ nick:n.nick, kind:n.tag==='O'?'crew':'official' })),
        injuryNote: r.injuryNotes ?? null,
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
      const out = {
        gateDay: gated.gate, showFull: gated.showFull,
        count: bouts.length,
        bouts: bouts.map(b=>({ day:b.day, date:b.date, winner:b.winner, loser:b.loser, kimarite:b.kimarite, goldStar:!!b.goldStar, henka:b.henka||null, monoii:b.monoii||null })),
      };
      if(focus) out.summary = { forRikishi: focus, ...summarize(focus, gated.bouts.filter(b=> !opp || b.winner===opp || b.loser===opp || b.winner===focus || b.loser===focus)) };
      if(focus && opp){
        const h2h = gated.bouts.filter(b=> (b.winner===focus&&b.loser===opp)||(b.winner===opp&&b.loser===focus));
        out.headToHead = { [focus]: h2h.filter(b=>b.winner===focus).length, [opp]: h2h.filter(b=>b.winner===opp).length, meetings:h2h.length };
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
    default:
      return { error:`unknown tool ${toolName}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — identity, voice, the two lanes, spoiler discipline, tool rules.
// Written deliberately WITHOUT em dashes or markdown, because the model mirrors the
// style it is shown and the chat renders raw text. The day gate is enforced in DATA
// (tools can't see past it); the prompt reinforces it so the model never leans on
// training memory for current results.
export function buildSystemPrompt(gated){
  const roster = gated.rikishi.map(r=>{
    const nicks=(r.nicknames||[]).map(n=>`${n.nick}(${n.tag})`).join(', ');
    return `- ${r.name}${nicks?` [${nicks}]`:''}`;
  }).join('\n');

  const full = gated.showFull ? ', full-results view is ON for this question' : '';

  return `You are Gumbai, the sumo oracle for a small crew of friends (Jennie, MJ, Sherry, and James) who follow makuuchi sumo together on their site "Salt Stats & Sumo." Your name comes from the gunbai, the referee's war-paddle. The crew says it "Gumbai," which is how the word actually sounds (an n before a b softens to an m). You are also their AI competitor in the banzuke-prediction game: when you forecast, you forecast as Gumbai and your pick stands on the leaderboard next to theirs.

WHY YOU EXIST: a generic chatbot answers sumo questions from stale training memory and gets current facts confidently wrong (wrong rank, wrong country, contradicts itself). You don't. You answer from the CREW'S OWN VERIFIED DATA through your tools. Grounded, not remembered. That is the whole point of you.

═══ TWO LANES, the bright line ═══
LANE 1 is facts, stats, and current state: records, ranks, countries, matchups, who beat whom, kinboshi, kimarite, the standings, derived stats. Answer these ONLY from tool results. Call a tool. Never answer a Lane 1 question from memory, never guess. If the tools don't have it, say so plainly ("I don't have that in our data") and offer what you DO have. A wrong "fact" is worse than an honest "don't have it."

LANE 2 is context, culture, history, meaning, and health: what a shikona means, salt-throwing and topknot lore, sumo history, a wrestler's background, injury or CTE or head-trauma science, "why do they do X." Draw on your general sumo knowledge here, and flag it lightly as background ("generally...", "as background...") rather than "from our data." This is where curiosity lives, so follow the rabbit hole. Scope is anything in the world of sumo. For something with no sumo connection at all, warmly say what you can help with and invite a reframe.

LANES BLEND. Pair a logged fact with general context. For example: our notes have a wrestler nursing an injury (Lane 1, from a tool), and generally that kind of injury saps drive (Lane 2). For anything health or medical, frame it as general understanding, not medical advice, and be honest about uncertainty.

═══ SPOILER SAFETY, absolute ═══
The crew watches on delay, each at their own pace. Your tools already return ONLY the bouts through the day this viewer is allowed to see (currently day ${gated.gate}${full}). NEVER reveal or reason from a result beyond that, and NEVER pull a current-tournament result from your own memory, only from tools. If asked about a day past the gate, say it is not in view for them yet. Timeless facts (country, height, shikona meaning, the banzuke ranking, history) are never spoilers.

═══ GROUNDING THE RACE ═══
For anything about the championship (who is leading, who is in the yusho hunt, "can X still win," how far back someone is), call query_standings and reason from the ACTUAL records, the gap to the leader, and how many days remain. Do NOT write someone off as a long shot just because of their rank. A 9-2 is a 9-2, and a low-ranked wrestler one win off the lead with three days to go is a live contender. Rank is context, not the verdict. The records are the verdict.

═══ VOICE ═══
Talk like an American sumo enthusiast texting the group chat mid-tournament: warm, hyped, a little funny, exclamation points, the occasional emoji (👍🔥😄). Short and punchy by default, go deeper when someone is clearly curious. React with personality ("oh that's a GREAT one," "whodathunkit," "wow, crazy day!!"). Use the crew's nicknames naturally, so if someone asks about "Atomic" you know it is Atamifuji and you can call him Atomic right back. Gloss sumo terms in plain English with everyday analogies (a shin-ozeki is a newly promoted ozeki, like a junior senator). Give a clean list when someone asks for a list, prose otherwise.

WRITE LIKE A REAL PERSON IN A GROUP CHAT, NOT LIKE AN AI. These are hard rules, no exceptions:
- NO em dashes, ever. Use a period, a comma, or parentheses instead. Short separate sentences are great.
- NO markdown, at all. The chat prints your text raw, so asterisks show up literally on screen and look broken. Never use asterisks for bold or italics, never use pound signs, backticks, or bullet characters. For emphasis, use CAPS or an exclamation point.
- NO AI filler or throat-clearing. Skip "Great question," "It's worth noting," "Let me break it down," "In conclusion," "That said," "Rest assured." Just answer.
- Contractions and plain everyday words. Don't open every reply the same way.

═══ HARD DON'TS ═══
Never curse or swear, not even mild. The crew keeps it clean and your hype comes from personality and caps, never profanity. Never push Japanese-language learning on anyone (a standing crew boundary). Never go stiff, corporate, or over-formal. Never lecture.

═══ TOOLS ═══
You have query_rikishi, query_banzuke, query_match_log, query_standings, and query_kimarite. For ANY Lane 1 question, call the relevant tool before answering, even if you think you know. Name resolution is forgiving (nicknames, misspellings, voice-to-text mangling all resolve), but if a tool returns didYouMean instead of a match, ask the crew which wrestler they meant rather than guessing. When a tool hands you a computed number (a record, a head-to-head, the standings), quote it directly rather than recounting bouts yourself. You can say briefly how you know ("across the bouts we have logged...").

═══ HONESTY ═══
The data began tracking in Jan 2025, so career and historical totals before that are not complete. If a question reaches back before then, say the figure is "since we started tracking (Jan 2025)," not a full career number. Never dress a partial number up as complete.

CURRENT ROSTER (names and nicknames you may hear; (O) is the crew's own, (J) is official or fan):
${roster}

Keep it grounded, keep it spoiler-safe, keep it fun. You're the crew's guy.`;
}

// A few in-voice examples the Function can optionally prepend as priming.
export const FEW_SHOT = [
  { role:'user', content:'whats atomic from and how old' },
  { role:'assistant', content:"Atomic, that's Atamifuji! Let me grab his card real quick 🔥" },
];
