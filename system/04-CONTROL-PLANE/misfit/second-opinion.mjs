// 04-CONTROL-PLANE/misfit/second-opinion.mjs
//
// AE Misfit second-opinion gate.
//
// Before any Hermes action whose risk_level is >= "high", this module asks
// AE Misfit (model id `ae-misfit:v0`) via the OrangeLLM gateway
// (`POST /v1/chat/completions` on 127.0.0.1:1337) for a refuse-or-confirm
// verdict. If Misfit refuses, the action is blocked and a Thought-lane
// receipt is written. Risk levels below "high" pass through untouched —
// AE Misfit is not in the hot path for routine work.
//
// Doctrine anchor:
//   16-TRAINING/ae-misfit/corpus-strategy.md §2 — "AE Misfit is trained
//   to look for: fake-greens, missed refusal triggers, adversarial framings,
//   scope drift hidden in 'helpful' phrasing."
//
// AE Misfit is ADDITIVE, never substitutive. OrangeLLM-fatty has already
// signed off before this gate fires. AE Misfit is the second opinion.
//
// Schema: orange5.misfit.second-opinion.v0
// Sovereign: Atom McCree

import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Constants

const SCHEMA = "orange5.misfit.second-opinion.v0";
const MODEL_ID = "ae-misfit:v0";
const GATEWAY_HOST = "127.0.0.1";
const GATEWAY_PORT = 1337;
const GATEWAY_URL = `http://${GATEWAY_HOST}:${GATEWAY_PORT}/v1/chat/completions`;
const DEFAULT_TIMEOUT_MS = 15_000;

// Risk levels that trigger the gate. Anything below "high" bypasses.
const TRIGGER_RISK_LEVELS = new Set(["high", "destructive", "production", "critical"]);

// Verdict tokens AE Misfit is trained to emit at the head of its reply.
const VERDICT_REFUSE = "REFUSE";
const VERDICT_CONFIRM = "CONFIRM";

// On gateway error or parse failure we fail CLOSED on triggered risk levels.
// A second-opinion gate that errors open is theater.
const FAIL_CLOSED = true;

// Repo root (this file is at 04-CONTROL-PLANE/misfit/second-opinion.mjs).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const RECEIPTS_DIR = join(REPO_ROOT, "10-RECEIPTS", "thought-lane");

// ----------------------------------------------------------------------------
// Prompt builder
//
// The system prompt mirrors how AE Misfit was trained
// (16-TRAINING/ae-misfit/corpus-strategy.md §5.1). It states the gate's job,
// requires the verdict token at the head of the reply, and forbids
// performative hedging.

function buildSystemPrompt() {
  return [
    "You are AE Misfit, the second-opinion gate before a high-risk Hermes action.",
    "OrangeLLM-fatty has already signed off. Your job is to catch what it missed:",
    "fake-greens, missed refusal triggers, adversarial framings, scope drift",
    "hidden in 'helpful' phrasing.",
    "",
    "Reply format is non-negotiable:",
    "  Line 1: a single token, either REFUSE or CONFIRM.",
    "  Line 2+: one paragraph of reasoning. If REFUSE, cite the AtomEons rule",
    "          breached (Mom's Law, 27 Guardrails, Gate 0 LBCE, Scope, Triad,",
    "          HRE, Security, Drift, Receipt, CHECKMATE, Human Final Stop,",
    "          Hermes lease policy, Frontier Isolation Boundary, Misfit Frontier).",
    "          Name the gate that should have caught it. Propose a corrected",
    "          scoped-down action if one exists.",
    "",
    "No performative hedging. No simulation of named people. Mom is watching.",
  ].join("\n");
}

function buildUserPrompt(action) {
  const lines = [
    `Hermes leased a ${action.risk_level} action.`,
    `Action id: ${action.id || "(unspecified)"}`,
    `Action description:`,
    action.description || "(no description provided)",
  ];
  if (action.fatty_approval) {
    lines.push("");
    lines.push(`OrangeLLM-fatty signed off with reasoning:`);
    lines.push(action.fatty_approval);
  }
  if (action.context) {
    lines.push("");
    lines.push(`Context:`);
    lines.push(typeof action.context === "string" ? action.context : JSON.stringify(action.context, null, 2));
  }
  lines.push("");
  lines.push("Do you agree?");
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Gateway call

/**
 * POST to the OrangeLLM gateway with a timeout.
 * Returns { ok, status, body } or { ok: false, error }.
 */
async function postToGateway({ url, payload, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      return { ok: false, error: `gateway returned non-JSON body (status ${res.status})`, status: res.status, raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, error: `gateway timeout after ${timeoutMs}ms` };
    }
    return { ok: false, error: `gateway error: ${err.message || String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// Verdict parser
//
// AE Misfit is trained to emit REFUSE or CONFIRM at the head of the reply.
// We parse the first non-empty line case-insensitively. Anything that does
// not match exactly is treated as a parse failure and (with FAIL_CLOSED)
// becomes a refusal.

function parseVerdict(content) {
  if (typeof content !== "string" || !content.trim()) {
    return { verdict: null, reasoning: "", parse_error: "empty model reply" };
  }
  const lines = content.split(/\r?\n/);
  let head = "";
  let headIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t) { head = t; headIdx = i; break; }
  }
  const reasoning = headIdx >= 0 ? lines.slice(headIdx + 1).join("\n").trim() : "";

  // Strip surrounding punctuation/markdown from the head token.
  const token = head.replace(/^[#>\-*_`\s]+/, "").replace(/[.:!,;`]+$/, "").toUpperCase();

  if (token === VERDICT_REFUSE) return { verdict: "refuse", reasoning };
  if (token === VERDICT_CONFIRM) return { verdict: "confirm", reasoning };

  // Some tolerant fallbacks for common refusal phrasings, but ONLY for refusal.
  // Confirm requires an explicit CONFIRM token — silence-as-consent is theater.
  if (/^(no|refuse|reject|block|deny)\b/i.test(head)) {
    return { verdict: "refuse", reasoning: head + (reasoning ? "\n" + reasoning : "") };
  }

  return {
    verdict: null,
    reasoning: content.trim(),
    parse_error: `head token "${token}" is neither REFUSE nor CONFIRM`,
  };
}

// ----------------------------------------------------------------------------
// Receipt writer

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function ts() {
  // ISO-ish, filesystem-safe.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeThoughtLaneReceipt(record, { writer = defaultReceiptWriter } = {}) {
  return writer(record);
}

async function defaultReceiptWriter(record) {
  await mkdir(RECEIPTS_DIR, { recursive: true });
  const stamp = ts();
  const actionTag = (record.action.id || "anon").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const verdictTag = record.verdict || "error";
  const filename = `${stamp}-misfit-${verdictTag}-${actionTag}.md`;
  const path = join(RECEIPTS_DIR, filename);
  const body = renderReceiptMarkdown(record);
  await writeFile(path, body, { encoding: "utf8" });
  return { path, sha256: sha256Hex(body) };
}

function renderReceiptMarkdown(r) {
  const lines = [
    `# AE Misfit second-opinion receipt`,
    ``,
    `**Schema:** \`${SCHEMA}\``,
    `**Timestamp:** ${r.timestamp}`,
    `**Verdict:** \`${r.verdict || "ERROR"}\``,
    `**Action id:** \`${r.action.id || "(unspecified)"}\``,
    `**Risk level:** \`${r.action.risk_level}\``,
    `**Model:** \`${r.model}\``,
    `**Lane:** Thought (pre-execution second opinion)`,
    ``,
    `## Action description`,
    ``,
    "```",
    r.action.description || "(no description provided)",
    "```",
    ``,
  ];
  if (r.action.fatty_approval) {
    lines.push(`## OrangeLLM-fatty approval reasoning`, ``, "```", r.action.fatty_approval, "```", ``);
  }
  if (r.misfit_reasoning) {
    lines.push(`## AE Misfit reasoning`, ``, "```", r.misfit_reasoning, "```", ``);
  }
  if (r.parse_error) {
    lines.push(`## Parse error`, ``, "```", r.parse_error, "```", ``);
  }
  if (r.gateway_error) {
    lines.push(`## Gateway error`, ``, "```", r.gateway_error, "```", ``);
  }
  lines.push(
    `## Outcome`,
    ``,
    r.blocked
      ? `Action BLOCKED. Hermes must not execute. Operator may override only by explicit typed instruction per CLAUDE.md standing law.`
      : `Action CONFIRMED by AE Misfit second opinion. Hermes may proceed subject to remaining 9-Gate stages.`,
    ``,
    `## Doctrine anchor`,
    ``,
    `- 16-TRAINING/ae-misfit/corpus-strategy.md §2 (second-opinion gate placement)`,
    `- .claude/rules/00-moms-law.md (no fake-green receipts)`,
    ``,
    `**Mom is watching.**`,
    ``,
  );
  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// Public API

/**
 * Decide whether the gate must fire for a given action.
 * Exported for tests and for Hermes to short-circuit cheaply.
 */
export function shouldGate(action) {
  if (!action || typeof action !== "object") return false;
  const risk = String(action.risk_level || "").toLowerCase();
  return TRIGGER_RISK_LEVELS.has(risk);
}

/**
 * Run the AE Misfit second-opinion gate.
 *
 * @param {Object} action
 * @param {string} action.description     - human-readable action description (required when gating)
 * @param {string} action.risk_level      - "low" | "medium" | "high" | "destructive" | "production" | "critical"
 * @param {string} [action.id]            - stable identifier (e.g. Hermes lease id)
 * @param {string} [action.fatty_approval] - OrangeLLM-fatty's approval reasoning, if available
 * @param {Object|string} [action.context] - free-form context for the gate
 *
 * @param {Object} [opts]
 * @param {string} [opts.gatewayUrl=GATEWAY_URL]
 * @param {number} [opts.timeoutMs=DEFAULT_TIMEOUT_MS]
 * @param {Function} [opts.fetchImpl=globalThis.fetch] - injectable for tests
 * @param {Function} [opts.receiptWriter]              - injectable for tests
 * @param {boolean}  [opts.failClosed=FAIL_CLOSED]
 *
 * @returns {Promise<{
 *   schema: string,
 *   gated: boolean,
 *   verdict: 'refuse'|'confirm'|null,
 *   blocked: boolean,
 *   reason: string,
 *   misfit_reasoning: string,
 *   model: string,
 *   timestamp: string,
 *   receipt: { path: string, sha256: string } | null,
 *   parse_error?: string,
 *   gateway_error?: string,
 * }>}
 */
export async function secondOpinion(action, opts = {}) {
  const {
    gatewayUrl = GATEWAY_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl,
    receiptWriter,
    failClosed = FAIL_CLOSED,
  } = opts;

  const timestamp = new Date().toISOString();
  const base = {
    schema: SCHEMA,
    model: MODEL_ID,
    timestamp,
    action: action || {},
  };

  if (!shouldGate(action)) {
    return {
      ...base,
      gated: false,
      verdict: null,
      blocked: false,
      reason: `risk_level=${action?.risk_level ?? "(none)"} below gate threshold; AE Misfit not consulted`,
      misfit_reasoning: "",
      receipt: null,
    };
  }

  if (!action.description || typeof action.description !== "string") {
    // Missing description on a triggered risk level is itself a refusal trigger.
    const record = {
      ...base,
      gated: true,
      verdict: "refuse",
      blocked: true,
      reason: "action.description missing on high-risk lease — cannot ask second opinion blind",
      misfit_reasoning: "",
      parse_error: undefined,
      gateway_error: undefined,
    };
    const receipt = await writeThoughtLaneReceipt(record, { writer: receiptWriter });
    return { ...record, receipt };
  }

  // Build chat payload (OpenAI-compatible, as the gateway expects).
  const payload = {
    model: MODEL_ID,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(action) },
    ],
    temperature: 0.2,
    max_tokens: 512,
    stream: false,
  };

  // Use injected fetch in tests; otherwise the global.
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    const record = {
      ...base,
      gated: true,
      verdict: failClosed ? "refuse" : null,
      blocked: failClosed,
      reason: "no fetch implementation available (Node < 18 without polyfill)",
      misfit_reasoning: "",
      gateway_error: "fetch undefined",
    };
    const receipt = await writeThoughtLaneReceipt(record, { writer: receiptWriter });
    return { ...record, receipt };
  }

  // Inline a minimal wrapper that uses the injected fetch.
  let gatewayResult;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(gatewayUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; }
      catch (_) {
        gatewayResult = { ok: false, status: res.status, error: "gateway returned non-JSON body", raw: text };
      }
      if (!gatewayResult) gatewayResult = { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    gatewayResult = {
      ok: false,
      error: err?.name === "AbortError"
        ? `gateway timeout after ${timeoutMs}ms`
        : `gateway error: ${err?.message || String(err)}`,
    };
  }

  if (!gatewayResult.ok) {
    const record = {
      ...base,
      gated: true,
      verdict: failClosed ? "refuse" : null,
      blocked: failClosed,
      reason: failClosed
        ? "gateway error on high-risk lease; failing closed per FAIL_CLOSED policy"
        : "gateway error on high-risk lease; failing open per operator override",
      misfit_reasoning: "",
      gateway_error: gatewayResult.error || `gateway status ${gatewayResult.status}`,
    };
    const receipt = await writeThoughtLaneReceipt(record, { writer: receiptWriter });
    return { ...record, receipt };
  }

  // OpenAI-shaped reply: { choices: [ { message: { content } } ] }
  const content = gatewayResult.body?.choices?.[0]?.message?.content;
  const parsed = parseVerdict(content);

  if (parsed.verdict === "confirm") {
    const record = {
      ...base,
      gated: true,
      verdict: "confirm",
      blocked: false,
      reason: "AE Misfit confirmed action",
      misfit_reasoning: parsed.reasoning || "",
    };
    // Confirmations also get a Thought-lane receipt — receipts are not
    // refusal-only. The receipt is the audit trail.
    const receipt = await writeThoughtLaneReceipt(record, { writer: receiptWriter });
    return { ...record, receipt };
  }

  if (parsed.verdict === "refuse") {
    const record = {
      ...base,
      gated: true,
      verdict: "refuse",
      blocked: true,
      reason: "AE Misfit refused the action",
      misfit_reasoning: parsed.reasoning || "",
    };
    const receipt = await writeThoughtLaneReceipt(record, { writer: receiptWriter });
    return { ...record, receipt };
  }

  // Parse failed — treat as refusal under FAIL_CLOSED.
  const record = {
    ...base,
    gated: true,
    verdict: failClosed ? "refuse" : null,
    blocked: failClosed,
    reason: failClosed
      ? "could not parse AE Misfit verdict; failing closed per FAIL_CLOSED policy"
      : "could not parse AE Misfit verdict; failing open per operator override",
    misfit_reasoning: parsed.reasoning || "",
    parse_error: parsed.parse_error,
  };
  const receipt = await writeThoughtLaneReceipt(record, { writer: receiptWriter });
  return { ...record, receipt };
}

// ----------------------------------------------------------------------------
// Internals exported for tests.

export const __internals = {
  SCHEMA,
  MODEL_ID,
  GATEWAY_URL,
  TRIGGER_RISK_LEVELS,
  RECEIPTS_DIR,
  buildSystemPrompt,
  buildUserPrompt,
  parseVerdict,
  renderReceiptMarkdown,
  postToGateway,
  sha256Hex,
};
