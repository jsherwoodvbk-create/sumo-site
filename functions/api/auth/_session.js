// functions/api/auth/_session.js — the "wristband": sign & verify a session token.
// Helper module (leading _, no onRequest export) → never a URL.
//
// A session is a small SIGNED token: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
// The payload holds { email, name, exp } (exp = unix seconds). The signature is made with
// AUTH_SECRET (a Cloudflare env secret) so nobody can forge or tamper with a token.
// Stateless: nothing is stored server-side, so no database is needed yet.

const COOKIE_NAME = 'ss_session';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

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

// Make a signed token from a payload object.
export async function signSession(env, payload) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(env);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return body + '.' + b64urlEncode(sig);
}

// Verify a token; return the payload if valid & unexpired, else null.
export async function verifySession(env, token) {
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

// Build a session for a crew member → returns a Set-Cookie header value.
export async function makeSessionCookie(env, { email, name }, ttl = DEFAULT_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const token = await signSession(env, { email, name, exp });
  return cookie(COOKIE_NAME, token, ttl);
}

// Read + verify the session from a request's Cookie header. Returns payload|null.
export async function getSession(request, env) {
  const token = readCookie(request, COOKIE_NAME);
  return token ? verifySession(env, token) : null;
}

// A Set-Cookie value that clears the session (logout).
export function clearSessionCookie() {
  return cookie(COOKIE_NAME, '', 0);
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
