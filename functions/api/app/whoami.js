// functions/api/app/whoami.js — "who am I, and what may I do?" (self-gated, read-only).
//
// The smoke test for the membership foundation: hit it while logged in and you get your resolved
// member record from the store (or the env bootstrap, before seeding). Confirms end-to-end that the
// session -> member-store -> role resolution works. Also the clean source for a "Signed in as
// <name> · <role>" chip in /app. Never exposes the calendar token itself — only whether one exists.
import { resolveMember } from '../members/_members.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const m = await resolveMember(request, env);
  if (!m) return json({ error: 'not-authed' }, 401);
  return json({
    email: m.email,
    name: m.name,
    role: m.role,               // member | admin | super-admin
    status: m.status,           // active | blocked
    subscribed: !!m.calendar_token,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
