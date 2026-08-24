// functions/_middleware.js — ROOT middleware.
// A ROOT _middleware.js runs in front of EVERYTHING, including static pages — which is
// exactly what's needed to gate the static /app pages. (A nested functions/app/_middleware.js
// only fires for Pages *Functions* under /app, NOT for the static app/index.html — that was
// the bug: the doorman was one level too deep to guard a static page.)
//
// It gates ONLY the /app area; every other path (home, standings, gumbai, /api/*, images)
// passes straight through untouched, so nothing else changes.
import { getSession } from './api/auth/_session.js';

export async function onRequest(context) {
  const path = new URL(context.request.url).pathname;

  // Only the /app area is protected. Everything else is public — pass it through.
  const inAppArea = path === '/app' || path.startsWith('/app/');
  if (!inAppArea) return context.next();

  const session = await getSession(context.request, context.env);
  if (!session) {
    return new Response(null, { status: 302, headers: { Location: '/login.html' } });
  }
  return context.next(); // logged in → serve the requested /app page
}
