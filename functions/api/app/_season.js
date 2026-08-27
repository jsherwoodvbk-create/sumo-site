// functions/api/app/_season.js — season leaderboard: pace-car scoring + 3-view aggregation.
// Pure + dependency-free (Worker-safe).
//
// MODEL (locked 2026-08-26):
//  • Within a basho, golf score (from _score.js) ranks the field — lowest wins.
//  • Season points = 3 / 2 / 1 to the top-three HUMANS, ranked AMONG THEMSELVES.
//  • Gumbai is the PACE CAR: excluded from human placement (never bumps a human),
//    and earns the medal its OWN overall finish takes (1st in field→3, 2nd→2, 3rd→1,
//    off-podium→0). It earns what it actually places — not an assumed win. Flag it AI;
//    never crowned. Its number can coincide with a human's — it's a benchmark overlay.

export const PACE_KEY = 'gumbai';

// Crew roster (humans + the pace car). Names for display.
export const ROSTER = [
  { key: 'jennie', name: 'Jennie' },
  { key: 'mj',     name: 'MJ' },
  { key: 'sherry', name: 'Sherry' },
  { key: 'james',  name: 'James' },
  { key: 'gumbai', name: 'Gumbai', pace: true },
];

// One completed basho, baked in: Nagoya 2026. Golf totals authoritative (from the sheet).
// James did not play Nagoya, so he's absent from the field (→ 0 season pts that basho).
export const NAGOYA = {
  basho: 'Nagoya 2026', bashoId: '202607', year: 2026,
  field: [
    { key: 'gumbai', golf: 24 },
    { key: 'sherry', golf: 25 },
    { key: 'jennie', golf: 27 },
    { key: 'mj',     golf: 51 },
  ],
};

function nameOf(key) { const r = ROSTER.find((r) => r.key === key); return r ? r.name : key; }
export function isPace(key) { return key === PACE_KEY; }

// field: [{key, golf}] → [{key,name,golf,pace,place,points}].
//   place = human placement (1-based) or null for the pace car.
//   points = 3/2/1 for humans (top-3 among themselves); pace car earns its overall-finish medal.
export function placementPoints(field) {
  const PTS = { 1: 3, 2: 2, 3: 1 };
  // human placement: standard competition ranking by golf asc (ties share, next skips)
  const humans = field.filter((f) => !isPace(f.key)).slice().sort((a, b) => a.golf - b.golf);
  const placeByKey = {};
  let place = 0, seen = 0, prev = null;
  for (const h of humans) { seen++; if (prev === null || h.golf !== prev) { place = seen; prev = h.golf; } placeByKey[h.key] = place; }
  return field.map((f) => {
    if (isPace(f.key)) {
      const ahead = field.filter((x) => x.golf < f.golf).length; // players strictly better
      return { key: f.key, name: nameOf(f.key), golf: f.golf, pace: true, place: null, points: Math.max(0, 3 - ahead) };
    }
    const p = placeByKey[f.key];
    return { key: f.key, name: nameOf(f.key), golf: f.golf, pace: false, place: p, points: PTS[p] || 0 };
  });
}

// Turn a raw field into a completed-basho result.
export function gradeBashoSeason(meta, field) {
  return { basho: meta.basho, bashoId: meta.bashoId, year: meta.year, standings: placementPoints(field) };
}

// Sum points across a list of completed bashos → full-roster rows (unplayed = 0), sorted.
function aggregate(completed) {
  const totals = {};
  for (const b of completed) {
    for (const s of b.standings) {
      if (!totals[s.key]) totals[s.key] = { points: 0, bashos: 0 };
      totals[s.key].points += s.points;
      totals[s.key].bashos += 1;
    }
  }
  const rows = ROSTER.map((r) => ({
    key: r.key, name: r.name, pace: !!r.pace,
    points: totals[r.key] ? totals[r.key].points : 0,
    bashos: totals[r.key] ? totals[r.key].bashos : 0,
  }));
  rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  return rows;
}

// The three views from the season store (completed bashos, chronological order).
export function seasonViews(completed) {
  const latest = completed.length ? completed[completed.length - 1] : null;
  const currentYear = latest ? latest.year : null; // "current season" = latest banked basho's year
  const thisBasho = latest ? {
    basho: latest.basho, bashoId: latest.bashoId, year: latest.year,
    rows: latest.standings.slice().sort((a, b) => a.golf - b.golf), // by golf (the actual result)
  } : null;
  const yearList = completed.filter((b) => b.year === currentYear);
  return {
    thisBasho,
    thisYear: { year: currentYear, rows: aggregate(yearList) },
    allTime:  { rows: aggregate(completed) },
  };
}
