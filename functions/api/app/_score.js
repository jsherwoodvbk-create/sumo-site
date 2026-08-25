// functions/api/app/_score.js
// Scoring engine for the banzuke prediction game. Pure + dependency-free (runs in a Worker).
// Basho-agnostic: feed it a picks set (frozen Aki module OR live KV) + the actual banzuke.
//
// RULES (ported verbatim from the crew's sheet — "Start Here"):
//  • Rank → number: y=1 o=2 s=3 k=4  m1..m18 = 5..22  juryo = SMART  retired = special.
//  • Score per wrestler = |pick number − actual number|. Exact = 0. Lowest TOTAL wins (golf).
//  • Juryo graded SMART: the juryo bucket = one below the DEEPEST actual Maegashira that basho.
//  • Retirement: pick R & actual R = 0; wrong either way (ranked when R, or R when ranked) = 1.
//  • Bonus: −1 off FINAL per juryo→makuuchi pick that matches a real promotion (name AND rank).

// rank code -> number, given the smart juryo value for this basho.
export function rankValue(code, juryoValue) {
  const c = String(code || '').toLowerCase().trim();
  if (c === 'y') return 1;
  if (c === 'o') return 2;
  if (c === 's') return 3;
  if (c === 'k') return 4;
  const m = c.match(/^m(\d+)$/);
  if (m) return 4 + parseInt(m[1], 10);        // m1=5 ... m18=22
  if (c === 'j' || c === 'juryo') return juryoValue;
  if (c === 'r' || c === 'retired') return null; // handled specially, never distance-scored
  return null;                                    // unknown -> treated like absent/juryo upstream
}

// Map a banzuke rank STRING (snapshot uses words: "Yokozuna", "M1", "Juryo") -> a code.
export function codeFromRank(rank) {
  const r = String(rank || '').toLowerCase().trim();
  if (!r) return null;
  if (r.startsWith('yoko') || r === 'y') return 'y';
  if (r.startsWith('oze') || r === 'o') return 'o';
  if (r.startsWith('seki') || r === 's') return 's';
  if (r.startsWith('komu') || r === 'k') return 'k';
  const m = r.match(/^m(?:aegashira)?\s*(\d+)$/);
  if (m) return 'm' + m[1];
  if (r.startsWith('juryo') || r === 'j') return 'j';
  if (r.startsWith('ret') || r === 'r') return 'r';
  return null;
}

function isRetire(code) {
  const c = String(code || '').toLowerCase().trim();
  return c === 'r' || c === 'retired';
}

// Normalize a wrestler name for matching (lowercase, strip spaces/punct).
export function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

// Build the derived answer context from the raw actual-banzuke map {name: code}.
// predictedWrestlers = the roster everyone predicted (so we can spot NEW promotions for bonus).
export function buildAnswer(actualRanks, predictedWrestlers) {
  const entries = Object.entries(actualRanks || {});
  // smart juryo = deepest actual maegashira + 1 (default 23 if somehow no maegashira present)
  let deepestM = 0;
  for (const [, code] of entries) {
    const m = String(code).toLowerCase().match(/^m(\d+)$/);
    if (m) deepestM = Math.max(deepestM, 4 + parseInt(m[1], 10));
  }
  const juryoValue = deepestM ? deepestM + 1 : 23;

  // incoming = names on the actual banzuke that were NOT in the predicted roster (juryo→makuuchi)
  const predSet = new Set((predictedWrestlers || []).map(normName));
  const incoming = entries
    .filter(([name]) => !predSet.has(normName(name)))
    .map(([name, code]) => ({ name, code, norm: normName(name) }));

  return { actualRanks: actualRanks || {}, juryoValue, incoming };
}

// Score ONE player. Returns { base, bonusHits, final, detail[] }.
export function scorePlayer(player, answer) {
  const { actualRanks, juryoValue } = answer;
  let base = 0;
  const detail = [];

  for (const [wrestler, pickCode] of Object.entries(player.ranks || {})) {
    // actual: found on the new banzuke, else absent => juryo (smart). explicit 'r' => retired.
    const rawActual = actualRanks[wrestler];
    const actualCode = rawActual != null ? rawActual : 'j'; // absent from makuuchi = fell to juryo

    let pts;
    if (isRetire(pickCode) || isRetire(actualCode)) {
      pts = (isRetire(pickCode) && isRetire(actualCode)) ? 0 : 1;
    } else {
      const pv = rankValue(pickCode, juryoValue);
      const av = rankValue(actualCode, juryoValue);
      pts = (pv == null || av == null) ? 0 : Math.abs(pv - av);
    }
    base += pts;
    detail.push({ wrestler, pick: pickCode, actual: actualCode, pts });
  }

  // bonus: −1 per bonus pick matching an incoming promotion by name AND rank
  let bonusHits = 0;
  for (const bp of (player.bonus || [])) {
    const hit = answer.incoming.find(
      (i) => i.norm === normName(bp.name) && String(i.code).toLowerCase() === String(bp.rank).toLowerCase()
    );
    if (hit) bonusHits += 1;
  }

  const final = base - bonusHits;
  return { base, bonusHits, final, detail };
}

// Grade everyone. Returns standings sorted low->high (winner first), with ties sharing a place.
export function gradeBasho(picksData, actualRanks) {
  const answer = buildAnswer(actualRanks, picksData.wrestlers);
  const rows = (picksData.players || []).map((p) => {
    const s = scorePlayer(p, answer);
    return { key: p.key, name: p.name, base: s.base, bonusHits: s.bonusHits, final: s.final };
  });
  rows.sort((a, b) => a.final - b.final || a.name.localeCompare(b.name));
  // dense-rank places, ties share
  let place = 0, prev = null;
  rows.forEach((r, i) => {
    if (prev === null || r.final !== prev) { place = i + 1; prev = r.final; }
    r.place = place;
  });
  return { basho: picksData.basho, bashoId: picksData.bashoId, juryoValue: answer.juryoValue, standings: rows };
}
