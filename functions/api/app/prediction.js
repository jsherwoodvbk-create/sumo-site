// functions/api/app/prediction.js — a member's banzuke picks, stored in Cloudflare KV.
// Members only (self-gated: the /app middleware does NOT cover /api/*, so this checks the
// session itself). One JSON doc per (member, basho), keyed pred:{basho}:{email}.
// Bindings/env: KV namespace `PREDICTIONS`; current basho in env `PREDICT_BASHO`.
import { getSession } from '../auth/_session.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const s = await getSession(request, env);
  if (!s) return json({ error: 'not-authed' }, 401);
  const key = `pred:${env.PREDICT_BASHO}:${s.email}`;
  const saved = await env.PREDICTIONS.get(key);
  const doc = saved ? JSON.parse(saved) : null;
  return json({
    basho: env.PREDICT_BASHO,
    name: s.name,
    picks: doc?.picks ?? null,
    savedAt: doc?.savedAt ?? null,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const s = await getSession(request, env);
  if (!s) return json({ error: 'not-authed' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad-json' }, 400); }
  const key = `pred:${env.PREDICT_BASHO}:${s.email}`;
  const doc = {
    email: s.email,
    name: s.name,
    basho: env.PREDICT_BASHO,
    picks: body.picks ?? {},
    savedAt: Date.now(),
  };
  await env.PREDICTIONS.put(key, JSON.stringify(doc));
  return json({ ok: true, savedAt: doc.savedAt });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
