// functions/api/auth/_crew.js — the guest list: WHO may log in, and what we call them.
// Helper module (leading _, and it exports NO onRequest handler) → never a URL.
//
// The real emails are NOT in this public repo. They live in Cloudflare env vars
// (Pages → Settings → Environment variables):
//   • CREW_ALLOWLIST — comma-separated emails that may log in.
//   • CREW_NAMES     — comma-separated "email:Display Name" pairs (optional).
// This module only reads and parses those. Nothing personal is committed.

function list(env) {
  return (env.CREW_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Is this email on the crew allowlist?
export function isCrew(env, email) {
  const e = String(email || '').trim().toLowerCase();
  return e !== '' && list(env).includes(e);
}

// Parse CREW_NAMES ("skr12@psu.edu:Sherry, ...") into { email: "Name" }.
// Split on the FIRST colon only, so a name may contain spaces (but not a colon).
function names(env) {
  const map = {};
  for (const pair of String(env.CREW_NAMES || '').split(',')) {
    const i = pair.indexOf(':');
    if (i > 0) {
      const email = pair.slice(0, i).trim().toLowerCase();
      const name = pair.slice(i + 1).trim();
      if (email && name) map[email] = name;
    }
  }
  return map;
}

// A friendly display name for the UI. Prefer the CREW_NAMES map; otherwise fall
// back to the email's local part (e.g. "jennie@..." -> "Jennie") so it never breaks.
export function nameFromEmail(env, email) {
  const e = String(email || '').trim().toLowerCase();
  const mapped = names(env)[e];
  if (mapped) return mapped;
  const local = e.split('@')[0] || 'crew';
  return local.charAt(0).toUpperCase() + local.slice(1);
}
