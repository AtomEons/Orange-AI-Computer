#!/usr/bin/env node
// verify.mjs — AE Misfit v0 adapter verification gate.
//
// Disclosure: ATOM-AEMISFIT-VERIFY-2026-0624
// Author: Atom McCree (AtomEons Systems Laboratory)
// Lane: 16-TRAINING / adapters / ae-misfit-v0
//
// WHY THIS EXISTS — the fatty-v0 lesson
// --------------------------------------
// On 2026-06-24 the orangellm-fatty-v0 training-receipt.json shipped with
//   "base": "Qwen/Qwen3-30B-A3B-Instruct"
// while the actual adapter_config.json said
//   "base_model_name_or_path": "unsloth/qwen2.5-32b-instruct-bnb-4bit"
// That drift is exactly the class of fake-green AE Misfit was designed to
// catch. So before the AE Misfit adapter itself can be promoted we run a
// deterministic verification step that BOTH receipts agree on the same
// base model AND no stale Qwen3 string sneaks in.
//
// This script does five things:
//   1. Walks <adapter-dir> and computes SHA-256 of every safetensors shard
//      (deterministic ordering by filename).
//   2. Parses adapter_config.json and extracts base_model_name_or_path.
//   3. Asserts the base is exactly EXPECTED_BASE
//      ("unsloth/Qwen2.5-7B-Instruct-bnb-4bit"). Case-insensitive compare
//      to tolerate Unsloth's mixed-case repo names ("Qwen2.5" vs
//      "qwen2.5") but NOTHING ELSE — no Qwen3, no 32B, no MoE, no stale
//      strings.
//   4. Emits verification.json into the adapter dir with:
//        { adapter_dir, expected_base, observed_base, base_ok,
//          stale_qwen3_string, files: [{name, bytes, sha256}],
//          overall_ok, generated_at, disclosure_id }
//   5. Writes ONE Thought-lane Flux event so the Reality Flux ledger has
//      a hash-chained receipt of the verification verdict.
//
// CLI: node verify.mjs --adapter-dir <path>
//
// Exit codes:
//   0  verification passed
//   1  verification failed (base mismatch / stale Qwen3 / missing files)
//   2  invocation error (bad CLI args, unreadable dir, etc.)
//
// No external deps. Pure Node. Works on Windows and Linux.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// --- constants ------------------------------------------------------------

const DISCLOSURE_ID = 'ATOM-AEMISFIT-VERIFY-2026-0624';
const EXPECTED_BASE = 'unsloth/Qwen2.5-7B-Instruct-bnb-4bit';
// Stale strings we explicitly refuse — the fatty-v0 drift list.
const FORBIDDEN_BASE_SUBSTRINGS = [
  'qwen3',          // wrong major version
  'qwen-3',         // any hyphenated qwen3 variant
  '30b',            // wrong size class
  '32b',            // wrong size class (fatty was 32B)
  'a3b',            // MoE marker, wrong arch
  'moe',            // wrong arch
];

const ORANGE5_ROOT = path.resolve(
  process.env.ORANGE5_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
);
const FLUX_WRITER_PATH = path.join(
  ORANGE5_ROOT,
  '06-ORANGELLM',
  'memory',
  'ae-cobra',
  'flux',
  'writer.mjs',
);
const DEFAULT_FLUX_ROOT =
  process.env.AE_FLUX_ROOT ||
  path.join(ORANGE5_ROOT, '06-ORANGELLM', 'memory', 'ae-cobra', 'flux');

// --- cli ------------------------------------------------------------------

function parseArgs(argv) {
  const out = { adapterDir: null, fluxRoot: null, noFlux: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--adapter-dir' || a === '-a') {
      out.adapterDir = argv[++i];
    } else if (a === '--flux-root') {
      out.fluxRoot = argv[++i];
    } else if (a === '--no-flux') {
      out.noFlux = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!out.adapterDir && !a.startsWith('-')) {
      // Allow bare positional for convenience.
      out.adapterDir = a;
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      'verify.mjs — AE Misfit v0 adapter verification gate',
      '',
      'Usage:',
      '  node verify.mjs --adapter-dir <path> [--flux-root <path>] [--no-flux]',
      '',
      'Required:',
      '  --adapter-dir, -a   Path to the adapter directory (must contain',
      '                      adapter_config.json and at least one .safetensors).',
      '',
      'Optional:',
      `  --flux-root         Flux root for Thought-lane event. Defaults to`,
      `                      $AE_FLUX_ROOT or ${DEFAULT_FLUX_ROOT}`,
      '  --no-flux           Skip Flux event emission (verification.json still written).',
      '',
      `Expected base model: ${EXPECTED_BASE}`,
      '',
    ].join('\n') + '\n',
  );
}

// --- helpers --------------------------------------------------------------

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function normalizeBase(s) {
  return String(s || '').trim().toLowerCase();
}

function checkBaseModel(observed) {
  const expected = normalizeBase(EXPECTED_BASE);
  const obs = normalizeBase(observed);
  const exact = obs === expected;
  const forbidden = FORBIDDEN_BASE_SUBSTRINGS.filter((s) => obs.includes(s));
  return {
    base_ok: exact && forbidden.length === 0,
    exact_match: exact,
    forbidden_hits: forbidden,
    expected: EXPECTED_BASE,
    observed: observed || null,
  };
}

function listSafetensors(adapterDir) {
  const entries = fs.readdirSync(adapterDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.safetensors'))
    .map((e) => e.name)
    .sort(); // deterministic ordering
}

// --- core verification ----------------------------------------------------

function verifyAdapter(adapterDirRaw) {
  const errors = [];
  const adapterDir = path.resolve(adapterDirRaw);

  if (!fs.existsSync(adapterDir) || !fs.statSync(adapterDir).isDirectory()) {
    return {
      ok: false,
      kind: 'invocation_error',
      reason: `adapter dir not found: ${adapterDir}`,
      adapter_dir: adapterDir,
    };
  }

  // (1) safetensors
  const safetensorsFiles = listSafetensors(adapterDir);
  if (safetensorsFiles.length === 0) {
    errors.push('no .safetensors shard found');
  }
  const files = safetensorsFiles.map((name) => {
    const abs = path.join(adapterDir, name);
    const stat = fs.statSync(abs);
    return {
      name,
      bytes: stat.size,
      sha256: sha256File(abs),
    };
  });

  // (2) adapter_config.json
  const configPath = path.join(adapterDir, 'adapter_config.json');
  let observedBase = null;
  let config = null;
  if (!fs.existsSync(configPath)) {
    errors.push('adapter_config.json not found');
  } else {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      observedBase =
        config.base_model_name_or_path ||
        config.base_model ||
        null;
      if (!observedBase) {
        errors.push('adapter_config.json missing base_model_name_or_path');
      }
    } catch (err) {
      errors.push(`adapter_config.json parse error: ${err.message}`);
    }
  }

  // (3) base assertion + stale-Qwen3 sweep
  const baseCheck = checkBaseModel(observedBase);
  if (!baseCheck.base_ok) {
    if (!baseCheck.exact_match) {
      errors.push(
        `base mismatch: expected "${baseCheck.expected}", observed "${baseCheck.observed}"`,
      );
    }
    if (baseCheck.forbidden_hits.length > 0) {
      errors.push(
        `stale/forbidden tokens in base string: ${baseCheck.forbidden_hits.join(', ')}`,
      );
    }
  }

  // Also sweep the raw config text for a stale Qwen3 string anywhere — paranoia.
  let staleQwen3InConfig = false;
  if (config) {
    const raw = JSON.stringify(config).toLowerCase();
    staleQwen3InConfig = raw.includes('qwen3') || raw.includes('qwen-3');
    if (staleQwen3InConfig) {
      errors.push('adapter_config.json contains a stale Qwen3 reference');
    }
  }

  const overall_ok = errors.length === 0;

  return {
    ok: overall_ok,
    kind: overall_ok ? 'pass' : 'fail',
    adapter_dir: adapterDir,
    expected_base: EXPECTED_BASE,
    observed_base: observedBase,
    base_check: baseCheck,
    stale_qwen3_string: staleQwen3InConfig,
    files,
    errors,
    generated_at: new Date().toISOString(),
    disclosure_id: DISCLOSURE_ID,
  };
}

// --- emission -------------------------------------------------------------

function writeVerificationJson(adapterDir, result) {
  const outPath = path.join(adapterDir, 'verification.json');
  const payload = {
    schema: 'ae.misfit.verification.v1',
    disclosure_id: DISCLOSURE_ID,
    adapter_dir: result.adapter_dir,
    expected_base: result.expected_base,
    observed_base: result.observed_base,
    base_ok: result.base_check ? result.base_check.base_ok : false,
    base_exact_match: result.base_check ? result.base_check.exact_match : false,
    forbidden_hits: result.base_check ? result.base_check.forbidden_hits : [],
    stale_qwen3_string: !!result.stale_qwen3_string,
    files: result.files || [],
    errors: result.errors || [],
    overall_ok: !!result.ok,
    generated_at: result.generated_at,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return outPath;
}

async function emitFluxEvent({ result, fluxRoot }) {
  // Late import — verifier still works (and writes verification.json) even if
  // the Flux writer module is missing on the box. We just degrade gracefully
  // and note it in the return payload.
  let writerMod = null;
  try {
    writerMod = await import(pathToFileURL(FLUX_WRITER_PATH).href);
  } catch (err) {
    return { ok: false, source: 'import_failed', detail: String(err?.message || err) };
  }
  if (!writerMod || typeof writerMod.writeFluxRecord !== 'function') {
    return { ok: false, source: 'no_writer_export' };
  }

  try {
    fs.mkdirSync(fluxRoot, { recursive: true });
  } catch (err) {
    return { ok: false, source: 'mkdir_failed', detail: String(err?.message || err) };
  }

  const body = {
    summary: result.ok
      ? `AE Misfit v0 adapter verified against ${EXPECTED_BASE}`
      : `AE Misfit v0 adapter FAILED verification`,
    adapter_dir: result.adapter_dir,
    expected_base: result.expected_base,
    observed_base: result.observed_base,
    base_ok: result.base_check ? result.base_check.base_ok : false,
    forbidden_hits: result.base_check ? result.base_check.forbidden_hits : [],
    stale_qwen3_string: !!result.stale_qwen3_string,
    file_count: (result.files || []).length,
    safetensors_sha256: (result.files || []).map((f) => ({
      name: f.name,
      sha256: f.sha256,
      bytes: f.bytes,
    })),
    errors: result.errors || [],
    overall_ok: !!result.ok,
    disclosure_id: DISCLOSURE_ID,
  };

  try {
    const rec = writerMod.writeFluxRecord({
      lane: 'thought',
      origin: 'training.ae-misfit-v0.verify',
      kind: result.ok ? 'verification.pass' : 'verification.fail',
      body,
      fluxRoot,
    });
    return { ok: true, source: 'flux', hash: rec.hash, prev_hash: rec.prev_hash };
  } catch (err) {
    return { ok: false, source: 'write_failed', detail: String(err?.message || err) };
  }
}

// --- entrypoint -----------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.adapterDir) {
    process.stderr.write('error: --adapter-dir is required\n\n');
    printHelp();
    process.exit(2);
  }

  const result = verifyAdapter(args.adapterDir);

  if (result.kind === 'invocation_error') {
    process.stderr.write(`error: ${result.reason}\n`);
    process.exit(2);
  }

  // Always write verification.json — even on fail. The receipt IS the proof.
  let verificationPath;
  try {
    verificationPath = writeVerificationJson(result.adapter_dir, result);
  } catch (err) {
    process.stderr.write(`error: could not write verification.json: ${err.message}\n`);
    process.exit(2);
  }

  // Flux event (Thought lane) — soft-fail; verification.json is the source of truth.
  let fluxStatus = { ok: false, source: 'skipped' };
  if (!args.noFlux) {
    const fluxRoot = args.fluxRoot || DEFAULT_FLUX_ROOT;
    fluxStatus = await emitFluxEvent({ result, fluxRoot });
  }

  // Stdout report — terse, grid-first.
  const report = {
    result: result.ok ? 'PASS' : 'FAIL',
    adapter_dir: result.adapter_dir,
    expected_base: result.expected_base,
    observed_base: result.observed_base,
    base_ok: result.base_check ? result.base_check.base_ok : false,
    stale_qwen3_string: !!result.stale_qwen3_string,
    safetensors_files: (result.files || []).length,
    verification_json: verificationPath,
    flux: fluxStatus,
    errors: result.errors || [],
    disclosure_id: DISCLOSURE_ID,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  process.exit(result.ok ? 0 : 1);
}

// Only run when invoked directly, not when imported by tests/workflows.
const isDirectInvocation =
  import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isDirectInvocation) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err?.stack || err}\n`);
    process.exit(2);
  });
}

// Exports for workflow / test consumers.
export {
  verifyAdapter,
  writeVerificationJson,
  emitFluxEvent,
  checkBaseModel,
  sha256File,
  EXPECTED_BASE,
  FORBIDDEN_BASE_SUBSTRINGS,
  DISCLOSURE_ID,
};
