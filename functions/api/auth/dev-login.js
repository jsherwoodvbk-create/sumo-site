// functions/api/auth/dev-login.js — DEV-ONLY fake-lock login (skeleton phase).
// Trusts that whoever submits a crew email IS that person — NO proof of ownership.
// This is a FAKE LOCK to prove the plumbing. It MUST be removed/disabled before any
// real launch and replaced by real magic-link email verification.
import { isCrew, nameFromEmail } from './_crew.js';
import { makeSessionCookie } from './_session.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const form = await request.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();

  if (!isCrew(env, email)) {
    // not on the guest list → back to login with an error flag
    return redirect('/login.html?error=1');
  }
  const cookie = await makeSessionCookie(env, { email, name: nameFromEmail(email) });
  return new Response(null, {
    status: 302,
    headers: { Location: '/app/', 'Set-Cookie': cookie },
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}
