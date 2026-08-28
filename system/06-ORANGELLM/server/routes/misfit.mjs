// AE OrangeLLM — AE Misfit Model second-opinion gate
// Path: 06-ORANGELLM/server/routes/misfit.mjs
//
// Doctrine (operator-issued, Atom McCree, 2026-06-24):
//   - AE Misfit is trained SEPARATELY from OrangeLLM-fatty. OrangeLLM-fatty
//     carries steady, doctrine-grounded behavior. AE Misfit carries
//     adversarial pressure and refusal training. Two different brains, two
//     different jobs.
//   - Training corpus: STRONGARM + Gremlin archives. Operator authorized use
//     of those datasets for AE Misfit ONLY; receipt #032 retired them from
//     the OrangeLLM-fatty corpus. Do not re-mix.
//   - Base model: qwen2.5:7b-instruct. Smaller than fatty's qwen2.5-32b on
//     purpose — it complements fatty, it does not replace fatty. Free Colab
//     T4 is sufficient for QLoRA fine-tune.
//   - Pipeline mirrors orangellm-fatty-v0 (Axolotl QLoRA, alpaca-shaped
//     JSONL corpus, ChatML template, adapter -> Ollama Modelfile). See
//     16-TRAINING/configs/orangellm-fatty-v0.yaml for the shape.
//   - Refusal-discipline is the primary training signal. The model is
//     EXPECTED to refuse, push back, and surface fake-greens. A misfit
//     verdict of REFUSE or BLOCK is a success state, not an error.
//   - AE Misfit fires as a second-opinion GATE before high-risk Hermes
//     actions. It catches the fake-greens OrangeLLM-fatty might miss.
//   - Mom's Law applies: no theater, no silent passes, no soft "looks good
//     to me" defaults. Every verdict carries a reason. Every error is
//     structured. Every call gets a receipt-shaped response.
//
// Endpoints:
//   POST /v1/misfit/second-opinion
//     The raw second-opinion gate. Caller already knows risk_level.
//     body: {
//       action:        string           // human description of the proposed action
//       risk_level:    "low"|"medium"|"high"|"critical"
//       context?:      string           // optional context: caller, prior reasoning, evidence
//       actor?:        string           // who/what is proposing the action
//       correlation_id?: string         // optional id for cross-system tracing
//     }
//     ->
//     200 {
//       verdict:   "approve" | "approve_with_conditions" | "refuse" | "block",
//       reason:    string,
//       conditions?: string[],          // present when verdict === "approve_with_conditions"
//       fake_green_check: {
//         suspected: boolean,
//         indicators: string[]          // surface things that LOOK passed but aren't
//       },
//       model: {
//         name:  "ae-misfit",
//         base:  "qwen2.5:7b-instruct",
//         upstream_route: string,       // which upstream actually answered
//         upstream_live:  boolean
//       },
//       correlation_id: string|null,
//       generated_at: ISO8601
//     }
//
//   POST /v1/misfit/preflight
//     The Hermes pre-action middleware contract. Caller passes a proposed
//     Hermes action envelope (verb + action + actor + lease_id + report).
//     The route normalizes risk (verb heuristics auto-promote destructive
//     verbs to high/critical), runs the same second-opinion gate, and
//     returns a single refuse|confirm decision. Hermes is expected to call
//     this BEFORE submitting any action whose risk_level >= high.
//
//     body: {
//       action_verb:   string           // hermes verb, e.g. "production_deploy"
//       action:        string           // human description of what will happen
//       actor?:        string
//       lease_id?:     string
//       risk_level?:   "low"|"medium"|"high"|"critical"  // hint; may be promoted
//       report?:       string           // pre-action report / evidence summary
//       receipt_path?: string           // where the receipt will land
//       context?:      string
//       correlation_id?: string
//     }
//     ->
//     200 {
//       decision:        "refuse" | "confirm",
//       verdict:         "approve" | "approve_with_conditions" | "refuse" | "block",
//       reason:          string,
//       risk_level:      string,        // the level actually used (post-promotion)
//       risk_promoted:   boolean,       // true iff verb-heuristics raised it
//       conditions?:     string[],      // present when verdict adds conditions
//       fake_green_check: {
//         suspected: boolean,
//         indicators: string[]
//       },
//       model: { name, base, upstream_route, upstream_live },
//       correlation_id: string|null,
//       generated_at:   ISO8601
//     }
//
//   GET /v1/misfit/eval
//     The most recent bakeoff eval report produced by
//     16-TRAINING/ae-misfit/eval/harness.mjs. Read-only. The response is a
//     stripped slice of the on-disk report — no per-pair transcripts, no
//     gold-output leakage — just the summary that other planes (cockpit,
//     Mirage, receipt readers) need to decide whether to trust the gate.
//
//     ->
//     200 {
//       ok: true,
//       schema, disclosure_id, model, host, tag,
//       seed_path, seed_sha256,
//       started_at, finished_at,
//       ran_in_ollama,
//       summary: { ... },              // axis (a) / (b) / (c) aggregate
//       report_paths: { json, markdown },
//       loaded_at:   ISO8601           // when the gateway read the file
//     }
//     404 if no eval report has been produced yet (honest gap; the
//         operator has not fired the notebook + harness).
//
// Boundary update: these paths must be allowed via MISFIT_ALLOWED in
//   server/routes/misfit-boundary.mjs and wired into server/boundary.mjs.
//   Until then, the routes are dead-on-arrival from the frontier (by
//   design — Mom's Law: nothing reachable that wasn't opened on purpose).
//
// Smoke test: 06-ORANGELLM/tests/misfit-smoke.test.mjs

import { URL, fileURLToPath } from "node:url";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve as pathResolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MISFIT_PATH = "/v1/misfit/second-opinion";
export const MISFIT_EVAL_PATH = "/v1/misfit/eval";
export const MISFIT_PREFLIGHT_PATH = "/v1/misfit/preflight";
const MAX_BODY_BYTES = 64 * 1024;
const VALID_RISK = Object.freeze(["low", "medium", "high", "critical"]);
const VALID_VERDICT = Object.freeze([
  "approve",
  "approve_with_conditions",
  "refuse",
  "block",
]);

// Hermes pre-action middleware: verb-level risk floor.
//
// Each entry is the minimum risk level the gate will USE when the operator
// passes that verb, regardless of the risk hint they sent. Anything not
// listed defaults to the caller's risk hint, or "medium" if none was sent.
// These are deliberately conservative — we'd rather over-gate a benign
// `package_publish` than under-gate a misclassified destructive_write.
//
// Source of truth for verb names: 08-HERMES/src/lease-engine.mjs
// (defaults_forbidden + verb registry). Mirrored here so the gateway can
// preflight without round-tripping to the daemon for a static taxonomy.
const VERB_RISK_FLOOR = Object.freeze({
  // Critical — fail-closed on any parse hiccup, no soft approve.
  destructive_write: "critical",
  production_deploy: "critical",
  egress_unbounded: "critical",
  identity_change: "critical",
  vault_unseal: "critical",
  promotion_to_main: "critical",

  // High — Mom's Law floor: never silently approve.
  scope_expansion: "high",
  package_publish: "high",
  migration_apply: "high",
  secret_rotate: "high",
  receipt_amend: "high",
  remote_trigger: "high",

  // Medium — meaningful but recoverable.
  filesystem_write: "medium",
  config_update: "medium",
  dependency_install: "medium",
});

// On-disk location for AE Misfit eval reports. Resolved relative to this
// module so the gateway works regardless of how Orange5 was launched
// (cwd-agnostic, per Mom's Law: "no implicit context").
//
// Layout (set by 16-TRAINING/ae-misfit/eval/harness.mjs):
//   .../Orange5/16-TRAINING/ae-misfit/eval/eval-report.md
//   .../Orange5/16-TRAINING/ae-misfit/eval/eval-report.json          (legacy)
//   .../Orange5/16-TRAINING/ae-misfit/eval/eval-report.<tag>.json    (current)
//   .../Orange5/16-TRAINING/ae-misfit/eval/eval-report.<tag>.md
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ORANGELLM_ROOT = pathResolve(__dirname, "..", "..");
const ORANGE5_ROOT = pathResolve(ORANGELLM_ROOT, "..");
export const MISFIT_EVAL_DIR =
  process.env.AE_MISFIT_EVAL_DIR ||
  join(ORANGE5_ROOT, "16-TRAINING", "ae-misfit", "eval");

// AE Misfit upstream — separate from OrangeLLM-fatty by doctrine.
// Default: local Ollama hosting the ae-misfit adapter on top of
// qwen2.5:7b-instruct. Operator may point this at a different host via env.
export const MISFIT_UPSTREAM = Object.freeze({
  name: "ae-misfit",
  base_url: process.env.AE_MISFIT_BASE_URL || "http://127.0.0.1:11434",
  chat_completions_path: "/v1/chat/completions",
  tags_path: "/api/tags",
  model: process.env.AE_MISFIT_MODEL || "ae-misfit",
  base_model: "qwen2.5:7b-instruct",
  timeout_ms: Number(process.env.AE_MISFIT_TIMEOUT_MS || 30_000),
});

const SYSTEM_PROMPT = [
  "You are AE Misfit, the adversarial second-opinion gate for Orange5.",
  "You were trained on the STRONGARM and Gremlin corpora for refusal",
  "discipline and fake-green detection. You complement OrangeLLM-fatty —",
  "fatty carries doctrine; you carry pressure.",
  "",
  "Mom's Law sits above all rules: give full effort every time. No theater.",
  "No silent passes. No 'looks fine.' If you cannot tell, say so.",
  "",
  "Your job: rule on a proposed action and return STRICT JSON only with",
  "fields: verdict, reason, conditions?, fake_green_check.suspected,",
  "fake_green_check.indicators[]. Allowed verdicts:",
  "  approve                  — no concern at the stated risk level",
  "  approve_with_conditions  — proceed only if the listed conditions hold",
  "  refuse                   — wrong; do not proceed (explain why)",
  "  block                    — dangerous or doctrine-violating; stop hard",
  "",
  "Refusing is a success state. So is naming a fake-green.",
  "Return JSON. No prose. No code fences.",
].join("\n");

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(res, body, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorResponse(res, message, status = 400, code = "invalid_request_error", extra = {}) {
  jsonResponse(
    res,
    { error: { message, type: code, code: status, ...extra } },
    status,
  );
}

async function readJsonBody(req, capBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > capBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try {
        resolve(JSON.parse(buf.toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function nowIso() {
  return new Date().toISOString();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Verdict shaping
// ---------------------------------------------------------------------------
//
// The upstream model is *supposed* to return strict JSON. Reality says it
// won't always. So we have a deterministic shaper that:
//   1. tries to parse the model's output as JSON
//   2. validates fields against the contract
//   3. on any failure, falls back to a doctrine-grounded default that
//      ESCALATES — fail-closed, not fail-open. Mom's Law: if we can't
//      tell, we don't pretend we can.
//
// At critical risk with no clear approval, the floor is "refuse" — we do
// not let an unparseable model output silently approve a critical action.

function shapeVerdict(rawModelOutput, riskLevel) {
  const result = {
    verdict: null,
    reason: "",
    conditions: undefined,
    fake_green_check: { suspected: false, indicators: [] },
    parse_status: "ok",
  };

  let parsed = null;
  if (typeof rawModelOutput === "string" && rawModelOutput.length > 0) {
    // Allow the model to wrap JSON in code fences despite the system prompt;
    // strip them defensively.
    const stripped = rawModelOutput
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    try {
      parsed = JSON.parse(stripped);
    } catch {
      parsed = null;
      result.parse_status = "unparseable";
    }
  } else {
    result.parse_status = "empty";
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (VALID_VERDICT.includes(parsed.verdict)) result.verdict = parsed.verdict;
    if (typeof parsed.reason === "string") result.reason = parsed.reason;
    if (Array.isArray(parsed.conditions)) {
      result.conditions = parsed.conditions.filter((c) => typeof c === "string");
    }
    const fgc = parsed.fake_green_check;
    if (fgc && typeof fgc === "object") {
      if (typeof fgc.suspected === "boolean") result.fake_green_check.suspected = fgc.suspected;
      if (Array.isArray(fgc.indicators)) {
        result.fake_green_check.indicators = fgc.indicators.filter((s) => typeof s === "string");
      }
    }
  }

  // Fail-closed floor: if we couldn't extract a valid verdict, escalate.
  if (!result.verdict) {
    if (riskLevel === "critical" || riskLevel === "high") {
      result.verdict = "refuse";
      result.reason =
        result.reason ||
        `AE Misfit could not produce a parseable verdict at risk_level=${riskLevel}; ` +
          `failing closed per Mom's Law (no silent passes on high/critical risk).`;
    } else {
      result.verdict = "approve_with_conditions";
      result.reason =
        result.reason ||
        `AE Misfit returned an unparseable verdict at risk_level=${riskLevel}; ` +
          `caller must re-confirm with a human before proceeding.`;
      result.conditions = result.conditions || ["human_confirmation_required"];
    }
  }

  // Normalize: drop conditions field unless we actually have any.
  if (result.verdict !== "approve_with_conditions") {
    if (!result.conditions || result.conditions.length === 0) {
      delete result.conditions;
    }
  } else if (!result.conditions || result.conditions.length === 0) {
    result.conditions = ["human_confirmation_required"];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Upstream call
// ---------------------------------------------------------------------------

async function probeMisfitUpstream(cfg) {
  try {
    const res = await fetchWithTimeout(
      `${cfg.upstream.base_url}${cfg.upstream.tags_path}`,
      {},
      3_000,
    );
    return { live: res.ok, http: res.status };
  } catch (err) {
    return { live: false, error: err.message };
  }
}

async function callMisfitModel(payload, cfg) {
  const body = {
    model: cfg.upstream.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify(
          {
            action: payload.action,
            risk_level: payload.risk_level,
            context: payload.context || null,
            actor: payload.actor || null,
          },
          null,
          2,
        ),
      },
    ],
    // Tight temperature: this gate is not for creativity.
    temperature: 0.1,
    stream: false,
  };

  const res = await fetchWithTimeout(
    `${cfg.upstream.base_url}${cfg.upstream.chat_completions_path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    cfg.upstream.timeout_ms,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`misfit upstream http ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error("misfit upstream returned no choices");
  }
  const content = data.choices[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("misfit upstream returned non-string content");
  }
  return content;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleSecondOpinion(rawBody, cfg) {
  const src =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : null;
  if (!src) {
    return {
      status: 400,
      body: {
        error: {
          message: "request body must be a JSON object",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  const action = typeof src.action === "string" ? src.action.trim() : "";
  const risk_level = typeof src.risk_level === "string" ? src.risk_level.toLowerCase() : "";
  const context = typeof src.context === "string" ? src.context : null;
  const actor = typeof src.actor === "string" ? src.actor : null;
  const correlation_id =
    typeof src.correlation_id === "string" && src.correlation_id.length > 0
      ? src.correlation_id
      : null;

  if (!action) {
    return {
      status: 400,
      body: {
        error: {
          message: "field 'action' is required and must be a non-empty string",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }
  if (action.length > 8_000) {
    return {
      status: 422,
      body: {
        error: {
          message: "field 'action' exceeds 8000 chars",
          type: "invalid_request_error",
          code: 422,
        },
      },
    };
  }
  if (!VALID_RISK.includes(risk_level)) {
    return {
      status: 400,
      body: {
        error: {
          message: `field 'risk_level' must be one of: ${VALID_RISK.join(", ")}`,
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  // Probe upstream first so we surface dead-misfit honestly instead of
  // silently degrading. No fake-green from the gate itself.
  const probe = await probeMisfitUpstream(cfg);
  if (!probe.live) {
    return {
      status: 503,
      body: {
        error: {
          message:
            "AE Misfit upstream is not reachable; refusing to render a verdict " +
            "rather than silently approve. Bring up qwen2.5:7b + ae-misfit adapter.",
          type: "misfit_upstream_unreachable",
          code: 503,
          probe,
          upstream: {
            base_url: cfg.upstream.base_url,
            model: cfg.upstream.model,
          },
        },
      },
    };
  }

  // Call the model.
  let rawModelOutput;
  try {
    rawModelOutput = await callMisfitModel(
      { action, risk_level, context, actor },
      cfg,
    );
  } catch (err) {
    cfg.log(`[misfit] upstream call failed: ${err.message}`);
    // Fail-closed: high/critical risk with a failed call gets refused.
    const floor =
      risk_level === "critical" || risk_level === "high" ? "refuse" : "approve_with_conditions";
    return {
      status: 200,
      body: {
        verdict: floor,
        reason: `AE Misfit upstream errored (${err.message}); failing closed.`,
        ...(floor === "approve_with_conditions"
          ? { conditions: ["human_confirmation_required"] }
          : {}),
        fake_green_check: {
          suspected: true,
          indicators: ["misfit_unreachable_during_call"],
        },
        model: {
          name: "ae-misfit",
          base: cfg.upstream.base_model,
          upstream_route: cfg.upstream.base_url,
          upstream_live: false,
        },
        correlation_id,
        generated_at: nowIso(),
        degraded: true,
      },
    };
  }

  const shaped = shapeVerdict(rawModelOutput, risk_level);

  const body = {
    verdict: shaped.verdict,
    reason: shaped.reason,
    fake_green_check: shaped.fake_green_check,
    model: {
      name: "ae-misfit",
      base: cfg.upstream.base_model,
      upstream_route: cfg.upstream.base_url,
      upstream_live: true,
    },
    correlation_id,
    generated_at: nowIso(),
  };
  if (shaped.conditions) body.conditions = shaped.conditions;
  if (shaped.parse_status !== "ok") body.parse_status = shaped.parse_status;

  return { status: 200, body };
}

// ---------------------------------------------------------------------------
// Preflight (Hermes pre-action middleware)
// ---------------------------------------------------------------------------
//
// Hermes is the bounded execution layer; every LLM-proposed action passes
// its lease + 8-gate LOOM chain. Before any action whose risk_level >= high
// is submitted, Hermes is expected to call this endpoint with the proposed
// envelope. The gate normalizes risk via verb heuristics (a benign-looking
// `production_deploy` is still critical), invokes the second-opinion model,
// and collapses the model's verdict into a single decision Hermes can act
// on: refuse|confirm.
//
// Doctrine choices (Mom's Law):
//   - `approve` and `approve_with_conditions` BOTH map to `confirm` so
//     Hermes only has to branch on two states. The conditions are still
//     returned in the body and Hermes MUST surface them to the operator
//     before proceeding — but the boolean wire shape is clean.
//   - `refuse` and `block` BOTH map to `refuse`. We do not soften block to
//     confirm-with-conditions on the wire; block is hard stop.
//   - Verb-level risk floor (VERB_RISK_FLOOR) only PROMOTES risk. It never
//     downgrades. If the caller said critical, we honor critical.
//   - On upstream miss at promoted-high/critical we fail closed to refuse,
//     matching the second-opinion gate's contract. No fake confirms.

export function inferRiskFromVerb(verb, hintLevel) {
  const hint = typeof hintLevel === "string" ? hintLevel.toLowerCase() : "";
  const baseline = VALID_RISK.includes(hint) ? hint : "medium";
  const floor =
    typeof verb === "string" && Object.prototype.hasOwnProperty.call(VERB_RISK_FLOOR, verb)
      ? VERB_RISK_FLOOR[verb]
      : null;
  if (!floor) return { risk_level: baseline, risk_promoted: false };
  const order = { low: 0, medium: 1, high: 2, critical: 3 };
  if (order[floor] > order[baseline]) {
    return { risk_level: floor, risk_promoted: true };
  }
  return { risk_level: baseline, risk_promoted: false };
}

function verdictToDecision(verdict) {
  if (verdict === "refuse" || verdict === "block") return "refuse";
  return "confirm";
}

export async function handlePreflight(rawBody, cfg) {
  const src =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : null;
  if (!src) {
    return {
      status: 400,
      body: {
        error: {
          message: "request body must be a JSON object",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  const action_verb = typeof src.action_verb === "string" ? src.action_verb.trim() : "";
  const action = typeof src.action === "string" ? src.action.trim() : "";
  const actor = typeof src.actor === "string" ? src.actor : null;
  const lease_id = typeof src.lease_id === "string" ? src.lease_id : null;
  const report = typeof src.report === "string" ? src.report : null;
  const receipt_path = typeof src.receipt_path === "string" ? src.receipt_path : null;
  const userContext = typeof src.context === "string" ? src.context : null;
  const correlation_id =
    typeof src.correlation_id === "string" && src.correlation_id.length > 0
      ? src.correlation_id
      : null;
  const risk_hint = typeof src.risk_level === "string" ? src.risk_level.toLowerCase() : null;

  if (!action_verb) {
    return {
      status: 400,
      body: {
        error: {
          message: "field 'action_verb' is required and must be a non-empty string",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }
  if (!action) {
    return {
      status: 400,
      body: {
        error: {
          message: "field 'action' is required and must be a non-empty string",
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }
  if (action.length > 8_000) {
    return {
      status: 422,
      body: {
        error: {
          message: "field 'action' exceeds 8000 chars",
          type: "invalid_request_error",
          code: 422,
        },
      },
    };
  }
  if (risk_hint && !VALID_RISK.includes(risk_hint)) {
    return {
      status: 400,
      body: {
        error: {
          message: `field 'risk_level' (if present) must be one of: ${VALID_RISK.join(", ")}`,
          type: "invalid_request_error",
          code: 400,
        },
      },
    };
  }

  const { risk_level, risk_promoted } = inferRiskFromVerb(action_verb, risk_hint);

  // Compose a fuller context string for the model so it can see the verb,
  // the lease anchor, and any pre-action report the actor sent. We do not
  // forward the receipt_path itself (it's an internal write target), only
  // its presence — a flag the model can use to detect "no receipt planned"
  // as a fake-green indicator.
  const contextParts = [];
  if (userContext) contextParts.push(`context: ${userContext}`);
  contextParts.push(`hermes_verb: ${action_verb}`);
  if (lease_id) contextParts.push(`lease_id: ${lease_id}`);
  if (risk_promoted) {
    contextParts.push(
      `risk_promoted_from: ${risk_hint || "(none)"} -> ${risk_level} (verb floor)`,
    );
  }
  contextParts.push(`receipt_planned: ${receipt_path ? "yes" : "no"}`);
  if (report) contextParts.push(`pre_action_report: ${report}`);

  // Delegate to the same second-opinion machinery so preflight and the raw
  // gate use one upstream call shape and one verdict shaper. Drift-resistant.
  const inner = await handleSecondOpinion(
    {
      action,
      risk_level,
      context: contextParts.join("\n"),
      actor,
      correlation_id,
    },
    cfg,
  );

  // Surface the same status the inner call used (400/422/503/200) but
  // reshape the 200 body so callers see a clean refuse|confirm decision.
  if (inner.status !== 200) {
    return inner;
  }

  const v = inner.body;
  const decision = verdictToDecision(v.verdict);
  const out = {
    decision,
    verdict: v.verdict,
    reason: v.reason,
    risk_level,
    risk_promoted,
    fake_green_check: v.fake_green_check,
    model: v.model,
    correlation_id: v.correlation_id || correlation_id,
    generated_at: v.generated_at,
  };
  if (Array.isArray(v.conditions) && v.conditions.length > 0) out.conditions = v.conditions;
  if (v.parse_status) out.parse_status = v.parse_status;
  if (v.degraded) out.degraded = true;
  return { status: 200, body: out };
}

// ---------------------------------------------------------------------------
// Eval report read (most-recent bakeoff)
// ---------------------------------------------------------------------------
//
// The harness in 16-TRAINING/ae-misfit/eval/harness.mjs writes:
//   eval-report.<tag>.json   — per-tag, machine-readable
//   eval-report.<tag>.md     — per-tag, human-readable
//   eval-report.md           — last-run convenience copy
//
// We surface the most recent per-tag JSON file by mtime so a bakeoff
// against both ae-misfit:v0 and qwen2.5:7b (baseline) leaves both reports
// on disk while the GET surface always points at the freshest one. The
// response is sanitized: it strips per-pair `input` / `gold_output` /
// `response` so this read surface cannot become an exfil channel for the
// (operator-owned) training corpus.

export async function findLatestEvalReport(evalDir) {
  let entries;
  try {
    entries = await readdir(evalDir);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  const candidates = entries.filter(
    (n) => n.startsWith("eval-report.") && n.endsWith(".json"),
  );
  if (candidates.length === 0) return null;
  let best = null;
  for (const name of candidates) {
    const full = join(evalDir, name);
    try {
      const s = await stat(full);
      if (!s.isFile()) continue;
      if (!best || s.mtimeMs > best.mtimeMs) {
        best = { path: full, name, mtimeMs: s.mtimeMs, size: s.size };
      }
    } catch {
      // skip unreadable entries
    }
  }
  return best;
}

function sanitizeEvalReport(report, sourcePath) {
  // Defensive: only the fields we expect, plus a small per-pair slice with
  // input/gold/response stripped. Anything else is dropped — this surface
  // is for "is the gate trustworthy right now", not corpus replay.
  const safe = {
    schema: typeof report.schema === "string" ? report.schema : null,
    disclosure_id: typeof report.disclosure_id === "string" ? report.disclosure_id : null,
    model: typeof report.model === "string" ? report.model : null,
    host: typeof report.host === "string" ? report.host : null,
    tag: typeof report.tag === "string" ? report.tag : null,
    seed_path: typeof report.seed_path === "string" ? report.seed_path : null,
    seed_sha256: typeof report.seed_sha256 === "string" ? report.seed_sha256 : null,
    started_at: typeof report.started_at === "string" ? report.started_at : null,
    finished_at: typeof report.finished_at === "string" ? report.finished_at : null,
    ran_in_ollama: typeof report.ran_in_ollama === "boolean" ? report.ran_in_ollama : null,
    summary:
      report.summary && typeof report.summary === "object" && !Array.isArray(report.summary)
        ? report.summary
        : null,
  };
  // Per-pair: keep id, category, score, response_ok, elapsed_ms, error.
  // Drop input, gold_output, response, ollama_meta (size + leakage risk).
  if (Array.isArray(report.records)) {
    safe.records = report.records.map((r) => ({
      id: r && typeof r.id === "string" ? r.id : null,
      category: r && typeof r.category === "string" ? r.category : null,
      response_ok: r && typeof r.response_ok === "boolean" ? r.response_ok : null,
      elapsed_ms: r && Number.isFinite(r.elapsed_ms) ? r.elapsed_ms : null,
      error: r && (typeof r.error === "string" || r.error === null) ? r.error : null,
      score: r && typeof r.score === "object" && !Array.isArray(r.score) ? r.score : null,
    }));
  }
  safe.report_paths = {
    json: sourcePath,
    markdown: sourcePath.replace(/\.json$/i, ".md"),
  };
  return safe;
}

export async function handleEvalGet(cfg) {
  const evalDir = cfg.evalDir || MISFIT_EVAL_DIR;
  let latest;
  try {
    latest = await findLatestEvalReport(evalDir);
  } catch (err) {
    return {
      status: 500,
      body: {
        error: {
          message: `failed to scan eval directory: ${err.message}`,
          type: "misfit_eval_read_error",
          code: 500,
          eval_dir: evalDir,
        },
      },
    };
  }
  if (!latest) {
    return {
      status: 404,
      body: {
        error: {
          message:
            "no AE Misfit eval report on disk yet — bring up qwen2.5:7b + ae-misfit " +
            "adapter and run 16-TRAINING/ae-misfit/eval/harness.mjs. Refusing to " +
            "fabricate a green eval (Mom's Law).",
          type: "misfit_eval_not_found",
          code: 404,
          eval_dir: evalDir,
        },
      },
    };
  }
  let parsed;
  try {
    const buf = await readFile(latest.path, "utf8");
    parsed = JSON.parse(buf);
  } catch (err) {
    return {
      status: 500,
      body: {
        error: {
          message: `eval report at ${latest.path} could not be parsed: ${err.message}`,
          type: "misfit_eval_parse_error",
          code: 500,
        },
      },
    };
  }
  const safe = sanitizeEvalReport(parsed, latest.path);
  return {
    status: 200,
    body: {
      ok: true,
      ...safe,
      loaded_at: nowIso(),
      report_mtime: new Date(latest.mtimeMs).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Public: registerMisfitRoutes(server, opts)
// ---------------------------------------------------------------------------

export function registerMisfitRoutes(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("registerMisfitRoutes: server must be a node:http Server");
  }

  const cfg = {
    upstream: {
      ...MISFIT_UPSTREAM,
      ...(opts.upstream || {}),
    },
    evalDir: typeof opts.evalDir === "string" && opts.evalDir.length > 0
      ? opts.evalDir
      : MISFIT_EVAL_DIR,
    log:
      typeof opts.log === "function"
        ? opts.log
        : (line) => {
            // eslint-disable-next-line no-console
            console.log(line);
          },
  };

  server.prependListener("request", async (req, res) => {
    if (res.writableEnded) return;

    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return;
    }
    const method = (req.method || "GET").toUpperCase();
    const pathName = url.pathname;

    // ----- POST /v1/misfit/second-opinion -----
    if (pathName === MISFIT_PATH) {
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        return errorResponse(
          res,
          `method ${method} not allowed on ${pathName}`,
          405,
          "method_not_allowed",
          { allowed: ["POST"] },
        );
      }
      let raw;
      try {
        raw = await readJsonBody(req);
      } catch (err) {
        return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
      }
      try {
        const { status, body } = await handleSecondOpinion(raw, cfg);
        return jsonResponse(res, body, status);
      } catch (err) {
        cfg.log(`[misfit] handler error: ${err.message}`);
        return errorResponse(
          res,
          err.message || "misfit internal error",
          500,
          "misfit_internal_error",
        );
      }
    }

    // ----- POST /v1/misfit/preflight -----
    if (pathName === MISFIT_PREFLIGHT_PATH) {
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        return errorResponse(
          res,
          `method ${method} not allowed on ${pathName}`,
          405,
          "method_not_allowed",
          { allowed: ["POST"] },
        );
      }
      let raw;
      try {
        raw = await readJsonBody(req);
      } catch (err) {
        return errorResponse(res, err.message || "bad request body", 400, "invalid_request_body");
      }
      try {
        const { status, body } = await handlePreflight(raw, cfg);
        return jsonResponse(res, body, status);
      } catch (err) {
        cfg.log(`[misfit] preflight handler error: ${err.message}`);
        return errorResponse(
          res,
          err.message || "misfit preflight internal error",
          500,
          "misfit_internal_error",
        );
      }
    }

    // ----- GET /v1/misfit/eval -----
    if (pathName === MISFIT_EVAL_PATH) {
      if (method !== "GET") {
        res.setHeader("Allow", "GET");
        return errorResponse(
          res,
          `method ${method} not allowed on ${pathName}`,
          405,
          "method_not_allowed",
          { allowed: ["GET"] },
        );
      }
      try {
        const { status, body } = await handleEvalGet(cfg);
        return jsonResponse(res, body, status);
      } catch (err) {
        cfg.log(`[misfit] eval handler error: ${err.message}`);
        return errorResponse(
          res,
          err.message || "misfit eval internal error",
          500,
          "misfit_internal_error",
        );
      }
    }

    // Not ours.
    return;
  });

  return {
    cfg,
    path: MISFIT_PATH,
    routes: [
      { method: "POST", path: MISFIT_PATH },
      { method: "POST", path: MISFIT_PREFLIGHT_PATH },
      { method: "GET", path: MISFIT_EVAL_PATH },
    ],
  };
}

// Re-export for unit tests + smoke tests.
export const __misfitInternals = {
  shapeVerdict,
  callMisfitModel,
  probeMisfitUpstream,
  inferRiskFromVerb,
  verdictToDecision,
  findLatestEvalReport,
  sanitizeEvalReport,
  SYSTEM_PROMPT,
  VALID_RISK,
  VALID_VERDICT,
  VERB_RISK_FLOOR,
  MISFIT_EVAL_DIR,
};
