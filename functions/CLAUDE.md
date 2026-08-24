# functions/ — Cloudflare Pages Functions (server-side)

Everything here runs on Cloudflare's edge (the **Workers runtime**), NOT Node. Web APIs only — `fetch`, `Request`/`Response`, `crypto.subtle`. There is no `fs` and no `process` here (those belong to the `.mjs` generator scripts that run on Node in GitHub Actions).

## Routing
- **A file = a route.** `functions/api/gumbai.js` → `/api/gumbai`. `functions/api/auth/logout.js` → `/api/auth/logout`.
- **Leading `_` = NOT a route — a shared module** you import from siblings (`_engine.js`, `_snapshot.js`, `auth/_session.js`, `auth/_crew.js`). Never served to the public.
- **`_middleware.js` = runs for every request in its folder and below**, before the route or static asset. `functions/app/_middleware.js` guards all of `/app/*`, static pages included — this is how a static page gets login-gated.

## Handler shape
Export `onRequest` (any method) or `onRequestGet` / `onRequestPost` / etc. You receive a `context`:
```
export async function onRequestPost(context) {
  const { request, env, next } = context;
  // env.AUTH_SECRET  ← secrets & vars come from context.env (NOT process.env)
  return new Response('ok');
}
```
- **Secrets come from `context.env`** (`env.AUTH_SECRET`, …). Set them in Cloudflare Pages → Settings → Environment variables, marked as encrypted secrets. **NEVER hardcode a secret — this repo is public.**
- **Always return a `Response`.** Redirect with `new Response(null, { status: 302, headers: { Location: '/app/' } })`.

## Auth rules (the /app layer)
- **The server is the only authority.** The middleware + Functions decide who may do what by verifying the **signed session cookie** (`auth/_session.js`). Never trust anything the browser asserts about identity — a cookie is trusted only after its HMAC signature verifies.
- **Cookies are `HttpOnly; Secure; SameSite=Lax; Path=/`.** HttpOnly means page JavaScript cannot read them — on purpose. A page learns who's logged in by calling `/api/auth/me`, never by reading the cookie.
- **Least privilege.** A Function exposes only what its caller needs. Public endpoints stay public; identity endpoints verify the session first.

## Don't break the firewall
Result/record data comes only from sumo-api / the Match Log (see root `CLAUDE.md`). A Function that serves data must never let soft/observational data stand in for a hard result. Keep Notion off the per-request hot path — read generated snapshots, not Notion live.
