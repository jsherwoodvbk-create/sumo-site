// Rebuild standings.html from the sumo-api banzuke endpoint. Runs in GitHub Actions (Node fetch).
// One call returns roster + ranks + each wrestler's day-by-day record. No scraping, no Notion.
// Spoiler-safe logs: counts only.
import fs from 'node:fs';

// ─── PER-BASHO CONFIG — change at the start of each tournament ───────────────
// BASHO: sumo-api basho code YYYYMM. This is the LIVE value — publish.yml does not
//   override it, so edit it right here. Must also change in sync-notion.yml and
//   sync-notion.mjs (the config block up top there).
//   NOTE: the standings HEADER (title / h1 / gate) is now DERIVED from BASHO — no hand-edit.
// HT_WT map below: add rows for any newly-promoted Makuuchi wrestlers, or their
//   height/weight columns show blank. (Age auto-fetches from sumo-api, so age is fine.)
// Full step-by-step: see the "Tournament Rollover" checklist in the project.
const BASHO = process.env.BASHO || "202609";
const DIVISION = "Makuuchi";
const TOTAL_DAYS = 15;
const TARGET = process.env.TARGET || "standings.html";

// Basho label DERIVED from the BASHO code, so the header is never hand-edited each drop.
// Odd months (02/04/…) or a malformed code → null, and the stamp is skipped (header left as-is).
const BASHO_NAMES = { "01":"Hatsu", "03":"Haru", "05":"Natsu", "07":"Nagoya", "09":"Aki", "11":"Kyushu" };
function bashoLabel(code){
  const s = String(code || "");
  const nm = BASHO_NAMES[s.slice(4,6)], yr = s.slice(0,4);
  return (nm && /^\d{4}$/.test(yr)) ? `${nm} ${yr}` : null;
}

// height/weight aren't in the banzuke endpoint; keep a static map (ft/in, lb). New wrestlers -> blank.
const HT_WT = {"Hoshoryu": {"ht": "6'2\"", "wt": 331}, "Onosato": {"ht": "6'4\"", "wt": 417}, "Kirishima": {"ht": "6'1\"", "wt": 331}, "Kotozakura": {"ht": "6'2\"", "wt": 392}, "Aonishiki": {"ht": "6'0\"", "wt": 313}, "Atamifuji": {"ht": "6'2\"", "wt": 434}, "Kotoshoho": {"ht": "6'3\"", "wt": 379}, "Wakatakakage": {"ht": "6'0\"", "wt": 304}, "Yoshinofuji": {"ht": "6'1\"", "wt": 346}, "Oho": {"ht": "6'4\"", "wt": 408}, "Fujinokawa": {"ht": "5'10\"", "wt": 271}, "Takanosho": {"ht": "6'0\"", "wt": 381}, "Churanoumi": {"ht": "5'10\"", "wt": 333}, "Gonoyama": {"ht": "5'10\"", "wt": 344}, "Hiradoumi": {"ht": "5'10\"", "wt": 311}, "Hakunofuji": {"ht": "5'11\"", "wt": 351}, "Daieisho": {"ht": "6'0\"", "wt": 353}, "Ichiyamamoto": {"ht": "6'3\"", "wt": 353}, "Oshoma": {"ht": "6'3\"", "wt": 366}, "Ura": {"ht": "5'9\"", "wt": 306}, "Shodai": {"ht": "6'0\"", "wt": 370}, "Fujiseiun": {"ht": "6'1\"", "wt": 331}, "Kotoeiho": {"ht": "6'0\"", "wt": 313}, "Takayasu": {"ht": "6'2\"", "wt": 381}, "Wakamotoharu": {"ht": "6'2\"", "wt": 315}, "Roga": {"ht": "6'0\"", "wt": 353}, "Fujiryoga": {"ht": "5'11\"", "wt": 399}, "Tobizaru": {"ht": "5'8\"", "wt": 298}, "Asanoyama": {"ht": "6'2\"", "wt": 386}, "Chiyoshoma": {"ht": "6'0\"", "wt": 309}, "Mitakeumi": {"ht": "6'0\"", "wt": 386}, "Wakanosho": {"ht": "5'10\"", "wt": 320}, "Abi": {"ht": "6'2\"", "wt": 368}, "Asahakuryu": {"ht": "6'1\"", "wt": 335}, "Nishikifuji": {"ht": "6'0\"", "wt": 342}, "Takerufuji": {"ht": "6'2\"", "wt": 326}, "Kinbozan": {"ht": "6'5\"", "wt": 395}, "Shishi": {"ht": "6'4\"", "wt": 390}, "Onokatsu": {"ht": "6'1\"", "wt": 364}, "Kazuma": {"ht": "6'1\"", "wt": 452}, "Asakoryu": {"ht": "5'10\"", "wt": 276}, "Daiseizan": {"ht": "6'4\"", "wt": 362}, "Asasuiryu": {"ht": "5'9\"", "wt": 265}, "Tokihayate": {"ht": "5'10\"", "wt": 300}, "Toshinofuji": {"ht": "6'5\"", "wt": 333}, "Shonannoumi": {"ht": "6'4\"", "wt": 403}};

const MAWASHI = {"Abi":"#191970","Aonishiki":"#004225","Asahakuryu":"#16305c","Asakoryu":"#b7302a","Asanoyama":"#5a2a52","Atamifuji":"#7e3a4f","Chiyoshoma":"#a9762f","Churanoumi":"#6a3d9a","Daieisho":"#932c50","Daiseizan":"#5d2e8e","Fujinokawa":"#2f6fc0","Fujiryoga":"#16305c","Fujiseiun":"#191970","Gonoyama":"#191970","Hakunofuji":"#8a7b68","Hiradoumi":"#2b1a47","Hoshoryu":"#10132e","Ichiyamamoto":"#17a088","Kazuma":"#191970","Kinbozan":"#8c8c8c","Kirishima":"#3a2b3a","Kotoeiho":"#5b73a0","Kotoshoho":"#aebfca","Kotozakura":"#7fd8cf","Mitakeumi":"#bf3d67","Nishikifuji":"#c096bf","Oho":"#47215e","Onokatsu":"#9a9a9a","Onosato":"#191970","Oshoma":"#c6c6c6","Roga":"#302a63","Sadanoumi":"#7d8894","Shishi":"#1c1c1c","Shodai":"#1c1c1c","Takanosho":"#b7302a","Takayasu":"#16305c","Takerufuji":"#ab8fd0","Tobizaru":"#adbccb","Ura":"#ffb7c5","Wakamotoharu":"#1c1c1c","Wakanosho":"#191970","Wakatakakage":"#16215e","Yoshinofuji":"#2b1a47"};

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

async function fetchChampionName(){
  if(process.env.CHAMPION_NAME !== undefined) return process.env.CHAMPION_NAME || null;
  try{
    const res = await fetch(`https://www.sumo-api.com/api/basho/${BASHO}`);
    if(!res.ok) return null;
    const j = await res.json();
    const arr = Array.isArray(j.yusho) ? j.yusho : [];
    const mk = arr.find(y => /makuuchi/i.test(String((y && (y.type||y.division))||"")));
    return mk ? (mk.shikonaEn || mk.shikona || mk.rikishiEn || null) : null;
  }catch(e){ return null; }
}

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

  const ages = await Promise.all(all.map(r => fetchBirth(r.rikishiID).then(ageFrom)));

  const dayDecided = Array(TOTAL_DAYS).fill(0);
  const DATA = all.map((r,idx)=>{
    const {rank, rc} = rankInfo(r.rank);
    const days = Array(TOTAL_DAYS).fill("");
    (r.record||[]).forEach((rec,i)=>{
      if(i>=TOTAL_DAYS) return;
      const code = RESULT[rec.result] ?? "";
      days[i] = code;
      if(code==="w"||code==="l") dayDecided[i]++;
    });
    const hw = HT_WT[r.shikonaEn] || {ht:"", wt:""};
    const mc = MAWASHI[r.shikonaEn];
    const slug = String(r.shikonaEn).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
    const shotPath = `img/headshots/${slug}.png`;
    const shot = fs.existsSync(shotPath) ? shotPath : null;
    return { name:r.shikonaEn, rank, rc, days, ht:hw.ht, wt:hw.wt, age:ages[idx], ...(mc?{color:mc}:{}), ...(shot?{shot}:{}) };
  });
  const fullSlate = Math.max(0, ...dayDecided);
  const rosterFloor = Math.floor(all.length / 2);
  const expectedFull = Math.max(fullSlate, rosterFloor);
  const DAY_TOL = 3;
  let MAX_DAY = 1;
  for(let d=1; d<=TOTAL_DAYS; d++){
    const cnt = dayDecided[d-1];
    const laterHasData = d<TOTAL_DAYS && dayDecided[d] > 0;
    if(cnt>0 && ((cnt >= expectedFull - DAY_TOL) || laterHasData)) MAX_DAY = d;
  }

  const champName = await fetchChampionName();
  let champion = null;
  if(champName){
    const winsOf = r => (r.days||[]).filter(v=>v==="w").length;
    const maxW = Math.max(0, ...DATA.map(winsOf));
    const tiedAtTop = DATA.filter(r => winsOf(r) === maxW).length;
    champion = { name: champName, playoff: maxW > 0 && tiedAtTop > 1 };
  }

  let out = fs.readFileSync(TARGET,"utf8");
  // Match MAX_DAY + CHAMPION + DATA as one block so re-runs stay idempotent (CHAMPION seeded as null in the template).
  const re = /const MAX_DAY=\d+;\r?\nconst CHAMPION=[\s\S]*?;\r?\nconst DATA=\[[\s\S]*?\];/;
  if(!re.test(out)) throw new Error("data block not found in "+TARGET+" (expected MAX_DAY / CHAMPION / DATA lines)");
  out = out.replace(re, `const MAX_DAY=${MAX_DAY};\nconst CHAMPION=${JSON.stringify(champion)};\nconst DATA=${JSON.stringify(DATA)};`);

  // Header basho label — DERIVED from BASHO and stamped into title / h1 / gate every publish, so it
  // never freezes on the old basho. Anchors on the FIXED surrounding text (not the old basho name),
  // so it's idempotent and doesn't care what's currently there. Skipped if the code doesn't resolve.
  const LABEL = bashoLabel(BASHO);
  if(LABEL){
    const before = out;
    out = out.replace(/(<title>Salt Stats & Sumo · ).*?( Standings<\/title>)/, `$1${LABEL}$2`)
             .replace(/(<h1>).*?( · Makuuchi Standings<\/h1>)/,               `$1${LABEL}$2`)
             .replace(/(<h2>).*?( is in progress<\/h2>)/,                     `$1${LABEL}$2`);
    console.log(out!==before ? `header stamped -> ${LABEL}` : `header already ${LABEL} (or anchors not found)`);
  } else {
    console.warn(`header not stamped — BASHO ${BASHO} didn't resolve to a name (odd month?)`);
  }

  fs.writeFileSync(TARGET, out);
  console.log(`OK roster=${DATA.length} maxDay=${MAX_DAY} champion=${champion?champion.name+(champion.playoff?" (playoff)":""):"none"} (source: sumo-api ${BASHO})`);

  // Keep the homepage badge's day in sync.
  try {
    const IDX = 'index.html';
    if (fs.existsSync(IDX)) {
      const idx = fs.readFileSync(IDX, 'utf8');
      const idxRe = /(in progress · Day )\d+/;
      if (idxRe.test(idx)) {
        const patched = idx.replace(idxRe, `$1${MAX_DAY}`);
        if (patched !== idx) { fs.writeFileSync(IDX, patched); console.log(`index.html badge -> Day ${MAX_DAY}`); }
        else console.log(`index.html badge already Day ${MAX_DAY}`);
      } else console.log('index.html badge pattern not found — skipped (homepage day not updated)');
    }
  } catch (e) { console.warn('index.html badge update skipped:', e.message); }
}
main().catch(e=>{ console.error(e); process.exit(1); });
