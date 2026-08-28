// sparse-worksets/compressor.mjs
//
// AtomSmasher module #4 — Sparse Worksets.
//
// Purpose:
//   Given a task and the full available context, compress the context to the
//   minimum-needed working set for that task. Context items the task does
//   not need are NOT pruned silently — they are returned in `dropped` with
//   the reason they were excluded, so the operator can audit what the model
//   was actually shown.
//
// Doctrine:
//   - The working set is the SMALLEST set of context items sufficient to
//     execute the task. Sufficiency is defined here by relevance signal,
//     not by guessing. The compressor never imagines a relevant fact that
//     was not in the supplied context.
//   - Compression is deterministic given identical inputs. Same task + same
//     context => same working_set, same dropped list, same compression_ratio.
//     The scorer is rule-based; no randomness, no time, no model call.
//   - Every dropped item has a `reason` string the operator can read. Empty
//     "trust me" drops are not allowed. Mom's Law: no theater.
//   - Token budget is optional. If supplied, the working set is trimmed to
//     fit the budget by removing the lowest-scored kept items first. Items
//     dropped solely for budget carry `reason: 'over_budget'` so audits can
//     distinguish "irrelevant" from "didn't fit".
//   - Pinned items are never dropped. If a pinned item exceeds the budget,
//     the compressor reports `over_budget_pinned` in `warnings` rather than
//     silently violating the pin.
//   - Compression ratio is reported in BOTH item-count terms and (when
//     `size` is supplied on items) byte/token terms. We do not pretend a
//     ratio when we lack the data — `compression_ratio_bytes` is `null` if
//     no sizes were provided.
//
// Anti-fluff (LIVE):
//   - A task string consisting solely of fluff words (e.g. "do the thing")
//     is rejected. Tasks must contain at least one content-bearing token.
//   - Items whose only content is fluff/hedging are dropped with reason
//     'fluff_only'. The forbidden-word list is shared with the encoder
//     family (probably / should_work / looks_ok / green_assumed) and a
//     small set of empty-signal phrases.
//   - The compressor refuses to return a working_set larger than the
//     supplied context (sanity check) and refuses to return a negative
//     compression_ratio.
//
// This file is the pure compressor + validator. Persistence, gateway routes,
// and the SQLite-backed certificate index belong to sibling modules.

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSET_SCHEMA_ID = 'orange5.atomsmasher.sparse-workset.v0';

// Forbidden / empty-signal words. A context item or task that is ONLY these
// words carries no information density and gets dropped or rejected.
const FORBIDDEN_WORDS = Object.freeze([
  'green_assumed',
  'looks_ok',
  'probably',
  'should_work',
]);

const FLUFF_ONLY_PATTERNS = Object.freeze([
  /^\s*(do the thing|handle it|figure it out|make it work|fix everything)\s*\.?\s*$/i,
  /^\s*(tbd|todo|wip|n\/a|na)\s*\.?\s*$/i,
  /^\s*\.{0,3}\s*$/,
]);

// Stopwords excluded from the relevance keyword set. Short and conservative —
// we are not trying to be a search engine, we are trying to prevent "the"
// from dominating overlap counts.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'this', 'to', 'was', 'were', 'will', 'with', 'we', 'you', 'i', 'do',
  'does', 'did', 'not', 'no', 'so', 'if', 'then', 'than', 'into', 'out',
  'over', 'under', 'about', 'up', 'down', 'all', 'any', 'some',
]);

// Score thresholds.
// Overlap-jaccard floor for relevance keep. Tuned to 0.10 because at 0.15 the
// rule-based tokenizer (no stemming, no morphology) was dropping items that
// shared 1-2 strong tokens with the task amid a long tail of incidental
// vocabulary. 0.10 still drops items with zero literal overlap. Callers who
// want a stricter cut can pass `opts.keepThreshold`.
const KEEP_THRESHOLD_DEFAULT = 0.10;
const MIN_TASK_CONTENT_TOKENS = 1;   // task must yield >= this many keywords

// ---------------------------------------------------------------------------
// Canonical JSON + hashing — same convention as Commitment Atoms / AIR Codec
// so downstream tools share verifier shape.
// ---------------------------------------------------------------------------

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalStringify(value[k]),
  );
  return '{' + parts.join(',') + '}';
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Tokenization + relevance scoring
// ---------------------------------------------------------------------------

/**
 * Lowercase alphanumeric tokens, stopwords removed, deduped.
 * @param {string} s
 * @returns {Set<string>}
 */
function keywordsOf(s) {
  if (typeof s !== 'string') return new Set();
  const out = new Set();
  const matches = s.toLowerCase().match(/[a-z0-9_][a-z0-9_\-]*/g);
  if (!matches) return out;
  for (const tok of matches) {
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/**
 * Jaccard-ish overlap with a recency tiebreaker baked in. We do not need
 * full TF-IDF; the goal is a deterministic, defensible relevance score.
 * @param {Set<string>} taskKw
 * @param {Set<string>} itemKw
 * @returns {number} 0..1
 */
function relevance(taskKw, itemKw) {
  if (taskKw.size === 0 || itemKw.size === 0) return 0;
  let intersect = 0;
  // iterate the smaller set for speed
  const [small, large] = taskKw.size <= itemKw.size ? [taskKw, itemKw] : [itemKw, taskKw];
  for (const t of small) if (large.has(t)) intersect++;
  const union = taskKw.size + itemKw.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Detect items whose content is empty / fluff-only / forbidden.
 * @param {string} text
 * @returns {string|null} reason if fluff, otherwise null
 */
function fluffReason(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return 'empty';
  }
  const lower = text.toLowerCase();
  for (const word of FORBIDDEN_WORDS) {
    // forbidden_only means the trimmed body equals (or is dominated by) the word
    if (lower.trim() === word) return 'forbidden_only';
  }
  for (const pat of FLUFF_ONLY_PATTERNS) {
    if (pat.test(text)) return 'fluff_only';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compressor
// ---------------------------------------------------------------------------

/**
 * Compress a task + context to its minimum-needed working set.
 *
 * @param {Object} params
 * @param {string} params.task                       - the task statement
 * @param {Array<Object|string>} params.context      - candidate context items
 *   Each item may be a string (treated as `{id, content: <string>}`) or an
 *   object: `{ id, content, tag?, pinned?, size?, score_hint? }`.
 *   - `id`         : stable string id; generated if absent (idx_<n>)
 *   - `content`    : the text the model would see
 *   - `tag`        : optional category (e.g. "spec", "log", "schema")
 *   - `pinned`     : if true, never dropped for relevance (only over_budget_pinned warning)
 *   - `size`       : bytes or tokens (caller's choice; we just sum)
 *   - `score_hint` : 0..1 caller-supplied relevance boost (added, clamped)
 * @param {Object} [opts]
 * @param {number} [opts.keepThreshold]              - relevance keep floor (default 0.15)
 * @param {number|null} [opts.budget]                - max total size of working_set; null = unlimited
 * @returns {{
 *   schema: string,
 *   workset_id: string,
 *   task: string,
 *   working_set: Array<Object>,
 *   dropped: Array<{id:string, reason:string, score:number}>,
 *   compression_ratio: number,
 *   compression_ratio_bytes: number|null,
 *   warnings: string[],
 *   created_at: string,
 *   stats: { input_items:number, kept_items:number, dropped_items:number, input_bytes:number|null, kept_bytes:number|null }
 * }}
 * @throws {Error} on invalid input shape or empty/fluff task
 */
export function compressWorkset({ task, context }, opts = {}) {
  // ---- input shape ------------------------------------------------------
  if (typeof task !== 'string') {
    throw new Error('sparse-worksets: task must be a string');
  }
  if (!Array.isArray(context)) {
    throw new Error('sparse-worksets: context must be an array');
  }
  const keepThreshold = typeof opts.keepThreshold === 'number'
    ? opts.keepThreshold
    : KEEP_THRESHOLD_DEFAULT;
  if (!(keepThreshold >= 0 && keepThreshold <= 1)) {
    throw new Error('sparse-worksets: keepThreshold must be in [0, 1]');
  }
  const budget = opts.budget == null ? null : Number(opts.budget);
  if (budget !== null && !(budget >= 0 && Number.isFinite(budget))) {
    throw new Error('sparse-worksets: budget must be a non-negative finite number or null');
  }

  // ---- anti-fluff on task ----------------------------------------------
  const taskReason = fluffReason(task);
  if (taskReason) {
    throw new Error(`sparse-worksets: task rejected (${taskReason}) — provide a content-bearing task`);
  }
  const taskKw = keywordsOf(task);
  if (taskKw.size < MIN_TASK_CONTENT_TOKENS) {
    throw new Error('sparse-worksets: task contained no content tokens after stopword removal');
  }

  // ---- normalize items --------------------------------------------------
  const items = context.map((raw, idx) => {
    if (raw == null) {
      return { id: `idx_${idx}`, content: '', tag: null, pinned: false, size: null, score_hint: 0, _idx: idx };
    }
    if (typeof raw === 'string') {
      return { id: `idx_${idx}`, content: raw, tag: null, pinned: false, size: null, score_hint: 0, _idx: idx };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`sparse-worksets: context[${idx}] must be string or object, got ${typeof raw}`);
    }
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `idx_${idx}`;
    const content = typeof raw.content === 'string' ? raw.content : '';
    const tag = typeof raw.tag === 'string' ? raw.tag : null;
    const pinned = raw.pinned === true;
    const size = raw.size == null ? null : Number(raw.size);
    if (size !== null && !(size >= 0 && Number.isFinite(size))) {
      throw new Error(`sparse-worksets: context[${idx}].size must be non-negative number or null`);
    }
    let hint = raw.score_hint == null ? 0 : Number(raw.score_hint);
    if (!Number.isFinite(hint)) hint = 0;
    if (hint < 0) hint = 0;
    if (hint > 1) hint = 1;
    return { id, content, tag, pinned, size, score_hint: hint, _idx: idx };
  });

  // Detect duplicate ids early — silent dedup would hide structure.
  const idSet = new Set();
  for (const it of items) {
    if (idSet.has(it.id)) {
      throw new Error(`sparse-worksets: duplicate context id '${it.id}' — ids must be unique`);
    }
    idSet.add(it.id);
  }

  // ---- score items ------------------------------------------------------
  // For each item: compute fluff drop first, then relevance overlap with task.
  // Pinned items skip the relevance drop but still record their score.
  const scored = items.map((it) => {
    const fr = fluffReason(it.content);
    if (fr && !it.pinned) {
      return { ...it, score: 0, drop_reason: fr };
    }
    const kw = keywordsOf(it.content);
    const baseScore = relevance(taskKw, kw);
    // score_hint is additive but clamped — caller can nudge, not override.
    let score = baseScore + it.score_hint;
    if (score > 1) score = 1;
    return { ...it, score, drop_reason: null, _kwSize: kw.size };
  });

  // ---- relevance filter -------------------------------------------------
  const kept = [];
  const dropped = [];
  for (const it of scored) {
    if (it.drop_reason) {
      dropped.push({ id: it.id, reason: it.drop_reason, score: 0 });
      continue;
    }
    if (it.pinned) {
      kept.push(it);
      continue;
    }
    if (it.score < keepThreshold) {
      dropped.push({
        id: it.id,
        reason: it._kwSize === 0 ? 'no_content_tokens' : 'low_relevance',
        score: it.score,
      });
      continue;
    }
    kept.push(it);
  }

  // ---- budget pass ------------------------------------------------------
  const warnings = [];
  let finalKept = kept;
  if (budget !== null) {
    // We can only enforce a byte budget if every kept item declared a size.
    // If any kept item lacks a size, we cannot honestly trim — record a
    // warning and leave the set as-is, rather than guess.
    const allSized = finalKept.every((it) => typeof it.size === 'number');
    if (!allSized) {
      warnings.push('budget_not_enforced: at least one kept item lacks size; refusing to trim by guess');
    } else {
      // Sort kept by (pinned desc, score desc, original index asc) so we
      // remove the LOWEST-scored non-pinned items first if we go over.
      const sorted = [...finalKept].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return a._idx - b._idx;
      });
      let runningSize = 0;
      const survivors = [];
      const overflow = [];
      for (const it of sorted) {
        if (runningSize + it.size <= budget) {
          runningSize += it.size;
          survivors.push(it);
        } else if (it.pinned) {
          // honor the pin, but flag the violation
          runningSize += it.size;
          survivors.push(it);
          warnings.push(`over_budget_pinned: id=${it.id} forced into working_set despite budget`);
        } else {
          overflow.push(it);
        }
      }
      for (const it of overflow) {
        dropped.push({ id: it.id, reason: 'over_budget', score: it.score });
      }
      finalKept = survivors;
    }
  }

  // ---- compose final working_set (preserve original order) -------------
  finalKept.sort((a, b) => a._idx - b._idx);
  const working_set = finalKept.map((it) => ({
    id: it.id,
    content: it.content,
    tag: it.tag,
    pinned: it.pinned,
    size: it.size,
    score: Number(it.score.toFixed(6)),
  }));

  // ---- ratios + stats ---------------------------------------------------
  const input_items = items.length;
  const kept_items = working_set.length;
  const dropped_items = dropped.length;

  // sanity invariants
  if (kept_items + dropped_items !== input_items) {
    // This would be an internal bug, not user error. Surface loudly.
    throw new Error(
      `sparse-worksets: internal accounting error: kept(${kept_items}) + dropped(${dropped_items}) != input(${input_items})`,
    );
  }
  if (kept_items > input_items) {
    throw new Error('sparse-worksets: internal error: working_set larger than input');
  }

  const compression_ratio = input_items === 0
    ? 1
    : Number((kept_items / input_items).toFixed(6));

  let input_bytes = null;
  let kept_bytes = null;
  let compression_ratio_bytes = null;
  const allInputSized = items.every((it) => typeof it.size === 'number');
  const allKeptSized = working_set.every((it) => typeof it.size === 'number');
  if (allInputSized && items.length > 0) {
    input_bytes = items.reduce((acc, it) => acc + it.size, 0);
    if (allKeptSized) {
      kept_bytes = working_set.reduce((acc, it) => acc + it.size, 0);
      compression_ratio_bytes = input_bytes === 0
        ? 1
        : Number((kept_bytes / input_bytes).toFixed(6));
    }
  }

  if (compression_ratio < 0) {
    throw new Error('sparse-worksets: internal error: negative compression_ratio');
  }

  // ---- workset_id is content-derived from {task, working_set ids+scores, dropped}.
  // It is INDEPENDENT of timestamp / warnings so two identical compressions
  // produce the same workset_id, matching Commitment Atoms convention.
  const idPayload = canonicalStringify({
    task,
    working_set: working_set.map((w) => ({ id: w.id, score: w.score })),
    dropped: dropped.map((d) => ({ id: d.id, reason: d.reason })),
    keepThreshold,
    budget,
  });
  const workset_id = sha256(idPayload);

  return {
    schema: WORKSET_SCHEMA_ID,
    workset_id,
    task,
    working_set,
    dropped,
    compression_ratio,
    compression_ratio_bytes,
    warnings,
    created_at: new Date().toISOString(),
    stats: {
      input_items,
      kept_items,
      dropped_items,
      input_bytes,
      kept_bytes,
    },
  };
}

// ---------------------------------------------------------------------------
// Validator — checks a workset object for structural and accounting integrity.
// ---------------------------------------------------------------------------

/**
 * @param {unknown} workset
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateWorkset(workset) {
  const errors = [];
  if (workset == null || typeof workset !== 'object' || Array.isArray(workset)) {
    return { valid: false, errors: ['workset must be a non-null object'] };
  }
  const required = [
    'schema', 'workset_id', 'task', 'working_set', 'dropped',
    'compression_ratio', 'compression_ratio_bytes', 'warnings',
    'created_at', 'stats',
  ];
  for (const k of required) {
    if (!(k in workset)) errors.push(`missing required field: ${k}`);
  }
  if (errors.length) return { valid: false, errors };

  if (workset.schema !== WORKSET_SCHEMA_ID) {
    errors.push(`schema must be '${WORKSET_SCHEMA_ID}', got '${workset.schema}'`);
  }
  if (!/^[a-f0-9]{64}$/.test(workset.workset_id)) {
    errors.push('workset_id must be 64-char lowercase hex (sha256)');
  }
  if (typeof workset.task !== 'string' || workset.task.length === 0) {
    errors.push('task must be a non-empty string');
  }
  if (!Array.isArray(workset.working_set)) errors.push('working_set must be an array');
  if (!Array.isArray(workset.dropped)) errors.push('dropped must be an array');
  if (!Array.isArray(workset.warnings)) errors.push('warnings must be an array of strings');
  if (typeof workset.compression_ratio !== 'number' || workset.compression_ratio < 0) {
    errors.push('compression_ratio must be a non-negative number');
  }
  if (
    workset.compression_ratio_bytes !== null &&
    (typeof workset.compression_ratio_bytes !== 'number' || workset.compression_ratio_bytes < 0)
  ) {
    errors.push('compression_ratio_bytes must be null or a non-negative number');
  }
  if (typeof workset.created_at !== 'string' || Number.isNaN(Date.parse(workset.created_at))) {
    errors.push('created_at must be parseable ISO 8601 string');
  }
  if (workset.stats == null || typeof workset.stats !== 'object') {
    errors.push('stats must be an object');
  }
  if (errors.length) return { valid: false, errors };

  // Accounting integrity: kept + dropped == input
  const { input_items, kept_items, dropped_items } = workset.stats;
  if (
    typeof input_items !== 'number' ||
    typeof kept_items !== 'number' ||
    typeof dropped_items !== 'number'
  ) {
    errors.push('stats.{input_items,kept_items,dropped_items} must all be numbers');
  } else {
    if (kept_items !== workset.working_set.length) {
      errors.push(`stats.kept_items (${kept_items}) != working_set.length (${workset.working_set.length})`);
    }
    if (dropped_items !== workset.dropped.length) {
      errors.push(`stats.dropped_items (${dropped_items}) != dropped.length (${workset.dropped.length})`);
    }
    if (kept_items + dropped_items !== input_items) {
      errors.push(`stats: kept(${kept_items}) + dropped(${dropped_items}) != input(${input_items})`);
    }
  }

  // Every dropped entry must carry a non-empty reason.
  for (const d of workset.dropped) {
    if (!d || typeof d.id !== 'string' || typeof d.reason !== 'string' || d.reason.length === 0) {
      errors.push('every dropped entry must have id:string and non-empty reason:string');
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Re-exports for downstream tooling
// ---------------------------------------------------------------------------

export const __internals = Object.freeze({
  canonicalStringify,
  sha256,
  keywordsOf,
  relevance,
  fluffReason,
  STOPWORDS: [...STOPWORDS],
  FORBIDDEN_WORDS: [...FORBIDDEN_WORDS],
  KEEP_THRESHOLD_DEFAULT,
  WORKSET_SCHEMA_ID,
});
