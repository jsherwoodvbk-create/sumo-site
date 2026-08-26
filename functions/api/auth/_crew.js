// functions/api/auth/_crew.js — the guest list: WHO may log in, and what we call them.
// Helper module (leading _, and it exports NO onRequest handler) → never a URL.
//
// The real emails are NOT in this public repo. They live in ONE Cloudflare env var
// (Pages → Settings → Environment variables):
//   CREW_ALLOWLIST — comma-separated entries, each "email" or "email:Display Name".
//     e.g.  jennie@stavesandhoop.com:Jennie, skr12@psu.edu:Sherry
// One list is the whole guest book: who may enter, and what we greet them as.

function entries(env) {
  return String(env.CREW_ALLOWLIST || '')
    .split(',')
    .map((s) => {
      const raw = s.trim();
      if (!raw) return null;
      const i = raw.indexOf(':');                       // split on the FIRST colon only
      const email = (i > 0 ? raw.slice(0, i) : raw).trim().toLowerCase();
      const name = i > 0 ? raw.slice(i + 1).trim() : '';
      return email ? { email, name } : null;
    })
    .filter(Boolean);
}

// Is this email on the crew allowlist?
export function isCrew(env, email) {
  const e = String(email || '').trim().toLowerCase();
  return e !== '' && entries(env).some((x) => x.email === e);
}

// A friendly display name for the UI. Prefer the name in the allowlist entry;
// otherwise fall back to the email's local part (e.g. "jennie@..." -> "Jennie")
// so a bare-email entry never breaks.
export function nameFromEmail(env, email) {
  const e = String(email || '').trim().toLowerCase();
  const hit = entries(env).find((x) => x.email === e);
  if (hit && hit.name) return hit.name;
  const local = e.split('@')[0] || 'crew';
  return local.charAt(0).toUpperCase() + local.slice(1);
}
