// functions/api/gallery.js — PUBLIC gallery feed. No auth.
// Lists ONLY photos tagged `public`. Crew-only photos never appear here.
// Storage = Cloudflare R2 (binding GALLERY). Bytes served by /api/img (gates crew-only).

export async function onRequestGet(context) {
  const bucket = context.env.GALLERY;
  if (!bucket) return json({ photos: [] });   // bucket not bound yet → empty, never errors

  const out = [];
  let cursor;
  do {
    const list = await bucket.list({ include: ['customMetadata'], cursor, limit: 1000 });
    for (const o of list.objects) {
      const m = o.customMetadata || {};
      if ((m.visibility || 'crew') !== 'public') continue;
      out.push({
        id: o.key,
        src: '/api/img?id=' + encodeURIComponent(o.key),
        caption: m.caption || '',
        by: m.ownerName || '',
        taken: m.taken || '',
        uploaded: m.uploaded || '',
      });
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);

  out.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded))); // newest first
  return json({ photos: out });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
