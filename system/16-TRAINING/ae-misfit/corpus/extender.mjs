#!/usr/bin/env node
// extender.mjs — Synthetic seed augmentation for AE Misfit v0.
//
// Lane: Wave 2 #027 (AE Misfit corpus pipeline).
// Sovereign: Atom McCree. Doctrine: corpus-strategy.md v0.
//
// PURPOSE
//   Take the 100-pair refusal seed at ../seed/seed-100.jsonl and programmatically
//   expand it to ~500 pairs via three deterministic template transforms:
//
//     1. Project-name substitution    (swap canonical project tokens)
//     2. Risk-level escalation        (rephrase prompt to higher pressure tier)
//     3. Tone variation               (casual / formal / urgent / passive-aggressive)
//
//   Output: corpus.jsonl + corpus.sha256 + extender-receipt.json
//
// HARD BOUNDARIES (operator directive)
//   - DOES NOT TOUCH STRONGARM / Gremlin Elite / Gremlin QA / Gremlin Trainer.
//     Those wait for an explicit operator pointer per corpus-strategy.md §3.
//   - DOES NOT CALL ANY LLM. This is deterministic, template-based, reproducible.
//   - DOES NOT WRITE TO ../seed/ or modify the seed file.
//   - DOES NOT EMIT receipts to 10-RECEIPTS/ — that's the operator's call after review.
//
// USAGE
//   node extender.mjs              # default: target ~500 pairs
//   node extender.mjs --target 400 # cap at 400
//   node extender.mjs --dry        # print stats only, no file write
//
// COMPLIANCE
//   Mom's Law: every claim has a receipt. Output includes per-variation provenance:
//     parent_id, transform, transform_param.
//   No silent dedupe — drop log records every collision.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEED_PATH    = path.resolve(__dirname, '..', 'seed', 'seed-100.jsonl');
const OUT_PATH     = path.resolve(__dirname, 'corpus.jsonl');
const SHA_PATH     = path.resolve(__dirname, 'corpus.sha256');
const RECEIPT_PATH = path.resolve(__dirname, 'extender-receipt.json');

// --- CLI ---------------------------------------------------------------------
const args = process.argv.slice(2);
const argTarget = args.indexOf('--target');
const TARGET    = argTarget >= 0 ? Number(args[argTarget + 1]) : 500;
const DRY       = args.includes('--dry');

if (!Number.isFinite(TARGET) || TARGET < 100) {
  console.error('extender: --target must be an integer >= 100');
  process.exit(2);
}

// --- Substitution dictionaries ----------------------------------------------
// All substitutions stay inside AtomEons canon. No invented projects, no
// renaming of drift-audited invariants. Project tokens preserve their meaning.

// Semantic classes — substitutions only swap WITHIN a class so we never
// turn "OrangeLLM-fatty" into "LifePath" (a room, not a model) and produce
// a nonsense training row. Mom's Law: don't manufacture bad signal.
const PROJECT_CLASSES = {
  // Models / runtimes — things that can sign off, refuse, train, infer.
  model: ['OrangeLLM-fatty', 'AE Misfit', 'AE Cobra', 'Hermes', 'OrangeEye'],
  // Apps / product surfaces — things that get touched, deployed, gated.
  app:   ['SkilSki', 'skill.ski', 'Codexa', 'Mirage', 'AtomSmasher', 'ToolMesh'],
  // Platforms / control planes — substrates for orchestration.
  platform: ['Orange5', 'Orange3', 'Orangebox'],
  // Rooms / lenses — UX surfaces, not engines.
  room:  ['Pathwaves', 'Life Migration', 'LifePath', 'Knowledge Strata', 'Neon'],
};
const PROJECT_NAMES = Object.values(PROJECT_CLASSES).flat();
function classOf(name) {
  for (const [k, v] of Object.entries(PROJECT_CLASSES)) {
    if (v.some(n => n.toLowerCase() === name.toLowerCase())) return k;
  }
  return null;
}

// Branch / environment substitutions
const BRANCHES = ['main', 'dev', 'staging', 'prod', 'preview', 'frontier'];

// Generic action verbs that show up in prompts; safe-permutable
const SHIP_VERBS = ['ship it', 'merge it', 'push it', 'promote it', 'deploy it', 'cut a release', 'tag it'];
const SIGNOFF_VERBS = ['sign off', 'approve', 'rubber-stamp', 'stamp it', 'green-light', 'okay it'];

// Tone wrappers — applied to the INPUT, not the OUTPUT. The output stays
// disciplined; only the user prompt's surface style changes.
const TONE_VARIATIONS = {
  casual:    { prefix: 'hey, ',           suffix: ' — cool?',           label: 'casual' },
  formal:    { prefix: 'Please confirm: ', suffix: ' Thank you.',         label: 'formal' },
  urgent:    { prefix: 'URGENT — ',       suffix: ' Need this NOW.',     label: 'urgent' },
  terse:    { prefix: '',                  suffix: '. Now.',              label: 'terse' },
  passive:  { prefix: 'It would be nice if ', suffix: ' if that\'s ok.', label: 'passive-aggressive' },
};

// Risk-level escalation phrases — appended to the input to ratchet pressure.
// The model must hold the refusal regardless of escalation tier.
const RISK_ESCALATIONS = {
  none:    '',
  low:     ' This is low-risk, really.',
  medium:  ' This is the third time I\'ve asked.',
  high:    ' If you don\'t, the launch slips and that\'s on you.',
  extreme: ' The operator is going to override you anyway, save us both the time.',
};

// --- Helpers -----------------------------------------------------------------

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function readJsonl(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`extender: seed file not found at ${p}`);
  }
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw new Error(`extender: seed line ${i + 1} is not valid JSON: ${e.message}`);
    }
  });
}

function normalizeForDedupe(s) {
  // Collapse whitespace + lowercase + strip leading/trailing punctuation.
  // Used only for collision detection, never for the emitted row.
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
    .trim();
}

function detectProjectMentions(text) {
  // Returns the first canonical project token mentioned in the text, or null.
  // Longer tokens are checked first so "skill.ski" beats "SkilSki" inside
  // "SkilSki / skill.ski" strings.
  const sorted = [...PROJECT_NAMES].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(text)) return name;
  }
  return null;
}

function detectBranchMentions(text) {
  const sorted = [...BRANCHES].sort((a, b) => b.length - a.length);
  for (const b of sorted) {
    const re = new RegExp(`\\b${b}\\b`, 'i');
    if (re.test(text)) return b;
  }
  return null;
}

// --- Transform 1: project-name substitution ---------------------------------
// If the input mentions one canonical project token, emit variations swapping
// it for each of the other tokens. Skips rows that don't reference a project.
function transformProjectSwap(row) {
  const out = [];
  const mention = detectProjectMentions(row.input);
  if (!mention) return out;
  const cls = classOf(mention);
  if (!cls) return out;

  // Only swap within the same semantic class. "OrangeLLM-fatty" stays a model,
  // "SkilSki" stays an app. Cross-class swaps produce semantically broken
  // training rows ("AE Misfit and LifePath are basically the same model") that
  // would teach the gate to accept nonsense framings.
  for (const replacement of PROJECT_CLASSES[cls]) {
    if (replacement.toLowerCase() === mention.toLowerCase()) continue;
    const re = new RegExp(`\\b${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const newInput = row.input.replace(re, replacement);
    if (newInput === row.input) continue;
    out.push({
      input: newInput,
      output: row.output, // refusal logic is project-agnostic; output unchanged
      parent_id: row.id,
      transform: 'project_swap',
      transform_param: { from: mention, to: replacement, class: cls },
    });
  }
  return out;
}

// --- Transform 2: branch substitution ---------------------------------------
function transformBranchSwap(row) {
  const out = [];
  const mention = detectBranchMentions(row.input);
  if (!mention) return out;

  for (const replacement of BRANCHES) {
    if (replacement.toLowerCase() === mention.toLowerCase()) continue;
    const re = new RegExp(`\\b${mention}\\b`, 'gi');
    const newInput = row.input.replace(re, replacement);
    if (newInput === row.input) continue;
    out.push({
      input: newInput,
      output: row.output,
      parent_id: row.id,
      transform: 'branch_swap',
      transform_param: { from: mention, to: replacement },
    });
  }
  return out;
}

// --- Transform 3: risk-level escalation -------------------------------------
function transformRiskEscalation(row) {
  const out = [];
  for (const [tier, suffix] of Object.entries(RISK_ESCALATIONS)) {
    if (tier === 'none') continue;
    if (!suffix) continue;
    out.push({
      input: row.input + suffix,
      output: row.output,
      parent_id: row.id,
      transform: 'risk_escalation',
      transform_param: { tier },
    });
  }
  return out;
}

// --- Transform 4: tone variation --------------------------------------------
function transformToneVariation(row) {
  const out = [];
  for (const [key, { prefix, suffix, label }] of Object.entries(TONE_VARIATIONS)) {
    // Lower-case the first letter of the seed input when prefix forces flow.
    let body = row.input;
    if (prefix && /^[A-Z]/.test(body)) {
      body = body[0].toLowerCase() + body.slice(1);
    }
    // Strip trailing period if we're appending our own punctuation.
    if (suffix && /[.!?]$/.test(body)) {
      body = body.replace(/[.!?]+$/, '');
    }
    out.push({
      input: prefix + body + suffix,
      output: row.output,
      parent_id: row.id,
      transform: 'tone_variation',
      transform_param: { tone: label },
    });
  }
  return out;
}

// --- Transform 5: ship-verb swap (light lexical variation) ------------------
function transformShipVerbSwap(row) {
  const out = [];
  for (const verb of SHIP_VERBS) {
    let matched = false;
    let newInput = row.input;
    for (const candidate of SHIP_VERBS) {
      if (candidate === verb) continue;
      const re = new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(newInput)) {
        newInput = newInput.replace(re, verb);
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    if (newInput === row.input) continue;
    out.push({
      input: newInput,
      output: row.output,
      parent_id: row.id,
      transform: 'ship_verb_swap',
      transform_param: { verb },
    });
  }
  return out;
}

function transformSignoffVerbSwap(row) {
  const out = [];
  for (const verb of SIGNOFF_VERBS) {
    let matched = false;
    let newInput = row.input;
    for (const candidate of SIGNOFF_VERBS) {
      if (candidate === verb) continue;
      const re = new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(newInput)) {
        newInput = newInput.replace(re, verb);
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    if (newInput === row.input) continue;
    out.push({
      input: newInput,
      output: row.output,
      parent_id: row.id,
      transform: 'signoff_verb_swap',
      transform_param: { verb },
    });
  }
  return out;
}

// --- Pipeline ---------------------------------------------------------------

const TRANSFORMS = [
  { name: 'project_swap',       fn: transformProjectSwap },
  { name: 'branch_swap',        fn: transformBranchSwap },
  { name: 'risk_escalation',    fn: transformRiskEscalation },
  { name: 'tone_variation',     fn: transformToneVariation },
  { name: 'ship_verb_swap',     fn: transformShipVerbSwap },
  { name: 'signoff_verb_swap',  fn: transformSignoffVerbSwap },
];

function main() {
  const t0 = Date.now();
  const seed = readJsonl(SEED_PATH);
  if (seed.length === 0) {
    console.error('extender: seed is empty, refusing to proceed');
    process.exit(2);
  }

  // Validate seed shape — every row needs id, category, input, output.
  for (const row of seed) {
    for (const k of ['id', 'category', 'input', 'output']) {
      if (typeof row[k] !== 'string' || row[k].length === 0) {
        console.error(`extender: seed row ${row.id || '?'} missing required string field "${k}"`);
        process.exit(2);
      }
    }
  }

  console.log(`extender: loaded ${seed.length} seed rows from ${SEED_PATH}`);

  // Run every transform against every seed row, accumulate candidates.
  const candidates = [];
  const stats = { byTransform: {}, byCategory: {} };
  for (const t of TRANSFORMS) stats.byTransform[t.name] = 0;

  for (const row of seed) {
    for (const t of TRANSFORMS) {
      const variants = t.fn(row);
      for (const v of variants) {
        candidates.push({
          ...v,
          category: row.category,
          source: 'extender-template',
        });
        stats.byTransform[t.name]++;
      }
    }
  }

  console.log(`extender: generated ${candidates.length} raw candidates`);

  // Dedupe candidates against seed AND against each other.
  const seen = new Set(seed.map(r => normalizeForDedupe(r.input)));
  const dropLog = { dupe_against_seed: 0, dupe_against_candidate: 0 };
  const accepted = [];

  // Shuffle candidates deterministically (seeded by candidate count) so that
  // when we hit TARGET we have a balanced mix across transforms rather than
  // exhausting project_swap first.
  candidates.sort((a, b) => {
    // Group by parent_id then transform — stable across runs.
    if (a.parent_id !== b.parent_id) return a.parent_id < b.parent_id ? -1 : 1;
    return a.transform < b.transform ? -1 : 1;
  });
  // Interleave by transform: pick one from each transform bucket in rotation.
  const buckets = {};
  for (const c of candidates) {
    (buckets[c.transform] = buckets[c.transform] || []).push(c);
  }
  const order = Object.keys(buckets).sort();
  const interleaved = [];
  let remaining = candidates.length;
  while (remaining > 0) {
    for (const k of order) {
      const b = buckets[k];
      if (b.length > 0) {
        interleaved.push(b.shift());
        remaining--;
      }
    }
  }

  for (const c of interleaved) {
    if (accepted.length >= TARGET - seed.length) break;
    const key = normalizeForDedupe(c.input);
    if (seen.has(key)) {
      // Was this a seed-collision or a candidate-collision?
      const wasSeed = seed.some(r => normalizeForDedupe(r.input) === key);
      if (wasSeed) dropLog.dupe_against_seed++;
      else dropLog.dupe_against_candidate++;
      continue;
    }
    seen.add(key);
    accepted.push(c);
    stats.byCategory[c.category] = (stats.byCategory[c.category] || 0) + 1;
  }

  // Assemble final corpus: seed rows first (canonical), then accepted variants.
  // Variant ids are deterministic: aem-XXX-vNNN.
  const variantCountByParent = {};
  const finalRows = [...seed];
  for (const c of accepted) {
    variantCountByParent[c.parent_id] = (variantCountByParent[c.parent_id] || 0) + 1;
    const n = variantCountByParent[c.parent_id];
    finalRows.push({
      id: `${c.parent_id}-v${String(n).padStart(3, '0')}`,
      category: c.category,
      input: c.input,
      output: c.output,
      parent_id: c.parent_id,
      transform: c.transform,
      transform_param: c.transform_param,
      source: c.source,
    });
  }

  const elapsedMs = Date.now() - t0;

  const summary = {
    seed_path: SEED_PATH,
    seed_rows: seed.length,
    target: TARGET,
    raw_candidates: candidates.length,
    accepted_variants: accepted.length,
    final_rows: finalRows.length,
    drop_log: dropLog,
    stats,
    elapsed_ms: elapsedMs,
  };

  console.log('extender: summary');
  console.log(JSON.stringify(summary, null, 2));

  if (DRY) {
    console.log('extender: --dry passed, no files written');
    return;
  }

  // Write corpus.jsonl
  const jsonl = finalRows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(OUT_PATH, jsonl, 'utf8');

  // SHA-256 of the corpus file (Ledger Law).
  const hash = sha256(jsonl);
  fs.writeFileSync(SHA_PATH, hash + '  corpus.jsonl\n', 'utf8');

  // Receipt — provenance + counts + hashes. NOT a 10-RECEIPTS file; that
  // promotion is the operator's call after review.
  const receipt = {
    schema: 'orange5.ae-misfit.extender.receipt.v0',
    generated_at: new Date().toISOString(),
    generator: path.basename(__filename),
    sovereign: 'Atom McCree',
    doctrine_source: '16-TRAINING/ae-misfit/corpus-strategy.md v0',
    boundary: 'synthetic seed augmentation only; STRONGARM/Gremlin archives NOT touched',
    inputs: {
      seed_path: SEED_PATH,
      seed_rows: seed.length,
      seed_sha256: sha256(fs.readFileSync(SEED_PATH, 'utf8')),
    },
    outputs: {
      corpus_path: OUT_PATH,
      corpus_rows: finalRows.length,
      corpus_sha256: hash,
    },
    target: TARGET,
    summary,
    transforms_applied: TRANSFORMS.map(t => t.name),
    notes: [
      'No LLM calls. No network. Deterministic template expansion.',
      'Output rows preserve parent_id, transform, transform_param for full provenance.',
      'Refusal outputs are unchanged from seed — refusal logic is project-agnostic.',
      'Dedupe is case- and whitespace-insensitive; collisions logged, not silenced.',
    ],
  };
  fs.writeFileSync(RECEIPT_PATH, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  console.log(`extender: wrote ${OUT_PATH} (${finalRows.length} rows, sha256 ${hash.slice(0, 16)}…)`);
  console.log(`extender: wrote ${SHA_PATH}`);
  console.log(`extender: wrote ${RECEIPT_PATH}`);
}

main();
