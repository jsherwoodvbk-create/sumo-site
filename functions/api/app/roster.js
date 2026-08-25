// functions/api/app/roster.js — the roster to predict against, WITH each wrestler's record + KK/MK,
// tallied from the current-basho bouts in the snapshot (same origin as standings.html).
// Members only: it carries results, and predictions inherently reveal them; only the
// just-completed basho is ever shown here (you predict BETWEEN tournaments), so no live spoiler.
import snapshot from '../_snapshot.js';
import { getSession } from '../auth/_session.js';

function order(rank) {
  const r = String(rank || '').toLowerCase().trim();
  if (r.startsWith('yoko') || r === 'y') return 1;
  if (r.startsWith('oze') || r === 'o') return 2;
  if (r.startsWith('seki') || r === 's') return 3;
  if (r.startsWith('komu') || r === 'k') return 4;
  const m = r.match(/(?:maegashira|m)\s*(\d+)/);
  if (m) return 4 + parseInt(m[1], 10);
  if (r.startsWith('juryo') || r === 'j') return 23;
  return 200;
}

export async function onRequestGet(context) {
  const s = await getSession(context.request, context.env);
  if (!s) return json({ error: 'not-authed' }, 401);

  const wins = {}, losses = {};
  for (const b of (snapshot.bouts || [])) {
    if (b && b.winner) wins[b.winner] = (wins[b.winner] || 0) + 1;
    if (b && b.loser) losses[b.loser] = (losses[b.loser] || 0) + 1;
  }

  const roster = (snapshot.banzuke || [])
    .filter((b) => b && b.name)
    .map((b) => {
      const w = wins[b.name] || 0, l = losses[b.name] || 0;
      return {
        name: b.name,
        rank: b.rank || '',
        record: (w + l) ? (w + '–' + l) : '',
        kkmk: w >= 8 ? 'KK' : (l >= 8 ? 'MK' : ''),
      };
    })
    .sort((a, b) => order(a.rank) - order(b.rank) || a.name.localeCompare(b.name));

  return json({ basho: snapshot.meta?.basho ?? null, roster });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
