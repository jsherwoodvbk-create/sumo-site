// functions/api/cal/subscribe.js — mint (or rotate) the caller's personal calendar feed token.
// POST, member-gated. Body: { rotate?: true }. Returns { url: "/api/cal/<token>.ics" }.
//   • First call for a member  -> mints a token, returns the feed URL.
//   • rotate:true             -> new token, old URL stops resolving (for a lost/leaked link).
//   • Already has a token, no rotate -> returns the existing URL (idempotent).
// The token is an opaque bearer; the calendar carries only public dates + birthdays, so it is a
// members-only PERK, not data secrecy (a leaked link exposes a birthday calendar, nothing more).
import { requireRole, ROLES } from '../members/_members.js';
import { mintCalendarToken } from '../members/_store.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const gate = await requireRole(request, env, ROLES.MEMBER);
  if (!gate.ok) return gate.response;                       // 401 not-authed / 403 blocked

  let body = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }

  let token = gate.member.calendar_token || '';
  if (!token || body.rotate) {
    const r = await mintCalendarToken(env, gate.member);
    if (!r || !r.token) return json({ error: 'mint-failed' }, 500);
    token = r.token;
  }
  return json({ url: `/api/cal/${token}.ics` });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
