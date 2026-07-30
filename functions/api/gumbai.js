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

export async function onRequestPost({ request, env }){
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
        if(status===429 || /credit|billing|spend|quota|limit/i.test(text))
          return json({ reply: FAN_DOWN, capped:true, gateDay: gated.gate });
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
      return json({ reply, gateDay: gated.gate, showFull: gated.showFull, usedTools });
    }
    // exhausted hops without a final answer
    return json({ reply: "Hmm, I tangled myself up chasing that one down — mind rephrasing? 😅", gateDay: gated.gate, usedTools }, 200);
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
