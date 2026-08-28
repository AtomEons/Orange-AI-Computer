#!/usr/bin/env bun
// assemble.mjs — MiniEyes corpus assembler (Bun)
//
// Disclosure ID: ATOM-MINIEYES-ASSEMBLE-2026-0624
// Status:        Deferred / Optional addendum. Build ONLY if the primary
//                visual stack (GLM-4.6V + Playwright + Chrome DevTools + UX
//                tools) proves insufficient under real Orange5/AECode load.
//                See ./corpus-strategy.md §1 and §9.
//
// What this script is:
//   The corpus-assembly pipeline for MiniEyes — the 2-8B local VLM addendum.
//   It walks the three approved source lanes (cockpit screenshots, AECode
//   diagrams, receipt-PDF page renders), runs the four hard filter rules
//   (no PII, no operator face, no secrets, no third-party UI), invokes the
//   currently running OrangeEye (GLM-4.6V) endpoint to draft a structured
//   description per image with patch grounding, and emits one JSONL line per
//   candidate pair into ./corpus/pairs/{lane}.jsonl. Every drop writes a
//   rejection receipt. Every admission gets a SHA-256.
//
// What this script is NOT:
//   - It is not a curator. The operator still reviews every pair via
//     03_curate.py before HRE-gate. This script is stage 01_ingest +
//     02_filter + the description draft that 03_curate edits.
//   - It is not a trainer. Training lives in
//     ./notebooks/minieyes_qlora.ipynb (authored at promotion time).
//   - It is not a promotion. Promotion ceremony is corpus-strategy.md §8.
//
// Run:
//   bun run 16-TRAINING/minieyes/assemble.mjs \
//     [--lane cockpit|diagram|receipt|all] \
//     [--limit N] [--dry-run]
//
// Required env:
//   ORANGEEYE_URL          OrangeEye GLM-4.6V endpoint (OpenAI-compatible
//                          chat/completions). Default: http://127.0.0.1:8798/v1/chat/completions
//   ORANGEEYE_MODEL        Model name. Default: glm-4.6v
//   MINIEYES_CONFIRM       Must equal "yes-build-the-addendum" to run.
//                          Forces the operator to acknowledge the deferred
//                          status before any image ingest.
//
// Mom's Law: no padding, no theater, no silent failure. Every stage emits
// a receipt. If the upstream eye is unreachable, this script stops at the
// boot probe — it does not invent descriptions.
//

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Paths & constants
// ─────────────────────────────────────────────────────────────────────────────

const ROOT      = path.resolve(process.env.ORANGE5_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const MINIEYES  = path.join(ROOT, '16-TRAINING/minieyes');
const RECEIPTS  = path.join(ROOT, '10-RECEIPTS');

const SOURCE_LANES = {
  cockpit: {
    root: 'C:/AtomEons/orange3/cockpit-captures',
    glob: /\.(png|jpg|jpeg|webp)$/i,
    sidecar_ext: '.json',                // optional state sidecar
    pairs_per_image_target: 2,           // strategy §4.2
    instruction:
      'Describe the state of this Orange5 cockpit view. Identify the visible ' +
      'panels (dag-step-row, receipt-card, model-route-badge, router-asic-state ' +
      'pill, etc.), report only observable state, and ground every described ' +
      'element on a region bounding box in the image.',
  },
  diagram: {
    root: 'C:/AtomEons/orangebox/docs/diagrams',
    glob: /\.(png|jpg|jpeg)$/i,
    sidecar_ext: '.json',                // optional node/edge sidecar
    pairs_per_image_target: 4,
    instruction:
      'Describe this AECode diagram. List nodes and edges, identify the ' +
      'doctrine it encodes (Black Mamba vN, Router Law, Lifespark Train, ' +
      'Ignition Cascade, Phenomenon Approach, Federation Triumvirate, Router ' +
      'ASIC v1.0, 24-Month Attack Roadmap), and ground each major region on a ' +
      'bounding box. No interpretation beyond what is drawn.',
  },
  receipt: {
    root: 'C:/AtomEons/orange3/receipts',
    glob: /\.(png|jpg|jpeg)$/i,          // PDF→PNG already done upstream
    sidecar_ext: '.json',                // canonical receipt JSON sidecar
    pairs_per_image_target: 2,
    instruction:
      'Read this Orange5 receipt page. Emit the canonical receipt JSON shape ' +
      '(run_id, step, state, model_route, validator_status, timestamps, ' +
      'package_sha256) for every field visible on the page. Ground each ' +
      'field on a bounding box. Do not invent fields that are not visible.',
  },
};

// Also scan 10-RECEIPTS for any rendered receipt pages already on disk.
const EXTRA_RECEIPT_SCAN_ROOTS = [
  path.join(RECEIPTS, 'orange5-build'),
  path.join(RECEIPTS, 'runtime-logs'),
];

const ORANGEEYE_URL   = process.env.ORANGEEYE_URL   || 'http://127.0.0.1:8798/v1/chat/completions';
const ORANGEEYE_MODEL = process.env.ORANGEEYE_MODEL || 'glm-4.6v';
const MINIEYES_CONFIRM = process.env.MINIEYES_CONFIRM || '';

const FILTERS = {
  // §3.1 PII deny-list (compact, deterministic, no NN — face is §3.2)
  pii: [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,                       // email
    /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/,  // US phone
    /\b\d{3}-\d{2}-\d{4}\b/,                                            // SSN
    /\b\d{1,5}\s+[A-Z][a-z]+\s+(St|Ave|Rd|Blvd|Ln|Dr|Way|Ct)\.?\b/,     // street
  ],
  // §3.3 secrets — high-signal patterns; high-entropy fallback in filter pass
  secrets: [
    /\bAKIA[0-9A-Z]{16}\b/,                                            // AWS access key
    /\bASIA[0-9A-Z]{16}\b/,                                            // AWS STS key
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,                                  // GitHub token
    /\bsk_(live|test)_[A-Za-z0-9]{24,}\b/,                             // Stripe key
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,                                // Slack token
    /\bey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/, // JWT
    /\bATOMEONS_IDENTITY_SECRET\b/,                                    // operator secret name
  ],
  // §3.4 third-party UI brand strings (incidental hits acceptable; deliberate UI = reject)
  third_party_brand: [
    /\b(Salesforce|HubSpot|Notion|Linear|Asana|Jira|Confluence|Monday|Pendo|Amplitude|Mixpanel)\b/i,
  ],
};

// §3.2 operator-face check is required but delegated: this Bun script flags
// every image as "needs_face_check" and the Python filter stage (02_filter.py)
// runs MediaPipe/RetinaFace locally before admission. We do not silently pass.
// See corpus-strategy.md §3.2.

const OUT_DIR    = path.join(MINIEYES, 'corpus/pairs');
const REJECT_DIR = path.join(MINIEYES, 'corpus/rejected');
const STAGE_DIR  = path.join(MINIEYES, 'corpus/staging');

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_LOG = path.join(MINIEYES, `assemble-${RUN_ID}.log`);
const RUN_RECEIPT = path.join(MINIEYES, `assemble-${RUN_ID}-receipt.json`);

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const ARG_LANE   = arg('--lane', 'all');
const ARG_LIMIT  = parseInt(arg('--limit', '0'), 10) || 0;   // 0 = no cap
const ARG_DRY    = !!arg('--dry-run', false);

// ─────────────────────────────────────────────────────────────────────────────
// Logging & receipts
// ─────────────────────────────────────────────────────────────────────────────

const logLines = [];
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  logLines.push(stamped);
}
function flushLog() {
  try { fs.writeFileSync(RUN_LOG, logLines.join('\n') + '\n'); } catch {}
}

function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function sha256Str(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function walk(dir, pred, out = []) {
  if (!fs.existsSync(dir)) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, pred, out);
    else if (e.isFile() && pred(full)) out.push(full);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter stage (§3 of corpus-strategy.md)
// ─────────────────────────────────────────────────────────────────────────────

function readSidecar(imgPath, ext) {
  const side = imgPath.replace(/\.[^.]+$/, ext);
  if (!fs.existsSync(side)) return null;
  try { return JSON.parse(fs.readFileSync(side, 'utf8')); }
  catch { return null; }
}

function regexHit(text, patterns) {
  for (const re of patterns) if (re.test(text)) return re.source;
  return null;
}

function writeRejection(imgPath, rule, detail) {
  ensureDir(REJECT_DIR);
  const rec = {
    schema: 'minieyes.rejection.v0',
    image_path: imgPath,
    image_sha256: safeSha(imgPath),
    rule_fired: rule,
    detail,
    rejected_at: new Date().toISOString(),
  };
  const stem = path.basename(imgPath).replace(/\.[^.]+$/, '');
  const rejPath = path.join(REJECT_DIR, `${stem}.${rule}.json`);
  fs.writeFileSync(rejPath, JSON.stringify(rec, null, 2));
  return rejPath;
}

function safeSha(p) {
  try { return sha256File(p); } catch { return null; }
}

/**
 * Returns { admit: bool, rule?: string, detail?: string }
 * Only runs the deterministic regex sweeps + sidecar-driven rules. The face
 * detector is delegated to 02_filter.py (Python, local MediaPipe/RetinaFace).
 * This Bun script tags any admitted image as `needs_face_check: true`.
 */
function filterImage(imgPath, lane) {
  const sidecarTexts = [];
  const side = readSidecar(imgPath, SOURCE_LANES[lane].sidecar_ext);
  if (side) sidecarTexts.push(JSON.stringify(side));
  const haystack = sidecarTexts.join('\n') + '\n' + imgPath;

  const piiHit = regexHit(haystack, FILTERS.pii);
  if (piiHit) return { admit: false, rule: 'pii', detail: piiHit };

  const secHit = regexHit(haystack, FILTERS.secrets);
  if (secHit) return { admit: false, rule: 'secrets', detail: secHit };

  const brandHit = regexHit(haystack, FILTERS.third_party_brand);
  if (brandHit && lane !== 'diagram') {
    // diagrams may legitimately reference brand names in node labels; cockpit
    // and receipts must not.
    return { admit: false, rule: 'third_party_brand', detail: brandHit };
  }

  // §3.5 theater check: receipt lane must have a sidecar JSON. No sidecar =
  // we cannot confirm the receipt is a real run, so reject.
  if (lane === 'receipt' && !side) {
    return { admit: false, rule: 'theater_no_sidecar', detail: 'receipt page has no canonical-JSON sidecar' };
  }

  return { admit: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// OrangeEye call (GLM-4.6V, OpenAI-compatible)
// ─────────────────────────────────────────────────────────────────────────────

async function probeOrangeEye() {
  const url = ORANGEEYE_URL.replace(/\/v1\/chat\/completions\/?$/, '/v1/models');
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(`[OK] OrangeEye reachable at ${url}`);
    return true;
  } catch (err) {
    log(`[FATAL] OrangeEye unreachable at ${url}: ${err.message}`);
    log(`        Set ORANGEEYE_URL to a live GLM-4.6V endpoint, or start it`);
    log(`        before re-running. This script does NOT fabricate descriptions.`);
    return false;
  }
}

function imageToDataUrl(imgPath) {
  const buf = fs.readFileSync(imgPath);
  const ext = path.extname(imgPath).toLowerCase().replace('.', '');
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`;
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const RESPONSE_SCHEMA_HINT = `
Return a STRICT JSON object with this exact shape (no prose outside JSON):

{
  "description_terse":   "engineering-spec, one paragraph, no hedging",
  "description_natural": "full natural-language paragraph, observable state only",
  "description_structured": { /* canonical state JSON; field set depends on lane */ },
  "grounding": [
    {"region_id": "r1", "bbox": [x0, y0, x1, y1], "label": "panel-name"}
  ]
}

Hard rules:
- bbox values are integer pixel coordinates in the original image.
- Every described element MUST appear in grounding[] with a region_id.
- No personification ("the cockpit thinks…" is forbidden).
- No simulation ("as Atom would describe it…" is forbidden).
- If a field is not visible, omit it. Do not invent.
- If the image is unreadable, return {"description_terse":"unreadable","description_natural":"unreadable","description_structured":{},"grounding":[]}.
`.trim();

async function describeImage(imgPath, lane) {
  const dataUrl = imageToDataUrl(imgPath);
  const userText = `${SOURCE_LANES[lane].instruction}\n\n${RESPONSE_SCHEMA_HINT}`;

  const body = {
    model: ORANGEEYE_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 1800,
    stream: false,
  };

  const res = await fetch(ORANGEEYE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OrangeEye HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';

  // Extract the JSON object. GLM-4.6V occasionally wraps in ```json fences.
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) ||
                    content.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) throw new Error(`OrangeEye returned non-JSON: ${content.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

  // Shape guard. If any required field is missing, treat as a failed draft —
  // do not fabricate.
  if (!parsed.description_terse ||
      !parsed.description_natural ||
      !parsed.description_structured ||
      !Array.isArray(parsed.grounding)) {
    throw new Error('OrangeEye draft missing required fields');
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pair emission
// ─────────────────────────────────────────────────────────────────────────────

let pairCounter = 0;
function nextPairId() {
  pairCounter += 1;
  return `minieyes-${String(pairCounter).padStart(6, '0')}`;
}

function buildPair(lane, imgPath, imgSha, draft) {
  return {
    pair_id: nextPairId(),
    image_path: imgPath,
    image_sha256: imgSha,
    source_lane: lane,
    instruction: SOURCE_LANES[lane].instruction,
    response: {
      terse: draft.description_terse,
      natural: draft.description_natural,
      structured: draft.description_structured,
    },
    grounding: draft.grounding,
    supervision_target: 'both',
    curator: null,                          // filled by 03_curate.py
    curated_at: null,
    filter_pass: true,
    needs_face_check: true,                 // §3.2 — Python stage confirms
    hre_gate_pass: null,                    // filled by 04_hre_gate.py
    draft_source: { model: ORANGEEYE_MODEL, url: ORANGEEYE_URL },
    drafted_at: new Date().toISOString(),
    doctrine_tags: [],                      // operator adds during curation
  };
}

function appendPair(lane, pair) {
  ensureDir(OUT_DIR);
  const out = path.join(OUT_DIR, `${lane}.jsonl`);
  fs.appendFileSync(out, JSON.stringify(pair) + '\n');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lane drivers
// ─────────────────────────────────────────────────────────────────────────────

function collectLaneImages(lane) {
  const cfg = SOURCE_LANES[lane];
  const seen = new Set();
  const out = [];
  const push = (p) => {
    const real = path.resolve(p);
    if (!seen.has(real)) { seen.add(real); out.push(real); }
  };
  for (const p of walk(cfg.root, (f) => cfg.glob.test(f))) push(p);
  if (lane === 'receipt') {
    for (const extra of EXTRA_RECEIPT_SCAN_ROOTS) {
      for (const p of walk(extra, (f) => cfg.glob.test(f))) push(p);
    }
  }
  return out;
}

async function runLane(lane, stats) {
  log(`[LANE] ${lane}: scanning ${SOURCE_LANES[lane].root}`);
  const images = collectLaneImages(lane);
  log(`[LANE] ${lane}: ${images.length} candidate images`);

  if (images.length === 0) {
    log(`[LANE] ${lane}: nothing to do — source root empty or missing.`);
    return;
  }

  const cap = ARG_LIMIT > 0 ? Math.min(ARG_LIMIT, images.length) : images.length;
  let admitted = 0, rejected = 0, errored = 0;

  for (let i = 0; i < cap; i++) {
    const imgPath = images[i];
    const filt = filterImage(imgPath, lane);
    if (!filt.admit) {
      const rejPath = writeRejection(imgPath, filt.rule, filt.detail);
      rejected += 1;
      log(`[REJ] ${path.basename(imgPath)} → ${filt.rule} (${rejPath})`);
      continue;
    }

    if (ARG_DRY) {
      log(`[DRY] would describe ${path.basename(imgPath)} [${lane}]`);
      admitted += 1;
      continue;
    }

    let imgSha;
    try { imgSha = sha256File(imgPath); }
    catch (err) { log(`[ERR] sha256 ${imgPath}: ${err.message}`); errored += 1; continue; }

    let draft;
    try {
      draft = await describeImage(imgPath, lane);
    } catch (err) {
      log(`[ERR] OrangeEye draft failed for ${path.basename(imgPath)}: ${err.message}`);
      errored += 1;
      continue;
    }

    const pair = buildPair(lane, imgPath, imgSha, draft);
    const outPath = appendPair(lane, pair);
    admitted += 1;
    if (admitted % 10 === 0 || admitted === 1) {
      log(`[OK ] ${pair.pair_id} ← ${path.basename(imgPath)} (lane=${lane}, out=${outPath})`);
    }
  }

  stats[lane] = { scanned: images.length, processed: cap, admitted, rejected, errored };
  log(`[LANE] ${lane}: admitted=${admitted} rejected=${rejected} errored=${errored}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(MINIEYES);
  ensureDir(OUT_DIR);
  ensureDir(REJECT_DIR);
  ensureDir(STAGE_DIR);

  log('────────────────────────────────────────────────────────────────────');
  log('MiniEyes Corpus Assembler — Disclosure ID ATOM-MINIEYES-ASSEMBLE-2026-0624');
  log(`Run ID: ${RUN_ID}`);
  log(`Lane:   ${ARG_LANE}    Limit: ${ARG_LIMIT || 'none'}    Dry: ${ARG_DRY}`);
  log(`Eye:    ${ORANGEEYE_MODEL} @ ${ORANGEEYE_URL}`);
  log('────────────────────────────────────────────────────────────────────');

  // Deferred-status gate. Operator must opt in explicitly.
  if (MINIEYES_CONFIRM !== 'yes-build-the-addendum') {
    log('[GATE] MINIEYES_CONFIRM is not set to "yes-build-the-addendum".');
    log('       MiniEyes is the deferred addendum visual model — build only when');
    log('       the primary visual stack (GLM-4.6V + Playwright + Chrome');
    log('       DevTools + UX tools) has demonstrably failed under real load.');
    log('       See ./corpus-strategy.md §1 and §9.');
    log('       To proceed, set MINIEYES_CONFIRM=yes-build-the-addendum and re-run.');
    flushLog();
    process.exit(2);
  }

  // Pre-flight: OrangeEye reachable (skipped on dry-run).
  if (!ARG_DRY) {
    const ok = await probeOrangeEye();
    if (!ok) { flushLog(); process.exit(1); }
  }

  const lanes = ARG_LANE === 'all'
    ? ['cockpit', 'diagram', 'receipt']
    : [ARG_LANE].filter((l) => SOURCE_LANES[l]);
  if (lanes.length === 0) {
    log(`[FATAL] Unknown lane: ${ARG_LANE}. Valid: cockpit, diagram, receipt, all.`);
    flushLog();
    process.exit(1);
  }

  const stats = {};
  for (const lane of lanes) {
    await runLane(lane, stats);
  }

  // Receipt.
  const receipt = {
    schema: 'minieyes.assemble-receipt.v0',
    run_id: RUN_ID,
    started_at: RUN_ID.replace(/-/g, ':').replace('T', 'T').slice(0, 19),
    finished_at: new Date().toISOString(),
    lanes_run: lanes,
    stats,
    out_dir: OUT_DIR,
    reject_dir: REJECT_DIR,
    eye: { model: ORANGEEYE_MODEL, url: ORANGEEYE_URL },
    dry_run: ARG_DRY,
    pair_total: pairCounter,
    log_path: RUN_LOG,
    next_stage: '03_curate.py (operator-only TUI for response style edits + grounding refinement)',
    notes: [
      'Every admitted pair is tagged needs_face_check=true and hre_gate_pass=null.',
      'Pairs are draft descriptions from OrangeEye. The operator curates and HRE-gates before training.',
      'Pipeline order: 01_ingest (this script) → 02_filter (face) → 03_curate → 04_hre_gate → 05_pack → 06_ledger.',
    ],
  };
  fs.writeFileSync(RUN_RECEIPT, JSON.stringify(receipt, null, 2));
  log(`[RECEIPT] ${RUN_RECEIPT}`);

  // Summary line for the operator.
  const totalAdmitted = Object.values(stats).reduce((s, v) => s + v.admitted, 0);
  const totalRejected = Object.values(stats).reduce((s, v) => s + v.rejected, 0);
  const totalErrored  = Object.values(stats).reduce((s, v) => s + v.errored,  0);
  log(`[DONE] admitted=${totalAdmitted} rejected=${totalRejected} errored=${totalErrored} run=${RUN_ID}`);
  flushLog();
}

main().catch((err) => {
  log(`[FATAL] ${err.stack || err.message}`);
  flushLog();
  process.exit(1);
});
