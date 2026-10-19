// functions/api/app/_targets.js
// ONE source of truth for the banzuke-prediction lifecycle: which bashos are finalized history,
// which single basho is live right now (and where its picks come from), and how the snapshot/flag
// selects it. Shared by BOTH leaderboard.js and pred-history.js so the two public surfaces can
// never disagree about what is live. Adding a basho is a one-line edit here, nowhere else.
//
// ROLL ORDERING (kill-skill / season-bank beat): when the snapshot rolls to the NEXT basho, the one
// leaving must be BAKED first — add its final golf field to _season.js and list it in BAKED below,
// and drop it from TARGETS — or it falls off both surfaces (no longer live, not yet baked). Never
// flip LEADERBOARD_LIVE to the next basho while the snapshot still holds the current one.

import PICKS from './_aki-picks.js';
import { NAGOYA } from './_season.js';
// Gumbai's authored picks for a LIVE basho (the bot never POSTs to KV). Drop in per basho at grade
// time, ported from that basho's rollover workbook Gumbai column, then set it as `gumbai` below.
// import KY26_GUMBAI from './_ky26-gumbai.js';

// Finalized bashos (golf frozen in _season.js). Grows at each roll.
export const BAKED = [NAGOYA];

// Live-gradeable targets, oldest→newest. At most ONE is current at a time — the basho the snapshot
// holds (or LEADERBOARD_LIVE forces). Aki = frozen module; Kyushu+ = live KV via _picks-loader.
export const TARGETS = [
  { basho: 'Aki 2026',    bashoId: '202609', bashoCode: 'Aki',  year: 2026, frozen: PICKS },
  { basho: 'Kyushu 2026', bashoId: '202611', bashoCode: 'Ky26', year: 2026, live: true, gumbai: null /* KY26_GUMBAI */ },
];

// Which target does the current snapshot (or the manual flag) select? At most one.
// The forced flag wins first (exact bashoId); otherwise the snapshot's own basho (id, else name).
export function currentTarget(snapshot, env) {
  const forced = String((env && env.LEADERBOARD_LIVE) || '');
  if (forced) { const f = TARGETS.find((t) => t.bashoId === forced); if (f) return f; }
  const snapId = String(snapshot?.meta?.bashoId ?? '');
  const snapName = String(snapshot?.meta?.basho ?? '');
  return TARGETS.find((t) => {
    if (t.bashoId === snapId) return true;
    const word = t.basho.split(' ')[0];
    return word && new RegExp(word, 'i').test(snapName);
  }) || null;
}
