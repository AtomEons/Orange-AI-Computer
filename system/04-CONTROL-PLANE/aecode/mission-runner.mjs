// AE Orange5 Control Plane — AECode mission runner.
//
// Executes a mission contract emitted by `compiler.mjs`. The runner walks the
// compiled bundle step by step, asking Hermes (/v1/hermes/action) for an
// action proposal at each step, applying the proposed patch to the working
// tree, running the gauntlet, writing a hash-chained receipt, and looping
// until the mission is `done`, `blocked`, or `aborted`.
//
// Pipeline (per AECode/AELang doctrine):
//
//   intent → AECode Source → mission contract → target plan →
//     ┌──── for each patchPlan.step ─────────────────────┐
//     │  1. Hermes /v1/hermes/action  → proposed patch    │
//     │  2. applyPatch                → mutate working    │
//     │  3. runGauntlet               → gates             │
//     │  4. writeReceipt              → hash-chained log  │
//     │  5. updateState               → done|next|blocked │
//     └───────────────────────────────────────────────────┘
//   → approval (operator) → promote
//
// Doctrine refs:
//   - Operates under AE0-AE14 departments. Receipt-first, visual-first.
//   - Schema:    09-SCHEMAS/aecode-final-format.schema.json
//   - Mission:   09-SCHEMAS/mission.schema.json
//   - Receipt:   09-SCHEMAS/receipt.schema.json (orange5.receipt.v0)
//   - Gauntlet:  09-SCHEMAS/gauntlet_result.schema.json (ae.gauntlet.v0)
//   - Order:     09-SCHEMAS/orange.order.v1.schema.json
//
// Surface (the four exports the control plane binds to):
//
//   runMission(bundle, opts)         → top-level driver, returns final state
//   stepOnce(state, opts)            → execute exactly one step (test-friendly)
//   defaultHermes(opts)              → factory for /v1/hermes/action client
//   __internal                       → topo helpers, status enum, receipt mint
//
// Honest gaps:
//   - This is the *runner*. It does not invent a Hermes server; it talks to
//     whatever client is injected via `opts.hermes` (default: HTTP fetch to
//     base_url + /v1/hermes/action). Hermes must already be reachable.
//   - applyPatch is intentionally conservative: only file-edit patches under
//     mission.allowed_paths land. Any path outside the allow-list blocks the
//     step with status="blocked", reason="scope_violation". No silent fallback.
//   - The gauntlet runner here is a *driver*: it iterates declared gates and
//     calls into adapters. Real gate implementations live in 04-CONTROL-PLANE/
//     promotion-gate and 04-CONTROL-PLANE/nine-gate-stack. A custom gauntlet
//     can be injected via `opts.gauntlet`.
//   - Receipts are written to disk under `opts.receiptDir` (default
//     10-RECEIPTS/orange5-build/<mission_id>/). The hash chain is sha256 of
//     (prior_receipt_hash || canonicalized_body). A broken chain triggers
//     rollback per mission.rollback_plan.triggers.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1. Constants.
// ─────────────────────────────────────────────────────────────────────────────

export const MISSION_STATUS = Object.freeze({
  PENDING:  "pending",
  RUNNING:  "running",
  DONE:     "done",
  BLOCKED:  "blocked",
  ABORTED:  "aborted",
  ROLLED_BACK: "rolled_back",
});

export const STEP_STATUS = Object.freeze({
  OK:           "ok",
  BLOCKED:      "blocked",
  GAUNTLET_FAIL:"gauntlet_fail",
  PATCH_FAIL:   "patch_fail",
  HERMES_FAIL:  "hermes_fail",
  SCOPE_VIOLATION: "scope_violation",
});

const RUNNER_VERSION = "0.1.0";
const RECEIPT_SCHEMA = "orange5.receipt.v0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// aecode/ → Orange5/10-RECEIPTS/orange5-build
const DEFAULT_RECEIPT_DIR = resolve(__dirname, "..", "..", "10-RECEIPTS", "orange5-build");
const DEFAULT_WORKING_DIR = resolve(__dirname, "..", "..", "..");

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2. Structured errors.
// ─────────────────────────────────────────────────────────────────────────────

export class RunnerError extends Error {
  constructor(message, { code, step_id, detail } = {}) {
    super(message);
    this.name = "RunnerError";
    this.code = code ?? "runner_error";
    this.step_id = step_id ?? null;
    this.detail = detail ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3. Default Hermes client — HTTP POST to /v1/hermes/action.
//
// Replace via opts.hermes in tests. The contract:
//   request:  { mission, step, target, lease_id?, context? }
//   response: { ok: boolean,
//               action: { kind: "patch"|"noop"|"abort", files?: [{path, op, content}], reason? },
//               proof:  { model, latency_ms, hermes_lease_id, gates_passed? } }
// ─────────────────────────────────────────────────────────────────────────────

export function defaultHermes({ baseUrl = "http://127.0.0.1:7430", fetchFn } = {}) {
  const f = fetchFn || (typeof fetch === "function" ? fetch : null);
  if (!f) {
    throw new RunnerError("no fetch available", { code: "no_fetch" });
  }
  return {
    async action(payload) {
      const url = `${baseUrl.replace(/\/+$/, "")}/v1/hermes/action`;
      let res;
      try {
        res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        throw new RunnerError(`hermes unreachable: ${e.message}`,
          { code: "hermes_unreachable", detail: { url } });
      }
      if (!res.ok) {
        const body = await safeText(res);
        throw new RunnerError(`hermes ${res.status}: ${body}`,
          { code: "hermes_http_error", detail: { status: res.status, body } });
      }
      let json;
      try { json = await res.json(); }
      catch (e) {
        throw new RunnerError(`hermes returned non-JSON: ${e.message}`,
          { code: "hermes_bad_json" });
      }
      if (!json || typeof json !== "object" || !("ok" in json) || !json.action) {
        throw new RunnerError(`hermes response missing {ok, action}`,
          { code: "hermes_bad_shape", detail: json });
      }
      return json;
    },
  };
}

async function safeText(res) {
  try { return await res.text(); } catch { return "<unreadable>"; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4. Path / scope policy. Closed-world: every write must fall under at
// least one allowed_paths entry, and must NOT fall under forbidden_paths.
// All comparisons normalize to forward-slash posix paths.
// ─────────────────────────────────────────────────────────────────────────────

function normPath(p) {
  if (typeof p !== "string") return "";
  return p.split(sep).join("/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function withinAny(target, prefixes) {
  const t = normPath(target);
  for (const p of prefixes) {
    const np = normPath(p);
    if (!np) continue;
    if (t === np) return true;
    if (t.startsWith(np.endsWith("/") ? np : np + "/")) return true;
  }
  return false;
}

export function checkScope(filePath, mission) {
  const allowed = Array.isArray(mission.allowed_paths) ? mission.allowed_paths : [];
  const forbidden = Array.isArray(mission.forbidden_paths) ? mission.forbidden_paths : [];

  // forbidden beats allowed (deny-first)
  if (forbidden.length && withinAny(filePath, forbidden)) {
    return { ok: false, reason: "path_in_forbidden_list", path: filePath };
  }
  if (allowed.length === 0) {
    return { ok: false, reason: "allowed_paths_empty", path: filePath };
  }
  if (!withinAny(filePath, allowed)) {
    return { ok: false, reason: "path_outside_allowed", path: filePath };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5. Patch application. Conservative: only `edit`, `create`, `delete`,
// `noop`. Every file edit re-checks scope. Failures return { ok:false, reason }.
//
// Patch shape (echoed back from Hermes):
//   { kind: "patch", files: [{ path, op: "edit"|"create"|"delete", content? }] }
// ─────────────────────────────────────────────────────────────────────────────

export function applyPatch(action, mission, opts = {}) {
  const workDir = opts.workingDir || DEFAULT_WORKING_DIR;
  const dryRun = !!opts.dryRun;

  if (!action || typeof action !== "object") {
    return { ok: false, reason: "missing_action", changed: [] };
  }
  if (action.kind === "noop") return { ok: true, changed: [], noop: true };
  if (action.kind === "abort") {
    return { ok: false, reason: action.reason || "hermes_requested_abort",
      changed: [], abort: true };
  }
  if (action.kind !== "patch") {
    return { ok: false, reason: `unknown_action_kind:${action.kind}`, changed: [] };
  }

  const files = Array.isArray(action.files) ? action.files : [];
  if (files.length === 0) {
    return { ok: false, reason: "patch_has_no_files", changed: [] };
  }

  // Pre-flight: every path must pass scope before any write lands.
  for (const f of files) {
    if (!f || typeof f.path !== "string" || !f.op) {
      return { ok: false, reason: "patch_file_malformed", changed: [], detail: f };
    }
    const scope = checkScope(f.path, mission);
    if (!scope.ok) {
      return { ok: false, reason: scope.reason, changed: [], detail: { path: f.path } };
    }
    if (!["edit", "create", "delete"].includes(f.op)) {
      return { ok: false, reason: `bad_file_op:${f.op}`, changed: [] };
    }
    if ((f.op === "edit" || f.op === "create") && typeof f.content !== "string") {
      return { ok: false, reason: "edit_or_create_requires_string_content",
        changed: [], detail: { path: f.path } };
    }
  }

  // Apply.
  const changed = [];
  for (const f of files) {
    const abs = join(workDir, ...normPath(f.path).split("/"));
    if (dryRun) {
      changed.push({ path: f.path, op: f.op, bytes: f.content?.length ?? 0, dryRun: true });
      continue;
    }
    try {
      if (f.op === "delete") {
        if (existsSync(abs)) unlinkSync(abs);
        changed.push({ path: f.path, op: "delete" });
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content, "utf8");
        changed.push({ path: f.path, op: f.op, bytes: f.content.length });
      }
    } catch (e) {
      return { ok: false, reason: "fs_write_failed",
        changed, detail: { path: f.path, error: e.message } };
    }
  }
  return { ok: true, changed };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6. Gauntlet driver. Iterates `bundle.gauntletSteps` filtered by the
// current patch step (or all of them, on a dedicated gauntlet pass) and asks
// the adapter to evaluate each gate. Returns a gauntlet_result.schema.json
// shaped object.
// ─────────────────────────────────────────────────────────────────────────────

export async function runGauntlet(gauntletSteps, ctx = {}, adapter) {
  const started_at = new Date().toISOString();
  const out = { gauntlet_id: ctx.gauntlet_id || "g_default",
    started_at, finished_at: null, ok: true, gates: [] };

  for (const step of gauntletSteps) {
    const gateRecord = {
      gate_id: step.gate_id,
      name: step.name,
      pass: false,
      evidence: [],
    };
    try {
      const r = adapter
        ? await adapter.evaluateGate(step, ctx)
        : { pass: true, evidence: [{ note: "no-adapter:default-pass-deterministic" }] };
      gateRecord.pass = !!r.pass;
      gateRecord.evidence = Array.isArray(r.evidence) ? r.evidence : [];
      if (r.reason) gateRecord.reason = r.reason;
    } catch (e) {
      gateRecord.pass = false;
      gateRecord.reason = `adapter_throw:${e.message}`;
    }
    out.gates.push(gateRecord);
    if (!gateRecord.pass && step.blocking) {
      out.ok = false;
      // continue iterating so the receipt is complete, but mark not-ok.
    }
  }
  out.finished_at = new Date().toISOString();
  out.ok = out.gates.every(g => g.pass);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7. Receipt writer. orange5.receipt.v0 shape with sha256 hash chain.
// ─────────────────────────────────────────────────────────────────────────────

function canonical(o) {
  // stable JSON: sorted keys, deterministic output.
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(canonical).join(",") + "]";
  const keys = Object.keys(o).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

export function mintReceipt({
  mission, step, action_outcome, gauntlet_result, prior_receipt, hash_chain, actor,
  status, confidence, blockers = [], next_action = null, rollback_hint = null,
}) {
  const receipt_id = `${mission.mission_id}__${step?.step_id || "init"}__rcpt`;
  const body = {
    receipt_id,
    generated_at: new Date().toISOString(),
    schema: RECEIPT_SCHEMA,
    actor: actor || mission?.receipt_plan?.writer || "control-plane",
    sovereign: "atom.mccree",
    status,
    confidence: clamp01(confidence),
    prior_receipt: prior_receipt ?? null,
    hash_chain,
    actions: action_outcome ? [{
      step_id: step?.step_id || null,
      node: step?.node || null,
      kind: step?.kind || null,
      changed: action_outcome.changed || [],
      noop: !!action_outcome.noop,
      ok: !!action_outcome.ok,
      reason: action_outcome.reason || null,
    }] : [],
    evidence: gauntlet_result ? [{
      kind: "gauntlet_result",
      gauntlet_id: gauntlet_result.gauntlet_id,
      ok: gauntlet_result.ok,
      gates: gauntlet_result.gates,
    }] : [],
    blockers,
    next_action: next_action || "",
    rollback: rollback_hint || mission?.rollback_plan?.strategy || "git_reset_hard",
  };
  const chain_hash = sha256((prior_receipt ?? "") + canonical(body));
  body.chain_hash = chain_hash;
  return body;
}

function clamp01(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0; if (n > 1) return 1;
  return n;
}

export function writeReceipt(receipt, receiptDir) {
  const dir = resolve(receiptDir);
  mkdirSync(dir, { recursive: true });
  const safeId = receipt.receipt_id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = join(dir, `${safeId}.json`);
  writeFileSync(file, JSON.stringify(receipt, null, 2), "utf8");
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8. State machine — pure function over (state, step) → next state.
// State lives in memory while the run is happening, and a copy is persisted in
// the latest receipt under `evidence` so runs are resumable in principle.
// ─────────────────────────────────────────────────────────────────────────────

export function initialState(bundle, opts = {}) {
  if (!bundle || !bundle.mission || !bundle.patchPlan) {
    throw new RunnerError("initialState: bundle must include mission and patchPlan",
      { code: "bad_bundle" });
  }
  return {
    mission_id: bundle.mission.mission_id,
    mission: bundle.mission,
    order: bundle.order,
    targetPlan: bundle.targetPlan,
    patchSteps: bundle.patchPlan.steps.slice(),
    gauntletSteps: bundle.gauntletSteps.slice(),
    receiptPlan: bundle.receiptPlan,
    rollbackPlan: bundle.rollbackPlan,
    cursor: 0,
    status: MISSION_STATUS.PENDING,
    prior_receipt_hash: null,
    receipt_chain_index: 0,
    receipt_paths: [],
    blockers: [],
    aborted_reason: null,
    max_steps: opts.maxSteps ?? bundle.patchPlan.steps.length + 8,
    iterations: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9. stepOnce — drive exactly one step. Returns updated state and
// the receipt that was written.
//
// Step lifecycle:
//   (a) if cursor >= patchSteps.length → final gauntlet pass then DONE
//   (b) ask Hermes for action proposal
//   (c) applyPatch (scope-checked)
//   (d) optional per-step gauntlet
//   (e) write receipt
//   (f) advance cursor or block
// ─────────────────────────────────────────────────────────────────────────────

export async function stepOnce(state, opts = {}) {
  if (state.status === MISSION_STATUS.DONE ||
      state.status === MISSION_STATUS.BLOCKED ||
      state.status === MISSION_STATUS.ABORTED ||
      state.status === MISSION_STATUS.ROLLED_BACK) {
    return { state, receipt: null, terminal: true };
  }

  state.status = MISSION_STATUS.RUNNING;
  state.iterations += 1;
  if (state.iterations > state.max_steps) {
    state.status = MISSION_STATUS.BLOCKED;
    state.blockers.push({ code: "max_steps_exceeded", iterations: state.iterations });
    const receipt = mintReceipt({
      mission: state.mission, step: null,
      action_outcome: null, gauntlet_result: null,
      prior_receipt: state.prior_receipt_hash,
      hash_chain: ++state.receipt_chain_index,
      status: "blocked", confidence: 0,
      blockers: state.blockers, next_action: "human_review",
    });
    const path = writeReceipt(receipt, opts.receiptDir || join(DEFAULT_RECEIPT_DIR, state.mission_id));
    state.receipt_paths.push(path);
    state.prior_receipt_hash = receipt.chain_hash;
    return { state, receipt, terminal: true };
  }

  const hermes = opts.hermes || defaultHermes({ baseUrl: opts.hermesBaseUrl });
  const receiptDir = opts.receiptDir || join(DEFAULT_RECEIPT_DIR, state.mission_id);

  const isFinalGauntlet = state.cursor >= state.patchSteps.length;
  const step = isFinalGauntlet
    ? { step_id: `${state.mission_id}__final_gauntlet`, node: "final_gauntlet", kind: "verify", files: [] }
    : state.patchSteps[state.cursor];

  // 1. Ask Hermes for an action (skipped on final gauntlet pass).
  let action = { kind: "noop" };
  let proof = null;
  if (!isFinalGauntlet) {
    let resp;
    try {
      resp = await hermes.action({
        mission: state.mission,
        step,
        target: state.targetPlan[0] || null,
        lease_id: opts.lease_id || null,
        context: { iterations: state.iterations, cursor: state.cursor },
      });
    } catch (e) {
      state.status = MISSION_STATUS.BLOCKED;
      state.blockers.push({ code: "hermes_fail", step_id: step.step_id, error: e.message });
      const receipt = mintReceipt({
        mission: state.mission, step,
        action_outcome: { ok: false, reason: "hermes_fail", changed: [] },
        gauntlet_result: null,
        prior_receipt: state.prior_receipt_hash,
        hash_chain: ++state.receipt_chain_index,
        status: STEP_STATUS.HERMES_FAIL, confidence: 0,
        blockers: state.blockers, next_action: "fix_hermes_or_abort",
        rollback_hint: state.rollbackPlan.strategy,
      });
      const path = writeReceipt(receipt, receiptDir);
      state.receipt_paths.push(path);
      state.prior_receipt_hash = receipt.chain_hash;
      return { state, receipt, terminal: false };
    }
    action = resp.action;
    proof  = resp.proof || null;
  }

  // 2. Apply patch (scope-checked).
  const action_outcome = isFinalGauntlet
    ? { ok: true, changed: [], noop: true }
    : applyPatch(action, state.mission, {
        workingDir: opts.workingDir,
        dryRun: opts.dryRun,
      });

  if (!action_outcome.ok) {
    state.status = MISSION_STATUS.BLOCKED;
    const code = action_outcome.abort ? STEP_STATUS.HERMES_FAIL :
                 /scope|allowed|forbidden/.test(action_outcome.reason || "") ?
                 STEP_STATUS.SCOPE_VIOLATION : STEP_STATUS.PATCH_FAIL;
    state.blockers.push({ code, step_id: step.step_id, reason: action_outcome.reason,
      detail: action_outcome.detail || null });
    const receipt = mintReceipt({
      mission: state.mission, step, action_outcome,
      gauntlet_result: null,
      prior_receipt: state.prior_receipt_hash,
      hash_chain: ++state.receipt_chain_index,
      status: code, confidence: 0,
      blockers: state.blockers, next_action: "operator_review",
      rollback_hint: state.rollbackPlan.strategy,
    });
    const path = writeReceipt(receipt, receiptDir);
    state.receipt_paths.push(path);
    state.prior_receipt_hash = receipt.chain_hash;
    return { state, receipt, terminal: false };
  }

  // 3. Gauntlet pass for this step (subset: gates not bound to a node OR
  //    bound to the current step's node). Final pass runs every gate.
  const gates = isFinalGauntlet
    ? state.gauntletSteps
    : state.gauntletSteps.filter(g => !g.node || g.node === step.node);

  const gauntlet_result = await runGauntlet(gates, {
    mission_id: state.mission_id,
    step_id: step.step_id,
    gauntlet_id: isFinalGauntlet ? "final" : (gates[0]?.gauntlet_id || "per_step"),
    changed: action_outcome.changed,
    proof,
  }, opts.gauntlet);

  // 4. Mint + write receipt.
  const stepStatus = gauntlet_result.ok ? STEP_STATUS.OK : STEP_STATUS.GAUNTLET_FAIL;
  const receipt = mintReceipt({
    mission: state.mission, step, action_outcome, gauntlet_result,
    prior_receipt: state.prior_receipt_hash,
    hash_chain: ++state.receipt_chain_index,
    status: stepStatus,
    confidence: gauntlet_result.ok ? 1 : 0,
    blockers: gauntlet_result.ok ? [] : [{
      code: "gauntlet_fail",
      failing_gates: gauntlet_result.gates.filter(g => !g.pass).map(g => g.gate_id),
    }],
    next_action: gauntlet_result.ok
      ? (isFinalGauntlet ? "promote" : "next_step")
      : "rollback_or_repatch",
    rollback_hint: gauntlet_result.ok ? null : state.rollbackPlan.strategy,
  });
  const path = writeReceipt(receipt, receiptDir);
  state.receipt_paths.push(path);
  state.prior_receipt_hash = receipt.chain_hash;

  // 5. Advance / block / complete.
  if (!gauntlet_result.ok) {
    state.status = MISSION_STATUS.BLOCKED;
    state.blockers.push({
      code: "gauntlet_fail", step_id: step.step_id,
      failing_gates: gauntlet_result.gates.filter(g => !g.pass).map(g => g.gate_id),
    });
    return { state, receipt, terminal: false };
  }
  if (isFinalGauntlet) {
    state.status = MISSION_STATUS.DONE;
    return { state, receipt, terminal: true };
  }
  state.cursor += 1;
  return { state, receipt, terminal: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10. runMission — top-level driver loop.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a compiled bundle until DONE / BLOCKED / ABORTED.
 *
 * @param {object} bundle — output of compiler.mjs `compile()` or `compileSource()`.
 * @param {object} [opts]
 * @param {object} [opts.hermes]        — Hermes client (defaults to HTTP).
 * @param {string} [opts.hermesBaseUrl] — base url for default Hermes (http://127.0.0.1:7430).
 * @param {object} [opts.gauntlet]      — gauntlet adapter (evaluateGate(step, ctx) → {pass, evidence?, reason?}).
 * @param {string} [opts.receiptDir]    — override receipt root.
 * @param {string} [opts.workingDir]    — override working tree root.
 * @param {string} [opts.lease_id]      — optional Hermes lease to thread through.
 * @param {number} [opts.maxSteps]      — cap on iterations (default = patchSteps + 8).
 * @param {boolean}[opts.dryRun]        — skip fs writes; receipts still written.
 * @param {(state, receipt) => void} [opts.onStep] — observer.
 * @returns {Promise<{ state: object, receipts: string[], status: string }>}
 */
export async function runMission(bundle, opts = {}) {
  const state = initialState(bundle, opts);

  for (;;) {
    const { receipt, terminal } = await stepOnce(state, opts);
    if (typeof opts.onStep === "function") opts.onStep(state, receipt);
    if (terminal) break;
  }

  // If we ended in BLOCKED and rollback triggers match, fire rollback.
  if (state.status === MISSION_STATUS.BLOCKED && shouldRollback(state)) {
    await rollback(state, opts);
  }

  return {
    state,
    receipts: state.receipt_paths,
    status: state.status,
    mission_id: state.mission_id,
    blockers: state.blockers,
    runner: { version: RUNNER_VERSION },
  };
}

function shouldRollback(state) {
  const triggers = state.rollbackPlan?.triggers || [];
  const codes = new Set(state.blockers.map(b => b.code));
  if (codes.has("gauntlet_fail") && triggers.includes("gauntlet_fail")) return true;
  if (codes.has("scope_violation") && triggers.includes("scope_violation")) return true;
  return false;
}

async function rollback(state, opts) {
  // The runner does not invent git operations. It records intent and emits a
  // rollback receipt. The actual rollback strategy is honored by the AE10_OPS
  // adapter or the operator. If opts.rollbackAdapter is supplied, call it.
  let outcome = { ok: true, note: "rollback_recorded_intent_only" };
  if (opts.rollbackAdapter && typeof opts.rollbackAdapter.execute === "function") {
    try {
      outcome = await opts.rollbackAdapter.execute(state.rollbackPlan, state);
    } catch (e) {
      outcome = { ok: false, error: e.message };
    }
  }
  const receipt = mintReceipt({
    mission: state.mission, step: { step_id: `${state.mission_id}__rollback`, node: "rollback", kind: "rollback" },
    action_outcome: { ok: outcome.ok, changed: [], noop: false, reason: outcome.error || null },
    gauntlet_result: null,
    prior_receipt: state.prior_receipt_hash,
    hash_chain: ++state.receipt_chain_index,
    status: outcome.ok ? "rolled_back" : "rollback_failed",
    confidence: outcome.ok ? 1 : 0,
    blockers: state.blockers,
    next_action: "human_review",
    rollback_hint: state.rollbackPlan.strategy,
  });
  const path = writeReceipt(receipt, opts.receiptDir || join(DEFAULT_RECEIPT_DIR, state.mission_id));
  state.receipt_paths.push(path);
  state.prior_receipt_hash = receipt.chain_hash;
  state.status = outcome.ok ? MISSION_STATUS.ROLLED_BACK : MISSION_STATUS.ABORTED;
  if (!outcome.ok) state.aborted_reason = outcome.error || "rollback_failed";
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11. Receipt-chain audit utility — readback path for tests + tools.
// ─────────────────────────────────────────────────────────────────────────────

export function verifyReceiptChain(receiptPaths) {
  let prior = null;
  let idx = 0;
  for (const p of receiptPaths) {
    idx += 1;
    if (!existsSync(p)) {
      return { ok: false, broken_at: idx, reason: "missing_file", path: p };
    }
    let body;
    try { body = JSON.parse(readFileSync(p, "utf8")); }
    catch (e) { return { ok: false, broken_at: idx, reason: "bad_json", path: p, detail: e.message }; }
    if (body.schema !== RECEIPT_SCHEMA) {
      return { ok: false, broken_at: idx, reason: "bad_schema", path: p, detail: body.schema };
    }
    if (body.prior_receipt !== prior) {
      return { ok: false, broken_at: idx, reason: "prior_mismatch", path: p,
        detail: { expected: prior, got: body.prior_receipt } };
    }
    // recompute chain_hash
    const without = { ...body }; delete without.chain_hash;
    const expected = sha256((prior ?? "") + canonical(without));
    if (expected !== body.chain_hash) {
      return { ok: false, broken_at: idx, reason: "chain_hash_mismatch", path: p };
    }
    prior = body.chain_hash;
  }
  return { ok: true, length: idx, tip: prior };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12. Internal surface for tests.
// ─────────────────────────────────────────────────────────────────────────────

export const __internal = Object.freeze({
  canonical, sha256, normPath, withinAny, clamp01,
  DEFAULT_RECEIPT_DIR, DEFAULT_WORKING_DIR, RUNNER_VERSION, RECEIPT_SCHEMA,
});
