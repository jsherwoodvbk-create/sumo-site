// fan.mjs - the color fan-out as an inspectable CI script (the keystone).
//
// DESIGN: the model EXTRACTS, this code ENFORCES the rails. The Claude API turns a
// transcript (Pass 1) or scorekeeper notes (Pass 2) into structured JSON; every Notion
// write below is deterministic code that holds the firewall, merge-never-clobber,
// idempotency, provenance, and the catchphrase/injury models. The guardrails live here,
// in code you can read and test, not in a prompt you have to trust.
//
// Runs in GitHub Actions on the Claude API (same ANTHROPIC_API_KEY Gumbai uses), so it is
// OFF the flaky Cowork scheduled-task session that hangs. Triggered event-driven by the box
// (repository_dispatch, Pass 1) or by Jennie (workflow_dispatch, Pass 2).
//
// Authoritative specs ported here: deliverables/Fan-Out Runbook v1.md,
// state/catchphrase-lane-fanout-spec.md, state/catcher-fan-lane-spec.md, state/injury-lane-backlog.md.
//
// ENV:
//   NOTION_TOKEN         (required) Notion write token, same integration as the generators
//   ANTHROPIC_API_KEY    (required unless MOCK_EXTRACTION) the key Gumbai uses
//   ANTHROPIC_MODEL      (default claude-sonnet-4-5) extraction model - quality matters here
//   MODE                 pass1 | pass2   (default pass1)
//   BASHO_LABEL          (default "Aki 2026")
//   TOURNAMENT_PAGE_ID   (default the Aki Bashos page) - scopes Days to this basho
//   DAY                  optional integer/float - process this Day # instead of "today's ready row"
//   DRY_RUN              1 = print every planned Notion write, execute NONE (safe rehearsal)
//   MOCK_EXTRACTION      path to a JSON file of the model's output - skips the API call (offline test)
//   RESEND_KEY / ALERT_EMAIL / ALERT_FROM   optional - emails the run summary (no-silent-fails)
//
// EXIT: 0 = ran clean (incl. the idempotent no-op) · 3 = a real problem (reported) · 1 = crash.

import fs from 'node:fs';
import process from 'node:process';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const NOTION_VERSION = '2022-06-28';
const ANTHROPIC_VERSION = '2023-06-01';

const MODE = (process.env.MODE || 'pass1').toLowerCase();
const BASHO_LABEL = process.env.BASHO_LABEL || 'Aki 2026';
const TOURNAMENT_PAGE_ID = (process.env.TOURNAMENT_PAGE_ID || '3351ade1-241f-8011-8987-d959538f54a0');
const DAY_OVERRIDE = process.env.DAY ? Number(process.env.DAY) : null;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const MOCK_EXTRACTION = process.env.MOCK_EXTRACTION || null;

// DATABASE ids (REST /databases/{id}/query + parent for creates). From the Fan-Out Runbook.
const DB = {
  days:       'eb0597c9-7259-49cd-babb-889f3b28f33d',
  announcers: '0dff86b0-5a19-462f-a5ef-10f46af12e5a',
  library:    '4d95409b-12f5-45ca-bc4d-b308c94f7576',
  sightings:  'a3cd5904-e534-45be-bf2d-cf4c46ea3b4f',
  catcher:    '0caf1338-72e8-4097-acfb-905af5b1d9f1',   // crew ear-grab intake (write-in / jewel-vote / flag)
  injuries:   '7a44f06d-389d-4bd6-aa84-314225d06085',
  rikishi:    'ca79ecbb-4c56-45eb-b353-3dd33031c7d9',
};

// Canonical announcer roster - only ever CREATE a genuinely new voice.
const ROSTER = ['Hiro Morita', 'Murray Johnson', 'John Gunning', 'Ross Mihara', 'Raja Pradhan'];

const warn = [];   // accumulates report lines; a non-empty "problem" warn -> exit 3
const log  = [];   // accumulates the human run summary
const spend = { in: 0, out: 0, usd: 0, model: ANTHROPIC_MODEL };
let CREDIT_DRY = false;   // set true if the API says credit balance is too low -> LOUD alert

function note(line) { log.push(line); console.log(line); }
function problem(line) { warn.push(line); console.error('  ! ' + line); }

// per-million-token USD, keyed by model substring (Sep 2026 list prices). Update if pricing moves.
// This is a COST ECHO, not a balance read - Anthropic exposes no remaining-balance API. It shows what
// each run spent so the burn rate is visible. The wallet stays CAPPED/prepaid on purpose (that cap is
// what protects public-facing Gumbai on the shared key - NO auto-reload); credit-watch.mjs warns before
// it runs low so top-ups happen on purpose, ahead of a basho. See the deploy guide.
const PRICE = [
  [/opus/i,   { in: 15, out: 75 }],
  [/sonnet/i, { in: 3,  out: 15 }],
  [/haiku/i,  { in: 0.8, out: 4 }],
];
function priceFor(model) { const hit = PRICE.find(([re]) => re.test(model)); return hit ? hit[1] : { in: 3, out: 15 }; }
function recordSpend(usage) {
  if (!usage) return;
  const inTok = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  const p = priceFor(ANTHROPIC_MODEL);
  spend.in += inTok; spend.out += outTok;
  spend.usd += (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

// ---------------------------------------------------------------------------
// GUARDRAIL HELPERS
// ---------------------------------------------------------------------------
// no macrons; no em/en dashes in written prose (rail 6). Applied to every string we write.
function clean(s) {
  if (s == null) return s;
  return String(s)
    .normalize('NFKD')            // dohyo-macron -> o + combining macron
    .replace(/[̀-ͯ]/g, '') // drop ALL combining diacritics (macrons etc.) - no macrons rail
    .replace(/\s*[—–]\s*/g, ', ') // em/en dash (+ its surrounding spaces) -> comma-space
    .replace(/\s+,/g, ',')        // no space before comma
    .replace(/,\s+,/g, ',')       // collapse doubled commas from adjacent dashes
    .replace(/[ \t]{2,}/g, ' ')   // collapse runs of spaces
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
const airToday = () => new Date().toISOString().slice(0, 10);
const idNoDash = s => String(s || '').replace(/-/g, '');
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// NOTION REST (same pattern as gen-drinking-game.mjs / gen-gumbai-snapshot.mjs)
// ---------------------------------------------------------------------------
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
  if (!res.ok) throw new Error(`Notion ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
async function queryAll(dbId, filter) {
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
async function blockChildrenText(pageId) {
  // concatenate all paragraph/heading text in the page body (the transcript lives here)
  const lines = []; let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const r = await notion(`/blocks/${idNoDash(pageId)}/children${qs}`);
    for (const b of r.results || []) {
      const rt = b[b.type]?.rich_text;
      if (Array.isArray(rt)) lines.push(rt.map(t => t.plain_text).join(''));
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return lines.join('\n');
}

// REST create/update, guarded by DRY_RUN.
async function createPage(dbId, properties, label) {
  if (DRY_RUN) { note(`   DRY create [${label}]: ${JSON.stringify(shrink(properties))}`); return { id: 'dry-' + Math.random().toString(36).slice(2) }; }
  const r = await notion('/pages', 'POST', { parent: { database_id: dbId }, properties });
  note(`   + created [${label}] ${r.id}`);
  return r;
}
async function updatePage(pageId, properties, label) {
  if (DRY_RUN) { note(`   DRY update [${label}] ${pageId}: ${JSON.stringify(shrink(properties))}`); return; }
  await notion(`/pages/${idNoDash(pageId)}`, 'PATCH', { properties });
  note(`   ~ updated [${label}] ${pageId}`);
}
const shrink = o => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 77) + '...' : v)));

// ---------------------------------------------------------------------------
// REST property readers / writers
// ---------------------------------------------------------------------------
const pTitle = (p, k) => (p.properties?.[k]?.title || []).map(t => t.plain_text).join('').trim();
const pText  = (p, k) => (p.properties?.[k]?.rich_text || []).map(t => t.plain_text).join('').trim();
const pNum   = (p, k) => (typeof p.properties?.[k]?.number === 'number' ? p.properties[k].number : null);
const pBool  = (p, k) => p.properties?.[k]?.checkbox === true;
const pRel   = (p, k) => (p.properties?.[k]?.relation || []).map(r => r.id);
const pSelect= (p, k) => p.properties?.[k]?.select?.name || null;
const pDate  = (p, k) => p.properties?.[k]?.date?.start || null;
// writers (REST shapes)
const wTitle = s => ({ title: [{ text: { content: clean(s) || '' } }] });
const wText  = s => ({ rich_text: [{ text: { content: clean(s) || '' } }] });
const wNum   = n => ({ number: n });
const wBool  = b => ({ checkbox: !!b });
const wRel   = ids => ({ relation: (ids || []).map(id => ({ id: idNoDash(id) })) });
const wSelect= name => (name ? { select: { name } } : { select: null });
const wMulti = names => ({ multi_select: (names || []).map(name => ({ name })) });
const wDate  = d => (d ? { date: { start: d } } : { date: null });

// ---------------------------------------------------------------------------
// ANTHROPIC - structured extraction via tool use
// ---------------------------------------------------------------------------
const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    announcer_self_id: { type: ['string', 'null'], description: 'Announcer name if the booth self-identifies IN the transcript, mapped to the canonical roster; else null. Never guess.' },
    announcer_fingerprint: { type: ['string', 'null'], description: 'Best roster guess from distinctive signature phrasing ONLY if clearly one voice (Murray most distinctive); null if unclear or if the phrasing is shared between Hiro and Raja.' },
    announcer_confidence: { type: 'string', enum: ['self_id', 'fingerprint', 'unclear'] },
    storylines: { type: 'string', description: 'The day narrative arcs as booth color, plain prose, no em dashes, no macrons, no results stated as hard fact (booth narrative is fine). Bulleted with a leading bullet per arc.' },
    injuries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rikishi: { type: 'string', description: 'shikona, canonical spelling' },
          area: { type: 'string', description: 'body area e.g. left shoulder, right knee, thigh, or "unspecified (ongoing)"' },
          setting: { type: 'string', enum: ['On-dohyo', 'Off-dohyo', ''] },
          nature: { type: 'array', items: { type: 'string', enum: ['Acute', 'Chronic', 'Suspected chronic', 'Flared', 'Worsened'] } },
          status: { type: 'string', enum: ['Active', 'Withdrawn', 'Eased', ''] },
          booth_read: { type: 'string', description: 'what the booth said, plain prose' },
          carrying: { type: 'boolean', description: 'true if framed as ongoing/nagging ("carrying"), false if a fresh acute event' },
        },
        required: ['rikishi', 'area', 'booth_read'],
      },
    },
    catchphrases: {
      type: 'array',
      description: 'ONLY genuine announcer idioms. EXCLUDE garbled kimarite, mangled rikishi names, and known nicknames. Template the subject to X.',
      items: {
        type: 'object',
        properties: {
          phrase_templated: { type: 'string', description: 'the X-templated canonical phrase, e.g. "Now that is the X we know"' },
          subject: { type: 'string', description: 'the proper noun / wrestler it was about (SPOILER - stored, never rendered); blank for general lines' },
          times_today: { type: 'integer', description: '1 unless heard multiple times' },
          speaker: { type: 'string', enum: ['Announcer', 'Interviewee'] },
          jewel_candidate: { type: 'boolean', description: 'true if this is the funniest / most memorable call of the day' },
        },
        required: ['phrase_templated'],
      },
    },
    bio_proposals: {
      type: 'array',
      description: 'PROPOSE-only soft bio for Master Rikishi (style, comeback narrative, current-form read, candidate nickname). Never hard facts (dates, debuts, records).',
      items: {
        type: 'object',
        properties: { rikishi: { type: 'string' }, proposal: { type: 'string' } },
        required: ['rikishi', 'proposal'],
      },
    },
    verify_flags: { type: 'array', items: { type: 'string' }, description: 'any result-shaped or uncertain claims that need [verify] rather than being written as fact' },
    // Pass 2 only - scorekeeper corrections on top of Pass 1
    corrections: {
      type: 'array',
      description: 'Pass 2 ONLY: scorekeeper corrections. crown = re-crown the Jewel to this phrase (giggle -> 5); giggle = bump; add_catchphrase; fix_subject; confirm/correct an injury.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['crown', 'giggle', 'fix_subject', 'confirm_injury', 'correct_injury', 'note'] },
          phrase_templated: { type: 'string' },
          subject: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['kind'],
      },
    },
  },
  required: ['storylines', 'injuries', 'catchphrases', 'bio_proposals'],
};

function extractionPrompt({ mode, type, dayNum, sourceText, announcerHint, libraryHint }) {
  const rails = `RAILS (hold these):
- FIREWALL: the transcript is COLOR ONLY. Never state a result, record, kimarite, rank, or win/loss as a hard fact. Booth NARRATIVE about the day is fine (storylines), but any result-shaped specific claim goes in verify_flags, not asserted.
- Catchphrases are announcer IDIOM only. EXCLUDE: garbled kimarite (yori kitty=yorikiri, etc.), mangled rikishi names, and known rikishi nicknames (a nickname travels with the WRESTLER; a catchphrase travels with the VOICE). Template the subject to X; keep escalations as distinct phrases ("Guns blazing" vs "Guns blazing bang bang bang").
- Injuries: report what the booth OBSERVED. "carrying"/ongoing framing = carrying:true (Suspected chronic), a fresh event = carrying:false (Acute). Area + setting + booth_read.
- Bio is PROPOSE-only soft color, never hard facts.
- Plain prose, no em dashes, no macrons.`;
  const ctx = `CONTEXT: ${BASHO_LABEL}, Day ${dayNum}, row Type "${type}". Canonical announcer roster: ${ROSTER.join(', ')}.` +
    (announcerHint ? `\nThe Day's announcer is already set to: ${announcerHint} (use it; you need not re-resolve).` : '') +
    (libraryHint ? `\nExisting Library phrases for candidate announcers (for fingerprinting + find-or-create matching):\n${libraryHint}` : '');
  const laneNote = type && type.includes('Live/Preview')
    ? 'This is a .5 Live/Preview row: NO catchphrases (return []), no bout-derived lanes. Announcers + Storylines + Injuries + bio only.'
    : 'This is a Highlights row: all color lanes apply.';
  if (mode === 'pass2') {
    return `You are extracting Jennie's SCOREKEEPER NOTES to MERGE onto an existing fan-out (Pass 2). Scorekeeper beats booth. Populate "corrections" for crowns/giggle bumps/subject fixes/injury confirmations, and add any missed catchphrases or injuries she recorded. Do NOT restate the whole day.\n\n${rails}\n\n${ctx}\n${laneNote}\n\nSCOREKEEPER NOTES:\n${sourceText}`;
  }
  return `You are the broadcast color fan-out (Pass 1). Extract structured color from this ${BASHO_LABEL} transcript. Emit ONLY via the tool.\n\n${rails}\n\n${ctx}\n${laneNote}\n\nTRANSCRIPT:\n${sourceText}`;
}

async function extract(args) {
  if (MOCK_EXTRACTION) { note(`(mock extraction from ${MOCK_EXTRACTION})`); return JSON.parse(fs.readFileSync(MOCK_EXTRACTION, 'utf8')); }
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set (and no MOCK_EXTRACTION)');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      tools: [{ name: 'emit_fanout', description: 'Emit the extracted broadcast color as structured data.', input_schema: EXTRACTION_SCHEMA }],
      tool_choice: { type: 'tool', name: 'emit_fanout' },
      messages: [{ role: 'user', content: extractionPrompt(args) }],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // credit-dry is a MONEY emergency, not a code bug - flag it so report() screams LOUD.
    if (res.status === 400 && /credit balance is too low|insufficient|quota/i.test(text)) {
      CREDIT_DRY = true;
      throw new Error(`ANTHROPIC CREDIT DRY (shared Gumbai key) - ${text.slice(0, 200)}`);
    }
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  recordSpend(data.usage);
  const tu = (data.content || []).find(c => c.type === 'tool_use');
  if (!tu) throw new Error('Anthropic returned no tool_use block');
  return tu.input;
}

// ---------------------------------------------------------------------------
// LOOKUPS (cached)
// ---------------------------------------------------------------------------
let _announcers, _rikishi;
async function announcers() { return _announcers ||= await queryAll(DB.announcers); }
async function rikishiAll() { return _rikishi ||= await queryAll(DB.rikishi); }

async function findAnnouncerId(name) {
  const rows = await announcers();
  const hit = rows.find(r => norm(pTitle(r, 'Announcer')) === norm(name));
  if (hit) return hit.id;
  // genuinely new voice -> create (canonical spelling only; roster is the guard)
  const r = await createPage(DB.announcers, { Announcer: wTitle(name) }, 'Announcer');
  return r.id;
}
async function findRikishiId(name) {
  const rows = await rikishiAll();
  const n = norm(name);
  let hit = rows.find(r => norm(pTitle(r, 'Rikishi') || pTitle(r, 'Name') || pTitle(r, Object.keys(r.properties).find(k => r.properties[k].type === 'title'))) === n);
  if (hit) return hit.id;
  // loose contains fallback (Whisper garble) - only if unambiguous
  const titleKey = rows.length ? Object.keys(rows[0].properties).find(k => rows[0].properties[k].type === 'title') : null;
  const cand = titleKey ? rows.filter(r => { const t = norm(pTitle(r, titleKey)); return t.includes(n) || n.includes(t); }) : [];
  if (cand.length === 1) return cand[0].id;
  return null; // caller flags it (no silent bad write)
}
const rikishiTitleKey = rows => Object.keys(rows[0].properties).find(k => rows[0].properties[k].type === 'title');

// ---------------------------------------------------------------------------
// LANE WRITERS (deterministic; enforce the rails)
// ---------------------------------------------------------------------------
async function writeAnnouncer(dayRow, resolved) {
  if (!resolved) return null;
  const already = pRel(dayRow, 'Announcer');
  const id = await findAnnouncerId(resolved);
  if (already.map(idNoDash).includes(idNoDash(id))) { note(`   = announcer already ${resolved}`); return id; }
  await updatePage(dayRow.id, { Announcer: wRel([id]) }, 'Day.Announcer');
  note(`   announcer = ${resolved}`);
  return id;
}

async function writeStorylines(dayRow, storylines, show, air) {
  if (!storylines) return;
  const existing = pText(dayRow, 'Storylines');
  if (existing) { note('   storylines already present (idempotent) - not clobbering'); return; }
  const stamped = `${clean(storylines)}\n\n[booth, ${show}, air ${air}]`;
  await updatePage(dayRow.id, { Storylines: wText(stamped) }, 'Day.Storylines');
  note('   storylines written');
}

async function writeInjury(dayRow, inj, show, air) {
  const rid = await findRikishiId(inj.rikishi);
  if (!rid) { problem(`injury: could not resolve rikishi "${inj.rikishi}" - SKIPPED (no bad write)`); return; }
  const area = clean(inj.area) || 'unspecified';
  const layer = `${BASHO_LABEL.replace(/[^0-9A-Za-z]/g, '')}D${pNum(dayRow, 'Day #')}: ${clean(inj.booth_read)} [booth${inj.carrying ? ', carrying' : ''}]`;
  // find-or-update by rikishi + area
  const rows = await queryAll(DB.injuries, { property: 'Rikishi', relation: { contains: idNoDash(rid) } });
  const match = rows.find(r => norm(pText(r, 'Area')).includes(norm(area)) || norm(area).includes(norm(pText(r, 'Area'))));
  if (match) {
    const sev = pText(match, 'Severity Log');
    const newSev = sev ? `${sev}<br>${layer}` : layer;
    const boothOld = pText(match, 'Booth Read');
    const props = { 'Severity Log': wText(newSev) };
    if (clean(inj.booth_read) && !norm(boothOld).includes(norm(inj.booth_read))) props['Booth Read'] = wText(clean(boothOld ? boothOld + ' | ' + inj.booth_read : inj.booth_read));
    if (inj.status) props['Status'] = wSelect(inj.status);
    // add Day relation on the injury (Onset Day is onset; only set if empty)
    if (!pRel(match, 'Onset Day').length) props['Onset Day'] = wRel([dayRow.id]);
    await updatePage(match.id, props, `Injury(${inj.rikishi}) append`);
    return match.id;
  }
  // new row
  const nature = (inj.nature && inj.nature.length) ? inj.nature : (inj.carrying ? ['Suspected chronic'] : ['Acute']);
  const props = {
    Condition: wTitle(`${inj.rikishi} - ${area}`),
    Area: wText(area),
    Nature: wMulti(nature),
    Status: wSelect(inj.status || 'Active'),
    Setting: wSelect(inj.setting || 'Off-dohyo'),
    Source: wMulti(['Booth mention']),
    'Booth Read': wText(`${clean(inj.booth_read)} [${show}, air ${air}, booth]`),
    'Severity Log': wText(layer),
    'Onset Day': wRel([dayRow.id]),
    Rikishi: wRel([rid]),
  };
  const r = await createPage(DB.injuries, props, `Injury(${inj.rikishi}) NEW`);
  return r.id;
}

async function libraryForAnnouncer(announcerId) {
  // all Library rows for this announcer (for find-or-create match + distinct-day seed)
  const rows = await queryAll(DB.library, { property: 'Announcer', relation: { contains: idNoDash(announcerId) } });
  return rows;
}
async function distinctDayCount(libId) {
  const s = await queryAll(DB.sightings, { property: 'Phrase', relation: { contains: idNoDash(libId) } });
  const days = new Set(s.map(r => (pRel(r, 'Day')[0] || '')).filter(Boolean).map(idNoDash));
  return days.size;
}

async function writeCatchphrases(dayRow, cps, announcerId, announcerName, show, air, opts = {}) {
  const { allowJewel = true, skipExisting = false } = opts;   // crew lane runs first; machine is the FALLBACK (no crown, no clobber) when crew is present
  if (!announcerId) { problem('catchphrases HELD: announcer unresolved (color lanes landed regardless)'); return { held: true }; }
  if (!cps || !cps.length) { note('   catchphrases: none extracted'); return { held: false, count: 0 }; }
  const lib = await libraryForAnnouncer(announcerId);
  const dayId = dayRow.id;
  const written = [];
  // seed giggle in CODE (base 2; +1 within-day>=2; +1 if >=3 distinct days incl today). never 5.
  for (const cp of cps) {
    const phrase = clean(cp.phrase_templated);
    if (!phrase) continue;
    // find-or-create Library row {announcer, normalized phrase}
    let libRow = lib.find(r => norm(pTitle(r, 'Phrase')) === norm(phrase));
    let libId;
    if (libRow) { libId = libRow.id; }
    else {
      const r = await createPage(DB.library, {
        Phrase: wTitle(phrase),
        Announcer: wRel([announcerId]),
        Speaker: wSelect(cp.speaker || 'Announcer'),
        Notes: wText(`[booth, ${show}, air ${air}] auto first-pass; verify/refine.`),
      }, `Library "${phrase}"`);
      libId = r.id; lib.push({ id: libId, properties: { Phrase: { title: [{ plain_text: phrase }] } } });
    }
    const priorDays = DRY_RUN ? 0 : await distinctDayCount(libId);
    const times = cp.times_today && cp.times_today > 1 ? cp.times_today : null;
    let giggle = 2; if (times) giggle += 1; if (priorDays + 1 >= 3) giggle += 1; if (giggle > 4) giggle = 4;
    // find-or-update Sighting by {Phrase, Day}
    const existing = DRY_RUN ? [] : await queryAll(DB.sightings, { and: [
      { property: 'Phrase', relation: { contains: idNoDash(libId) } },
      { property: 'Day', relation: { contains: idNoDash(dayId) } },
    ] });
    const props = {
      Sighting: wTitle(`${announcerName} - Day ${pNum(dayRow, 'Day #')} - ${phrase.slice(0, 40)}`),
      Phrase: wRel([libId]),
      Day: wRel([dayId]),
      Subject: wText(cp.subject || ''),
      'Giggle Rank': wNum(giggle),
      Notes: wText(`[booth, ${show}, air ${air}] machine giggle seed ${giggle}.`),
    };
    if (times) props['Times Today'] = wNum(times);
    if (existing.length && skipExisting) { note(`   = "${phrase}" already a sighting (crew/prior) - machine fallback leaves it`); continue; }
    if (existing.length) { await updatePage(existing[0].id, props, `Sighting "${phrase}"`); written.push({ phrase, libId, sightId: existing[0].id, giggle, jewelCand: cp.jewel_candidate, times }); }
    else { const r = await createPage(DB.sightings, props, `Sighting "${phrase}"`); written.push({ phrase, libId, sightId: r.id, giggle, jewelCand: cp.jewel_candidate, times }); }
  }
  // auto-crown the day's single Jewel: prefer model jewel_candidate, else top by (times, giggle).
  // Suppressed when crew catches are present (crew owns the crown; see runCatcherLane / settleJewel).
  let jewel = allowJewel && (written.find(w => w.jewelCand)
    || [...written].sort((a, b) => ((b.times || 1) - (a.times || 1)) || (b.giggle - a.giggle))[0]);
  if (jewel) {
    await updatePage(jewel.sightId, { Jewel: wBool(true) }, `Jewel "${jewel.phrase}"`);
    // clear any other Jewel this day (one crown)
    for (const w of written) if (w.sightId !== jewel.sightId) await updatePage(w.sightId, { Jewel: wBool(false) }, `un-Jewel`);
    note(`   Jewel = "${jewel.phrase}"`);
  }
  // populate the Day's Catchphrases relation (Jennie's completeness surface) - merge, don't clobber
  const dayLibIds = new Set(pRel(dayRow, 'Catchphrases').map(idNoDash));
  for (const w of written) dayLibIds.add(idNoDash(w.libId));
  await updatePage(dayRow.id, { Catchphrases: wRel([...dayLibIds]) }, 'Day.Catchphrases');
  note(`   catchphrases: ${written.length} sighting(s)`);
  return { held: false, count: written.length };
}

// ---------------------------------------------------------------------------
// CATCHER LANE (crew ear-grab intake -> Sightings/Library)  [state/catcher-fan-lane-spec.md]
// ---------------------------------------------------------------------------
// The Catcher is where the crew logs commentary that grabbed their ear while watching.
// That human signal is the game's grade: tier 1 = a recurring catchphrase (house-ism),
// tiers 2/3 = the great color they caught today (tier 3 = the day's Jewel). "color vs
// catchphrase" is not the gate; the ONLY filter is the firewall (results/kimarite/names
// never become a Phrase; a name in a crew quote is templated to X, real subject -> Sighting).
//
// Jennie's rule: fan reads the Catcher; anything there that TIES TO THE TRANSCRIPT and is
// not already in Sightings gets added to Sightings + Library and prioritized for the game.

const STOP = new Set('a an the of to in on at is it he she his her him they them and or but for with was were be been are as no not into out off up down this that today her his'.split(/\s+/));
// strip the X subject placeholder, then normalize, so a templated submission can be matched to raw transcript
function corePhrase(sub) { return norm(String(sub || '').replace(/\bX\b/gi, ' ')); }
// "ties to transcript": verbatim substring, else >=60% of content words present (Whisper garbles names, not idiom)
function tiesToTranscript(submission, txNorm) {
  const core = corePhrase(submission);
  if (!core) return { tie: false, how: 'empty' };
  if (txNorm.includes(core)) return { tie: true, how: 'verbatim' };
  const words = core.split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w));
  if (!words.length) return { tie: false, how: 'no content words (needs verbatim)' };
  const hit = words.filter(w => txNorm.includes(w)).length;
  const frac = hit / words.length;
  if (frac >= 0.6) return { tie: true, how: `fuzzy ${hit}/${words.length}` };
  return { tie: false, how: `weak ${hit}/${words.length}` };
}

async function readCatcherDay(dayNum) {
  // open crew submissions for the day (any Type); triage/merged/etc. rows are already handled
  return await queryAll(DB.catcher, { and: [
    { property: 'Day', number: { equals: dayNum } },
    { or: [
      { property: 'Status', select: { equals: 'new' } },
      { property: 'Status', select: { equals: 'pending-confirmation' } },
    ] },
  ] });
}

// human announcer signals for the resolution ladder
function announcerFromNotes(dayRow) {
  const notes = pText(dayRow, 'Scorekeeper Notes');
  const m = notes.match(/announcer\s*[:\-]\s*([^\n,;(]+)/i);
  if (!m) return null;
  const cand = norm(m[1]);   // tolerant of a trailing period or extra words after the name
  const hit = ROSTER.find(n => cand === norm(n) || cand.startsWith(norm(n) + ' ') || cand.startsWith(norm(n) + '.'));
  return hit ? canonical(hit) : null;
}
async function announcerFromCatcher(catcherRows) {
  const tagged = (catcherRows || []).find(r => pRel(r, 'Announcer').length);
  if (!tagged) return null;
  const aid = pRel(tagged, 'Announcer')[0];
  const rows = await announcers();
  const r = rows.find(x => idNoDash(x.id) === idNoDash(aid));
  return r ? { id: aid, name: pTitle(r, 'Announcer') } : null;
}

async function runCatcherLane(dayRow, dayNum, txNorm, annId, annName, show, air, catcherRows) {
  const rows = catcherRows || [];
  if (!rows.length) { note('   catcher: no open crew submissions for the day'); return { count: 0 }; }
  const writeins = rows.filter(r => (pSelect(r, 'Type') || 'write-in') === 'write-in');
  const votes    = rows.filter(r => pSelect(r, 'Type') === 'jewel-vote');
  const flags    = rows.filter(r => pSelect(r, 'Type') === 'flag');
  if (!annId) {
    problem(`catcher HELD: ${rows.length} open crew submission(s) for Day ${dayNum} but announcer unresolved. Set the Day's Announcer, tag a Catcher row's Announcer, or add an "Announcer: <name>" line to Scorekeeper Notes, then re-fire.`);
    return { held: true };
  }
  const lib = await libraryForAnnouncer(annId);
  const written = [];
  for (const row of writeins) {
    const submission = pTitle(row, 'Submission');
    const phrase = clean(submission);   // the crew's own wording is the Phrase (they template names to X; we trust that)
    if (!phrase) { problem(`catcher: a Day ${dayNum} write-in has an empty Submission - skipped`); continue; }
    const t = tiesToTranscript(submission, txNorm);
    if (!t.tie) { problem(`catcher: "${submission}" (Day ${dayNum}) did not corroborate against the transcript (${t.how}) - left OPEN for review, not written`); continue; }
    // find-or-create Library {announcer, phrase}
    let libRow = lib.find(r => norm(pTitle(r, 'Phrase')) === norm(phrase));
    let libId;
    if (libRow) { libId = libRow.id; }
    else {
      const r = await createPage(DB.library, {
        Phrase: wTitle(phrase),
        Announcer: wRel([annId]),
        Speaker: wSelect('Announcer'),
        Notes: wText(`[booth, ${annName}, ${show}, air ${air}] crew-caught via Catcher; verify/refine.`),
      }, `Library "${phrase}" (crew)`);
      libId = r.id; lib.push({ id: libId, properties: { Phrase: { title: [{ plain_text: phrase }] } } });
    }
    // dedupe by {Phrase, Day}
    const existing = DRY_RUN ? [] : await queryAll(DB.sightings, { and: [
      { property: 'Phrase', relation: { contains: idNoDash(libId) } },
      { property: 'Day', relation: { contains: idNoDash(dayRow.id) } },
    ] });
    const suggestedBy = pText(row, 'Suggested by');
    const subjGuess = pText(row, 'Fan subject guess');   // quarantined: a fan guess, never feeds the nickname engine
    const priorDays = DRY_RUN ? 0 : await distinctDayCount(libId);
    let giggle = 2; if (priorDays + 1 >= 3) giggle += 1; if (giggle > 4) giggle = 4;
    const props = {
      Sighting: wTitle(`${annName} - Day ${dayNum} - ${phrase.slice(0, 40)}`),
      Phrase: wRel([libId]),
      Day: wRel([dayRow.id]),
      Subject: wText(subjGuess || ''),
      'Giggle Rank': wNum(giggle),
      Notes: wText(`[booth, ${annName}, ${show}, air ${air}] crew-caught via Catcher${suggestedBy ? ' (' + suggestedBy + ')' : ''}${subjGuess ? '; subject is a fan guess' : ''}; tie ${t.how}; giggle seed ${giggle}.`),
    };
    let sightId;
    if (existing.length) { await updatePage(existing[0].id, props, `Sighting "${phrase}" (crew)`); sightId = existing[0].id; }
    else { const r = await createPage(DB.sightings, props, `Sighting "${phrase}" (crew)`); sightId = r.id; }
    // close the Catcher row
    const closeProps = { Status: wSelect('merged-sighting'), 'Related Phrase': wRel([libId]), 'Related Sighting': wRel([sightId]) };
    if (!pRel(row, 'Announcer').length) closeProps['Announcer'] = wRel([annId]);
    await updatePage(row.id, closeProps, `Catcher "${submission.slice(0, 30)}" -> merged`);
    written.push({ phrase, libId, sightId, giggle });
  }
  // Day.Catchphrases merge (crew) - never clobber
  if (written.length) {
    const dayLibIds = new Set(pRel(dayRow, 'Catchphrases').map(idNoDash));
    for (const w of written) dayLibIds.add(idNoDash(w.libId));
    await updatePage(dayRow.id, { Catchphrases: wRel([...dayLibIds]) }, 'Day.Catchphrases (crew)');
  }
  // Jewel: a crew jewel-vote wins; else auto-seed among crew sightings if nothing is crowned yet
  await settleJewel(dayRow, dayNum, votes, written, annId);
  // flags -> report only (non-destructive; a human applies not-said/mis-worded/dupe/not-funny in Pass 2)
  for (const f of flags) problem(`catcher FLAG for review: "${pTitle(f, 'Submission')}" reason=${pSelect(f, 'Reason') || 'flag'} (Day ${dayNum}) - not auto-applied`);
  note(`   catcher: ${written.length} crew sighting(s) folded${votes.length ? `, ${votes.length} jewel-vote(s)` : ''}${flags.length ? `, ${flags.length} flag(s) flagged` : ''}`);
  return { count: written.length };
}

async function settleJewel(dayRow, dayNum, votes, written, annId) {
  const lib = await libraryForAnnouncer(annId);
  const tally = new Map();   // libId(nodash) -> vote count
  for (const v of votes) {
    const sub = pTitle(v, 'Submission');
    let libId = pRel(v, 'Related Phrase')[0] || null;
    if (!libId) { const lr = lib.find(r => norm(pTitle(r, 'Phrase')) === norm(clean(sub))); libId = lr ? lr.id : null; }
    if (!libId) { problem(`catcher jewel-vote "${sub}" (Day ${dayNum}) matches no library phrase for this announcer - ignored`); continue; }
    tally.set(idNoDash(libId), (tally.get(idNoDash(libId)) || 0) + 1);
    await updatePage(v.id, { Status: wSelect('applied'), 'Related Phrase': wRel([libId]) }, 'Catcher jewel-vote -> applied');
  }
  const dayS = DRY_RUN ? [] : await queryAll(DB.sightings, { property: 'Day', relation: { contains: idNoDash(dayRow.id) } });
  const alreadyCrowned = dayS.some(s => pBool(s, 'Jewel'));
  if (tally.size) {
    const crownLibId = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const target = dayS.find(s => pRel(s, 'Phrase').map(idNoDash).includes(crownLibId));
    if (target) {
      for (const s of dayS) if (pBool(s, 'Jewel') && s.id !== target.id) await updatePage(s.id, { Jewel: wBool(false) }, 'un-Jewel');
      await updatePage(target.id, { Jewel: wBool(true), 'Giggle Rank': wNum(5) }, 'crew jewel-vote crown');
      note(`   Jewel (crew vote) = "${pTitle(target, 'Sighting')}"`);
    } else problem(`catcher jewel-vote crown: no sighting on Day ${dayNum} for the most-voted phrase`);
    return;
  }
  // no vote: auto-seed the day's Jewel among crew-written sightings, only if nothing is crowned yet
  if (!alreadyCrowned && written.length) {
    const top = [...written].sort((a, b) => b.giggle - a.giggle)[0];
    await updatePage(top.sightId, { Jewel: wBool(true) }, 'auto-Jewel (crew)');
    note(`   Jewel (auto, crew) = "${top.phrase}"`);
  }
}

// Backfill entry: run ONLY the Catcher lane against an already-fanned day (Storylines filled),
// or as a completeness pass after Pass 2. No API spend - resolves the announcer from human
// signals (row / Scorekeeper header / crew tag) and reads the transcript body for the tie check.
async function catcherBackfill(row) {
  const dayNum = pNum(row, 'Day #');
  const type = pSelect(row, 'Type') || 'Highlights';
  const air = pDate(row, 'Original Air Date') || airToday();
  if (type.includes('Live/Preview')) { note('   catcher backfill skipped (.5 row)'); return; }
  const show = 'GSH Highlights';
  const catcherRows = await readCatcherDay(dayNum);
  if (!catcherRows.length) { note('   catcher: nothing open to backfill'); return; }
  const resolved = await resolveAnnouncer(row, null, catcherRows);
  note(`   catcher backfill announcer: ${resolved.name || 'UNDETERMINED'} (${resolved.how})`);
  const annId = resolved.name ? await writeAnnouncer(row, resolved.name) : null;
  const body = await blockChildrenText(row.id);
  const tx = body.split(/Transcript \(auto-landed/i).pop();
  await runCatcherLane(row, dayNum, norm(tx || body), annId, resolved.name, show, air, catcherRows);
}

// ---------------------------------------------------------------------------
// ANNOUNCER RESOLUTION LADDER (row -> Scorekeeper header -> crew tag -> self-id -> fingerprint -> HOLD)
// ---------------------------------------------------------------------------
async function resolveAnnouncer(dayRow, ex, catcherRows) {
  const already = pRel(dayRow, 'Announcer');
  if (already.length) {
    const rows = await announcers();
    const r = rows.find(x => idNoDash(x.id) === idNoDash(already[0]));
    if (r) return { name: pTitle(r, 'Announcer'), how: 'human-set on the row' };
  }
  // human signals next: a scorekeeper "Announcer:" header, then a crew tag on a Catcher row
  const fromNotes = announcerFromNotes(dayRow);
  if (fromNotes) return { name: fromNotes, how: 'Scorekeeper Notes header' };
  const fromCatcher = await announcerFromCatcher(catcherRows);
  if (fromCatcher) return { name: canonical(fromCatcher.name), how: 'crew-tagged in Catcher' };
  // transcript-derived signals (Pass 1 only; ex is null on a backfill)
  if (ex && ex.announcer_self_id && ROSTER.some(n => norm(n) === norm(ex.announcer_self_id))) return { name: canonical(ex.announcer_self_id), how: 'self-ID in transcript' };
  if (ex && ex.announcer_confidence === 'fingerprint' && ex.announcer_fingerprint && ROSTER.some(n => norm(n) === norm(ex.announcer_fingerprint))) return { name: canonical(ex.announcer_fingerprint), how: 'KB fingerprint' };
  return { name: null, how: 'undetermined (HOLD catchphrases)' };
}
const canonical = name => ROSTER.find(n => norm(n) === norm(name)) || name;

// ---------------------------------------------------------------------------
// FIND THE READY ROW
// ---------------------------------------------------------------------------
async function findRow() {
  const rows = await queryAll(DB.days, { property: 'Basho', relation: { contains: idNoDash(TOURNAMENT_PAGE_ID) } });
  const withTx = rows.filter(r => (p => p && p.length)(pRel(r, 'Bouts')) || true); // all this-basho rows
  if (DAY_OVERRIDE != null) {
    const r = rows.find(x => pNum(x, 'Day #') === DAY_OVERRIDE);
    if (!r) throw new Error(`no Day # ${DAY_OVERRIDE} row in ${BASHO_LABEL}`);
    return r;
  }
  // "today's" row: Original Air Date == today, else most recent with a transcript file
  const today = airToday();
  const dated = rows.filter(r => pDate(r, 'Original Air Date'));
  let r = dated.find(x => pDate(x, 'Original Air Date') === today && (p => p && p.length)(pRel(x, 'Bouts') || []) );
  if (!r) r = dated.filter(x => (x.properties?.Transcript?.files || []).length)
                     .sort((a, b) => (pDate(b, 'Original Air Date') || '').localeCompare(pDate(a, 'Original Air Date') || ''))[0];
  return r || null;
}

// ---------------------------------------------------------------------------
// PASS 1
// ---------------------------------------------------------------------------
async function pass1() {
  const row = await findRow();
  if (!row) { problem('no ready Day row (no transcript landed) - nothing fanned'); return; }
  const dayNum = pNum(row, 'Day #');
  const type = pSelect(row, 'Type') || 'Highlights';
  const air = pDate(row, 'Original Air Date') || airToday();
  note(`Pass 1: ${BASHO_LABEL} Day ${dayNum} (Type ${type}, air ${air})`);
  // idempotency: Storylines non-empty => already fanned. Still run the Catcher backfill so a re-fire
  // picks up crew catches even though the transcript lanes are done (no API spend on this path).
  if (pText(row, 'Storylines')) {
    note('Storylines already filled - Pass 1 already ran. Running Catcher backfill only (idempotent).');
    await catcherBackfill(row);
    return;
  }
  const body = await blockChildrenText(row.id);
  const tx = body.split(/Transcript \(auto-landed/i).pop(); // text after the transcript heading
  if (!tx || tx.replace(/[^A-Za-z]/g, '').length < 200) { problem('transcript body is blank/tiny (box body-write may have failed) - not fabricating color'); return; }
  const show = type.includes('Live/Preview') ? 'GSH Live/Preview' : 'GSH Highlights';

  // build a small library hint for fingerprinting (distinctive phrases per announcer)
  let libraryHint = '';
  try {
    const libAll = await queryAll(DB.library);
    const byAnn = {};
    for (const r of libAll) { const a = (pRel(r, 'Announcer')[0] || ''); if (!a) continue; (byAnn[a] ||= []).push(pTitle(r, 'Phrase')); }
    const rows = await announcers();
    libraryHint = Object.entries(byAnn).map(([aid, ph]) => { const ar = rows.find(x => idNoDash(x.id) === idNoDash(aid)); return `${ar ? pTitle(ar, 'Announcer') : aid}: ${ph.slice(0, 8).join('; ')}`; }).join('\n');
  } catch { /* fingerprint hint is best-effort */ }

  const announcerHint = (() => { const a = pRel(row, 'Announcer'); return a.length ? '(already set)' : ''; })();
  const ex = await extract({ mode: 'pass1', type, dayNum, sourceText: tx, announcerHint, libraryHint });

  // crew ear-grab intake for the day (also a human announcer signal); [] on a .5 row
  const catcherRows = type.includes('Live/Preview') ? [] : await readCatcherDay(dayNum);

  // announcer FIRST (catchphrases need it); color lanes fan regardless
  const resolved = await resolveAnnouncer(row, ex, catcherRows);
  note(`Announcer: ${resolved.name || 'UNDETERMINED'} (${resolved.how})`);
  const annId = resolved.name ? await writeAnnouncer(row, resolved.name) : null;

  await writeStorylines(row, ex.storylines, show, air);
  for (const inj of (ex.injuries || [])) await writeInjury(row, inj, show, air);
  if (!type.includes('Live/Preview')) {
    // crew Catcher lane FIRST (the ear-grab signal owns the day + the Jewel when present)...
    const crew = await runCatcherLane(row, dayNum, norm(tx), annId, resolved.name, show, air, catcherRows);
    // ...then the machine transcript lane as a FALLBACK for the (likely) days nobody watched: it adds
    // phrases crew did not catch, never clobbers a crew sighting, and only crowns when crew caught nothing.
    const crewPresent = !!(crew && crew.count > 0);
    await writeCatchphrases(row, ex.catchphrases, annId, resolved.name, show, air, { allowJewel: !crewPresent, skipExisting: true });
  } else note('   catchphrases skipped (.5 row)');

  // bio + verify flags -> report only (PROPOSE / never auto-write)
  if ((ex.bio_proposals || []).length) note(`   bio PROPOSED (not written): ${ex.bio_proposals.map(b => b.rikishi).join(', ')}`);
  if ((ex.verify_flags || []).length) for (const v of ex.verify_flags) note(`   [verify] ${v}`);
  note(`Pass 1 done for Day ${dayNum}.`);
}

// ---------------------------------------------------------------------------
// PASS 2 - scorekeeper notes, merge (scorekeeper authority)
// ---------------------------------------------------------------------------
async function pass2() {
  const row = await findRow();
  if (!row) { problem('no Day row for Pass 2'); return; }
  const dayNum = pNum(row, 'Day #');
  const type = pSelect(row, 'Type') || 'Highlights';
  const air = pDate(row, 'Original Air Date') || airToday();
  const notes = pText(row, 'Scorekeeper Notes');
  if (!notes) { problem(`no Scorekeeper Notes on Day ${dayNum} - nothing to merge`); return; }
  note(`Pass 2: merging scorekeeper notes for Day ${dayNum}`);
  const show = 'GSH Highlights';
  const ex = await extract({ mode: 'pass2', type, dayNum, sourceText: notes, announcerHint: '(set)', libraryHint: '' });

  const a = pRel(row, 'Announcer'); let annId = a[0] || null, annName = null;
  if (annId) { const rows = await announcers(); const r = rows.find(x => idNoDash(x.id) === idNoDash(annId)); annName = r ? pTitle(r, 'Announcer') : null; }

  // add any missed injuries / catchphrases (find-or-update -> safe)
  for (const inj of (ex.injuries || [])) await writeInjury(row, inj, show, air);
  if (annId && (ex.catchphrases || []).length) await writeCatchphrases(row, ex.catchphrases, annId, annName, show, air, { allowJewel: false, skipExisting: true });

  // corrections: crown -> re-crown Jewel + giggle 5; giggle bump; fix subject
  for (const c of (ex.corrections || [])) {
    if (!annId) { problem('correction skipped: no announcer'); continue; }
    if (c.kind === 'crown' || c.kind === 'giggle' || c.kind === 'fix_subject') {
      const lib = await libraryForAnnouncer(annId);
      const libRow = lib.find(r => norm(pTitle(r, 'Phrase')) === norm(c.phrase_templated));
      if (!libRow) { problem(`correction "${c.kind}" phrase not found: ${c.phrase_templated}`); continue; }
      const s = await queryAll(DB.sightings, { and: [ { property: 'Phrase', relation: { contains: idNoDash(libRow.id) } }, { property: 'Day', relation: { contains: idNoDash(row.id) } } ] });
      if (!s.length) { problem(`correction: no sighting for ${c.phrase_templated} on Day ${dayNum}`); continue; }
      if (c.kind === 'crown') {
        // clear other jewels this day, crown this, giggle -> 5 (human crown)
        const dayS = await queryAll(DB.sightings, { property: 'Day', relation: { contains: idNoDash(row.id) } });
        for (const x of dayS) if (pBool(x, 'Jewel') && x.id !== s[0].id) await updatePage(x.id, { Jewel: wBool(false) }, 'un-Jewel');
        await updatePage(s[0].id, { Jewel: wBool(true), 'Giggle Rank': wNum(5) }, `crown "${c.phrase_templated}"`);
        note(`   re-crowned Jewel -> "${c.phrase_templated}"`);
      } else if (c.kind === 'giggle') { await updatePage(s[0].id, { 'Giggle Rank': wNum(Math.min(5, Number(c.value) || 5)) }, 'giggle bump'); }
      else if (c.kind === 'fix_subject') { await updatePage(s[0].id, { Subject: wText(c.subject || c.value || '') }, 'fix subject'); }
    } else { note(`   scorekeeper note: ${c.kind} ${c.value || ''}`); }
  }
  // fold any open crew Catcher submissions for the day (idempotent; merged rows are skipped)
  await catcherBackfill(row);
  note(`Pass 2 done for Day ${dayNum}.`);
}

// ---------------------------------------------------------------------------
// MAIN + report (no silent fails)
// ---------------------------------------------------------------------------
async function report(status) {
  // cost echo (this run) - a running-low signal, since Anthropic exposes no balance API
  const costLine = spend.in || spend.out
    ? `API spend this run: ~$${spend.usd.toFixed(4)} (${spend.in.toLocaleString()} in / ${spend.out.toLocaleString()} out tok, ${spend.model})`
    : 'API spend this run: none (mock/dry/no call)';
  const creditLine = CREDIT_DRY
    ? '*** ANTHROPIC CREDIT IS DRY - the shared Gumbai key hit its prepaid cap. TOP UP (Console -> Billing). '
      + 'The fan is blocked until refilled, and public Gumbai is also down on this key. ***'
    : null;
  const summary = [
    `fan.mjs ${MODE} ${status}${DRY_RUN ? ' (DRY_RUN)' : ''} - ${BASHO_LABEL}`,
    ...(creditLine ? ['', creditLine, ''] : []),
    ...log,
    '', costLine,
    ...(warn.length ? ['', 'PROBLEMS:', ...warn.map(w => '- ' + w)] : []),
  ].join('\n');
  const subj = CREDIT_DRY
    ? `fan.mjs CREDIT DRY - top up the Anthropic key`
    : `fan.mjs ${MODE} ${status}${warn.length ? ' - PROBLEMS' : ''}`;
  if (process.env.RESEND_KEY && process.env.ALERT_EMAIL && !DRY_RUN) {
    try {
      await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.ALERT_FROM || 'fan@stavesandhoop.com', to: process.env.ALERT_EMAIL, subject: subj, text: summary }) });
    } catch (e) { console.error('Resend failed: ' + e.message); }
  }
  console.log('\n===== RUN SUMMARY =====\n' + summary);
}

async function main() {
  if (!NOTION_TOKEN && !DRY_RUN) throw new Error('NOTION_TOKEN not set');
  if (MODE === 'pass2') await pass2(); else await pass1();
}

// Run only when invoked directly (node fan.mjs), not when imported by a test harness.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main()
    .then(() => report(warn.length ? 'completed WITH PROBLEMS' : 'OK'))
    .then(() => process.exit(warn.length ? 3 : 0))
    .catch(async e => { problem('FATAL: ' + e.message); await report('FATAL'); process.exit(1); });
}

// exported for offline testing (stubbed fetch); harmless in production
export const __test = { clean, writeCatchphrases, writeInjury, resolveAnnouncer, priceFor, recordSpend, spend,
  corePhrase, tiesToTranscript, readCatcherDay, runCatcherLane, catcherBackfill, announcerFromNotes };
