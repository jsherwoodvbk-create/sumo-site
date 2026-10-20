// functions/api/app/_fantasy-score.js
// Pure fantasy scoring engine — NO I/O (same split as the prediction grade: engine here,
// pick/field sources in the loader). Grades fantasy rosters against a completed basho's
// field and ranks the league.
//
// A player ROSTER:  { key, name, picks:{ <rung>: <WrestlerName> } }  — one wrestler per rank rung.
// The FIELD (answer key): array of
//   { name, rank, w, l, margin?, absent?, yusho?, sansho:[...] }
// margin defaults to w-l. sansho entries are English prize names, exactly as the data carries
// them: 'Outstanding Performance' (Shukun-sho), 'Technique' (Gino-sho), 'Fighting Spirit' (Kanto-sho).
//
// SCORING (decisions 2026-10-20, state/fantasy-league-decisions-2026-10-20.md):
//  • Roster margin = sum over picks of that wrestler's (W − L). A wrestler not in the field, or
//    one who sat the whole basho (0-0), contributes 0 — the kyujo "freeze" falls out for free
//    because only actual wins/losses are counted. A post-deadline withdrawal is a dead slot, not
//    a penalty (decision 1).
//  • Leaderboard points: flat 3·2·1 for the top three humans, 4th+ = 0 (decision 2; all games
//    carry the same points). Ties take the HIGHER slot and skip the next (standard competition
//    ranking): two tied for 1st → both 3 pts, the next human → 1 pt (the 2-pt slot is skipped).
//  • Tiebreaker cascade on a margin tie (decision 4 — count-based, NO cap, a rikishi can win
//    multiple prizes): yusho winners rostered → Outstanding Performance → Technique → Fighting
//    Spirit. Each tier compares how many of that tier's winners each tied player holds; more wins
//    ranks higher, equal falls through. Still tied after every tier → CO-CHAMPIONS: they share the
//    slot and its points.
//  • Gumbai (the pace car) is scored and ranked alongside everyone for display ("beat the bot"),
//    but is EXCLUDED FROM THE HUMAN CROWN: it never bumps a human out of a 3·2·1 slot — the human
//    points are ranked among humans only. Gumbai still earns PACE POINTS = the medal its OWN overall
//    finish takes in the full field (1st overall → 3, 2nd → 2, 3rd → 1, off-podium → 0), exactly
//    like the season leaderboard's pace car (_season.js, locked 2026-08-26): it earns what it actually
//    places, not an assumed win. `opts.paceCarKey` names it.

export function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

// Prize tiers in cascade order, after yusho. Keys are the English names the data uses.
export const SANSHO_TIERS = ['Outstanding Performance', 'Technique', 'Fighting Spirit'];

// Index the field by normalized name → a clean record with margin/flags resolved.
export function indexField(field) {
  const byName = new Map();
  for (const r of (field || [])) {
    const w = Number(r.w) || 0;
    const l = Number(r.l) || 0;
    byName.set(normName(r.name), {
      name: r.name,
      rank: r.rank,
      w,
      l,
      margin: (r.margin != null ? Number(r.margin) : w - l),
      absent: !!r.absent,
      yusho: !!r.yusho,
      sansho: Array.isArray(r.sansho) ? r.sansho.slice() : [],
    });
  }
  return byName;
}

// Score ONE roster against an indexed field. Margin + the tiebreaker tier counts + a per-rung detail.
export function scoreRoster(roster, byName) {
  const picks = (roster && roster.picks) || {};
  let margin = 0;
  const detail = [];
  const tiers = { yusho: 0, 'Outstanding Performance': 0, 'Technique': 0, 'Fighting Spirit': 0 };
  for (const [rung, wname] of Object.entries(picks)) {
    if (!wname) { detail.push({ rung, pick: null, found: false, w: 0, l: 0, margin: 0 }); continue; }
    const rec = byName.get(normName(wname));
    if (!rec) { detail.push({ rung, pick: wname, found: false, w: 0, l: 0, margin: 0 }); continue; }
    margin += rec.margin;
    if (rec.yusho) tiers.yusho += 1;
    for (const s of rec.sansho) if (s in tiers) tiers[s] += 1;
    detail.push({
      rung, pick: rec.name, found: true,
      w: rec.w, l: rec.l, margin: rec.margin,
      yusho: rec.yusho, sansho: rec.sansho,
    });
  }
  return { key: roster.key, name: roster.name, margin, tiers, detail };
}

// Cascade comparator: < 0 means `a` ranks ABOVE `b`; 0 means fully tied (co-champions).
export function cmpScore(a, b) {
  if (b.margin !== a.margin) return b.margin - a.margin;       // 1) margin
  if (b.tiers.yusho !== a.tiers.yusho) return b.tiers.yusho - a.tiers.yusho;  // 2) yusho
  for (const tier of SANSHO_TIERS) {                            // 3-5) Shukun → Gino → Kanto
    const av = a.tiers[tier] || 0, bv = b.tiers[tier] || 0;
    if (bv !== av) return bv - av;
  }
  return 0;                                                     // 6) co-champions
}

// Rank the whole league. Returns the sorted standings (humans + pace car), each row tagged with:
//   place        competition rank across EVERYONE (ties share a place)
//   humanPlace   competition rank among humans only (pace car omitted); null on the pace car
//   points       humans: 3·2·1 for humanPlace 1/2/3, else 0. Pace car: PACE POINTS from its OWN
//                overall `place` (1→3, 2→2, 3→1, else 0) — it earns its finish, never bumps a human.
//   isPaceCar    true on the pace car row
//   beatPaceCar  (humans only) did this human finish strictly above the pace car?
export function rankStandings(rosters, field, opts = {}) {
  const paceCarKey = opts.paceCarKey || null;
  const byName = indexField(field);
  const scored = (rosters || []).map((r) => scoreRoster(r, byName));
  scored.sort(cmpScore);

  // Overall placement across everyone (ties share a place, next place skips).
  let shown = 0, prev = null;
  for (const s of scored) {
    shown += 1;
    s.isPaceCar = (s.key === paceCarKey);
    s.place = (prev && cmpScore(prev, s) === 0) ? prev.place : shown;
    prev = s;
  }

  // Human-only ranking → 3·2·1 points (pace car excluded from the crown).
  // Default every row so the pace car reads points:0 / humanPlace:null, not undefined.
  for (const s of scored) { s.points = 0; s.humanPlace = null; }
  const PTS = { 1: 3, 2: 2, 3: 1 };
  const humans = scored.filter((s) => !s.isPaceCar);
  let hshown = 0, hprev = null;
  for (const s of humans) {
    hshown += 1;
    s.humanPlace = (hprev && cmpScore(hprev, s) === 0) ? hprev.humanPlace : hshown;
    s.points = PTS[s.humanPlace] || 0;
    hprev = s;
  }

  const paceCar = scored.find((s) => s.isPaceCar) || null;
  // Pace points: the medal the pace car's OWN overall finish earns (never bumps a human).
  if (paceCar) paceCar.points = PTS[paceCar.place] || 0;
  for (const s of humans) s.beatPaceCar = paceCar ? (cmpScore(s, paceCar) < 0) : null;

  return { standings: scored, humans, paceCar };
}

// Gumbai's informed-chalk roster for a field: at each rung, the nominal favorite = the first
// non-absent wrestler in banzuke order (decision 6 — never a known-withdrawn wrestler; the field
// is expected in banzuke order so "first" = nominal East/higher). This is the dry-run / fallback
// pace-car roster; a live basho may instead hand in a hand-authored Gumbai roster (same shape),
// which the engine scores exactly like any other.
export function gumbaiChalkRoster(field, opts = {}) {
  const byRung = new Map();
  for (const r of (field || [])) {
    if (!byRung.has(r.rank)) byRung.set(r.rank, []);
    byRung.get(r.rank).push(r);
  }
  const picks = {};
  for (const [rung, list] of byRung) {
    const pick =
      list.find((x) => !x.absent && !((Number(x.w) || 0) === 0 && (Number(x.l) || 0) === 0)) ||
      list.find((x) => !x.absent) ||
      list[0];
    if (pick) picks[rung] = pick.name;
  }
  return { key: opts.key || 'gumbai', name: opts.name || 'Gumbai', picks };
}

export default { rankStandings, scoreRoster, gumbaiChalkRoster, indexField, cmpScore, normName };
