#!/usr/bin/env bun
// promote.mjs — AE Black Mamba candidate bakeoff + symlink promotion.
//
// Doctrine source:
//   - AE_COBRA_FOUNDATION_SPEC.md (Pillar 1, Phase-3 swap)
//   - 16-TRAINING/ae-black-mamba/strategy.md
//   - 06-ORANGELLM/memory/ae-cobra/bin/start.sh (declares the model path the
//     daemon loads at boot — that is the file this script swaps)
//   - 06-ORANGELLM/memory/ae-cobra/tests/smoke-100-pair.mjs (lends the 100
//     representative prompts so the bakeoff and the activation gate score on
//     the same surface)
//
// Phase-1 / Night-1 surrogate model:
//   bartowski/mamba-2.8b-hf-GGUF (Q5_K_M), symlinked at:
//     ${AE_COBRA_ROOT}/models/ae-blackmamba-2.8b-Q5_K_M.gguf
//
// Phase-3 candidate model (this script's input):
//   AE Black Mamba — custom Mamba 2.8B SSM full-FT on Orange5 corpus
//   (Flux events + AgentTurn JSON + receipts; per strategy.md §2 this is
//   full fine-tune, not LoRA — SSM lacks transformer-style attention
//   projections so LoRA tooling is rough and unreliable at 2.8B).
//
// Bakeoff doctrine (operator brief):
//   Score four metrics, surrogate vs candidate. Promote ONLY if candidate
//   wins on >= 2 of 4. Anything less keeps the surrogate. Mom's Law: no
//   silent promotion, no fake-green report, no "close enough."
//
// The four metrics (defined exactly):
//
//   1. lane_classification_accuracy
//      The daemon's caller (flow-direct/caller.mjs) origin-classifies the
//      lane and OVERRIDES the model's emitted lane field. That override is
//      a correctness *patch*, not a measurement. Here we strip the patch
//      and measure the raw model: does the model's first-pass `lane` field
//      match the lane the origin actually maps to?
//        terminal | hermes | operator | receipts  → reality
//        orangellm                                → thought
//      Higher is better.
//
//   2. agent_turn_json_validity_rate
//      Of N completions, how many parse as JSON AND pass the AgentTurn
//      schema (schemas/agent-turn.schema.json)? The GBNF guarantees most
//      of this; differences here measure how cleanly each model converges
//      under the GBNF lock + retry budget.
//      Higher is better.
//
//   3. latency_mean_ms
//      Mean wall-clock per /completion call. Lower is better. (We use mean,
//      not p95, because the bakeoff sample size is 100 and the tail estimator
//      is noisy. Mean is what the operator brief asked for.)
//
//   4. rss_peak_mb
//      Peak resident-set-size of the llama-server child process during the
//      100-prompt run, sampled every RSS_SAMPLE_MS while completions are
//      in flight. Lower is better. (Mamba is a recurrent SSM — its RSS is
//      dominated by weight quantization choice and KV-less state; a heavier
//      candidate buys nothing for the daemon's resident footprint.)
//
// Promotion rule:
//   Candidate wins a metric iff strictly better than surrogate
//   (lane_acc / validity: greater is better; latency / rss: lower is better).
//   Ties do NOT count as wins. Promote iff wins >= 2.
//
// What this script DOES NOT do:
//   - It does NOT train. Training is the upstream Colab notebook's job.
//   - It does NOT mutate Flux ledgers or receipts (read-only on the corpus).
//   - It does NOT touch the running ae-cobra systemd service. The operator
//     restarts the service after a successful promotion. (Hot-swap of the
//     model file under a running mlock'd llama-server is unsafe — start.sh
//     uses --mlock + --no-mmap by design.)
//   - It does NOT rebuild llama.cpp. Same binary serves both models.
//   - It does NOT call out to network. Local model files only.
//
// Receipts:
//   - Writes a bakeoff report JSON next to this script:
//       ./bakeoff-<utc-iso>.json
//   - On promotion, writes a sidecar receipt to:
//       10-RECEIPTS/orange5-build/<utc-iso>-ae-black-mamba-promoted.md
//   - On non-promotion, writes:
//       10-RECEIPTS/orange5-build/<utc-iso>-ae-black-mamba-bakeoff-fail.md
//
// Run:
//   bun run 16-TRAINING/ae-black-mamba/promote.mjs \
//     --candidate /path/to/ae-black-mamba-2.8b-Q5_K_M.gguf
//
//   (or set AE_BM_CANDIDATE_GGUF env var instead of --candidate)
//
// Env overrides (all optional):
//   AE_COBRA_ROOT          default /opt/atomeons/ae-cobra
//   AE_COBRA_MODEL         absolute path of the file the daemon loads
//                          default ${AE_COBRA_ROOT}/models/ae-blackmamba-2.8b-Q5_K_M.gguf
//   LLAMA_BIN              default /opt/atomeons/llama.cpp/build/bin/llama-server
//   AE_BM_BAKEOFF_PORT     default 7517 (deliberately different from prod 7418)
//   AE_BM_BAKEOFF_N        default 100 (number of prompts; max = PROMPTS.length)
//   AE_BM_BAKEOFF_TIMEOUT  per-completion timeout ms, default 15000
//   AE_BM_RSS_SAMPLE_MS    RSS poll interval ms, default 500
//   AE_BM_WARMUP_S         warmup wait after llama-server up, default 5
//   AE_BM_NO_PROMOTE       if set to '1', score only; never swap symlink
//   AE_BM_FORCE_PROMOTE    if set to '1', promote even if rule says no
//                          (logged loudly as operator override)
//   ORANGE5_ROOT           optional checkout override (used for receipt dir)
//
// Exit codes:
//   0 — bakeoff ran, candidate promoted
//   1 — bakeoff ran, candidate rejected (surrogate retained)
//   2 — caller / setup error (missing candidate, missing llama-bin, etc.)
//   3 — bakeoff aborted (server failed to start for one of the models)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ORANGE5_ROOT = path.resolve(process.env.ORANGE5_ROOT || path.resolve(__dirname, '..', '..'));
const AE_COBRA_ROOT = process.env.AE_COBRA_ROOT || '/opt/atomeons/ae-cobra';
const AE_COBRA_MODEL = process.env.AE_COBRA_MODEL
  || path.posix.join(AE_COBRA_ROOT, 'models/ae-blackmamba-2.8b-Q5_K_M.gguf');
const LLAMA_BIN = process.env.LLAMA_BIN
  || '/opt/atomeons/llama.cpp/build/bin/llama-server';

const GRAMMAR_PATH = path.resolve(
  ORANGE5_ROOT,
  '06-ORANGELLM/memory/ae-cobra/grammar/agent_turn.gbnf',
);
const SCHEMA_PATH = path.resolve(
  ORANGE5_ROOT,
  '06-ORANGELLM/memory/ae-cobra/schemas/agent-turn.schema.json',
);
const SMOKE_PATH = path.resolve(
  ORANGE5_ROOT,
  '06-ORANGELLM/memory/ae-cobra/tests/smoke-100-pair.mjs',
);

const PORT = parseInt(process.env.AE_BM_BAKEOFF_PORT || '7517', 10);
const N_REQUESTED = parseInt(process.env.AE_BM_BAKEOFF_N || '100', 10);
const REQ_TIMEOUT_MS = parseInt(process.env.AE_BM_BAKEOFF_TIMEOUT || '15000', 10);
const RSS_SAMPLE_MS = parseInt(process.env.AE_BM_RSS_SAMPLE_MS || '500', 10);
const WARMUP_S = parseInt(process.env.AE_BM_WARMUP_S || '5', 10);
const NO_PROMOTE = process.env.AE_BM_NO_PROMOTE === '1';
const FORCE_PROMOTE = process.env.AE_BM_FORCE_PROMOTE === '1';

const SERVER_HEALTH_TIMEOUT_S = 60; // generous: cold T4-trained GGUF can be ~3GB

// ---------------------------------------------------------------------------
// Args (--candidate / -c)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { candidate: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--candidate' || a === '-c') {
      out.candidate = argv[++i];
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.error([
    'promote.mjs — AE Black Mamba candidate bakeoff + symlink promotion',
    '',
    'usage:',
    '  bun run promote.mjs --candidate /path/to/ae-black-mamba.gguf',
    '',
    'see file header for full doctrine and env overrides.',
  ].join('\n'));
  process.exit(0);
}

const CANDIDATE_PATH = args.candidate || process.env.AE_BM_CANDIDATE_GGUF || '';

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

function die(code, msg) {
  console.error(`[promote] FATAL: ${msg}`);
  process.exit(code);
}

if (!CANDIDATE_PATH) {
  die(2, 'no candidate GGUF given (--candidate <path> or AE_BM_CANDIDATE_GGUF env)');
}
if (!fs.existsSync(CANDIDATE_PATH)) {
  die(2, `candidate not found at ${CANDIDATE_PATH}`);
}
if (!fs.existsSync(AE_COBRA_MODEL)) {
  die(2, `surrogate not found at ${AE_COBRA_MODEL} (AE_COBRA_MODEL)`);
}
if (!fs.existsSync(GRAMMAR_PATH)) {
  die(2, `grammar not found at ${GRAMMAR_PATH}`);
}
if (!fs.existsSync(SCHEMA_PATH)) {
  die(2, `schema not found at ${SCHEMA_PATH}`);
}
if (!fs.existsSync(SMOKE_PATH)) {
  die(2, `smoke prompts not found at ${SMOKE_PATH}`);
}
if (!fs.existsSync(LLAMA_BIN)) {
  die(2, `llama-server not found at ${LLAMA_BIN} (LLAMA_BIN)`);
}

// ---------------------------------------------------------------------------
// Load schema + prompts
// ---------------------------------------------------------------------------

const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const GRAMMAR = fs.readFileSync(GRAMMAR_PATH, 'utf8');

// PROMPTS exported by smoke-100-pair.mjs — single source of truth.
const smokeMod = await import(/* @vite-ignore */ pathToFileUrl(SMOKE_PATH));
const PROMPTS = Array.isArray(smokeMod.PROMPTS) ? smokeMod.PROMPTS : null;
if (!PROMPTS || PROMPTS.length === 0) {
  die(2, `smoke-100-pair.mjs did not export PROMPTS array`);
}

const N = Math.min(N_REQUESTED, PROMPTS.length);
if (N < N_REQUESTED) {
  console.error(`[promote] note: requested ${N_REQUESTED} prompts, smoke file only exposes ${PROMPTS.length}; using ${N}`);
}

// ---------------------------------------------------------------------------
// Origin → expected lane (the law from smoke-100-pair.mjs PROMPTS coverage).
//   terminal | hermes | operator → reality
//   orangellm                    → thought
// merge lane is not represented in the smoke prompts — it's synthesized, not
// emitted from a single origin — so we don't score it.
// ---------------------------------------------------------------------------

function expectedLaneForOrigin(origin) {
  switch (origin) {
    case 'terminal':
    case 'hermes':
    case 'operator':
      return 'reality';
    case 'orangellm':
      return 'thought';
    default:
      // unknown origin — don't score (returns null)
      return null;
  }
}

// ---------------------------------------------------------------------------
// Dep-free AgentTurn validator (mirrors flow-direct/caller.mjs's verdict)
// ---------------------------------------------------------------------------

function validateAgentTurn(obj, schema = SCHEMA) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['root not an object'] };
  }
  for (const key of schema.required || []) {
    if (!(key in obj)) errors.push(`missing required field: ${key}`);
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) errors.push(`additional property not allowed: ${key}`);
    }
  }
  const props = schema.properties || {};
  for (const [key, def] of Object.entries(props)) {
    if (!(key in obj)) continue;
    const val = obj[key];
    if (def.type === 'string') {
      if (typeof val !== 'string') { errors.push(`${key}: expected string`); continue; }
      if (def.enum && !def.enum.includes(val)) errors.push(`${key}: '${val}' not in enum`);
      if (def.minLength != null && val.length < def.minLength) errors.push(`${key}: too short`);
      if (def.maxLength != null && val.length > def.maxLength) errors.push(`${key}: too long`);
    } else if (def.type === 'number') {
      if (typeof val !== 'number' || Number.isNaN(val)) { errors.push(`${key}: not a number`); continue; }
      if (def.minimum != null && val < def.minimum) errors.push(`${key}: below minimum`);
      if (def.maximum != null && val > def.maximum) errors.push(`${key}: above maximum`);
    } else if (def.type === 'array') {
      if (!Array.isArray(val)) { errors.push(`${key}: not an array`); continue; }
      if (def.maxItems != null && val.length > def.maxItems) errors.push(`${key}: too many items`);
      if (def.items && def.items.type === 'string') {
        for (let i = 0; i < val.length; i++) {
          if (typeof val[i] !== 'string') errors.push(`${key}[${i}]: not a string`);
          else if (def.items.maxLength != null && val[i].length > def.items.maxLength)
            errors.push(`${key}[${i}]: too long`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Prompt builder — mirror flow-direct/caller.mjs prompt shape exactly so the
// bakeoff measures the daemon's real production prompt, not a synthetic one.
// We pass lane=reality as the "caller-intended" lane, but we DO NOT measure
// the model against that — we measure the model's emitted lane against the
// origin-derived expected lane. (The point of metric 1 is to score the
// model's intrinsic classification, since the production caller patches the
// lane field anyway.)
// ---------------------------------------------------------------------------

function buildPrompt({ event, lane }) {
  const systemMsg = [
    'You are Æ Cobra, the resident memory daemon of Orange5.',
    `The event below is on the ${lane.toUpperCase()} lane (origin-classified by the caller — DO NOT change the lane).`,
    'Emit ONLY a single AgentTurn JSON object that matches the GBNF grammar exactly.',
    'No prose, no markdown, no roleplay. Cite real files, real commands. Mom\'s Law applies.',
  ].join(' ');
  return [
    '<|im_start|>system',
    systemMsg,
    '<|im_end|>',
    '<|im_start|>user',
    typeof event === 'string' ? event : JSON.stringify(event),
    '<|im_end|>',
    '<|im_start|>assistant',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// llama-server child lifecycle
// ---------------------------------------------------------------------------

function spawnLlamaServer(modelPath, port) {
  const proc = spawn(LLAMA_BIN, [
    '--model', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', '2048',
    '--grammar-file', GRAMMAR_PATH,
    '--threads', String(os.cpus().length),
    '--log-disable',
    // Deliberately NOT using --mlock + --no-mmap during bakeoff:
    // we want the candidate process to come up fast and not lock the
    // surrogate's bytes in RAM during the second leg of the run. The
    // production daemon uses --mlock; the bakeoff is a measurement, not
    // production. Both legs of the bakeoff use identical flags so the
    // comparison is fair.
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  return proc;
}

async function waitForHealth(port, deadlineS) {
  const deadline = Date.now() + deadlineS * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

// Sample RSS of pid from /proc/<pid>/status (Linux/WSL2 — production target).
// On non-Linux fall back to null (we can't measure honestly; report null
// rather than a fake zero).
function sampleRssKb(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = txt.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-completion call (no retries during bakeoff — we want raw model quality,
// not retry-budget-adjusted quality. Production caller has its own retry budget
// downstream, but THAT is a layer above the model we are measuring here).
// ---------------------------------------------------------------------------

async function callCompletion(port, prompt) {
  const body = {
    prompt,
    n_predict: 240,
    temperature: 0.4,
    grammar: GRAMMAR,
    grammar_lazy: false,
    cache_prompt: false,
    stream: false,
  };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: `http ${res.status}: ${text.slice(0, 200)}`, latency_ms: elapsed };
    }
    const data = await res.json();
    return { ok: true, content: data?.content ?? '', latency_ms: elapsed };
  } catch (e) {
    return {
      ok: false,
      reason: e.name === 'AbortError' ? `timeout after ${REQ_TIMEOUT_MS}ms` : e.message,
      latency_ms: Date.now() - t0,
    };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Score one model under llama-server
// ---------------------------------------------------------------------------

async function scoreOne(label, modelPath) {
  console.error(`[promote] ── ${label} ── booting llama-server with ${modelPath}`);
  const proc = spawnLlamaServer(modelPath, PORT);
  let exited = false;
  let exitInfo = null;
  proc.on('exit', (code, sig) => { exited = true; exitInfo = { code, sig }; });

  // Capture stderr tail for diagnostics (don't buffer unbounded).
  const errTail = [];
  proc.stderr.on('data', (chunk) => {
    const lines = chunk.toString('utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      errTail.push(line);
      if (errTail.length > 200) errTail.shift();
    }
  });
  proc.stdout.on('data', () => { /* discard, --log-disable should silence */ });

  const up = await waitForHealth(PORT, SERVER_HEALTH_TIMEOUT_S);
  if (!up || exited) {
    try { proc.kill('SIGTERM'); } catch {}
    return {
      ok: false,
      label,
      modelPath,
      error: exited
        ? `llama-server exited before health: code=${exitInfo?.code} sig=${exitInfo?.sig}`
        : `llama-server health timeout after ${SERVER_HEALTH_TIMEOUT_S}s`,
      stderr_tail: errTail.slice(-40),
    };
  }
  console.error(`[promote] ${label}: health OK; warming up ${WARMUP_S}s`);
  await sleep(WARMUP_S * 1000);

  // RSS sampler
  let rssPeakKb = 0;
  let rssSamples = 0;
  let rssAvailable = process.platform === 'linux';
  const rssTimer = rssAvailable
    ? setInterval(() => {
        const kb = sampleRssKb(proc.pid);
        if (kb != null) { rssSamples++; if (kb > rssPeakKb) rssPeakKb = kb; }
      }, RSS_SAMPLE_MS)
    : null;

  // Fire N completions sequentially. Mamba SSM is single-stream by design;
  // parallel requests on llama.cpp under GBNF can serialize anyway and would
  // muddy the latency measurement.
  const perPrompt = [];
  let valid = 0, validLanes = 0, scoredLanes = 0;
  const reasonHistogram = Object.create(null);

  for (let i = 0; i < N; i++) {
    const p = PROMPTS[i];
    const expectedLane = expectedLaneForOrigin(p.origin);
    const prompt = buildPrompt({ event: p.text, lane: expectedLane || 'reality' });
    const r = await callCompletion(PORT, prompt);

    let parsed = null;
    let row = {
      idx: i,
      origin: p.origin,
      expected_lane: expectedLane,
      latency_ms: r.latency_ms,
      ok_http: r.ok,
      valid: false,
      lane_match: null,
      reason: null,
    };
    if (!r.ok) {
      row.reason = `transport: ${r.reason}`;
    } else {
      try { parsed = JSON.parse(r.content); }
      catch (e) { row.reason = `parse: ${e.message}`; }
      if (parsed) {
        const verdict = validateAgentTurn(parsed);
        if (verdict.ok) {
          valid++;
          row.valid = true;
          if (expectedLane) {
            scoredLanes++;
            const match = parsed.lane === expectedLane;
            row.lane_match = match;
            if (match) validLanes++;
          }
        } else {
          row.reason = `schema: ${verdict.errors.slice(0, 3).join('; ')}`;
        }
      }
    }
    if (!row.valid) {
      const cls = (row.reason || 'unknown').split(':')[0].trim();
      reasonHistogram[cls] = (reasonHistogram[cls] || 0) + 1;
    }
    perPrompt.push(row);

    if ((i + 1) % 25 === 0) {
      process.stderr.write(`[promote] ${label}: ${i + 1}/${N}  valid=${valid}\n`);
    }
  }

  if (rssTimer) clearInterval(rssTimer);

  // Stop llama-server
  try { proc.kill('SIGTERM'); } catch {}
  // Give it 5s to exit cleanly
  const exitDeadline = Date.now() + 5000;
  while (!exited && Date.now() < exitDeadline) await sleep(100);
  if (!exited) {
    try { proc.kill('SIGKILL'); } catch {}
  }

  const latencies = perPrompt.map(r => r.latency_ms);
  const latencyMean = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;

  return {
    ok: true,
    label,
    modelPath,
    n: N,
    valid,
    validity_rate: N ? valid / N : 0,
    scored_lanes: scoredLanes,
    valid_lanes: validLanes,
    lane_classification_accuracy: scoredLanes ? validLanes / scoredLanes : 0,
    latency_mean_ms: latencyMean,
    latency_p50_ms: pct(0.50),
    latency_p95_ms: pct(0.95),
    rss_peak_mb: rssAvailable ? Math.round(rssPeakKb / 1024) : null,
    rss_samples: rssSamples,
    rss_available: rssAvailable,
    failure_reason_histogram: reasonHistogram,
    per_prompt: perPrompt,
    stderr_tail: errTail.slice(-20),
  };
}

// ---------------------------------------------------------------------------
// Compare + decide
// ---------------------------------------------------------------------------

function decide(surrogate, candidate) {
  // Each entry: { name, winner: 'surrogate'|'candidate'|'tie',
  //               surrogate, candidate, better:'higher'|'lower' }
  const cmp = (name, sVal, cVal, direction) => {
    let winner = 'tie';
    if (sVal == null || cVal == null) {
      // If either side is missing (e.g. rss on non-Linux), this metric is not
      // scored and CANNOT contribute a win to either side. Honest-fail.
      winner = 'unscorable';
    } else if (direction === 'higher') {
      if (cVal > sVal) winner = 'candidate';
      else if (cVal < sVal) winner = 'surrogate';
    } else {
      if (cVal < sVal) winner = 'candidate';
      else if (cVal > sVal) winner = 'surrogate';
    }
    return { name, surrogate: sVal, candidate: cVal, direction, winner };
  };

  const metrics = [
    cmp('lane_classification_accuracy',
        surrogate.lane_classification_accuracy,
        candidate.lane_classification_accuracy,
        'higher'),
    cmp('agent_turn_json_validity_rate',
        surrogate.validity_rate,
        candidate.validity_rate,
        'higher'),
    cmp('latency_mean_ms',
        surrogate.latency_mean_ms,
        candidate.latency_mean_ms,
        'lower'),
    cmp('rss_peak_mb',
        surrogate.rss_peak_mb,
        candidate.rss_peak_mb,
        'lower'),
  ];

  const wins = metrics.filter(m => m.winner === 'candidate').length;
  const losses = metrics.filter(m => m.winner === 'surrogate').length;
  const ties = metrics.filter(m => m.winner === 'tie').length;
  const unscorable = metrics.filter(m => m.winner === 'unscorable').length;

  const ruleSatisfied = wins >= 2;
  const promote = FORCE_PROMOTE ? true : (ruleSatisfied && !NO_PROMOTE);

  return {
    metrics,
    wins,
    losses,
    ties,
    unscorable,
    rule: 'promote iff candidate wins >= 2 of 4 metrics (strict; ties do not count)',
    rule_satisfied: ruleSatisfied,
    no_promote_flag: NO_PROMOTE,
    force_promote_flag: FORCE_PROMOTE,
    promote,
  };
}

// ---------------------------------------------------------------------------
// Promotion (file swap)
// ---------------------------------------------------------------------------
//
// Strategy: AE_COBRA_MODEL is typically a regular GGUF file (not a real
// symlink) on the production target. We:
//   1. Move surrogate aside to <model>.surrogate.<utc>.bak
//   2. Copy candidate into AE_COBRA_MODEL (atomic rename via temp file
//      in the same directory).
// We use COPY not symlink because the production daemon launches with
// --mlock + --no-mmap; pointing at a symlink that's later swapped under a
// running daemon is unsafe. The operator MUST `systemctl restart ae-cobra`
// after this script exits. We do not restart for them.

function utcIso() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function promoteCandidate(candidatePath, targetPath) {
  const dir = path.dirname(targetPath);
  const stamp = utcIso();
  const backupPath = `${targetPath}.surrogate.${stamp}.bak`;
  const tmpPath = path.join(dir, `.promote.tmp.${stamp}`);

  // 1. backup
  fs.renameSync(targetPath, backupPath);

  // 2. copy candidate to tmp (in target dir so rename is same-fs)
  fs.copyFileSync(candidatePath, tmpPath);

  // 3. atomic rename tmp -> target
  fs.renameSync(tmpPath, targetPath);

  return { backupPath, targetPath, candidateSource: candidatePath };
}

// ---------------------------------------------------------------------------
// Receipt writer
// ---------------------------------------------------------------------------

function writeReceipt(decision, surrogate, candidate, swap) {
  const stamp = new Date().toISOString().slice(0, 10);
  const receiptsDir = path.resolve(ORANGE5_ROOT, '10-RECEIPTS/orange5-build');
  fs.mkdirSync(receiptsDir, { recursive: true });
  const kind = decision.promote ? 'promoted' : 'bakeoff-fail';
  const filename = `${stamp}-ae-black-mamba-${kind}.md`;
  const filepath = path.join(receiptsDir, filename);

  const lines = [
    `# AE Black Mamba — ${decision.promote ? 'PROMOTED' : 'BAKEOFF REJECTED'}`,
    ``,
    `**Schema:** orange5.ae-black-mamba.promote-receipt.v0`,
    `**Generated by:** \`16-TRAINING/ae-black-mamba/promote.mjs\``,
    `**Timestamp (UTC):** ${new Date().toISOString()}`,
    `**Target model file:** \`${AE_COBRA_MODEL}\``,
    `**Candidate source:** \`${CANDIDATE_PATH}\``,
    ``,
    `## Decision`,
    ``,
    `- Rule: ${decision.rule}`,
    `- Rule satisfied: **${decision.rule_satisfied}**`,
    `- Wins: ${decision.wins}  Losses: ${decision.losses}  Ties: ${decision.ties}  Unscorable: ${decision.unscorable}`,
    `- NO_PROMOTE flag: ${decision.no_promote_flag}`,
    `- FORCE_PROMOTE flag: ${decision.force_promote_flag}`,
    `- Promoted: **${decision.promote}**`,
    ``,
    `## Metrics (surrogate vs candidate)`,
    ``,
    `| Metric | Surrogate | Candidate | Direction | Winner |`,
    `|---|---|---|---|---|`,
    ...decision.metrics.map(m =>
      `| ${m.name} | ${fmtMetric(m.name, m.surrogate)} | ${fmtMetric(m.name, m.candidate)} | ${m.direction} | ${m.winner} |`,
    ),
    ``,
    `## Bakeoff config`,
    ``,
    `- N prompts: ${N}`,
    `- Per-completion timeout: ${REQ_TIMEOUT_MS} ms`,
    `- RSS sample interval: ${RSS_SAMPLE_MS} ms (platform=${process.platform}, available=${surrogate.rss_available})`,
    `- llama-server binary: \`${LLAMA_BIN}\``,
    `- llama-server port: ${PORT}`,
    `- Grammar: \`${GRAMMAR_PATH}\``,
    `- Schema: \`${SCHEMA_PATH}\``,
    `- Prompt corpus: \`${SMOKE_PATH}\` (PROMPTS export)`,
    ``,
    `## Surrogate run`,
    ``,
    `- Model: \`${surrogate.modelPath}\``,
    `- Validity: ${surrogate.valid}/${surrogate.n} = ${(surrogate.validity_rate * 100).toFixed(1)}%`,
    `- Lane accuracy: ${surrogate.valid_lanes}/${surrogate.scored_lanes} = ${(surrogate.lane_classification_accuracy * 100).toFixed(1)}%`,
    `- Latency mean: ${surrogate.latency_mean_ms} ms (p50=${surrogate.latency_p50_ms}, p95=${surrogate.latency_p95_ms})`,
    `- RSS peak: ${surrogate.rss_peak_mb == null ? 'n/a' : surrogate.rss_peak_mb + ' MB'} (samples=${surrogate.rss_samples})`,
    `- Failure histogram: ${JSON.stringify(surrogate.failure_reason_histogram)}`,
    ``,
    `## Candidate run`,
    ``,
    `- Model: \`${candidate.modelPath}\``,
    `- Validity: ${candidate.valid}/${candidate.n} = ${(candidate.validity_rate * 100).toFixed(1)}%`,
    `- Lane accuracy: ${candidate.valid_lanes}/${candidate.scored_lanes} = ${(candidate.lane_classification_accuracy * 100).toFixed(1)}%`,
    `- Latency mean: ${candidate.latency_mean_ms} ms (p50=${candidate.latency_p50_ms}, p95=${candidate.latency_p95_ms})`,
    `- RSS peak: ${candidate.rss_peak_mb == null ? 'n/a' : candidate.rss_peak_mb + ' MB'} (samples=${candidate.rss_samples})`,
    `- Failure histogram: ${JSON.stringify(candidate.failure_reason_histogram)}`,
    ``,
  ];

  if (decision.promote && swap) {
    lines.push(
      `## Swap performed`,
      ``,
      `- Surrogate backed up to: \`${swap.backupPath}\``,
      `- New active model: \`${swap.targetPath}\``,
      `- Copied from: \`${swap.candidateSource}\``,
      `- **Operator must \`systemctl restart ae-cobra\` (or rerun start.sh) to load the new model. The mlock'd daemon does not hot-reload.**`,
      ``,
    );
  } else {
    lines.push(
      `## No swap performed`,
      ``,
      `- Surrogate at \`${AE_COBRA_MODEL}\` is retained.`,
      `- Candidate at \`${CANDIDATE_PATH}\` is left in place; operator may retrain or hand-inspect.`,
      ``,
    );
  }

  lines.push(
    `## Mom's Law notes`,
    ``,
    `- Both legs of the bakeoff used identical llama-server flags except for \`--model\`. Identical grammar, identical port, identical N, identical prompt set, identical temperature.`,
    `- Lane accuracy is measured against the model's raw \`lane\` field BEFORE the production caller patches it. This is the intrinsic classifier score, not the post-patch behavior.`,
    `- RSS is unscorable on non-Linux hosts; on those hosts the metric contributes neither a win nor a loss. The bakeoff therefore degrades to 3-metric comparison, and the rule still demands strict ${'>'}= 2 wins.`,
    `- No retries during the bakeoff. The production caller's 3-attempt retry budget is layered ABOVE the model and would mask differences in raw model quality.`,
    `- This receipt was generated by \`promote.mjs\` and is the only authoritative record of the swap. Anything that disagrees with this file is theater.`,
    ``,
  );

  fs.writeFileSync(filepath, lines.join('\n'));
  return filepath;
}

function fmtMetric(name, val) {
  if (val == null) return 'n/a';
  if (name === 'lane_classification_accuracy' || name === 'agent_turn_json_validity_rate') {
    return `${(val * 100).toFixed(1)}%`;
  }
  if (name === 'latency_mean_ms') return `${val} ms`;
  if (name === 'rss_peak_mb') return `${val} MB`;
  return String(val);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pathToFileUrl(p) {
  // bun + node both accept file:// URLs for dynamic import; this avoids
  // Windows backslash quoting bugs in `await import(p)`.
  const abs = path.resolve(p);
  // Normalize windows backslashes
  let u = abs.replace(/\\/g, '/');
  if (!u.startsWith('/')) u = '/' + u; // drive-letter case
  return `file://${u}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error(`[promote] AE Black Mamba bakeoff`);
  console.error(`[promote] surrogate: ${AE_COBRA_MODEL}`);
  console.error(`[promote] candidate: ${CANDIDATE_PATH}`);
  console.error(`[promote] N=${N}, port=${PORT}, llama-bin=${LLAMA_BIN}`);
  console.error(`[promote] platform=${process.platform} (rss measurable: ${process.platform === 'linux'})`);

  const surrogate = await scoreOne('surrogate', AE_COBRA_MODEL);
  if (!surrogate.ok) {
    console.error(`[promote] FATAL: surrogate scoring failed: ${surrogate.error}`);
    console.error(`[promote] stderr tail:\n${(surrogate.stderr_tail || []).join('\n')}`);
    process.exit(3);
  }

  const candidate = await scoreOne('candidate', CANDIDATE_PATH);
  if (!candidate.ok) {
    console.error(`[promote] FATAL: candidate scoring failed: ${candidate.error}`);
    console.error(`[promote] stderr tail:\n${(candidate.stderr_tail || []).join('\n')}`);
    process.exit(3);
  }

  const decision = decide(surrogate, candidate);

  // Write bakeoff report next to this script
  const reportPath = path.join(__dirname, `bakeoff-${utcIso()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    schema: 'orange5.ae-black-mamba.bakeoff-report.v0',
    started_at_iso: new Date().toISOString(),
    config: {
      n: N,
      port: PORT,
      req_timeout_ms: REQ_TIMEOUT_MS,
      rss_sample_ms: RSS_SAMPLE_MS,
      warmup_s: WARMUP_S,
      llama_bin: LLAMA_BIN,
      grammar_path: GRAMMAR_PATH,
      schema_path: SCHEMA_PATH,
      smoke_path: SMOKE_PATH,
      ae_cobra_model: AE_COBRA_MODEL,
      candidate_path: CANDIDATE_PATH,
      no_promote: NO_PROMOTE,
      force_promote: FORCE_PROMOTE,
    },
    surrogate,
    candidate,
    decision,
  }, null, 2));
  console.error(`[promote] bakeoff report: ${reportPath}`);

  // Console summary
  console.error('');
  console.error('[promote] ── Decision ──');
  for (const m of decision.metrics) {
    console.error(`  ${m.name.padEnd(34)} ` +
      `surrogate=${String(fmtMetric(m.name, m.surrogate)).padEnd(10)} ` +
      `candidate=${String(fmtMetric(m.name, m.candidate)).padEnd(10)} ` +
      `winner=${m.winner}`);
  }
  console.error(`[promote] wins=${decision.wins} losses=${decision.losses} ties=${decision.ties} unscorable=${decision.unscorable}`);
  console.error(`[promote] rule satisfied: ${decision.rule_satisfied}`);
  console.error(`[promote] promote: ${decision.promote}` +
    (NO_PROMOTE ? ' (NO_PROMOTE flag suppressed swap)' : '') +
    (FORCE_PROMOTE ? ' (FORCE_PROMOTE flag overrode rule)' : ''));

  let swap = null;
  if (decision.promote) {
    try {
      swap = promoteCandidate(CANDIDATE_PATH, AE_COBRA_MODEL);
      console.error(`[promote] swap OK`);
      console.error(`[promote]   surrogate backed up: ${swap.backupPath}`);
      console.error(`[promote]   active model:        ${swap.targetPath}`);
      console.error(`[promote]   *** restart ae-cobra to load: systemctl restart ae-cobra ***`);
    } catch (e) {
      console.error(`[promote] FATAL: swap failed: ${e.message}`);
      // Receipt still gets written so the failure is on the record.
      const receiptPath = writeReceipt(
        { ...decision, promote: false, swap_error: e.message },
        surrogate, candidate, null);
      console.error(`[promote] receipt: ${receiptPath}`);
      process.exit(3);
    }
  } else {
    console.error(`[promote] no swap; surrogate retained at ${AE_COBRA_MODEL}`);
  }

  const receiptPath = writeReceipt(decision, surrogate, candidate, swap);
  console.error(`[promote] receipt: ${receiptPath}`);

  // stdout: machine-readable verdict
  console.log(JSON.stringify({
    promote: decision.promote,
    wins: decision.wins,
    losses: decision.losses,
    ties: decision.ties,
    unscorable: decision.unscorable,
    rule_satisfied: decision.rule_satisfied,
    metrics: decision.metrics,
    report_path: reportPath,
    receipt_path: receiptPath,
    swap,
  }, null, 2));

  process.exit(decision.promote ? 0 : 1);
}

main().catch((e) => {
  console.error(`[promote] uncaught fatal: ${e.stack || e.message}`);
  process.exit(3);
});
