// functions/api/auth/request-link.js — magic-link REQUEST: email a one-time login link.
// The login form POSTs here. On a crew email we sign a 15-min magic token, build a link to
// /api/auth/verify, and email it via Resend. Real proof-of-ownership: only the inbox owner
// can click the link. (This replaces the dev-login fake lock.)
import { isCrew } from './_crew.js';
import { signMagicToken } from './_session.js';
import { sendMagicLink } from './_email.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const form = await request.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();

  if (!isCrew(env, email)) {
    return redirect('/login.html?error=notcrew');
  }
  const token = await signMagicToken(env, email);
  const origin = new URL(request.url).origin;
  const link = `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  try {
    await sendMagicLink(env, email, link);
  } catch (e) {
    return redirect('/login.html?error=send');
  }
  return redirect('/login.html?sent=1');
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}
