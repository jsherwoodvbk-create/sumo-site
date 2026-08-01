// functions/api/gumbai.js — Cloudflare Pages Function. Route: POST /api/gumbai
//
// Flow: receive {messages, day, showFull} → gate the snapshot to that day (spoiler
// safety happens HERE, in data, before the model sees anything) → run Claude with the
// four scoped tools in a short agent loop → return the grounded, in-voice answer.
//
// Secrets/config (set in Cloudflare Pages → Settings → Environment variables):
//   ANTHROPIC_API_KEY   (required, encrypted)  — from console.anthropic.com
//   GUMBAI_MODEL        (optional)             — model slug; defaults below. Confirm the
//                                                exact Opus 4.8 slug in your console.
//   GUMBAI_LOG_DB       (optional)             — Notion database id for the interaction log.
//   GUMBAI_LOG_TOKEN    (optional)             — Notion integration token (falls back to NOTION_TOKEN).
//                        Logging is OFF until BOTH a db id and a token are present, so the
//                        oracle runs fine with these unset.
//
// The monthly HARD cap is the spending limit you set in the Anthropic console — that's
// the real stop. When the account is over limit the API errors, and we surface the
// crew-friendly "fan is down" message instead of a stack trace.

import SNAP from './_snapshot.js';
import { gateSnapshot, buildSystemPrompt, TOOLS, runTool } from './_engine.js';

const MODEL_DEFAULT = 'claude-opus-4-8';   // confirm exact slug in the Anthropic console
const MAX_TOOL_HOPS = 6;                    // safety bound on the agent loop
const MAX_MESSAGES  = 40;                   // conversational memory window we accept
const MAX_CHARS     = 4000;                 // per user message (abuse guard)

const FAN_DOWN =
  "🪭 Gumbai's fan is down for the month — no tachiai till the calendar flips. " +
  "*(We've hit this month's question budget; he's back next month.)*";

const json = (obj, status=200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
});

// ── interaction logging ──────────────────────────────────────────────────────
// One row per turn to the Notion "Gumbai Interaction Log", fire-and-forget via waitUntil:
// the user's reply returns FIRST, then this runs; a Notion hiccup can never slow or break
// Gumbai. No-op unless both GUMBAI_LOG_DB and a token are configured.
const NOTION_TXT = 1900;   // stay under Notion's 2000-char-per-rich-text limit

function classifyAnswer(capped, usedTools, reply){
  if(capped) return 'capped';
  if(!usedTools || !usedTools.length) return 'no tool call';
  if(/\b(don'?t|do not|didn'?t) have\b|not in our data|outside what we track|can'?t (confirm|call|total)/i.test(reply||''))
    return 'deflected — no data';
  return 'tool-grounded';
}

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

  // ── gate BEFORE the model sees anything ───────────────────────────────────
  const gated = gateSnapshot(SNAP, day, showFull);
  const system = [
    { type:'text', text: buildSystemPrompt(gated), cache_control:{ type:'ephemeral' } } // prompt caching = cheaper repeats
  ];
  const model = (env.GUMBAI_MODEL || MODEL_DEFAULT);

  // ── agent loop ────────────────────────────────────────────────────────────
  const convo = messages.slice();       // Claude-format message list we grow with tool turns
  const usedTools = [];
  try {
    for(let hop=0; hop<MAX_TOOL_HOPS; hop++){
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version':'2023-06-01',
          'content-type':'application/json',
        },
        body: JSON.stringify({
          model, max_tokens: 1024, system, tools: TOOLS, messages: convo,
        }),
      });

      if(!resp.ok){
        const status = resp.status;
        const text = await resp.text().catch(()=>'');
        // Over the spending cap / out of credit → the "fan is down" message.
        if(status===429 || /credit|billing|spend|quota|limit/i.test(text)){
          ctx.waitUntil(logInteraction(env, { question, reply: FAN_DOWN, gateDay: gated.gate,
            showFull: gated.showFull, usedTools, model, turns: messages.length, capped:true }));
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
      ctx.waitUntil(logInteraction(env, { question, reply, gateDay: gated.gate,
        showFull: gated.showFull, usedTools, model, turns: messages.length, capped:false }));
      return json({ reply, gateDay: gated.gate, showFull: gated.showFull, usedTools });
    }
    // exhausted hops without a final answer
    const stuck = "Hmm, I tangled myself up chasing that one down — mind rephrasing? 😅";
    ctx.waitUntil(logInteraction(env, { question, reply: stuck, gateDay: gated.gate,
      showFull: gated.showFull, usedTools, model, turns: messages.length, capped:false }));
    return json({ reply: stuck, gateDay: gated.gate, usedTools }, 200);
  } catch(e){
    return json({ error:'exception', detail:String(e&&e.message||e) }, 500);
  }
}

// Same-origin GET is a health check + safe metadata (basho label and how many days
// have been logged — maxDay is already shown publicly on the homepage badge, so it's
// not a spoiler). Never returns any bout/result data.
export async function onRequestGet(){
  return json({ ok:true, service:'gumbai', basho: SNAP.meta.basho, maxDay: SNAP.meta.maxDay });
}
