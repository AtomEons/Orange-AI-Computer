// flow-direct/caller.mjs — Direct GBNF round-trip client for the Æ Cobra llama.cpp server.
//
// Distinct from `/event` on the Bun Flow Direct server (server.mjs): this is a
// lower-level path that any in-process Orange5 tool can import to:
//   1. Build a prompt + load GBNF grammar text
//   2. POST to llama.cpp /completion with grammar attached
//   3. Parse the response as JSON
//   4. Validate against the AgentTurn JSON Schema (belt-and-suspenders behind the GBNF logit gate)
//   5. On validation failure: retry up to 3 times with exponential backoff (250ms, 500ms, 1000ms + jitter)
//   6. On persistent failure: write a refusal record to the Thought lane (hash-chained), return {ok:false}
//   7. On success: write the validated AgentTurn to the appropriate lane, return {ok:true, record}
//
// This caller is used by:
//   - activation/100-pair-smoke.mjs (JSON validity rate burn-in, gate item #5)
//   - mirage/state-brief.mjs (when synthesizing a merge-lane summary)
//   - any internal Orange5 process that needs a deterministic SSM round-trip without going
//     through the Bun /event route's CLR-K1 filter
//
// Frontier-Isolation Law: LLAMA_URL must be loopback (127.0.0.1 or [::1]). Anything else
// throws synchronously before the first fetch — no plain-HTTP-over-network failure mode.
//
// Mom's Law: every failure path writes a real receipt, never a silent green.

import fs from 'node:fs';
import path from 'node:path';
import { canonicalFluxRoot } from '../paths.mjs';
import { fileURLToPath } from 'node:url';
import { writeFluxRecord } from '../flux/writer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration --------------------------------------------------------

const LLAMA_URL = process.env.AE_COBRA_LLAMA_URL || 'http://127.0.0.1:7418';
const FLUX_ROOT = canonicalFluxRoot();
const GRAMMAR_PATH = process.env.AE_COBRA_GRAMMAR
  || path.resolve(__dirname, '..', 'grammar', 'agent_turn.gbnf');
const SCHEMA_PATH = process.env.AE_COBRA_SCHEMA
  || path.resolve(__dirname, '..', 'schemas', 'agent-turn.schema.json');

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const REQUEST_TIMEOUT_MS = parseInt(process.env.AE_COBRA_HTTP_TIMEOUT_MS || '15000', 10);
const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_MAX_TOKENS = 240;

// --- Loopback guard (Frontier-Isolation Law) ------------------------------

function assertLoopback(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error(`AE_COBRA_LLAMA_URL not a valid URL: ${urlStr}`); }
  const host = u.hostname;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (!isLoopback) {
    throw new Error(`AE-COBRA caller refuses non-loopback target: ${host} (Frontier-Isolation Law)`);
  }
}
assertLoopback(LLAMA_URL);

// --- Grammar + Schema load (cached on first use) --------------------------

let _grammarText = null;
function loadGrammar() {
  if (_grammarText !== null) return _grammarText;
  if (!fs.existsSync(GRAMMAR_PATH)) {
    throw new Error(`GBNF grammar missing at ${GRAMMAR_PATH}`);
  }
  _grammarText = fs.readFileSync(GRAMMAR_PATH, 'utf8');
  if (!_grammarText.includes('root')) {
    throw new Error(`GBNF grammar at ${GRAMMAR_PATH} has no 'root' rule`);
  }
  return _grammarText;
}

let _schema = null;
function loadSchema() {
  if (_schema !== null) return _schema;
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(`AgentTurn schema missing at ${SCHEMA_PATH}`);
  }
  _schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return _schema;
}

// --- Minimal AgentTurn validator (no external deps) -----------------------
// Schema is small and frozen for Night-1; a dep-free validator avoids
// adding ajv to the runtime surface. Returns {ok, errors}.

function validateAgentTurn(obj, schema = loadSchema()) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['root not an object'] };
  }

  const required = schema.required || [];
  for (const key of required) {
    if (!(key in obj)) errors.push(`missing required field: ${key}`);
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) errors.push(`additional property not allowed: ${key}`);
    }
  }

  const props = schema.properties || {};
  for (const [key, def] of Object.entries(props)) {
    if (!(key in obj)) continue;
    const val = obj[key];

    if (def.type === 'string') {
      if (typeof val !== 'string') { errors.push(`${key}: expected string, got ${typeof val}`); continue; }
      if (def.enum && !def.enum.includes(val)) errors.push(`${key}: '${val}' not in enum [${def.enum.join(',')}]`);
      if (def.minLength != null && val.length < def.minLength) errors.push(`${key}: length ${val.length} < minLength ${def.minLength}`);
      if (def.maxLength != null && val.length > def.maxLength) errors.push(`${key}: length ${val.length} > maxLength ${def.maxLength}`);
    } else if (def.type === 'number') {
      if (typeof val !== 'number' || Number.isNaN(val)) { errors.push(`${key}: expected number, got ${typeof val}`); continue; }
      if (def.minimum != null && val < def.minimum) errors.push(`${key}: ${val} < minimum ${def.minimum}`);
      if (def.maximum != null && val > def.maximum) errors.push(`${key}: ${val} > maximum ${def.maximum}`);
    } else if (def.type === 'array') {
      if (!Array.isArray(val)) { errors.push(`${key}: expected array, got ${typeof val}`); continue; }
      if (def.maxItems != null && val.length > def.maxItems) errors.push(`${key}: ${val.length} items > maxItems ${def.maxItems}`);
      if (def.items && def.items.type === 'string') {
        for (let i = 0; i < val.length; i++) {
          if (typeof val[i] !== 'string') errors.push(`${key}[${i}]: expected string, got ${typeof val[i]}`);
          else if (def.items.maxLength != null && val[i].length > def.items.maxLength)
            errors.push(`${key}[${i}]: length ${val[i].length} > maxLength ${def.items.maxLength}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// --- Prompt builder -------------------------------------------------------

function buildPrompt({ event, lane, system }) {
  const systemMsg = system || [
    'You are Æ Cobra, the resident memory daemon of Orange5.',
    `The event below is on the ${lane.toUpperCase()} lane (origin-classified by the caller — DO NOT change the lane).`,
    'Emit ONLY a single AgentTurn JSON object that matches the GBNF grammar exactly.',
    'No prose, no markdown, no roleplay. Cite real files, real commands. Mom\'s Law applies.',
  ].join(' ');

  return [
    '<|im_start|>system',
    systemMsg,
    '<|im_end|>',
    '<|im_start|>user',
    typeof event === 'string' ? event : JSON.stringify(event),
    '<|im_end|>',
    '<|im_start|>assistant',
    '',
  ].join('\n');
}

// --- HTTP call with timeout ----------------------------------------------

async function postCompletion({ prompt, grammar, maxTokens, temperature, signal }) {
  const body = {
    prompt,
    n_predict: maxTokens,
    temperature,
    grammar,            // llama.cpp /completion accepts inline GBNF via `grammar` field
    grammar_lazy: false,
    cache_prompt: false,
    stream: false,
  };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('llama-server request timeout')), REQUEST_TIMEOUT_MS);
  // Chain caller's signal if provided
  if (signal) signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });

  try {
    const res = await fetch(`${LLAMA_URL}/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`llama-server HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return data?.content ?? '';
  } finally {
    clearTimeout(t);
  }
}

// --- Backoff helper -------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function backoffMs(attempt) {
  // attempt is 1-indexed: 1 -> ~250, 2 -> ~500, 3 -> ~1000 (with up to +25% jitter)
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  return Math.floor(base + Math.random() * base * 0.25);
}

// --- Public API -----------------------------------------------------------

/**
 * Call Æ Cobra with GBNF grammar attached. Retry on validation failure.
 * On persistent failure, write a refusal record to the Thought lane.
 *
 * @param {object} args
 * @param {object|string} args.event          Event payload (JSON-serialized into the user turn)
 * @param {string} args.lane                  'reality' | 'thought' | 'merge' (caller decides — origin-classified upstream)
 * @param {string} args.origin                Origin tag for Flux writer (e.g. 'terminal', 'orangellm_reasoning')
 * @param {string} [args.system]              Override system prompt
 * @param {number} [args.maxTokens=240]
 * @param {number} [args.temperature=0.4]
 * @param {string} [args.fluxRoot=FLUX_ROOT]
 * @param {AbortSignal} [args.signal]
 * @param {boolean} [args.writeOnSuccess=true] If false, return validated parse without writing to Flux
 * @returns {Promise<{ok:boolean, accepted:boolean, attempts:number, agent_turn?:object, record?:object, refusal?:object, errors?:string[], raw?:string, ttft_ms?:number}>}
 */
export async function callCobra({
  event,
  lane,
  origin,
  system,
  maxTokens = DEFAULT_MAX_TOKENS,
  temperature = DEFAULT_TEMPERATURE,
  fluxRoot = FLUX_ROOT,
  signal,
  writeOnSuccess = true,
}) {
  if (!event) throw new Error('callCobra: event required');
  if (!lane || !['reality', 'thought', 'merge'].includes(lane)) {
    throw new Error(`callCobra: invalid lane '${lane}'`);
  }
  if (!origin) throw new Error('callCobra: origin required');

  const grammar = loadGrammar();
  const prompt = buildPrompt({ event, lane, system });

  const failures = [];
  const t0 = Date.now();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw = '';
    try {
      raw = await postCompletion({ prompt, grammar, maxTokens, temperature, signal });
    } catch (e) {
      failures.push({ attempt, stage: 'http', error: e.message });
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt));
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      failures.push({ attempt, stage: 'parse', error: e.message, raw_head: raw.slice(0, 200) });
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt));
      continue;
    }

    const verdict = validateAgentTurn(parsed);
    if (!verdict.ok) {
      failures.push({ attempt, stage: 'schema', errors: verdict.errors });
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt));
      continue;
    }

    // Caller is authoritative on lane (origin-classified upstream).
    // The model's emitted lane is overridden — see Night-1 V1 mitigation.
    parsed.lane = lane;

    const ttft_ms = Date.now() - t0;

    if (!writeOnSuccess) {
      return { ok: true, accepted: true, attempts: attempt, agent_turn: parsed, raw, ttft_ms };
    }

    const record = await writeFluxRecord({
      lane,
      origin,
      kind: parsed.event_type,
      body: parsed,
      fluxRoot,
    });

    return { ok: true, accepted: true, attempts: attempt, agent_turn: parsed, record, ttft_ms };
  }

  // All attempts exhausted → write refusal to Thought lane.
  const refusal = await writeFluxRecord({
    lane: 'thought',
    origin: 'ae_cobra_caller_refuse',
    kind: 'error',
    body: {
      reason: 'persistent_validation_failure',
      attempts: MAX_ATTEMPTS,
      caller_lane: lane,
      caller_origin: origin,
      raw_event: event,
      failures,
    },
    fluxRoot,
  });

  return {
    ok: false,
    accepted: false,
    attempts: MAX_ATTEMPTS,
    refusal,
    errors: failures,
    ttft_ms: Date.now() - t0,
  };
}

// Named secondary exports for tooling and tests
export { validateAgentTurn, buildPrompt, loadGrammar, loadSchema, assertLoopback };

// --- CLI entrypoint -------------------------------------------------------
// Allows: `bun flow-direct/caller.mjs '{"stdout":"npm test 7/7"}' terminal reality`
// Useful for the activation gate's 100-pair smoke runner.

if (import.meta.main) {
  const [eventArg, origin = 'operator', lane = 'reality'] = process.argv.slice(2);
  if (!eventArg) {
    console.error('usage: bun caller.mjs <event-json> [origin] [lane]');
    process.exit(2);
  }
  let event;
  try { event = JSON.parse(eventArg); } catch { event = { text: eventArg }; }

  callCobra({ event, lane, origin })
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch(err => {
      console.error(`[AE-COBRA caller] fatal: ${err.message}`);
      process.exit(3);
    });
}
