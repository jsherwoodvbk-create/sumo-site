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

import { NAGOYA, AKI } from './_season.js';
// Gumbai's authored picks for a LIVE basho (the bot never POSTs to KV). Drop in per basho at grade
// time, ported from that basho's rollover workbook Gumbai column, then set it as `gumbai` below.
import KY26_GUMBAI from './_ky26-gumbai.js';

// Finalized bashos (golf frozen in _season.js). Grows at each roll.
export const BAKED = [NAGOYA, AKI];

// Live-gradeable targets, oldest→newest. At most ONE is current at a time — the basho the snapshot
// holds (or LEADERBOARD_LIVE forces). Kyushu = live KV via _picks-loader.
export const TARGETS = [
  { basho: 'Kyushu 2026', bashoId: '202611', bashoCode: 'Ky26', year: 2026, live: true, gumbai: KY26_GUMBAI },
];

// Which target does the current snapshot (or the manual flag) select? At most one.
// Forced flag wins first (exact bashoId); else the snapshot's own basho by id, else EXACT name.
export function currentTarget(snapshot, env) {
  const forced = String((env && env.LEADERBOARD_LIVE) || '');
  if (forced) { const f = TARGETS.find((t) => t.bashoId === forced); if (f) return f; }
  const snapId = String(snapshot?.meta?.bashoId ?? '');
  return TARGETS.find((t) => t.bashoId === snapId) || null;
}
