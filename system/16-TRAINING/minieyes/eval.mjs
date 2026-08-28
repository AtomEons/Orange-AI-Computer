#!/usr/bin/env bun
// eval.mjs — MiniEyes 30-image bench harness (Bun)
//
// Disclosure ID: ATOM-MINIEYES-EVAL-2026-0624
// Status:        Deferred / Optional addendum. The harness exists so that
//                IF MiniEyes is ever fine-tuned, the promotion ceremony in
//                corpus-strategy.md §8 has a real eval surface to score
//                against — not a vibe check. Until corpus + adapter exist,
//                this script refuses to invent numbers.
//
// What this script is:
//   The frozen 30-image bench. Five categories × 6 images each:
//     1. cockpit-screenshot description (Orange5 cockpit state read)
//     2. AECode diagram parse           (node/edge identification)
//     3. receipt-image extract           (canonical receipt JSON shape)
//     4. ui-grounding                    (region bbox per described element)
//     5. chart-read                      (axis labels, series, headline value)
//
//   It walks ./eval-corpus/{category}/*.png, loads the matching ground-truth
//   JSON sidecar (same basename .json), runs the candidate model endpoint
//   (MiniEyes adapter loaded on top of base via vLLM/llama.cpp OpenAI-compat
//   server, OR the GLM-4.6V baseline for shadow comparison), scores per-image
//   with deterministic rules, then rolls up per-category accuracy and writes
//   a single eval receipt.
//
// What this script is NOT:
//   - It is not a trainer. Training is the Colab notebook (corpus-strategy §7).
//   - It is not the promotion. Promotion is corpus-strategy §8 — this script
//     produces ONE input (the eval report) to that ceremony. Side-by-side
//     shadow scoring, operator sign-off, and aec1 entry are separate steps.
//   - It is not a benchmark of someone else's model. The eval-corpus is
//     drawn from the MiniEyes holdout (corpus-strategy §5: 10% of every lane
//     reserved, never seen during fine-tuning).
//
// Run:
//   bun run 16-TRAINING/minieyes/eval.mjs \
//     [--target minieyes|baseline] \
//     [--endpoint http://127.0.0.1:8799/v1/chat/completions] \
//     [--model minieyes-qlora-v0] \
//     [--out ./eval-RUN.json] \
//     [--dry-run]
//
// Required env (if not passed on CLI):
//   MINIEYES_ENDPOINT      OpenAI-compatible chat endpoint serving the target
//                          model. No default — refuse to run without one.
//   MINIEYES_MODEL         Model name the endpoint expects.
//   MINIEYES_EVAL_CONFIRM  Must equal "yes-run-the-eval" to score. Forces
//                          the operator to acknowledge that this is the
//                          frozen holdout — no re-runs to chase a number.
//
// Mom's Law: no padding, no theater, no fake numbers. If the corpus is
// missing, the script stops at the corpus probe. If the endpoint is down,
// it stops at the boot probe. If a single image lacks a ground-truth
// sidecar, that image is reported as MISSING_GT and excluded from the
// per-category denominator — never silently scored as zero or one.
//

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// Paths & constants
// ─────────────────────────────────────────────────────────────────────────────

const ROOT     = path.resolve(process.env.ORANGE5_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const MINIEYES = path.join(ROOT, '16-TRAINING/minieyes');
const EVAL_DIR = path.join(MINIEYES, 'eval-corpus');

const CATEGORIES = {
  cockpit: {
    dir: 'cockpit',
    count: 6,
    instruction:
      'Describe the state of this Orange5 cockpit view. Identify the visible ' +
      'panels (dag-step-row, receipt-card, model-route-badge, router-asic-state ' +
      'pill). Report only observable state. Emit JSON: ' +
      '{"route": str, "panels": [{"name": str, "state": str}], "model_route": str}.',
    score_fn: 'scoreCockpit',
  },
  diagram: {
    dir: 'diagram',
    count: 6,
    instruction:
      'Parse this AECode diagram. Emit JSON: ' +
      '{"doctrine": str, "nodes": [str], "edges": [{"from": str, "to": str}]}. ' +
      'No interpretation beyond what is drawn.',
    score_fn: 'scoreDiagram',
  },
  receipt: {
    dir: 'receipt',
    count: 6,
    instruction:
      'Read this Orange5 receipt page. Emit the canonical receipt JSON: ' +
      '{"run_id": str, "step": str, "state": str, "model_route": str, ' +
      '"validator_status": str, "package_sha256": str}. ' +
      'Do not invent fields that are not visible on the page.',
    score_fn: 'scoreReceipt',
  },
  grounding: {
    dir: 'grounding',
    count: 6,
    instruction:
      'For each labeled element in the prompt, return its bounding box in ' +
      'pixel coordinates. Emit JSON: ' +
      '{"regions": [{"label": str, "bbox": [x0, y0, x1, y1]}]}. ' +
      'IoU >= 0.5 against ground truth counts as a hit.',
    score_fn: 'scoreGrounding',
  },
  chart: {
    dir: 'chart',
    count: 6,
    instruction:
      'Read this chart. Emit JSON: ' +
      '{"chart_type": str, "x_axis": str, "y_axis": str, ' +
      '"series": [str], "headline_value": str|number}. ' +
      'Headline value is the single number a reader would quote (peak, total, ' +
      'or final). No interpretation beyond what is plotted.',
    score_fn: 'scoreChart',
  },
};

const TOTAL_IMAGES = Object.values(CATEGORIES).reduce((a, c) => a + c.count, 0);
if (TOTAL_IMAGES !== 30) {
  // Compile-time invariant: 5 categories × 6 = 30. If this trips, the
  // category table was edited without updating the bench size.
  console.error(`[FATAL] category counts sum to ${TOTAL_IMAGES}, expected 30`);
  process.exit(2);
}

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
const ARG_TARGET   = arg('--target', 'minieyes');           // 'minieyes' | 'baseline'
const ARG_ENDPOINT = arg('--endpoint', process.env.MINIEYES_ENDPOINT || '');
const ARG_MODEL    = arg('--model',    process.env.MINIEYES_MODEL    || '');
const ARG_OUT      = arg('--out', '');
const ARG_DRY      = !!arg('--dry-run', false);
const CONFIRM      = process.env.MINIEYES_EVAL_CONFIRM || '';

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_PATH = ARG_OUT && typeof ARG_OUT === 'string'
  ? path.resolve(ARG_OUT)
  : path.join(MINIEYES, `eval-${ARG_TARGET}-${RUN_ID}.json`);

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

const logLines = [];
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  logLines.push(stamped);
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight: corpus + endpoint
// ─────────────────────────────────────────────────────────────────────────────

function preflightCorpus() {
  if (!fs.existsSync(EVAL_DIR)) {
    log(`[FATAL] eval-corpus missing at ${EVAL_DIR}.`);
    log('        The frozen 30-image holdout has not been packed yet.');
    log('        See corpus-strategy.md §5 (10% holdout) and §6 stage 05_pack.');
    log('        This harness will not invent images. Stopping.');
    process.exit(3);
  }
  const found = {};
  let missing = 0;
  for (const [cat, spec] of Object.entries(CATEGORIES)) {
    const catDir = path.join(EVAL_DIR, spec.dir);
    if (!fs.existsSync(catDir)) {
      log(`[FATAL] eval-corpus/${spec.dir} missing.`);
      missing++;
      continue;
    }
    const images = fs.readdirSync(catDir)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .sort();
    found[cat] = images;
    if (images.length < spec.count) {
      log(`[FATAL] category ${cat}: found ${images.length} images, need ${spec.count}.`);
      missing++;
    } else if (images.length > spec.count) {
      log(`[WARN] category ${cat}: found ${images.length} images, expected exactly ${spec.count}. Using first ${spec.count}.`);
    }
  }
  if (missing > 0) {
    log('        Refusing to score a partial bench. Stopping.');
    process.exit(3);
  }
  return found;
}

async function preflightEndpoint(endpoint) {
  // Health probe: a simple /v1/models call if the endpoint follows the
  // OpenAI shape. We accept any 2xx; we do not verify the model identity
  // since some local servers (llama.cpp, vLLM) name models inconsistently.
  if (!endpoint) {
    log('[FATAL] no --endpoint provided and MINIEYES_ENDPOINT unset.');
    log('        Refusing to score against an unspecified target. Stopping.');
    process.exit(4);
  }
  try {
    const u = new URL(endpoint);
    const probe = `${u.protocol}//${u.host}/v1/models`;
    const res = await fetch(probe, { method: 'GET' });
    if (!res.ok) {
      log(`[FATAL] endpoint probe ${probe} returned ${res.status}.`);
      process.exit(4);
    }
    log(`[ok] endpoint reachable: ${probe}`);
  } catch (err) {
    log(`[FATAL] endpoint unreachable: ${err.message || err}`);
    log('        Bring the local VLM server up before running the eval.');
    process.exit(4);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model call
// ─────────────────────────────────────────────────────────────────────────────

async function callModel(endpoint, model, imagePath, instruction) {
  const buf = fs.readFileSync(imagePath);
  const b64 = buf.toString('base64');
  const ext = path.extname(imagePath).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction + ' Respond with JSON only, no prose.' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 800,
  };
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const dt = Date.now() - t0;
  if (!res.ok) {
    return { ok: false, status: res.status, error: await res.text(), latency_ms: dt };
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? '';
  return { ok: true, content, latency_ms: dt };
}

function parseJsonLoose(s) {
  if (!s || typeof s !== 'string') return null;
  // Strip code fences if the model added them.
  const trimmed = s.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try { return JSON.parse(trimmed); } catch {}
  // Fall back to the first { … } block.
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scorers (deterministic, per-category)
// ─────────────────────────────────────────────────────────────────────────────

function strEq(a, b) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function arrIncl(haystack, needle) {
  if (!Array.isArray(haystack)) return false;
  return haystack.some(h => strEq(h, needle));
}

// scoreCockpit: required fields = route, panels[].name, panels[].state, model_route.
// A hit is awarded when (a) route matches, (b) >=80% of GT panels match name+state,
// and (c) model_route matches. Partial credit not allowed — Mom's Law: real or not.
function scoreCockpit(pred, gt) {
  if (!pred || typeof pred !== 'object') return { hit: 0, reason: 'no_json' };
  if (!strEq(pred.route, gt.route)) return { hit: 0, reason: 'route_mismatch' };
  if (!strEq(pred.model_route, gt.model_route)) return { hit: 0, reason: 'model_route_mismatch' };
  const gtPanels = Array.isArray(gt.panels) ? gt.panels : [];
  const pPanels  = Array.isArray(pred.panels) ? pred.panels : [];
  if (gtPanels.length === 0) return { hit: 0, reason: 'gt_panels_empty' };
  let matched = 0;
  for (const g of gtPanels) {
    const m = pPanels.find(p => strEq(p?.name, g.name) && strEq(p?.state, g.state));
    if (m) matched++;
  }
  const frac = matched / gtPanels.length;
  if (frac >= 0.8) return { hit: 1, reason: `panels_${matched}/${gtPanels.length}` };
  return { hit: 0, reason: `panels_${matched}/${gtPanels.length}` };
}

// scoreDiagram: hit when doctrine matches AND node set Jaccard >= 0.7 AND edge
// set Jaccard >= 0.7 (edges normalized to "from->to" lowercase).
function jaccard(aSet, bSet) {
  if (aSet.size === 0 && bSet.size === 0) return 1;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  return inter / (aSet.size + bSet.size - inter || 1);
}

function scoreDiagram(pred, gt) {
  if (!pred || typeof pred !== 'object') return { hit: 0, reason: 'no_json' };
  if (!strEq(pred.doctrine, gt.doctrine)) return { hit: 0, reason: 'doctrine_mismatch' };
  const gtN = new Set((gt.nodes || []).map(n => String(n).trim().toLowerCase()));
  const pN  = new Set((pred.nodes || []).map(n => String(n).trim().toLowerCase()));
  const jN  = jaccard(pN, gtN);
  const norm = e => `${String(e?.from || '').trim().toLowerCase()}->${String(e?.to || '').trim().toLowerCase()}`;
  const gtE = new Set((gt.edges || []).map(norm));
  const pE  = new Set((pred.edges || []).map(norm));
  const jE  = jaccard(pE, gtE);
  if (jN >= 0.7 && jE >= 0.7) return { hit: 1, reason: `J(nodes)=${jN.toFixed(2)} J(edges)=${jE.toFixed(2)}` };
  return { hit: 0, reason: `J(nodes)=${jN.toFixed(2)} J(edges)=${jE.toFixed(2)}` };
}

// scoreReceipt: required exact-string fields = run_id, step, state, model_route,
// validator_status, package_sha256. All six must match. The whole point of a
// receipt is exactness; partial credit poisons the discipline.
function scoreReceipt(pred, gt) {
  if (!pred || typeof pred !== 'object') return { hit: 0, reason: 'no_json' };
  const fields = ['run_id', 'step', 'state', 'model_route', 'validator_status', 'package_sha256'];
  const miss = [];
  for (const f of fields) if (!strEq(pred[f], gt[f])) miss.push(f);
  if (miss.length === 0) return { hit: 1, reason: 'all_six_exact' };
  return { hit: 0, reason: `miss:${miss.join(',')}` };
}

// scoreGrounding: hit when, for every GT region (by label), the predicted bbox
// has IoU >= 0.5 with the GT bbox. Bbox format: [x0, y0, x1, y1] in pixels.
function iou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return 0;
  const [ax0, ay0, ax1, ay1] = a;
  const [bx0, by0, bx1, by1] = b;
  const ix0 = Math.max(ax0, bx0);
  const iy0 = Math.max(ay0, by0);
  const ix1 = Math.min(ax1, bx1);
  const iy1 = Math.min(ay1, by1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const interArea = (ix1 - ix0) * (iy1 - iy0);
  const aArea = Math.max(0, ax1 - ax0) * Math.max(0, ay1 - ay0);
  const bArea = Math.max(0, bx1 - bx0) * Math.max(0, by1 - by0);
  const unionArea = aArea + bArea - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
}

function scoreGrounding(pred, gt) {
  if (!pred || typeof pred !== 'object') return { hit: 0, reason: 'no_json' };
  const gtR = Array.isArray(gt.regions) ? gt.regions : [];
  const pR  = Array.isArray(pred.regions) ? pred.regions : [];
  if (gtR.length === 0) return { hit: 0, reason: 'gt_regions_empty' };
  let hits = 0;
  const details = [];
  for (const g of gtR) {
    const p = pR.find(r => strEq(r?.label, g.label));
    const v = p ? iou(p.bbox, g.bbox) : 0;
    details.push(`${g.label}:${v.toFixed(2)}`);
    if (v >= 0.5) hits++;
  }
  const ok = hits === gtR.length;
  return { hit: ok ? 1 : 0, reason: `iou[${details.join(' ')}]` };
}

// scoreChart: hit when chart_type, x_axis, y_axis all match AND headline_value
// is within 5% relative tolerance (or exact string match for non-numeric
// headlines like "Q4 2025"). Series set Jaccard >= 0.7.
function scoreChart(pred, gt) {
  if (!pred || typeof pred !== 'object') return { hit: 0, reason: 'no_json' };
  if (!strEq(pred.chart_type, gt.chart_type)) return { hit: 0, reason: 'chart_type_mismatch' };
  if (!strEq(pred.x_axis, gt.x_axis))         return { hit: 0, reason: 'x_axis_mismatch' };
  if (!strEq(pred.y_axis, gt.y_axis))         return { hit: 0, reason: 'y_axis_mismatch' };
  const gtS = new Set((gt.series || []).map(s => String(s).trim().toLowerCase()));
  const pS  = new Set((pred.series || []).map(s => String(s).trim().toLowerCase()));
  const jS  = jaccard(pS, gtS);
  if (jS < 0.7) return { hit: 0, reason: `J(series)=${jS.toFixed(2)}` };
  const gtH = gt.headline_value;
  const pH  = pred.headline_value;
  const bothNum = typeof gtH === 'number' && (typeof pH === 'number' || (typeof pH === 'string' && !isNaN(parseFloat(pH))));
  if (bothNum) {
    const pn = typeof pH === 'number' ? pH : parseFloat(pH);
    const tol = Math.abs(gtH) * 0.05;
    if (Math.abs(pn - gtH) <= tol) return { hit: 1, reason: `headline ${pn} ~= ${gtH}` };
    return { hit: 0, reason: `headline ${pn} vs ${gtH}` };
  }
  if (strEq(pH, gtH)) return { hit: 1, reason: 'headline_exact' };
  return { hit: 0, reason: `headline ${JSON.stringify(pH)} vs ${JSON.stringify(gtH)}` };
}

const SCORERS = {
  scoreCockpit, scoreDiagram, scoreReceipt, scoreGrounding, scoreChart,
};

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log(`MiniEyes eval — target=${ARG_TARGET} model=${ARG_MODEL || '(unset)'} dry-run=${ARG_DRY}`);
  log(`disclosure: ATOM-MINIEYES-EVAL-2026-0624`);

  if (!ARG_DRY && CONFIRM !== 'yes-run-the-eval') {
    log('[FATAL] MINIEYES_EVAL_CONFIRM != "yes-run-the-eval".');
    log('        The eval-corpus is the frozen holdout. Re-running for a');
    log('        better number is theater. Set the env var deliberately or');
    log('        use --dry-run to inspect the harness without scoring.');
    process.exit(1);
  }

  const corpus = preflightCorpus();
  log(`[ok] eval-corpus probed: ${Object.values(corpus).reduce((a, b) => a + b.length, 0)} images across ${Object.keys(corpus).length} categories`);

  if (!ARG_DRY) {
    await preflightEndpoint(ARG_ENDPOINT);
    if (!ARG_MODEL) {
      log('[FATAL] no --model and MINIEYES_MODEL unset. Stopping.');
      process.exit(4);
    }
  } else {
    log('[dry-run] skipping endpoint probe and model calls');
  }

  const perCategory = {};
  const perImage = [];
  let totalHits = 0;
  let totalScored = 0;
  let totalMissingGt = 0;
  let totalErrors = 0;
  const latencies = [];

  for (const [cat, spec] of Object.entries(CATEGORIES)) {
    const catDir = path.join(EVAL_DIR, spec.dir);
    const images = corpus[cat].slice(0, spec.count);
    const scorer = SCORERS[spec.score_fn];
    let hits = 0;
    let scored = 0;
    let missingGt = 0;
    let errors = 0;

    for (const fname of images) {
      const imgPath = path.join(catDir, fname);
      const gtPath  = path.join(catDir, fname.replace(/\.(png|jpg|jpeg|webp)$/i, '.json'));
      const imageRecord = {
        category: cat,
        image: fname,
        image_sha256: sha256File(imgPath),
        gt_path: gtPath,
      };

      if (!fs.existsSync(gtPath)) {
        imageRecord.status = 'MISSING_GT';
        imageRecord.hit = null;
        missingGt++;
        perImage.push(imageRecord);
        log(`  [${cat}] ${fname} → MISSING_GT (excluded from denominator)`);
        continue;
      }

      let gt;
      try { gt = JSON.parse(fs.readFileSync(gtPath, 'utf8')); }
      catch (err) {
        imageRecord.status = 'GT_PARSE_ERROR';
        imageRecord.hit = null;
        imageRecord.error = String(err.message || err);
        missingGt++;
        perImage.push(imageRecord);
        log(`  [${cat}] ${fname} → GT_PARSE_ERROR (${err.message})`);
        continue;
      }

      if (ARG_DRY) {
        imageRecord.status = 'DRY_RUN';
        imageRecord.hit = null;
        perImage.push(imageRecord);
        continue;
      }

      let resp;
      try {
        resp = await callModel(ARG_ENDPOINT, ARG_MODEL, imgPath, spec.instruction);
      } catch (err) {
        imageRecord.status = 'CALL_ERROR';
        imageRecord.hit = 0;
        imageRecord.error = String(err.message || err);
        errors++;
        scored++;
        perImage.push(imageRecord);
        log(`  [${cat}] ${fname} → CALL_ERROR (${err.message})`);
        continue;
      }
      if (!resp.ok) {
        imageRecord.status = 'HTTP_ERROR';
        imageRecord.hit = 0;
        imageRecord.error = `${resp.status} ${resp.error?.slice(0, 200) || ''}`;
        imageRecord.latency_ms = resp.latency_ms;
        errors++;
        scored++;
        perImage.push(imageRecord);
        log(`  [${cat}] ${fname} → HTTP ${resp.status}`);
        continue;
      }
      latencies.push(resp.latency_ms);
      const pred = parseJsonLoose(resp.content);
      const result = scorer(pred, gt);
      imageRecord.status = 'SCORED';
      imageRecord.hit = result.hit;
      imageRecord.reason = result.reason;
      imageRecord.latency_ms = resp.latency_ms;
      imageRecord.pred_excerpt = (resp.content || '').slice(0, 300);
      hits += result.hit;
      scored++;
      perImage.push(imageRecord);
      log(`  [${cat}] ${fname} → ${result.hit ? 'HIT ' : 'MISS'} (${result.reason}) ${resp.latency_ms}ms`);
    }

    const denom = scored;
    const accuracy = denom > 0 ? hits / denom : null;
    perCategory[cat] = {
      images_total: images.length,
      images_scored: scored,
      images_missing_gt: missingGt,
      images_errored: errors,
      hits,
      accuracy,
    };
    totalHits += hits;
    totalScored += scored;
    totalMissingGt += missingGt;
    totalErrors += errors;
    log(`[${cat}] ${hits}/${scored} = ${accuracy == null ? 'n/a' : (accuracy * 100).toFixed(1) + '%'} (missing_gt=${missingGt}, errors=${errors})`);
  }

  latencies.sort((a, b) => a - b);
  const pct = q => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : null;

  const overall = {
    images_total: TOTAL_IMAGES,
    images_scored: totalScored,
    images_missing_gt: totalMissingGt,
    images_errored: totalErrors,
    hits: totalHits,
    accuracy: totalScored > 0 ? totalHits / totalScored : null,
    latency_ms_p50: pct(0.50),
    latency_ms_p95: pct(0.95),
    latency_ms_mean: latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null,
  };

  const receipt = {
    disclosure_id: 'ATOM-MINIEYES-EVAL-2026-0624',
    run_id: RUN_ID,
    target: ARG_TARGET,
    endpoint: ARG_ENDPOINT || null,
    model: ARG_MODEL || null,
    dry_run: ARG_DRY,
    started_at: new Date().toISOString(),
    overall,
    per_category: perCategory,
    per_image: perImage,
    log: logLines,
  };

  try {
    fs.writeFileSync(OUT_PATH, JSON.stringify(receipt, null, 2));
    log(`[ok] eval receipt written: ${OUT_PATH}`);
  } catch (err) {
    log(`[FATAL] could not write receipt: ${err.message}`);
    process.exit(5);
  }

  // Console roll-up
  console.log('');
  console.log('───────── MiniEyes eval rollup ─────────');
  console.log(`target:   ${ARG_TARGET}`);
  console.log(`model:    ${ARG_MODEL || '(dry-run)'}`);
  console.log(`run_id:   ${RUN_ID}`);
  console.log('');
  for (const [cat, r] of Object.entries(perCategory)) {
    const acc = r.accuracy == null ? 'n/a' : (r.accuracy * 100).toFixed(1) + '%';
    console.log(`  ${cat.padEnd(10)} ${String(r.hits).padStart(2)}/${String(r.images_scored).padStart(2)}  ${acc.padStart(6)}   (missing_gt=${r.images_missing_gt} errors=${r.images_errored})`);
  }
  console.log('');
  const acc = overall.accuracy == null ? 'n/a' : (overall.accuracy * 100).toFixed(1) + '%';
  console.log(`  overall    ${String(overall.hits).padStart(2)}/${String(overall.images_scored).padStart(2)}  ${acc.padStart(6)}`);
  if (overall.latency_ms_mean != null) {
    console.log(`  latency    mean=${overall.latency_ms_mean}ms p50=${overall.latency_ms_p50}ms p95=${overall.latency_ms_p95}ms`);
  }
  console.log('');
  console.log('Mom\'s Law: the number above is the number. Do not re-run for a better one.');
  console.log('───────────────────────────────────────');

  // Exit code reflects whether the run actually scored everything it
  // was asked to. 0 = all images either scored or honestly missing-GT.
  // 1 = at least one image errored out (HTTP, network, parser). The
  // promotion ceremony reads exit code to gate downstream steps.
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  log(`[FATAL] ${err.stack || err.message || err}`);
  process.exit(99);
});
