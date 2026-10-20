// functions/api/app/_leagues.js
// Crew-scale static league registry (same philosophy as CREW_ALLOWLIST).
// Generalizes to a KV/D1 store of user-created leagues when public sign-up lands.
// Picks live in KV:  fantasy:{bashoCode}:{leagueId}:{email}
//   -> { email, name, league, basho, picks:{ <rung>: <WrestlerName> }, savedAt }

export const PACE_CARS = { gumbai: { key: 'gumbai', name: 'Gumbai', flag: 'AI' } };

export const LEAGUES = {
  crew: {
    id: 'crew',
    name: 'The Crew',
    members: ['jennie', 'mj', 'sherry', 'james'], // season ROSTER keys (member store maps to email+name)
    admins:  ['jennie', 'james'],                 // >=2 admins; add/remove members  ⟨confirm James as #2⟩
    paceCar: 'gumbai',                            // informed chalk, not eligible for the crown
    createdAt: '2026-10-20',
  },
};

export const pickKey = (bashoCode, leagueId, email) =>
  `fantasy:${bashoCode}:${leagueId}:${String(email).toLowerCase()}`;

export function leaguesForKey(key) {
  return Object.values(LEAGUES).filter(L => L.members.includes(key)).map(L => L.id);
}

export const isAdmin = (leagueId, key) =>
  !!LEAGUES[leagueId] && LEAGUES[leagueId].admins.includes(key);

export default LEAGUES;
