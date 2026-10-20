// functions/api/app/fantasy.js — a member's fantasy roster, stored in Cloudflare KV.
// Members only (self-gated: /app middleware does NOT cover /api/*, so this checks the
// session itself, same as prediction.js). One JSON doc per (member, basho), keyed
// fantasy:{basho}:{league}:{email}.
//
// Bindings/env: reuses the KV namespace `PREDICTIONS` (keys are namespaced `fantasy:…`
//   vs `pred:…`, so no new binding is required — add a dedicated `FANTASY` binding later
//   if you want them separated). Current fantasy basho in env `FANTASY_BASHO`.
//
// IDENTITY IS SERVER-DERIVED: the member is taken from the verified session (s.email),
// never from the request body. The page may send `member`/`basho`/`leagueId` for its own
// convenience; the server ignores them and trusts the session + env + the one crew league.
import { getSession } from '../auth/_session.js';

const LEAGUE = 'crew'; // crew scale: one league. Generalize to the member's league(s) when public leagues land.

export async function onRequestGet(context) {
  const { request, env } = context;
  const s = await getSession(request, env);
  if (!s) return json({ error: 'not-authed' }, 401);
  const basho = env.FANTASY_BASHO || '';
  const key = `fantasy:${basho}:${LEAGUE}:${String(s.email).toLowerCase()}`;
  const saved = await env.PREDICTIONS.get(key);
  const doc = saved ? JSON.parse(saved) : null;
  return json({
    basho,
    league: LEAGUE,
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
  const basho = env.FANTASY_BASHO || '';
  const key = `fantasy:${basho}:${LEAGUE}:${String(s.email).toLowerCase()}`;
  const doc = {
    email: s.email,
    name: s.name,
    league: LEAGUE,
    basho,
    picks: (body && body.picks) ? body.picks : {}, // { <rung>: <WrestlerName> }
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
