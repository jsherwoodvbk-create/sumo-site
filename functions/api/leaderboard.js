// functions/api/leaderboard.js — PUBLIC storefront leaderboard for the banzuke prediction game.
// No auth: this is the teaser. It exposes standings (names + scores), NEVER raw picks.
//
// HOW IT GRADES: the answer key is the actual banzuke, read from the server snapshot
// (snapshot.banzuke). It grades ONLY once the snapshot reflects the target basho —
// i.e. once Jennie has entered the new banzuke on the Notion Banzuke table and
// regenerated + published the snapshot ("that will be the grade sheet"). Until then it
// returns a LOCKED teaser: "the crew's picks are in, awaiting the banzuke."
//
// TARGET basho = the picks set's own bashoId (Aki = 202609). Two ways it goes live:
//   1) auto — snapshot.meta.bashoId matches the target (or meta.basho names it), OR
//   2) manual switch — env LEADERBOARD_LIVE set to the target bashoId (a hard "go live"
//      lever Jennie controls in Cloudflare the moment she knows the snapshot is Aki).
//
// FOR NOVEMBER (Kyushu): swap the picks source from the frozen Aki module to live KV
// (pred:{basho}:*) and bump the target bashoId — see the PICKS_SOURCE note below.

import snapshot from './_snapshot.js';
import PICKS from './app/_aki-picks.js';           // frozen Aki picks (the demo set)
import { gradeBasho, codeFromRank } from './app/_score.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet(context) {
  const env = context.env || {};
  const snapBashoId = String(snapshot?.meta?.bashoId ?? '');
  const snapBashoName = String(snapshot?.meta?.basho ?? '');
  const target = String(PICKS.bashoId);              // '202609' for Aki

  // Is the snapshot the grade sheet for THIS basho yet?
  const forced = String(env.LEADERBOARD_LIVE || '') === target;
  const autoRolled =
    snapBashoId === target ||
    (PICKS.basho && new RegExp(PICKS.basho.split(' ')[0], 'i').test(snapBashoName));
  const live = forced || autoRolled;

  // roster of who's playing (names + pick counts only — no picks leaked pre-grade)
  const players = (PICKS.players || []).map((p) => ({
    name: p.name,
    picks: Object.keys(p.ranks || {}).length,
    bonus: (p.bonus || []).length,
  }));

  if (!live) {
    return json({
      status: 'locked',
      basho: PICKS.basho,
      message: 'Picks are locked. Standings go live when the ' + PICKS.basho + ' banzuke drops.',
      players,
      _debug: { snapshotBashoId: snapBashoId, targetBashoId: target },
    });
  }

  // Build the answer key from the snapshot banzuke: { wrestlerName: code }
  const actualRanks = {};
  for (const b of (snapshot.banzuke || [])) {
    if (!b || !b.name) continue;
    const code = codeFromRank(b.rank);
    if (code) actualRanks[b.name] = code;
  }

  const graded = gradeBasho(PICKS, actualRanks);
  return json({
    status: 'graded',
    basho: graded.basho,
    juryoValue: graded.juryoValue,
    standings: graded.standings,     // [{place,name,base,bonusHits,final}]
    players,
    _debug: { snapshotBashoId: snapBashoId, targetBashoId: target, source: forced ? 'forced' : 'auto' },
  });
}
