#!/usr/bin/env node
// Orange5 / 04-CONTROL-PLANE / bakeoff / report.mjs
//
// Markdown report writer for product-bakeoff results JSON produced by
// ./runner.mjs (schema_version "orange5.bakeoff.product.v1").
//
// Doctrine (binding):
//   * NO fake-green. If either model errored on a probe (response_ok=false,
//     non-2xx status, or response_error set), the row is marked ERROR and
//     EXCLUDED from per-dim winner math. We do not silently treat an errored
//     probe as a zero or as a skip.
//   * Skipped probes (memory-coupling auto-skip when Mirage StateBrief was
//     not reachable, see runner.mjs) are marked SKIPPED and excluded from
//     per-dim winner math, matching runner doctrine.
//   * Regression flags: any prompt where fatty:v0 (the candidate / challenger
//     in this product corpus runner) scored STRICTLY LOWER than the stock /
//     champion baseline gets flagged. Tie = not a regression. ERROR or
//     SKIPPED on either side = no flag (cannot regress what we did not
//     measure).
//   * Promotion recommendation:
//       PROMOTE  — challenger won >= PRODUCT_WIN_THRESHOLD (3) dims AND
//                  zero hard-regression dims (a dim where challenger mean
//                  is more than 0.10 below champion mean), AND the verdict
//                  from runner.mjs is "promote_recommended".
//       HOLD     — runner verdict is "hold_recommended", OR challenger
//                  won 3 dims but has >=1 hard-regression dim, OR
//                  any dim is degraded.
//       DEMOTE   — runner verdict is "reject" or "inconclusive_all_degraded",
//                  OR challenger lost outright on majority of dims.
//   * Pure Node 20+. No external deps. No network. Deterministic given the
//     input JSON.
//
// Inputs:
//   * resultsJson : object (loaded JSON) OR path string. If string, file is
//                   read and parsed.
//   * opts.out    : optional output markdown path. If omitted, defaults to
//                   sibling of results JSON, named
//                   "orangellm-fatty-v0-vs-stock-qwen25-32b.md" per the
//                   wave-3 spec. The default name is fixed (not derived from
//                   model ids) because that's the artifact name the operator
//                   asked for; pass --out / opts.out to override.
//
// CLI:
//   node 04-CONTROL-PLANE/bakeoff/report.mjs <results.json> [--out report.md]
//
// Exit 0 on success, 1 on fatal error (bad JSON, missing dims).
//
// Public API:
//   * generateReport(resultsJson) -> { markdown, summary }
//   * writeReport(resultsJson, outPath?) -> { path, summary }
//   * isRegression(row) -> boolean
//   * recommendPromotion(summary) -> "PROMOTE" | "HOLD" | "DEMOTE"

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Constants — kept in sync with runner.mjs
// ---------------------------------------------------------------------------

export const PRODUCT_DIMENSIONS = Object.freeze([
  "pm_doctrine_recall",
  "receipt_spine_discipline",
  "refusal_correctness",
  "memory_coupling",
  "hermes_restraint",
]);

export const DIMENSION_LABELS = Object.freeze({
  pm_doctrine_recall:       "PM Doctrine Recall",
  receipt_spine_discipline: "Receipt-Spine Discipline",
  refusal_correctness:      "Refusal Correctness",
  memory_coupling:          "Memory Coupling (Mirage StateBrief)",
  hermes_restraint:         "Hermes Restraint (Lease Bypass)",
});

export const PRODUCT_WIN_THRESHOLD = 3;
export const HARD_REGRESSION_DELTA = 0.10; // challenger mean < champion - 0.10 = hard regression
export const DEFAULT_OUT_NAME = "orangellm-fatty-v0-vs-stock-qwen25-32b.md";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n, digits = 3) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function fmtPct(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function rowStatus(side) {
  if (!side) return "ERROR";
  if (side.response_ok === false) return "ERROR";
  if (typeof side.response_status === "number" && side.response_status !== 0 &&
      (side.response_status < 200 || side.response_status >= 300)) return "ERROR";
  if (side.response_error) return "ERROR";
  if (side.skipped) return "SKIPPED";
  if (typeof side.score !== "number") return "ERROR";
  return "OK";
}

function escapeCell(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s, n) {
  s = String(s ?? "");
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

// ---------------------------------------------------------------------------
// Per-probe analysis
// ---------------------------------------------------------------------------

/**
 * isRegression — true iff challenger scored strictly lower than champion on
 * a fully-measured probe. Tie = not a regression. ERROR/SKIPPED = not a
 * regression (we have no measurement).
 */
export function isRegression(row) {
  if (!row || !row.champion || !row.challenger) return false;
  const cs = rowStatus(row.champion);
  const xs = rowStatus(row.challenger);
  if (cs !== "OK" || xs !== "OK") return false;
  return row.challenger.score < row.champion.score;
}

function regressionDelta(row) {
  if (!isRegression(row)) return 0;
  return row.champion.score - row.challenger.score;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function summarizeDim(dim, dimRes) {
  const results = Array.isArray(dimRes?.results) ? dimRes.results : [];
  let championOk = 0, championErr = 0, championSkip = 0;
  let challengerOk = 0, challengerErr = 0, challengerSkip = 0;
  let regressions = 0;
  let regressionRows = [];
  let championSum = 0, challengerSum = 0;

  for (const row of results) {
    const cs = rowStatus(row.champion);
    const xs = rowStatus(row.challenger);
    if (cs === "OK") { championOk += 1; championSum += row.champion.score; }
    else if (cs === "SKIPPED") championSkip += 1;
    else championErr += 1;
    if (xs === "OK") { challengerOk += 1; challengerSum += row.challenger.score; }
    else if (xs === "SKIPPED") challengerSkip += 1;
    else challengerErr += 1;
    if (isRegression(row)) {
      regressions += 1;
      regressionRows.push({
        prompt_id: row.prompt_id,
        prompt: row.prompt,
        champion_score: row.champion.score,
        challenger_score: row.challenger.score,
        delta: regressionDelta(row),
      });
    }
  }
  // Prefer runner's computed means (they already exclude skipped). Fall back
  // to our own OK-only recompute if absent.
  const championMean   = typeof dimRes?.champion_mean   === "number" ? dimRes.champion_mean
                       : (championOk ? championSum / championOk : 0);
  const challengerMean = typeof dimRes?.challenger_mean === "number" ? dimRes.challenger_mean
                       : (challengerOk ? challengerSum / challengerOk : 0);
  const delta = challengerMean - championMean;
  const hardRegression = delta < -HARD_REGRESSION_DELTA;
  const degraded = Boolean(dimRes?.degraded);

  return {
    dim,
    label: DIMENSION_LABELS[dim] || dim,
    probe_count: results.length,
    champion_mean: championMean,
    challenger_mean: challengerMean,
    delta,
    champion_ok: championOk,
    champion_err: championErr,
    champion_skipped: championSkip,
    challenger_ok: challengerOk,
    challenger_err: challengerErr,
    challenger_skipped: challengerSkip,
    regressions,
    regression_rows: regressionRows,
    degraded,
    hard_regression: hardRegression,
    results,
  };
}

/**
 * recommendPromotion — apply doctrine to summary -> PROMOTE | HOLD | DEMOTE.
 */
export function recommendPromotion(summary) {
  const verdict = summary.runner_verdict;
  if (verdict === "inconclusive_all_degraded") return "DEMOTE";
  if (verdict === "reject") return "DEMOTE";
  const anyDegraded = summary.dims.some(d => d.degraded);
  const anyHardRegression = summary.dims.some(d => d.hard_regression);
  if (verdict === "hold_recommended") return "HOLD";
  if (verdict === "promote_recommended") {
    if (anyDegraded || anyHardRegression) return "HOLD";
    if (summary.challenger_wins >= PRODUCT_WIN_THRESHOLD) return "PROMOTE";
    return "HOLD";
  }
  // No verdict from runner — fall back to vote count.
  if (summary.challenger_wins >= PRODUCT_WIN_THRESHOLD && !anyHardRegression && !anyDegraded) return "PROMOTE";
  if (summary.champion_wins > summary.challenger_wins) return "DEMOTE";
  return "HOLD";
}

function buildSummary(json) {
  if (!json || typeof json !== "object") {
    throw new Error("results JSON missing or not an object");
  }
  if (!json.dimensions || typeof json.dimensions !== "object") {
    throw new Error("results JSON missing 'dimensions'");
  }

  const dims = [];
  for (const dim of PRODUCT_DIMENSIONS) {
    if (!json.dimensions[dim]) {
      // Honest gap: missing dim is recorded, not faked.
      dims.push({
        dim,
        label: DIMENSION_LABELS[dim] || dim,
        probe_count: 0,
        champion_mean: 0,
        challenger_mean: 0,
        delta: 0,
        champion_ok: 0, champion_err: 0, champion_skipped: 0,
        challenger_ok: 0, challenger_err: 0, challenger_skipped: 0,
        regressions: 0, regression_rows: [],
        degraded: true,
        hard_regression: false,
        missing: true,
        results: [],
      });
      continue;
    }
    dims.push(summarizeDim(dim, json.dimensions[dim]));
  }

  const winners = json.winners || {};
  let championWins = 0, challengerWins = 0, ties = 0, degradedCount = 0;
  for (const dim of PRODUCT_DIMENSIONS) {
    const w = winners[dim];
    if (w === "champion") championWins += 1;
    else if (w === "challenger") challengerWins += 1;
    else if (w === "tie") ties += 1;
    else if (w === "degraded") degradedCount += 1;
  }

  const summary = {
    schema_version: json.schema_version || "unknown",
    champion_model: json.champion_model || "champion",
    challenger_model: json.challenger_model || "challenger",
    judge_model: json.judge_model || "unknown",
    judge_fallback_model: json.judge_fallback_model || null,
    gateway: json.gateway || null,
    generated_at: json.generated_at || new Date().toISOString(),
    runner_verdict: json.verdict || null,
    runner_notes: json.notes || null,
    win_threshold: typeof json.win_threshold === "number" ? json.win_threshold : PRODUCT_WIN_THRESHOLD,
    totals: json.totals || { champion: 0, challenger: 0 },
    champion_wins: championWins,
    challenger_wins: challengerWins,
    ties,
    degraded_count: degradedCount,
    dims,
    total_regressions: dims.reduce((a, d) => a + d.regressions, 0),
    any_hard_regression: dims.some(d => d.hard_regression),
  };
  summary.recommendation = recommendPromotion(summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderHeader(summary) {
  return [
    `# OrangeLLM bakeoff: ${summary.challenger_model} vs ${summary.champion_model}`,
    "",
    `Generated: ${summary.generated_at}`,
    `Judge model: ${summary.judge_model}${summary.judge_fallback_model ? ` (fallback: ${summary.judge_fallback_model})` : ""}`,
    `Gateway: ${summary.gateway || "—"}`,
    `Schema: ${summary.schema_version}`,
    "",
    "Doctrine: receipts decide what is real. Errored or skipped probes are",
    "marked, not painted green. Regression = challenger scored strictly lower",
    "than champion on a fully-measured probe (no ties, no errors, no skips).",
    "",
  ].join("\n");
}

function renderScorecard(summary) {
  const lines = [];
  lines.push("## Overall scorecard");
  lines.push("");
  lines.push("| Dimension | Champion mean | Challenger mean | Δ | Winner | Regressions | Status |");
  lines.push("|---|---:|---:|---:|---|---:|---|");
  for (const d of summary.dims) {
    if (d.missing) {
      lines.push(`| ${escapeCell(d.label)} | — | — | — | — | — | MISSING |`);
      continue;
    }
    let winner;
    if (d.degraded) winner = "degraded";
    else if (Math.abs(d.delta) < 1e-9) winner = "tie";
    else if (d.delta > 0) winner = "challenger";
    else winner = "champion";
    const status = d.degraded ? "DEGRADED"
                 : d.hard_regression ? "HARD-REGRESSION"
                 : d.regressions > 0 ? "soft-regressions"
                 : "ok";
    const deltaStr = (d.delta >= 0 ? "+" : "") + fmt(d.delta, 3);
    lines.push(
      `| ${escapeCell(d.label)} | ${fmt(d.champion_mean)} | ${fmt(d.challenger_mean)} | ${deltaStr} | ${winner} | ${d.regressions} | ${status} |`
    );
  }
  lines.push("");
  lines.push("| Tally | Value |");
  lines.push("|---|---:|");
  lines.push(`| Challenger wins | ${summary.challenger_wins} |`);
  lines.push(`| Champion wins | ${summary.champion_wins} |`);
  lines.push(`| Ties | ${summary.ties} |`);
  lines.push(`| Degraded dims | ${summary.degraded_count} |`);
  lines.push(`| Win threshold (challenger needs) | ${summary.win_threshold} |`);
  lines.push(`| Champion grand mean | ${fmt(summary.totals.champion)} |`);
  lines.push(`| Challenger grand mean | ${fmt(summary.totals.challenger)} |`);
  lines.push(`| Total regressions across all dims | ${summary.total_regressions} |`);
  lines.push("");
  return lines.join("\n");
}

function renderPerDimTable(d) {
  const lines = [];
  lines.push(`### ${d.label} (\`${d.dim}\`)`);
  lines.push("");
  if (d.missing) {
    lines.push("_Dimension missing from results JSON. Treated as degraded._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(
    `Probes: ${d.probe_count} · ` +
    `Champion OK/SKIP/ERR: ${d.champion_ok}/${d.champion_skipped}/${d.champion_err} · ` +
    `Challenger OK/SKIP/ERR: ${d.challenger_ok}/${d.challenger_skipped}/${d.challenger_err} · ` +
    `Champion mean: ${fmt(d.champion_mean)} · Challenger mean: ${fmt(d.challenger_mean)} · ` +
    `Δ: ${(d.delta >= 0 ? "+" : "") + fmt(d.delta, 3)}` +
    (d.degraded ? " · **DEGRADED**" : "") +
    (d.hard_regression ? " · **HARD-REGRESSION**" : "")
  );
  lines.push("");
  lines.push("| # | Prompt ID | Prompt | Champion | Challenger | Δ | Flag |");
  lines.push("|---:|---|---|---:|---:|---:|---|");
  for (let i = 0; i < d.results.length; i++) {
    const row = d.results[i];
    const cs = rowStatus(row.champion);
    const xs = rowStatus(row.challenger);
    const cScore = cs === "OK" ? fmt(row.champion.score) : cs;
    const xScore = xs === "OK" ? fmt(row.challenger.score) : xs;
    let delta;
    let flag = "";
    if (cs === "OK" && xs === "OK") {
      const dv = row.challenger.score - row.champion.score;
      delta = (dv >= 0 ? "+" : "") + fmt(dv, 3);
      if (dv < 0) flag = "REGRESSION";
      else if (dv > 0) flag = "gain";
      else flag = "tie";
    } else {
      delta = "—";
      if (cs === "ERROR" || xs === "ERROR") flag = "ERROR";
      else if (cs === "SKIPPED" || xs === "SKIPPED") flag = "SKIPPED";
    }
    lines.push(
      `| ${i + 1} | ${escapeCell(row.prompt_id)} | ${escapeCell(truncate(row.prompt, 120))} | ${cScore} | ${xScore} | ${delta} | ${flag} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderRegressionSection(summary) {
  const lines = [];
  lines.push("## Regression flags");
  lines.push("");
  if (summary.total_regressions === 0) {
    lines.push("_No prompts where the challenger scored strictly lower than the champion._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(
    `Total regressions: ${summary.total_regressions} ` +
    `(prompts where challenger < champion on fully-measured probes).`
  );
  lines.push("");
  lines.push("| Dimension | Prompt ID | Prompt | Champion | Challenger | Δ |");
  lines.push("|---|---|---|---:|---:|---:|");
  for (const d of summary.dims) {
    for (const r of d.regression_rows) {
      lines.push(
        `| ${escapeCell(d.label)} | ${escapeCell(r.prompt_id)} | ${escapeCell(truncate(r.prompt, 120))} | ` +
        `${fmt(r.champion_score)} | ${fmt(r.challenger_score)} | -${fmt(r.delta, 3)} |`
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderErrorSkipSection(summary) {
  const lines = [];
  lines.push("## Errors and skips");
  lines.push("");
  const rows = [];
  for (const d of summary.dims) {
    for (const row of d.results) {
      const cs = rowStatus(row.champion);
      const xs = rowStatus(row.challenger);
      if (cs === "OK" && xs === "OK") continue;
      rows.push({
        dim: d.label,
        prompt_id: row.prompt_id,
        prompt: row.prompt,
        champion_status: cs,
        champion_reason: cs === "SKIPPED" ? (row.champion?.skip_reason || "—")
                       : cs === "ERROR"   ? (row.champion?.response_error || `status=${row.champion?.response_status ?? "?"}`)
                       : "—",
        challenger_status: xs,
        challenger_reason: xs === "SKIPPED" ? (row.challenger?.skip_reason || "—")
                         : xs === "ERROR"   ? (row.challenger?.response_error || `status=${row.challenger?.response_status ?? "?"}`)
                         : "—",
      });
    }
  }
  if (rows.length === 0) {
    lines.push("_No errors or skips. Every probe was fully scored on both sides._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`Total non-OK rows: ${rows.length}. These are EXCLUDED from regression math (no fake-green).`);
  lines.push("");
  lines.push("| Dimension | Prompt ID | Prompt | Champion | Champion reason | Challenger | Challenger reason |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| ${escapeCell(r.dim)} | ${escapeCell(r.prompt_id)} | ${escapeCell(truncate(r.prompt, 90))} | ` +
      `${r.champion_status} | ${escapeCell(truncate(r.champion_reason, 80))} | ` +
      `${r.challenger_status} | ${escapeCell(truncate(r.challenger_reason, 80))} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderRecommendation(summary) {
  const lines = [];
  lines.push("## Promotion recommendation");
  lines.push("");
  lines.push(`**Recommendation: \`${summary.recommendation}\`**`);
  lines.push("");
  lines.push(`- Runner verdict: \`${summary.runner_verdict || "unknown"}\``);
  lines.push(`- Challenger wins: ${summary.challenger_wins} / ${PRODUCT_DIMENSIONS.length} (threshold: ${summary.win_threshold})`);
  lines.push(`- Champion wins: ${summary.champion_wins}`);
  lines.push(`- Ties: ${summary.ties}`);
  lines.push(`- Degraded dims: ${summary.degraded_count}`);
  lines.push(`- Hard regressions (challenger mean ≥ ${HARD_REGRESSION_DELTA} below champion on any dim): ${summary.any_hard_regression ? "YES" : "no"}`);
  lines.push(`- Total per-probe regressions: ${summary.total_regressions}`);
  if (summary.runner_notes) {
    lines.push(`- Runner notes: ${summary.runner_notes}`);
  }
  lines.push("");
  // Explain the recommendation in plain text.
  const r = summary.recommendation;
  if (r === "PROMOTE") {
    lines.push("Doctrine check: challenger won the required number of dimensions, no");
    lines.push("dim is degraded, no hard regressions. Promotion is recommended.");
  } else if (r === "HOLD") {
    lines.push("Doctrine check: challenger did not meet the bar cleanly. Either it");
    lines.push("won 2 dims (one short of threshold), or it won enough dims but has a");
    lines.push("degraded dim or a hard regression. Hold until the regression is");
    lines.push("understood or the degraded dim is rerun with Mirage reachable.");
  } else {
    lines.push("Doctrine check: challenger failed to clear the bar. Either the runner");
    lines.push("verdict is reject / inconclusive_all_degraded, or the challenger lost");
    lines.push("the majority of dimensions. Do not promote. Investigate before re-bench.");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * generateReport — pure transform: results JSON in, { markdown, summary } out.
 */
export function generateReport(resultsJson) {
  const summary = buildSummary(resultsJson);
  const parts = [];
  parts.push(renderHeader(summary));
  parts.push(renderScorecard(summary));
  parts.push("## Per-dimension detail");
  parts.push("");
  for (const d of summary.dims) {
    parts.push(renderPerDimTable(d));
  }
  parts.push(renderRegressionSection(summary));
  parts.push(renderErrorSkipSection(summary));
  parts.push(renderRecommendation(summary));
  parts.push("---");
  parts.push("");
  parts.push(`_Report generated by \`04-CONTROL-PLANE/bakeoff/report.mjs\` from results schema \`${summary.schema_version}\`._`);
  parts.push("");
  const markdown = parts.join("\n");
  return { markdown, summary };
}

// ---------------------------------------------------------------------------
// Disk IO
// ---------------------------------------------------------------------------

function loadResults(input) {
  if (typeof input === "string") {
    const path = resolve(input);
    if (!existsSync(path)) throw new Error(`results file not found: ${path}`);
    const text = readFileSync(path, "utf8");
    try {
      return { json: JSON.parse(text), srcPath: path };
    } catch (e) {
      throw new Error(`results JSON invalid at ${path}: ${e.message}`);
    }
  }
  if (input && typeof input === "object") {
    return { json: input, srcPath: null };
  }
  throw new TypeError("resultsJson must be a path string or a parsed object");
}

function defaultOutPathFor(srcPath) {
  if (srcPath) return join(dirname(srcPath), DEFAULT_OUT_NAME);
  return resolve(__dirname, "results", DEFAULT_OUT_NAME);
}

/**
 * writeReport — render + write to disk. Returns { path, summary }.
 */
export function writeReport(resultsJson, outPath) {
  const { json, srcPath } = loadResults(resultsJson);
  const { markdown, summary } = generateReport(json);
  const path = outPath ? resolve(outPath) : defaultOutPathFor(srcPath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, markdown, "utf8");
  return { path, summary };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  let input = null;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--out") { out = next; i++; continue; }
    if (a === "--help" || a === "-h") {
      const head = readFileSync(__filename, "utf8").split("\n");
      for (const l of head) {
        if (l.startsWith("//") || l.startsWith("#!")) console.log(l);
        else break;
      }
      process.exit(0);
    }
    if (!input && !a.startsWith("--")) { input = a; continue; }
  }
  return { input, out };
}

async function main() {
  const { input, out } = parseCliArgs(process.argv.slice(2));
  if (!input) {
    console.error("usage: report.mjs <results.json> [--out report.md]");
    process.exit(1);
  }
  try {
    const { path, summary } = writeReport(input, out);
    process.stdout.write(
      `[report] wrote ${path}\n` +
      `[report] recommendation=${summary.recommendation} ` +
      `challenger_wins=${summary.challenger_wins}/${PRODUCT_DIMENSIONS.length} ` +
      `regressions=${summary.total_regressions} ` +
      `degraded=${summary.degraded_count}\n`
    );
    process.exit(0);
  } catch (e) {
    console.error(`[report] FATAL: ${e.message}`);
    process.exit(1);
  }
}

// Run main only when invoked directly. ESM has no require.main, so compare
// process.argv[1] against this file's URL.
const isDirectInvocation = (() => {
  try {
    const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
    return argv1 && argv1 === __filename;
  } catch { return false; }
})();
if (isDirectInvocation) {
  main();
}

// Test-only internals export.
export const __internals = Object.freeze({
  rowStatus,
  regressionDelta,
  summarizeDim,
  buildSummary,
  renderScorecard,
  renderPerDimTable,
  renderRegressionSection,
  renderErrorSkipSection,
  renderRecommendation,
  DEFAULT_OUT_NAME,
  HARD_REGRESSION_DELTA,
});
