#!/usr/bin/env node
// triage-reds.mjs — live triage of the 27 Constitutional Guardrails.
//
// Disclosure: ATOM-27GUARD-TRIAGE-2026-0624
// Author: Atom McCree (AtomEons Systems Laboratory)
// Lane: 01-DOCTRINE / 27-guardrails / tools
//
// WHAT THIS DOES
// --------------
//   1. Imports ../runtime.mjs and runs all 27 checks in parallel against
//      the real disk state of this Orange5 checkout (no mocks).
//   2. For each guardrail that returns pass=false, builds a Thought-lane
//      Flux event (severity + suggested fix + raw details) and appends it
//      to the date-partitioned thought lane at
//        06-ORANGELLM/memory/ae-cobra/flux/events/thought/YYYY-MM-DD.jsonl
//      using the on-disk hash-chain protocol (ts, lane, origin, kind, body,
//      prev_hash, hash) — same shape the activation runner verifies in G13.
//   3. Writes a markdown report to state/last-triage.md covering the full
//      verdict, every red with its suggested fix, an honest gap section
//      naming the structural issues that no check can self-heal, and a
//      next-action ladder for the operator.
//
// Used by the live activation to surface real gaps (Receipt #033 went
// partial because the runtime daemon was never smoke-tested live; this
// tool is the smoke).
//
// CLI
// ---
//   node triage-reds.mjs                       # full live run, default outputs
//   node triage-reds.mjs --no-flux             # skip Thought-lane emission
//   node triage-reds.mjs --no-flux-runtime     # skip runtime.mjs flux-client write
//   node triage-reds.mjs --no-persist          # skip SQLite/JSONL persistence
//   node triage-reds.mjs --out <path>          # override markdown path
//   node triage-reds.mjs --json                # also print JSON verdict to stdout
//   node triage-reds.mjs --quiet               # suppress stdout banner
//
// Exit codes
// ----------
//   0  all 27 pass
//   1  at least one CRITICAL or HIGH red (matches runtime.mjs `stop` flag)
//   2  invocation error / triage tool itself failed
//
// MOM'S LAW
// ---------
// This is a witness. It does NOT silently fix anything. Every red gets an
// honest fix suggestion OR an honest "no automated remedy — operator
// review required" note. Receipts are the proof; the report file IS the
// receipt.

import { mkdirSync, existsSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARDRAILS_ROOT = resolve(HERE, "..");
const ORANGE5_ROOT = resolve(GUARDRAILS_ROOT, "..", "..");
const STATE_DIR = resolve(GUARDRAILS_ROOT, "state");
const DEFAULT_REPORT = resolve(STATE_DIR, "last-triage.md");
const THOUGHT_LANE_ROOT = resolve(
  ORANGE5_ROOT,
  "06-ORANGELLM",
  "memory",
  "ae-cobra",
  "flux",
  "events",
  "thought"
);

const DISCLOSURE_ID = "ATOM-27GUARD-TRIAGE-2026-0624";
const ORIGIN = "doctrine.27guardrails.triage";

// ---------------------------------------------------------------------------
// Suggested-fix table — one entry per G-ID. These are the operator-facing
// remedies, not the technical fault message. Pulled from the registry
// doctrine sources (CLAUDE.md, .claude/rules/, FRONTIER_ISOLATION_BOUNDARY,
// PR-build receipts ladder, Spiral Reasoning v3). When a check has no
// automated remedy ("no_state", "check threw", etc.), the runner falls
// back to a generic operator-review remedy.
// ---------------------------------------------------------------------------
const SUGGESTED_FIX = Object.freeze({
  G01: "Confirm runtime/node.py exists at the canonical path (one of: Orange5/runtime/node.py, Orange5/06-ORANGELLM/runtime/node.py, C:/AtomEons/runtime/node.py). If a rival file declares COGNITIVE_CENTER=True, delete the rival or move the declaration to the canonical file. Sole-authority is non-negotiable.",
  G02: "Set FOUNDER_SALARY_PER_INSTALL_CENTS in environment (or .env loaded by the runtime). Remove any hardcoded literal that bypasses the env. Verify with: rg -n 'FOUNDER_SALARY_PER_INSTALL_CENTS\\s*=\\s*[0-9]' --type=py --type=ts under the Orange5 root.",
  G03: "Open the gate-chain registration site and place LatticeIntegrityGate (LBCE) at position 0. No gate may register itself ahead of Gate 0. If Gate 0 is missing, the chain is unsafe to run — block promotion until restored.",
  G04: "Trace the autonomous-action path (orchestrator → executor → outbound) and confirm a synchronous, reachable Human Final Stop signal at every transition. If the stop hook is async-only or fire-and-forget, refactor to synchronous-block-on-stop semantics before re-running.",
  G05: "Move ATOMEONS_IDENTITY_SECRET out of source. Read it via process.env at boot only. Rotate the secret if it was ever committed (git log -p -S 'ATOMEONS_IDENTITY_SECRET').",
  G06: "Audit any frontier-bound calls (06-ORANGELLM, frontier loopback :7419) and confirm they route through the frontier gateway, not direct hosts. See FRONTIER_ISOLATION_BOUNDARY.md §3 — gateway is the only legal egress.",
  G07: "Remove any code-editor surface (Monaco / CodeMirror / ace) from the 4-lane operator app (02-APP/src/lanes/). Code editors belong in dev tooling, not in the operator surface. If a lane needs to display code, use a read-only viewer.",
  G08: "Verify exactly four lanes are registered in 02-APP/src/router.tsx: Chat, Cockpit, Vault, Settings. No additions, no renames, no removals without a constitutional review. If a 5th lane has crept in, revert it.",
  G09: "Re-read .claude/rules/00-moms-law.md. If the operator has flagged a Mom's Law breach for this turn, stop, redo the last output with full effort, and emit a MOMS_LAW_REVIEW receipt. The witness elevates from informational to blocking on operator flag.",
  G10: "Inspect the most recent receipts under 10-RECEIPTS/ and confirm every receipt has a non-null prior_sha256 (except genesis). If a chain break exists, run a chain_repair script and write a kind:'chain_repair' receipt — do NOT silently retie the chain.",
  G11: "Scan the last 50 git commit messages for fake-green words (passing, green, done, complete) without evidence. If found, the receipt for that commit must include test output or a verification receipt; otherwise rewrite the commit message to be honest.",
  G12: "Verify Reality Flux writes originate only from receipt-bearing terminals (origin field set, not 'unknown'). If you see direct writes from app code, route them through the receipts terminal instead. See 11-MIRAGE flux.mjs lane discipline.",
  G13: "Bind the frontier loopback (:7419) to 127.0.0.1 only, never 0.0.0.0. Verify with: netstat -an | findstr 7419. If exposed externally, kill the process and restart with explicit loopback bind.",
  G14: "Create or repair state/soul-genome.json. Schema is documented in lib/soul-genome.mjs. Without a Soul Genome anchor, Spiral Reasoning has no z_0 to anchor against — reasoning is unmoored.",
  G15: "Run `node lib/continuity-packet.mjs write` (or the cron) to produce yesterday's continuity packet under state/continuity/. Target deadline is 06:00 local. If the cron is missing, install it (see scripts.continuity:write in package.json).",
  G16: "Remove any persona simulation phrases ('as Atom would say…', 'speaking as X…') from outputs. Cite frameworks, results, techniques — not personifications. The HRE classifier should block emission; if it isn't, investigate why.",
  G17: "For the most recent deliverable, confirm three artifacts exist: the zip, the SHA-256, and the ledger row referencing both. If any of the three are missing, the deliverable did not ship — re-run the ledger emission.",
  G18: "On a trilane (Claude / GPT / Gemini) conflict, defer to GPT. Verify the conflict-resolution logic in the trilane bundler picks GPT over Gemini, and that the resolution is logged in the bundle manifest.",
  G19: "Set the Spiral Reasoning anchor: z_0 = Soul Genome. Confirm the reasoning runtime reads soul-genome.json at boot and uses it as the curvature origin. See SPIRAL_REASONING_INTEGRATION_v1.md.",
  G20: "Audit recent reasoning trajectories for alpha (belief angle) values. If alpha exceeded the configured bound, the trajectory has runaway curvature — bound the angle in the reasoning loop and re-run.",
  G21: "Verify 10-RECEIPTS/ exists and is writable by the runtime user. Create the directory if missing. If permission-denied, fix the ACL — receipts that cannot be written cannot prove anything.",
  G22: "Boot the Reality Flux daemon (cobra) on :7419 and confirm /healthz returns 200. If unreachable, check the spool at state/flux-spool.jsonl for queued events — they will replay on next reachable POST.",
  G23: "Open 18-HELD/ (misfit beta governance) and verify each beta branch has an explicit promotion gate. Silent canon drift = beta code in main without a promotion receipt. Revert any unreceipted promotion.",
  G24: "Review recent release decisions. If a non-release-steward agent shipped, that is a separation-of-powers breach. Re-route the next release through the release-steward and emit a corrective receipt.",
  G25: "Scan the last 50 commits for --no-verify or --no-gpg-sign. If present, re-run the hooks on those commits and emit a corrective receipt. Hook-skip without explicit operator authorization is a Mom's Law breach.",
  G26: "Confirm OrangeFive governed routing (orange.order.v1 through the spine and OrangeBrain) is present in standing docs and used as the orchestration entry point. Raw Workflow / parallel Agent calls without operator override are out-of-doctrine.",
  G27: "The registry has the wrong entry count. Open registry.mjs and confirm exactly 27 entries. Self-referential invariant — if this fails, every other check is suspect because the spine is broken.",
});

const GENERIC_FIX =
  "Operator review required — the check produced a red verdict but does not have an automated remedy registered. Open the check module under checks/ and the doctrine source cited in the registry, then determine the right corrective step.";

// ---------------------------------------------------------------------------
// CLI parser
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    flux: true,
    fluxRuntime: true,
    persist: true,
    out: DEFAULT_REPORT,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-flux") opts.flux = false;
    else if (a === "--no-flux-runtime") opts.fluxRuntime = false;
    else if (a === "--no-persist") opts.persist = false;
    else if (a === "--out") opts.out = resolve(argv[++i] || DEFAULT_REPORT);
    else if (a === "--json") opts.json = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else opts.unknown = (opts.unknown || []).concat([a]);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      "triage-reds.mjs — live triage of the 27 Constitutional Guardrails",
      "",
      "Usage:",
      "  node triage-reds.mjs [options]",
      "",
      "Options:",
      "  --no-flux            do not emit Thought-lane events per red",
      "  --no-flux-runtime    do not call runtime.mjs's flux-client",
      "  --no-persist         do not persist run to SQLite/JSONL",
      "  --out <path>         override markdown report path",
      "                       (default: state/last-triage.md)",
      "  --json               also write JSON verdict to stdout",
      "  --quiet              suppress stdout banner",
      "  -h, --help           this help",
      "",
      "Exit codes: 0 all pass, 1 CRITICAL/HIGH reds, 2 tool failure.",
      "",
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Thought-lane writer — matches the on-disk shape verified by the
// activation runner's G13 chain check:
//   {ts, lane:"thought", origin, kind, body, prev_hash, hash}
// hash = sha256( canonical JSON of the record with hash:"" )
// prev_hash = sha256 of the prior record in the same date-partitioned file
//             ("GENESIS" if first line in the file).
//
// We use a strict canonical JSON (sorted keys, no whitespace) so replay /
// verification is deterministic across machines.
// ---------------------------------------------------------------------------
function canonicalJSON(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number: ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalJSON(value[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function lastHashInFile(filePath) {
  if (!existsSync(filePath)) return "GENESIS";
  let data;
  try {
    data = readFileSync(filePath, "utf8");
  } catch {
    return "GENESIS";
  }
  if (!data) return "GENESIS";
  // ignore torn trailing fragment
  const complete = data.endsWith("\n") ? data : data.slice(0, data.lastIndexOf("\n") + 1);
  const lines = complete.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]);
      if (rec && typeof rec.hash === "string" && rec.hash.length > 0) return rec.hash;
    } catch {
      // skip unparseable lines
    }
  }
  return "GENESIS";
}

function appendThoughtEvent({ kind, body, ts }) {
  mkdirSync(THOUGHT_LANE_ROOT, { recursive: true });
  const date = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const file = resolve(THOUGHT_LANE_ROOT, `${date}.jsonl`);
  const prev_hash = lastHashInFile(file);
  const skeleton = {
    ts,
    lane: "thought",
    origin: ORIGIN,
    kind,
    body,
    prev_hash,
    hash: "",
  };
  const hash = sha256Hex(canonicalJSON(skeleton));
  const record = { ...skeleton, hash };
  appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  return { file, prev_hash, hash };
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------
function severitySortKey(s) {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[s] ?? 4;
}

function fmtDetails(d) {
  if (d == null) return "_(no details)_";
  if (typeof d === "string") return "```\n" + d.slice(0, 1200) + "\n```";
  try {
    const pretty = JSON.stringify(d, null, 2);
    if (pretty.length <= 1200) return "```json\n" + pretty + "\n```";
    return "```json\n" + pretty.slice(0, 1200) + "\n... (truncated)\n```";
  } catch {
    return "```\n" + String(d).slice(0, 1200) + "\n```";
  }
}

function fixFor(gid) {
  return SUGGESTED_FIX[gid] || GENERIC_FIX;
}

function gapSection(verdict, opts) {
  // Honest enumeration of structural state — things no individual check can
  // self-heal but the operator should see in every triage report.
  const gaps = [];

  // The dual-system issue: registry.mjs imports g01-g27, checks/index.mjs
  // imports 01-27. Either system works on its own, but they are not the
  // same set of files — a true single source of truth requires picking one.
  gaps.push({
    title: "Two parallel check sets exist in checks/",
    detail:
      "registry.mjs (used by runtime.mjs) imports legacy g01-g27 files. " +
      "checks/index.mjs imports the canonical 01-27 NN-slug files. " +
      "This triage tool runs the registry path (the live runtime). The " +
      "01-27 set is reachable only via checks/index.mjs and is not " +
      "currently wired to runtime.mjs. Pick one canonical set and delete " +
      "or wire the other before promoting beyond static scaffolding.",
  });

  // Receipt #033 partial — runtime daemon never smoke-tested live until now.
  gaps.push({
    title: "Receipt #033 returned status=partial",
    detail:
      "Receipt #033 noted the runtime daemon was specified but never " +
      "smoke-tested live. This triage run IS the live smoke. If this " +
      "run produces a clean markdown report and a Thought-lane receipt, " +
      "Receipt #033 can be re-issued with status=complete (operator " +
      "discretion — release-steward authority).",
  });

  // Bun :7460 not booted
  gaps.push({
    title: "Bun guardrails server (:7460) not booted",
    detail:
      "spec.md and package.json define `bun server.mjs` on :7460 as the " +
      "guardrail HTTP surface. The port is not currently bound. Boot " +
      "with: cd 01-DOCTRINE/27-guardrails && bun server.mjs. Until " +
      "booted, the only way to run all 27 is via this triage tool or " +
      "`node runtime.mjs` directly.",
  });

  // Gateway routes never wired into v1.mjs splice
  gaps.push({
    title: "Gateway routes at 06-ORANGELLM/server/routes/guardrails.mjs not spliced into v1.mjs",
    detail:
      "The guardrails route file exists but is not mounted in the v1 " +
      "router. The OrangeLLM gateway cannot proxy guardrail queries " +
      "until the splice lands. This is a manual edit — open " +
      "06-ORANGELLM/server/v1.mjs and import + mount " +
      "./routes/guardrails.mjs at the configured prefix.",
  });

  // Honest about checks that returned check threw / no_state
  const sketchy = verdict.results.filter(
    (r) =>
      !r.pass &&
      r.details &&
      (r.details.reason === "no_state" ||
        r.details.reason === "check threw" ||
        r.details.error)
  );
  if (sketchy.length > 0) {
    gaps.push({
      title: `${sketchy.length} check(s) failed due to runtime/wiring issues (not policy violations)`,
      detail:
        "These reds are infrastructure problems with the check itself or " +
        "missing state — not actual doctrine breaches. Listed: " +
        sketchy
          .map((s) => `${s.guardrail_id} (${s.details.reason || s.details.error || "unknown"})`)
          .join(", ") +
        ". Fix the check or supply the state before treating these as breaches.",
    });
  }

  if (!opts.flux) {
    gaps.push({
      title: "Thought-lane emission was disabled for this run (--no-flux)",
      detail:
        "Reds were NOT written to the Thought-lane Flux ledger. The " +
        "markdown report below is the only receipt. To enable receipts, " +
        "re-run without --no-flux.",
    });
  }
  if (!opts.fluxRuntime) {
    gaps.push({
      title: "Runtime flux-client write disabled (--no-flux-runtime)",
      detail:
        "runtime.mjs's writeViolationsToFlux() (which posts to the cobra " +
        "loopback or spools to state/flux-spool.jsonl) was skipped. The " +
        "Thought-lane events from this tool may still have been written " +
        "depending on --no-flux.",
    });
  }

  return gaps;
}

function buildMarkdown(verdict, opts, thoughtEmissions) {
  const ts = new Date(verdict.finished_at).toISOString();
  const reds = verdict.results.filter((r) => !r.pass);
  reds.sort((a, b) => severitySortKey(a.severity) - severitySortKey(b.severity));

  const lines = [];
  lines.push(`# 27 Guardrails — Triage Report`);
  lines.push("");
  lines.push(`- **Run ID:** \`${verdict.run_id}\``);
  lines.push(`- **Finished:** ${ts}`);
  lines.push(`- **Elapsed:** ${verdict.elapsed_ms} ms`);
  lines.push(`- **Overall:** ${verdict.ok ? "GREEN (all 27 pass)" : "RED (" + reds.length + " of 27 failed)"}`);
  lines.push(`- **Stop flag:** ${verdict.stop ? "YES — CRITICAL or HIGH red present" : "no"}`);
  lines.push(`- **Persist backend:** ${verdict.backend ?? "(disabled)"}`);
  lines.push(`- **Runtime flux-client:** ${verdict.flux ? JSON.stringify(verdict.flux) : "(no violations / disabled)"}`);
  lines.push(`- **Thought-lane events emitted:** ${thoughtEmissions.length}`);
  lines.push(`- **Disclosure:** ${DISCLOSURE_ID}`);
  lines.push("");

  // Verdict table — all 27
  lines.push(`## Verdict — all 27 checks`);
  lines.push("");
  lines.push("| G-ID | Severity | Pass | Elapsed | Name |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of verdict.results) {
    lines.push(
      `| ${r.guardrail_id} | ${r.severity} | ${r.pass ? "yes" : "**NO**"} | ${r.elapsed_ms} ms | ${r.name} |`
    );
  }
  lines.push("");

  // Reds in detail
  lines.push(`## Reds — ${reds.length}`);
  lines.push("");
  if (reds.length === 0) {
    lines.push("_All 27 green. No reds to triage._");
    lines.push("");
  } else {
    for (const r of reds) {
      lines.push(`### ${r.guardrail_id} — ${r.name}`);
      lines.push("");
      lines.push(`- **Severity:** ${r.severity}`);
      lines.push(`- **Doctrine:** ${r.doctrine}`);
      lines.push(`- **Check module:** \`${r.check_module}\``);
      lines.push(`- **Elapsed:** ${r.elapsed_ms} ms`);
      lines.push("");
      lines.push(`**Details:**`);
      lines.push("");
      lines.push(fmtDetails(r.details));
      lines.push("");
      lines.push(`**Suggested fix:**`);
      lines.push("");
      lines.push(`> ${fixFor(r.guardrail_id)}`);
      lines.push("");
      const emit = thoughtEmissions.find((e) => e.guardrail_id === r.guardrail_id);
      if (emit) {
        lines.push(
          `**Receipt:** Thought-lane event hash \`${emit.hash}\` (prev: \`${emit.prev_hash}\`) in \`${emit.file}\``
        );
        lines.push("");
      } else if (!opts.flux) {
        lines.push(`**Receipt:** _(Thought-lane emission disabled — --no-flux)_`);
        lines.push("");
      }
    }
  }

  // Honest gap section
  const gaps = gapSection(verdict, opts);
  lines.push(`## Honest gaps — structural state no single check can self-heal`);
  lines.push("");
  for (const g of gaps) {
    lines.push(`### ${g.title}`);
    lines.push("");
    lines.push(g.detail);
    lines.push("");
  }

  // Next-action ladder
  lines.push(`## Next action`);
  lines.push("");
  if (reds.length === 0) {
    lines.push("1. Re-issue Receipt #033 with `status=complete` (release-steward authority).");
    lines.push("2. Boot the Bun guardrails server on :7460 for cron-mode operation.");
    lines.push("3. Splice 06-ORANGELLM/server/routes/guardrails.mjs into v1.mjs.");
    lines.push("4. Schedule this tool on the 27-guardrails cron cadence (default: hourly).");
  } else {
    lines.push("1. Resolve every CRITICAL and HIGH red. The stop flag is " + (verdict.stop ? "**SET** — promotion is blocked." : "not set."));
    lines.push("2. For each red above, apply the suggested fix and re-run this tool.");
    lines.push("3. After all reds are resolved, re-run with `--no-flux` to confirm clean verdict without emitting fresh receipts.");
    lines.push("4. Only then promote downstream gates.");
  }
  lines.push("");
  lines.push(`_Generated by ${ORIGIN} on ${ts}._`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (opts.unknown) {
    process.stderr.write(`unknown arg(s): ${opts.unknown.join(", ")}\n\n`);
    printHelp();
    process.exit(2);
  }

  // Import runtime in-process so we hit the live registry, not a mock.
  let runGuardrails;
  try {
    const mod = await import(pathToFileURL(resolve(GUARDRAILS_ROOT, "runtime.mjs")).href);
    runGuardrails = mod.runGuardrails;
    if (typeof runGuardrails !== "function") {
      throw new Error("runtime.mjs does not export runGuardrails()");
    }
  } catch (err) {
    process.stderr.write(`triage-reds: failed to import runtime.mjs: ${err?.stack || err}\n`);
    process.exit(2);
  }

  if (!opts.quiet) {
    process.stdout.write(`triage-reds: running 27 guardrails live...\n`);
  }

  let verdict;
  try {
    verdict = await runGuardrails({
      write_to_flux: opts.fluxRuntime,
      persist: opts.persist,
    });
  } catch (err) {
    process.stderr.write(`triage-reds: runGuardrails threw: ${err?.stack || err}\n`);
    process.exit(2);
  }

  // Emit one Thought-lane event per red.
  const thoughtEmissions = [];
  const reds = verdict.results.filter((r) => !r.pass);
  if (opts.flux && reds.length > 0) {
    for (const r of reds) {
      try {
        const body = {
          run_id: verdict.run_id,
          guardrail_id: r.guardrail_id,
          name: r.name,
          severity: r.severity,
          doctrine: r.doctrine,
          check_module: r.check_module,
          elapsed_ms: r.elapsed_ms,
          details: r.details,
          suggested_fix: fixFor(r.guardrail_id),
          disclosure_id: DISCLOSURE_ID,
        };
        const kind = `guardrails.red.${(r.severity || "UNKNOWN").toLowerCase()}`;
        const emit = appendThoughtEvent({ kind, body, ts: verdict.finished_at });
        thoughtEmissions.push({ guardrail_id: r.guardrail_id, ...emit });
      } catch (err) {
        // Do not abort the whole triage on a single emission failure — record
        // the failure as a gap and continue. The witness keeps watching.
        thoughtEmissions.push({
          guardrail_id: r.guardrail_id,
          error: String(err?.message || err),
        });
      }
    }
  }

  // Write markdown report.
  const md = buildMarkdown(verdict, opts, thoughtEmissions);
  try {
    mkdirSync(dirname(opts.out), { recursive: true });
    await writeFile(opts.out, md, "utf8");
  } catch (err) {
    process.stderr.write(`triage-reds: could not write report to ${opts.out}: ${err?.message || err}\n`);
    process.exit(2);
  }

  if (!opts.quiet) {
    process.stdout.write(
      `triage-reds: verdict=${verdict.ok ? "GREEN" : "RED"} stop=${verdict.stop} ` +
        `reds=${reds.length} thought_events=${thoughtEmissions.filter((e) => !e.error).length} ` +
        `report=${opts.out}\n`
    );
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          run_id: verdict.run_id,
          ok: verdict.ok,
          stop: verdict.stop,
          elapsed_ms: verdict.elapsed_ms,
          red_count: reds.length,
          thought_emissions: thoughtEmissions,
          report_path: opts.out,
          disclosure_id: DISCLOSURE_ID,
        },
        null,
        2
      ) + "\n"
    );
  }

  // Exit code matches runtime.mjs CLI convention.
  process.exit(verdict.stop ? 1 : 0);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`triage-reds fatal: ${err?.stack || err}\n`);
    process.exit(2);
  });
}

export { main as triageReds, appendThoughtEvent, SUGGESTED_FIX, DISCLOSURE_ID };
