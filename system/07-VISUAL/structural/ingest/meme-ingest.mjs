// meme-ingest.mjs
//
// Enrich the imgflip meme corpus into an identity-store JSON matching the
// YouTube pipeline schema. For each concept dir under fixtures/meme-corpus/:
//   - Read template.jpg + variant-*.jpg/png
//   - Decode via extractImageRGB (ffmpeg) -> {R,G,B,width,height}
//   - Extract warm entities (useLoose: true), compute signatureForUnion
//   - Split: variants 1..(N-1) -> TRAINING, last variant -> HELD-OUT
//   - If only template.jpg exists (no variants), template is held-out AND training-empty
//
// Emits:
//   store-memes-enriched.json  (identity-store-v2 schema)
//   store-memes-heldout.json   ({ [label]: heldout_image_path })
//
// Honest receipts only. Reports actual counts on stderr and stdout.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "../prism.mjs";
import { candidatesForFrame, HUMAN_GRADE_WEIGHTS } from "../identity/recognize-human-grade.mjs";
import { attachSignaturesV2 } from "../identity/identity-store-v2.mjs";

const CORPUS_ROOT = "C:/AtomEons/Orange5/07-VISUAL/fixtures/meme-corpus";
const STORE_OUT   = path.join(CORPUS_ROOT, "store-memes-enriched.json");
const HELDOUT_OUT = path.join(CORPUS_ROOT, "store-memes-heldout.json");
const SOURCE      = "imgflip-top-100";
const NOW         = new Date().toISOString();

function log(scope, msg) {
  console.error(`[meme-ingest] ${scope}: ${msg}`);
}

function listConceptDirs(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function listImagesInDir(dir) {
  const files = fs.readdirSync(dir);
  const templates = [];
  const variants = [];
  for (const f of files) {
    const lo = f.toLowerCase();
    if (!/\.(jpg|jpeg|png)$/.test(lo)) continue;
    const full = path.join(dir, f);
    if (lo.startsWith("template.")) templates.push(full);
    else if (lo.startsWith("variant-")) variants.push(full);
  }
  // Deterministic order for variants (variant-1, variant-2, ...).
  variants.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { templates, variants };
}

async function buildSignatureForImage(imgPath) {
  const frame = await extractImageRGB(imgPath, { maxSize: 384 });
  // CANDIDATE PARITY: same generator as recognition (unions, both gates).
  // Also fixes the expanding-brain / left-exit failure class: text-heavy
  // templates that fail warm_loose now train via the "any" gate union.
  const cands = candidatesForFrame(frame);
  if (!cands.length) return { sigs: null, reason: "no_warm_entities" };
  return { sigs: cands, reason: "ok" };
}

const STORE = { labels: [] };
const HELDOUT = {};

const concepts = listConceptDirs(CORPUS_ROOT);
log("*", `concept dirs found: ${concepts.length}`);

let conceptsProcessed = 0;
let conceptsSkippedEmpty = 0;
let conceptsWithHeldoutOnly = 0;
let totalTrainSigs = 0;
let totalHeldout = 0;
let totalNoWarm = 0;
let totalNoUnionSig = 0;
let totalDecodeFail = 0;

for (const slug of concepts) {
  const dir = path.join(CORPUS_ROOT, slug);
  const { templates, variants } = listImagesInDir(dir);
  if (!templates.length && !variants.length) {
    log(slug, "no images -> skip");
    conceptsSkippedEmpty++;
    continue;
  }

  // Split policy:
  //   - variants.length >= 2: use variants[0..n-2] for training, variants[n-1] for held-out
  //   - variants.length == 1: training = template.jpg, held-out = variant-1
  //   - variants.length == 0: training = [], held-out = template.jpg (concept can only be evaluated, not trained)
  let trainPaths = [];
  let heldoutPath = null;
  if (variants.length >= 2) {
    trainPaths = variants.slice(0, -1);
    heldoutPath = variants[variants.length - 1];
  } else if (variants.length === 1) {
    trainPaths = templates.slice(0, 1);
    heldoutPath = variants[0];
  } else {
    // No variants: template is the only image. Log honestly.
    trainPaths = [];
    heldoutPath = templates[0];
    conceptsWithHeldoutOnly++;
  }

  const trainSigs = [];
  for (const p of trainPaths) {
    try {
      const { sigs, reason } = await buildSignatureForImage(p);
      if (sigs && sigs.length) {
        trainSigs.push(...sigs);
      } else {
        if (reason === "no_warm_entities") totalNoWarm++;
        else if (reason === "no_union_sig") totalNoUnionSig++;
        log(slug, `  train ${path.basename(p)} -> null (${reason})`);
      }
    } catch (e) {
      totalDecodeFail++;
      log(slug, `  train ${path.basename(p)} -> DECODE FAIL: ${e.message}`);
    }
  }

  if (trainSigs.length) {
    attachSignaturesV2(STORE, slug, trainSigs, SOURCE, NOW);
    // Give each label the human-grade weights (matches YouTube pipeline default)
    const row = STORE.labels[STORE.labels.length - 1];
    row.channel_weights = HUMAN_GRADE_WEIGHTS;
    totalTrainSigs += trainSigs.length;
  } else {
    log(slug, "  NO training sigs — label excluded from store");
  }

  if (heldoutPath) {
    HELDOUT[slug] = heldoutPath.replace(/\\/g, "/");
    totalHeldout++;
  }

  conceptsProcessed++;
  if (conceptsProcessed % 10 === 0) {
    log("*", `progress: ${conceptsProcessed}/${concepts.length} (train sigs=${totalTrainSigs})`);
    // Incremental save
    fs.writeFileSync(STORE_OUT,   JSON.stringify(STORE,   null, 2));
    fs.writeFileSync(HELDOUT_OUT, JSON.stringify(HELDOUT, null, 2));
  }
}

// Final save.
fs.writeFileSync(STORE_OUT,   JSON.stringify(STORE,   null, 2));
fs.writeFileSync(HELDOUT_OUT, JSON.stringify(HELDOUT, null, 2));

// ---- RECEIPTS ----
const labelsInStore = STORE.labels.length;
let sumSigs = 0;
for (const r of STORE.labels) sumSigs += r.signatures.length;
const avgSigsPerLabel = labelsInStore ? (sumSigs / labelsInStore) : 0;

// Sample sig key count (first label, first sig).
let sampleSigKeys = 0;
let sampleSigKeyList = [];
if (STORE.labels.length && STORE.labels[0].signatures.length) {
  const s = STORE.labels[0].signatures[0].sig;
  sampleSigKeyList = Object.keys(s);
  sampleSigKeys = sampleSigKeyList.length;
}

const receipt = {
  corpus_root: CORPUS_ROOT,
  store_path:   STORE_OUT,
  heldout_path: HELDOUT_OUT,
  concept_dirs_scanned: concepts.length,
  concepts_processed:   conceptsProcessed,
  concepts_skipped_empty: conceptsSkippedEmpty,
  concepts_with_heldout_only_no_training: conceptsWithHeldoutOnly,
  labels_in_store:      labelsInStore,
  total_training_sigs:  sumSigs,
  avg_sigs_per_label:   Number(avgSigsPerLabel.toFixed(3)),
  heldout_entries:      Object.keys(HELDOUT).length,
  sample_sig_key_count: sampleSigKeys,
  sample_sig_keys:      sampleSigKeyList,
  failures: {
    decode_fail:  totalDecodeFail,
    no_warm_entities: totalNoWarm,
    no_union_sig: totalNoUnionSig,
  },
  finished_at: new Date().toISOString(),
};

console.log(JSON.stringify(receipt, null, 2));
