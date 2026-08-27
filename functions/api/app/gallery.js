// functions/api/app/gallery.js — the CREW gallery (members only). Self-gated via getSession.
//   GET    → list ALL photos (public + crew-only), each flagged `mine` for the delete UI.
//   POST   → upload one photo (multipart: photo, caption, visibility=public|crew).
//   DELETE → remove one photo by ?id= , but ONLY if the session owns it.
// Bytes live in R2 (binding GALLERY); this never caches/copies them, so a delete truly retracts.
import { getSession } from '../auth/_session.js';

const MAX_BYTES = 15 * 1024 * 1024;                 // 15 MB / photo
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

export async function onRequestGet(context) {
  const s = await getSession(context.request, context.env);
  if (!s) return json({ error: 'not-authed' }, 401);
  const bucket = context.env.GALLERY;
  if (!bucket) return json({ photos: [] });

  const out = [];
  let cursor;
  do {
    const list = await bucket.list({ include: ['customMetadata'], cursor, limit: 1000 });
    for (const o of list.objects) {
      const m = o.customMetadata || {};
      out.push({
        id: o.key,
        src: '/api/img?id=' + encodeURIComponent(o.key),
        caption: m.caption || '',
        by: m.ownerName || '',
        visibility: m.visibility || 'crew',
        uploaded: m.uploaded || '',
        mine: (m.owner || '') === s.email,        // drives the delete button
      });
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);

  out.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
  return json({ photos: out });
}

export async function onRequestPost(context) {
  const s = await getSession(context.request, context.env);
  if (!s) return json({ error: 'not-authed' }, 401);
  const bucket = context.env.GALLERY;
  if (!bucket) return json({ error: 'not-configured' }, 503);

  let form;
  try { form = await context.request.formData(); }
  catch { return json({ error: 'bad-form' }, 400); }

  const file = form.get('photo');
  if (!file || typeof file === 'string' || !file.size) return json({ error: 'no-file' }, 400);
  if (!OK_TYPES.includes(file.type)) return json({ error: 'bad-type', got: file.type }, 415);
  if (file.size > MAX_BYTES) return json({ error: 'too-big', max: MAX_BYTES }, 413);

  const caption = String(form.get('caption') || '').slice(0, 240);
  const visibility = String(form.get('visibility') || '') === 'public' ? 'public' : 'crew';
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' })[file.type] || 'img';
  const key = 'gallery/' + crypto.randomUUID() + '.' + ext;

  await bucket.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      owner: s.email, ownerName: s.name || '', caption, visibility,
      uploaded: new Date().toISOString(),
    },
  });
  return json({ ok: true, id: key, visibility });
}

export async function onRequestDelete(context) {
  const s = await getSession(context.request, context.env);
  if (!s) return json({ error: 'not-authed' }, 401);
  const bucket = context.env.GALLERY;
  if (!bucket) return json({ error: 'not-configured' }, 503);

  const id = new URL(context.request.url).searchParams.get('id') || '';
  if (!id) return json({ error: 'no-id' }, 400);
  const head = await bucket.head(id);
  if (!head) return json({ error: 'not-found' }, 404);
  if ((head.customMetadata?.owner || '') !== s.email) return json({ error: 'not-yours' }, 403);

  await bucket.delete(id);
  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
