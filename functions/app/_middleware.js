// functions/app/_middleware.js — the DOORMAN for everything under /app.
// Runs before any /app page or asset loads. Valid wristband → let through (next()).
// No wristband → bounce to the login page. This is what makes a static page login-gated.
import { getSession } from '../api/auth/_session.js';

export async function onRequest(context) {
  const session = await getSession(context.request, context.env);
  if (!session) {
    return new Response(null, { status: 302, headers: { Location: '/login.html' } });
  }
  return context.next(); // authenticated → serve the requested /app page
}
