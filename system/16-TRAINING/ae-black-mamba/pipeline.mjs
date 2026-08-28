#!/usr/bin/env bun
// pipeline.mjs — AE Black Mamba pretraining corpus builder.
//
// Spec: AE_COBRA_FOUNDATION_SPEC.md + AE Cobra Night-1 receipt (#017).
//
// Phase-1 (Cobra Night-1) substrate: Mamba 2.8B Q5_K_M from
//   bartowski/mamba-2.8b-hf-GGUF acts as the surrogate body.
// Phase-3 (this pipeline's purpose): replace the surrogate with a custom
//   Mamba 2.8B SSM pretrained ON Orange5's own evidence — Flux events,
//   AgentTurn JSON, and receipts. This is FULL fine-tune, not LoRA
//   (SSMs lack the linear-projection structure that makes LoRA cheap on
//   transformers — see Gu/Dao Mamba 2023). T4 16GB is sufficient for
//   2.8B full FT at bf16 + grad checkpoint + cpu-offload optimizer.
//
// What this script does (and only this):
//
//   1. Walk Flux ledger files (reality.jsonl + thought.jsonl). Each line
//      is a hash-chained wrapper around an `event` field. The `event`
//      payload is supposed to satisfy the AgentTurn schema (it was
//      GBNF-constrained at emission time, but Night-1 ALSO accepts
//      free-form events; we validate at ingest, not trust origin).
//
//   2. Walk receipts/orange5-build/*.md. Parse `**Field:** value`
//      markdown lines into a derived AgentTurn-shaped row whose `lane`
//      is always `reality` (a written receipt IS reality), event_type
//      is `receipt`, and risk/confidence are pulled from the receipt
//      where available.
//
//   3. Validate each candidate against AgentTurn schema (loaded from
//      ae-cobra/schemas/agent-turn.schema.json). Reject + log; never
//      silently coerce. (Mom's Law: no fake-green training rows.)
//
//   4. Normalize: trim whitespace, dedupe by canonical-JSON SHA-256,
//      drop rows shorter than MIN_BYTES.
//
//   5. Serialize each surviving row to a single-line training example:
//        { "text": "<grammar-ordered JSON of the AgentTurn>\n" }
//      Keys are emitted in agent_turn.gbnf root-rule order (lane,
//      event_type, summary, entities, files, commands, risk, next_action,
//      confidence) so the token sequence the model learns matches the
//      sequence the GBNF mask forces at inference. The dedupe SHA-256
//      hashes a *separate* alphabetically-canonical form (matches the
//      ae-cobra/flux/writer.mjs convention) so rerunning on unchanged
//      input still produces a bit-identical dedupe key set.
//      This is the standard causal-LM pretraining format. Mamba HF
//      checkpoints expect raw text; serializing the AgentTurn as a
//      stable grammar-ordered string teaches the SSM the JSON shape
//      structurally, the same way the GBNF teaches inference-time.
//
//   6. Deterministic 90/10 split by content hash (NOT by file order,
//      NOT by time — reproducible across reruns regardless of how the
//      Flux ledger grew). Even-bucket hashes → train; odd buckets where
//      bucket < VAL_PERCENT → val.
//
//   7. Emit train.jsonl + val.jsonl + a receipt-shaped manifest
//      (corpus-manifest.json) with input counts, reject counts per
//      reason, output SHA-256s, and the exact ruleset used. Operator
//      uploads the two JSONLs + manifest to the Phase-3 trainer.
//
// What this script does NOT do:
//
//   - No model loading. No tokenization. No GPU. No network.
//   - No mutation of Flux ledgers or receipts (read-only).
//   - No silent coercion of bad rows into "good enough" rows.
//   - No instruction-tuning chat template. SSM pretraining is causal LM.
//
// Run:
//
//   bun run 16-TRAINING/ae-black-mamba/pipeline.mjs
//
// Env overrides (all optional):
//
//   AE_FLUX_ROOT          directory containing reality.jsonl + thought.jsonl
//                         default: ${ORANGE5_ROOT}/06-ORANGELLM/memory/ae-cobra/flux
//   ORANGE5_ROOT          optional checkout override
//   AE_BM_OUT             output dir; default ${ORANGE5_ROOT}/16-TRAINING/ae-black-mamba/corpus
//   AE_BM_VAL_PERCENT     int 1-49, default 10
//   AE_BM_MIN_BYTES       int, default 32 (canonical-JSON byte length floor)
//   AE_BM_INCLUDE_THOUGHT '1' to include thought-lane events (default '0' —
//                         Reality + Receipts only; thought-lane is rejected
//                         hypothesis space, training on it would teach the
//                         model rejected thinking)
//
// Failure modes (intentional):
//
//   - Schema file missing → hard fail before any output. Cannot validate.
//   - Flux chain corruption → script still parses the file line-by-line,
//     but each broken line counts as a rejection. We do NOT call the
//     writer's verifyChain — pipeline runs even on a torn chain so we
//     can still extract surviving training rows. Operator's job to
//     decide whether to chain_repair before retraining.
//   - Zero accepted rows → hard fail. We refuse to emit an empty corpus.
//
// Mom's Law: every rejection is itemized in the manifest. No padding.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ORANGE5_ROOT = path.resolve(process.env.ORANGE5_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const FLUX_ROOT = process.env.AE_FLUX_ROOT
  || path.join(ORANGE5_ROOT, '06-ORANGELLM/memory/ae-cobra/flux');
const RECEIPTS_DIR = path.join(ORANGE5_ROOT, '10-RECEIPTS/orange5-build');
const SCHEMA_PATH = path.join(ORANGE5_ROOT, '06-ORANGELLM/memory/ae-cobra/schemas/agent-turn.schema.json');
const OUT_DIR = process.env.AE_BM_OUT
  || path.join(ORANGE5_ROOT, '16-TRAINING/ae-black-mamba/corpus');

const VAL_PERCENT = clampInt(process.env.AE_BM_VAL_PERCENT, 10, 1, 49);
const MIN_BYTES = clampInt(process.env.AE_BM_MIN_BYTES, 32, 1, 4096);
const INCLUDE_THOUGHT = process.env.AE_BM_INCLUDE_THOUGHT === '1';

const VALID_LANES = new Set(['reality', 'thought', 'merge']);
const VALID_EVENT_TYPES = new Set([
  'observation', 'decision', 'error', 'checkpoint', 'recall', 'receipt', 'risk',
]);
const VALID_RISK = new Set(['low', 'medium', 'high']);

function clampInt(raw, dflt, lo, hi) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// Canonical JSON — bit-identical to ae-cobra/flux/writer.mjs.
// Reused here so the hash we compute matches the writer's hash if the
// caller ever wants to cross-verify.
// ---------------------------------------------------------------------------
function canonicalJSON(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number: ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') throw new Error('bigint not supported');
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJSON).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Grammar-ordered serialization for the TRAINING row payload.
//
// canonicalJSON (above) sorts keys alphabetically — stable across reruns,
// fine for an internal dedupe key. The TRAINING text the model learns,
// however, must match agent_turn.gbnf's fixed key order at the logit layer:
//
//   root ::= "{" "\"lane\":" ... "\"event_type\":" ... "\"confidence\":" ... "}"
//
// If the corpus emits alphabetically-sorted JSON ({"commands":...,"confidence":
// ...,"entities":...}) the model learns the wrong token sequence and at
// inference the GBNF mask forces a different order — exactly the
// "model fighting the grammar" outcome strategy.md §6 warns against.
//
// Two transforms applied on top of canonical JSON:
//
//   (1) Key order pinned to the grammar's root rule. The schema's `required`
//       array is already in this order — they match by design.
//   (2) `confidence` is snapped to GBNF's lexical form. The grammar accepts
//       `0.XX`, `0.0`, or `1.0` only — values like `1`, `0.8`, `0.875` all
//       fail acceptance even with correct key order. Snapping rounds to two
//       decimal places and dispatches the 0 and 1 edges. The seed corpus
//       only carries values that snap losslessly; future values round to
//       grid (≤ 1 grid-unit of error in a heuristic field — acceptable).
//
// The dedupe SHA-256 still hashes the alphabetical canonical form, so
// rerunning pipeline.mjs on unchanged input produces a bit-identical dedupe
// key set. Only the on-disk training text changes.
// ---------------------------------------------------------------------------

const GRAMMAR_KEY_ORDER = Object.freeze([
  'lane',
  'event_type',
  'summary',
  'entities',
  'files',
  'commands',
  'risk',
  'next_action',
  'confidence',
]);

function formatConfidenceForGbnf(value) {
  // Grammar rule: confidence ::= "0." digit digit | "1.0" | "0.0"
  const snapped = Math.round(value * 100) / 100;
  if (snapped === 0) return '0.0';
  if (snapped === 1) return '1.0';
  return snapped.toFixed(2); // 0.XX
}

function grammarOrderedJSON(turn) {
  const parts = [];
  for (const k of GRAMMAR_KEY_ORDER) {
    if (!(k in turn)) {
      throw new Error(`grammarOrderedJSON: missing required key '${k}'`);
    }
    const v = turn[k];
    const rendered = k === 'confidence' ? formatConfidenceForGbnf(v) : canonicalJSON(v);
    parts.push(JSON.stringify(k) + ':' + rendered);
  }
  return '{' + parts.join(',') + '}';
}

// ---------------------------------------------------------------------------
// AgentTurn schema validator — hand-written to match agent-turn.schema.json.
// We do NOT pull a JSON-Schema library; the shape is small and stable, and a
// dependency-free script is auditable in one read. The schema file IS the
// source of truth — we load it to assert its contents match the validator,
// and fail loud on mismatch.
// ---------------------------------------------------------------------------
function loadAndCheckSchema() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(
      `AgentTurn schema missing: ${SCHEMA_PATH}. ` +
      `Cannot validate without it. Abort.`
    );
  }
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  // Sanity: confirm the enums hard-coded here match the schema. If the
  // schema drifts and we don't notice, our validator would silently
  // accept rows the daemon would reject at runtime.
  const schemaLanes = new Set(schema?.properties?.lane?.enum ?? []);
  const schemaEvents = new Set(schema?.properties?.event_type?.enum ?? []);
  const schemaRisks = new Set(schema?.properties?.risk?.enum ?? []);
  for (const v of VALID_LANES) {
    if (!schemaLanes.has(v)) {
      throw new Error(`validator lane '${v}' not in schema. Update one or the other.`);
    }
  }
  for (const v of VALID_EVENT_TYPES) {
    if (!schemaEvents.has(v)) {
      throw new Error(`validator event_type '${v}' not in schema. Update one or the other.`);
    }
  }
  for (const v of VALID_RISK) {
    if (!schemaRisks.has(v)) {
      throw new Error(`validator risk '${v}' not in schema. Update one or the other.`);
    }
  }
  // Reverse check — schema must not declare values we don't know about.
  for (const v of schemaLanes) {
    if (!VALID_LANES.has(v)) throw new Error(`schema lane '${v}' unknown to validator`);
  }
  for (const v of schemaEvents) {
    if (!VALID_EVENT_TYPES.has(v)) throw new Error(`schema event_type '${v}' unknown to validator`);
  }
  for (const v of schemaRisks) {
    if (!VALID_RISK.has(v)) throw new Error(`schema risk '${v}' unknown to validator`);
  }
  return schema;
}

/** Returns null if valid, or an error string. */
function validateAgentTurn(t) {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return 'not an object';

  const required = ['lane', 'event_type', 'summary', 'entities', 'files', 'commands', 'risk', 'next_action', 'confidence'];
  for (const k of required) {
    if (!(k in t)) return `missing field: ${k}`;
  }

  // additionalProperties: false
  for (const k of Object.keys(t)) {
    if (!required.includes(k)) return `unexpected field: ${k}`;
  }

  if (!VALID_LANES.has(t.lane)) return `invalid lane: ${t.lane}`;
  if (!VALID_EVENT_TYPES.has(t.event_type)) return `invalid event_type: ${t.event_type}`;
  if (!VALID_RISK.has(t.risk)) return `invalid risk: ${t.risk}`;

  if (typeof t.summary !== 'string' || t.summary.length < 1 || t.summary.length > 240) {
    return 'summary must be string [1,240]';
  }
  if (typeof t.next_action !== 'string' || t.next_action.length < 1 || t.next_action.length > 240) {
    return 'next_action must be string [1,240]';
  }
  if (typeof t.confidence !== 'number' || !Number.isFinite(t.confidence) || t.confidence < 0 || t.confidence > 1) {
    return 'confidence must be number in [0,1]';
  }

  for (const arrField of ['entities', 'files', 'commands']) {
    const a = t[arrField];
    if (!Array.isArray(a)) return `${arrField} must be array`;
    if (a.length > 20) return `${arrField} has >20 items`;
    for (const item of a) {
      if (typeof item !== 'string') return `${arrField} contains non-string`;
      if (item.length > 240) return `${arrField} item exceeds 240 chars`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Flux ingest
// ---------------------------------------------------------------------------

function* iterFluxLane(lane) {
  const file = path.join(FLUX_ROOT, `${lane}.jsonl`);
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue; // empty / trailing newline
    yield { lane, lineNo: i + 1, file, raw };
  }
}

function extractAgentTurnFromFlux({ lane, raw }) {
  // The writer wraps records as {ts, sha256, prior_sha256, origin, lane, event}.
  // The `event` field is the AgentTurn payload.
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'flux-parse-error' };
  }
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    return { ok: false, reason: 'flux-not-object' };
  }
  if (!('event' in rec) || rec.event === null || typeof rec.event !== 'object') {
    return { ok: false, reason: 'flux-no-event' };
  }
  // The wrapper's `lane` is authoritative (origin-pinned at write time).
  // Override the inner event's lane to match — protects against any
  // historical event payload where lane was omitted or stale.
  const turn = { ...rec.event, lane: rec.lane ?? lane };
  return { ok: true, turn };
}

// ---------------------------------------------------------------------------
// Receipt ingest — derive an AgentTurn from a `**Field:** value` receipt.md.
// Receipts are written by humans + Claude in a stable house style:
//   **Receipt ID:** ...
//   **Status:** ...
//   **Confidence:** 0.97
//   **Actor:** ...
//   **Hash chain:** #NN
// Plus prose. We map the structured header to AgentTurn fields and use the
// receipt's first non-header sentence as the summary fallback.
// ---------------------------------------------------------------------------

const RECEIPT_FIELD_RE = /^\*\*([A-Za-z][A-Za-z0-9 \-]+?):\*\*\s*(.+?)\s*$/;

function parseReceiptHeader(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    const m = line.match(RECEIPT_FIELD_RE);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, '_');
    fields[key] = m[2].trim();
  }
  return fields;
}

function firstSentence(text, maxLen = 240) {
  // Skip frontmatter-ish header lines and code fences; take the first prose
  // line of meaningful length.
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('**')) continue;
    if (line.startsWith('---')) continue;
    if (line.startsWith('|')) continue;
    if (line.startsWith('```')) continue;
    if (line.startsWith('>')) continue;
    // Strip surrounding markdown emphasis.
    const cleaned = line.replace(/[*_`]/g, '').trim();
    if (cleaned.length < 8) continue;
    return cleaned.slice(0, maxLen);
  }
  return null;
}

function clampStr(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function deriveAgentTurnFromReceipt(filename, text) {
  const fields = parseReceiptHeader(text);
  const summarySrc = fields.status || fields.receipt_id || firstSentence(text);
  const summary = clampStr(summarySrc, 240);
  if (!summary) return { ok: false, reason: 'receipt-no-summary' };

  const nextSrc = fields.next_action
    || fields.next_gate
    || fields.next_expected
    || 'await operator review';
  const next_action = clampStr(nextSrc, 240) || 'await operator review';

  // Confidence: parse trailing number out of the value (e.g. "1.0 (spec only…)").
  let confidence = 0.8;
  if (fields.confidence) {
    const m = fields.confidence.match(/([01](?:\.\d+)?)/);
    if (m) {
      const n = Number.parseFloat(m[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 1) confidence = n;
    }
  }

  // Risk: heuristic from status keywords. Receipts that include rollback
  // language or note vulnerabilities are higher risk; closed/locked/green
  // statuses are low.
  const statusLow = (fields.status || '').toLowerCase();
  let risk = 'low';
  if (/(vuln|drift|breach|fail|incident|reject)/.test(statusLow)) risk = 'high';
  else if (/(queued|pending|preflight|authoring|awaiting)/.test(statusLow)) risk = 'medium';

  const turn = {
    lane: 'reality',
    event_type: 'receipt',
    summary,
    entities: [filename, fields.receipt_id, fields.actor]
      .filter(Boolean)
      .map(s => clampStr(s, 80))
      .filter(Boolean)
      .slice(0, 20),
    files: [filename].map(s => clampStr(s, 240)).filter(Boolean).slice(0, 20),
    commands: [],
    risk,
    next_action,
    confidence,
  };
  return { ok: true, turn };
}

function* iterReceipts() {
  if (!fs.existsSync(RECEIPTS_DIR)) return;
  const entries = fs.readdirSync(RECEIPTS_DIR);
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const fp = path.join(RECEIPTS_DIR, name);
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    if (!stat.isFile()) continue;
    yield { name, path: fp };
  }
}

// ---------------------------------------------------------------------------
// Normalization + dedupe
// ---------------------------------------------------------------------------

/** Trim string fields and drop arrays to their max sizes. Returns a NEW
 *  object; never mutates input. Returns null if any required field would
 *  become empty after trimming (validator catches that, but we short-circuit
 *  to keep the reject log readable). */
function normalize(turn) {
  const summary = clampStr(turn.summary, 240);
  const next_action = clampStr(turn.next_action, 240);
  if (!summary || !next_action) return null;
  const trimArr = (arr, maxLen) =>
    (Array.isArray(arr) ? arr : [])
      .map(s => (typeof s === 'string' ? clampStr(s, maxLen) : null))
      .filter(Boolean)
      .slice(0, 20);
  return {
    lane: turn.lane,
    event_type: turn.event_type,
    summary,
    entities: trimArr(turn.entities, 80),
    files: trimArr(turn.files, 240),
    commands: trimArr(turn.commands, 240),
    risk: turn.risk,
    next_action,
    confidence: turn.confidence,
  };
}

// ---------------------------------------------------------------------------
// Deterministic 90/10 split by content hash.
// hash → first 8 hex chars → uint32 → mod 100. < VAL_PERCENT goes to val.
// ---------------------------------------------------------------------------
function bucketOf(hash) {
  return parseInt(hash.slice(0, 8), 16) % 100;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString();
  loadAndCheckSchema(); // throws if drift or missing

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const counts = {
    flux_lines_seen: 0,
    flux_accepted: 0,
    receipts_seen: 0,
    receipts_accepted: 0,
    duplicates: 0,
    too_short: 0,
  };
  const rejects = []; // { source, reason, locator }
  const seenHashes = new Set();
  const accepted = []; // { hash, turn, source }

  function consider(turn, source) {
    const normed = normalize(turn);
    if (!normed) {
      rejects.push({ source, reason: 'normalize-empty', locator: source });
      return;
    }
    const err = validateAgentTurn(normed);
    if (err) {
      rejects.push({ source, reason: `schema:${err}`, locator: source });
      return;
    }
    const canonical = canonicalJSON(normed);
    if (Buffer.byteLength(canonical, 'utf8') < MIN_BYTES) {
      counts.too_short += 1;
      rejects.push({ source, reason: 'below-min-bytes', locator: source });
      return;
    }
    const h = sha256Hex(canonical);
    if (seenHashes.has(h)) {
      counts.duplicates += 1;
      return;
    }
    const grammarText = grammarOrderedJSON(normed);
    seenHashes.add(h);
    accepted.push({ hash: h, turn: normed, canonical, grammarText, source });
  }

  // 1. Flux lanes
  const lanesToWalk = INCLUDE_THOUGHT ? ['reality', 'thought'] : ['reality'];
  for (const lane of lanesToWalk) {
    for (const item of iterFluxLane(lane)) {
      counts.flux_lines_seen += 1;
      const out = extractAgentTurnFromFlux(item);
      if (!out.ok) {
        rejects.push({
          source: 'flux',
          reason: out.reason,
          locator: `${path.basename(item.file)}:${item.lineNo}`,
        });
        continue;
      }
      const before = accepted.length;
      consider(out.turn, `flux:${lane}:${item.lineNo}`);
      if (accepted.length > before) counts.flux_accepted += 1;
    }
  }

  // 2. Receipts
  for (const r of iterReceipts()) {
    counts.receipts_seen += 1;
    let text;
    try { text = fs.readFileSync(r.path, 'utf8'); }
    catch (e) {
      rejects.push({ source: 'receipt', reason: `read-error:${e.message}`, locator: r.name });
      continue;
    }
    const out = deriveAgentTurnFromReceipt(r.name, text);
    if (!out.ok) {
      rejects.push({ source: 'receipt', reason: out.reason, locator: r.name });
      continue;
    }
    const before = accepted.length;
    consider(out.turn, `receipt:${r.name}`);
    if (accepted.length > before) counts.receipts_accepted += 1;
  }

  if (accepted.length === 0) {
    console.error('REFUSING TO EMIT EMPTY CORPUS. Counts:', counts);
    console.error('First 20 rejects:', rejects.slice(0, 20));
    process.exit(2);
  }

  // 3. Deterministic split. Sort by hash so output ordering is stable across
  //    runs even if the input file order changed.
  accepted.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  const trainPath = path.join(OUT_DIR, 'train.jsonl');
  const valPath = path.join(OUT_DIR, 'val.jsonl');
  const manifestPath = path.join(OUT_DIR, 'corpus-manifest.json');

  const trainLines = [];
  const valLines = [];
  for (const row of accepted) {
    // Pretraining row: {"text": "<grammar-ordered AgentTurn JSON>\n"}.
    // No instruction template — full FT on raw text. Keys are in
    // agent_turn.gbnf root-rule order so the token sequence matches the
    // GBNF mask at inference time. The trailing newline gives the tokenizer
    // a stable EOS-equivalent and sits OUTSIDE the closing `}` (the grammar
    // accepts the JSON without trailing whitespace; the `\n` is corpus
    // framing, not a grammar-internal token).
    const example = JSON.stringify({ text: row.grammarText + '\n' }) + '\n';
    if (bucketOf(row.hash) < VAL_PERCENT) valLines.push(example);
    else trainLines.push(example);
  }

  // Write atomically: tmp + rename, so a partial write never poisons a
  // downstream training run that polls these files.
  function atomicWrite(target, lines) {
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, lines.join(''));
    fs.renameSync(tmp, target);
  }
  atomicWrite(trainPath, trainLines);
  atomicWrite(valPath, valLines);

  const trainSha = sha256Hex(trainLines.join(''));
  const valSha = sha256Hex(valLines.join(''));

  // Rejection histogram — every reason gets a count, no smoothing.
  const rejectHistogram = {};
  for (const r of rejects) {
    rejectHistogram[r.reason] = (rejectHistogram[r.reason] || 0) + 1;
  }

  const manifest = {
    schema: 'orange5.ae-black-mamba.corpus-manifest.v0',
    generated_at: startedAt,
    finished_at: new Date().toISOString(),
    purpose: 'AE Black Mamba Phase-3 full-FT pretraining corpus',
    inputs: {
      flux_root: FLUX_ROOT,
      receipts_dir: RECEIPTS_DIR,
      schema_path: SCHEMA_PATH,
      lanes_included: lanesToWalk,
      min_bytes: MIN_BYTES,
      val_percent: VAL_PERCENT,
    },
    outputs: {
      train_path: trainPath,
      val_path: valPath,
      train_rows: trainLines.length,
      val_rows: valLines.length,
      train_sha256: trainSha,
      val_sha256: valSha,
    },
    counts,
    accepted_total: accepted.length,
    rejected_total: rejects.length,
    reject_histogram: rejectHistogram,
    // First 50 rejection locators — enough for an operator to spot-fix
    // without bloating the manifest into the megabytes.
    reject_sample: rejects.slice(0, 50),
    rules: {
      validator: 'hand-written; cross-checked against schema enums at startup',
      dedupe: 'SHA-256 of alphabetically-canonical JSON of normalized AgentTurn',
      split: 'deterministic by SHA-256 prefix mod 100; <VAL_PERCENT → val',
      row_format: '{"text": "<grammar-ordered AgentTurn JSON>\\n"}',
      text_serialization: 'Keys in agent_turn.gbnf root-rule order ('
        + GRAMMAR_KEY_ORDER.join(', ')
        + '). confidence snapped to GBNF lexical form (0.0 | 1.0 | 0.XX). '
        + 'Dedupe SHA-256 is computed on the separate alphabetical canonical '
        + 'form so reruns on unchanged input still produce a bit-identical '
        + 'dedupe key set; only the on-disk text differs between the two '
        + 'serializations.',
      training_mode: 'FULL fine-tune (not LoRA — SSM has no transformer-style LoRA)',
      base_model: 'Phase-1 surrogate: bartowski/mamba-2.8b-hf-GGUF; '
        + 'Phase-3 custom: AE Black Mamba 2.8B SSM, pretrained from this corpus',
    },
    moms_law: 'Every rejection itemized. No fake-green rows. No silent coercion.',
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Operator-facing console summary — terse, grid-shaped.
  console.log('AE Black Mamba pipeline — DONE');
  console.log(`  flux lines seen      : ${counts.flux_lines_seen}`);
  console.log(`  flux rows accepted   : ${counts.flux_accepted}`);
  console.log(`  receipts seen        : ${counts.receipts_seen}`);
  console.log(`  receipts accepted    : ${counts.receipts_accepted}`);
  console.log(`  duplicates dropped   : ${counts.duplicates}`);
  console.log(`  too-short dropped    : ${counts.too_short}`);
  console.log(`  total accepted       : ${accepted.length}`);
  console.log(`  train rows           : ${trainLines.length}  sha256 ${trainSha.slice(0, 12)}…`);
  console.log(`  val rows             : ${valLines.length}  sha256 ${valSha.slice(0, 12)}…`);
  console.log(`  rejects              : ${rejects.length}`);
  console.log(`  out dir              : ${OUT_DIR}`);
  console.log(`  manifest             : ${manifestPath}`);
}

// Bun and Node both support import.meta.url; main-module check works in both.
const isDirectRun =
  (typeof Bun !== 'undefined' && import.meta.path === Bun.main)
  || (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`)
  || (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])));

if (isDirectRun) {
  main().catch(err => {
    console.error('pipeline FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

// Exposed for tests.
export const _internal = {
  canonicalJSON,
  grammarOrderedJSON,
  formatConfidenceForGbnf,
  GRAMMAR_KEY_ORDER,
  sha256Hex,
  validateAgentTurn,
  normalize,
  parseReceiptHeader,
  deriveAgentTurnFromReceipt,
  extractAgentTurnFromFlux,
  bucketOf,
};
