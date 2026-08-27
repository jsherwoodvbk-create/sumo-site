// functions/api/leaderboard.js — PUBLIC season leaderboard for the banzuke prediction game.
// No auth: this is the storefront scoreboard. Exposes standings + points, never raw picks.
//
// SEASON MODEL (see state/prediction-game-backlog.md → Season leaderboard):
//   • Golf score (from _score.js) ranks each basho's field.
//   • Season points = 3/2/1 to the top-3 HUMANS among themselves; Gumbai is the PACE CAR
//     (earns its own overall-finish medal, flagged AI, never crowned) — all in _season.js.
//   • Three views: This basho (golf shown) · This year · All-time (points only).
//
// SEASON STORE: Nagoya '26 is baked in (_season.NAGOYA, the first banked result). Aki appends
// itself the moment it grades — same GO-LIVE lever as before (snapshot rolls to Aki, or env
// LEADERBOARD_LIVE=202609). Future bashos (Ky26+) will append the same way once wired to KV.

import snapshot from './_snapshot.js';
import PICKS from './app/_aki-picks.js';
import { gradeBasho, codeFromRank } from './app/_score.js';
import { NAGOYA, gradeBashoSeason, seasonViews } from './app/_season.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Is the Aki grade live yet? (snapshot reflects Aki, or the manual env switch is set)
function akiIsLive(env) {
  const target = String(PICKS.bashoId);
  const snapBashoId = String(snapshot?.meta?.bashoId ?? '');
  const snapBashoName = String(snapshot?.meta?.basho ?? '');
  const forced = String(env.LEADERBOARD_LIVE || '') === target;
  const rolled = snapBashoId === target ||
    (PICKS.basho && new RegExp(PICKS.basho.split(' ')[0], 'i').test(snapBashoName));
  return forced || rolled;
}

// Grade Aki from the snapshot and shape it as a season field [{key, golf}].
function akiField() {
  const actualRanks = {};
  for (const b of (snapshot.banzuke || [])) {
    if (!b || !b.name) continue;
    const code = codeFromRank(b.rank);
    if (code) actualRanks[b.name] = code;
  }
  const graded = gradeBasho(PICKS, actualRanks);   // standings: [{key,name,base,bonusHits,final}]
  return graded.standings.map((s) => ({ key: s.key, golf: s.final }));
}

export async function onRequestGet(context) {
  const env = context.env || {};

  // Season store: Nagoya baked, then Aki once it's live.
  const completed = [gradeBashoSeason(NAGOYA, NAGOYA.field)];
  let pending = null;
  if (akiIsLive(env)) {
    completed.push(gradeBashoSeason({ basho: PICKS.basho, bashoId: PICKS.bashoId, year: 2026 }, akiField()));
  } else {
    pending = { basho: PICKS.basho, message: PICKS.basho + ' picks are locked — the leaderboard updates when the banzuke drops.' };
  }

  const views = seasonViews(completed);
  return json({ status: 'ok', views, pending, bashosPlayed: completed.length });
}
