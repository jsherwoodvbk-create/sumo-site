// functions/api/auth/verify.js — magic-link VERIFY: the emailed link lands here.
// Verify the token (signature + 15-min expiry + purpose), re-check the email is still on the
// crew list, then mint the real 14-day session cookie and drop them at /app/.
import { isCrew, nameFromEmail } from './_crew.js';
import { verifyMagicToken, makeSessionCookie } from './_session.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = new URL(request.url).searchParams.get('token') || '';
  const email = await verifyMagicToken(env, token);

  if (!email || !isCrew(env, email)) {
    return redirect('/login.html?error=expired');
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
