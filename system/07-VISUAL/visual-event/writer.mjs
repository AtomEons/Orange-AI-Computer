// 07-VISUAL/visual-event/writer.mjs — OrangeEye visual-event Flux writer.
//
// Wraps the Æ Cobra Flux writer at 06-ORANGELLM/memory/ae-cobra/flux/writer.mjs.
// Composes an agent_turn-compatible body with a structured `ae_visual` block,
// then appends it to the Reality lane via writeFluxRecord with:
//   origin = 'orangeeye'
//   lane   = 'reality'
//   kind   = 'observation'
//
// Origin-based classifier (V1 mitigation): the lane is fixed to reality on
// origin='orangeeye'. The classifier does NOT inspect content; that prevents
// visual events from getting misrouted into Thought just because the GLM-4.6V
// summary happens to read like analytical prose.
//
// Doctrine refs:
//   - 07-VISUAL/AE_ORANGEEYE_FOUNDATION_SPEC.md
//   - 07-VISUAL/PR-13-SPEC.md
//   - Frontier-Isolation Law: this file never calls a frontier model directly;
//     it only RECORDS whether one was used upstream via the gateway.

import path from 'node:path';
import { writeFluxRecord } from '../../06-ORANGELLM/memory/ae-cobra/flux/writer.mjs';

const ORIGIN = 'orangeeye';
const LANE = 'reality';
const KIND = 'observation';

const DEFAULT_FLUX_ROOT = path.resolve(
  process.cwd(),
  '06-ORANGELLM',
  'memory',
  'ae-cobra',
  'flux',
);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampConfidence(v, fallback = 0.5) {
  if (!isFiniteNumber(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function normalizeStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(isNonEmptyString);
}

function normalizePatchGrounding(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    const idx = isFiniteNumber(p.idx) ? p.idx : null;
    const bbox = Array.isArray(p.bbox) && p.bbox.length === 4 && p.bbox.every(isFiniteNumber)
      ? p.bbox
      : null;
    const confidence = clampConfidence(p.confidence, 0);
    if (idx === null && bbox === null) continue;
    out.push({ idx, bbox, confidence });
  }
  return out;
}

function inferRisk(explicit, patchGrounding) {
  if (explicit === 'low' || explicit === 'medium' || explicit === 'high') return explicit;
  // Default: low. Visual ingestion is read-only — no command, no state mutation.
  // Caller can override (e.g. if cortex flagged sensitive content).
  void patchGrounding;
  return 'low';
}

/**
 * writeVisualEvent — append a Reality-lane observation describing one visual page event.
 *
 * @param {object} params
 * @param {string} params.image_sha256          - SHA-256 of the source page image (hex).
 * @param {string} params.qdrant_doc_id         - Qdrant point id in `orange5-vision`.
 * @param {number} [params.page=0]              - Zero-based page index.
 * @param {string} params.cortex_model          - Local cortex model id, e.g. 'glm-4.6v'.
 * @param {object} params.cortex_response       - {summary, entities, files, commands, risk, next_action, confidence}
 * @param {Array}  [params.patch_grounding=[]]  - [{idx, bbox:[x,y,w,h], confidence}, ...]
 * @param {boolean}[params.frontier_used=false] - Was the OrangeLLM gateway routed to a frontier model?
 * @param {string} [params.frontier_model]      - Frontier model id (only meaningful when frontier_used=true).
 * @param {string} [params.fluxRoot]            - Override Flux root path. Defaults to the Æ Cobra root.
 * @returns {object} The written Flux record (with prev_hash, hash, ts).
 */
export function writeVisualEvent({
  image_sha256,
  qdrant_doc_id,
  page = 0,
  cortex_model,
  cortex_response,
  patch_grounding = [],
  frontier_used = false,
  frontier_model,
  fluxRoot,
} = {}) {
  // --- validate ---
  if (!isNonEmptyString(image_sha256)) {
    throw new Error('writeVisualEvent: image_sha256 required (hex string)');
  }
  if (!/^[0-9a-f]{64}$/i.test(image_sha256)) {
    throw new Error('writeVisualEvent: image_sha256 must be 64-char hex');
  }
  if (!isNonEmptyString(qdrant_doc_id)) {
    throw new Error('writeVisualEvent: qdrant_doc_id required');
  }
  if (!isNonEmptyString(cortex_model)) {
    throw new Error('writeVisualEvent: cortex_model required');
  }
  if (!cortex_response || typeof cortex_response !== 'object') {
    throw new Error('writeVisualEvent: cortex_response object required');
  }
  if (frontier_used && !isNonEmptyString(frontier_model)) {
    throw new Error('writeVisualEvent: frontier_model required when frontier_used=true');
  }

  const root = isNonEmptyString(fluxRoot) ? fluxRoot : DEFAULT_FLUX_ROOT;

  // --- ae_visual block ---
  const ae_visual = {
    image_sha256: image_sha256.toLowerCase(),
    qdrant_doc_id,
    page: isFiniteNumber(page) ? page : 0,
    cortex_model,
    frontier_used: Boolean(frontier_used),
    patch_grounding: normalizePatchGrounding(patch_grounding),
  };
  if (frontier_used && isNonEmptyString(frontier_model)) {
    ae_visual.frontier_model = frontier_model;
  }

  // --- agent_turn-compatible fields, sourced from cortex_response ---
  const summary = isNonEmptyString(cortex_response.summary)
    ? cortex_response.summary
    : '(no summary)';
  const entities = normalizeStringArray(cortex_response.entities);
  const files = normalizeStringArray(cortex_response.files);
  const commands = normalizeStringArray(cortex_response.commands);
  const risk = inferRisk(cortex_response.risk, ae_visual.patch_grounding);
  const next_action = isNonEmptyString(cortex_response.next_action)
    ? cortex_response.next_action
    : 'wait for follow-up query';
  const confidence = clampConfidence(cortex_response.confidence, 0.5);

  const body = {
    ae_visual,
    summary,
    entities,
    files,
    commands,
    risk,
    next_action,
    confidence,
  };

  // --- write via Æ Cobra ---
  try {
    return writeFluxRecord({
      lane: LANE,
      origin: ORIGIN,
      kind: KIND,
      body,
      fluxRoot: root,
    });
  } catch (err) {
    // Re-throw with caller-facing context; the Flux writer's own messages stay
    // intact for debugging. Common failure modes: fluxRoot unwritable, invalid
    // lane (shouldn't happen here), prev-day chain unreadable.
    const wrapped = new Error(
      `writeVisualEvent: Flux append failed: ${err && err.message ? err.message : err}`,
    );
    wrapped.cause = err;
    throw wrapped;
  }
}

export const __internal = {
  ORIGIN,
  LANE,
  KIND,
  DEFAULT_FLUX_ROOT,
  normalizePatchGrounding,
  clampConfidence,
};
