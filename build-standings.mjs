// Rebuild standings.html from Notion, in place. Runs in GitHub Actions.
// Reads NOTION_TOKEN (a read-only Notion integration secret) from the environment.
// Spoiler-safe: logs only counts, never winners or records.
import fs from 'node:fs';

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error("NOTION_TOKEN missing"); process.exit(1); }

const H = {
  "Authorization": `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

// ---- active basho config ----
const TOURNAMENT_ID = "3351ade1241f80fbb4efd2bef497b295"; // Nagoya 2026 tournament page
const DB = {
  banzuke:  "8e3457a9274742759b917ac03fe18290",
  matchlog: "1a2bad82ebf5447287eacb2c2481f9f1",
  master:   "ca79ecbb4c5645ebb3533dd33031c7d9",
};
const TOTAL_DAYS = 15;

async function queryAll(dbId, body = {}) {
  const out = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!res.ok) throw new Error(`Notion query ${dbId} -> ${res.status}: ${await res.text()}`);
    const j = await res.json();
    out.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return out;
}

const titleOf = (p) => (p?.title?.map(t => t.plain_text).join("") || "").trim();
const numOf   = (p) => (p?.number ?? null);
const selOf   = (p) => (p?.select?.name ?? null);
const ftin    = (cm) => { const i = Math.round(cm / 2.54); return `${Math.floor(i / 12)}'${i % 12}"`; };
const lbs     = (kg) => Math.round(kg * 2.20462);

async function main() {
  const relFilter = { property: "Tournament", relation: { contains: TOURNAMENT_ID } };

  const [banz, matches, master] = await Promise.all([
    queryAll(DB.banzuke,  { filter: relFilter }),
    queryAll(DB.matchlog, { filter: relFilter }),
    queryAll(DB.master),
  ]);

  const heightByName = {};
  for (const p of master) {
    const name = titleOf(p.properties["Ring Name"]);
    const cm = numOf(p.properties["Height (cm)"]);
    if (name && cm) heightByName[name] = cm;
  }

  // makuuchi roster (exclude Juryo visitors: rank "J")
  const roster = [];
  for (const p of banz) {
    const name = titleOf(p.properties["Entry"]).split("—")[0].trim(); // "Name — Nagoya 2026"
    const rank = selOf(p.properties["Rank"]);
    const wkg  = numOf(p.properties["Weight (kg)"]);
    if (!name || !rank || rank === "J") continue;
    roster.push({ name, rank, wkg });
  }

  // per-wrestler day results; MAX_DAY derived from the data (auto-advances)
  const names = new Set(roster.map(r => r.name));
  const days = {};
  for (const n of names) days[n] = Array(TOTAL_DAYS).fill("");
  let maxDay = 0;
  for (const p of matches) {
    const m = titleOf(p.properties["Match"]).match(/^(.*?) vs (.*?) · Day (\d+)/);
    if (!m) continue;
    const winner = m[1].trim(), loser = m[2].trim(), day = parseInt(m[3], 10);
    if (day > maxDay) maxDay = day;
    if (names.has(winner)) days[winner][day - 1] = "w";
    if (names.has(loser))  days[loser][day - 1]  = "l";
  }

  const rcOf = (rank) => ({ Yokozuna: "yok", Ozeki: "ozeki", Sekiwake: "seki", Komusubi: "komu" }[rank] || "maeg");
  const rankOrder = ["Yokozuna","Ozeki","Sekiwake","Komusubi","M1","M2","M3","M4","M5","M6","M7","M8","M9","M10","M11","M12","M13","M14","M15","M16","M17"];
  roster.sort((a, b) => (rankOrder.indexOf(a.rank) - rankOrder.indexOf(b.rank)) || a.name.localeCompare(b.name));

  const DATA = roster.map(r => ({
    name: r.name, rank: r.rank, rc: rcOf(r.rank),
    days: days[r.name],
    ht: heightByName[r.name] ? ftin(heightByName[r.name]) : "",
    wt: r.wkg ? lbs(r.wkg) : "",
  }));
  const MAX_DAY = maxDay || 1;

  // in-place replace the data block in standings.html
  const html = fs.readFileSync("standings.html", "utf8");
  const re = /const MAX_DAY=\d+;\r?\nconst DATA=\[[\s\S]*?\];/;
  if (!re.test(html)) throw new Error("data block not found in standings.html");
  const inject = `const MAX_DAY=${MAX_DAY};\nconst DATA=${JSON.stringify(DATA)};`;
  fs.writeFileSync("standings.html", html.replace(re, inject));

  console.log(`OK roster(makuuchi)=${DATA.length} matches=${matches.length} maxDay=${MAX_DAY}`);
}

main().catch(e => { console.error(e); process.exit(1); });
