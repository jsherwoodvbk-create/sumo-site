// functions/api/auth/me.js — who's wearing the wristband? The frontend reads identity here
// (it can't read the HttpOnly cookie itself). Returns {authenticated, name, email}.
import { getSession } from './_session.js';

export async function onRequestGet(context) {
  const s = await getSession(context.request, context.env);
  if (!s) {
    return new Response('{"authenticated":false}', {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ authenticated: true, name: s.name, email: s.email }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
