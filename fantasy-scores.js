// functions/api/app/fantasy-scores.js — the scored fantasy leaderboard (data endpoint).
// Members only (self-gated). GETs the current fantasy basho's standings: loads every crew roster
// from KV, adds Gumbai the pace car, grades against the field, returns the ranked league + per-day
// detail so the scorecard can gate the running margin to the viewer's watched day.
//
// Bindings/env: KV namespace `PREDICTIONS` (rosters `fantasy:{basho}:{league}:{email}`); current
//   fantasy basho in env `FANTASY_BASHO`.
//
// FIELD SOURCE (the answer key):
//   • DRY RUN (basho code contains "dry") → the frozen Aki module `_fantasy-aki.js` (final only).
//   • LIVE (a real basho) → built from the committed snapshot: tally `snapshot.bouts` winner/loser
//     against `snapshot.banzuke` (the SAME source roster.js reads), stamped per day so the margin is
//     computable through the viewer's gated day. (brick 5, 2026-11-03.)
//
// LOCK GATE (no peeking): a LIVE basho exposes rosters ONLY once the draft is locked — the deadline
//   in /fantasy-current.json has passed, or its phase is "locked". Before lock → scored:false and NO
//   roster load (nothing to leak). Fail-closed: if the config can't be read, treat as NOT locked.
//   (Gumbai's own sight is gated separately + structurally — the Day-1 skill bakes the frozen rosters
//   into the snapshot at lock; this endpoint is the crew-facing board.)
import snapshot from '../_snapshot.js';
import { getSession } from '../auth/_session.js';
import { keyForName } from './_picks-loader.js';
import { rankStandings, gumbaiChalkRoster, normName } from './_fantasy-score.js';
import { AKI_FIELD } from './_fantasy-aki.js';
import { LEAGUES, PACE_CARS } from './_leagues.js';

const LEAGUE = 'crew';

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
      if (!picks || !Object.keys(picks).length) continue;
      rows.push({ key: keyForName(doc.name), name: doc.name || keyForName(doc.name), picks });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const byKey = new Map();
  for (const p of rows) if (p.key !== 'gumbai') byKey.set(p.key, p);
  return [...byKey.values()];
}

// LIVE field from the snapshot (brick 5): per-wrestler W-L + per-day results + yusho/sansho.
function buildLiveField(snap) {
  const meta = (snap && snap.meta) || {};
  const maxDay = Number(meta.maxDay) || 0;
  const banzuke = (snap && snap.banzuke) || [];
  const bouts = (snap && snap.bouts) || [];
  const byName = new Map();
  for (const b of banzuke) {
    if (!b || !b.name) continue;
    byName.set(normName(b.name), { name: b.name, rank: b.rank || '', w: 0, l: 0, days: Array(maxDay).fill(''), absent: false, yusho: false, sansho: [] });
  }
  for (const bo of bouts) {
    if (!bo) continue;
    const d = Number(bo.day) || 0;
    const wk = normName(bo.winner), lk = normName(bo.loser);
    if (bo.winner && byName.has(wk)) { const r = byName.get(wk); r.w++; if (d >= 1 && d <= maxDay) r.days[d - 1] = 'w'; }
    if (bo.loser && byName.has(lk)) { const r = byName.get(lk); r.l++; if (d >= 1 && d <= maxDay) r.days[d - 1] = 'l'; }
  }
  const champRaw = snap && snap.champion;
  const champ = champRaw && (champRaw.name || (typeof champRaw === 'string' ? champRaw : null));
  const sanshoByName = new Map();
  for (const b of banzuke) if (b && b.name && Array.isArray(b.sansho) && b.sansho.length) sanshoByName.set(normName(b.name), b.sansho.slice());
  const field = [];
  for (const b of banzuke) {
    if (!b || !b.name) continue;
    const r = byName.get(normName(b.name));
    if (champ && normName(b.name) === normName(champ)) r.yusho = true;
    if (sanshoByName.has(normName(b.name))) r.sansho = sanshoByName.get(normName(b.name));
    r.absent = (r.w + r.l) === 0 && maxDay > 0;
    r.margin = r.w - r.l;
    field.push(r);
  }
  return field;
}

// Read /fantasy-current.json (the same config the page reads) for the lock state. Fail-closed.
async function readCfg(request) {
  try {
    const res = await fetch(new URL('/fantasy-current.json', request.url), { cf: { cacheTtl: 0 } });
    if (!res.ok) return null;
    const j = await res.json();
    return (j && j.cfg) ? j.cfg : j;
  } catch { return null; }
}
function isLocked(cfg, nowMs) {
  if (!cfg) return false;                                   // fail-closed: unknown → not locked → no exposure
  if (String(cfg.phase || '').toLowerCase() === 'locked') return true;
  if (cfg.lockAt) { const t = Date.parse(cfg.lockAt); if (!isNaN(t) && nowMs >= t) return true; }
  return false;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const s = await getSession(request, env);
  if (!s) return json({ error: 'not-authed' }, 401);

  const basho = env.FANTASY_BASHO || '';
  const league = LEAGUES[LEAGUE] || null;
  const leagueName = (league && league.name) || 'The Crew';
  const paceCarKey = (league && league.paceCar) || 'gumbai';
  const dry = /dry/i.test(String(basho));

  // DRY RUN: frozen Aki, ungated (test scaffolding). LIVE: gate roster exposure on the lock.
  let field, maxDay, locked = true;
  if (dry) {
    field = AKI_FIELD;
    maxDay = 15;
  } else {
    locked = isLocked(await readCfg(request), Date.now());
    if (!locked) {
      return json({ basho, league: LEAGUE, leagueName, scored: false, locked: false, standings: [], note: 'The draft is still open. The scorecard opens when picks lock.' });
    }
    field = buildLiveField(snapshot);
    maxDay = Number(snapshot?.meta?.maxDay) || 0;
  }

  const humans = await loadRosters(env, basho, LEAGUE);
  const paceName = (PACE_CARS[paceCarKey] && PACE_CARS[paceCarKey].name) || 'Gumbai';
  const paceRoster = gumbaiChalkRoster(field, { key: paceCarKey, name: paceName });
  const { standings } = rankStandings([...humans, paceRoster], field, { paceCarKey });

  return json({
    basho,
    league: LEAGUE,
    leagueName,
    scored: true,
    locked,
    maxDay,                                   // tournament progress; the scorecard gates margins to the viewer's day ≤ maxDay
    paceCarKey,
    standings: standings.map((r) => ({
      key: r.key,
      name: r.name,
      margin: r.margin,                        // final/through-maxDay; the client recomputes through the watched day from detail[].days
      place: r.place,
      humanPlace: r.humanPlace != null ? r.humanPlace : null,
      points: r.points || 0,
      isPaceCar: r.isPaceCar,
      beatPaceCar: r.beatPaceCar != null ? r.beatPaceCar : null,
      tiers: r.tiers,
      detail: r.detail,                        // per rung: pick, rank, w, l, margin, days[] (for the daily gate), yusho, sansho
    })),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
