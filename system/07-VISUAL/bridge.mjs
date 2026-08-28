// 07-VISUAL/bridge.mjs — AE Eyes → OrangeBrain structured-text bridge (Pillar 4).
//
// BACKEND ONLY. Pure function. No model call, no network, no UI.
//
// The bridge is the last hop of: screen/doc/UI → visual stack → STRUCTURED TEXT
// → OrangeBrain → Hermes. It takes the *already-produced* output of the visual
// stack (a GLM-4.6V caption, a Playwright/Chrome-DevTools DOM/a11y snapshot, or
// a doc extract) and normalizes it into the single envelope OrangeBrain
// consumes:
//
//   { kind, summary, fields, cites }
//
//   kind    — coarse type OrangeBrain routes on: 'screenshot' | 'dom' | 'doc'.
//   summary — one compact natural-language line (what was seen).
//   fields  — structured key facts pulled from the payload (typed, flat-ish).
//   cites   — provenance handles the answer can be traced back to
//             (source paths, doc#page, qdrant_doc_id, DOM selectors, patch idx).
//
// toStructuredText accepts the MODEL OUTPUT as input — it never invokes the VLM
// or the browser. That keeps it deterministic and unit-testable (Frontier-
// Isolation Law: this file has zero egress). The live model call happens
// upstream in the orchestrator; the bridge only shapes the result.
//
// Doctrine refs:
//   - AE_ORANGEEYE_FOUNDATION_SPEC.md §4.3 (cortex describe/extract/ground
//     shapes), §7 (Reality-lane event body: summary/entities/files/confidence).
//   - Master Plan §6 bridge: "visual stack → structured text → OrangeBrain".

const KINDS = {
  'screenshot-caption': 'screenshot',
  'dom-snapshot': 'dom',
  'doc-extract': 'doc',
};

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(isNonEmptyString);
}

function clampConfidence(v) {
  if (!isFiniteNumber(v)) return null;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Collapse whitespace and trim to a single tidy line. */
function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/** Truncate a summary to a sane length with an ellipsis, on a word boundary. */
function capSummary(s, max = 280) {
  const t = oneLine(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// Per-source normalizers. Each returns { summary, fields, cites } and is fed a
// payload object; missing pieces degrade gracefully (never throw on shape).
// ---------------------------------------------------------------------------

/**
 * screenshot-caption — output of GLM-4.6V /v1/visual/describe (or a frontier
 * offload). Expected payload keys (all optional except caption/answer):
 *   { caption|answer, entities[], image_path|file, image_sha256, qdrant_doc_id,
 *     grounding:[{patch_idx|idx, bbox, confidence}], confidence, frontier_used }
 */
function fromScreenshotCaption(p) {
  const captionText = isNonEmptyString(p.caption) ? p.caption
    : isNonEmptyString(p.answer) ? p.answer
    : '';
  const summary = captionText ? capSummary(captionText) : '(no caption produced)';

  const grounding = Array.isArray(p.grounding) ? p.grounding : [];
  const patchCount = grounding.length;

  const fields = {
    entities: asStringArray(p.entities),
    patch_count: patchCount,
    confidence: clampConfidence(p.confidence),
    frontier_used: Boolean(p.frontier_used),
  };

  const cites = [];
  if (isNonEmptyString(p.image_path)) cites.push(p.image_path);
  else if (isNonEmptyString(p.file)) cites.push(p.file);
  if (isNonEmptyString(p.image_sha256)) cites.push(`sha256:${p.image_sha256}`);
  if (isNonEmptyString(p.qdrant_doc_id)) cites.push(`qdrant:${p.qdrant_doc_id}`);
  for (const g of grounding) {
    const idx = isFiniteNumber(g.patch_idx) ? g.patch_idx : (isFiniteNumber(g.idx) ? g.idx : null);
    if (idx !== null) cites.push(`patch:${idx}`);
  }
  return { summary, fields, cites };
}

/**
 * dom-snapshot — output of Playwright / Chrome DevTools MCP. Expected payload:
 *   { url, title, text|a11ySummary, nodes|elements:[{role,name,selector}],
 *     landmarks[], forms[] }
 * We surface the accessibility spine (title, url, key roles) as structured text.
 */
function fromDomSnapshot(p) {
  const nodes = Array.isArray(p.nodes) ? p.nodes
    : Array.isArray(p.elements) ? p.elements
    : [];

  const title = isNonEmptyString(p.title) ? p.title : '';
  const url = isNonEmptyString(p.url) ? p.url : '';
  const bodyText = isNonEmptyString(p.text) ? p.text
    : isNonEmptyString(p.a11ySummary) ? p.a11ySummary
    : '';

  const summarySeed = title
    ? `DOM snapshot: ${title}${url ? ` (${url})` : ''} — ${nodes.length} a11y node(s)`
    : bodyText
      ? `DOM snapshot — ${bodyText}`
      : url
        ? `DOM snapshot of ${url} — ${nodes.length} a11y node(s)`
        : 'DOM snapshot (empty)';
  const summary = capSummary(summarySeed);

  // Roll up roles present, e.g. { button: 3, link: 12, textbox: 2 }.
  const roleCounts = {};
  for (const n of nodes) {
    const role = n && isNonEmptyString(n.role) ? n.role : 'unknown';
    roleCounts[role] = (roleCounts[role] || 0) + 1;
  }

  const fields = {
    url,
    title,
    node_count: nodes.length,
    roles: roleCounts,
    landmarks: asStringArray(p.landmarks),
    form_count: Array.isArray(p.forms) ? p.forms.length : 0,
  };

  const cites = [];
  if (url) cites.push(url);
  // Cite up to a few concrete selectors so OrangeBrain can point at real nodes.
  for (const n of nodes) {
    if (n && isNonEmptyString(n.selector)) {
      cites.push(`selector:${n.selector}`);
      if (cites.length >= 8) break;
    }
  }
  return { summary, fields, cites };
}

/**
 * doc-extract — output of a PDF/doc extraction (ColPali page pull, OCR, or
 * structured table/form extract). Expected payload:
 *   { source|file, page, doc_id, text|content, tables[], structure{},
 *     confidence }
 */
function fromDocExtract(p) {
  const source = isNonEmptyString(p.source) ? p.source
    : isNonEmptyString(p.file) ? p.file
    : '';
  const page = isFiniteNumber(p.page) ? p.page : null;
  const text = isNonEmptyString(p.text) ? p.text
    : isNonEmptyString(p.content) ? p.content
    : '';

  const where = source
    ? `${source}${page !== null ? `#page=${page}` : ''}`
    : (page !== null ? `page ${page}` : 'document');
  const summarySeed = text
    ? `Doc extract from ${where}: ${text}`
    : `Doc extract from ${where} (no text layer)`;
  const summary = capSummary(summarySeed);

  const tableCount = Array.isArray(p.tables) ? p.tables.length : 0;

  const fields = {
    source,
    page,
    char_count: text.length,
    table_count: tableCount,
    has_structure: Boolean(p.structure && typeof p.structure === 'object'),
    confidence: clampConfidence(p.confidence),
  };

  const cites = [];
  if (source) cites.push(page !== null ? `${source}#page=${page}` : source);
  if (isNonEmptyString(p.doc_id)) cites.push(`doc:${p.doc_id}`);
  return { summary, fields, cites };
}

// ---------------------------------------------------------------------------
// Public: toStructuredText
// ---------------------------------------------------------------------------

/**
 * toStructuredText — normalize one visual-stack output into the OrangeBrain
 * structured-text envelope. Pure; deterministic; never calls a model.
 *
 * @param {object} params
 * @param {'screenshot-caption'|'dom-snapshot'|'doc-extract'} params.source_type
 * @param {object} params.payload   - the visual stack's output for that source.
 * @returns {{kind:string, summary:string, fields:object, cites:string[]}}
 *
 * Throws only on contract violation (unknown source_type, non-object payload).
 * A structurally-thin-but-valid payload degrades gracefully into a well-formed
 * envelope (empty fields / cites, honest "(no ...)" summary) rather than
 * throwing — OrangeBrain always receives a shaped result.
 */
export function toStructuredText({ source_type, payload } = {}) {
  if (!isNonEmptyString(source_type) || !(source_type in KINDS)) {
    throw new Error(
      `toStructuredText: unknown source_type "${source_type}" ` +
      `(expected one of: ${Object.keys(KINDS).join(', ')})`,
    );
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('toStructuredText: payload must be a plain object');
  }

  const kind = KINDS[source_type];
  let shaped;
  switch (source_type) {
    case 'screenshot-caption':
      shaped = fromScreenshotCaption(payload);
      break;
    case 'dom-snapshot':
      shaped = fromDomSnapshot(payload);
      break;
    case 'doc-extract':
      shaped = fromDocExtract(payload);
      break;
    default:
      // unreachable — guarded above.
      shaped = { summary: '(unhandled)', fields: {}, cites: [] };
  }

  return {
    kind,
    summary: shaped.summary,
    fields: shaped.fields,
    cites: Array.isArray(shaped.cites) ? shaped.cites : [],
  };
}

export const SOURCE_TYPES = Object.keys(KINDS);
export const ENVELOPE_KINDS = Object.values(KINDS);

export const __internal = {
  KINDS,
  oneLine,
  capSummary,
  clampConfidence,
  asStringArray,
  fromScreenshotCaption,
  fromDomSnapshot,
  fromDocExtract,
};
