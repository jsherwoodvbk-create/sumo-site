// test-engine.mjs — spoiler-gate + soft-data unit tests for gumbai-engine v4.
// Run: node test-engine.mjs   (exits non-zero on any failure)
import assert from 'node:assert';
import { gateSnapshot, runTool, buildSystemPrompt } from './functions/api/_engine.js';

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
// A completed basho: Aonishiki won it in a playoff. Champion lives in the full snapshot; the gate
// must keep it null until the viewer is caught up to the final day (15).
const SNAP_DONE = { ...SNAP, champion:{ name:'Aonishiki', playoff:true } };
// A basho with no champion posted (mid-tournament / not complete).
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
// Member-gate sweep — the audience twin of the spoiler sweep. Seed a distinct sentinel into
// every member-only field, then prove NO public path (view, any tool, the prompt) leaks one,
// while the member path keeps them all (no regression). Pure logic, runs in Node.
import { gateSnapshot, toolsFor, runTool, buildSystemPrompt, TOOLS } from './_engine.js';

// member-only sentinels (must NEVER appear anywhere public)
const S = {
  conduct:'SENTINEL_CONDUCT', conductNote:'SENTINEL_CONDUCTNOTE', botd:'SENTINEL_BOTD',
  length:'SENTINEL_LENGTH', storyline:'SENTINEL_STORYLINE', skNotes:'SENTINEL_SKNOTES',
  condition:'SENTINEL_CONDITION', official:'SENTINEL_OFFICIAL', booth:'SENTINEL_BOOTH', skEye:'SENTINEL_SKEYE',
};
const SENTINELS = Object.values(S);

const SNAP = {
  meta:{ basho:'Aki 2026', bashoId:'202609', maxDay:15, schema:'gumbai-snapshot/5' },
  rikishi:[
    { name:'Onosato', nicknames:[{nick:'The Wall',tag:'O'}] },
    { name:'Hoshoryu', nicknames:[] },
  ],
  banzuke:[
    { name:'Onosato', rank:'Yokozuna', weightKg:191 },
    { name:'Hoshoryu', rank:'Yokozuna', weightKg:151 },
  ],
  kimarite:[{ name:'yorikiri', gloss:'force out' }],
  bouts:[
    { day:1, date:'2026-09-13', winner:'Onosato', loser:'Hoshoryu', kimarite:'yorikiri',
      goldStar:true, rematch:true,
      henka:true, monoii:true,                              // PUBLIC-allowed nets
      boutOfDay:S.botd, conduct:[S.conduct], conductNote:S.conductNote, length:S.length, cushions:true }, // member-only
  ],
  days:[{ day:1, announcer:'Murray', storylines:S.storyline, scorekeeperNotes:S.skNotes }],
  injuries:[{ rikishi:'Hoshoryu', onsetDay:1, fullMaxDay:1, area:'knee', setting:'bout',
    nature:['chronic'], severity:[{ day:1, level:'moderate' }],
    condition:S.condition, status:'ongoing', officialReason:S.official, boothRead:S.booth, scorekeeperEye:S.skEye, source:['video'] }],
  catchphrases:[{ phrase:'here comes the salt', announcer:'Murray', days:[1], giggle:3, jewel:false }],
  history:{ basho:{} },
  upcoming:{ day:2, date:'2026-09-14', matchups:[{ eastName:'Onosato', eastRank:'Y', westName:'Hoshoryu', westRank:'Y' }] },
};

let pass = 0, fail = 0;
const ok  = (name, cond) => { if(cond){ pass++; } else { fail++; console.log('  ✗ FAIL:', name); } };
const leak = (name, text) => {
  const hit = SENTINELS.filter(s => String(text).includes(s));
  ok(name + (hit.length ? ' — LEAKED ' + hit.join(',') : ''), hit.length === 0);
};

// ── tool sets ──
ok('toolsFor(member) is the full 12', toolsFor('member').length === TOOLS.length && TOOLS.length === 12);
const pubTools = toolsFor('public').map(t=>t.name);
ok('toolsFor(public) omits query_condition', !pubTools.includes('query_condition'));
ok('toolsFor(public) omits query_storylines', !pubTools.includes('query_storylines'));
ok('toolsFor(public) keeps query_catchphrases (drinking game is public)', pubTools.includes('query_catchphrases'));
ok('toolsFor(public) = 10 tools', pubTools.length === 10);

// ── views ──
const mem = gateSnapshot(SNAP, 15, false, 'member');
const pub = gateSnapshot(SNAP, 15, false, 'public');

// member view keeps everything (no regression)
ok('member view has injuries', (mem.injuries||[]).length === 1);
ok('member view has days/storylines', (mem.days||[]).length === 1);
ok('member bout keeps conduct', mem.bouts[0].conduct && mem.bouts[0].conduct[0] === S.conduct);
ok('member bout keeps length', mem.bouts[0].length === S.length);

// public view strips the member lanes
ok('public view: injuries empty', (pub.injuries||[]).length === 0);
ok('public view: days empty', (pub.days||[]).length === 0);
ok('public bout: conduct dropped', pub.bouts[0].conduct === undefined);
ok('public bout: conductNote dropped', pub.bouts[0].conductNote === undefined);
ok('public bout: boutOfDay dropped', pub.bouts[0].boutOfDay === undefined);
ok('public bout: length dropped', pub.bouts[0].length === undefined);
ok('public bout: cushions dropped', pub.bouts[0].cushions === undefined);
ok('public bout: henka KEPT', pub.bouts[0].henka === true);
ok('public bout: monoii KEPT', pub.bouts[0].monoii === true);
ok('public bout: goldStar KEPT (hard result)', pub.bouts[0].goldStar === true);
ok('public bout: rematch KEPT', pub.bouts[0].rematch === true);
ok('public view: snapshot NOT mutated (member re-read still has conduct)', gateSnapshot(SNAP,15,false,'member').bouts[0].conduct[0] === S.conduct);

// leak sweep: the whole public view must carry no sentinel
leak('public gated view JSON', JSON.stringify(pub));

// run EVERY tool over the PUBLIC view (even the member-only two, to prove they leak nothing if ever reached)
const probes = {
  query_rikishi:{name:'Hoshoryu'}, query_banzuke:{}, query_match_log:{}, query_kimarite:{},
  query_standings:{}, query_career:{name:'Onosato'}, query_yusho:{}, query_leaderboard:{},
  query_upcoming:{}, query_condition:{}, query_storylines:{}, query_catchphrases:{},
};
for(const t of TOOLS){
  const out = runTool(t.name, probes[t.name]||{}, pub);
  leak(`public runTool(${t.name})`, JSON.stringify(out));
}
// public match log must still surface henka+monoii (public color kept)
const pubML = runTool('query_match_log', {}, pub);
ok('public match_log keeps henka', pubML.bouts[0].henka === true);
ok('public match_log keeps monoii', pubML.bouts[0].monoii === true);
ok('public match_log conduct is null (stripped)', pubML.bouts[0].conduct === null);
ok('public query_rikishi conditions null', runTool('query_rikishi',{name:'Hoshoryu'},pub).conditions === null);

// public prompt: no sentinels, and no member-only tools/routing listed
const pubPrompt = buildSystemPrompt(pub, 'public');
leak('public system prompt', pubPrompt);
ok('public prompt omits query_condition from TOOLS line', !/TOOLS:[^\n]*query_condition/.test(pubPrompt));
ok('public prompt omits query_storylines from TOOLS line', !/TOOLS:[^\n]*query_storylines/.test(pubPrompt));
ok('public prompt has the AUDIENCE public block', /PUBLIC visitor/.test(pubPrompt));

// member run STILL sees the sensitive data (no regression) — sentinels SHOULD appear
const memCond = JSON.stringify(runTool('query_condition', {}, mem));
ok('member query_condition surfaces the condition sentinels', memCond.includes(S.official) && memCond.includes(S.skEye));
const memStory = JSON.stringify(runTool('query_storylines', {}, mem));
ok('member query_storylines surfaces the storyline sentinels', memStory.includes(S.storyline) && memStory.includes(S.skNotes));
const memML = JSON.stringify(runTool('query_match_log', {}, mem));
ok('member match_log surfaces the conduct sentinel', memML.includes(S.conduct));
const memPrompt = buildSystemPrompt(mem, 'member');
ok('member prompt lists query_condition in TOOLS line', /TOOLS:[^\n]*query_condition/.test(memPrompt));

console.log(`\n${fail===0 ? '✅' : '❌'} member-gate sweep: ${pass} passed, ${fail} failed`);
process.exit(fail===0 ? 0 : 1);

console.log(`\n${'═'.repeat(48)}\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
