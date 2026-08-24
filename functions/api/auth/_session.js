// functions/api/auth/_session.js — the "wristband": sign & verify tokens.
// Helper module (leading _, no onRequest export) → never a URL.
//
// Two token kinds, both HMAC-signed with AUTH_SECRET, told apart by a `purpose` field so one
// can never be used as the other:
//   • SESSION  {email, name, purpose:'session', exp}  — the 14-day login cookie.
//   • MAGIC    {email,       purpose:'magic',   exp}  — the 15-min one-time login link token.
// Stateless: nothing is stored server-side, so no database is needed yet.

const COOKIE_NAME = 'ss_session';
const SESSION_TTL = 60 * 60 * 24 * 14; // 14 days
const MAGIC_TTL = 60 * 15;             // 15 minutes

const enc = new TextEncoder();

// ---- base64url helpers (Workers provide btoa/atob) ----
function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(env) {
  if (!env.AUTH_SECRET) throw new Error('AUTH_SECRET is not set');
  return crypto.subtle.importKey(
    'raw', enc.encode(env.AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

// ---- generic sign / verify ----
export async function signToken(env, payload) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(env);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return body + '.' + b64urlEncode(sig);
}
export async function verifyToken(env, token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  try {
    const key = await hmacKey(env);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (!payload.exp || Date.now() / 1000 > payload.exp) return null; // expired
    return payload;
  } catch {
    return null;
  }
}

// ---- SESSION cookie (login) ----
export async function makeSessionCookie(env, { email, name }, ttl = SESSION_TTL) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const token = await signToken(env, { email, name, purpose: 'session', exp });
  return cookie(COOKIE_NAME, token, ttl);
}
export async function getSession(request, env) {
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;
  const p = await verifyToken(env, token);
  return p && p.purpose === 'session' ? p : null;
}
export function clearSessionCookie() {
  return cookie(COOKIE_NAME, '', 0);
}

// ---- MAGIC token (one-time login link) ----
export async function signMagicToken(env, email, ttl = MAGIC_TTL) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return signToken(env, { email, purpose: 'magic', exp });
}
// Returns the email if the token is a valid, unexpired magic token, else null.
export async function verifyMagicToken(env, token) {
  const p = await verifyToken(env, token);
  return p && p.purpose === 'magic' ? p.email : null;
}

// ---- cookie plumbing ----
function cookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
