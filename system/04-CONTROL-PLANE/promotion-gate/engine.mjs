// Orange5 / 04-CONTROL-PLANE / promotion-gate / engine.mjs
//
// Promotion Gate decision engine.
//
// Decides promote | hold | reject for any candidate change, based on:
//   - receipt_path        (string)   path to a Hermes receipt JSON file on disk
//   - bakeoff             (object)   5-dimension head-to-head eval result
//   - status              (string)   coarse status from upstream lanes
//   - risk_level          (string)   low | medium | high | destructive | production
//   - operator_approved   (boolean)  explicit human sign-off
//   - candidate_text      (string)   optional, scanned for fake-green words
//
// Doctrine (binding):
//   * Auto-REJECT on any fake-green word in candidate_text or status.
//   * Auto-HOLD if receipt_path missing / unreadable, or bakeoff missing.
//   * Require operator_approved === true for risk_level in
//     { high, destructive, production }. Without it -> HOLD.
//   * Bakeoff is 5 dims, each in [0, 1]. Candidate must WIN >= 4 of 5
//     vs baseline. A dim is a "win" iff candidate >= baseline + EPSILON.
//     Tie or loss on >= 2 dims -> REJECT (bakeoff loss is a real signal,
//     not a hold).
//   * status in { failed, error, regressed, broken } -> REJECT.
//   * status in { unknown, pending, partial } -> HOLD.
//   * Only after all gates pass: PROMOTE.
//
// CLR-K5 (Claim-Level Reliability Phase-5):
//   When opts.clr is provided, it must satisfy:
//     - clr.k === 5            (K=5 candidates per turn)
//     - clr.score >= 0.50      (reliability threshold)
//   Otherwise -> REJECT with reason citing CLR-K5.
//   CLR is optional input; absence does not by itself block promotion,
//   but if the caller declares clr at all it must satisfy the contract.
//
// This module is pure Node 20+. No external deps. Synchronous fs read on
// receipt verification is intentional: promotion is a serial gate, not
// a hot path.

import { readFileSync, statSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BAKEOFF_DIMENSIONS = Object.freeze([
  "mission_shape",
  "doctrine_recall",
  "topology_recall",
  "receipt_grounding",
  "refusal_discipline",
]);

export const BAKEOFF_WIN_THRESHOLD = 4; // >= 4 of 5 dims
export const BAKEOFF_EPSILON = 1e-9;    // strict >, with FP slack

export const CLR_K5_K = 5;
export const CLR_K5_THRESHOLD = 0.50;

export const HIGH_RISK_LEVELS = Object.freeze(
  new Set(["high", "destructive", "production"])
);

export const VALID_RISK_LEVELS = Object.freeze(
  new Set(["low", "medium", "high", "destructive", "production"])
);

export const REJECT_STATUSES = Object.freeze(
  new Set(["failed", "error", "regressed", "broken"])
);

export const HOLD_STATUSES = Object.freeze(
  new Set(["unknown", "pending", "partial"])
);

export const PROMOTABLE_STATUSES = Object.freeze(
  new Set(["green", "passed", "ok", "ready"])
);

// Fake-green words: language that claims success without earning it.
// Case-insensitive, word-boundary match.
export const FAKE_GREEN_WORDS = Object.freeze([
  "looks good to me",
  "lgtm",
  "should be fine",
  "should work",
  "probably works",
  "trust me",
  "ship it anyway",
  "good enough",
  "close enough",
  "basically works",
  "i think it works",
  "i think this works",
  "seems to work",
  "appears to work",
  "no tests needed",
  "we'll fix later",
  "tests later",
  "skip tests",
  "skip the tests",
  "yolo",
  "fake green",
  "rubber stamp",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide promotion outcome.
 *
 * @param {object} opts
 * @param {string} [opts.receipt_path]   Path to Hermes receipt JSON.
 * @param {object} [opts.bakeoff]        { candidate: {...dims}, baseline: {...dims} }
 *                                       Each dim a number in [0, 1].
 * @param {string} [opts.status]         Upstream status string.
 * @param {string} [opts.risk_level]     low|medium|high|destructive|production
 * @param {boolean} [opts.operator_approved=false]
 * @param {string} [opts.candidate_text] Optional text scanned for fake-green words.
 * @param {object} [opts.clr]            Optional CLR-K5 result { k, score }.
 * @returns {{ decision: 'promote'|'hold'|'reject', reason: string, details?: object }}
 */
export function decide(opts = {}) {
  if (opts === null || typeof opts !== "object") {
    return reject("opts must be an object");
  }

  const {
    receipt_path,
    bakeoff,
    status,
    risk_level,
    operator_approved = false,
    candidate_text = "",
    clr,
  } = opts;

  // 1. Hard reject: fake-green words anywhere we can see them.
  const fakeGreenHit = findFakeGreen(
    [candidate_text, typeof status === "string" ? status : ""].join("\n")
  );
  if (fakeGreenHit) {
    return reject(`fake-green word detected: "${fakeGreenHit}"`);
  }

  // 2. Hard reject: explicit failure status.
  if (typeof status === "string" && REJECT_STATUSES.has(status.toLowerCase())) {
    return reject(`status=${status} (reject-status)`);
  }

  // 3. Hold: status missing or ambiguous.
  if (typeof status !== "string" || status.trim() === "") {
    return hold("status missing");
  }
  if (HOLD_STATUSES.has(status.toLowerCase())) {
    return hold(`status=${status} (hold-status)`);
  }

  // 4. Hold: receipt missing or unreadable.
  const receiptCheck = verifyReceipt(receipt_path);
  if (!receiptCheck.ok) {
    return hold(`receipt unavailable: ${receiptCheck.reason}`);
  }

  // 5. Bakeoff present?
  if (!bakeoff || typeof bakeoff !== "object") {
    return hold("bakeoff missing");
  }
  const bakeoffResult = evaluateBakeoff(bakeoff);
  if (bakeoffResult.error) {
    return hold(`bakeoff invalid: ${bakeoffResult.error}`);
  }
  if (bakeoffResult.wins < BAKEOFF_WIN_THRESHOLD) {
    return reject(
      `bakeoff: candidate won ${bakeoffResult.wins}/${BAKEOFF_DIMENSIONS.length} ` +
        `(need ${BAKEOFF_WIN_THRESHOLD}); losses=${bakeoffResult.losses.join(",") || "none"}`,
      { bakeoff: bakeoffResult }
    );
  }

  // 6. Risk-level gate.
  if (typeof risk_level !== "string" || !VALID_RISK_LEVELS.has(risk_level.toLowerCase())) {
    return hold(`risk_level missing or invalid (got ${JSON.stringify(risk_level)})`);
  }
  const rl = risk_level.toLowerCase();
  if (HIGH_RISK_LEVELS.has(rl) && operator_approved !== true) {
    return hold(`risk_level=${rl} requires operator_approved=true`);
  }

  // 7. CLR-K5 contract (only if caller declared clr).
  if (clr !== undefined && clr !== null) {
    const clrCheck = verifyCLRK5(clr);
    if (!clrCheck.ok) {
      return reject(`CLR-K5 contract violated: ${clrCheck.reason}`, { clr });
    }
  }

  // 8. Status must be explicitly promotable.
  if (!PROMOTABLE_STATUSES.has(status.toLowerCase())) {
    return hold(`status=${status} not in promotable set`);
  }

  // All gates passed.
  return promote(
    `bakeoff ${bakeoffResult.wins}/${BAKEOFF_DIMENSIONS.length}; ` +
      `status=${status}; risk=${rl}` +
      (HIGH_RISK_LEVELS.has(rl) ? "; operator_approved" : ""),
    { bakeoff: bakeoffResult }
  );
}

// ---------------------------------------------------------------------------
// Sub-checks (exported for unit testing)
// ---------------------------------------------------------------------------

export function findFakeGreen(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const lower = text.toLowerCase();
  for (const phrase of FAKE_GREEN_WORDS) {
    // Word-ish boundary: require non-letter before/after for short tokens
    // like "yolo" / "lgtm"; substring match is fine for multi-word phrases.
    if (phrase.includes(" ")) {
      if (lower.includes(phrase)) return phrase;
    } else {
      const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(phrase)}(?:[^a-z0-9]|$)`, "i");
      if (re.test(lower)) return phrase;
    }
  }
  return null;
}

export function verifyReceipt(receipt_path) {
  if (typeof receipt_path !== "string" || receipt_path.trim() === "") {
    return { ok: false, reason: "receipt_path missing" };
  }
  try {
    const st = statSync(receipt_path);
    if (!st.isFile()) {
      return { ok: false, reason: "receipt_path not a file" };
    }
    if (st.size === 0) {
      return { ok: false, reason: "receipt empty" };
    }
  } catch (err) {
    return { ok: false, reason: `stat failed (${err.code || err.message})` };
  }
  let raw;
  try {
    raw = readFileSync(receipt_path, "utf8");
  } catch (err) {
    return { ok: false, reason: `read failed (${err.code || err.message})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON (${err.message})` };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: "receipt not a JSON object" };
  }
  return { ok: true, receipt: parsed };
}

export function evaluateBakeoff(bakeoff) {
  if (!bakeoff || typeof bakeoff !== "object") {
    return { error: "bakeoff not an object" };
  }
  const { candidate, baseline } = bakeoff;
  if (!candidate || typeof candidate !== "object") {
    return { error: "candidate scores missing" };
  }
  if (!baseline || typeof baseline !== "object") {
    return { error: "baseline scores missing" };
  }
  let wins = 0;
  const losses = [];
  const perDim = {};
  for (const dim of BAKEOFF_DIMENSIONS) {
    const c = candidate[dim];
    const b = baseline[dim];
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
      return { error: `candidate.${dim} not a number in [0,1]` };
    }
    if (typeof b !== "number" || !Number.isFinite(b) || b < 0 || b > 1) {
      return { error: `baseline.${dim} not a number in [0,1]` };
    }
    const won = c >= b + BAKEOFF_EPSILON;
    perDim[dim] = { candidate: c, baseline: b, won };
    if (won) wins += 1;
    else losses.push(dim);
  }
  return { wins, losses, perDim };
}

export function verifyCLRK5(clr) {
  if (!clr || typeof clr !== "object") {
    return { ok: false, reason: "clr not an object" };
  }
  if (clr.k !== CLR_K5_K) {
    return { ok: false, reason: `clr.k=${clr.k}, need ${CLR_K5_K}` };
  }
  if (
    typeof clr.score !== "number" ||
    !Number.isFinite(clr.score) ||
    clr.score < 0 ||
    clr.score > 1
  ) {
    return { ok: false, reason: `clr.score=${clr.score} not in [0,1]` };
  }
  if (clr.score < CLR_K5_THRESHOLD) {
    return {
      ok: false,
      reason: `clr.score=${clr.score} below threshold ${CLR_K5_THRESHOLD}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function promote(reason, details) {
  return { decision: "promote", reason, ...(details ? { details } : {}) };
}
function hold(reason, details) {
  return { decision: "hold", reason, ...(details ? { details } : {}) };
}
function reject(reason, details) {
  return { decision: "reject", reason, ...(details ? { details } : {}) };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default decide;
