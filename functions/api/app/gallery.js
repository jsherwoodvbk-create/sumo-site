// functions/api/app/gallery.js — the CREW gallery (members only). Self-gated via getSession.
//   GET    → list ALL photos (public + crew-only), each flagged `mine` for the delete UI.
//   POST   → upload one photo (multipart: photo, caption, visibility=public|crew).
//   DELETE → remove one photo by ?id= (owner, or an admin).
// Storage = Cloudflare R2 (binding GALLERY). Reads live, so a delete truly retracts everywhere.
//
// COST & ABUSE GUARDRAILS (all limits computed live from what's actually stored):
//   • PER-PERSON cap 1 GB — one member can never hoard the store.
//   • GLOBAL cap 9 GB — a full GB under R2's free 10 GB, so usage can NEVER cross into paid.
//   • Email alerts (Resend) when the gallery passes 8 GB or a member passes 900 MB.
//   • Moderation (env-driven, optional): GALLERY_BLOCKED bars an email from uploading;
//     GALLERY_ADMINS lets those emails delete ANY photo. (Nuclear option: pull them from
//     CREW_ALLOWLIST → no app at all.)
import { getSession } from '../auth/_session.js';

const MAX_BYTES = 15 * 1024 * 1024;                 // 15 MB / photo
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const GB = 1024 * 1024 * 1024;
const PER_USER_CAP = 1 * GB;
const GLOBAL_CAP   = 9 * GB;                          // buffer under R2 free 10 GB
const USER_WARN    = Math.floor(0.9 * GB);
const TOTAL_WARN   = 8 * GB;

function emailList(v) { return String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); }
function isBlocked(env, email) { return emailList(env.GALLERY_BLOCKED).includes(String(email || '').toLowerCase()); }
function isAdmin(env, email) { return emailList(env.GALLERY_ADMINS).includes(String(email || '').toLowerCase()); }

// live totals from R2: overall + per owner
async function tally(bucket) {
  let total = 0; const byUser = {};
  let cursor;
  do {
    const list = await bucket.list({ include: ['customMetadata'], cursor, limit: 1000 });
    for (const o of list.objects) {
      total += o.size;
      const owner = (o.customMetadata?.owner || '').toLowerCase();
      byUser[owner] = (byUser[owner] || 0) + o.size;
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);
  return { total, byUser };
}

// best-effort email alert to GALLERY_ALERT_EMAIL via Resend (skipped if not configured)
async function notify(env, subject, text) {
  if (!env.RESEND_API_KEY || !env.GALLERY_ALERT_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Salt Stats & Sumo <sumo@stavesandhoop.com>',
        to: [env.GALLERY_ALERT_EMAIL], subject, text,
      }),
    });
  } catch (e) { /* alerts are best-effort; never block the upload path */ }
}

export async function onRequestGet(context) {
  const s = await getSession(context.request, context.env);
  if (!s) return json({ error: 'not-authed' }, 401);
  const bucket = context.env.GALLERY;
  if (!bucket) return json({ photos: [] });
  const admin = isAdmin(context.env, s.email);

  const out = [];
  let cursor;
  do {
    const list = await bucket.list({ include: ['customMetadata'], cursor, limit: 1000 });
    for (const o of list.objects) {
      const m = o.customMetadata || {};
      const mine = (m.owner || '').toLowerCase() === s.email.toLowerCase();
      out.push({
        id: o.key,
        src: '/api/img?id=' + encodeURIComponent(o.key),
        caption: m.caption || '', by: m.ownerName || '',
        visibility: m.visibility || 'crew', uploaded: m.uploaded || '', taken: m.taken || '',
        mine, canDelete: mine || admin,             // admins can remove any photo
      });
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);

  out.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
  return json({ photos: out, admin });
}

export async function onRequestPost(context) {
  const { env } = context;
  const s = await getSession(context.request, env);
  if (!s) return json({ error: 'not-authed' }, 401);
  if (isBlocked(env, s.email)) return json({ error: 'blocked', message: 'Uploading is turned off for your account.' }, 403);
  const bucket = env.GALLERY;
  if (!bucket) return json({ error: 'not-configured' }, 503);

  let form;
  try { form = await context.request.formData(); }
  catch { return json({ error: 'bad-form' }, 400); }
  const file = form.get('photo');
  if (!file || typeof file === 'string' || !file.size) return json({ error: 'no-file' }, 400);
  if (!OK_TYPES.includes(file.type)) return json({ error: 'bad-type', got: file.type }, 415);
  if (file.size > MAX_BYTES) return json({ error: 'too-big', max: MAX_BYTES }, 413);

  // live cost/abuse guardrails
  const { total, byUser } = await tally(bucket);
  const userBytes = byUser[s.email.toLowerCase()] || 0;
  const newUser = userBytes + file.size, newTotal = total + file.size;
  if (newUser > PER_USER_CAP) {
    return json({ error: 'user-quota', message: 'You’ve hit your 1 GB gallery limit — delete some shots to make room.' }, 413);
  }
  if (newTotal > GLOBAL_CAP) {
    context.waitUntil(notify(env, '🛑 Sumo gallery is FULL', 'An upload was blocked: the gallery hit its ' + (GLOBAL_CAP / GB) + ' GB cap (kept safely under R2’s free 10 GB, so nothing was charged). Time to prune or raise the cap.'));
    return json({ error: 'gallery-full', message: 'The gallery is at capacity right now — Jennie has been notified.' }, 507);
  }

  const caption = String(form.get('caption') || '').slice(0, 240);
  const visibility = String(form.get('visibility') || '') === 'public' ? 'public' : 'crew';
  const takenRaw = String(form.get('captured') || '');                 // EXIF date, parsed in the browser
  const taken = /^\d{4}-\d{2}-\d{2}$/.test(takenRaw) ? takenRaw : '';
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' })[file.type] || 'img';
  const key = 'gallery/' + crypto.randomUUID() + '.' + ext;

  await bucket.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { owner: s.email, ownerName: s.name || '', caption, visibility, taken, uploaded: new Date().toISOString() },
  });

  // threshold-crossing alerts (fire once, in the background)
  if (userBytes < USER_WARN && newUser >= USER_WARN) {
    context.waitUntil(notify(env, '📸 A crew member passed 900 MB', (s.name || s.email) + ' just crossed 900 MB of gallery uploads (the per-person cap is 1 GB).'));
  }
  if (total < TOTAL_WARN && newTotal >= TOTAL_WARN) {
    context.waitUntil(notify(env, '📸 Sumo gallery passed 8 GB', 'Total gallery storage just crossed 8 GB (hard cap 9 GB; R2 free tier 10 GB). Might be time to prune or bump the limit.'));
  }

  return json({ ok: true, id: key, visibility });
}

export async function onRequestDelete(context) {
  const { env } = context;
  const s = await getSession(context.request, env);
  if (!s) return json({ error: 'not-authed' }, 401);
  const bucket = env.GALLERY;
  if (!bucket) return json({ error: 'not-configured' }, 503);

  const id = new URL(context.request.url).searchParams.get('id') || '';
  if (!id) return json({ error: 'no-id' }, 400);
  const head = await bucket.head(id);
  if (!head) return json({ error: 'not-found' }, 404);
  const owner = (head.customMetadata?.owner || '').toLowerCase();
  if (owner !== s.email.toLowerCase() && !isAdmin(env, s.email)) return json({ error: 'not-yours' }, 403);

  await bucket.delete(id);
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
