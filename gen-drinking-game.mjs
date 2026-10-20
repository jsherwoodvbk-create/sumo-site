<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Leaderboard · Salt Stats &amp; Sumo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Zen+Old+Mincho:wght@400;700;900&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#f1e9db; --surface:#fbf7ef; --surface-2:#efe6d3; --ink:#26262b; --muted:#6f695d; --faint:#9a9182; --line:#e2d9c7;
    --clay:#a9742c; --clay-soft:#e6cf9f; --purple:#6a3d9a; --vermilion:#cf5a2c; --win:#227a4b; --loss:#a93327;
    --thead:#5e3c1e; --pace:#a9742c; --gold:#a9742c;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#171719; --surface:#212127; --surface-2:#1b1b21; --ink:#ece4d4; --muted:#a49c8b; --faint:#7b7364; --line:#33333b;
      --clay:#d2a35c; --clay-soft:#40331d; --purple:#b892e4; --vermilion:#e5814f; --win:#49bd82; --loss:#e06a5c;
      --thead:#2b2119; --pace:#d2a35c; --gold:#d2a35c;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); min-height:100vh; padding:16px 16px 56px;
         font:16px/1.5 'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  h1 { font-family:'Zen Old Mincho',Georgia,'Times New Roman',serif; }
  .wrap { max-width:680px; margin:0 auto; }
  /* clay roofline header band — the arena standard */
  header { background:
      repeating-linear-gradient(178deg, rgba(0,0,0,.14) 0 1px, transparent 1px 4px),
      repeating-linear-gradient(90deg, rgba(0,0,0,.05) 0 2px, transparent 2px 44px),
      linear-gradient(160deg,#6e4826,#432a15);
    color:#fff; border-radius:14px; padding:18px 20px; margin-bottom:16px; border:1px solid #38230f;
    box-shadow:0 8px 22px rgba(50,30,10,.28); }
  header h1 { margin:0; font-size:23px; line-height:1.1; font-weight:900; }
  header .sub { margin:3px 0 0; font-size:13px; opacity:.9; }
  .hdrow { display:flex; align-items:center; gap:14px; }
  .hdricon { width:50px; height:50px; flex:0 0 auto; filter:drop-shadow(0 2px 5px rgba(0,0,0,.3)); }
  .hdnav { margin-left:auto; display:flex; align-items:center; gap:9px; }
  .navcoin { width:34px; height:34px; flex:0 0 auto; border-radius:50%; overflow:hidden; display:block;
             box-shadow:0 0 0 1px rgba(255,255,255,.30), 0 2px 6px rgba(0,0,0,.28);
             transition:transform .12s ease, box-shadow .12s ease; }
  .navcoin svg { width:100%; height:100%; display:block; }
  .navcoin:hover { transform:translateY(-1px); box-shadow:0 0 0 1px rgba(255,255,255,.55), 0 5px 13px rgba(0,0,0,.34); }
  /* home crest — the site mark, tap to go home */
  .homecrest { width:34px; height:34px; border-radius:50%; flex:0 0 auto; overflow:hidden;
               background:#efe7d5; box-shadow:0 0 0 1px rgba(255,255,255,.30), 0 2px 6px rgba(0,0,0,.28);
               transition:transform .12s ease, box-shadow .12s ease; }
  .homecrest:hover { transform:translateY(-1px); box-shadow:0 0 0 1px rgba(255,255,255,.55), 0 5px 13px rgba(0,0,0,.34); }
  .homecrest img { width:100%; height:100%; object-fit:cover; display:block; }
  .body { margin:0; }
  /* view toggle */
  .tabs { display:flex; gap:6px; background:var(--surface-2); border:1px solid var(--line); border-radius:10px;
          padding:4px; margin:0 0 18px; }
  .tabs button { flex:1; font:inherit; font-size:13.5px; font-weight:600; color:var(--muted);
                 background:transparent; border:0; border-radius:7px; padding:9px 6px; cursor:pointer; }
  .tabs button.on { background:var(--ink); color:var(--bg); box-shadow:0 2px 6px rgba(0,0,0,.14); }
  .viewhead { font-size:13px; color:var(--muted); margin:0 0 10px; text-transform:uppercase; letter-spacing:.04em; font-weight:700; }
  .scorehint { font-size:12px; color:var(--muted); margin:0 0 12px; line-height:1.45; }
  .pending { background:var(--surface-2); border:1px solid var(--line); border-left:4px solid var(--clay);
             border-radius:9px; padding:11px 14px; font-size:13px; line-height:1.5; margin:0 0 16px; }
  table { width:100%; border-collapse:collapse; font-size:15px; }
  thead th { text-align:left; font-size:11px; letter-spacing:.04em; text-transform:uppercase;
             color:var(--muted); border-bottom:2px solid var(--line); padding:7px 10px; }
  thead th.num, td.num { text-align:right; font-variant-numeric:tabular-nums; }
  tbody td { padding:11px 10px; border-bottom:1px solid var(--line); }
  tbody tr.leader { background:color-mix(in srgb, var(--clay) 12%, transparent); }
  .place { font-weight:700; color:var(--muted); width:40px; }
  .medal { font-size:17px; }
  .who { font-weight:600; }
  /* season points split into columns: Picks + Participation = Total */
  td.num.sub { color:var(--muted); font-weight:600; font-size:14px; }
  td.num.sub.eng { color:var(--purple); }
  thead th.num.eng { color:var(--purple); }
  /* grouped header for the per-basho scoreboard (Banzuke prediction spans Score + Pts) */
  thead th.grphd { text-align:center; color:var(--clay); border-bottom:1px solid var(--line); padding-bottom:5px; }
  @media (max-width:430px){
    thead th, tbody td { padding-left:6px; padding-right:6px; }
    td.num.sub { font-size:13px; }
  }
  .pts { font-weight:800; font-size:17px; }
  .golf { color:var(--muted); font-variant-numeric:tabular-nums; }
  /* pace car strip — Gumbai, the benchmark. Warm parchment, on-palette. */
  .pacecar { margin:16px 0 4px; display:flex; align-items:center; gap:12px;
             background:var(--surface-2); border:1px solid var(--line); border-radius:10px; padding:12px 15px; }
  .pacecar .botimg { width:38px; height:38px; flex:0 0 auto; }
  .pacecar .txt { font-size:13px; line-height:1.45; color:var(--muted); }
  .pacecar .txt b { color:var(--pace); }
  .pacecar .p { margin-left:auto; text-align:center; flex:0 0 auto; }
  .pacecar .p .n { font-weight:800; font-size:20px; color:var(--pace); font-variant-numeric:tabular-nums; }
  .pacecar .p .l { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--faint); }
  .cta { margin-top:22px; background:var(--surface-2); border:1px dashed var(--vermilion); border-radius:10px;
         padding:16px 18px; text-align:center; }
  .cta p { margin:0 0 12px; font-size:14px; line-height:1.5; }
  .cta a { display:inline-block; background:var(--vermilion); color:#fff; text-decoration:none;
           font-weight:600; font-size:14.5px; padding:10px 22px; border-radius:8px; transition:filter .12s ease; }
  .cta a:hover { filter:brightness(1.08); }
  /* on the app surface you're already a member — the join funnel is a site-only call */
  body[data-surface="app"] .cta { display:none; }
  .rules { margin-top:16px; font-size:12px; color:var(--muted); line-height:1.55; }
  .foot { text-align:center; margin-top:16px; font-size:12px; color:var(--muted); }
  .spin { text-align:center; padding:30px; color:var(--muted); font-size:14px; }
</style>
</head>
<body>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <filter id="inkS" x="-6%" y="-6%" width="112%" height="112%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="1.3" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <clipPath id="coinClip"><circle cx="60" cy="60" r="55"/></clipPath>
    <symbol id="ic-leaderboard" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="58" fill="#efe7d5"/>
      <circle cx="60" cy="60" r="55.5" fill="none" stroke="#c06a34" stroke-width="4.5"/>
      <circle cx="60" cy="60" r="49" fill="none" stroke="#c06a34" stroke-width="1.3"/>
      <g clip-path="url(#coinClip)" filter="url(#inkS)">
        <g fill="#211a12">
          <rect x="38" y="60" width="16" height="20" rx="2"/>
          <rect x="52" y="50" width="16" height="30" rx="2"/>
          <rect x="66" y="64" width="16" height="16" rx="2"/>
        </g>
        <path d="M60 39 l2.5 5.1 l5.6 .5 l-4.2 3.7 l1.3 5.5 l-5.2 -2.9 l-5.2 2.9 l1.3 -5.5 l-4.2 -3.7 l5.6 -.5 Z" fill="#b23a2e"/>
      </g>
    </symbol>
  </defs></svg>
  <div class="wrap">
    <header>
      <div class="hdrow">
        <svg class="hdricon" viewBox="0 0 120 120" aria-hidden="true"><use href="#ic-leaderboard"/></svg>
        <div>
          <h1>Leaderboard</h1>
          <p class="sub" id="sub">The crew's ranking this basho, this year, or all-time.</p>
        </div>
        <nav class="hdnav">
          <a class="homecrest" id="crest" href="/" title="Salt Stats &amp; Sumo · home" aria-label="Home"><img src="/salt-stats-sumo-badgeold.png" alt=""></a>
        </nav>
      </div>
    </header>
    <div class="body" id="body">
      <div class="spin">Loading standings…</div>
    </div>
    <p class="foot">Each basho, the closest three crew members score 3·2·1. Gumbai runs the same race as the pace car. Beat it if you can.</p>
  </div>
<script>
(function () {
  var body = document.getElementById('body');
  var MEDAL = { 1:'🥇', 2:'🥈', 3:'🥉' };
  var state = { data:null, view:'thisBasho' };
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function ordinal(n){ var s=['th','st','nd','rd'], v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }
  function tabsHTML(){
    var t = [['thisBasho','This basho'],['thisYear','This year'],['allTime','All-time']];
    return '<div class="tabs">' + t.map(function(x){
      return '<button data-v="'+x[0]+'" class="'+(state.view===x[0]?'on':'')+'">'+x[1]+'</button>';
    }).join('') + '</div>';
  }
  function ctaHTML(){
    return '<div class="cta"><p>Think you can out-call the crew, or even the bot?</p>'+
      '<a href="/join">Join the crew &amp; make your picks →</a></div>';
  }
  function pendingHTML(){
    var p = state.data.pending;
    return p ? '<div class="pending">🔒 '+esc(p.message)+'</div>' : '';
  }
  function paceStrip(pace, view){
    if(!pace) return '';
    var detail;
    if(view==='thisBasho'){
      var overall = (pace.aheadRank!=null) ? ('. It scored '+pace.golf+', good for '+ordinal(pace.aheadRank)+' in the field') : '';
      detail = 'Gumbai, the machine, ran the same race'+overall+'.';
    } else {
      detail = 'Gumbai, running the season as the pace car.';
    }
    return '<div class="pacecar"><img class="botimg" src="/gumbai-badge.svg" alt="Gumbai">'+
      '<span class="txt"><b>Gumbai · pace car</b><br>'+esc(detail)+' The crew’s crown is decided among the humans. This is the mark to beat.</span>'+
      '<span class="p"><span class="n">'+pace.points+'</span><span class="l">pace pts</span></span></div>';
  }
  function renderBasho(v){
    var humans = v.rows.filter(function(r){return !r.pace;});
    var pace = v.rows.filter(function(r){return r.pace;})[0];
    if(pace){ // pace car's finishing position in the full field (for the strip text)
      pace.aheadRank = v.rows.filter(function(r){return r.golf!=null && r.golf < pace.golf;}).length + 1;
    }
    // With participation banked for this basho, show the full scoreboard and rank by Total;
    // before the tournament ends (no participation yet) it stays the prediction result by Score.
    var hasPart = !!v.hasPart || humans.some(function(r){ return (r.part||0) > 0; });
    var g = function(x){ return x.golf==null ? Infinity : x.golf; };
    var tot = function(x){ return x.total==null ? x.points : x.total; };
    var ordered = humans.slice().sort(hasPart
      ? function(a,b){ return (tot(b)-tot(a)) || (g(a)-g(b)); }
      : function(a,b){ return g(a)-g(b); });
    var rank=0, prev=null;
    var rows = ordered.map(function(r,i){
      var med, lead;
      if(hasPart){
        var k = tot(r);
        if(prev===null || k!==prev){ rank=i+1; prev=k; }
        med = MEDAL[rank] ? '<span class="medal">'+MEDAL[rank]+'</span>' : rank;
        lead = (rank===1 && k>0);
      } else {
        med = MEDAL[r.place] ? '<span class="medal">'+MEDAL[r.place]+'</span>' : r.place;
        lead = (r.place===1);
      }
      var golf = (r.golf==null ? '—' : r.golf);
      var tail = hasPart
        ? '<td class="num sub">'+r.points+'</td>'+
          '<td class="num sub eng">'+(r.part==null?0:r.part)+'</td>'+
          '<td class="num"><span class="pts">'+tot(r)+'</span></td>'
        : '<td class="num"><span class="pts">'+r.points+'</span></td>';
      return '<tr class="'+(lead?'leader':'')+'">'+
        '<td class="place">'+med+'</td>'+
        '<td class="who">'+esc(r.name)+'</td>'+
        '<td class="num golf">'+golf+'</td>'+ tail +'</tr>';
    }).join('');
    var head = hasPart
      ? '<tr class="grp"><th rowspan="2">#</th><th rowspan="2">Crew</th>'+
        '<th class="num grphd" colspan="2">Banzuke prediction</th>'+
        '<th class="num eng" rowspan="2">Partic.</th><th class="num" rowspan="2">Total</th></tr>'+
        '<tr><th class="num">Score ↓</th><th class="num">Pts</th></tr>'
      : '<tr><th>#</th><th>Crew</th><th class="num">Score ↓</th><th class="num">Points</th></tr>';
    var hint = hasPart
      ? 'Banzuke prediction: Score is how far your picks landed from where the wrestlers actually finished (lower is better), and Pts is the 3·2·1 it earns. Participation is the drinking-game and Gumbai points banked over the tournament. Total decides the basho.'
      : 'Score = how far your picks landed from the real banzuke, added up. ↓ Lowest wins.';
    return '<p class="viewhead">'+esc(v.basho)+' · final</p>'+
      '<p class="scorehint">'+hint+'</p>'+
      '<table><thead>'+head+'</thead>'+
      '<tbody>'+rows+'</tbody></table>'+ paceStrip(pace,'thisBasho');
  }
  function renderPoints(v, label){
    var humans = v.rows.filter(function(r){return !r.pace;});
    var pace = v.rows.filter(function(r){return r.pace;})[0];
    // Break the total into Picks + Participation columns only when this view carries engagement.
    var hasPart = humans.some(function(r){ return (r.part||0) > 0; });
    // dense rank by points (ties share)
    var rank=0, prev=null;
    var rows = humans.map(function(r,i){
      if(prev===null || r.points!==prev){ rank=i+1; prev=r.points; }
      var med = MEDAL[rank] ? '<span class="medal">'+MEDAL[rank]+'</span>' : rank;
      var grade = (r.grade==null ? r.points : r.grade), part = (r.part==null ? 0 : r.part);
      var cells = hasPart
        ? '<td class="num sub">'+grade+'</td>'+
          '<td class="num sub eng">'+part+'</td>'+
          '<td class="num"><span class="pts">'+r.points+'</span></td>'
        : '<td class="num"><span class="pts">'+r.points+'</span></td>';
      return '<tr class="'+(rank===1&&r.points>0?'leader':'')+'">'+
        '<td class="place">'+med+'</td>'+
        '<td class="who">'+esc(r.name)+'</td>'+ cells +'</tr>';
    }).join('');
    var head = hasPart
      ? '<th>#</th><th>Crew</th><th class="num">Picks</th><th class="num eng">Partic.</th><th class="num">Total</th>'
      : '<th>#</th><th>Crew</th><th class="num">Points</th>';
    return '<p class="viewhead">'+esc(label)+'</p>'+
      '<table><thead><tr>'+head+'</tr></thead>'+
      '<tbody>'+rows+'</tbody></table>'+ paceStrip(pace, 'points');
  }
  function render(){
    var d = state.data, v = d.views;
    var inner;
    if(state.view==='thisBasho'){
      inner = v.thisBasho ? renderBasho(v.thisBasho) : '<p class="spin">No basho scored yet.</p>';
    } else if(state.view==='thisYear'){
      inner = renderPoints(v.thisYear, (v.thisYear.year||'') + ' season · points');
    } else {
      inner = renderPoints(v.allTime, 'All-time · points');
    }
    body.innerHTML = tabsHTML() + pendingHTML() + inner + ctaHTML() +
      '<p class="rules">Each basho, your picks are graded by how far they landed from the real banzuke; the lowest score earns the top banzuke points (3·2·1). Participation adds more on the same flat 3·2·1, from the drinking-game and Gumbai boards. The two combine into each basho’s Total and the season standings. Gumbai plays too, as the pace car: it earns the medal its own finish would take, but the crew crown is settled among the humans.</p>';
    body.querySelectorAll('.tabs button').forEach(function(b){
      b.onclick = function(){ state.view = b.dataset.v; render(); };
    });
  }
  fetch('/api/leaderboard', { credentials:'same-origin' })
    .then(function(r){ return r.json(); })
    .then(function(d){ state.data = d; render(); })
    .catch(function(){
      body.innerHTML = '<div class="spin">Standings are taking a breather. Refresh in a moment.</div>';
    });
})();
</script>
<script>
/* surface-aware header: "home" + the Back-to-Games coin follow the surface you're browsing (app hub vs
   public site), not your login. An explicit ?s=app hint from the app's Games card is authoritative and
   survives refresh via sessionStorage; the referrer is only a fallback when there's no hint. The site
   surface keeps the plain crest and the Join CTA; the app surface swaps in Back-to-Games + crew home. */
(function(){
  var s=null;
  try{ var q=new URLSearchParams(location.search).get('s'); if(q==='app'||q==='site') s=q; }catch(e){}
  if(!s){ try{ if(document.referrer){ var u=new URL(document.referrer);
    if(u.origin===location.origin && u.pathname!==location.pathname)
      s = u.pathname.indexOf('/app')===0 ? 'app' : 'site'; } }catch(e){} }
  if(s){ try{ sessionStorage.setItem('ss_surface', s); }catch(e){} }
  else { try{ s = sessionStorage.getItem('ss_surface'); }catch(e){} }
  try{ document.body.setAttribute('data-surface', s||'site'); }catch(e){}
  if(s==='app'){
    var c=document.getElementById('crest'); if(c){ c.setAttribute('href','/app'); c.setAttribute('title','Crew home'); }
  }
})();
</script>
</body>
</html>
