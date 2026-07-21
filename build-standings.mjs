// Rebuild standings.html from the sumo-api banzuke endpoint. Runs in GitHub Actions (Node fetch).
// One call returns roster + ranks + each wrestler's day-by-day record. No scraping, no Notion.
// Spoiler-safe logs: counts only.
import fs from 'node:fs';

const BASHO = process.env.BASHO || "202607";      // <-- the only per-basho knob
const DIVISION = "Makuuchi";
const TOTAL_DAYS = 15;
const TARGET = process.env.TARGET || "standings.html";

// height/weight aren't in the banzuke endpoint; keep a static map (ft/in, lb). New wrestlers -> blank.
const HT_WT = {"Hoshoryu": {"ht": "6'2\"", "wt": 331}, "Onosato": {"ht": "6'4\"", "wt": 417}, "Kirishima": {"ht": "6'1\"", "wt": 331}, "Kotozakura": {"ht": "6'2\"", "wt": 392}, "Aonishiki": {"ht": "6'0\"", "wt": 313}, "Atamifuji": {"ht": "6'2\"", "wt": 434}, "Kotoshoho": {"ht": "6'3\"", "wt": 379}, "Wakatakakage": {"ht": "6'0\"", "wt": 304}, "Yoshinofuji": {"ht": "6'1\"", "wt": 346}, "Oho": {"ht": "6'4\"", "wt": 408}, "Fujinokawa": {"ht": "5'10\"", "wt": 271}, "Takanosho": {"ht": "6'0\"", "wt": 381}, "Churanoumi": {"ht": "5'10\"", "wt": 333}, "Gonoyama": {"ht": "5'10\"", "wt": 344}, "Hiradoumi": {"ht": "5'10\"", "wt": 311}, "Hakunofuji": {"ht": "5'11\"", "wt": 351}, "Daieisho": {"ht": "6'0\"", "wt": 353}, "Ichiyamamoto": {"ht": "6'3\"", "wt": 353}, "Oshoma": {"ht": "6'3\"", "wt": 366}, "Ura": {"ht": "5'9\"", "wt": 306}, "Shodai": {"ht": "6'0\"", "wt": 370}, "Fujiseiun": {"ht": "6'1\"", "wt": 331}, "Kotoeiho": {"ht": "6'0\"", "wt": 313}, "Takayasu": {"ht": "6'2\"", "wt": 381}, "Wakamotoharu": {"ht": "6'2\"", "wt": 315}, "Roga": {"ht": "6'0\"", "wt": 353}, "Fujiryoga": {"ht": "5'11\"", "wt": 399}, "Tobizaru": {"ht": "5'8\"", "wt": 298}, "Asanoyama": {"ht": "6'2\"", "wt": 386}, "Chiyoshoma": {"ht": "6'0\"", "wt": 309}, "Mitakeumi": {"ht": "6'0\"", "wt": 386}, "Wakanosho": {"ht": "5'10\"", "wt": 320}, "Abi": {"ht": "6'2\"", "wt": 368}, "Asahakuryu": {"ht": "6'1\"", "wt": 335}, "Nishikifuji": {"ht": "6'0\"", "wt": 342}, "Takerufuji": {"ht": "6'2\"", "wt": 326}, "Kinbozan": {"ht": "6'5\"", "wt": 395}, "Shishi": {"ht": "6'4\"", "wt": 390}, "Onokatsu": {"ht": "6'1\"", "wt": 364}, "Kazuma": {"ht": "6'1\"", "wt": 452}, "Asakoryu": {"ht": "5'10\"", "wt": 276}, "Daiseizan": {"ht": "6'4\"", "wt": 362}};

const RESULT = { "win":"w", "fusen win":"w", "loss":"l", "fusen loss":"l", "absent":"a", "":"" };

function rankInfo(rankStr){
  const parts = String(rankStr||"").split(" ");
  const w = parts[0];
  if(w==="Yokozuna") return {rank:"Yokozuna", rc:"yok"};
  if(w==="Ozeki")    return {rank:"Ozeki",    rc:"ozeki"};
  if(w==="Sekiwake") return {rank:"Sekiwake", rc:"seki"};
  if(w==="Komusubi") return {rank:"Komusubi", rc:"komu"};
  if(w==="Maegashira") return {rank:"M"+parts[1], rc:"maeg"};
  return {rank:rankStr, rc:"maeg"};
}

async function getBanzuke(){
  if(process.env.LOCAL_JSON) return JSON.parse(fs.readFileSync(process.env.LOCAL_JSON,"utf8"));
  const res = await fetch(`https://www.sumo-api.com/api/basho/${BASHO}/banzuke/${DIVISION}`);
  if(!res.ok) throw new Error(`sumo-api banzuke -> ${res.status}: ${await res.text()}`);
  return res.json();
}

// Age = static fact, never gated. Pulled per-wrestler from sumo-api; blank on any miss.
async function fetchBirth(id){
  try{
    const res = await fetch(`https://www.sumo-api.com/api/rikishi/${id}`);
    if(!res.ok) return null;
    const j = await res.json();
    return j.birthDate ? String(j.birthDate).slice(0,10) : null;
  }catch(e){ return null; }
}
function ageFrom(bd){
  if(!bd) return null;
  const b=new Date(bd), n=new Date();
  let a=n.getUTCFullYear()-b.getUTCFullYear();
  const m=n.getUTCMonth()-b.getUTCMonth();
  if(m<0||(m===0&&n.getUTCDate()<b.getUTCDate())) a--;
  return (a>=0&&a<100)?a:null;
}

async function main(){
  const b = await getBanzuke();
  const all = [...(b.east||[]), ...(b.west||[])];
  all.sort((x,y)=> (x.rankValue-y.rankValue) || String(x.shikonaEn).localeCompare(String(y.shikonaEn)));

  // ages fetched in parallel from the rikishi endpoint (aligned to `all` by index)
  const ages = await Promise.all(all.map(r => fetchBirth(r.rikishiID).then(ageFrom)));

  let maxDay = 0;
  const DATA = all.map((r,idx)=>{
    const {rank, rc} = rankInfo(r.rank);
    const days = Array(TOTAL_DAYS).fill("");
    (r.record||[]).forEach((rec,i)=>{
      if(i>=TOTAL_DAYS) return;
      const code = RESULT[rec.result] ?? "";
      days[i] = code;
      if(code!=="" && (i+1)>maxDay) maxDay = i+1;
    });
    const hw = HT_WT[r.shikonaEn] || {ht:"", wt:""};
    return { name:r.shikonaEn, rank, rc, days, ht:hw.ht, wt:hw.wt, age:ages[idx] };
  });
  const MAX_DAY = maxDay || 1;

  const html = fs.readFileSync(TARGET,"utf8");
  const re = /const MAX_DAY=\d+;\r?\nconst DATA=\[[\s\S]*?\];/;
  if(!re.test(html)) throw new Error("data block not found in "+TARGET);
  fs.writeFileSync(TARGET, html.replace(re, `const MAX_DAY=${MAX_DAY};\nconst DATA=${JSON.stringify(DATA)};`));
  console.log(`OK roster=${DATA.length} maxDay=${MAX_DAY} (source: sumo-api banzuke ${BASHO})`);
}
main().catch(e=>{ console.error(e); process.exit(1); });
