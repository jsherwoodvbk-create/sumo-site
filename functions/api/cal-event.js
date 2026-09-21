// functions/api/cal-event.js — Special Event editor (admin+). The in-app way the crew adds their
// own events (US Open, exhibitions, etc.) to the calendar WITHOUT touching Notion directly.
//
// SYSTEM OF RECORD: writes to the 🏆 Bashos/Events Notion database as Type = "Special Event" — the
// same table the calendar generator + Gumbai snapshot read. So a crew event becomes permanent,
// queryable history (Gumbai can recall "the US Open in Long Beach"), exactly like a catchphrase.
//
// AUTH: role >= admin, server-side. The session identifies (cookie); the member store authorizes.
// Typed errors, same contract as /api/fan:
//   401 not-authed · 403 blocked/not-authorized (from requireRole) · 400 bad-input · 502 notion · 500 exception
//
// CADENCE (by design, not a bug): an event written here appears on the calendar + Gumbai at the NEXT
// snapshot rebuild (publish run), not instantly — the app never reads Notion on the hot path. Same
// cadence catchphrases run on. Notion is the durable authoring store; the snapshot is the read layer.
//
// ENV: CAL_WRITE_TOKEN (a Notion integration scoped to WRITE only the Bashos/Events DB) + the MEMBERS
// KV (used by _members for role lookup). The generators' broad NOTION_TOKEN is deliberately NOT used
// here — a public-runtime endpoint gets a least-privilege, single-table write key.
import { requireRole, ROLES } from './members/_members.js';

const BASHOS_DB = 'ae8b304d-8655-4072-934e-d01a43fe11ce';   // 🏆 Bashos/Events (same id the generators use; rename didn't change it)
const NOTION_VERSION = '2022-06-28';
const SPECIAL = 'Special Event';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ---- Notion REST (scoped write token) ----------------------------------------------------------
async function notion(env, path, method = 'GET', body) {
  const token = env.CAL_WRITE_TOKEN;
  if (!token) throw Object.assign(new Error('CAL_WRITE_TOKEN is not set on this environment.'), { typed: 'notion' });
  const res = await fetch('https://api.notion.com/v1' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Notion ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`), { typed: 'notion' });
  return text ? JSON.parse(text) : {};
}
const shortId = s => String(s || '').replace(/-/g, '');

// ---- property readers (for the GET list) -------------------------------------------------------
const tl = (p, k) => (p.properties?.[k]?.title || []).map(t => t.plain_text).join('').trim();
const rt = (p, k) => (p.properties?.[k]?.rich_text || []).map(t => t.plain_text).join('').trim();
const dt = (p, k) => (p.properties?.[k]?.date?.start ? String(p.properties[k].date.start).slice(0, 10) : null);
const ur = (p, k) => (p.properties?.[k]?.url || '').trim() || null;
const typeOf = p => p.properties?.Type?.select?.name || null;

// ---- validation --------------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanEvent(body) {
  const name = String(body.name || body.title || '').trim();
  const start = String(body.start || '').trim();
  const end = String(body.end || '').trim();
  const location = String(body.location || '').trim();
  const link = String(body.link || body.url || '').trim();
  const notes = String(body.notes || '').trim();
  if (!name) return { error: 'Event name is required.' };
  if (name.length > 200) return { error: 'Event name is too long (200 char max).' };
  if (!DATE_RE.test(start) || Number.isNaN(Date.parse(start))) return { error: 'Start date must be a real date.' };
  if (end && (!DATE_RE.test(end) || Number.isNaN(Date.parse(end)))) return { error: 'End date must be a real date.' };
  if (end && end < start) return { error: "End date can't be before the start date." };
  if (link && !/^https?:\/\//i.test(link)) return { error: 'Link must start with http:// or https://' };
  if (location.length > 200) return { error: 'Location is too long (200 char max).' };
  if (notes.length > 2000) return { error: 'Notes are too long (2000 char max).' };
  return { name, start, end: end || null, location: location || null, link: link || null, notes: notes || null };
}

// ---- Notion property payload for a Special Event -----------------------------------------------
// Start Date and End Date are SEPARATE single-date properties (matching how honbasho rows are shaped
// and how the calendar generator reads them), not one Notion date range.
function props(ev) {
  return {
    'Tournament Name': { title: [{ text: { content: ev.name } }] },
    'Type': { select: { name: SPECIAL } },
    'Start Date': { date: { start: ev.start } },
    'End Date': ev.end ? { date: { start: ev.end } } : { date: null },
    'Event Location': { rich_text: ev.location ? [{ text: { content: ev.location } }] : [] },
    'Event Link': { url: ev.link || null },
    'Notes': { rich_text: ev.notes ? [{ text: { content: ev.notes } }] : [] },
  };
}

const fail = e => json({ error: e.typed || 'exception', message: String(e.message || e) }, e.typed === 'notion' ? 502 : 500);

// Confirm a page really is a crew Special Event before we edit or delete it — a stored guard so this
// endpoint can NEVER mutate or archive a real tournament row even if handed a tournament's id.
async function assertSpecial(env, id) {
  const page = await notion(env, `/pages/${shortId(id)}`);
  if (typeOf(page) !== SPECIAL) throw Object.assign(new Error('That row is not a crew event.'), { typed: 'bad-input' });
  return page;
}

const normName = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// The current crew (Special Event) rows, shaped for the editor list — the single Notion read reused
// by GET, the add-time duplicate guard, and the calendar's admin live-merge.
async function queryEvents(env) {
  const r = await notion(env, `/databases/${BASHOS_DB}/query`, 'POST', {
    page_size: 100,
    filter: { property: 'Type', select: { equals: SPECIAL } },
    sorts: [{ property: 'Start Date', direction: 'ascending' }],
  });
  return (r.results || []).map(p => ({
    id: p.id,
    name: tl(p, 'Tournament Name'),
    start: dt(p, 'Start Date'),
    end: dt(p, 'End Date'),
    location: rt(p, 'Event Location') || null,
    link: ur(p, 'Event Link'),
    notes: rt(p, 'Notes') || null,
    addedBy: rt(p, 'Added by') || null,               // who created it (stamped from the login on add)
  }));
}

// ---- GET: list the crew (Special Event) rows so the editor can show + edit + delete them --------
export async function onRequestGet({ request, env }) {
  const gate = await requireRole(request, env, ROLES.ADMIN);
  if (!gate.ok) return gate.response;
  try {
    return json({ ok: true, me: gate.member.email, events: await queryEvents(env) });
  } catch (e) { return fail(e); }
}

// ---- POST: add a Special Event -----------------------------------------------------------------
export async function onRequestPost({ request, env }) {
  const gate = await requireRole(request, env, ROLES.ADMIN);
  if (!gate.ok) return gate.response;
  let body; try { body = await request.json(); } catch { return json({ error: 'bad-input', message: 'Bad request body.' }, 400); }
  const ev = cleanEvent(body);
  if (ev.error) return json({ error: 'bad-input', message: ev.error }, 400);
  try {
    // Duplicate guard — the real safety net for "it didn't show on the calendar, so I added it again."
    // A crew event won't reach the calendar grid until the next snapshot rebuild, so a re-add is easy;
    // reject a create that matches an existing Special Event on name + start date, and hand back the
    // one already on file so the editor can say "that's already added."
    const existing = await queryEvents(env);
    const dup = existing.find(e => e.start === ev.start && normName(e.name) === normName(ev.name));
    if (dup) return json({ error: 'duplicate', message: `"${dup.name}" on ${dup.start} is already added — it'll appear on the calendar at the next refresh.`, event: dup }, 409);
    // Stamp WHO added it, from the verified session (not on PATCH — an edit keeps the original author).
    const addedBy = (gate.member.name || gate.member.email || '').toString().slice(0, 80);
    const properties = { ...props(ev), 'Added by': { rich_text: addedBy ? [{ text: { content: addedBy } }] : [] } };
    const created = await notion(env, '/pages', 'POST', { parent: { database_id: BASHOS_DB }, properties });
    return json({ ok: true, id: created.id, event: { ...ev, id: created.id, addedBy: addedBy || null } });
  } catch (e) { return fail(e); }
}

// ---- PATCH: edit an existing Special Event (by page id) ----------------------------------------
export async function onRequestPatch({ request, env }) {
  const gate = await requireRole(request, env, ROLES.ADMIN);
  if (!gate.ok) return gate.response;
  let body; try { body = await request.json(); } catch { return json({ error: 'bad-input', message: 'Bad request body.' }, 400); }
  const id = String(body.id || '').trim();
  if (!id) return json({ error: 'bad-input', message: 'Missing event id.' }, 400);
  const ev = cleanEvent(body);
  if (ev.error) return json({ error: 'bad-input', message: ev.error }, 400);
  try {
    await assertSpecial(env, id);
    await notion(env, `/pages/${shortId(id)}`, 'PATCH', { properties: props(ev) });
    return json({ ok: true, id, event: ev });
  } catch (e) {
    if (e.typed === 'bad-input') return json({ error: 'bad-input', message: e.message }, 400);
    return fail(e);
  }
}

// ---- DELETE: archive a Special Event (by page id) ----------------------------------------------
// Notion "archive" (in_trash) — recoverable from Notion's trash, not a hard delete.
export async function onRequestDelete({ request, env }) {
  const gate = await requireRole(request, env, ROLES.ADMIN);
  if (!gate.ok) return gate.response;
  let body; try { body = await request.json(); } catch { return json({ error: 'bad-input', message: 'Bad request body.' }, 400); }
  const id = String(body.id || '').trim();
  if (!id) return json({ error: 'bad-input', message: 'Missing event id.' }, 400);
  try {
    await assertSpecial(env, id);
    await notion(env, `/pages/${shortId(id)}`, 'PATCH', { archived: true });
    return json({ ok: true, id });
  } catch (e) {
    if (e.typed === 'bad-input') return json({ error: 'bad-input', message: e.message }, 400);
    return fail(e);
  }
}
