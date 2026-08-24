// functions/api/auth/logout.js — clear the session wristband, send back to login.
import { clearSessionCookie } from './_session.js';

export async function onRequestGet() {
  return new Response(null, {
    status: 302,
    headers: { Location: '/login.html', 'Set-Cookie': clearSessionCookie() },
  });
}
