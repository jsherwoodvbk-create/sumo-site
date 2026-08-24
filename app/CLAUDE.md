# app/ — the authenticated app frontend (/app)

Every page in this folder is served under `/app/` and sits BEHIND the doorman (`functions/app/_middleware.js`). By the time one of these pages loads, the visitor already has a valid session — the middleware bounced anyone who didn't.

## Rules
- **The page is UI, not the guard.** Never make a security decision in browser JavaScript. The middleware and the Functions are the source of truth. Anyone can open dev tools — assume they will — so a check done only in the page means nothing.
- **To show who's logged in, ask the server.** Fetch `/api/auth/me`, which reads the verified session cookie server-side and returns `{ name, email }`. Do NOT try to read the session cookie in JS — it's `HttpOnly` by design and unreadable.
- **Match the site's style.** Hand-written HTML + vanilla JS, same look and feel as the public showcase pages. No framework, no build step.
- **Consume vs identity.** If a feature only *consumes* shared data, it probably belongs on the public showcase, not here. `/app` is for things that must know *who you are* — your picks, your files, your standings row.
- **Log out** by linking to `/api/auth/logout` (clears the cookie and sends you back to `/login.html`).
