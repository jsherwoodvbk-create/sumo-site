// functions/api/auth/_crew.js — the guest list: WHO may log in.
// Helper module (leading _, and it exports NO onRequest handler) → never a URL.
//
// The real emails are NOT in this public repo. They live in the Cloudflare
// env var CREW_ALLOWLIST (comma-separated), set in Pages → Settings →
// Environment variables. This module only reads and parses that list.

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

// A friendly display name for the UI, derived from the email's local part
// (so no real names/emails need to live in the repo). e.g. "jennie@..." -> "Jennie".
export function nameFromEmail(email) {
  const local = String(email || '').split('@')[0] || 'crew';
  return local.charAt(0).toUpperCase() + local.slice(1);
}
