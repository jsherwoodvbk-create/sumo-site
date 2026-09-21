// functions/api/members/_members.js — ROLES + IDENTITY (substrate-agnostic).
//
// The one place the app asks "who is this caller, and may they do X?" The session cookie
// IDENTIFIES (getSession -> {email, name}); this module AUTHORIZES by reading the member store.
// Server is the only authority: a member cannot self-promote — only a super-admin writes roles.
//
// It also collapses the old sprawl. gallery-admin / crew-membership / blocked / calendar-editor
// were four separate env lists; here they are one question — "what role does this member have?" —
// answered the same way everywhere via resolveMember() + atLeast().
//
// ENV IS BOOTSTRAP ONLY. Before the store is seeded (or if a KV read fails), a caller's record is
// DERIVED from the env lists so nobody is ever locked out mid-rollout — then lazily persisted, so
// the store becomes the source of truth as people use the site. Once a super-admin CHANGES a role,
// the stored record wins (getMember is consulted first; env is only the fallback for the unknown).
//
// Bootstrap env (all optional, comma-separated emails unless noted):
//   SUPER_ADMINS    -> seed as 'super-admin' (Jennie today; add James here later, no code change)
//   CREW_ALLOWLIST  -> seed as 'admin'  (email or email:Name — the existing guest list; "everyone
//                      is admin today" is this fact, not a hardcoded rule)
//   GALLERY_ADMINS  -> also 'admin' (honored for continuity; redundant while crew = admin)
//   GALLERY_BLOCKED -> status 'blocked'

import { getSession } from '../auth/_session.js';
import { nameFromEmail } from '../auth/_crew.js';
import { getMember, patchMember, normEmail, hasStore } from './_store.js';

// ---- the role model --------------------------------------------------------

export const ROLES = { SUPER: 'super-admin', ADMIN: 'admin', MEMBER: 'member' };
const RANK = { 'member': 1, 'admin': 2, 'super-admin': 3 };

// caller's role >= the required role? Unknown roles rank 0 (deny).
export function atLeast(role, minRole) {
  return (RANK[role] || 0) >= (RANK[minRole] || 99);
}

// ---- env bootstrap ---------------------------------------------------------

function envEmails(env, key) {
  return String(env[key] || '')
    .split(',')
    .map((s) => {
      const raw = s.trim();
      if (!raw) return '';
      const i = raw.indexOf(':');          // tolerate "email:Name" entries (CREW_ALLOWLIST shape)
      return (i > 0 ? raw.slice(0, i) : raw).trim().toLowerCase();
    })
    .filter(Boolean);
}

// Derive the record an email SHOULD have from the env lists, without writing anything. Used as the
// fail-soft fallback for an unknown/again-unreadable member, and as the per-email unit of seeding.
export function bootstrapRecord(env, email) {
  const e = normEmail(email);
  const supers = envEmails(env, 'SUPER_ADMINS');
  const crew = envEmails(env, 'CREW_ALLOWLIST');
  const galAdmins = envEmails(env, 'GALLERY_ADMINS');
  const blocked = envEmails(env, 'GALLERY_BLOCKED');
  let role = ROLES.MEMBER;
  if (crew.includes(e) || galAdmins.includes(e)) role = ROLES.ADMIN;
  if (supers.includes(e)) role = ROLES.SUPER;
  return {
    email: e,
    name: nameFromEmail(env, e),
    role,
    status: blocked.includes(e) ? 'blocked' : 'active',
    calendar_token: '',
    created_at: null,
    updated_at: null,
  };
}

// ---- resolve the caller ----------------------------------------------------

// The caller's member record, or null if there's no valid session.
//   1. verified session -> email
//   2. stored record wins if present (respects any super-admin change)
//   3. else derive from env bootstrap, and lazily persist it (best-effort) so the store fills in
// Fail-soft throughout: a store outage still yields the env-derived record (deny elevated actions,
// never crash), and never silently elevates — an unknown email lands at 'member'/'active' at most
// what the env lists say.
export async function resolveMember(request, env) {
  const s = await getSession(request, env);
  if (!s || !s.email) return null;
  const email = normEmail(s.email);

  const stored = await getMember(env, email);
  if (stored) {
    // keep the display name fresh from the session if the record never captured one
    if (!stored.name && s.name) stored.name = s.name;
    return stored;
  }

  const boot = bootstrapRecord(env, email);
  if (s.name && !boot.name) boot.name = s.name;
  if (hasStore(env)) {
    // lazily write the derived record so the store becomes truth as members show up (best-effort)
    const written = await patchMember(env, boot, {});
    if (written) return written;
  }
  return boot;
}

// ---- the gate --------------------------------------------------------------

// Authorize the caller for a minimum role. Returns { ok:true, member } or { ok:false, response }
// where response is a typed JSON error the endpoint can return directly — same contract as /api/fan:
//   401 not-authed   : no valid session
//   403 blocked      : status = blocked
//   403 not-authorized: role below the requirement
export async function requireRole(request, env, minRole = ROLES.MEMBER) {
  const member = await resolveMember(request, env);
  if (!member) return { ok: false, response: errJson('not-authed', 401) };
  if (member.status === 'blocked') return { ok: false, response: errJson('blocked', 403) };
  if (!atLeast(member.role, minRole)) return { ok: false, response: errJson('not-authorized', 403) };
  return { ok: true, member };
}

export function errJson(error, status) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---- convenience predicates (for non-endpoint callers) ---------------------

export function isActive(member) { return !!member && member.status !== 'blocked'; }
export function isAdmin(member) { return isActive(member) && atLeast(member.role, ROLES.ADMIN); }
export function isSuper(member) { return isActive(member) && atLeast(member.role, ROLES.SUPER); }
