#!/usr/bin/env node
// Orange5 Promotion Gate CLI
// Location: 04-CONTROL-PLANE/promotion-gate/promote.mjs
//
// Decides promote / hold / reject for a candidate change.
//
// Usage:
//   node promote.mjs --receipt <path> --bakeoff <path> --status <s> --risk <r> [--operator-approved]
//   node promote.mjs --help
//   node promote.mjs --version
//
// Doctrine (wave2-08):
//   - Auto-rejects on fake-green words in --status.
//   - Auto-holds on missing/unreadable receipt or bakeoff.
//   - Auto-rejects when bakeoff result is "fail" OR when candidate wins < 4 of 5 bakeoff dimensions.
//   - Requires --operator-approved for risk in [high, destructive, production].
//
// Exit codes:
//   0 = promote
//   1 = hold
//   2 = reject
//   3 = usage / IO error
//
// Node 20+ only. No deps. Reads files via node:fs. JSON output via --json.

import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { argv, exit, stdout, stderr } from "node:process";

export const FORBIDDEN_STATUS_WORDS = [
  "green_assumed",
  "should_work",
  "looks_ok",
  "probably",
  "fake_green",
];

export const HIGH_RISK_LEVELS = ["high", "destructive", "production"];

export const BAKEOFF_DIMENSIONS = [
  "mission_shape",
  "doctrine_recall",
  "topology_recall",
  "receipt_grounding",
  "refusal_discipline",
];

export const BAKEOFF_WIN_THRESHOLD = 4; // candidate must win >= 4 of 5

const EXIT = { PROMOTE: 0, HOLD: 1, REJECT: 2, USAGE: 3 };

const HELP = `promote.mjs — Orange5 Promotion Gate CLI

Usage:
  node promote.mjs --receipt <path> --bakeoff <path> --status <s> --risk <r> [--operator-approved] [--json]
  node promote.mjs --help
  node promote.mjs --version

Required:
  --receipt <path>       Path to candidate receipt file (must exist + be non-empty).
  --bakeoff <path>       Path to bakeoff result JSON (see schema below).
  --status <s>           Candidate status string (checked for fake-green words).
  --risk <r>             Risk level: low | medium | high | destructive | production.

Optional:
  --operator-approved    Operator approval flag (required for high/destructive/production).
  --json                 Emit machine-readable JSON verdict on stdout.
  --help                 Print this help.
  --version              Print version.

Bakeoff JSON schema (one of):
  { "result": "win" | "fail",
    "dimensions": {
      "mission_shape":     { "candidate": 0.83, "baseline": 0.71 },
      "doctrine_recall":   { "candidate": 0.90, "baseline": 0.82 },
      "topology_recall":   { "candidate": 0.66, "baseline": 0.74 },
      "receipt_grounding": { "candidate": 0.88, "baseline": 0.70 },
      "refusal_discipline":{ "candidate": 0.91, "baseline": 0.65 }
    }
  }
  -- or the legacy flat form: { "result": "win" | "fail" }

Exit codes:
  0 promote   1 hold   2 reject   3 usage/IO error
`;

const VERSION = "1.0.0";

// ---------- arg parsing ----------

export function parseArgs(args) {
  const out = {
    receipt: null,
    bakeoff: null,
    status: null,
    risk: null,
    operatorApproved: false,
    json: false,
    help: false,
    version: false,
    unknown: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--receipt":
        out.receipt = args[++i] ?? null;
        break;
      case "--bakeoff":
        out.bakeoff = args[++i] ?? null;
        break;
      case "--status":
        out.status = args[++i] ?? null;
        break;
      case "--risk":
      case "--risk-level":
        out.risk = args[++i] ?? null;
        break;
      case "--operator-approved":
      case "--approved":
        out.operatorApproved = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-v":
      case "--version":
        out.version = true;
        break;
      default:
        out.unknown.push(a);
    }
  }
  return out;
}

// ---------- IO helpers ----------

export function readReceipt(path) {
  const abs = resolvePath(path);
  const st = statSync(abs); // throws if missing
  if (!st.isFile()) throw new Error(`receipt is not a regular file: ${abs}`);
  if (st.size === 0) throw new Error(`receipt is empty: ${abs}`);
  return { path: abs, size: st.size };
}

export function readBakeoff(path) {
  const abs = resolvePath(path);
  const raw = readFileSync(abs, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`bakeoff file is not valid JSON: ${abs} (${e.message})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`bakeoff file must be a JSON object: ${abs}`);
  }
  return { path: abs, data: parsed };
}

// ---------- decision logic ----------

/**
 * Score the bakeoff against the 4-of-5 doctrine.
 * Accepts either an explicit { result: "win"|"fail" } OR a { dimensions: {...} } object.
 * If both are present, dimension scoring is authoritative.
 * @returns {{ wins: number, total: number, winners: string[], explicitResult: string|null, missingDims: string[] }}
 */
export function scoreBakeoff(bakeoff) {
  const dims = bakeoff && bakeoff.dimensions;
  const explicitResult =
    typeof bakeoff?.result === "string" ? bakeoff.result.toLowerCase() : null;

  if (!dims || typeof dims !== "object") {
    return {
      wins: 0,
      total: 0,
      winners: [],
      explicitResult,
      missingDims: BAKEOFF_DIMENSIONS.slice(),
    };
  }

  const winners = [];
  const missingDims = [];
  for (const d of BAKEOFF_DIMENSIONS) {
    const v = dims[d];
    if (
      !v ||
      typeof v.candidate !== "number" ||
      typeof v.baseline !== "number"
    ) {
      missingDims.push(d);
      continue;
    }
    if (v.candidate > v.baseline) winners.push(d);
  }
  return {
    wins: winners.length,
    total: BAKEOFF_DIMENSIONS.length,
    winners,
    explicitResult,
    missingDims,
  };
}

/**
 * Pure decision function. Inputs already loaded/validated.
 * @returns {{verdict:'promote'|'hold'|'reject', reasons:string[], bakeoffScore:object}}
 */
export function decide({
  receiptOk,
  bakeoffOk,
  bakeoff,
  status,
  risk,
  operatorApproved,
}) {
  const reasons = [];
  let hardReject = false;

  // 1. fake-green guard on status — hard reject if matched
  const lowerStatus = String(status ?? "").toLowerCase();
  for (const w of FORBIDDEN_STATUS_WORDS) {
    if (lowerStatus.includes(w)) {
      reasons.push(`status contains forbidden word "${w}" (fake-green guard)`);
      hardReject = true;
    }
  }

  // 2. receipt / bakeoff presence -> hold (per doctrine)
  if (!receiptOk) reasons.push("missing or unreadable receipt");
  if (!bakeoffOk) reasons.push("missing or unreadable bakeoff");

  // 3. bakeoff scoring (only meaningful if bakeoff loaded)
  let bakeoffScore = null;
  if (bakeoffOk) {
    bakeoffScore = scoreBakeoff(bakeoff);
    if (bakeoffScore.explicitResult === "fail") {
      reasons.push('bakeoff explicit result = "fail"');
      hardReject = true;
    }
    if (bakeoffScore.missingDims.length === 0) {
      if (bakeoffScore.wins < BAKEOFF_WIN_THRESHOLD) {
        reasons.push(
          `bakeoff candidate won ${bakeoffScore.wins}/${bakeoffScore.total} dims (need >= ${BAKEOFF_WIN_THRESHOLD})`,
        );
        hardReject = true;
      }
    } else {
      // Per-dim scoring is doctrine. Without it we cannot confirm the 4-of-5
      // win condition. A flat {"result":"win"} is not authoritative on its own.
      reasons.push(
        `bakeoff lacks per-dim scores for [${bakeoffScore.missingDims.join(", ")}] (cannot confirm ${BAKEOFF_WIN_THRESHOLD}-of-${BAKEOFF_DIMENSIONS.length})`,
      );
    }
  }

  // 4. risk gate
  const r = String(risk ?? "").toLowerCase();
  if (!r) {
    reasons.push("missing --risk");
  } else if (HIGH_RISK_LEVELS.includes(r) && !operatorApproved) {
    reasons.push(
      `risk_level="${r}" requires --operator-approved`,
    );
  }

  if (reasons.length === 0) {
    return { verdict: "promote", reasons: [], bakeoffScore };
  }
  if (hardReject) return { verdict: "reject", reasons, bakeoffScore };
  return { verdict: "hold", reasons, bakeoffScore };
}

// ---------- CLI entry ----------

export function runCli(rawArgs, { write = (s) => stdout.write(s), errWrite = (s) => stderr.write(s) } = {}) {
  const args = parseArgs(rawArgs);

  if (args.help) {
    write(HELP);
    return EXIT.PROMOTE; // help is not a verdict; map to 0 by convention only when --help
  }
  if (args.version) {
    write(`promote.mjs ${VERSION}\n`);
    return EXIT.PROMOTE;
  }

  if (args.unknown.length) {
    errWrite(`promote: unknown argument(s): ${args.unknown.join(", ")}\n`);
    errWrite(HELP);
    return EXIT.USAGE;
  }

  const missing = [];
  if (!args.receipt) missing.push("--receipt");
  if (!args.bakeoff) missing.push("--bakeoff");
  if (args.status == null) missing.push("--status");
  if (!args.risk) missing.push("--risk");
  if (missing.length) {
    errWrite(`promote: missing required arg(s): ${missing.join(", ")}\n`);
    errWrite(HELP);
    return EXIT.USAGE;
  }

  // Load receipt
  let receiptOk = false;
  let receiptInfo = null;
  let receiptErr = null;
  try {
    receiptInfo = readReceipt(args.receipt);
    receiptOk = true;
  } catch (e) {
    receiptErr = e.message;
  }

  // Load bakeoff
  let bakeoffOk = false;
  let bakeoffData = null;
  let bakeoffErr = null;
  try {
    const b = readBakeoff(args.bakeoff);
    bakeoffData = b.data;
    bakeoffOk = true;
  } catch (e) {
    bakeoffErr = e.message;
  }

  const decision = decide({
    receiptOk,
    bakeoffOk,
    bakeoff: bakeoffData,
    status: args.status,
    risk: args.risk,
    operatorApproved: args.operatorApproved,
  });

  const payload = {
    verdict: decision.verdict,
    reasons: decision.reasons,
    inputs: {
      receipt: args.receipt,
      bakeoff: args.bakeoff,
      status: args.status,
      risk: args.risk,
      operator_approved: args.operatorApproved,
    },
    receipt_ok: receiptOk,
    receipt_error: receiptErr,
    bakeoff_ok: bakeoffOk,
    bakeoff_error: bakeoffErr,
    bakeoff_score: decision.bakeoffScore,
    version: VERSION,
  };

  if (args.json) {
    write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    const banner = {
      promote: "PROMOTE",
      hold: "HOLD",
      reject: "REJECT",
    }[decision.verdict];
    write(`[promotion-gate] verdict: ${banner}\n`);
    if (decision.reasons.length) {
      write("reasons:\n");
      for (const r of decision.reasons) write(`  - ${r}\n`);
    }
    if (decision.bakeoffScore && decision.bakeoffScore.total > 0) {
      write(
        `bakeoff: ${decision.bakeoffScore.wins}/${decision.bakeoffScore.total} dims won` +
          (decision.bakeoffScore.winners.length
            ? ` [${decision.bakeoffScore.winners.join(", ")}]`
            : "") +
          "\n",
      );
    }
    if (receiptErr) write(`receipt error: ${receiptErr}\n`);
    if (bakeoffErr) write(`bakeoff error: ${bakeoffErr}\n`);
  }

  switch (decision.verdict) {
    case "promote":
      return EXIT.PROMOTE;
    case "hold":
      return EXIT.HOLD;
    case "reject":
      return EXIT.REJECT;
    default:
      return EXIT.USAGE;
  }
}

// Only auto-run when invoked as a script (not when imported by tests).
// Robust cross-platform main-module check (works on Windows file:// URLs).
import { fileURLToPath } from "node:url";
function isMainModule() {
  try {
    const here = fileURLToPath(import.meta.url);
    const entry = argv[1] ? resolvePath(argv[1]) : "";
    return here === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = runCli(argv.slice(2));
  exit(code);
}
