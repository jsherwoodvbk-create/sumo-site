// functions/api/leaderboard.js — PUBLIC season leaderboard for the banzuke prediction game.
// No auth: this is the storefront scoreboard. Exposes standings + points, never raw picks.
//
// SEASON MODEL (see state/prediction-game-backlog.md → Season leaderboard):
//   • Golf score (from _score.js) ranks each basho's field.
//   • Season points = 3/2/1 to the top-3 HUMANS among themselves; Gumbai is the PACE CAR
//     (earns its own overall-finish medal, flagged AI, never crowned) — all in _season.js.
//   • Three views: This basho (golf shown) · This year · All-time (points only).
//
// SEASON STORE: finalized bashos are BAKED (golf frozen) in _targets.js; the one live basho the
// snapshot currently holds is graded on each request off `snapshot.banzuke`. Its picks come from
// the shared loader — a FROZEN module for an archived basho (Aki), or LIVE KV for the open one
// (Kyushu+). GO-LIVE lever unchanged: the snapshot rolls, or env LEADERBOARD_LIVE=<bashoId>.
// The lifecycle config (which basho is baked vs live, and where its picks come from) lives in
// _targets.js, shared with pred-history.js so the two surfaces never disagree.

import snapshot from './_snapshot.js';
import { gradeBasho, codeFromRank } from './app/_score.js';
import { gradeBashoSeason, seasonViews } from './app/_season.js';
import { loadPicks } from './app/_picks-loader.js';
import { BAKED, TARGETS, currentTarget } from './app/_targets.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Grade a picksData against the live snapshot banzuke → a season field [{key, golf}].
function fieldFromPicks(picksData) {
  const actualRanks = {};
  for (const b of (snapshot.banzuke || [])) {
    if (!b || !b.name) continue;
    const code = codeFromRank(b.rank);
    if (code) actualRanks[b.name] = code;
  }
  const graded = gradeBasho(picksData, actualRanks); // standings: [{key,name,base,bonusHits,final}]
  return graded.standings.map((s) => ({ key: s.key, golf: s.final }));
}

export async function onRequestGet(context) {
  const env = context.env || {};

  // Baked history first (Nagoya today; Aki joins here after the Kyushu roll).
  const completed = BAKED.map((b) => gradeBashoSeason(b, b.field));

  let pending = null;
  const target = currentTarget(snapshot, env);
  if (target) {
    const picksData = await loadPicks(env, target, { frozen: target.frozen || null, gumbaiPlayer: target.gumbai || null });
    completed.push(gradeBashoSeason({ basho: target.basho, bashoId: target.bashoId, year: target.year }, fieldFromPicks(picksData)));
  } else {
    const next = TARGETS[TARGETS.length - 1];
    pending = { basho: next.basho, message: next.basho + ' picks are locked — the leaderboard updates when the banzuke drops.' };
  }

  const views = seasonViews(completed);
  return json({ status: 'ok', views, pending, bashosPlayed: completed.length });
}
