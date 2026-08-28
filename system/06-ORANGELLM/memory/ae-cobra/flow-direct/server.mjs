// flow-direct/server.mjs — Bun HTTP server on 127.0.0.1:7419.
// Wraps llama.cpp (mlock-pinned, GBNF-locked) + Flux JSONL ledgers + Mirage Recall API.
//
// Routes:
//   GET  /healthz                 — daemon + upstream state + per-lane counts
//   POST /event                   — accept event, classify lane (origin-based!), call SSM, CLR-K1, write Flux
//   POST /state-brief             — Mirage Recall API
//   POST /shutdown                — graceful flush
//
// Loopback-bound only. Frontier-Isolation Law: never reachable from outside the daemon host.

import { homedir } from 'node:os';
import { canonicalFluxRoot } from '../paths.mjs';
import { join } from 'node:path';
import { writeFluxRecord, verifyChain } from '../flux/writer.mjs';
import { readFlux, countEvents } from '../flux/reader.mjs';
import { verifyAgentTurnK1 } from '../clr/verifier-k1.mjs';
import { computeStateBrief } from '../mirage/state-brief.mjs';
import { mergeSemanticMemory, querySemanticMemory, upsertSemanticRecords } from '../semantic-index.mjs';

const LEGACY_LLAMA_URL = process.env.AE_COBRA_LLAMA_URL || null;
const ORANGEBRAIN_URL = process.env.AE_COBRA_ORANGEBRAIN_URL || 'http://127.0.0.1:1337';
const ORANGEBRAIN_MODEL = process.env.AE_COBRA_MODEL || 'orange-navigator';
const PROCESSOR_URL = LEGACY_LLAMA_URL || ORANGEBRAIN_URL;
const PROCESSOR_KIND = LEGACY_LLAMA_URL ? 'llama.cpp' : 'orangebrain';
const FLUX_ROOT = canonicalFluxRoot();
const PORT = parseInt(process.env.AE_COBRA_BUN_PORT || '7419', 10);
const LLAMA_PID = process.env.AE_COBRA_LLAMA_PID || null;
const VERSION = 'ae-cobra.v0.2.0-orangebrain';
const LIVE_RETRIEVAL_MODE = ['lexical', 'dense', 'hybrid'].includes(process.env.AE_COBRA_LIVE_RETRIEVAL_MODE)
  ? process.env.AE_COBRA_LIVE_RETRIEVAL_MODE
  : 'lexical';

// Origin → lane discriminator (V1 mitigation: origin-based, NOT string-match)
const ORIGIN_LANE = {
  terminal: 'reality',
  hermes: 'reality',
  mirage_data: 'reality',
  orangeeye: 'reality',
  compiler: 'reality',
  operator: 'reality',
  orangellm_reasoning: 'thought',
  orangellm_rejected: 'thought',
  strategy: 'thought',
  pivot: 'thought',
  merge_synthesis: 'merge',
};

function classifyLane({ origin, fallback }) {
  if (origin in ORIGIN_LANE) return ORIGIN_LANE[origin];
  if (fallback === 'reality' || fallback === 'thought' || fallback === 'merge') return fallback;
  return 'thought'; // safe default: unknown origin lands in Thought, never Reality
}

async function callProcessor({ prompt, maxTokens = 240, temperature = 0.1 }) {
  if (!LEGACY_LLAMA_URL) {
    const res = await fetch(`${ORANGEBRAIN_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ORANGEBRAIN_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are AE Cobra, the OrangeFive memory compiler. Return only the requested AgentTurn JSON object. Never add markdown or commentary.',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        reasoning_effort: 'none',
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`OrangeBrain HTTP ${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  }

  const res = await fetch(`${LEGACY_LLAMA_URL}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      n_predict: maxTokens,
      temperature,
      grammar_lazy: false,
      cache_prompt: false,
    }),
  });
  if (!res.ok) throw new Error(`llama-server HTTP ${res.status}`);
  const data = await res.json();
  return data?.content || '';
}

function buildPrompt({ event, lane }) {
  return [
    '<|im_start|>system',
    'You are Æ Cobra, the memory daemon of Orange5. Emit ONLY a single AgentTurn JSON object matching the GBNF grammar.',
    `The event below is on the ${lane.toUpperCase()} lane (origin-classified by the caller — DO NOT change the lane).`,
    'Be concise. Cite real files, real commands. No fluff. Mom\'s Law applies.',
    '<|im_end|>',
    '<|im_start|>user',
    JSON.stringify(event),
    '<|im_end|>',
    '<|im_start|>assistant',
  ].join('\n');
}

function compileRealityTurn(event) {
  const eventTypes = new Set(['observation', 'decision', 'error', 'checkpoint', 'recall', 'receipt', 'risk']);
  const risks = new Set(['low', 'medium', 'high']);
  const evidenceEntities = event?.evidence && typeof event.evidence === 'object'
    ? Object.values(event.evidence).filter((value) => typeof value === 'string')
    : [];
  return {
    lane: 'reality',
    event_type: eventTypes.has(event?.event_type) ? event.event_type : 'observation',
    summary: String(event?.summary || 'Verified runtime event').slice(0, 240),
    entities: [...(Array.isArray(event?.entities) ? event.entities : []), ...evidenceEntities]
      .map(String).slice(0, 20),
    files: (Array.isArray(event?.files) ? event.files : []).map(String).slice(0, 20),
    commands: (Array.isArray(event?.commands) ? event.commands : []).map(String).slice(0, 20),
    risk: risks.has(event?.risk) ? event.risk : 'low',
    next_action: String(event?.next_action || 'No action required.').slice(0, 240),
    confidence: typeof event?.confidence === 'number'
      ? Math.max(0, Math.min(1, event.confidence))
      : 1,
  };
}

function normalizeProcessedTurn(parsed, event, lane) {
  const candidate = parsed && typeof parsed === 'object' ? parsed : {};
  const eventTypes = new Set(['observation', 'decision', 'error', 'checkpoint', 'recall', 'receipt', 'risk']);
  const risks = new Set(['low', 'medium', 'high']);
  const sourceSummary = event?.summary || event?.reasoning || event?.text || event?.message;
  return {
    lane,
    event_type: eventTypes.has(candidate.event_type) ? candidate.event_type : 'observation',
    summary: String(candidate.summary || sourceSummary || 'Recorded reasoning event').slice(0, 240),
    entities: (Array.isArray(candidate.entities) ? candidate.entities : (event?.entities || []))
      .map(String).slice(0, 20),
    files: (Array.isArray(candidate.files) ? candidate.files : (event?.files || []))
      .map(String).slice(0, 20),
    commands: (Array.isArray(candidate.commands) ? candidate.commands : (event?.commands || []))
      .map(String).slice(0, 20),
    risk: risks.has(candidate.risk) ? candidate.risk : (risks.has(event?.risk) ? event.risk : 'low'),
    next_action: String(candidate.next_action || event?.next_action || 'Review when relevant.').slice(0, 240),
    confidence: typeof candidate.confidence === 'number'
      ? Math.max(0, Math.min(1, candidate.confidence))
      : (typeof event?.confidence === 'number' ? Math.max(0, Math.min(1, event.confidence)) : 0.7),
  };
}

function vmStats() {
  try {
    const fs = require('node:fs');
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const grab = key => {
      const m = status.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    return { vmlock_bytes: grab('VmLck'), vmswap_bytes: grab('VmSwap'), vmrss_bytes: grab('VmRSS') };
  } catch { return { vmlock_bytes: 0, vmswap_bytes: 0, vmrss_bytes: 0 }; }
}

async function processorHealth() {
  try {
    // OrangeBrain /healthz includes memory health, which points back to Cobra.
    // Probe model discovery instead so health cannot recurse across the two
    // services while still proving the configured processor is responsive.
    const path = LEGACY_LLAMA_URL ? '/health' : '/livez';
    const res = await fetch(`${PROCESSOR_URL}${path}`, { signal: AbortSignal.timeout(3000) });
    return { live: res.ok, status: res.status, kind: PROCESSOR_KIND, url: PROCESSOR_URL, model: LEGACY_LLAMA_URL ? null : ORANGEBRAIN_MODEL };
  } catch (e) { return { live: false, error: e.message }; }
}

Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  idleTimeout: 180,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET /healthz
    if (path === '/healthz' && req.method === 'GET') {
      const processor = await processorHealth();
      const counts = countEvents({ fluxRoot: FLUX_ROOT });
      const vm = vmStats();
      const body = {
        status: processor.live ? 'ok' : 'degraded',
        service: 'ae-cobra',
        version: VERSION,
        boundary: 'gbnf_active',
        upstream: {
          processor,
          mamba: LEGACY_LLAMA_URL ? processor : { live: false, configured: false, optional: true },
          flux_writer: { live: true, root: FLUX_ROOT },
        },
        lanes: counts,
        ...vm,
        llama_pid: LLAMA_PID,
        generated_at: new Date().toISOString(),
      };
      return Response.json(body);
    }

    // POST /event
    if (path === '/event' && req.method === 'POST') {
      server.timeout(req, 180);
      let body;
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
      const { origin, fallback_lane, event } = body;
      if (!origin) return Response.json({ ok: false, error: 'origin required' }, { status: 400 });
      if (!event) return Response.json({ ok: false, error: 'event required' }, { status: 400 });
      const lane = classifyLane({ origin, fallback: fallback_lane });

      let ssm_output, parsed, verifier;
      try {
        if (lane === 'reality') {
          parsed = compileRealityTurn(event);
        } else {
          ssm_output = await callProcessor({ prompt: buildPrompt({ event, lane }) });
          parsed = normalizeProcessedTurn(JSON.parse(ssm_output), event, lane);
        }
        verifier = verifyAgentTurnK1(parsed);
      } catch (e) {
        // Write rejection to Thought lane
        const rejection = await writeFluxRecord({
          lane: 'thought',
          origin: 'ae_cobra_reject',
          kind: 'error',
          body: { reason: 'ssm_parse_fail', error: e.message, raw_origin: origin, raw_event: event, ssm_output: ssm_output?.slice(0, 500) },
          fluxRoot: FLUX_ROOT,
        });
        return Response.json({ ok: false, accepted: false, reason: 'ssm_parse_fail', error: e.message, rejection_id: rejection.hash.slice(0,12) }, { status: 200 });
      }

      if (!verifier.accepted) {
        const rejection = await writeFluxRecord({
          lane: 'thought',
          origin: 'ae_cobra_reject',
          kind: 'risk',
          body: { reason: 'clr_k1_below_threshold', score: verifier.score, verifier_reasons: verifier.reasons, candidate: parsed },
          fluxRoot: FLUX_ROOT,
        });
        return Response.json({ ok: true, accepted: false, score: verifier.score, reasons: verifier.reasons, rejection_id: rejection.hash.slice(0,12) });
      }

      // Override lane in the parsed AgentTurn with origin-classified lane (model cannot change lane)
      parsed.lane = lane;
      const written = await writeFluxRecord({
        lane,
        origin,
        kind: parsed.event_type,
        body: parsed,
        fluxRoot: FLUX_ROOT,
      });
      let semantic_indexed = false;
      let semantic_warning = null;
      try {
        const indexed = await upsertSemanticRecords([written]);
        semantic_indexed = indexed.indexed === 1;
      } catch (error) {
        semantic_warning = error.message;
      }
      return Response.json({ ok: true, accepted: true, score: verifier.score, id: written.hash.slice(0,12), lane, agent_turn: parsed, semantic_indexed, semantic_warning });
    }

    // POST /state-brief
    if (path === '/state-brief' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
      let brief = computeStateBrief({
        fluxRoot: FLUX_ROOT,
        query: body.query || '',
        timeRangeMs: body.time_range_ms || 86_400_000 * 7,
        maxRecords: body.max_records || 50,
        includeConflicts: body.include_conflicts !== false,
      });
      if (body.query && process.env.AE_COBRA_SEMANTIC_ENABLED !== '0') {
        try {
          const requestedMode = ['lexical', 'dense', 'hybrid'].includes(body.retrieval_mode)
            ? body.retrieval_mode
            : LIVE_RETRIEVAL_MODE;
          const semantic = await querySemanticMemory(body.query, {
            limit: Math.min(24, body.max_records || 50),
            mode: requestedMode,
          });
          brief = mergeSemanticMemory(brief, semantic, body.max_records || 50);
        } catch (error) {
          brief.retrieval = { ...(brief.retrieval || {}), semantic: { active: false, warning: error.message } };
        }
      }
      return Response.json(brief);
    }

    // POST /verify-chain
    if (path === '/verify-chain' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { body = {}; }
      const lane = body.lane || 'reality';
      const result = verifyChain({ lane, fluxRoot: FLUX_ROOT });
      return Response.json({ lane, ...result });
    }

    // POST /shutdown
    if (path === '/shutdown' && req.method === 'POST') {
      setTimeout(() => process.exit(0), 100);
      return Response.json({ ok: true, message: 'shutting down' });
    }

    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
  error(err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  },
});

console.log(`[AE-COBRA] Flow Direct on 127.0.0.1:${PORT} (${VERSION})`);
console.log(`[AE-COBRA] upstream processor: ${PROCESSOR_KIND} ${PROCESSOR_URL}`);
console.log(`[AE-COBRA] flux root: ${FLUX_ROOT}`);
console.log(`[AE-COBRA] origin-based lane classifier active (V1 mitigation)`);
