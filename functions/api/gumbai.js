// functions/api/gumbai.js — Cloudflare Pages Function. Route: POST /api/gumbai
//
// Flow: read the session cookie → decide AUDIENCE (member = logged-in crew, public = everyone else)
// → gate the snapshot to the viewer's day AND their audience (spoiler safety + the member/public
// data line happen HERE, in data, before the model sees anything) → run Claude with the
// audience-scoped tools in a short agent loop → return the grounded, in-voice answer.
//
// AUDIENCE SPLIT (2026-08-31): one endpoint, the cookie decides. A logged-in crew member hitting the
// public /gumbai page still sends their session, so they get the MEMBER oracle on the same page; a
// public visitor sends no cookie and gets the reduced PUBLIC oracle. Read ONLY from getSession,
// server-side — never a client flag. Public is the floor; member is additive.
//   - DATA: public view is stripped of injuries, day storylines, and the member-only per-bout nets.
//   - TOOLS: public omits query_condition + query_storylines.
//   - BUDGET: public gets a smaller max_tokens + fewer tool hops (protect the crew's monthly budget).
//   - LOGGING: member turns → Notion interaction log (as before); PUBLIC turns → Cloudflare Analytics
//     Engine, so no public traffic ever touches Notion (Notion's rate limit is per-token = the lock-out
//     path). The old NOTION_TOKEN fallback no longer carries public writes.
//
// Secrets/config (Cloudflare Pages → Settings → Environment variables / Bindings):
//   ANTHROPIC_API_KEY   (required, encrypted)  — from console.anthropic.com
//   GUMBAI_MODEL        (optional)             — model slug; defaults below.
//   GUMBAI_LOG_DB       (optional)             — Notion database id for the MEMBER interaction log.
//   GUMBAI_LOG_TOKEN    (optional)             — Notion integration token (falls back to NOTION_TOKEN).
//   GUMBAI_AE           (optional binding)     — Analytics Engine dataset for PUBLIC turn logs.
//   AUTH_SECRET         (required for sessions)— used by getSession to verify the crew cookie.
//
// The monthly HARD cap is the spending limit you set in the Anthropic console — that's the real stop.

import SNAP from './_snapshot.js';
import { gateSnapshot, buildSystemPrompt, toolsFor, TOOLS, runTool, ENGINE_VERSION } from './_engine.js';
import { getSession } from './auth/_session.js';

const MODEL_DEFAULT = 'claude-opus-4-8';   // confirm exact slug in the Anthropic console
const MAX_TOOL_HOPS = 6;                    // safety bound on the agent loop (member)
const PUBLIC_TOOL_HOPS = 4;                 // tighter loop for public (cheaper per answer)
const MAX_TOKENS_MEMBER = 1024;
const MAX_TOKENS_PUBLIC = 640;              // smaller per-turn budget for public — stretches the monthly cap
const MAX_MESSAGES  = 40;                   // conversational memory window we accept
const MAX_CHARS     = 4000;                 // per user message (abuse guard)

const FAN_DOWN =
  "🪭 Gumbai's fan is down for the month — no tachiai till the calendar flips. " +
  "*(We've hit this month's question budget; he's back next month.)*";

const json = (obj, status=200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
});

// ── answer classification (shared by both loggers) ──
const NOTION_TXT = 1900;   // stay under Notion's 2000-char-per-rich-text limit

function classifyAnswer(capped, usedTools, reply){
  if(capped) return 'capped';
  if(!usedTools || !usedTools.length) return 'no tool call';
  if(/\b(don'?t|do not|didn'?t) have\b|not in our data|outside what we track|can'?t (confirm|call|total)/i.test(reply||''))
    return 'deflected — no data';
  return 'tool-grounded';
}

// ── MEMBER logging → Notion "Gumbai Interaction Log", fire-and-forget via waitUntil. ──
// No-op unless both GUMBAI_LOG_DB and a token are configured. Only MEMBER turns reach this now,
// so no public traffic can ever write to Notion (the per-token rate-limit lock-out path is closed).
async function logInteraction(env, { question, reply, gateDay, showFull, usedTools, model, turns, capped }){
  const dbId  = env && env.GUMBAI_LOG_DB;
  const token = env && (env.GUMBAI_LOG_TOKEN || env.NOTION_TOKEN);
  if(!dbId || !token) return;                              // logging not configured — skip silently
  const toolNames = [...new Set((usedTools||[]).map(t => t && t.name).filter(Boolean))];
  const props = {
    'Question':      { title:     [{ text:{ content: String(question||'(empty)').slice(0, NOTION_TXT) } }] },
    'Reply':         { rich_text: [{ text:{ content: String(reply||'').slice(0, NOTION_TXT) } }] },
    'Asked':         { date: { start: new Date().toISOString() } },
    'Gate Day':      { number: Number.isInteger(gateDay) ? gateDay : null },
    'Full View':     { checkbox: !!showFull },
    'Tools Used':    { multi_select: (toolNames.length ? toolNames : ['(none)']).map(n => ({ name: n })) },
    'Answered From': { select: { name: classifyAnswer(capped, usedTools, reply) } },
    'Model':         { rich_text: [{ text:{ content: String(model||'').slice(0, 200) } }] },
    'Turns':         { number: Number.isInteger(turns) ? turns : null },
  };
  try {
    await fetch('https://api.notion.com/v1/pages', {
      method:'POST',
      headers:{
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ parent:{ database_id: dbId }, properties: props }),
    });
  } catch(e){ /* logging must never affect the reply */ }
}

// ── PUBLIC logging → Cloudflare Analytics Engine. NO Notion, so a public spike can never throttle
// the crew's Notion. No-op if the GUMBAI_AE binding isn't configured. AE holds the raw firehose and
// ages it out on its own retention; a nightly Action can roll deflections + a daily count into Notion.
function logPublic(env, { question, reply, gateDay, usedTools, model, turns, capped }){
  const ae = env && env.GUMBAI_AE;
  if(!ae || typeof ae.writeDataPoint !== 'function') return;   // AE binding not configured — skip
  try {
    const toolNames = [...new Set((usedTools||[]).map(t => t && t.name).filter(Boolean))];
    ae.writeDataPoint({
      indexes: ['public'],                                     // sampling key
      blobs: [
        'public',                                              // audience
        classifyAnswer(capped, usedTools, reply),              // Answered From
        toolNames.join(',') || '(none)',                       // tools used
        String(question||'').slice(0, 200),                    // truncated question (the deflection signal)
        String(model||'').slice(0, 80),
      ],
      doubles: [ Number.isInteger(gateDay) ? gateDay : -1, Number.isInteger(turns) ? turns : 0, capped ? 1 : 0 ],
    });
  } catch(e){ /* logging must never affect the reply */ }
}

export async function onRequestPost(ctx){
  const { request, env } = ctx;
  // ── parse + validate ──────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); } catch { return json({ error:'bad_json' }, 400); }
  let { messages, day, showFull } = body || {};
  if(!Array.isArray(messages) || messages.length===0) return json({ error:'no_messages' }, 400);
  if(messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
  // sanitize: only role/content, clamp size, drop anything else
  messages = messages
    .filter(m => m && (m.role==='user'||m.role==='assistant') && typeof m.content==='string')
    .map(m => ({ role:m.role, content: m.content.slice(0, MAX_CHARS) }));
  if(!messages.length || messages[messages.length-1].role!=='user')
    return json({ error:'last_message_must_be_user' }, 400);

  if(!env || !env.ANTHROPIC_API_KEY)
    // Not wired yet — let the page show its friendly "coming soon" state.
    return json({ error:'not_configured', reply:null }, 503);

  const question = messages[messages.length-1].content;   // the user's turn we're answering

  // ── AUDIENCE: the cookie decides, server-side. Verified session = crew member; else public. ──
  let session = null;
  try { session = await getSession(request, env); } catch(e){ session = null; }  // never let auth failure break the oracle
  const audience = session ? 'member' : 'public';

  // ── gate BEFORE the model sees anything (day-gate AND audience-gate) ───────
  const gated = gateSnapshot(SNAP, day, showFull, audience);
  const system = [
    { type:'text', text: buildSystemPrompt(gated, audience), cache_control:{ type:'ephemeral' } } // prompt caching = cheaper repeats
  ];
  const model  = (env.GUMBAI_MODEL || MODEL_DEFAULT);
  const tools  = toolsFor(audience);
  const maxTokens = audience === 'public' ? MAX_TOKENS_PUBLIC : MAX_TOKENS_MEMBER;
  const maxHops   = audience === 'public' ? PUBLIC_TOOL_HOPS  : MAX_TOOL_HOPS;

  // route each turn's log by audience: member → Notion (waitUntil), public → Analytics Engine (no Notion)
  const logTurn = (payload) => {
    if(audience === 'member') ctx.waitUntil(logInteraction(env, payload));
    else logPublic(env, payload);
  };

  // ── agent loop ────────────────────────────────────────────────────────────
  const convo = messages.slice();       // Claude-format message list we grow with tool turns
  const usedTools = [];
  try {
    for(let hop=0; hop<maxHops; hop++){
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version':'2023-06-01',
          'content-type':'application/json',
        },
        body: JSON.stringify({
          model, max_tokens: maxTokens, system, tools, messages: convo,
        }),
      });

      if(!resp.ok){
        const status = resp.status;
        const text = await resp.text().catch(()=>'');
        // Over the spending cap / out of credit → the "fan is down" message.
        if(status===429 || /credit|billing|spend|quota|limit/i.test(text)){
          logTurn({ question, reply: FAN_DOWN, gateDay: gated.gate,
            showFull: gated.showFull, usedTools, model, turns: messages.length, capped:true });
          return json({ reply: FAN_DOWN, capped:true, gateDay: gated.gate });
        }
        return json({ error:'upstream', status, detail: text.slice(0,300) }, 502);
      }

      const data = await resp.json();
      const blocks = data.content || [];

      if(data.stop_reason === 'tool_use'){
        // record the assistant's tool-use turn verbatim, then answer each tool call
        convo.push({ role:'assistant', content: blocks });
        const toolResults = [];
        for(const b of blocks){
          if(b.type!=='tool_use') continue;
          usedTools.push({ name:b.name, input:b.input });
          let result;
          try { result = runTool(b.name, b.input, gated); }
          catch(e){ result = { error:'tool_failed', detail:String(e&&e.message||e) }; }
          toolResults.push({ type:'tool_result', tool_use_id:b.id, content: JSON.stringify(result) });
        }
        convo.push({ role:'user', content: toolResults });
        continue; // let the model read the tool output and either call more or answer
      }

      // final answer
      const reply = blocks.filter(b=>b.type==='text').map(b=>b.text).join('').trim();
      logTurn({ question, reply, gateDay: gated.gate,
        showFull: gated.showFull, usedTools, model, turns: messages.length, capped:false });
      return json({ reply, gateDay: gated.gate, showFull: gated.showFull, usedTools });
    }
    // exhausted hops without a final answer
    const stuck = "Hmm, I tangled myself up chasing that one down — mind rephrasing? 😅";
    logTurn({ question, reply: stuck, gateDay: gated.gate,
      showFull: gated.showFull, usedTools, model, turns: messages.length, capped:false });
    return json({ reply: stuck, gateDay: gated.gate, usedTools }, 200);
  } catch(e){
    return json({ error:'exception', detail:String(e&&e.message||e) }, 500);
  }
}

// Same-origin GET is a health check + safe metadata. Unauthenticated, so it lists the PUBLIC tool set
// (exactly what an anonymous caller gets) — a clean deploy-verify that the audience split is live.
// Never returns any bout/result data.
export async function onRequestGet(ctx){
  const env = (ctx && ctx.env) || {};
  return json({
    ok:true, service:'gumbai',
    basho: SNAP.meta.basho, maxDay: SNAP.meta.maxDay,
    engine: ENGINE_VERSION,                       // which engine is live
    schema: SNAP.meta.schema,                     // which snapshot schema is live
    audienceSplit: true,
    publicTools: toolsFor('public').map(t=>t.name),   // the reduced public set (proves the split shipped)
    memberToolCount: TOOLS.length,                    // full set size (should be publicTools + 2)
    snapshotHasChampion: !!SNAP.champion,         // true once the snapshot regenerated on a completed basho (no name = no spoiler)
    memberLoggingConfigured: !!(env.GUMBAI_LOG_DB && (env.GUMBAI_LOG_TOKEN || env.NOTION_TOKEN)), // Notion (member) log wired?
    publicLoggingConfigured: !!(env.GUMBAI_AE),   // Analytics Engine (public) log wired?
  });
}
