// functions/api/members/_store.js — THE MEMBER STORE (substrate adapter).
//
// This is the ONE file that touches the storage engine. Everything else in the app calls the
// functions exported here and never talks to KV directly — so moving KV -> D1 later (when a paid
// tier or real scale forces it) is a swap of THIS file plus a tiny copy-the-rows migration, and
// no caller changes. Same adapter discipline that made the gallery a clean KV<->R2 swap.
//
// SUBSTRATE (today): Cloudflare KV, binding `MEMBERS`.
//   member:<email>      -> the member record (JSON)           the source of truth per person
//   caltoken:<token>    -> <email>                            reverse index for the .ics feed
//
// A member record:
//   { email, name, role, status, calendar_token, created_at, updated_at }
//     role   : 'super-admin' | 'admin' | 'member'   (hierarchy lives in _members.js)
//     status : 'active' | 'blocked'
//     calendar_token : the current .ics feed token, or '' if the member hasn't subscribed
//
// Every function here is FAIL-SOFT by design: a KV hiccup returns null / false rather than
// throwing, so a store outage denies an elevated action (see _members.js) instead of crashing a
// page. Callers treat "no record" as "fall back to the env bootstrap," never as "let them in."

export const MEMBER_PREFIX = 'member:';
export const TOKEN_PREFIX = 'caltoken:';

// Normalize an email the one way the whole system agrees on: trimmed, lowercased.
export function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Is the store even wired up? (Lets callers degrade gracefully before the KV binding exists.)
export function hasStore(env) {
  return !!(env && env.MEMBERS);
}

// ---- reads -----------------------------------------------------------------

// One member by email, or null if not stored (or on any read error — fail-soft).
export async function getMember(env, email) {
  const e = normEmail(email);
  if (!e || !hasStore(env)) return null;
  try {
    const raw = await env.MEMBERS.get(MEMBER_PREFIX + e);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null; // treat a read failure as "unknown" — the caller falls back to env bootstrap
  }
}

// Every member. Uses list metadata (a light {name,role,status} summary written on put) so the
// admin roster renders without an N-read fan-out; falls back to a full get if metadata is missing.
// Crew-scale only — a KV prefix scan is the right tool for dozens, not thousands (that's the D1 line).
export async function listMembers(env) {
  if (!hasStore(env)) return [];
  const out = [];
  try {
    let cursor;
    do {
      const page = await env.MEMBERS.list({ prefix: MEMBER_PREFIX, cursor, limit: 1000 });
      for (const k of page.keys) {
        const email = k.name.slice(MEMBER_PREFIX.length);
        const m = k.metadata;
        if (m && m.role) {
          out.push({ email, name: m.name || '', role: m.role, status: m.status || 'active' });
        } else {
          const full = await getMember(env, email);
          if (full) out.push({ email, name: full.name || '', role: full.role, status: full.status || 'active' });
        }
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  } catch (_) { /* return whatever we gathered — fail-soft */ }
  return out;
}

// Resolve a calendar feed token to its owner's email, or null. The .ics endpoint's only lookup.
export async function resolveTokenToEmail(env, token) {
  const t = String(token || '').trim();
  if (!t || !hasStore(env)) return null;
  try {
    return (await env.MEMBERS.get(TOKEN_PREFIX + t)) || null;
  } catch (_) {
    return null;
  }
}

// ---- writes ----------------------------------------------------------------

// Create or replace a member record. Stamps created_at once and updated_at every time, and mirrors
// a {name,role,status} summary into KV metadata for listMembers. Returns the written record, or
// null on failure (fail-soft — the caller decides whether that failure blocks the action).
export async function putMember(env, record) {
  if (!hasStore(env)) return null;
  const email = normEmail(record.email);
  if (!email) return null;
  const now = new Date().toISOString();
  const prior = await getMember(env, email);
  const rec = {
    email,
    name: record.name != null ? record.name : (prior?.name || ''),
    role: record.role || prior?.role || 'member',
    status: record.status || prior?.status || 'active',
    calendar_token: record.calendar_token != null ? record.calendar_token : (prior?.calendar_token || ''),
    created_at: prior?.created_at || record.created_at || now,
    updated_at: now,
  };
  try {
    await env.MEMBERS.put(MEMBER_PREFIX + email, JSON.stringify(rec), {
      metadata: { name: rec.name, role: rec.role, status: rec.status },
    });
    return rec;
  } catch (_) {
    return null;
  }
}

// Merge a partial patch onto an existing (or bootstrap) record and persist it. `base` is the
// current record the caller already resolved (from the store OR the env bootstrap), so a member
// who only exists in env gets written on first change. Returns the new record, or null on failure.
export async function patchMember(env, base, patch) {
  return putMember(env, { ...base, ...patch, email: base.email });
}

// ---- calendar tokens -------------------------------------------------------

// A fresh, unguessable feed token: 32 random bytes, base64url (~43 chars, URL-safe, no padding).
export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mint (or rotate) a member's calendar token: make a new one, point caltoken:<new> at the member,
// write it onto the record, and delete the OLD reverse-index entry so the previous URL 404s at once.
// `base` is the member's current record (store or bootstrap). Returns { record, token } or null.
export async function mintCalendarToken(env, base) {
  if (!hasStore(env)) return null;
  const email = normEmail(base.email);
  if (!email) return null;
  const oldToken = base.calendar_token || '';
  const token = randomToken();
  try {
    await env.MEMBERS.put(TOKEN_PREFIX + token, email);
    const rec = await patchMember(env, base, { calendar_token: token });
    if (!rec) { // record write failed — don't leave a dangling reverse index
      try { await env.MEMBERS.delete(TOKEN_PREFIX + token); } catch (_) {}
      return null;
    }
    if (oldToken && oldToken !== token) {
      try { await env.MEMBERS.delete(TOKEN_PREFIX + oldToken); } catch (_) {}
    }
    return { record: rec, token };
  } catch (_) {
    return null;
  }
}

// Revoke a member's calendar token entirely (feed stops resolving). Returns the record or null.
export async function clearCalendarToken(env, base) {
  if (!hasStore(env)) return null;
  const oldToken = base.calendar_token || '';
  const rec = await patchMember(env, base, { calendar_token: '' });
  if (oldToken) { try { await env.MEMBERS.delete(TOKEN_PREFIX + oldToken); } catch (_) {} }
  return rec;
}
