// Cloudflare Pages Function — POST /api/fan
// Single intake endpoint for the Catchphrase Catcher (Notion).
// Writes one row per user submission: write-in / jewel-vote / flag.
// Votes upsert on (Source, Day) so a viewer's crown updates in place, never stacks.
//
// MEMBER ATTRIBUTION (A7, 2026-09-21): when the submitter is a logged-in member, the endpoint
// resolves their VERIFIED identity server-side (same resolveMember() the gallery + cal-event use —
// the domain-wide session cookie reaches this public page too) and stamps it, instead of trusting a
// client-typed name. For a verified member:
//   • `Suggested by`  = the member's real name (server-stamped, overrides any client value), so
//     "found by <member>" credit is trustworthy by construction.
//   • `Source`        = "m:<email>" (a member-scoped dedup key) so the jewel-vote upsert becomes
//     one crown per MEMBER per day across devices — a logged-out visitor can't stuff the ballot,
//     and switching devices doesn't stack crowns. (Anonymous submitters keep their session token.)
// This is ADDITIVE: anonymous play/submit still works today. The full member-ONLY lockdown (reject
// anonymous + hide the write-in/crown when logged out on the board) is a separate board pass.
//
// Required Cloudflare Pages env vars (Settings → Variables and Secrets):
//   Sumo_Fan_Intake — the sumo-fan-intake Notion integration secret (starts with "ntn_").
//                     Connected to Catchphrase Catcher (write) + Library (link) only.
//   CATCHER_DB      — the Catchphrase Catcher database id (default below), optional.
//   MEMBERS (KV)    — the member store, read by resolveMember() for identity (already bound).
//
// Fails soft: the game POSTs fire-and-forget, so a missing token just means
// no persistence yet — the game stays fully playable. Identity resolution is also fail-soft
// (a store hiccup just falls back to the anonymous path — a submission is never lost over it).

import { resolveMember } from "./members/_members.js";

const NOTION_VERSION = "2022-06-28";
const DEFAULT_DB = "0caf1338-72e8-4097-acfb-905af5b1d9f1";
const TYPES = ["write-in", "jewel-vote", "flag"];
const REASONS = ["promote-to-jewel", "dupe-of", "not-said", "mis-worded", "not-funny"];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function notion(token, path, method, body) {
  const res = await fetch("https://api.notion.com/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function onRequestPost({ request, env }) {
  const token = env.Sumo_Fan_Intake;
  const db = env.CATCHER_DB || DEFAULT_DB;
  if (!token) return json({ ok: false, error: "not-configured" }, 200);

  let p;
  try { p = await request.json(); } catch (e) { return json({ ok: false, error: "bad-json" }, 400); }

  // ---- validate ----
  const type = TYPES.includes(p.type) ? p.type : null;
  if (!type) return json({ ok: false, error: "bad-type" }, 400);
  const day = Number.isInteger(p.day) && p.day >= 1 && p.day <= 15 ? p.day : null;
  const text = (p.text || "").toString().slice(0, 300).trim();
  const reason = REASONS.includes(p.reason) ? p.reason : null;
  const pid = (p.pid || "").toString().slice(0, 60); // library phrase page id, when known
  const now = new Date().toISOString();

  // ---- resolve the submitter's VERIFIED identity (fail-soft) ----
  // A logged-in member → server-stamped name + a member-scoped dedup key. Anonymous → the client's
  // session token + optional client-typed name, exactly as before. Never throws into the write path.
  let member = null;
  try { member = await resolveMember(request, env); } catch (e) { member = null; }
  const verified = !!(member && member.email && member.status !== "blocked");

  // Source (dedup key): "m:<email>" for a verified member (one crown per member per day, any device);
  // otherwise the anonymous session token the client sent.
  const source = verified
    ? ("m:" + String(member.email).toLowerCase()).slice(0, 80)
    : (p.source || "").toString().slice(0, 80);

  // Suggested-by (attribution): the member's real name, server-side, overriding any client value;
  // otherwise whatever optional name an anonymous submitter chose to give.
  const suggestedBy = verified
    ? String(member.name || member.email).slice(0, 60)
    : (p.suggestedBy || "").toString().slice(0, 60);

  // ---- build properties ----
  const props = {
    "Submission": { title: [{ text: { content: text || (type === "jewel-vote" ? "(crown)" : "(submission)") } }] },
    "Type": { select: { name: type } },
    "Status": { select: { name: "new" } },
    "Submitted at": { date: { start: now } },
  };
  if (day !== null) props["Day"] = { number: day };
  if (source) props["Source"] = { rich_text: [{ text: { content: source } }] };
  if (reason) props["Reason"] = { select: { name: reason } };
  if (suggestedBy) props["Suggested by"] = { rich_text: [{ text: { content: suggestedBy } }] };
  if (pid) props["Related Phrase"] = { relation: [{ id: pid }] };

  try {
    // ---- votes: upsert on (Source, Day) — now member-scoped for a verified member ----
    if (type === "jewel-vote" && source && day !== null) {
      const q = await notion(token, `/databases/${db}/query`, "POST", {
        page_size: 1,
        filter: {
          and: [
            { property: "Source", rich_text: { equals: source } },
            { property: "Day", number: { equals: day } },
            { property: "Type", select: { equals: "jewel-vote" } },
          ],
        },
      });
      if (q.ok && q.data.results && q.data.results.length) {
        const pageId = q.data.results[0].id;
        await notion(token, `/pages/${pageId}`, "PATCH", { properties: props });
        return json({ ok: true, updated: true, verified });
      }
    }
    // ---- create ----
    const c = await notion(token, "/pages", "POST", { parent: { database_id: db }, properties: props });
    if (!c.ok) return json({ ok: false, error: "notion", detail: c.data && c.data.message }, 200);
    return json({ ok: true, created: true, verified });
  } catch (e) {
    return json({ ok: false, error: "exception" }, 200);
  }
}

// Optional: quick health check
export async function onRequestGet({ env }) {
  return json({ ok: true, configured: !!env.Sumo_Fan_Intake });
}
