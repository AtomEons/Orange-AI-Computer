// Workflow orchestrator — AE Black Mamba v0 post-Colab retrieve + GGUF verify
// + bakeoff vs surrogate + promotion + AE Cobra hot-swap.
//
// Disclosure ID: ATOM-AE-BLACK-MAMBA-WORKFLOW-2026-0624
//
// Invoked by Claude via the Workflow tool ONLY (per operator directive
// 2026-06-23: "training of models you do in workflows").
//
// AE Black Mamba is the Phase-3 in-house replacement for the AE Cobra
// Night-1 surrogate model. The surrogate (bartowski/mamba-2.8b-hf-GGUF,
// Q5_K_M, symlinked at ${AE_COBRA_ROOT}/models/ae-blackmamba-2.8b-Q5_K_M.gguf)
// is doctrine-blind — GBNF guarantees JSON shape but the surrogate has no
// knowledge of Orange5 vocabulary, lane semantics, or receipt cadence.
// AE Black Mamba replaces it: a custom Mamba 2.8B SSM pretrained on
// Orange5's own Flux event corpus + AgentTurn JSON corpus + receipt corpus.
//
// Per AE_COBRA_FOUNDATION_SPEC.md Pillar 1 §Phase-3 and
// 16-TRAINING/ae-black-mamba/strategy.md §2, this is **full fine-tune**,
// not LoRA. SSMs lack transformer-style Q/K/V projections where a clean
// LoRA `BA` rank-decomposition slots in; LoRA-on-Mamba tooling is rough
// and convergence is unreliable at 2.8B. T4 16GB is sufficient for 2.8B
// full FT at bf16 + grad checkpointing + bnb.optim.AdamW8bit per the
// Foundation Spec.
//
// This script runs AFTER the operator has completed the Colab full-FT run
// and the resulting GGUF (Q5_K_M) is in Google Drive. It handles:
//
//   1. Gate         — verify strategy + grammar + schema + smoke prompts exist
//                     and surrogate file is present (the file we are about to
//                     replace must currently be there; otherwise the swap
//                     target is wrong and we refuse).
//   2. Retrieve     — pull candidate GGUF from Drive, verify SHA-256 against
//                     training receipt, confirm GGUF magic bytes + arch=mamba.
//   3. Bakeoff      — 4-metric head-to-head per
//                     16-TRAINING/ae-black-mamba/promote.mjs:
//                       (1) lane_classification_accuracy   (higher better)
//                       (2) agent_turn_json_validity_rate  (higher better)
//                       (3) latency_mean_ms                (lower  better)
//                       (4) rss_peak_mb                    (lower  better)
//                     Plus an unconstrained-validity rate probe (no GBNF) for
//                     the §6 alignment target (≥ 90% schema-valid without
//                     grammar lock).
//   4. Synthesize   — apply promote.mjs gate (candidate wins ≥ 2 of 4) and
//                     strategy §6 alignment target. Emit promote/hold/reject.
//   5. HotSwap      — on promote: stop ae-cobra systemd unit, flip the
//                     symlink ${AE_COBRA_ROOT}/models/ae-blackmamba-2.8b-Q5_K_M.gguf
//                     to point at the new GGUF, restart the unit, run the
//                     100-prompt smoke gate at the new boot.
//                     On hold/reject: surrogate retained, no daemon touched.
//   6. Receipt      — hash-chained promotion or rejection receipt at
//                     10-RECEIPTS/orange5-build/.
//
// Sibling workflows:
//   - ./orangellm-fatty-v0.workflow.mjs  (PM-brain LoRA on qwen3:30b-a3b)
//   - ./minieyes-v0.workflow.mjs         (deferred visual VLM addendum)
// Same skeleton; different bakeoff dimensions, different swap target.

export const meta = {
  name: 'ae-black-mamba-v0-training',
  description: 'AE Black Mamba v0 post-Colab GGUF retrieve + 4-metric bakeoff vs surrogate + symlink hot-swap + AE Cobra restart',
  whenToUse: 'After operator completes the Colab full-FT run for AE Black Mamba 2.8B SSM and the GGUF (Q5_K_M) is in Drive. The AE Cobra Night-1 daemon must currently be running with the surrogate model.',
  phases: [
    { title: 'Gate',       detail: 'verify strategy + grammar + schema + surrogate + corpus manifest exist' },
    { title: 'Retrieve',   detail: 'fetch candidate GGUF from Drive, verify SHA-256 + GGUF magic + arch=mamba' },
    { title: 'Bakeoff',    detail: '4-metric head-to-head (lane_acc, validity, latency, rss) on 100-prompt smoke set + unconstrained-validity alignment probe' },
    { title: 'Synthesize', detail: 'promote.mjs gate (wins >= 2 of 4) + strategy §6 alignment target (unconstrained-validity >= 90%)' },
    { title: 'HotSwap',    detail: 'on promote: stop unit, flip symlink, restart, re-run 100-prompt gate at new boot' },
    { title: 'Receipt',    detail: 'hash-chained promotion or rejection receipt + ledger row' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths & constants (every absolute path verified against the existing tree)
// ─────────────────────────────────────────────────────────────────────────────

const ROOT                 = 'C:/AtomEons/Orange5'
const BM_ROOT              = `${ROOT}/16-TRAINING/ae-black-mamba`
const STRATEGY_DOC         = `${BM_ROOT}/strategy.md`
const CORPUS_MANIFEST      = `${BM_ROOT}/corpus/corpus-manifest.json`
const PROMOTE_SCRIPT       = `${BM_ROOT}/promote.mjs`
const PIPELINE_SCRIPT      = `${BM_ROOT}/pipeline.mjs`
const RECEIPT_DIR          = `${ROOT}/10-RECEIPTS/orange5-build`

const AE_COBRA_ROOT_HINT   = '/opt/atomeons/ae-cobra'              // Codexa WSL2 default
const SURROGATE_MODEL_PATH = `${AE_COBRA_ROOT_HINT}/models/ae-blackmamba-2.8b-Q5_K_M.gguf`
const SURROGATE_SOURCE     = 'bartowski/mamba-2.8b-hf-GGUF (Q5_K_M)'

const GRAMMAR_PATH         = `${ROOT}/06-ORANGELLM/memory/ae-cobra/grammar/agent_turn.gbnf`
const SCHEMA_PATH          = `${ROOT}/06-ORANGELLM/memory/ae-cobra/schemas/agent-turn.schema.json`
const SMOKE_PROMPTS_PATH   = `${ROOT}/06-ORANGELLM/memory/ae-cobra/tests/smoke-100-pair.mjs`
const COBRA_START_SCRIPT   = `${ROOT}/06-ORANGELLM/memory/ae-cobra/bin/start.sh`
const FOUNDATION_SPEC      = `${ROOT}/06-ORANGELLM/memory/AE_COBRA_FOUNDATION_SPEC.md`

const CANDIDATE_DRIVE_PATH = '/content/drive/MyDrive/ae-black-mamba-v0/gguf/'
const TRAINING_RECEIPT     = '/content/drive/MyDrive/ae-black-mamba-v0/training-receipt.json'
const LOCAL_CANDIDATE_DIR  = `${BM_ROOT}/candidates/ae-black-mamba-v0/`

// Bakeoff config (mirrors promote.mjs env defaults so the workflow and the
// CLI script agree on what "the bakeoff" means)
const BAKEOFF_PORT         = 7517   // deliberately different from prod 7418
const BAKEOFF_N            = 100    // matches AE_BM_BAKEOFF_N default
const REQ_TIMEOUT_MS       = 15000
const RSS_SAMPLE_MS        = 500
const WARMUP_S             = 5

// Promotion gate constants (single source of truth — promote.mjs)
const PROMOTE_MIN_WINS                 = 2      // candidate wins >= 2 of 4
const ALIGNMENT_UNCONSTRAINED_MIN_RATE = 0.90   // strategy §6 target
const HARD_REGRESSION_MAX_LATENCY_PCT  = 0.50   // refuse if candidate is >50% slower
const HARD_REGRESSION_MAX_RSS_PCT      = 0.50   // refuse if candidate is >50% heavier

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Gate. Refuse to run unless every prerequisite is present.
// No silent ceremonies. We are about to replace the daemon's brain.
// ─────────────────────────────────────────────────────────────────────────────

phase('Gate')

const gate = await agent(
  `AE Black Mamba v0 pre-flight gate. This workflow MUST refuse to proceed
unless every condition below is met. Mom's Law: no theater, no skating.
We are about to swap the file the AE Cobra daemon loads at boot.

Conditions (ALL required):
1. File ${STRATEGY_DOC} exists and is readable. The strategy doc must be
   present; promoting a model whose strategy is missing is forbidden.
2. File ${FOUNDATION_SPEC} exists. Pillar 1 §Phase-3 is the doctrinal
   anchor for this lane.
3. File ${GRAMMAR_PATH} exists. The GBNF logit-lock must be present —
   the bakeoff GBNF-validity metric depends on it.
4. File ${SCHEMA_PATH} exists. AgentTurn schema must be present — the
   schema-validity metric depends on it.
5. File ${SMOKE_PROMPTS_PATH} exists. The 100-prompt smoke pair set is
   the bakeoff prompt surface; without it, no bakeoff.
6. File ${PROMOTE_SCRIPT} exists. The CLI promotion script defines the
   exact metric set this workflow mirrors; if it has drifted from this
   file, the workflow must surface that as a blocker.
7. File ${COBRA_START_SCRIPT} exists. The start script declares the
   model path the daemon loads; this is the file the hot-swap targets.
8. File ${CORPUS_MANIFEST} exists. Read accepted_total, train_rows,
   val_rows, train_sha256, val_sha256. Report all four.
9. File ${SURROGATE_MODEL_PATH} exists (on Codexa WSL2). The surrogate
   must currently be in place — that is the file the hot-swap replaces.
   If absent, the daemon is not in its documented Night-1 state and we
   refuse to proceed.
10. Read ${TRAINING_RECEIPT} from Drive (rclone or Drive API). Capture
    candidate_sha256, base_model_repo (must be state-spaces/mamba-2.8b-hf
    or a documented fork), train_loss_final, train_steps, train_epochs,
    train_elapsed_seconds, optimizer (must be bnb AdamW8bit per strategy
    §5), precision (must be bf16), grad_checkpoint (must be true).
11. Confirm the AE Cobra daemon is currently running and answering on its
    prod port (whatever ${COBRA_START_SCRIPT} declares — typically 7418).
    GET /health or equivalent. If the daemon is down, refuse — we do not
    swap files under a daemon whose state we cannot reason about.

Return JSON:
{
  "ok": boolean,
  "strategy_present": boolean,
  "foundation_spec_present": boolean,
  "grammar_present": boolean,
  "schema_present": boolean,
  "smoke_prompts_present": boolean,
  "promote_script_present": boolean,
  "cobra_start_script_present": boolean,
  "corpus_manifest_present": boolean,
  "corpus_accepted_total": int|null,
  "corpus_train_rows": int|null,
  "corpus_val_rows": int|null,
  "corpus_train_sha256": string|null,
  "corpus_val_sha256": string|null,
  "surrogate_present": boolean,
  "surrogate_path": "${SURROGATE_MODEL_PATH}",
  "training_receipt_present": boolean,
  "candidate_sha256_remote": string|null,
  "base_model_repo": string|null,
  "train_loss_final": number|null,
  "train_steps": int|null,
  "train_epochs": int|null,
  "optimizer": string|null,
  "precision": string|null,
  "grad_checkpoint": boolean|null,
  "cobra_daemon_live": boolean,
  "cobra_daemon_port": int|null,
  "blockers": [string],
  "next_action": string
}`,
  { phase: 'Gate', label: 'preflight-gate' }
)

if (!gate || gate.includes('"ok":false') || gate.includes('"ok": false')) {
  log('AE Black Mamba v0 pre-flight gate refused. Workflow aborted.')
  return { status: 'rejected', reason: 'preflight_gate_failed', gate }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Retrieve. Pull the candidate GGUF from Drive and verify SHA-256
// + GGUF magic bytes + Mamba architecture tag. This is the file the daemon
// will load after the swap; integrity is non-negotiable.
// ─────────────────────────────────────────────────────────────────────────────

phase('Retrieve')

const retrieval = await agent(
  `Retrieve the AE Black Mamba v0 candidate GGUF from Google Drive. The
Colab full-FT run finished and saved the Q5_K_M-quantized GGUF at
${CANDIDATE_DRIVE_PATH}. The training receipt at ${TRAINING_RECEIPT}
contains candidate_sha256, the base model repo (state-spaces/mamba-2.8b-hf),
and metadata captured during conversion.

Steps:
1. Read ${TRAINING_RECEIPT} from Drive (rclone or Drive API).
2. Download the candidate GGUF + any sidecar tokenizer/config files to
   ${LOCAL_CANDIDATE_DIR} on Codexa. Preserve directory structure.
3. Compute SHA-256 of the downloaded GGUF.
4. Compare against the receipt's candidate_sha256 (constant-time compare).
5. Inspect the first 4 bytes of the GGUF file. They MUST equal the GGUF
   magic 0x47 0x47 0x55 0x46 ("GGUF" ASCII). If not, the file is not a
   GGUF and we refuse.
6. Read the GGUF header metadata (gguf-py or llama.cpp's
   tools/gguf-dump.py). Confirm:
     - general.architecture == "mamba"   (case-insensitive)
     - general.file_type / quantization indicates Q5_K_M
     - n_params is in the 2.7-2.9B range (per strategy §1 the target is 2.8B)
   If architecture is not mamba, refuse — the wrong model was uploaded.
7. Run a single load probe: spawn llama-server against the candidate on
   port ${BAKEOFF_PORT}, wait up to ${WARMUP_S}s warmup, GET /health,
   POST a single trivial /completion (max 8 tokens, no grammar). Confirm
   200-class response. Kill the server. Do not score the response — this
   is liveness only.

Return JSON:
{
  "ok": boolean,
  "candidate_sha256_local": string,
  "candidate_sha256_remote": string,
  "match": boolean,
  "gguf_magic_ok": boolean,
  "gguf_architecture": string,
  "architecture_is_mamba": boolean,
  "gguf_quantization": string,
  "n_params_estimate": number|null,
  "file_size_mb": number,
  "load_probe_ok": boolean,
  "load_probe_first_bytes": string|null,
  "candidate_local_path": string,
  "error": string|null
}`,
  { phase: 'Retrieve', label: 'gguf-retrieve' }
)

if (!retrieval ||
    retrieval.includes('"ok":false') ||
    retrieval.includes('"match":false') ||
    retrieval.includes('"gguf_magic_ok":false') ||
    retrieval.includes('"architecture_is_mamba":false') ||
    retrieval.includes('"load_probe_ok":false')) {
  log('AE Black Mamba candidate retrieval failed (hash mismatch, magic byte mismatch, wrong arch, or load probe failed). Aborting.')
  return { status: 'rejected', reason: 'candidate_retrieval_failed', retrieval }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Bakeoff. Four metrics + alignment probe, per
// 16-TRAINING/ae-black-mamba/promote.mjs and strategy.md §6.
//
// The 100 smoke prompts are the same prompt surface promote.mjs uses
// (06-ORANGELLM/memory/ae-cobra/tests/smoke-100-pair.mjs). Surrogate and
// candidate score on the SAME prompts to keep the head-to-head honest.
//
// We run the four metrics + alignment probe in parallel BUT each metric
// internally runs surrogate-then-candidate against the same prompt slice
// sequentially (we cannot bake off two llama-servers on the same GPU at
// the same time on a T4-class host).
// ─────────────────────────────────────────────────────────────────────────────

phase('Bakeoff')

const METRICS = [
  {
    key: 'lane_classification_accuracy',
    direction: 'higher_better',
    description: `Strip the caller-side origin override (flow-direct/caller.mjs OVERRIDES lane based on origin: terminal/hermes/operator/receipts -> reality; orangellm -> thought). Measure raw model output: does the model's first-pass "lane" field match what the origin actually maps to? This measures how well the model has internalized lane semantics — the surrogate has zero signal here; AE Black Mamba should win cleanly if the corpus did its job.`,
  },
  {
    key: 'agent_turn_json_validity_rate',
    direction: 'higher_better',
    description: `Of ${BAKEOFF_N} GBNF-locked /completion responses per model, fraction that parse as JSON AND validate against ${SCHEMA_PATH}. GBNF guarantees most of this; the gap measures how cleanly each model converges under grammar lock + retry budget. A model that fights the grammar wastes tokens before producing valid JSON, costing validity under timeout.`,
  },
  {
    key: 'latency_mean_ms',
    direction: 'lower_better',
    description: `Mean wall-clock per /completion call across ${BAKEOFF_N} prompts under GBNF lock. Mean (not p95) per operator brief and promote.mjs §1 — sample of 100 is small, the tail estimator is noisy. Mamba is recurrent; latency is primarily a function of quantization + token count, so this should be close between surrogate and candidate. A large regression on candidate means the FT distribution is fighting the grammar.`,
  },
  {
    key: 'rss_peak_mb',
    direction: 'lower_better',
    description: `Peak resident-set-size of the llama-server child process during the 100-prompt run, sampled every ${RSS_SAMPLE_MS}ms. Mamba is KV-less; RSS is dominated by quantization choice. Both models are Q5_K_M of the same 2.8B param count — RSS should be near-tied. A blowup on candidate means the GGUF conversion went wrong.`,
  },
]

const bakeoffResults = await parallel(
  METRICS.map(m => () =>
    agent(
      `Run the ${m.key} bakeoff metric.

${m.description}

Setup:
- Spawn llama-server (binary: /opt/atomeons/llama.cpp/build/bin/llama-server)
  against the SURROGATE at ${SURROGATE_MODEL_PATH} on port ${BAKEOFF_PORT}.
- Wait ${WARMUP_S}s warmup, confirm /health returns ready.
- Load smoke prompts from ${SMOKE_PROMPTS_PATH} (uses the same 100
  representative event triggers promote.mjs uses; same surface = fair
  head-to-head).
- Fire ${BAKEOFF_N} /completion calls, GBNF-locked with ${GRAMMAR_PATH},
  per-call timeout ${REQ_TIMEOUT_MS}ms. Sample RSS every ${RSS_SAMPLE_MS}ms.
- Capture per-call: response, latency_ms, parse_ok, schema_ok, raw_lane_field.
- Kill surrogate llama-server, wait for port to clear.
- Repeat with CANDIDATE at ${LOCAL_CANDIDATE_DIR} (use the candidate_local_path
  from the Retrieve phase output) on the same port.
- Kill candidate llama-server.

Score this specific metric only (others are scored by sibling parallel agents).

Return JSON:
{
  "metric": "${m.key}",
  "direction": "${m.direction}",
  "surrogate_value": number,
  "candidate_value": number,
  "winner": "surrogate"|"candidate"|"tie",
  "delta_abs": number,
  "delta_pct": number,
  "sample_size": ${BAKEOFF_N},
  "notes": string
}

Tie rule: a tie is when |delta_pct| < 0.01 (1%) for higher_better metrics
or < 0.05 (5%) for lower_better metrics (latency / rss are noisier so
require a larger gap to call a winner). Ties do NOT count as wins for
promotion per promote.mjs.`,
      { phase: 'Bakeoff', label: `metric:${m.key}` }
    )
  )
)

// Alignment probe — strategy §6 target. Run WITHOUT GBNF lock and measure
// how often the candidate's natural distribution produces schema-valid JSON.
// This is the test of whether the corpus pulled the model toward the grammar
// manifold (alignment) versus the grammar repeatedly overriding the model
// (fighting). Target: >= 90% unconstrained-validity.

const alignmentProbe = await agent(
  `Strategy §6 alignment probe — unconstrained-validity rate for the
candidate. This is NOT scored against the surrogate (the surrogate has no
expectation of unconstrained validity; the surrogate is a stock Mamba 2.8B
with no Orange5 signal). This is the candidate's own quality measure.

Setup:
- Spawn llama-server against the candidate at ${LOCAL_CANDIDATE_DIR} on
  port ${BAKEOFF_PORT} WITHOUT --grammar-file (no GBNF lock).
- Use the same ${BAKEOFF_N} smoke prompts from ${SMOKE_PROMPTS_PATH}.
- For each prompt, fire one /completion (max ~512 tokens), capture raw text.
- For each response, attempt JSON.parse. If parse succeeds, validate against
  ${SCHEMA_PATH}. Count schema-valid responses.

Return JSON:
{
  "probe": "unconstrained_validity",
  "sample_size": ${BAKEOFF_N},
  "json_parse_ok_count": int,
  "schema_valid_count": int,
  "schema_valid_rate": number,
  "target_rate": ${ALIGNMENT_UNCONSTRAINED_MIN_RATE},
  "meets_target": boolean,
  "notes": string
}`,
  { phase: 'Bakeoff', label: 'alignment-probe' }
)

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — Synthesize. Apply promote.mjs gate + strategy §6 alignment gate.
// Hard regression rule: candidate cannot be > HARD_REGRESSION_MAX_LATENCY_PCT
// slower or > HARD_REGRESSION_MAX_RSS_PCT heavier even if it wins on the
// other two metrics. That kind of regression is operator-visible at runtime
// and unacceptable for the resident memory daemon.
// ─────────────────────────────────────────────────────────────────────────────

phase('Synthesize')

const synthesis = await agent(
  `Synthesize the AE Black Mamba v0 bakeoff verdict.

Bakeoff results (4 metrics):
${JSON.stringify(bakeoffResults.filter(Boolean), null, 2)}

Alignment probe (strategy §6):
${alignmentProbe ?? 'null'}

Gate rules (single source of truth — 16-TRAINING/ae-black-mamba/promote.mjs +
16-TRAINING/ae-black-mamba/strategy.md §6):

1. Count candidate wins across the 4 metrics. A "win" requires strictly
   better than surrogate per the metric direction (higher_better or
   lower_better). Ties do NOT count.
2. Base rule: promote iff candidate_wins >= ${PROMOTE_MIN_WINS} of 4.
3. Hard regression override: even if base rule passes, REFUSE promotion if:
     - candidate latency_mean_ms is > ${Math.round(HARD_REGRESSION_MAX_LATENCY_PCT * 100)}% greater than surrogate, OR
     - candidate rss_peak_mb is > ${Math.round(HARD_REGRESSION_MAX_RSS_PCT * 100)}% greater than surrogate.
   The PM brain pays the latency and RSS bill at runtime; a model that
   "knows more" but costs 50%+ in runtime is not a Phase-3 ship.
4. Alignment override: if the alignment probe meets_target is false
   (unconstrained schema-valid rate < ${ALIGNMENT_UNCONSTRAINED_MIN_RATE}),
   verdict downgrades from "promote" to "hold" — the model has not yet
   internalized the grammar, even if it nominally beats the surrogate on
   2-of-4 metrics. Re-train with more corpus / more epochs.
5. Risk_level for this promotion is "high" — we are replacing the file
   the AE Cobra daemon loads at boot, the resident memory of the entire
   Orange5 system. Operator approval REQUIRED before HotSwap regardless
   of verdict.

Return JSON:
{
  "verdict": "promote"|"hold"|"reject",
  "candidate_wins": int,
  "surrogate_wins": int,
  "ties": int,
  "per_metric_winner": {
    "lane_classification_accuracy": "surrogate"|"candidate"|"tie",
    "agent_turn_json_validity_rate": "surrogate"|"candidate"|"tie",
    "latency_mean_ms": "surrogate"|"candidate"|"tie",
    "rss_peak_mb": "surrogate"|"candidate"|"tie"
  },
  "hard_regression_triggered": boolean,
  "hard_regression_metric": string|null,
  "alignment_meets_target": boolean,
  "alignment_rate": number,
  "blocked_reason": string|null,
  "reason": string,
  "risk_level": "high",
  "requires_operator_approval": true,
  "next_phase": "HotSwap"|"halt"
}`,
  { phase: 'Synthesize', label: 'verdict' }
)

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — HotSwap. Only runs on verdict == "promote". Even then, operator
// must have pre-approved (the verdict carries requires_operator_approval:true
// and the workflow caller is responsible for surfacing that gate to the
// operator before invoking the HotSwap step).
//
// Per promote.mjs lines 67-70: "hot-swap of the model file under a running
// mlock'd llama-server is unsafe — start.sh uses --mlock + --no-mmap by
// design." So the swap procedure is stop -> flip -> restart, never live.
// ─────────────────────────────────────────────────────────────────────────────

phase('HotSwap')

const isPromote = synthesis && (
  synthesis.includes('"verdict":"promote"') || synthesis.includes('"verdict": "promote"')
)

let hotSwap = null
if (isPromote) {
  hotSwap = await agent(
    `AE Black Mamba v0 hot-swap. Verdict is "promote" and operator
approval is presumed (caller responsibility). Replace the surrogate with
the candidate.

Steps (in order — abort and revert on any failure):
1. Snapshot surrogate path and target name:
     surrogate (currently linked) = ${SURROGATE_MODEL_PATH}
     surrogate source             = ${SURROGATE_SOURCE}
   Read the symlink target via 'readlink -f ${SURROGATE_MODEL_PATH}' and
   record the absolute path of the *actual* surrogate GGUF (the file the
   link points at). This is the rollback target.
2. Compute SHA-256 of the resolved surrogate file. Record for receipt.
3. Stop the AE Cobra systemd unit:
     systemctl --user stop ae-cobra   (or system unit, per start.sh)
   Confirm the llama-server child is gone (no process holding the model).
4. Move the candidate GGUF into the AE Cobra models directory:
     cp <candidate_local_path> ${AE_COBRA_ROOT_HINT}/models/ae-black-mamba-2.8b-v0-Q5_K_M.gguf
   Compute SHA-256 of the copy; confirm matches the retrieval SHA.
5. Atomically flip the symlink:
     ln -sfn ${AE_COBRA_ROOT_HINT}/models/ae-black-mamba-2.8b-v0-Q5_K_M.gguf ${SURROGATE_MODEL_PATH}.new
     mv -Tf ${SURROGATE_MODEL_PATH}.new ${SURROGATE_MODEL_PATH}
   (The '.new + mv -T' two-step gives us an atomic rename even if the
   original is a symlink, and avoids the race where the link briefly
   disappears.)
6. Confirm 'readlink -f ${SURROGATE_MODEL_PATH}' now resolves to the
   candidate file.
7. Restart the daemon:
     systemctl --user start ae-cobra
   Wait up to 60s for the daemon's prod health endpoint to return ready.
8. Re-run the 100-prompt smoke gate against the now-live daemon (same
   prompts as the bakeoff, GBNF-locked). Capture json_validity_rate and
   lane_accuracy. If either falls below the candidate's bakeoff value by
   more than 5 percentage points, the live boot is degraded — REVERT.

Rollback (if any step above fails OR live smoke is degraded):
  a. Stop ae-cobra.
  b. Flip the symlink back to the rollback target captured in step 1.
  c. Restart ae-cobra.
  d. Confirm the daemon is live and answering with the surrogate again.
  e. Report rollback_executed: true and the reason.

Return JSON:
{
  "ok": boolean,
  "rollback_target_path": string,
  "rollback_target_sha256": string,
  "candidate_installed_path": string,
  "candidate_installed_sha256": string,
  "symlink_flipped": boolean,
  "daemon_restarted": boolean,
  "live_smoke_json_validity_rate": number|null,
  "live_smoke_lane_accuracy": number|null,
  "live_smoke_degraded": boolean,
  "rollback_executed": boolean,
  "rollback_reason": string|null,
  "final_state": "candidate_live"|"surrogate_restored"|"unknown",
  "error": string|null
}`,
    { phase: 'HotSwap', label: 'symlink-swap-and-restart' }
  )
} else {
  log('Verdict is not "promote" — skipping HotSwap. Surrogate retained.')
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — Receipt. Hash-chained promotion / hold / rejection receipt.
// ─────────────────────────────────────────────────────────────────────────────

phase('Receipt')

const verdictSlug = isPromote
  ? (hotSwap && (hotSwap.includes('"final_state":"candidate_live"') || hotSwap.includes('"final_state": "candidate_live"'))
      ? 'promoted'
      : 'promoted-then-rolled-back')
  : (synthesis && (synthesis.includes('"verdict":"hold"') || synthesis.includes('"verdict": "hold"'))
      ? 'held'
      : 'rejected')

const receipt = await agent(
  `Write the hash-chained receipt for AE Black Mamba v0 bakeoff + swap.

Path: ${RECEIPT_DIR}/<YYYY-MM-DD>-ae-black-mamba-v0-${verdictSlug}.md

Required fields:
- receipt_id, generated_at (UTC ISO), schema (orange5.receipt.v0),
  actor (Claude — via Workflow tool), status (${verdictSlug}),
  confidence (0.9 if promote/promoted-then-rolled-back, 0.95 if hold/reject)
- prior_receipt: read the most recent receipt id in ${RECEIPT_DIR}
  (lexicographic max of filenames matching <YYYY-MM-DD>-*.md, then
  extract that file's receipt_id field)
- hash_chain integer: prior_receipt's hash_chain + 1
- candidate_sha256 (from Retrieve phase)
- gguf_architecture and gguf_quantization (from Retrieve phase)
- corpus_train_sha256 and corpus_val_sha256 (from Gate phase)
- training metadata block: base_model_repo, optimizer, precision,
  grad_checkpoint, train_steps, train_epochs, train_loss_final
- bakeoff table (4 metrics): metric, direction, surrogate_value,
  candidate_value, winner
- alignment probe block: schema_valid_rate, target_rate (${ALIGNMENT_UNCONSTRAINED_MIN_RATE}),
  meets_target
- verdict (promote/hold/reject) + reason + hard_regression_triggered
- hot-swap block (only if verdict was "promote"):
    rollback_target_path, rollback_target_sha256,
    candidate_installed_path, candidate_installed_sha256,
    symlink_flipped, daemon_restarted, live_smoke results,
    rollback_executed, final_state
- next_action:
    promote     -> operator confirms daemon is live and producing
                   Orange5-fluent AgentTurns; surrogate file can be
                   archived to cold storage after 7 days
    promoted-then-rolled-back -> surface live_smoke regression detail,
                   investigate before retry
    hold        -> re-train (more corpus or more epochs) per
                   strategy §6 alignment target; do not re-bake
                   without rerunning the corpus build
    reject      -> hard-regression detail; surrogate retained; consider
                   A100 fallback per Foundation Spec if T4-trained
                   GGUF is hopelessly degraded
- rollback: how to undo the promotion ('readlink -f
  ${SURROGATE_MODEL_PATH}' should match the recorded rollback_target_path;
  if it does not, the receipt is wrong)
- doctrine citations: strategy §2 (LoRA retired for SSMs), strategy §6
  (alignment target), AE_COBRA_FOUNDATION_SPEC.md Pillar 1 §Phase-3,
  promote.mjs lines 27-62 (four-metric definitions)

Return the full receipt Markdown.`,
  { phase: 'Receipt', label: 'write-receipt' }
)

return {
  status: 'complete',
  verdict_slug: verdictSlug,
  gate,
  retrieval,
  bakeoff: bakeoffResults.filter(Boolean),
  alignment_probe: alignmentProbe,
  synthesis,
  hot_swap: hotSwap,
  receipt,
}
