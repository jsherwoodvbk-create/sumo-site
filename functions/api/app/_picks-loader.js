// functions/api/app/_picks-loader.js
// Shared pick-source loader for the banzuke prediction grade. ONE loader, TWO consumers
// (leaderboard.js + pred-history.js) — assembles a picksData the _score.js engine grades directly.
// Pure logic + a KV read; no snapshot/grade knowledge (the caller supplies the answer key).
//
// SOURCES, per basho:
//  • FROZEN module — a completed basho whose picks are archived as code (e.g. Aki `_aki-picks.js`).
//    The caller passes it in; the loader returns it verbatim. Unchanged behavior for Aki.
//  • LIVE KV — the open / just-closed basho (e.g. Kyushu). Human picks the crew typed on the pick
//    screen, stored by prediction.js as  pred:{bashoCode}:{email} -> {email,name,basho,picks,savedAt}.
//    KV binding: PREDICTIONS. One doc per member. The app form (app/prediction.html) saves picks
//    NESTED as  { ranks:{Name:code}, bonus:[{name,rank}] }; this loader reads picks.ranks (the flat
//    map the engine grades) and picks.bonus (juryo->makuuchi guesses, -1 each on a name+rank hit).
//    A legacy flat { Name:code } doc is still tolerated (ranks = picks). Gumbai sits out the bonus.
//  • GUMBAI (the pace car) never POSTs through the member endpoint, so for a live basho its picks
//    come from an optional per-basho module handed in as `gumbaiPlayer` (same {key,name,ranks,bonus}
//    shape, authored from the rollover workbook's Gumbai column). Absent -> no pace car that basho;
//    the human crown is unaffected.
//
// Player KEY = the season ROSTER key (jennie/mj/sherry/james/gumbai) so Nagoya + Aki + Kyushu line up
// per person and participation + the pace car match. A live doc maps to a key by matching its display
// name against ROSTER (case-insensitive); an unknown name falls back to a slug so a new crew member
// still appears (just not pace-aware). Emails are NEVER hardcoded here — they live only in the
// CREW_ALLOWLIST env var, and the doc already carries the display name set from it.

import { ROSTER } from './_season.js';

// display name -> roster key (Jennie->jennie, MJ->mj, ...). Falls back to a slug of the name.
export function keyForName(name) {
  const n = String(name || '').trim();
  const hit = ROSTER.find((r) => r.name.toLowerCase() === n.toLowerCase());
  if (hit) return hit.key;
  const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
  return slug || 'anon';
}

// Read every live human pick doc for a basho CODE (e.g. "Ky26") from KV -> player rows.
async function livePlayers(env, bashoCode) {
  const kv = env && env.PREDICTIONS;
  if (!kv || !bashoCode) return [];
  const prefix = `pred:${bashoCode}:`;
  const players = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of (page.keys || [])) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      let doc;
      try { doc = JSON.parse(raw); } catch { continue; }
      // The member form saves picks NESTED: { ranks:{Name:code}, bonus:[{name,rank}] }. Pull the flat
      // rank map out of picks.ranks (the engine iterates player.ranks as {Name:code}) and the juryo
      // bonus out of picks.bonus. Tolerate a legacy flat { Name:code } doc (ranks = picks).
      const p = (doc && doc.picks) || {};
      const ranks = (p.ranks && typeof p.ranks === 'object') ? p.ranks : p;
      const bonus = Array.isArray(p.bonus) ? p.bonus : [];
      if (!ranks || !Object.keys(ranks).length) continue;   // skip empty / started-but-blank saves
      players.push({
        key: keyForName(doc.name),
        name: doc.name || keyForName(doc.name),
        ranks,
        bonus,
      });  
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return players;
}

// The predicted roster (every name anyone picked) — the engine uses it to spot juryo->makuuchi
// promotions for the bonus. Union of all players' pick names, first-seen order.
export function rosterWrestlers(players) {
  const seen = new Set();
  const out = [];
  for (const p of (players || [])) {
    for (const name of Object.keys(p.ranks || {})) {
      if (!seen.has(name)) { seen.add(name); out.push(name); }
    }
  }
  return out;
}

// Build a picksData for a LIVE basho from KV (+ optional authored Gumbai module).
//   meta:         { basho, bashoId, bashoCode }
//   gumbaiPlayer: optional { key:'gumbai', name:'Gumbai', ranks:{...}, bonus:[] }
export async function loadLivePicks(env, meta, gumbaiPlayer) {
  const humans = await livePlayers(env, meta.bashoCode);
  // one row per roster key (guard against a stray double-save); never let a KV row masquerade as the pace car
  const byKey = new Map();
  for (const p of humans) if (p.key !== 'gumbai') byKey.set(p.key, p);
  const players = [...byKey.values()];
  if (gumbaiPlayer && gumbaiPlayer.ranks && Object.keys(gumbaiPlayer.ranks).length) players.push(gumbaiPlayer);
  return {
    basho: meta.basho,
    bashoId: meta.bashoId,
    wrestlers: rosterWrestlers(players),
    players,
  };
}

// Pick the source for a target basho: a frozen module (archived basho) verbatim, else live KV.
//   opts: { frozen?: picksData, gumbaiPlayer?: {...} }
export async function loadPicks(env, meta, opts = {}) {
  if (opts.frozen) return opts.frozen;
  return loadLivePicks(env, meta, opts.gumbaiPlayer || null);
}
