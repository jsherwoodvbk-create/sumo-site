// functions/api/img.js — serve one gallery image from R2 by ?id=<key>.
// A `public` photo serves to anyone; a `crew` photo requires a valid session — so a
// crew-only shot can't be pulled up by a stranger even with a direct link.
import { getSession } from './auth/_session.js';

export async function onRequestGet(context) {
  const id = new URL(context.request.url).searchParams.get('id') || '';
  if (!id) return new Response('missing id', { status: 400 });
  const bucket = context.env.GALLERY;
  if (!bucket) return new Response('not configured', { status: 503 });

  const obj = await bucket.get(id);
  if (!obj) return new Response('not found', { status: 404 });

  const visibility = obj.customMetadata?.visibility || 'crew';
  if (visibility !== 'public') {
    const s = await getSession(context.request, context.env);
    if (!s) return new Response('members only', { status: 403 });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);                       // Content-Type etc. from the stored object
  headers.set('etag', obj.httpEtag);
  headers.set('Cache-Control', visibility === 'public' ? 'public, max-age=3600' : 'private, no-store');
  return new Response(obj.body, { headers });
}
