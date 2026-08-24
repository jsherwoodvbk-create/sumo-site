# Salt Stats & Sumo — repo guide (root CLAUDE.md)

This repo is **`sumo-site`**: a sumo tracker that is becoming a **crew platform**. It has two faces on one Cloudflare Pages project:
- a **public showcase** anyone can visit (standings, the Gumbai oracle, reports, galleries) — no login, and
- an **authenticated app at `/app`** (in progress) where each crew member has their own identity, picks, and files.

The guiding rule for all work here: **evolve, don't rewrite.** New capability extends the existing static-site-plus-Functions stack; it does not replace it.

## How this site is built (no framework, no build step)
- **Root = static assets**, served directly. `index.html` is `/`; `standings.html`, `gumbai.html`, `prediction.html`, `gallery.html`, `drinking-game.html` are their own pages. Hand-written HTML + vanilla JS. There is no bundler and no framework — keep it that way unless a change is discussed.
- **`functions/api/` = Cloudflare Pages Functions** (server-side JS). **Each file is an API route**: `functions/api/gumbai.js` → `/api/gumbai`, `functions/api/fan.js` → `/api/fan`.
- **A leading underscore means "not a route — shared module."** `functions/api/_engine.js` and `_snapshot.js` are imported by the route handlers and never served. This is the project's convention for private/shared server code, and the auth layer reuses it (`functions/api/auth/_session.js`, etc.).
- **`_snapshot.js` is GENERATED — never hand-edit it.** `gen-gumbai-snapshot.mjs` rebuilds it from Notion. Editing it by hand is always wrong; the next generator run overwrites it.

## Data & deploy
- **Notion is the data-of-record** (for now — a SQL/D1 move is deferred until per-member identity/access demands it; see the crew-platform model doc). Generators pull Notion → static files (`build-standings.mjs` → `standings.html`; `gen-gumbai-snapshot.mjs` → `functions/api/_snapshot.js`).
- **Cloudflare Pages auto-deploys on every push to `main`.** `.github/workflows/publish.yml` regenerates data and pushes; that push is what triggers the deploy. `publish.yml` runs `node test-engine.mjs` (53 checks) as its FIRST step — a failing engine test fails the whole publish, so a broken engine can never ship.
- **Verify a deploy** at `GET /api/gumbai` — it reports the live `ENGINE_VERSION`, schema, tools, and flags.

## Conventions (match these)
- **Code files are hyphen-named**: `gen-gumbai-snapshot.mjs`, `build-standings.mjs`, `test-engine.mjs`. Follow suit for new code.
- **This repo is PUBLIC. Never commit a secret** — API tokens, signing keys, passwords. Secrets live in Cloudflare Pages environment variables (marked as secrets) and in GitHub Actions secrets (`NOTION_TOKEN`). Read them via `env`/`process.env`, never hardcode.
- **The hard-vs-soft data firewall is sacred.** Results, ranks, kimarite, records, yusho come ONLY from sumo-api / the Match Log. Transcript/observational ("soft") data is COLOR ONLY and must never establish a result.

## Path-specific guides (read the nearest one)
- `functions/CLAUDE.md` — how to write a Pages Function (routing, env, the `_`-module rule, auth patterns).
- `app/CLAUDE.md` — rules for the authenticated app frontend under `/app`.

## The app layer (being built)
- **`/app/*` is login-gated** by `functions/app/_middleware.js` (a doorman that checks the session cookie on every `/app` request).
- **Auth = magic link**, backed by a small hardcoded crew allowlist to start (no database yet). Sessions are **stateless signed cookies** (HMAC with `AUTH_SECRET`). A dev-login stub exists during the skeleton phase — it is a FAKE LOCK and must be removed/disabled before any real launch.
- **The dividing line is CONSUME vs IDENTITY**: anything you just consume stays public; anything that must know *who you are* (your picks, your files, your standings row) lives behind `/app`.
