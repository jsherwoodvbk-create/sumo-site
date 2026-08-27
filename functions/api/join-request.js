// functions/api/join-request.js — PUBLIC "request to join the crew" endpoint (no auth).
// The /join form POSTs here. We store the request in KV (binding CREW_REQUESTS) as the
// DURABLE record — that's the source of truth, so nothing gets lost in an inbox — and email
// Jennie via Resend so she sees it right away. She then adds the person to CREW_ALLOWLIST by
// hand (env-var allowlist). The one-click auto-add is the going-public upgrade: it needs the
// allowlist moved into KV first, because env vars can't be written at runtime.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// best-effort email to Jennie via Resend (skipped if not configured)
async function notify(env, subject, text) {
  const to = env.JOIN_ALERT_EMAIL || env.GALLERY_ALERT_EMAIL;
  if (!env.RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Salt Stats & Sumo <sumo@stavesandhoop.com>',
        to: [to], subject, text,
      }),
    });
  } catch (e) { /* alerts are best-effort; the KV record is the source of truth */ }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'bad-json' }, 400); }

  // Honeypot: a hidden field real people never see. Bots fill it. Silently accept + drop.
  if (String(body.website || '').trim()) return json({ ok: true });

  const name = String(body.name || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
  const sumo = String(body.sumo || '').trim().slice(0, 600);
  const note = String(body.note || '').trim().slice(0, 600);
  if (!name) return json({ error: 'no-name', message: 'Please add your name.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'bad-email', message: 'That email doesn’t look right.' }, 400);
  if (!sumo) return json({ error: 'no-sumo', message: 'Tell us how you got into sumo.' }, 400);

  const at = new Date().toISOString();
  const record = { name, email, sumo, note, at, status: 'pending' };

  // DURABLE record in KV (one entry per email — a repeat request just refreshes it).
  let stored = false;
  if (env.CREW_REQUESTS) {
    try {
      await env.CREW_REQUESTS.put('req:' + email, JSON.stringify(record), { metadata: { name, at } });
      stored = true;
    } catch (e) { /* fall through — still email Jennie */ }
  }

  // Ping Jennie (best-effort, in the background).
  context.waitUntil(notify(env,
    '🧂 New crew request: ' + name,
    name + ' <' + email + '> asked to join the crew.\n\n' +
    'Into sumo via: ' + sumo + '\n\n' +
    (note ? ('Knows the crew: ' + note + '\n\n') : '') +
    'Requested ' + at + '.\n\n' +
    'To let them in: add  ' + email + ':' + name + '  to CREW_ALLOWLIST in Cloudflare, ' +
    'then they can log in at /login.'));

  return json({ ok: true, stored });
}
