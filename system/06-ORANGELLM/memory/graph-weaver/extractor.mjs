// graph-weaver/extractor.mjs — entity extractor for the Graph Weaver daemon.
//
// Contract:
//   extractEntities(fluxRecord, opts?) -> Promise<{
//     entities: Array<{ type: string, name: string, attrs: object }>,
//     edges:    Array<{ source_name: string, predicate: string, target_name: string,
//                       // mirrored for downstream consumers that prefer the spec shape:
//                       source: string, target: string }>,
//     raw?:     string,   // model's raw response, for debugging
//     ok:       boolean,  // false if model output failed schema validation
//   }>
//
// Wire:
//   - Calls qwen3:0.6b via Ollama at http://127.0.0.1:11434/api/chat
//   - format: "json", temperature 0, stream off (deterministic, single shot)
//   - System prompt instructs the model to emit ONLY the JSON object
//     { entities: [{type,name,attrs}], edges: [{source,predicate,target}] }.
//
// Ontology (LOCKED per Graph Weaver doctrine):
//   Node types: Sovereign, Project, Mission, Lane, Model, Tool,
//               Service, Host, Receipt, Doctrine
//   Edge preds: PROVES, REQUIRES, BLOCKED_BY, SUPERSEDES, APPROVED_BY, OBSERVED_BY
//
//   For things the model wants but cannot fit, it MUST tag the type with
//   the prefix "Candidate:" (e.g. "Candidate:Person"). The Weaver daemon
//   routes Candidate:* into the ontology_candidates table where they wait
//   for receipt-gated promotion (>=5 distinct Receipt references OR operator
//   `promote-ontology <name>`).
//
// Failure policy:
//   - Network / Ollama errors: throw. The daemon catches and records the error;
//     watermark is NOT advanced so the record is reprocessed on the next tick.
//   - Schema validation failure (bad JSON, wrong shape, no entities array):
//     returns { entities: [], edges: [], raw, ok: false } AND appends a line
//     to the rejection sidecar JSONL. The daemon treats this as a clean
//     "nothing extracted" pass — watermark advances, no graph mutation.
//
// Sidecar:
//   Path defaults to /mnt/ae_flux/logs/graph-weaver-extract-failures.jsonl.
//   Override via opts.failuresLog or env AE_GRAPH_WEAVER_FAILURES_LOG.
//   Directory is created on first write. Sidecar writes are best-effort:
//   they never throw out of extractEntities (otherwise a logging glitch
//   would mask the real extraction outcome).
//
// Idempotency note: the extractor itself is stateless. Idempotency lives
// in the daemon's watermark table; this module just maps record -> JSON.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// constants — locked ontology
// ---------------------------------------------------------------------------

export const NODE_TYPES = Object.freeze([
  'Sovereign', 'Project', 'Mission', 'Lane', 'Model',
  'Tool', 'Service', 'Host', 'Receipt', 'Doctrine',
]);

export const EDGE_PREDICATES = Object.freeze([
  'PROVES', 'REQUIRES', 'BLOCKED_BY',
  'SUPERSEDES', 'APPROVED_BY', 'OBSERVED_BY',
]);

const NODE_TYPE_SET = new Set(NODE_TYPES);
const EDGE_PRED_SET = new Set(EDGE_PREDICATES);

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

const DEFAULT_OLLAMA_HOST = process.env.AE_OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_MODEL       = process.env.AE_GRAPH_WEAVER_CHAT_MODEL || 'qwen3:0.6b';
const DEFAULT_FAILURES    = process.env.AE_GRAPH_WEAVER_FAILURES_LOG
  || '/mnt/ae_flux/logs/graph-weaver-extract-failures.jsonl';
const DEFAULT_TIMEOUT_MS  = Number(process.env.AE_GRAPH_WEAVER_EXTRACT_TIMEOUT_MS || 20000);

// ---------------------------------------------------------------------------
// system prompt
// ---------------------------------------------------------------------------

export const EXTRACTOR_SYSTEM_PROMPT = `You are the AtomEons Graph Weaver entity extractor.

Input: a single flux record JSON object emitted by the AE Cobra reader.
Task: surface concrete, named entities and the relationships between them.
Output: ONE JSON object, no prose, no markdown, no code fences.

Schema (STRICT — these are the only allowed shapes):
{
  "entities": [
    { "type": "<NodeType>", "name": "<canonical-name>", "attrs": { ... } }
  ],
  "edges": [
    { "source": "<entity-name>", "predicate": "<EdgePredicate>", "target": "<entity-name>" }
  ]
}

NodeType MUST be one of:
  Sovereign, Project, Mission, Lane, Model, Tool, Service, Host, Receipt, Doctrine.

EdgePredicate MUST be one of:
  PROVES, REQUIRES, BLOCKED_BY, SUPERSEDES, APPROVED_BY, OBSERVED_BY.

If a clearly named real-world thing does not fit any NodeType, set its type to
"Candidate:<your-proposed-type>" (e.g. "Candidate:Person"). The system will
route it to an ontology-candidates table for receipt-gated promotion; do NOT
force-fit it into an unrelated NodeType.

Same rule for predicates: if the relationship is real but no listed predicate
fits, use "Candidate:<YOUR_PROPOSED_PREDICATE>".

Rules:
- "name" is a canonical short label, not a sentence. Examples: "Atom McCree",
  "Orange3", "qwen3:0.6b", "AECode Manifest", "Cymbal Crash Creed".
- "attrs" is a flat object of small string/number/boolean values; omit if empty.
- Only emit entities the record actually mentions or directly implies.
- Every edge's source and target MUST appear in entities. Do not invent
  dangling endpoints.
- If the record contains nothing concrete, return {"entities":[],"edges":[]}.
- Output JSON ONLY. No explanation. No reasoning text. No <think> tags.`;

// ---------------------------------------------------------------------------
// public entrypoint
// ---------------------------------------------------------------------------

/**
 * Extract entities + edges from a single flux record.
 *
 * @param {object} fluxRecord  — one record from the AE Cobra flux reader.
 * @param {object} [opts]
 * @param {string} [opts.ollamaHost]    — default 127.0.0.1:11434
 * @param {string} [opts.model]         — default qwen3:0.6b
 * @param {string} [opts.failuresLog]   — sidecar JSONL path for parse failures
 * @param {number} [opts.timeoutMs]     — abort after N ms (default 20000)
 * @param {AbortSignal} [opts.signal]   — caller-provided abort
 * @returns {Promise<{entities: object[], edges: object[], raw?: string, ok: boolean}>}
 */
export async function extractEntities(fluxRecord, opts = {}) {
  const ollamaHost  = opts.ollamaHost  || DEFAULT_OLLAMA_HOST;
  const model       = opts.model       || DEFAULT_MODEL;
  const failuresLog = opts.failuresLog || DEFAULT_FAILURES;
  const timeoutMs   = opts.timeoutMs   ?? DEFAULT_TIMEOUT_MS;

  // Compose user message. The record itself is sent as JSON so the model
  // sees lane, ts, hash, payload, etc. Truncation guard: very large
  // payloads are summarized to keep qwen3:0.6b inside its context window.
  const userJson = safeRecordToJson(fluxRecord);

  // Build abort signal combining caller signal + local timeout.
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const to = timeoutMs > 0 ? setTimeout(() => ctl.abort(), timeoutMs) : null;

  let raw;
  try {
    raw = await callOllamaChat({
      host: ollamaHost,
      model,
      system: EXTRACTOR_SYSTEM_PROMPT,
      user: userJson,
      signal: ctl.signal,
    });
  } finally {
    if (to) clearTimeout(to);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }

  // Parse + validate. Any failure here is a SCHEMA failure (not a network
  // failure), so we log to the sidecar and return an empty extraction.
  const parsed = tryParseModelOutput(raw);
  if (!parsed.ok) {
    logFailure(failuresLog, {
      reason: parsed.reason,
      record_hash: fluxRecord?.hash ?? null,
      record_lane: fluxRecord?.lane ?? null,
      record_ts:   fluxRecord?.ts   ?? null,
      model,
      raw_excerpt: typeof raw === 'string' ? raw.slice(0, 2000) : null,
    });
    return { entities: [], edges: [], raw, ok: false };
  }

  return {
    entities: parsed.entities,
    edges:    parsed.edges,
    raw,
    ok:       true,
  };
}

// ---------------------------------------------------------------------------
// HTTP — Ollama /api/chat
// ---------------------------------------------------------------------------

async function callOllamaChat({ host, model, system, user, signal }) {
  const url = `${String(host).replace(/\/+$/, '')}/api/chat`;
  const body = {
    model,
    stream: false,
    format: 'json',
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user   },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ollama chat ${res.status}: ${detail.slice(0, 500)}`);
  }
  const data = await res.json();
  return data?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// parsing + validation
// ---------------------------------------------------------------------------

function tryParseModelOutput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'empty_response' };
  }

  // Some models wrap output in ```json ... ``` or include a <think> block
  // despite the system prompt. Be defensive: strip code fences and pull
  // the outermost {...} block.
  const stripped = stripFencesAndThink(raw);
  const jsonText = extractFirstJsonObject(stripped);
  if (!jsonText) return { ok: false, reason: 'no_json_object_found' };

  let obj;
  try { obj = JSON.parse(jsonText); }
  catch (err) { return { ok: false, reason: `json_parse_error: ${err.message}` }; }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'root_not_object' };
  }
  if (!Array.isArray(obj.entities)) return { ok: false, reason: 'entities_not_array' };
  if (obj.edges !== undefined && !Array.isArray(obj.edges)) {
    return { ok: false, reason: 'edges_not_array' };
  }

  const entities = [];
  for (const e of obj.entities) {
    if (!e || typeof e !== 'object') continue;
    const type = typeof e.type === 'string' ? e.type.trim() : '';
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!type || !name) continue;

    // Accept either a locked type or Candidate:<X>. Daemon will route
    // Candidate:* into ontology_candidates; we pass it through verbatim.
    const isLocked    = NODE_TYPE_SET.has(type);
    const isCandidate = type.startsWith('Candidate:') && type.length > 'Candidate:'.length;
    if (!isLocked && !isCandidate) {
      // Unknown bare type: convert to Candidate so it's tracked rather than dropped.
      entities.push({
        type: `Candidate:${type}`,
        name,
        attrs: sanitizeAttrs(e.attrs),
        proposed_type: type,
      });
      continue;
    }

    const out = {
      type,
      name,
      attrs: sanitizeAttrs(e.attrs),
    };
    if (isCandidate) out.proposed_type = type.slice('Candidate:'.length);
    entities.push(out);
  }

  // Build a name set so we can drop edges whose endpoints are not declared.
  // (The daemon already records dangling edges as candidates, but we filter
  // obvious garbage here so the daemon's candidate table stays signal-rich.)
  const declared = new Set(entities.map((e) => normName(e.name)));

  const edges = [];
  if (Array.isArray(obj.edges)) {
    for (const ed of obj.edges) {
      if (!ed || typeof ed !== 'object') continue;
      // Accept either spec shape {source,target} or daemon shape {source_name,target_name}.
      const sourceName = pickName(ed.source, ed.source_name);
      const targetName = pickName(ed.target, ed.target_name);
      const predicate  = typeof ed.predicate === 'string' ? ed.predicate.trim() : '';
      if (!sourceName || !targetName || !predicate) continue;

      const isLockedPred    = EDGE_PRED_SET.has(predicate);
      const isCandidatePred = predicate.startsWith('Candidate:')
        && predicate.length > 'Candidate:'.length;
      let predOut = predicate;
      if (!isLockedPred && !isCandidatePred) predOut = `Candidate:${predicate}`;

      // Drop edges whose endpoints were never declared as entities.
      if (!declared.has(normName(sourceName)) || !declared.has(normName(targetName))) {
        continue;
      }

      edges.push({
        source_name: sourceName,
        target_name: targetName,
        predicate:   predOut,
        // Mirror under the spec keys so callers using either shape work.
        source: sourceName,
        target: targetName,
      });
    }
  }

  return { ok: true, entities, edges };
}

function pickName(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function normName(s) {
  return String(s || '').trim().toLowerCase();
}

function sanitizeAttrs(attrs) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return {};
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof k !== 'string' || !k.trim()) continue;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      // Cap string length so a chatty attr can't blow up the row.
      out[k] = (t === 'string' && v.length > 512) ? v.slice(0, 512) : v;
    } else if (v === null) {
      out[k] = null;
    }
    // silently drop nested objects/arrays — schema requires flat attrs
  }
  return out;
}

function stripFencesAndThink(raw) {
  let s = String(raw);
  // Remove <think>...</think> blocks (qwen reasoning sometimes leaks through).
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Strip ```json ... ``` or ``` ... ``` fences.
  s = s.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1');
  return s.trim();
}

function extractFirstJsonObject(s) {
  // Find the first balanced {...} substring. Tracks string state so braces
  // inside JSON strings don't break the balance counter.
  const text = String(s);
  let start = -1, depth = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"')  { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (c === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// record -> JSON (with size guard)
// ---------------------------------------------------------------------------

const MAX_RECORD_BYTES = 6000; // qwen3:0.6b has tiny context; keep prompt lean.

function safeRecordToJson(rec) {
  try {
    const full = JSON.stringify(rec);
    if (full.length <= MAX_RECORD_BYTES) return full;
    // Too big: keep top-level scalars + truncate payload-ish fields.
    const trimmed = trimRecord(rec, MAX_RECORD_BYTES);
    return JSON.stringify(trimmed);
  } catch {
    return JSON.stringify({ note: 'record_unserializable' });
  }
}

function trimRecord(rec, budget) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = {};
  // Preserve identity / routing scalars first.
  for (const k of ['ts', 'lane', 'hash', 'kind', 'source']) {
    if (rec[k] !== undefined) out[k] = rec[k];
  }
  // Everything else: serialize and truncate strings to fit.
  let used = JSON.stringify(out).length;
  for (const [k, v] of Object.entries(rec)) {
    if (k in out) continue;
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (typeof s !== 'string') continue;
    const remaining = budget - used - k.length - 8;
    if (remaining <= 64) { out[k] = '<truncated>'; break; }
    if (s.length > remaining) s = s.slice(0, remaining) + '...<truncated>';
    out[k] = (typeof v === 'string') ? s : safeReparse(s);
    used += s.length + k.length + 8;
  }
  return out;
}

function safeReparse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// ---------------------------------------------------------------------------
// sidecar rejection log
// ---------------------------------------------------------------------------

function logFailure(failuresLog, payload) {
  try {
    const dir = path.dirname(failuresLog);
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (err) {
      if (err && err.code !== 'EEXIST') {
        // mkdir failed (e.g. /mnt/ae_flux unavailable on this host).
        // Fall back to a sibling logs/ next to this module so we never
        // silently swallow the rejection.
        const fallback = path.join(
          path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
          'logs',
          'graph-weaver-extract-failures.jsonl',
        );
        try {
          fs.mkdirSync(path.dirname(fallback), { recursive: true });
          fs.appendFileSync(fallback, JSON.stringify({
            ts: new Date().toISOString(),
            note: `primary log unavailable: ${err.code}`,
            ...payload,
          }) + '\n');
        } catch { /* best-effort; never throw */ }
        return;
      }
    }
    fs.appendFileSync(failuresLog, JSON.stringify({
      ts: new Date().toISOString(),
      ...payload,
    }) + '\n');
  } catch { /* sidecar logging is best-effort by design */ }
}

// ---------------------------------------------------------------------------
// internal exports for tests
// ---------------------------------------------------------------------------

export const __test__ = Object.freeze({
  tryParseModelOutput,
  stripFencesAndThink,
  extractFirstJsonObject,
  sanitizeAttrs,
  trimRecord,
  safeRecordToJson,
  NODE_TYPE_SET,
  EDGE_PRED_SET,
});
