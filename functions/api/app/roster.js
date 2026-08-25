// functions/api/app/roster.js — current makuuchi roster to predict against (from the snapshot).
// Public data (the standings page shows the same); no gate. The pick screen fetches this.
import snapshot from '../_snapshot.js';

function order(rank) {
  const r = String(rank || '').toLowerCase().trim();
  if (r.startsWith('yoko') || r === 'y') return 1;
  if (r.startsWith('oze') || r === 'o') return 2;
  if (r.startsWith('seki') || r === 's') return 3;
  if (r.startsWith('komu') || r === 'k') return 4;
  const m = r.match(/(?:maegashira|m)\s*(\d+)/);
  if (m) return 4 + parseInt(m[1], 10);
  if (r.startsWith('juryo') || r === 'j') return 100;
  return 200;
}

export async function onRequestGet() {
  const roster = (snapshot.banzuke || [])
    .filter((b) => b && b.name)
    .map((b) => ({ name: b.name, rank: b.rank || '' }))
    .sort((a, b) => order(a.rank) - order(b.rank) || a.name.localeCompare(b.name));
  return new Response(JSON.stringify({ basho: snapshot.meta?.basho ?? null, roster }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
