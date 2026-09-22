// test-engine.mjs — spoiler-gate + soft-data + audience-split unit tests for gumbai-engine.
// Run: node test-engine.mjs   (exits non-zero on any failure)
import assert from 'node:assert';
import { gateSnapshot, runTool, buildSystemPrompt, toolsFor, TOOLS } from './functions/api/_engine.js';
let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('  ✓ ' + name); };
const bad = (name, e) => { fail++; console.log('  ✗ ' + name + '  — ' + (e && e.message || e)); };
function t(name, fn){ try { fn(); ok(name); } catch(e){ bad(name, e); } }
// ── Mock schema/4 snapshot. Sentinels SPOILER_D<n> mark day-n info that must NOT
// leak to any viewer gated before day n. Injury titles + cause tracks also carry
// future sentinels to prove the caught-up withholding. ──
const roster = ['Aonishiki','Wakanosho','Onosato','Chiyoshoma','Kotoeiho','Hoshoryu'];
const bouts = [];
for(let d=1; d<=15; d++){
  bouts.push({
    day:d, date:`2026-07-${d}`, winner: roster[d%6], loser: roster[(d+1)%6],
    kimarite:'yorikiri', goldStar:(d===3), henka:(d===2?'Full':null), monoii:(d===12?'Reversed (-R)':null),
    boutOfDay:(d===5?'U':null), conduct:(d===6?['Crowd-pleaser']:[]), conductNote:`net day ${d} SPOILER_D${d}`,
    length:(d===5?'*':null), cushions:(d===9), rematch:(d===12),
  });
}
const days = [];
for(let d=1; d<=15; d++) days.push({ day:d, storylines:`Day ${d} storyline SPOILER_D${d}`, scorekeeperNotes:(d===4?`sk note SPOILER_D4`:null), announcer:'Hiro Morita' });
const injuries = [
  { rikishi:'Aonishiki', condition:'Aonishiki — left foot (played through to the yusho SPOILER_D15)', area:'left foot', setting:'Off-dohyo',
    nature:['Acute','Flared'], status:'Active', officialReason:null, boothRead:'carried-in foot, favors it',
    scorekeeperEye:null, source:['Booth mention'], onsetDay:1, fullMaxDay:15,
    severity:[{day:1,text:'26NgD1 carried in'},{day:8,text:'26NgD8 flare SPOILER_D8'},{day:10,text:'26NgD10 worst point SPOILER_D10'},{day:15,text:'26NgD15 played through to the yusho SPOILER_D15'}] },
  { rikishi:'Wakanosho', condition:'Wakanosho — head (Day 6 concussion read)', area:'head', setting:'On-dohyo',
    nature:['Acute'], status:'Withdrawn', officialReason:'Right knee cited Day 7 SPOILER_D7', boothRead:'concussed, stretchered off SPOILER_D6',
    scorekeeperEye:'neurological read (Jennie)', source:['Seen-in-bout','Scorekeeper Eye'], onsetDay:6, fullMaxDay:7,
    severity:[{day:6,text:'26NgD6 collapse concussion SPOILER_D6'},{day:7,text:'26NgD7 withdrew knee SPOILER_D7'}] },
  { rikishi:'Onosato', condition:'Onosato — left shoulder', area:'shoulder', setting:'Off-dohyo',
    nature:['Chronic'], status:'Active', officialReason:null, boothRead:'rotator cuff, fragile',
    scorekeeperEye:null, source:['Booth mention'], onsetDay:1, fullMaxDay:12,
    severity:[{day:1,text:'26NgD1 carried in shoulder'},{day:7,text:'26NgD7 says mental now'},{day:12,text:'26NgD12 still bothering SPOILER_D12'}] },
  { rikishi:'Chiyoshoma', condition:'Chiyoshoma — chronic lower back', area:'back', setting:'Off-dohyo',
    nature:['Chronic'], status:'Active', officialReason:null, boothRead:'chronic back, managing',
    scorekeeperEye:null, source:['Booth mention'], onsetDay:1, fullMaxDay:1,
    severity:[{day:1,text:'26NgD1 carried in chronic back'}] },
];
const catchphrases = [
  { phrase:'Guns blazing', announcer:'Hiro Morita', days:[2,14], giggle:null, jewel:true },
  { phrase:'Has no answer', announcer:'Hiro Morita', days:[8,11], giggle:3, jewel:false },
  { phrase:'Do take care', announcer:'Murray Johnson', days:[], giggle:null, jewel:false },
];
const SNAP = {
  meta:{ maxDay:15, basho:'Test Basho' },
  rikishi: roster.map(n=>({ name:n, nicknames:[], country:'Japan', birthday:'1998-01-01', highestRank:'Maegashira 1', heightCm:185, injuryNotes:null, shikonaMeaning:null })),
  banzuke: roster.map((n,i)=>({ name:n, rank:`Maegashira ${i+1}`, weightKg:150 })),
  kimarite:[{name:'yorikiri', description:'force out'}],
  bouts, days, injuries, catchphrases, history:{ meta:{}, basho:{} }, upcoming:null,
};
// ═══ 1. THE SPOILER SWEEP: no SPOILER_D<n> with n > gate may appear anywhere ═══
console.log('\n[1] Spoiler sweep across every lane + every tool, gate 0..15');
for(let gate=0; gate<=15; gate++){
  const g = gateSnapshot(SNAP, gate, false);
  const toolOut = [
    JSON.stringify(g),
    JSON.stringify(runTool('query_condition', {}, g)),
    JSON.stringify(runTool('query_condition', {name:'Aonishiki'}, g)),
    JSON.stringify(runTool('query_condition', {name:'Wakanosho'}, g)),
    JSON.stringify(runTool('query_condition', {name:'Onosato'}, g)),
    JSON.stringify(runTool('query_storylines', {}, g)),
    JSON.stringify(runTool('query_storylines', {day:gate}, g)),
    JSON.stringify(runTool('query_catchphrases', {}, g)),
    JSON.stringify(runTool('query_match_log', {}, g)),
    JSON.stringify(runTool('query_match_log', {rikishi:'Aonishiki'}, g)),
    JSON.stringify(runTool('query_rikishi', {name:'Aonishiki'}, g)),
    JSON.stringify(runTool('query_rikishi', {name:'Wakanosho'}, g)),
    JSON.stringify(runTool('query_standings', {}, g)),
    buildSystemPrompt(g),
  ].join(' ||| ');
  t(`gate ${gate}: no future spoiler token leaks`, () => {
    for(let n=gate+1; n<=15; n++){
      assert(!toolOut.includes(`SPOILER_D${n}`), `leaked SPOILER_D${n} at gate ${gate}`);
    }
  });
}
// ═══ 2. Injury onset gating: hidden until onset day ═══
console.log('\n[2] Injury onset gating');
t('Wakanosho (onset 6) hidden at gate 5', () => {
  const g = gateSnapshot(SNAP, 5, false);
  assert.strictEqual(g.injuries.find(c=>c.rikishi==='Wakanosho'), undefined);
  assert.strictEqual(runTool('query_condition',{name:'Wakanosho'},g).found, false);
});
t('Wakanosho appears at gate 6', () => {
  const g = gateSnapshot(SNAP, 6, false);
  assert(g.injuries.find(c=>c.rikishi==='Wakanosho'));
});
// ═══ 3. Caught-up withholding: title/status/cause-tracks hidden until caught up ═══
console.log('\n[3] Caught-up withholding');
t('Aonishiki at gate 8: not caught up -> no title, no cause tracks, status ongoing', () => {
  const g = gateSnapshot(SNAP, 8, false);
  const c = g.injuries.find(x=>x.rikishi==='Aonishiki');
  assert(c, 'should be visible (onset 1)');
  assert.strictEqual(c.caughtUp, false);
  assert.strictEqual(c.status, 'ongoing');
  assert.strictEqual(c.condition, undefined, 'raw title (has yusho spoiler) must be withheld');
  assert.strictEqual(c.officialReason, undefined);
  assert.strictEqual(c.boothRead, undefined);
  assert(c.severity.every(e=>e.day<=8));
});
t('Aonishiki at gate 15: caught up -> full detail returns', () => {
  const g = gateSnapshot(SNAP, 15, false);
  const c = g.injuries.find(x=>x.rikishi==='Aonishiki');
  assert.strictEqual(c.caughtUp, true);
  assert.strictEqual(c.status, 'Active');
  assert(c.condition && c.condition.includes('yusho'));
  assert(c.boothRead);
});
t('Wakanosho at gate 6: status ongoing, official reason withheld (says Day 7)', () => {
  const g = gateSnapshot(SNAP, 6, false);
  const c = g.injuries.find(x=>x.rikishi==='Wakanosho');
  assert.strictEqual(c.status, 'ongoing');
  assert.strictEqual(c.officialReason, undefined);
});
t('Wakanosho at gate 7: caught up -> Withdrawn + official reason shown', () => {
  const g = gateSnapshot(SNAP, 7, false);
  const c = g.injuries.find(x=>x.rikishi==='Wakanosho');
  assert.strictEqual(c.caughtUp, true);
  assert.strictEqual(c.status, 'Withdrawn');
  assert(c.officialReason && c.officialReason.includes('knee'));
});
t('Chiyoshoma (single entry) caught up from gate 1 -> full 3-track detail', () => {
  const g = gateSnapshot(SNAP, 1, false);
  const c = g.injuries.find(x=>x.rikishi==='Chiyoshoma');
  assert.strictEqual(c.caughtUp, true);
  assert(c.condition && c.boothRead);
});
t('3 provenance tracks are separate fields (never merged)', () => {
  const g = gateSnapshot(SNAP, 7, false);
  const c = g.injuries.find(x=>x.rikishi==='Wakanosho');
  assert('officialReason' in c && 'boothRead' in c && 'scorekeeperEye' in c);
  assert(c.scorekeeperEye.includes('Jennie'));
});
// ═══ 4. Catchphrase count gating (floor) ═══
console.log('\n[4] Catchphrase gating');
t('"Has no answer" (days 8,11) hidden at gate 5', () => {
  const g = gateSnapshot(SNAP, 5, false);
  assert(!g.catchphrases.find(c=>c.phrase==='Has no answer'));
});
t('count is 1 at gate 8, 2 at gate 11', () => {
  const g8 = gateSnapshot(SNAP, 8, false), g11 = gateSnapshot(SNAP, 11, false);
  assert.strictEqual(g8.catchphrases.find(c=>c.phrase==='Has no answer').count, 1);
  assert.strictEqual(g11.catchphrases.find(c=>c.phrase==='Has no answer').count, 2);
});
t('timeless phrase (no days) always present, count null', () => {
  const g1 = gateSnapshot(SNAP, 1, false);
  const c = g1.catchphrases.find(x=>x.phrase==='Do take care');
  assert(c && c.timeless === true && c.count === null);
});
t('query_catchphrases labels floor + never claims most-used', () => {
  const g = gateSnapshot(SNAP, 14, false);
  const out = runTool('query_catchphrases', {}, g);
  assert(/FLOOR/i.test(out.note));
});
// ═══ 5. Storylines + scorekeeper notes gating ═══
console.log('\n[5] Storylines gating');
t('only days <= gate returned', () => {
  const g = gateSnapshot(SNAP, 5, false);
  const out = runTool('query_storylines', {}, g);
  assert(out.days.every(d=>d.day<=5));
  assert.strictEqual(out.days.length, 5);
});
t('scorekeeper note surfaces (day 4) and is labeled Jennie', () => {
  const g = gateSnapshot(SNAP, 4, false);
  const out = runTool('query_storylines', {day:4}, g);
  assert(out.days[0].scorekeeperNotes.includes('sk note'));
  assert(/scorekeeper|Jennie/i.test(out.note));
});
// ═══ 6. Per-bout nets flow through query_match_log ═══
console.log('\n[6] Per-bout nets');
t('nets present on bouts', () => {
  const g = gateSnapshot(SNAP, 9, false);
  const out = runTool('query_match_log', {}, g);
  const d5 = out.bouts.find(b=>b.day===5);
  assert.strictEqual(d5.boutOfDay, 'U');
  assert.strictEqual(d5.length, '*');
  const d9 = out.bouts.find(b=>b.day===9);
  assert.strictEqual(d9.cushions, true);
});
t('boutOfDayOnly filter works', () => {
  const g = gateSnapshot(SNAP, 15, false);
  const out = runTool('query_match_log', {boutOfDayOnly:true}, g);
  assert(out.bouts.every(b=>b.boutOfDay));
});
// ═══ 7. Regression: existing gate still hides future bouts ═══
console.log('\n[7] Core bout gate regression');
t('no bout past gate', () => {
  const g = gateSnapshot(SNAP, 7, false);
  assert(g.bouts.every(b=>b.day<=7));
  assert(runTool('query_match_log',{day:8},g).bouts.length===0);
});
t('query_rikishi attaches gated condition', () => {
  const g = gateSnapshot(SNAP, 15, false);
  const out = runTool('query_rikishi', {name:'Chiyoshoma'}, g);
  assert(out.conditions && out.conditions[0].rikishi==='Chiyoshoma');
});
// ═══ 8. YUSHO (champion) reveal — gated to a completed basho + caught-up viewer ═══
console.log('\n[8] Current-basho champion reveal gate');
const SNAP_DONE = { ...SNAP, champion:{ name:'Aonishiki', playoff:true } };
const SNAP_LIVE = { ...SNAP, champion:null };
t('champion hidden at every gate < 15', () => {
  for(let gate=0; gate<15; gate++){
    const g = gateSnapshot(SNAP_DONE, gate, false);
    assert.strictEqual(g.champion, null, `champion leaked at gate ${gate}`);
    const y = runTool('query_yusho', {}, g);
    assert.strictEqual(y.currentBashoInView, false, `currentBashoInView true too early at gate ${gate}`);
    assert(!JSON.stringify(y.champions).includes('Aonishiki') || y.champions.slice(1).some(c=>(c.yusho||[]).includes('Aonishiki')),
      'current champion named before day 15');
  }
});
t('champion revealed at gate 15', () => {
  const g = gateSnapshot(SNAP_DONE, 15, false);
  assert(g.champion && g.champion.name==='Aonishiki' && g.champion.playoff===true);
});
t('champion revealed with showFull', () => {
  const g = gateSnapshot(SNAP_DONE, 0, true);
  assert(g.champion && g.champion.name==='Aonishiki');
});
t('query_yusho (no name) at 15 lists current basho first, playoff flagged', () => {
  const g = gateSnapshot(SNAP_DONE, 15, false);
  const y = runTool('query_yusho', {}, g);
  assert.strictEqual(y.currentBashoInView, true);
  assert.strictEqual(y.champions[0].basho, 'Test Basho');
  assert(y.champions[0].yusho.includes('Aonishiki'));
  assert.strictEqual(y.champions[0].playoff, true);
});
t('query_yusho name=Aonishiki at 15 counts the current title', () => {
  const g = gateSnapshot(SNAP_DONE, 15, false);
  const y = runTool('query_yusho', {name:'Aonishiki'}, g);
  assert.strictEqual(y.currentBasho.result, 'won');
  assert(y.yusho.some(s=>/Test Basho/.test(s)));
  assert(y.yushoCount >= 1);
});
t('query_yusho name=Aonishiki at 14 = undecided in view', () => {
  const g = gateSnapshot(SNAP_DONE, 14, false);
  const y = runTool('query_yusho', {name:'Aonishiki'}, g);
  assert.strictEqual(y.currentBasho.result, 'undecided in your view');
  assert(!y.yusho.some(s=>/Test Basho/.test(s)));
});
t('query_yusho name=other at 15 = won by someone else', () => {
  const g = gateSnapshot(SNAP_DONE, 15, false);
  const y = runTool('query_yusho', {name:'Onosato'}, g);
  assert.strictEqual(y.currentBasho.result, 'won by someone else');
});
t('query_career at 15 counts current yusho + marks the perBasho entry', () => {
  const g = gateSnapshot(SNAP_DONE, 15, false);
  const c = runTool('query_career', {name:'Aonishiki'}, g);
  assert(c.yusho.includes('Test Basho'));
  const cur = c.perBasho.find(p=>p.basho==='Test Basho');
  assert(cur && cur.yusho===true && cur.playoff===true && !cur.inProgress);
});
t('query_career at 14 leaves current in-progress, no title', () => {
  const g = gateSnapshot(SNAP_DONE, 14, false);
  const c = runTool('query_career', {name:'Aonishiki'}, g);
  assert(!c.yusho.includes('Test Basho'));
  const cur = c.perBasho.find(p=>p.basho==='Test Basho');
  assert(cur && cur.inProgress===true && !cur.yusho);
});
t('no champion posted → never revealed even at 15', () => {
  const g = gateSnapshot(SNAP_LIVE, 15, false);
  assert.strictEqual(g.champion, null);
  const y = runTool('query_yusho', {}, g);
  assert.strictEqual(y.currentBashoInView, false);
  const c = runTool('query_career', {name:'Aonishiki'}, g);
  assert(!c.yusho.includes('Test Basho'));
});
// The exact bug Jennie hit: a non-champion's completed basho still read "in progress" at day 15.
t('career: non-champion at 15 reads FINAL, not in-progress, no title', () => {
  const g = gateSnapshot(SNAP_DONE, 15, false);
  const c = runTool('query_career', {name:'Onosato'}, g);   // Onosato did NOT win
  assert.strictEqual(c.bashoComplete, true);
  const cur = c.perBasho.find(p=>p.basho==='Test Basho');
  assert(cur && cur.final===true && !cur.inProgress && !cur.yusho);
});
t('career: at 14 a non-champion is still in-progress', () => {
  const g = gateSnapshot(SNAP_DONE, 14, false);
  const c = runTool('query_career', {name:'Onosato'}, g);
  assert.strictEqual(c.bashoComplete, false);
  const cur = c.perBasho.find(p=>p.basho==='Test Basho');
  assert(cur && cur.inProgress===true && !cur.final);
});
// "Basho over" must NOT depend on the yusho fetch: even with no champion posted, day 15 = final.
t('career: basho reads complete at 15 even when champion fetch is null', () => {
  const g = gateSnapshot(SNAP_LIVE, 15, false);
  const c = runTool('query_career', {name:'Onosato'}, g);
  assert.strictEqual(c.bashoComplete, true);
  const cur = c.perBasho.find(p=>p.basho==='Test Basho');
  assert(cur && cur.final===true && !cur.inProgress && !cur.yusho);
});
// ═══ 9. AUDIENCE SPLIT — member-gate sweep (public must NEVER see the member-only lanes) ═══
// The audience twin of the spoiler sweep: seed a distinct sentinel into every member-only field,
// then prove no public path (view, any tool, the prompt) leaks one, while the member path keeps them.
console.log('\n[9] Audience split — member-gate sweep');
const AUD_SENTINELS = ['SENTINEL_CONDUCT','SENTINEL_CONDUCTNOTE','SENTINEL_BOTD','SENTINEL_LENGTH','SENTINEL_STORYLINE','SENTINEL_SKNOTES','SENTINEL_CONDITION','SENTINEL_OFFICIAL','SENTINEL_BOOTH','SENTINEL_SKEYE'];
const A = { conduct:'SENTINEL_CONDUCT', conductNote:'SENTINEL_CONDUCTNOTE', botd:'SENTINEL_BOTD', length:'SENTINEL_LENGTH',
  storyline:'SENTINEL_STORYLINE', skNotes:'SENTINEL_SKNOTES', condition:'SENTINEL_CONDITION', official:'SENTINEL_OFFICIAL', booth:'SENTINEL_BOOTH', skEye:'SENTINEL_SKEYE' };
const SNAP_AUD = {
  meta:{ basho:'Aki 2026', bashoId:'202609', maxDay:15, schema:'gumbai-snapshot/6' },
  rikishi:[ {name:'Onosato',nicknames:[{nick:'The Wall',tag:'O'}]}, {name:'Hoshoryu',nicknames:[]} ],
  banzuke:[ {name:'Onosato',rank:'Yokozuna',weightKg:191}, {name:'Hoshoryu',rank:'Yokozuna',weightKg:151} ],
  kimarite:[{name:'yorikiri',gloss:'force out'}],
  bouts:[ { day:1,date:'2026-09-13',winner:'Onosato',loser:'Hoshoryu',kimarite:'yorikiri', goldStar:true,rematch:true,
    henka:true,monoii:true, boutOfDay:A.botd,conduct:[A.conduct],conductNote:A.conductNote,length:A.length,cushions:true } ],
  days:[{ day:1,announcer:'Murray',storylines:A.storyline,scorekeeperNotes:A.skNotes }],
  injuries:[{ rikishi:'Hoshoryu',onsetDay:1,fullMaxDay:1,area:'knee',setting:'bout',nature:['chronic'],severity:[{day:1,level:'moderate'}],
    condition:A.condition,status:'ongoing',officialReason:A.official,boothRead:A.booth,scorekeeperEye:A.skEye,source:['video'] }],
  catchphrases:[{ phrase:'here comes the salt',announcer:'Murray',days:[1],giggle:3,jewel:false }],
  history:{ basho:{} },
  upcoming:{ day:2,date:'2026-09-14',matchups:[{eastName:'Onosato',eastRank:'Y',westName:'Hoshoryu',westRank:'Y'}] },
};
const noLeak = (text) => { for(const s of AUD_SENTINELS) assert(!String(text).includes(s), 'leaked ' + s); };
const memV = gateSnapshot(SNAP_AUD, 15, false, 'member');
const pubV = gateSnapshot(SNAP_AUD, 15, false, 'public');
t('toolsFor(member) is the full 17', () => assert(toolsFor('member').length === TOOLS.length && TOOLS.length === 17));
t('toolsFor(public) = 15, omits condition+storylines, keeps catchphrases + rollup + rate + the reference tools', () => {
  const p = toolsFor('public').map(x=>x.name);
  assert(p.length===15 && !p.includes('query_condition') && !p.includes('query_storylines')
    && p.includes('query_catchphrases') && p.includes('query_rollup') && p.includes('query_rate')
    && p.includes('query_basho') && p.includes('query_glossary') && p.includes('query_library'));
});
t('member view keeps injuries + days + nets (no regression)', () =>
  assert((memV.injuries||[]).length===1 && (memV.days||[]).length===1 && memV.bouts[0].conduct[0]===A.conduct && memV.bouts[0].length===A.length));
t('public view strips injuries + days', () => assert((pubV.injuries||[]).length===0 && (pubV.days||[]).length===0));
t('public bout drops member nets, keeps henka/monoii/goldStar/rematch', () => {
  const b = pubV.bouts[0];
  assert(b.conduct===undefined && b.conductNote===undefined && b.boutOfDay===undefined && b.length===undefined && b.cushions===undefined
    && b.henka===true && b.monoii===true && b.goldStar===true && b.rematch===true);
});
t('public gate does NOT mutate the snapshot', () => assert(gateSnapshot(SNAP_AUD,15,false,'member').bouts[0].conduct[0]===A.conduct));
t('public gated view leaks no member sentinel', () => noLeak(JSON.stringify(pubV)));
t('every tool over the public view leaks no member sentinel', () => {
  const probes = { query_rikishi:{name:'Hoshoryu'}, query_career:{name:'Onosato'} };
  for(const tool of TOOLS) noLeak(JSON.stringify(runTool(tool.name, probes[tool.name]||{}, pubV)));
});
t('public match_log keeps henka/monoii, nulls stripped conduct', () => {
  const b = runTool('query_match_log',{},pubV).bouts[0];
  assert(b.henka===true && b.monoii===true && b.conduct===null);
});
t('public query_rikishi has null conditions', () => assert(runTool('query_rikishi',{name:'Hoshoryu'},pubV).conditions===null));
t('public prompt: no sentinel, no member tools in TOOLS line, has AUDIENCE block', () => {
  const p = buildSystemPrompt(pubV,'public');
  noLeak(p);
  assert(!/TOOLS:[^\n]*query_condition/.test(p) && !/TOOLS:[^\n]*query_storylines/.test(p) && /PUBLIC visitor/.test(p));
});
t('member run STILL surfaces the sensitive data (no regression)', () =>
  assert(JSON.stringify(runTool('query_condition',{},memV)).includes(A.official)
    && JSON.stringify(runTool('query_storylines',{},memV)).includes(A.storyline)
    && JSON.stringify(runTool('query_match_log',{},memV)).includes(A.conduct)));
t('member prompt lists query_condition in TOOLS line', () => assert(/TOOLS:[^\n]*query_condition/.test(buildSystemPrompt(memV,'member'))));

// ═══ 10. ORIGIN / ON-MISSION GUARD — prompt hardening for BOTH audiences (public is the exposed surface) ═══
// The guard must never depend on audience: it protects the prompt from extraction and keeps Gumbai
// on sumo. A regression here (someone edits the prompt and drops the block) should fail the suite.
console.log('\n[10] Origin / on-mission guard in the system prompt');
for(const aud of ['member','public']){
  const g = gateSnapshot(SNAP_AUD, 15, false, aud);
  const p = buildSystemPrompt(g, aud);
  t(`${aud} prompt carries the STAYING GUMBAI guard block`, () => assert(p.includes('STAYING GUMBAI')));
  t(`${aud} prompt states there is no in-chat override`, () => assert(/no override switch in the chat/i.test(p)));
  t(`${aud} prompt refuses prompt/instruction extraction`, () => assert(/never reveal, quote, print/i.test(p)));
  t(`${aud} prompt refuses non-sumo repurposing`, () => assert(/no sumo connection at all/i.test(p)));
  t(`${aud} prompt names spoof-authority attempts (Anthropic/admin) as no override`, () => assert(/claiming to be[^.]*admin/i.test(p)));
}
t('guard survives the default-audience call (buildSystemPrompt with no audience arg)', () => {
  const g = gateSnapshot(SNAP_AUD, 15, false);   // defaults to member
  assert(buildSystemPrompt(g).includes('STAYING GUMBAI'));
});

// ═══ 11. query_rollup + schema/6 profile fields (stable / mawashi / hometown / knownFor) ═══
// The crew's "how many from Isegahama" gap: Gumbai now rolls up a clean profile field across the
// WHOLE master (default) or the current banzuke, and surfaces stable/mawashi/hometown/knownFor on a
// profile. All timeless background → never gated, safe for public (knownFor stays member-only).
console.log('\n[11] query_rollup + schema/6 profile fields');
const SNAP_ROLL = {
  meta:{ basho:'Aki 2026', bashoId:'202609', maxDay:2 },
  rikishi:[
    { name:'Terunofuji', country:'Mongolia', stable:'Isegahama', hometown:'Ulaanbaatar', highestRank:'Yokozuna', knownFor:['Powerhouse'], mawashi:'gold', nicknames:[] },
    { name:'Takarafuji', country:'Japan', stable:'Isegahama', hometown:'Aomori', highestRank:'Sekiwake', knownFor:['Technician'], mawashi:'navy blue', nicknames:[] },
  ],
  banzuke:[ { name:'Terunofuji', rank:'Yokozuna', weightKg:180 }, { name:'Takarafuji', rank:'Maegashira 5', weightKg:150 } ],
  kimarite:[], bouts:[],
  master:[
    { name:'Terunofuji',   stable:'Isegahama',   country:'Mongolia', hometown:'Ulaanbaatar', knownFor:['Powerhouse'], highestRank:'Yokozuna',   active:true },
    { name:'Takarafuji',   stable:'Isegahama',   country:'Japan',    hometown:'Aomori',      knownFor:['Technician'], highestRank:'Sekiwake',   active:true },
    { name:'Nishikigi',    stable:'Isegahama',   country:'Japan',    hometown:'Iwate',       knownFor:[],             highestRank:'Maegashira', active:false }, // NOT on the current banzuke
    { name:'Ichiyamamoto', stable:'Nishonoseki', country:'Japan',    hometown:'Hokkaido',    knownFor:['Showman'],    highestRank:'Maegashira', active:true },
  ],
  days:[], injuries:[], catchphrases:[], history:{ meta:{}, basho:{} }, upcoming:null,
};
const rollM = gateSnapshot(SNAP_ROLL, 2, false, 'member');
const rollP = gateSnapshot(SNAP_ROLL, 2, false, 'public');
t('master lane passes the gate for both audiences (timeless)', () => assert(rollM.master.length===4 && rollP.master.length===4));
t('query_rikishi surfaces stable + mawashi + hometown', () => {
  const r = runTool('query_rikishi', {name:'Terunofuji'}, rollM);
  assert(r.stable==='Isegahama' && r.mawashiColor==='gold' && r.hometown==='Ulaanbaatar');
});
t('query_rollup stable=Isegahama master scope = 3 (retiree included)', () => {
  const o = runTool('query_rollup', {field:'stable', value:'Isegahama'}, rollM);
  assert(o.found && o.count===3 && o.members.includes('Nishikigi'));
});
t('query_rollup stable=Isegahama banzuke scope = 2 (retiree excluded)', () => {
  assert(runTool('query_rollup', {field:'stable', value:'Isegahama', scope:'banzuke'}, rollM).count===2);
});
t('query_rollup tolerates -beya suffix + case', () => {
  assert(runTool('query_rollup', {field:'stable', value:'Isegahama-beya'}, rollM).count===3
    && runTool('query_rollup', {field:'stable', value:'isegahama'}, rollM).count===3);
});
t('query_rollup country=Mongolia = Terunofuji', () => {
  assert.deepEqual(runTool('query_rollup', {field:'country', value:'Mongolia'}, rollM).members, ['Terunofuji']);
});
t('query_rollup (no value) groups sorted by count desc', () => {
  const o = runTool('query_rollup', {field:'stable'}, rollM);
  assert(o.groups[0].value==='Isegahama' && o.groups[0].count===3);
});
t('query_rollup knownFor is MEMBER-ONLY (public blocked, member allowed)', () => {
  assert(runTool('query_rollup', {field:'knownFor', value:'Showman'}, rollM).count===1);
  assert(runTool('query_rollup', {field:'knownFor', value:'Showman'}, rollP).found===false);
});
t('query_rollup stable/country still work for PUBLIC (timeless, non-sensitive)', () => {
  assert(runTool('query_rollup', {field:'stable', value:'Isegahama'}, rollP).count===3);
});
t('query_rollup heya alias -> stable; unknown field rejected cleanly', () => {
  assert(runTool('query_rollup', {field:'heya', value:'Isegahama'}, rollM).count===3);
  assert(runTool('query_rollup', {field:'blood type'}, rollM).found===false);
});
t('query_rollup registered + offered to both audiences', () => {
  assert(TOOLS.some(x=>x.name==='query_rollup') && toolsFor('public').some(x=>x.name==='query_rollup'));
});

// ═══ 12. schema/7 reference lanes — query_basho / query_glossary / query_library + profile fields ═══
// The completeness pass (Day-1, MJ): the reference tables Gumbai never pulled. All TIMELESS →
// pass the gate for both audiences. The headline: "which city was the July 2026 basho in" now answers.
console.log('\n[12] query_basho / query_glossary / query_library + schema/7 profile fields');
const SNAP_REF = {
  meta:{ basho:'Aki 2026', bashoId:'202609', maxDay:2 },
  rikishi:[
    { name:'Onosato', country:'Japan', nicknames:[], story:'The Wall arrived fast.', debut:'2023-05-01', retirement:null, pastMawashi:'gold', family:[] },
    { name:'Asanoryu', country:'Japan', nicknames:[], family:['Asasuiryu'] },   // brothers
  ],
  banzuke:[ { name:'Onosato', rank:'Yokozuna', weightKg:191 } ],
  kimarite:[{ name:'yorikiri', description:'force out' }],
  bouts:[],
  master:[],
  bashos:[
    { code:'202607', tournamentName:'2026 July - Nagoya', basho:'Nagoya', year:2026, location:'IG Arena - Nagoya', startDate:'2026-07-12', endDate:'2026-07-26' },
    { code:'202609', tournamentName:'2026 September - Aki', basho:'Aki', year:2026, location:'Ryogoku Kokugikan - Tokyo', startDate:'2026-09-13', endDate:'2026-09-27' },
    { code:'202511', tournamentName:'2025 November - Kyushu', basho:'Kyushu', year:2025, location:'Fukuoka Kokusai -Kyushu', startDate:'2025-11-09', endDate:'2025-11-23' },
  ],
  glossary:[
    { term:'gunbai', definition:"the referee's war-paddle", type:'term' },
    { term:'kachikoshi', definition:'a winning record (8+ wins)', type:'term' },
  ],
  library:[
    { title:'The Big Book of Sumo', author:'Sharnoff', year:1993, themes:['History','Culture'], notes:'a classic' },
  ],
  days:[], injuries:[], catchphrases:[], history:{ meta:{}, basho:{} }, upcoming:null,
};
const refM = gateSnapshot(SNAP_REF, 2, false, 'member');
const refP = gateSnapshot(SNAP_REF, 2, false, 'public');
t('reference lanes pass the gate for BOTH audiences (timeless)', () =>
  assert(refM.bashos.length===3 && refP.bashos.length===3 && refM.glossary.length===2 && refP.glossary.length===2 && refM.library.length===1 && refP.library.length===1));
// THE headline: MJ's exact question.
t('query_basho "July 2026" -> Nagoya, IG Arena - Nagoya (the exact MJ question)', () => {
  const o = runTool('query_basho', {which:'July 2026'}, refM);
  assert(o.found && o.count===1 && o.bashos[0].city==='IG Arena - Nagoya' && o.bashos[0].basho==='Nagoya');
});
t('query_basho handles the full-sentence form too', () => {
  const o = runTool('query_basho', {which:'which city was the July 2026 basho in'}, refM);
  assert(o.found && o.bashos[0].city==='IG Arena - Nagoya');
});
t('query_basho by name / by code / by year', () => {
  assert(runTool('query_basho', {which:'Aki'}, refM).bashos.some(b=>b.city==='Ryogoku Kokugikan - Tokyo'));
  assert(runTool('query_basho', {which:'202511'}, refM).bashos[0].basho==='Kyushu');
  assert(runTool('query_basho', {which:'2025'}, refM).bashos.every(b=>b.year===2025));
});
t('query_basho (no arg) lists every basho with city + dates', () => {
  const o = runTool('query_basho', {}, refM);
  assert(o.count===3 && o.bashos.every(b=>b.city && b.startDate));
});
t('query_basho works for PUBLIC too (timeless)', () =>
  assert(runTool('query_basho', {which:'Nagoya 2026'}, refP).bashos[0].city==='IG Arena - Nagoya'));
t('query_glossary term lookup (forgiving) + list', () => {
  assert(runTool('query_glossary', {term:'gunbai'}, refM).entry.definition.includes('war-paddle'));
  assert(runTool('query_glossary', {}, refM).count===2);
  assert(runTool('query_glossary', {term:'nope'}, refM).found===false);
});
t('query_library lists cite-approved books + theme filter', () => {
  assert(runTool('query_library', {}, refM).count===1);
  assert(runTool('query_library', {theme:'History'}, refM).books[0].title==='The Big Book of Sumo');
});
t('query_rikishi surfaces schema/7 fields (story, debut, family)', () => {
  const r = runTool('query_rikishi', {name:'Onosato'}, refM);
  assert(r.story && r.debut==='2023-05-01' && r.pastMawashiColors==='gold');
  const a = runTool('query_rikishi', {name:'Asanoryu'}, refM);
  assert(a.family && a.family.includes('Asasuiryu'));
});
t('the three reference tools are registered + public', () => {
  for(const n of ['query_basho','query_glossary','query_library'])
    assert(TOOLS.some(x=>x.name===n) && toolsFor('public').some(x=>x.name===n));
});

// ═══ 13. INJURY CARRY-OVER (schema/8) — last basho's injuries stay real until the viewer's Day 1 ═══
// Jennie's rule: a condition left open last basho is presumed real through the intertournament gap
// and EXPIRES once the viewer has watched Day 1 (then the live board governs). Prior basho = history,
// so this is spoiler-safe; the current-basho gate is untouched. Injuries stay members-only.
console.log('\n[13] Injury carry-over (prior-basho, pre-Day-1)');
const SNAP_INJ = {
  meta:{ basho:'Aki 2026', bashoId:'202609', maxDay:15 },
  rikishi:[ {name:'Aonishiki', nicknames:[]}, {name:'Onosato', nicknames:[]} ],
  banzuke:[ {name:'Aonishiki', rank:'Ozeki', weightKg:150}, {name:'Onosato', rank:'Yokozuna', weightKg:191} ],
  kimarite:[], bouts:[], master:[], bashos:[], glossary:[], library:[],
  injuries:[
    // carry-only: last basho's (Nagoya) foot, never re-stamped this basho
    { rikishi:'Aonishiki', area:'left foot', nature:['chronic'], status:'Active',
      onsetDay:99, fullMaxDay:99, severity:[],
      priorCarry:{ basho:'Nagoya 2026', status:'Active', note:'26NgD12 still favoring the foot' } },
    // current-basho condition (onset Day 3) that ALSO carried from last basho
    { rikishi:'Onosato', area:'shoulder', nature:['chronic'], status:'Active', condition:'Onosato — shoulder',
      officialReason:null, boothRead:'rotator cuff', scorekeeperEye:null, source:[],
      onsetDay:3, fullMaxDay:5,
      severity:[{day:3,text:'26AkD3 tweaked CURTOKEN3'},{day:5,text:'26AkD5 worse CURTOKEN5'}],
      priorCarry:{ basho:'Nagoya 2026', status:'Active', note:'26NgD9 shoulder flared' } },
  ],
  days:[], catchphrases:[], history:{ basho:{} }, upcoming:null,
};
const injPre  = gateSnapshot(SNAP_INJ, 0, false, 'member');   // pre-Day-1 (intertournament / not yet watched)
const injDay1 = gateSnapshot(SNAP_INJ, 1, false, 'member');   // watched Day 1
const injDay5 = gateSnapshot(SNAP_INJ, 5, false, 'member');
const injPub  = gateSnapshot(SNAP_INJ, 0, false, 'public');
t('pre-Day-1: carry-only injury surfaces as carried, last-known status, from prior basho', () => {
  const c = injPre.injuries.find(x=>x.rikishi==='Aonishiki');
  assert(c && c.carried===true && c.fromBasho==='Nagoya 2026' && c.lastKnownStatus==='Active' && /favoring the foot/.test(c.lastNote));
});
t('pre-Day-1 carry NEVER leaks current-basho detail', () => {
  assert(!JSON.stringify(injPre.injuries).includes('CURTOKEN'));
  const o = injPre.injuries.find(x=>x.rikishi==='Onosato');
  assert(o && o.carried===true && o.officialReason===undefined && o.severity===undefined);   // carried shape is minimal
});
t('query_condition pre-Day-1 finds the carried foot', () => {
  const r = runTool('query_condition', {name:'Aonishiki'}, injPre);
  assert(r.found && r.conditions[0].carried===true);
});
t('EXPIRES at Day 1: carry-only injury is gone once the viewer has watched Day 1', () => {
  assert(!injDay1.injuries.find(x=>x.rikishi==='Aonishiki'));           // expired, and no current activity
  assert(runTool('query_condition', {name:'Aonishiki'}, injDay1).found===false);
});
t('current-basho board untouched: Onosato hidden pre-onset (Day 1), full detail once caught up (Day 5)', () => {
  assert(!injDay1.injuries.find(x=>x.rikishi==='Onosato'));            // onset Day 3 > gate 1, not yet in view
  const o5 = injDay5.injuries.find(x=>x.rikishi==='Onosato');
  assert(o5 && o5.caughtUp===true && o5.officialReason!==undefined);   // live board, day-gated as before
  assert(JSON.stringify(injDay5.injuries).includes('CURTOKEN5'));      // current detail shows once watched
});
t('carry is MEMBER-ONLY (public view strips injuries entirely)', () => {
  assert((injPub.injuries||[]).length===0 && !JSON.stringify(injPub).includes('favoring the foot'));
});

// ═══ 14. ANALYTICS LAYER (schema/9) — registry-driven dimensions + cross-table measures ═══
// The general consolidation layer that replaces the hard-coded field list (the thing that lost
// mawashi in the schema/6 rewrite). Proves: mawashi + every profile dimension resolve; cross-table
// measures (wins/kinboshi/henka/weight by stable/country) compute correctly and are SPOILER-GATED
// over the bouts; a brand-new dimension supplied ONLY in snapshot.analytics works with no engine
// change (the anti-whack-a-mole property); audience gating on member-only dims/measures; and a
// canary that fails loudly if an anchor dimension ever silently drops again.
console.log('\n[14] Analytics layer — registry-driven dimensions + cross-table measures');
const SNAP_AN = {
  meta:{ basho:'Aki 2026', bashoId:'202609', maxDay:15 },
  rikishi:[
    { name:'Onosato',      nicknames:[], stable:'Nishonoseki', country:'Japan',    mawashi:'navy blue',   heightCm:192, birthday:'2000-06-07', knownFor:['Powerhouse'], university:'NSSU' },
    { name:'Hoshoryu',     nicknames:[], stable:'Tatsunami',   country:'Mongolia', mawashi:'purple',      heightCm:187, birthday:'1999-05-22', knownFor:['Showman'],    university:null   },
    { name:'Kirishima',    nicknames:[], stable:'Tatsunami',   country:'Mongolia', mawashi:'deep purple', heightCm:186, birthday:'1996-04-08', knownFor:[],             university:null   },
    { name:'Wakatakakage', nicknames:[], stable:'Arashio',     country:'Japan',    mawashi:'royal blue',  heightCm:182, birthday:'1994-12-05', knownFor:['Technician'], university:'NSSU' },
  ],
  banzuke:[
    { name:'Onosato', rank:'Yokozuna', weightKg:191 }, { name:'Hoshoryu', rank:'Maegashira 1', weightKg:151 },
    { name:'Kirishima', rank:'Maegashira 2', weightKg:162 }, { name:'Wakatakakage', rank:'Maegashira 3', weightKg:137 },
  ],
  kimarite:[],
  bouts:[
    { day:1, winner:'Onosato',      loser:'Hoshoryu',     goldStar:false, henka:null,   monoii:null,           boutOfDay:null, cushions:false },
    { day:2, winner:'Wakatakakage', loser:'Kirishima',    goldStar:true,  henka:'Full', monoii:null,           boutOfDay:null, cushions:false },
    { day:3, winner:'Hoshoryu',     loser:'Onosato',      goldStar:false, henka:null,   monoii:'Reversed (-R)',boutOfDay:'U',  cushions:true  },
    { day:8, winner:'Kirishima',    loser:'Wakatakakage', goldStar:false, henka:'Full', monoii:null,           boutOfDay:null, cushions:false },
  ],
  master:[
    { name:'Onosato', stable:'Nishonoseki', country:'Japan', highestRank:'Yokozuna', active:true },
    { name:'Hoshoryu', stable:'Tatsunami', country:'Mongolia', highestRank:'Yokozuna', active:true },
    { name:'Kirishima', stable:'Tatsunami', country:'Mongolia', highestRank:'Ozeki', active:true },
    { name:'Wakatakakage', stable:'Arashio', country:'Japan', highestRank:'Sekiwake', active:true },
  ],
  days:[], injuries:[], catchphrases:[],
  // The DATA registry: extends the engine default with a brand-new 'university' dimension. If the
  // executor honors it with NO engine change, the anti-whack-a-mole property holds.
  analytics:{
    dimensions:[ { key:'university', label:'university', field:'university', audience:'public', defaultScope:'roster', rosterOnly:true } ],
    measures:[],
  },
  history:{ basho:{} }, upcoming:null,
};
const anM   = gateSnapshot(SNAP_AN, 15, false, 'member');
const anM3  = gateSnapshot(SNAP_AN, 3, false, 'member');   // gate 3: days 1-3 only
const anM2  = gateSnapshot(SNAP_AN, 2, false, 'member');   // gate 2: days 1-2 only
const anP   = gateSnapshot(SNAP_AN, 15, false, 'public');

// -- mawashi: the flagship, restored and now maintenance-free --
t('mawashi groups the current roster by color family (blue 2, purple 2)', () => {
  const o = runTool('query_rollup', {field:'mawashi'}, anM);
  assert(o.found && o.groupCount===2, `expected 2 families, got ${o.groupCount}`);
  const blue = o.groups.find(g=>g.value==='blue'), purple = o.groups.find(g=>g.value==='purple');
  assert(blue && blue.count===2 && blue.members.includes('Onosato') && blue.members.includes('Wakatakakage'), 'navy + royal fold to blue');
  assert(purple && purple.count===2 && purple.members.includes('Kirishima'), 'deep purple folds to purple');
});
t('mawashi value=blue folds navy/royal into the blue family', () => {
  const o = runTool('query_rollup', {field:'mawashi', value:'blue'}, anM);
  assert(o.found && o.count===2);
});
t('mawashi is PUBLIC + reachable via belt/color aliases', () => {
  assert(runTool('query_rollup', {field:'mawashi'}, anP).found===true);
  assert(runTool('query_rollup', {field:'belt'}, anM).found===true);
  assert(runTool('query_rollup', {field:'color'}, anM).found===true);
});

// -- cross-table measures: group by one table's dimension, compute over the bouts --
t('wins by stable (Tatsunami 2, Nishonoseki 1, Arashio 1) at gate 15', () => {
  const o = runTool('query_rollup', {field:'stable', measure:'wins'}, anM);
  assert(o.found && o.measure==='wins' && o.agg==='sum');
  const by = Object.fromEntries(o.groups.map(g=>[g.value, g.metric]));
  assert(by.Tatsunami===2 && by.Nishonoseki===1 && by.Arashio===1, JSON.stringify(by));
  assert(o.groups[0].value==='Tatsunami', 'ranked by metric desc');
});
t('wins by stable are SPOILER-GATED: Tatsunami has 0 through gate 2 (its wins are days 3 & 8)', () => {
  const o2 = runTool('query_rollup', {field:'stable', measure:'wins'}, anM2);
  const tat = o2.groups.find(g=>g.value==='Tatsunami');
  assert(!tat || tat.metric===0, 'Tatsunami wins must not count days beyond the gate');
  const o15 = runTool('query_rollup', {field:'stable', measure:'wins'}, anM);
  assert(o15.groups.find(g=>g.value==='Tatsunami').metric===2, 'full count at gate 15');
});
t('kinboshi by stable: Arashio 1 (Wakatakakage day 2), attributed to the winner', () => {
  const o = runTool('query_rollup', {field:'stable', measure:'kinboshi'}, anM);
  const by = Object.fromEntries(o.groups.map(g=>[g.value, g.metric]));
  assert(by.Arashio===1 && (by.Tatsunami||0)===0 && (by.Nishonoseki||0)===0, JSON.stringify(by));
});
t('henka by country: Japan 1 (Wakatakakage) + Mongolia 1 (Kirishima), winner-attributed', () => {
  const o = runTool('query_rollup', {field:'country', measure:'henka'}, anM);
  const by = Object.fromEntries(o.groups.map(g=>[g.value, g.metric]));
  assert(by.Japan===1 && by.Mongolia===1, JSON.stringify(by));
});
t('avg weight by stable: Tatsunami 156.5, Nishonoseki 191, Arashio 137', () => {
  const o = runTool('query_rollup', {field:'stable', measure:'weight', agg:'avg'}, anM);
  const by = Object.fromEntries(o.groups.map(g=>[g.value, g.metric]));
  assert(by.Tatsunami===156.5 && by.Nishonoseki===191 && by.Arashio===137, JSON.stringify(by));
});
t('measure value-filter returns one group with its metric', () => {
  const o = runTool('query_rollup', {field:'stable', measure:'wins', value:'Tatsunami'}, anM);
  assert(o.found && o.value==='Tatsunami' && o.metric===2 && o.members.length===2);
});

// -- the anti-whack-a-mole property: a dimension declared ONLY in the data registry works --
t('a brand-new dimension supplied only in snapshot.analytics resolves with NO engine change', () => {
  const o = runTool('query_rollup', {field:'university'}, anM);
  assert(o.found && o.groups[0].value==='NSSU' && o.groups[0].count===2 && o.groups[0].members.includes('Onosato'));
});

// -- audience gating on the analytics layer --
t('member-only dimension knownFor: public blocked, member allowed', () => {
  assert(runTool('query_rollup', {field:'knownFor'}, anP).found===false);
  assert(runTool('query_rollup', {field:'knownFor'}, anM).found===true);
});
t('member-only measure cushions: public blocked, member computes it', () => {
  assert(runTool('query_rollup', {field:'stable', measure:'cushions'}, anP).found===false);
  const o = runTool('query_rollup', {field:'stable', measure:'cushions'}, anM);   // day-3 cushions: Hoshoryu(Tatsunami) beat Onosato(Nishonoseki), attribution 'either'
  const by = Object.fromEntries(o.groups.map(g=>[g.value, g.metric]));
  assert(by.Tatsunami===1 && by.Nishonoseki===1, JSON.stringify(by));
});
t('public CAN still do the public measures (wins by stable)', () => {
  const o = runTool('query_rollup', {field:'stable', measure:'wins'}, anP);
  assert(o.found && o.groups.find(g=>g.value==='Tatsunami').metric===2);
});
t('unknown measure is rejected cleanly (defers, does not fabricate)', () => {
  assert(runTool('query_rollup', {field:'stable', measure:'salt throws'}, anM).found===false);
});

// -- THE CANARY: the anchor dimensions must never silently vanish again (the mawashi regression) --
t('CANARY: anchor dimensions mawashi/stable/country all resolve from the engine default', () => {
  const bare = gateSnapshot({ ...SNAP_AN, analytics:null }, 15, false, 'member');   // no data registry at all
  for(const dim of ['mawashi','stable','country']){
    const o = runTool('query_rollup', {field:dim}, bare);
    assert(o.found === true, `anchor dimension "${dim}" did not resolve — the mawashi-loss regression is back`);
  }
});

// ═══ 15. CARD LAYER (schema/10) — matchups ungated for ANY published day; results stay gated ═══
// Jennie's rule: "matchups do not need to be gated, results do." A card (pairings) is result-free, so
// query_upcoming serves ANY published day (past, current, or next), defaulting to the VIEWER's own
// next day (gate+1) — fixing the quirk where a delayed viewer got the tournament's next REAL card
// (further ahead than their next day) and could never get their actual next day. RESULTS remain gated
// in query_match_log. Plus the real-world `today` anchor lands in the prompt (the model has no clock).
console.log('\n[15] Card layer — ungated matchups (any published day) + gate+1 default + today anchor');
const SNAP_CARD = {
  meta:{ basho:'Aki 2026', bashoId:'202609', maxDay:9 },   // crew synced/watched through Day 9
  rikishi:[ {name:'Aonishiki',nicknames:[]}, {name:'Takanosho',nicknames:[]}, {name:'Onosato',nicknames:[]}, {name:'Hoshoryu',nicknames:[]} ],
  banzuke:[ {name:'Aonishiki',rank:'Ozeki',weightKg:150}, {name:'Takanosho',rank:'Maegashira 4',weightKg:160}, {name:'Onosato',rank:'Yokozuna',weightKg:191}, {name:'Hoshoryu',rank:'Yokozuna',weightKg:151} ],
  kimarite:[], bouts:[ {day:9,winner:'Onosato',loser:'Hoshoryu',kimarite:'yorikiri'} ],
  master:[], days:[], injuries:[], catchphrases:[], history:{ basho:{} },
  // the tournament's next REAL scheduled card = Day 11 (the old single-card behavior would hand this out)
  upcoming:{ meta:{}, day:11, date:'2026-09-23', matchups:[ {eastName:'Aonishiki',eastRank:'O',westName:'Takanosho',westRank:'M4'} ] },
  // every PUBLISHED day's result-free pairings, keyed by day (string keys, as JSON stores them)
  cards:{
    '10': { day:10, date:'2026-09-22', matchups:[ {eastName:'Aonishiki',eastRank:'O',westName:'Onosato',westRank:'Y'}, {eastName:'Hoshoryu',eastRank:'Y',westName:'Takanosho',westRank:'M4'} ] },
    '11': { day:11, date:'2026-09-23', matchups:[ {eastName:'Aonishiki',eastRank:'O',westName:'Takanosho',westRank:'M4'} ] },
    '12': { day:12, date:'2026-09-24', matchups:[ {eastName:'Onosato',eastRank:'Y',westName:'Aonishiki',westRank:'O'} ] },
  },
  today:{ date:'2026-09-22', tournamentDay:10 },
};
const cardM = gateSnapshot(SNAP_CARD, 9, false, 'member');   // watched through Day 9
const cardP = gateSnapshot(SNAP_CARD, 9, false, 'public');
t('default (no day) returns the VIEWER\'s next day (Day 10), not the tournament\'s next real card (Day 11)', () => {
  const o = runTool('query_upcoming', {}, cardM);
  assert(o.available && o.day===10 && o.isYourNextDay===true, `expected Day 10, got ${o.day}`);
  assert(o.matchups.some(m => m.east==='Aonishiki' && m.west==='Onosato'));
});
t('ANY published day is servable even far past the gate (Day 12 to a Day-9 viewer) — matchups are ungated', () => {
  const o = runTool('query_upcoming', {day:12}, cardM);
  assert(o.available && o.day===12 && o.matchups.length===1, 'Day 12 card must come back');
  assert(o.isYourNextDay===false);
});
t('a card carries NO result field (structural firewall: pairings only)', () => {
  const o = runTool('query_upcoming', {day:10}, cardM);
  for(const m of o.matchups){
    assert(!('winner' in m) && !('loser' in m) && !('kimarite' in m) && !('result' in m), 'card matchup leaked a result field');
    assert('east' in m && 'west' in m);
  }
});
t('RESULTS stay gated even though the card is open: match_log Day 10 is empty at gate 9', () => {
  assert(runTool('query_match_log', {day:10}, cardM).bouts.length===0);
  assert(runTool('query_match_log', {day:9}, cardM).bouts.length===1);   // watched day still returns its result
});
t('an unpublished future day (Day 13, not in cards) returns available:false', () => {
  const o = runTool('query_upcoming', {day:13}, cardM);
  assert(o.available===false && o.requestedDay===13);
});
t('name filter narrows a card to one wrestler', () => {
  const o = runTool('query_upcoming', {day:10, name:'Onosato'}, cardM);
  assert(o.available && o.matchups.length===1 && (o.matchups[0].east==='Onosato' || o.matchups[0].west==='Onosato'));
});
t('cards are PUBLIC too (a matchup is not member-only)', () => {
  assert(runTool('query_upcoming', {day:12}, cardP).available===true);
  assert(runTool('query_upcoming', {}, cardP).day===10);
});
t('REAL-WORLD TODAY anchor lands in the prompt with the tournament day + next-unwatched day', () => {
  const p = buildSystemPrompt(cardM, 'member');
  assert(/REAL-WORLD TODAY/.test(p), 'today anchor missing');
  assert(/Day 10/.test(p), 'should name the real tournament day (10)');
  assert(/2026-09-22/.test(p), 'should name the calendar date');
});
t('back-compat: a snapshot with only `upcoming` (no cards map) still answers via fallback', () => {
  const legacy = gateSnapshot({ ...SNAP_CARD, cards:null, today:null }, 9, false, 'member');
  const o = runTool('query_upcoming', {}, legacy);   // no gate+1 card available -> falls back to the single next card
  assert(o.available===true && o.day===11);
  assert(!/REAL-WORLD TODAY/.test(buildSystemPrompt(legacy, 'member')));   // no today -> no anchor (no crash)
});
t('caught-up viewer: next-day card served when published, honest available:false when their next day is not out yet', () => {
  // maxDay=11 lets the viewer gate up to 11; Day 12 is NOT published (not in cards, upcoming empty).
  const S = { ...SNAP_CARD, meta:{ ...SNAP_CARD.meta, maxDay:11 },
    upcoming:{ empty:true, day:12 },
    cards:{ '10':SNAP_CARD.cards['10'], '11':SNAP_CARD.cards['11'] } };
  assert(runTool('query_upcoming', {}, gateSnapshot(S, 10, false, 'member')).day===11);           // gate+1=11, present
  assert(runTool('query_upcoming', {}, gateSnapshot(S, 11, false, 'member')).available===false);  // gate+1=12, not published -> honest no
});

// ═══ 16. HISTORY-SPANNING analytics (schema/11) + query_rate + units ═══
// Jennie's north star: "gumbai needs to glean and speak to ALL the historical information ... and do
// on-the-fly analysis." The measures were fenced to the current basho only because the snapshot pulled
// only the current tournament's bouts. Now a `crewHistory` lane (past crew-logged bouts WITH nets,
// ungated) + `span` let the measures reach the whole tracked history; the current basho stays gated.
console.log('\n[16] History-spanning analytics + query_rate + units');
const SNAP_HIST = {
  meta:{ basho:'Aki 2026', bashoId:'202609', maxDay:9 },
  rikishi:[
    { name:'Onosato', nicknames:[], stable:'Nishonoseki', country:'Japan', heightCm:192, birthday:'2000-06-07' },
    { name:'Hoshoryu', nicknames:[], stable:'Tatsunami', country:'Mongolia', heightCm:187, birthday:'1999-05-22' },
    { name:'Wakatakakage', nicknames:[], stable:'Arashio', country:'Japan', heightCm:182, birthday:'1994-12-05' },
  ],
  banzuke:[ { name:'Onosato', rank:'Yokozuna', weightKg:191 }, { name:'Hoshoryu', rank:'Yokozuna', weightKg:151 }, { name:'Wakatakakage', rank:'Maegashira 3', weightKg:137 } ],
  kimarite:[],
  bouts:[  // current basho, gated
    { day:3, winner:'Onosato', loser:'Hoshoryu', kimarite:'yorikiri', henka:null, goldStar:false, cushions:false, boutOfDay:null },
    { day:5, winner:'Hoshoryu', loser:'Wakatakakage', kimarite:'hatakikomi', henka:'Full', goldStar:false, cushions:false, boutOfDay:null },
  ],
  master:[
    { name:'Onosato', stable:'Nishonoseki', country:'Japan', highestRank:'Yokozuna', active:true },
    { name:'Hoshoryu', stable:'Tatsunami', country:'Mongolia', highestRank:'Yokozuna', active:true },
    { name:'Wakatakakage', stable:'Arashio', country:'Japan', highestRank:'Sekiwake', active:true },
  ],
  crewHistory:[  // past crew-tracked basho, WITH the crew's live nets — the fenced-off data
    { basho:'Nagoya 2026', day:2, winner:'Hoshoryu', loser:'Onosato', kimarite:'hatakikomi', henka:'Full', goldStar:false, cushions:true, boutOfDay:'U' },
    { basho:'Nagoya 2026', day:7, winner:'Wakatakakage', loser:'Hoshoryu', kimarite:'tsukiotoshi', henka:'Full', goldStar:true },
    { basho:'Nagoya 2026', day:9, winner:'Onosato', loser:'Wakatakakage', kimarite:'yorikiri', henka:null, goldStar:false },
  ],
  history:{ basho:{ '202605':{ label:'Natsu 2026', rikishi:[], yusho:[], bouts:[  // sumo-api backfill, hard only (no nets)
    { day:1, winner:'Onosato', loser:'Hoshoryu', kimarite:'oshidashi', goldStar:false },
    { day:3, winner:'Hoshoryu', loser:'Wakatakakage', kimarite:'yorikiri', goldStar:true },
  ] } } },
  days:[], injuries:[], catchphrases:[], upcoming:null,
};
const hM9 = gateSnapshot(SNAP_HIST, 9, false, 'member');
const hM2 = gateSnapshot(SNAP_HIST, 2, false, 'member');
const hP9 = gateSnapshot(SNAP_HIST, 9, false, 'public');
t('span default (basho) is current-only; span:all reaches the whole logged history (henka by stable)', () => {
  const curBy = Object.fromEntries(runTool('query_rollup', {field:'stable', measure:'henka'}, hM9).groups.map(g=>[g.value,g.metric]));
  assert((curBy.Tatsunami||0)===1 && (curBy.Arashio||0)===0, 'current-basho henka: '+JSON.stringify(curBy));
  const all = runTool('query_rollup', {field:'stable', measure:'henka', span:'all'}, hM9);
  const allBy = Object.fromEntries(all.groups.map(g=>[g.value,g.metric]));
  assert(all.span==='all' && allBy.Tatsunami===2 && allBy.Arashio===1, 'career henka: '+JSON.stringify(allBy));
});
t('the current basho STAYS gated inside a span:all query (wins by stable differ at gate 2 vs 9)', () => {
  const by9 = Object.fromEntries(runTool('query_rollup', {field:'stable', measure:'wins', span:'all'}, hM9).groups.map(g=>[g.value,g.metric]));
  assert(by9.Nishonoseki===3 && by9.Tatsunami===3 && by9.Arashio===1, 'gate9: '+JSON.stringify(by9));
  const by2 = Object.fromEntries(runTool('query_rollup', {field:'stable', measure:'wins', span:'all'}, hM2).groups.map(g=>[g.value,g.metric]));
  assert(by2.Nishonoseki===2 && by2.Tatsunami===2, 'gate2 must drop the ungated current bouts: '+JSON.stringify(by2));
});
t('kinboshi spans BOTH the crew history and the sumo-api backfill (goldStar exists in both)', () => {
  const by = Object.fromEntries(runTool('query_rollup', {field:'stable', measure:'kinboshi', span:'all'}, hM9).groups.map(g=>[g.value,g.metric]));
  assert(by.Arashio===1 && by.Tatsunami===1, 'kinboshi all-time: '+JSON.stringify(by));   // Wakatakakage (crew) + Hoshoryu (backfill)
});
t('henka does NOT falsely span the sumo-api backfill (no henka field there) — crew-logged basho only', () => {
  const by = Object.fromEntries(runTool('query_rollup', {field:'stable', measure:'henka', span:'history'}, hM9).groups.map(g=>[g.value,g.metric]));
  assert((by.Tatsunami||0)===1 && (by.Arashio||0)===1, 'past-only henka: '+JSON.stringify(by));
});
t('query_rate: a wrestler\'s henka rate vs the field average, career-spanning by default', () => {
  const o = runTool('query_rate', {name:'Hoshoryu', metric:'henka'}, hM9);
  // henka's field baseline is the crew-logged bouts only (the backfill has no henka to average), so
  // Hoshoryu is 2-in-4 (2 current + 2 crew-history), not counting the net-less sumo-api bouts.
  assert(o.found && o.count===2 && o.bouts===4, JSON.stringify(o));
  assert(o.rate>0 && o.fieldRate>0 && typeof o.ratio==='number' && typeof o.vsField==='string');
});
t('query_rate defers on a raw-total metric (wins) — that is a rollup/leaderboard job', () => {
  assert(runTool('query_rate', {name:'Onosato', metric:'wins'}, hM9).found===false);
});
t('crewHistory is UNGATED (past = not a spoiler) but PUBLIC still loses the member nets', () => {
  assert(Array.isArray(hM9.crewHistory) && hM9.crewHistory.length===3);
  const memBout = hM9.crewHistory.find(b=>b.day===2);
  assert(memBout.cushions===true && memBout.boutOfDay==='U');
  const pubBout = hP9.crewHistory.find(b=>b.day===2);
  assert(pubBout.cushions===undefined && pubBout.boutOfDay===undefined && pubBout.henka==='Full');
});
t('member-only rate (cushions) blocked for public, allowed for member', () => {
  assert(runTool('query_rate', {name:'Hoshoryu', metric:'cushions'}, hP9).found===false);
  assert(runTool('query_rate', {name:'Onosato', metric:'cushions', span:'all'}, hM9).found===true);
});
t('UNITS: query_rikishi returns both systems; prompt leads standard by default, metric when set', () => {
  const r = runTool('query_rikishi', {name:'Onosato'}, hM9);
  assert(r.heightCm===192 && r.heightImperial==="6'4\"" && r.weightKg===191 && r.weightLb===421, JSON.stringify({h:r.heightImperial, w:r.weightLb}));
  assert(/STANDARD units/.test(buildSystemPrompt(hM9, 'member')));
  const metricView = gateSnapshot(SNAP_HIST, 9, false, 'member'); metricView.units = 'metric';
  assert(/METRIC \(centimeters/.test(buildSystemPrompt(metricView, 'member')));
});

// ═══ 17. Head-to-head + career span crewHistory (the most-recent basho before gen-history reruns) ═══
// The bug (2026-09-22): historyH2H / careerFor read ONLY the frozen sumo-api `history` lane, so a
// just-completed basho that lives only in the Notion Match Log (`crewHistory`) was invisible — AO's
// Nagoya-2026 win over Onosato showed as 0-fought. Fix: read BOTH lanes, static lane owns its basho,
// crewHistory fills any basho the static lane hasn't rolled forward yet, deduped so nothing counts twice.
console.log('\n[17] Head-to-head + career span crewHistory (no double-count with the static lane)');
t('head-to-head now includes the most-recent basho that lives ONLY in crewHistory (Nagoya 2026)', () => {
  // static `history` lane (Natsu 2026): Onosato beat Hoshoryu once. crewHistory (Nagoya 2026): Hoshoryu
  // beat Onosato once. So the PAST rivalry is 2 meetings, split 1-1 — Nagoya 2026 was invisible before.
  const h = runTool('query_match_log', {rikishi:'Onosato', opponent:'Hoshoryu'}, hM9).historicalHeadToHead;
  assert(h.meetings===2, 'expected 2 past meetings incl. Nagoya 2026, got '+JSON.stringify(h));
  assert(h.Onosato===1 && h.Hoshoryu===1, 'past rivalry should be 1-1: '+JSON.stringify(h));
  assert(h.bouts.some(b=>b.basho==='Nagoya 2026'), 'the Nagoya 2026 meeting must be present');
  assert(h.bouts.some(b=>b.basho==='Natsu 2026'), 'the static-lane Natsu 2026 meeting must still be present');
});
t('head-to-head does NOT double-count a basho present in BOTH lanes (static lane owns it)', () => {
  const dupe = { ...SNAP_HIST, crewHistory:[ ...SNAP_HIST.crewHistory,
    { basho:'Natsu 2026', day:1, winner:'Onosato', loser:'Hoshoryu', kimarite:'oshidashi', goldStar:false } ] };
  const g = gateSnapshot(dupe, 9, false, 'member');
  const h = runTool('query_match_log', {rikishi:'Onosato', opponent:'Hoshoryu'}, g).historicalHeadToHead;
  assert(h.meetings===2 && h.Onosato===1 && h.Hoshoryu===1, 'a basho in both lanes was double-counted: '+JSON.stringify(h));
});
t('the CURRENT basho stays out of the historical bucket (still gated + reported separately)', () => {
  // Aki Day 3 Onosato beat Hoshoryu is in `bouts`, so it belongs to headToHead ("this basho only"),
  // NOT historicalHeadToHead — crewHistory never carries the current basho, so no leak, no double.
  const o = runTool('query_match_log', {rikishi:'Onosato', opponent:'Hoshoryu'}, hM9);
  assert(o.headToHead.note==='this basho only' && o.headToHead.meetings===1, JSON.stringify(o.headToHead));
  assert(!o.historicalHeadToHead.bouts.some(b=>b.basho==='Aki 2026'), 'current basho leaked into history');
});
t('career readout spans crewHistory: Nagoya 2026 appears in perBasho, tallied from the Match Log', () => {
  // Hoshoryu in Nagoya 2026 (crewHistory): beat Onosato (W, day2), lost to Wakatakakage (L, day7) => 1-1.
  const c = runTool('query_career', {name:'Hoshoryu'}, hM9);
  const ng = c.perBasho.find(p=>p.basho==='Nagoya 2026');
  assert(ng && ng.record==='1-1' && ng.fromMatchLog===true && ng.final===true, 'Nagoya 2026 career line missing/wrong: '+JSON.stringify(c.perBasho));
});

// ═══ 18. Today anchor NAMES the current basho (kills the past-basho drift) ═══
// The slip (2026-09-22): a long chat about a PAST basho made the model call that past tournament "the
// one in progress" — the date came through right but the basho name was confabulated. Fix: state the
// current basho (meta.basho) as a FACT in the real-world-today line so it is never inferred.
console.log('\n[18] Today anchor names the current basho as a fact');
t('with a today anchor: the prompt states the basho in progress by name', () => {
  const p = buildSystemPrompt(cardM, 'member');   // SNAP_CARD has today + meta.basho = "Aki 2026"
  assert(/REAL-WORLD TODAY/.test(p), 'today anchor missing');
  assert(/basho in progress is Aki 2026/.test(p), 'today line should name the current basho: not found');
});
t('no today anchor but a known basho: still states the current basho, full stop', () => {
  const p = buildSystemPrompt(hM9, 'member');   // SNAP_HIST has meta.basho but no `today`
  assert(/TOURNAMENT HAPPENING RIGHT NOW is Aki 2026/.test(p), 'current-basho fallback statement missing');
});
t('neither today nor a basho name: no crash, no anchor injected', () => {
  const bare = gateSnapshot({ ...SNAP_HIST, meta:{ maxDay:9 } }, 9, false, 'member');
  const p = buildSystemPrompt(bare, 'member');
  assert(!/REAL-WORLD TODAY/.test(p) && !/TOURNAMENT HAPPENING RIGHT NOW/.test(p), 'should inject nothing when both are absent');
});

// ═══ 19. Yusho derived from crewHistory — "who won the last tournament" before the roll-forward ═══
// The gap (2026-09-22): query_yusho read only the static sumo-api `history` lane, so the most-recent
// completed basho (Nagoya 2026, live-synced to Notion but not yet in that lane) had no champion — Gumbai
// couldn't say who won the last tournament. Fix (Jennie: "gumbai should be able to grab it from there"):
// derive the champion from crewHistory (top win-count), honest about a playoff tie, no double-listing.
console.log('\n[19] Yusho derived from crewHistory (most-recent completed basho before the roll-forward)');
const SNAP_YU = {
  meta:{ basho:'Aki 2026', bashoId:'202609', maxDay:9 },
  rikishi:[ {name:'Onosato',nicknames:[]}, {name:'Hoshoryu',nicknames:[]}, {name:'Kirishima',nicknames:[]} ],
  banzuke:[ {name:'Onosato',rank:'Yokozuna',weightKg:191}, {name:'Hoshoryu',rank:'Yokozuna',weightKg:151}, {name:'Kirishima',rank:'Ozeki',weightKg:166} ],
  kimarite:[], bouts:[], master:[],
  crewHistory:[  // Nagoya 2026 (past, NOT in the static lane): Onosato 3 wins, Hoshoryu 1 -> clean solo yusho
    { basho:'Nagoya 2026', day:1, winner:'Onosato', loser:'Hoshoryu', kimarite:'yorikiri' },
    { basho:'Nagoya 2026', day:2, winner:'Onosato', loser:'Kirishima', kimarite:'oshidashi' },
    { basho:'Nagoya 2026', day:3, winner:'Onosato', loser:'Hoshoryu', kimarite:'yorikiri' },
    { basho:'Nagoya 2026', day:4, winner:'Hoshoryu', loser:'Kirishima', kimarite:'hatakikomi' },
  ],
  history:{ basho:{ '202605':{ label:'Natsu 2026', rikishi:[{name:'Hoshoryu',rank:'Yokozuna',wins:13,losses:2}], yusho:['Hoshoryu'], bouts:[] } } },
  days:[], injuries:[], catchphrases:[], upcoming:null,
};
const yuM = gateSnapshot(SNAP_YU, 9, false, 'member');
t('who won the last tournament: champions list leads with the DERIVED most-recent basho', () => {
  const r = runTool('query_yusho', {}, yuM);
  assert(r.champions[0].basho==='Nagoya 2026' && r.champions[0].derived===true, 'derived Nagoya 2026 should lead: '+JSON.stringify(r.champions.map(c=>c.basho)));
  assert(r.champions[0].yusho.length===1 && r.champions[0].yusho[0]==='Onosato', 'Onosato should be the derived champ: '+JSON.stringify(r.champions[0]));
  assert(r.champions.some(c=>c.basho==='Natsu 2026' && (c.yusho||[]).includes('Hoshoryu')), 'the static-lane basho still lists');
});
t('named query credits the derived (clean solo) yusho to the wrestler', () => {
  const r = runTool('query_yusho', {name:'Onosato'}, yuM);
  assert(r.yusho.includes('Nagoya 2026') && r.yushoCount>=1, JSON.stringify(r));
});
t('career yushoCount includes the derived clean yusho', () => {
  const c = runTool('query_career', {name:'Onosato'}, yuM);
  assert(c.yusho.includes('Nagoya 2026'), 'career should count the derived title: '+JSON.stringify(c.yusho));
});
t('a PLAYOFF tie in the derived basho is reported honestly, never crowned', () => {
  const tie = { ...SNAP_YU, crewHistory:[  // Onosato + Hoshoryu tie at 1 win -> playoff, unresolved from the log
    { basho:'Nagoya 2026', day:1, winner:'Onosato', loser:'Kirishima' },
    { basho:'Nagoya 2026', day:2, winner:'Hoshoryu', loser:'Kirishima' },
  ]};
  const g = gateSnapshot(tie, 9, false, 'member');
  const ng = runTool('query_yusho', {}, g).champions.find(c=>c.basho==='Nagoya 2026');
  assert(ng.playoff===true && ng.yusho.length===2, 'should flag a 2-way playoff, not crown one: '+JSON.stringify(ng));
  assert(!runTool('query_yusho', {name:'Onosato'}, g).yusho.includes('Nagoya 2026'), 'a playoff tie must NOT credit a name');
});
t('no double-listing once §3d rolls the basho into the static lane (static owns it)', () => {
  const rolled = { ...SNAP_YU, history:{ basho:{
    '202605':{ label:'Natsu 2026', rikishi:[], yusho:['Hoshoryu'], bouts:[] },
    '202607':{ label:'Nagoya 2026', rikishi:[], yusho:['Kirishima'], bouts:[] },   // rolled in, with the real (playoff-resolved) champ
  } } };
  const g = gateSnapshot(rolled, 9, false, 'member');
  const ns = runTool('query_yusho', {}, g).champions.filter(c=>c.basho==='Nagoya 2026');
  assert(ns.length===1 && !ns[0].derived && ns[0].yusho[0]==='Kirishima', 'static lane must own it, no derived dupe: '+JSON.stringify(ns));
});

console.log(`\n${'═'.repeat(48)}\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
