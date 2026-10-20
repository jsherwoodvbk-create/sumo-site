// functions/api/app/fantasy-scores.js — the scored fantasy leaderboard (data endpoint).
// Members only (self-gated: /app middleware does NOT cover /api/*, so this checks the session
// itself, same as prediction.js / fantasy.js). GETs the current fantasy basho's standings:
// loads every crew roster from KV, adds Gumbai the pace car, grades against the completed field,
// and returns the ranked league for the brick-4 leaderboard UI.
//
// Bindings/env: reuses the KV namespace `PREDICTIONS` (fantasy rosters are namespaced
//   `fantasy:{basho}:{league}:{email}`). Current fantasy basho in env `FANTASY_BASHO`.
//
// FIELD SOURCE (the answer key):
//   • DRY RUN (basho code contains "dry") → the frozen Aki module `_fantasy-aki.js`, so the whole
//     flow scores end to end before Kyushu.
//   • LIVE (a real basho) → built from the completed results at basho-end (brick 5, wired at the
//     Kyushu drop/kill, same completed-results source the prediction leaderboard grades against).
//     Until that seam is wired a live basho returns scored:false (no results yet) rather than a
//     half-graded board. Margins are final-basho data, so a live board only exists post-senshuraku;
//     the spoiler-gated per-member report is brick 4's job — this endpoint serves the data.
import { getSession } from '../auth/_session.js';
import { keyForName } from './_picks-loader.js';
import { rankStandings, gumbaiChalkRoster } from './_fantasy-score.js';
import { AKI_FIELD } from './_fantasy-aki.js';
import { LEAGUES, PACE_CARS } from './_leagues.js';

const LEAGUE = 'crew'; // crew scale: one league. Generalize to the member's league(s) with public leagues.

// Every human fantasy roster for a basho, from KV → [{ key, name, picks:{rung:Name} }].
async function loadRosters(env, basho, leagueId) {
  const kv = env && env.PREDICTIONS;
  if (!kv || !basho) return [];
  const prefix = `fantasy:${basho}:${leagueId}:`;
  const rows = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of (page.keys || [])) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      let doc;
      try { doc = JSON.parse(raw); } catch { continue; }
      const picks = (doc && doc.picks) || {};
      if (!picks || !Object.keys(picks).length) continue; // skip empty / started-but-blank saves
      rows.push({ key: keyForName(doc.name), name: doc.name || keyForName(doc.name), picks });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  // one row per roster key (guard a stray double-save); never let a KV row masquerade as the pace car
  const byKey = new Map();
  for (const p of rows) if (p.key !== 'gumbai') byKey.set(p.key, p);
  return [...byKey.values()];
}

// The completed-basho field to score against. Dry run → frozen Aki; live → wired at the drop.
function loadField(basho) {
  if (/dry/i.test(String(basho))) return AKI_FIELD;
  return null; // LIVE field assembled here at the Kyushu drop (brick 5).
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const s = await getSession(request, env);
  if (!s) return json({ error: 'not-authed' }, 401);

  const basho = env.FANTASY_BASHO || '';
  const league = LEAGUES[LEAGUE] || null;
  const leagueName = (league && league.name) || 'The Crew';
  const paceCarKey = (league && league.paceCar) || 'gumbai';

  const field = loadField(basho);
  if (!field) {
    return json({ basho, league: LEAGUE, leagueName, scored: false, standings: [], note: 'Results are not in yet.' });
  }

  const humans = await loadRosters(env, basho, LEAGUE);
  // Pace-car roster: dry run → informed chalk over the field. (Live: a hand-authored Gumbai roster
  // module can be passed to rankStandings instead; the engine scores it identically.)
  const paceName = (PACE_CARS[paceCarKey] && PACE_CARS[paceCarKey].name) || 'Gumbai';
  const paceRoster = gumbaiChalkRoster(field, { key: paceCarKey, name: paceName });

  const { standings } = rankStandings([...humans, paceRoster], field, { paceCarKey });

  return json({
    basho,
    league: LEAGUE,
    leagueName,
    scored: true,
    paceCarKey,
    standings: standings.map((r) => ({
      key: r.key,
      name: r.name,
      margin: r.margin,
      place: r.place,
      humanPlace: r.humanPlace != null ? r.humanPlace : null,
      points: r.points || 0,
      isPaceCar: r.isPaceCar,
      beatPaceCar: r.beatPaceCar != null ? r.beatPaceCar : null,
      tiers: r.tiers,
      detail: r.detail,
    })),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
