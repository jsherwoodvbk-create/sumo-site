// functions/api/cal/[feed].js — the member's .ics feed. Public URL, but token-gated.
// Route: /api/cal/<token>.ics  (a static /api/cal/subscribe wins over this dynamic route.)
//   token -> member (store reverse index) -> must be active -> build ICS from the calendar snapshot.
// No cookie needed — a calendar app can't carry a login, so the unguessable token IS the credential.
// A bad, rotated, or blocked-member token returns 404 (never reveals whether a token exists).
import { resolveTokenToEmail, getMember } from '../members/_store.js';
import { buildICS } from './_ics.js';
import calendar from '../_calendar.js';

export async function onRequestGet(context) {
  const { params, env } = context;
  const feed = String(params.feed || '');
  const token = feed.replace(/\.ics$/i, '');
  if (!token) return notFound();

  const email = await resolveTokenToEmail(env, token);
  if (!email) return notFound();
  const member = await getMember(env, email);
  if (!member || member.status === 'blocked') return notFound();

  const ics = buildICS(calendar, { name: 'Salt Stats & Sumo' });
  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="salt-stats-sumo.ics"',
      // calendar apps re-poll on their own schedule; an hour of caching is plenty and eases load
      'Cache-Control': 'private, max-age=3600',
    },
  });
}

function notFound() { return new Response('Not found', { status: 404 }); }
