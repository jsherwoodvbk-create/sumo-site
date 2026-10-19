// functions/api/pred-history.js — PUBLIC per-crew-member banzuke-prediction history.
//
// The THIRD prediction surface (see state/prediction-game-backlog.md):
//   • /leaderboard  = cross-member standings (who's winning, by basho/year/all-time).
//   • "The Report"  = forward-looking working XLS (pick-building).
//   • THIS          = each member's OWN track record over time — golf, placement, season
//                     points per basho, the trend, accuracy by rank tier, best/worst calls.
//
// Pivots the SAME graded season history the leaderboard aggregates (Nagoya baked + the live target),
// sliced per member. Completed/graded bashos only — banzuke-vs-banzuke is public ranks (no bout
// results), and post-grade every pick is already shown on the scored prediction board, so there is
// NO watched-day spoiler gate (same as the leaderboard).
//
// Reuses the proven engines unchanged — only a new VIEW, no new scoring:
//   _score.js       → per-wrestler detail[] (accuracy tiers + best/worst calls)
//   _season.js      → ROSTER, pace-car placementPoints, the baked Nagoya row
//   _picks-loader.js → the live target's picks (frozen module for Aki, live KV for Kyushu+)
//   _targets.js     → the shared lifecycle config (same baked/live selection as the leaderboard)

import snapshot from './_snapshot.js';
import { buildAnswer, scorePlayer, codeFromRank } from './app/_score.js';
import { ROSTER, PACE_KEY, placementPoints } from './app/_season.js';
import { loadPicks } from './app/_picks-loader.js';
import { BAKED, currentTarget } from './app/_targets.js';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// actual-banzuke map {name: code} from the snapshot (the answer key).
function actualRanksFromSnapshot() {
  const out = {};
  for (const b of (snapshot.banzuke || [])) {
    if (!b || !b.name) continue;
    const code = codeFromRank(b.rank);
    if (code) out[b.name] = code;
  }
  return out;
}

// Which tier an ACTUAL landing code falls in — the buckets a member studies their accuracy by.
function tierOf(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'y' || c === 'o' || c === 's' || c === 'k') return 'sanyaku';
  if (/^m\d+$/.test(c)) return 'maegashira';
  if (c === 'j' || c === 'juryo') return 'juryo';
  if (c === 'r' || c === 'retired') return 'retired';
  return 'juryo'; // absent-from-makuuchi grades as (smart) juryo
}
const TIER_LABEL = { sanyaku: "San'yaku", maegashira: 'Maegashira', juryo: 'Juryo / out', retired: 'Retirements' };

// Grade a picksData against the snapshot → { field:[{key,golf}], byKey:{key:{detail,bonusHits,bonusAttempted}} }.
function detailFor(picksData) {
  const actual = actualRanksFromSnapshot();
  const answer = buildAnswer(actual, picksData.wrestlers);
  const byKey = {};
  const field = [];
  for (const p of (picksData.players || [])) {
    const s = scorePlayer(p, answer);
    field.push({ key: p.key, golf: s.final });
    byKey[p.key] = { detail: s.detail, bonusHits: s.bonusHits, bonusAttempted: (p.bonus || []).length };
  }
  return { field, byKey };
}

// Summarize one player's detail[] into accuracy tiers + best/worst calls.
function summarizeDetail(d) {
  if (!d) return null;
  const tiers = {};
  for (const row of d.detail) {
    const t = tierOf(row.actual);
    (tiers[t] = tiers[t] || { n: 0, sum: 0 }).n++;
    tiers[t].sum += (typeof row.pts === 'number' ? row.pts : 0);
  }
  const accuracy = {};
  for (const t of Object.keys(tiers)) {
    accuracy[t] = { label: TIER_LABEL[t] || t, n: tiers[t].n, avg: +(tiers[t].sum / tiers[t].n).toFixed(2) };
  }
  const exact = d.detail.filter((r) => r.pts === 0 && r.actual !== 'r');
  const nailed = exact.length;
  const best = exact
    .slice()
    .sort((a, b) => rankNum(b.actual) - rankNum(a.actual))
    .slice(0, 3)
    .map((r) => ({ wrestler: r.wrestler, landed: r.actual }));
  const worst = d.detail
    .slice()
    .sort((a, b) => (b.pts || 0) - (a.pts || 0))
    .slice(0, 3)
    .map((r) => ({ wrestler: r.wrestler, pick: r.pick, actual: r.actual, off: r.pts }));
  return { accuracy, nailed, best, worst, bonus: { hits: d.bonusHits, attempted: d.bonusAttempted } };
}
function rankNum(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'y') return 1; if (c === 'o') return 2; if (c === 's') return 3; if (c === 'k') return 4;
  const m = c.match(/^m(\d+)$/); if (m) return 4 + (+m[1]); return 23;
}

export async function onRequestGet(context) {
  const env = context.env || {};

  // Assemble completed bashos in chronological order. Each: {meta, standings, detailByKey|null}.
  const completed = [];
  // Baked history — golf totals only (no per-pick detail), e.g. Nagoya.
  for (const b of BAKED) {
    completed.push({
      meta: { basho: b.basho, bashoId: String(b.bashoId), year: b.year },
      standings: placementPoints(b.field),
      detailByKey: null,
    });
  }
  // The one live target, graded with full per-pick detail (frozen module for Aki, live KV for Kyushu+).
  const target = currentTarget(snapshot, env);
  if (target) {
    const picksData = await loadPicks(env, target, { frozen: target.frozen || null, gumbaiPlayer: target.gumbai || null });
    const { field, byKey } = detailFor(picksData);
    completed.push({
      meta: { basho: target.basho, bashoId: String(target.bashoId), year: target.year },
      standings: placementPoints(field),
      detailByKey: byKey,
    });
  }

  const bashos = completed.map((c) => c.meta);

  // Pivot to one row per member.
  const history = {};
  for (const member of ROSTER) {
    const perBasho = [];
    for (const c of completed) {
      const row = c.standings.find((s) => s.key === member.key);
      if (!row) { perBasho.push({ ...c.meta, played: false, points: 0 }); continue; }
      const det = c.detailByKey ? summarizeDetail(c.detailByKey[member.key]) : null;
      perBasho.push({
        ...c.meta, played: true,
        golf: row.golf, place: row.place, points: row.points, pace: !!row.pace,
        hasDetail: !!det, ...(det ? { summary: det } : {}),
      });
    }
    const played = perBasho.filter((b) => b.played);
    const golfs = played.map((b) => b.golf).filter((g) => typeof g === 'number');
    history[member.key] = {
      name: member.name, pace: !!member.pace,
      perBasho,
      totals: {
        seasonPoints: played.reduce((a, b) => a + (b.points || 0), 0),
        bashosPlayed: played.length,
        bestGolf: golfs.length ? Math.min(...golfs) : null,
        avgGolf: golfs.length ? +(golfs.reduce((a, b) => a + b, 0) / golfs.length).toFixed(1) : null,
      },
    };
  }

  return json({
    status: 'ok',
    members: ROSTER.map((r) => ({ key: r.key, name: r.name, pace: !!r.pace })),
    paceKey: PACE_KEY,
    bashos,
    history,
  });
}
