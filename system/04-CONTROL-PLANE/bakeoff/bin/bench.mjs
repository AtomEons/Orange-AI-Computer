#!/usr/bin/env node
// Orange5 / 04-CONTROL-PLANE / bakeoff / bin / bench.mjs
//
// Thin operator-facing CLI wrapper around runner.mjs (the product bakeoff).
//
// Doctrine (binding):
//   * This file is a CLI surface, not a re-implementation. All judgment,
//     scoring, mirage-skip logic, judge-fallback ladder, and verdict math
//     live in runner.mjs. We delegate via runProductBakeoff() so there is
//     one writer for that surface.
//   * Operator-facing defaults (per Wave 2 #029 spec):
//         --champion   orangellm-fatty:v0
//         --challenger qwen2.5:32b-instruct
//         --judge      ae-misfit:v0
//         --dimensions all  (or kebab-comma list, see DIM_ALIAS below)
//   * Preflight gate: refuses to start if ANY cited model tag (champion,
//     challenger, judge) is missing from `ollama list`. This is Mom's Law
//     applied to the bench: no fake-green from a bench that silently fell
//     back to a phantom model. The check is honest — we shell out to
//     `ollama list`, parse the NAME column, and require exact tag match.
//     A `--skip-ollama-check` escape hatch exists for non-ollama gateways
//     (e.g. when the gateway routes to a frontier judge), but the escape
//     is named in the receipt so the bypass is visible.
//   * Dimension flag accepts the kebab-case names that match the corpus
//     filenames (the operator-readable form), plus the literal "all".
//     We translate to the runner's canonical snake_case dimensions.
//   * Bearer / gateway / timeout / limit-per-dim / out / dry-run are
//     forwarded verbatim — we do not invent new defaults for them.
//
// Usage:
//   node bin/bench.mjs                      # full run with defaults
//   node bin/bench.mjs --challenger qwen2.5:14b
//   node bin/bench.mjs --dimensions pm-doctrine-recall,refusal-correctness
//   node bin/bench.mjs --skip-ollama-check  # bypass preflight (recorded)
//   node bin/bench.mjs --dry-run            # show plan, do not call models
//   node bin/bench.mjs --help
//
// Exit codes:
//   0   bench ran (any verdict)
//   1   fatal (missing model tag, corpus broken, runner threw)
//   2   bad CLI args
//
// Pure Node 20+. No external deps.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runProductBakeoff,
  PRODUCT_DIMENSIONS,
  __internals,
} from "../runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ---------------------------------------------------------------------------
// Defaults — operator-facing, per Wave 2 #029 spec
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  champion:    "orangellm-fatty:v0",
  challenger:  "qwen2.5:32b-instruct",
  judge:       "ae-misfit:v0",
  judgeFallback: "ae-misfit:v0",
  gateway:     process.env.ORANGE5_GATEWAY || "http://127.0.0.1:1337",
  bearer:      process.env.ORANGE5_BEARER || null,
  timeout:     60000,
  limitPerDim: Infinity,
  corpus:      resolve(__dirname, "..", "corpus"),
});

// ---------------------------------------------------------------------------
// Dimension alias map: kebab-case (operator-readable, matches corpus
// filenames) -> canonical snake_case used by runner.mjs.
// ---------------------------------------------------------------------------

const DIM_ALIAS = Object.freeze({
  "pm-doctrine-recall":       "pm_doctrine_recall",
  "receipt-spine-discipline": "receipt_spine_discipline",
  "refusal-correctness":      "refusal_correctness",
  "memory-coupling":          "memory_coupling",
  "hermes-restraint":         "hermes_restraint",
  // also accept snake_case verbatim for convenience
  "pm_doctrine_recall":       "pm_doctrine_recall",
  "receipt_spine_discipline": "receipt_spine_discipline",
  "refusal_correctness":      "refusal_correctness",
  "memory_coupling":          "memory_coupling",
  "hermes_restraint":         "hermes_restraint",
});

function normalizeDimensions(raw) {
  if (!raw || raw === "all") return [...PRODUCT_DIMENSIONS];
  const parts = String(raw).split(",").map(s => s.trim()).filter(Boolean);
  const out = [];
  const unknown = [];
  for (const p of parts) {
    const canonical = DIM_ALIAS[p.toLowerCase()];
    if (!canonical) { unknown.push(p); continue; }
    if (!out.includes(canonical)) out.push(canonical);
  }
  if (unknown.length) {
    throw new Error(
      `unknown --dimensions value(s): ${unknown.join(", ")}. ` +
      `Allowed: all, ${Object.keys(DIM_ALIAS).filter(k => k.includes("-")).join(", ")}`
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = {
    champion:      DEFAULTS.champion,
    challenger:    DEFAULTS.challenger,
    judge:         DEFAULTS.judge,
    judgeFallback: DEFAULTS.judgeFallback,
    dimensionsRaw: "all",
    gateway:       DEFAULTS.gateway,
    bearer:        DEFAULTS.bearer,
    timeout:       DEFAULTS.timeout,
    limitPerDim:   DEFAULTS.limitPerDim,
    corpus:        DEFAULTS.corpus,
    out:           null,
    dryRun:        false,
    skipOllamaCheck: false,
    help:          false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case "--champion":           a.champion = req(flag, next); i++; break;
      case "--challenger":         a.challenger = req(flag, next); i++; break;
      case "--judge":              a.judge = req(flag, next); i++; break;
      case "--judge-fallback":     a.judgeFallback = req(flag, next); i++; break;
      case "--dimensions":         a.dimensionsRaw = req(flag, next); i++; break;
      case "--gateway":            a.gateway = req(flag, next).replace(/\/$/, ""); i++; break;
      case "--bearer":             a.bearer = req(flag, next); i++; break;
      case "--timeout":            a.timeout = Number(req(flag, next)); i++; break;
      case "--limit-per-dim":      a.limitPerDim = Number(req(flag, next)); i++; break;
      case "--corpus":             a.corpus = resolve(req(flag, next)); i++; break;
      case "--out":                a.out = resolve(req(flag, next)); i++; break;
      case "--dry-run":            a.dryRun = true; break;
      case "--skip-ollama-check":  a.skipOllamaCheck = true; break;
      case "--help":
      case "-h":                   a.help = true; break;
      default:
        if (flag.startsWith("--")) {
          throw new Error(`unknown flag: ${flag}`);
        }
    }
  }
  return a;
}

function req(flag, val) {
  if (val === undefined || String(val).startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  const dimList = Object.keys(DIM_ALIAS).filter(k => k.includes("-")).join("\n                              ");
  process.stdout.write(`bench.mjs — Orange5 product bakeoff CLI

Usage:
  node bin/bench.mjs [options]

Defaults (Wave 2 #029):
  --champion    ${DEFAULTS.champion}
  --challenger  ${DEFAULTS.challenger}
  --judge       ${DEFAULTS.judge}
  --gateway     ${DEFAULTS.gateway}
  --dimensions  all

Options:
  --champion <tag>           model tag for the incumbent
  --challenger <tag>         model tag for the candidate
  --judge <tag>              judge LLM tag (separate from contestants)
  --judge-fallback <tag>     fallback judge if primary unparseable
  --dimensions <list>        comma list, or "all". Values:
                              ${dimList}
  --gateway <url>            OpenAI-compatible gateway (default ${DEFAULTS.gateway})
  --bearer <token>           bearer auth for gateway
  --timeout <ms>             per-request timeout (default ${DEFAULTS.timeout})
  --limit-per-dim <n>        cap probes per dim (default: all 12)
  --corpus <dir>             override corpus path
  --out <file>               override results file path
  --dry-run                  show plan without calling any model
  --skip-ollama-check        bypass the ollama-tag preflight (recorded
                              in the receipt so the bypass is visible)
  -h, --help                 show this and exit

Preflight: by default the CLI refuses to start unless every cited model
tag (champion, challenger, judge, judge-fallback) appears in
\`ollama list\`. Use --skip-ollama-check only when the gateway routes
to a non-ollama backend (e.g. a frontier judge). The bypass is named
in the result JSON under preflight.bypassed=true.
`);
}

// ---------------------------------------------------------------------------
// Ollama preflight
//
// We shell out to `ollama list` and parse the NAME column. We require an
// exact tag match (a model named "qwen2.5:32b-instruct" must appear as
// "qwen2.5:32b-instruct"). The check is silent on success, loud on
// failure. We surface the parsed installed tags in the result JSON so
// the operator can audit what the bench saw.
// ---------------------------------------------------------------------------

export function parseOllamaList(stdout) {
  // `ollama list` output:
  //   NAME                          ID              SIZE      MODIFIED
  //   orangellm-fatty:v0            abcdef          12 GB     2 days ago
  // Skip header and blank lines; first whitespace-separated token is NAME.
  if (typeof stdout !== "string") return [];
  const lines = stdout.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^NAME(\s+|$)/i.test(trimmed)) continue;
    const name = trimmed.split(/\s+/)[0];
    if (name) out.push(name);
  }
  return out;
}

function runOllamaList() {
  try {
    const out = execFileSync("ollama", ["list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    return { ok: true, stdout: out, error: null };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout?.toString() || "",
      error: e.message || String(e),
    };
  }
}

export function preflightOllamaTags({ tags, installed }) {
  const want = [...new Set(tags.filter(Boolean))];
  const missing = want.filter(t => !installed.includes(t));
  return { want, installed, missing, ok: missing.length === 0 };
}

// ---------------------------------------------------------------------------
// Output path default — mirrors runner.mjs but lives next to the CLI so
// callers who invoke this wrapper without --out get a stable location.
// ---------------------------------------------------------------------------

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function defaultOutPath({ champion, challenger }) {
  const stamp = new Date().toISOString().slice(0, 10);
  return resolve(__dirname, "..", "results", `${stamp}-${sanitize(champion)}-vs-${sanitize(challenger)}.json`);
}

function ensureDirFor(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`[bench] arg error: ${e.message}\n`);
    printHelp();
    return 2;
  }

  if (args.help) { printHelp(); return 0; }

  let dimensions;
  try {
    dimensions = normalizeDimensions(args.dimensionsRaw);
  } catch (e) {
    process.stderr.write(`[bench] ${e.message}\n`);
    return 2;
  }

  // -------------------------------------------------------------------------
  // Preflight: ollama tag presence
  // -------------------------------------------------------------------------

  const tagsToCheck = [
    args.champion,
    args.challenger,
    args.judge,
    args.judgeFallback,
  ];

  let preflight;
  if (args.skipOllamaCheck) {
    preflight = {
      checked: false,
      bypassed: true,
      bypass_reason: "--skip-ollama-check flag set; bench did NOT verify model tags against `ollama list`",
      want: [...new Set(tagsToCheck.filter(Boolean))],
      installed: [],
      missing: [],
    };
    process.stdout.write(`[bench] preflight bypassed (--skip-ollama-check); cited tags: ${preflight.want.join(", ")}\n`);
  } else {
    const listed = runOllamaList();
    if (!listed.ok) {
      process.stderr.write(
        `[bench] FATAL: cannot run \`ollama list\` (${listed.error}).\n` +
        `[bench]   if your gateway is not backed by ollama, re-run with --skip-ollama-check.\n`
      );
      return 1;
    }
    const installed = parseOllamaList(listed.stdout);
    const check = preflightOllamaTags({ tags: tagsToCheck, installed });
    preflight = {
      checked: true,
      bypassed: false,
      bypass_reason: null,
      want: check.want,
      installed,
      missing: check.missing,
    };
    if (!check.ok) {
      process.stderr.write(
        `[bench] FATAL: missing model tag(s) in \`ollama list\`: ${check.missing.join(", ")}\n` +
        `[bench]   installed tags (${installed.length}): ${installed.join(", ") || "(none)"}\n` +
        `[bench]   pull the missing tags, or pass --skip-ollama-check if the gateway routes\n` +
        `[bench]   to a non-ollama backend (the bypass will be named in the receipt).\n`
      );
      return 1;
    }
    process.stdout.write(`[bench] preflight ok: all ${check.want.length} tag(s) present in ollama list\n`);
  }

  // -------------------------------------------------------------------------
  // Dry-run: print plan, do not call models
  // -------------------------------------------------------------------------

  if (args.dryRun) {
    const plan = {
      dry_run: true,
      champion:    args.champion,
      challenger:  args.challenger,
      judge:       args.judge,
      judge_fallback: args.judgeFallback,
      gateway:     args.gateway,
      corpus_dir:  args.corpus,
      dimensions,
      limit_per_dim: Number.isFinite(args.limitPerDim) ? args.limitPerDim : "all",
      timeout_ms:  args.timeout,
      preflight,
    };
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return 0;
  }

  // -------------------------------------------------------------------------
  // Delegate to runner.mjs — single writer for bakeoff logic
  // -------------------------------------------------------------------------

  let result;
  try {
    result = await runProductBakeoff({
      champion:      args.champion,
      challenger:    args.challenger,
      corpus:        args.corpus,
      gateway:       args.gateway,
      judge:         args.judge,
      judgeFallback: args.judgeFallback,
      bearer:        args.bearer,
      out:           args.out,
      timeout:       args.timeout,
      limitPerDim:   args.limitPerDim,
      dimensions,
      dryRun:        false,
    });
  } catch (e) {
    process.stderr.write(`[bench] FATAL: runner threw: ${e.message}\n`);
    return 1;
  }

  // Annotate with the preflight receipt so the audit trail is in the file.
  const annotated = {
    ...result,
    preflight,
    cli: {
      wrapper:   "04-CONTROL-PLANE/bakeoff/bin/bench.mjs",
      argv:      argv.slice(),
      defaults:  { ...DEFAULTS, bearer: DEFAULTS.bearer ? "[redacted]" : null },
      resolved:  {
        champion: args.champion,
        challenger: args.challenger,
        judge: args.judge,
        judge_fallback: args.judgeFallback,
        dimensions,
      },
    },
  };

  const outPath = args.out || defaultOutPath({ champion: args.champion, challenger: args.challenger });
  ensureDirFor(outPath);
  writeFileSync(outPath, JSON.stringify(annotated, null, 2));

  process.stdout.write(`[bench] wrote ${outPath}\n`);
  process.stdout.write(
    `[bench] verdict=${annotated.verdict} wins ` +
    `champion=${annotated.wins.champion} ` +
    `challenger=${annotated.wins.challenger} ` +
    `tie=${annotated.wins.tie} ` +
    `degraded=${annotated.wins.degraded}\n`
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Entry — only when invoked directly (test-friendly)
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`;
if (isMain) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
    process.stderr.write(`[bench] FATAL: ${err.stack || err.message || String(err)}\n`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports for tests
// ---------------------------------------------------------------------------

export const __cli = Object.freeze({
  DEFAULTS,
  DIM_ALIAS,
  parseArgs,
  normalizeDimensions,
  parseOllamaList,
  preflightOllamaTags,
  defaultOutPath,
  // Re-export runner internals for symmetry in test bench
  runner: __internals,
});
