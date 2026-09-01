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
  meta:{ basho:'Aki 2026', bashoId:'202609', maxDay:15, schema:'gumbai-snapshot/5' },
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
t('toolsFor(member) is the full 12', () => assert(toolsFor('member').length === TOOLS.length && TOOLS.length === 12));
t('toolsFor(public) = 10, omits condition+storylines, keeps catchphrases', () => {
  const p = toolsFor('public').map(x=>x.name);
  assert(p.length===10 && !p.includes('query_condition') && !p.includes('query_storylines') && p.includes('query_catchphrases'));
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

console.log(`\n${'═'.repeat(48)}\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
