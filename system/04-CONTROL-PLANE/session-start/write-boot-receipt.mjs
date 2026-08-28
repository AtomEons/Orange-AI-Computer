#!/usr/bin/env node
// Orange5 — Session-Start Boot Receipt Writer (standalone)
// Path:    04-CONTROL-PLANE/session-start/write-boot-receipt.mjs
// Runtime: Node >= 20 (Bun-compatible — node: imports only, no third-party deps)
//
// Purpose
// -------
// Make step 6 of the Session-Start ritual a real, callable, auditable artifact
// independent of the orchestrator. Given a SessionStartGrid (the object built
// by orchestrator.mjs) and an optional `prior_receipt` link, this module
// writes a hash-chained Markdown receipt to
//
//   10-RECEIPTS/orange5-build/{YYYY-MM-DD}-session-boot-{nnn}.md
//
// where {nnn} is a zero-padded daily sequence (001, 002, ...) computed by
// scanning the receipts directory. A sibling .json file is written next to
// the markdown so the full grid is recoverable byte-for-byte.
//
// Returns
// -------
//   {
//     receipt_path,   // absolute path to the .md file (the operator surface)
//     md_path,        // same as receipt_path (clarity alias)
//     json_path,      // absolute path to the .json sidecar (full grid)
//     receipt_id,     // "{YYYY-MM-DD}-session-boot-{nnn}"
//     seq,            // integer daily sequence
//     sha256,         // hex sha256 over canonical JSON of the receipt payload
//     prior_receipt,  // echo of the prior_receipt link the caller passed (or null)
//     bytes,          // size of the markdown file written
//     generated_at,   // ISO timestamp
//   }
//
// Doctrine
// --------
// - Mom's Law: every line is real. The hash is over the actual bytes the
//   caller passed, not a sanitized projection. No fake "all green" lines.
// - Hash chain: if a prior_receipt link is given, it is embedded in the
//   receipt payload BEFORE hashing, so the chain is verifiable end-to-end.
//   The receipt records its own hash but excludes the `receipt` self-field
//   from the hash input to avoid circularity.
// - Deterministic: keys sorted, no wall-clock leakage into the canonical
//   JSON other than `generated_at` (which the caller can override for tests
//   via `now`).
// - Atomic: writes go through a temp file + rename so a partial crash never
//   leaves a half-written receipt.
// - Pure data: no model calls, no network, no daemon dependency.
//
// CLI
// ---
//   node write-boot-receipt.mjs --grid path/to/grid.json [--prior path/to/prior.md]
//                               [--dir custom/receipts/dir]
//                               [--print]    # print the rendered markdown to stdout
//
// Exit codes: 0 receipt written, 1 hard error.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Paths

const ORANGE5_ROOT =
  process.env.ORANGE5_ROOT || resolve(__dirname, "..", "..");

const DEFAULT_RECEIPTS_DIR =
  process.env.ORANGE5_BOOT_RECEIPTS_DIR ||
  resolve(ORANGE5_ROOT, "10-RECEIPTS", "orange5-build");

const SCHEMA = "orange5.session-start-receipt.v1";

// ---------------------------------------------------------------------------
// Helpers

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Stable JSON serializer used as the hash input. Sorts object keys
 * recursively, preserves array order, drops `undefined` (JSON behavior),
 * and guards against cycles (cycle nodes become null — should never trigger
 * for well-formed grids, but we don't crash if they do).
 */
function canonicalJSON(obj) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(obj));
}

function isoNow() {
  return new Date().toISOString();
}

function isoDate(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

/**
 * Find the next daily sequence number by scanning the receipts directory
 * for files matching `{date}-session-boot-{nnn}.{md|json}`. Returns the
 * smallest integer >= 1 not already used today. This makes the writer safe
 * to call multiple times per day without races as long as filesystem
 * rename is atomic on the host (it is on NTFS for same-directory rename).
 */
function nextSeqForDate(dir, date) {
  if (!existsSync(dir)) return 1;
  const re = new RegExp(`^${date}-session-boot-(\\d{3})\\.(md|json)$`);
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = name.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

/**
 * Atomic write: write to a temp file in the same directory, then rename.
 * Same-directory rename is atomic on POSIX and on NTFS. We also try to
 * clean up the temp file on failure.
 */
function writeAtomic(targetPath, contents) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmp = resolve(
    dir,
    `.${basename(targetPath)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmp, contents, "utf8");
    renameSync(tmp, targetPath);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* swallow */ }
    throw e;
  }
}

/**
 * Normalize a prior_receipt argument into a stable, embeddable link object.
 * Accepts:
 *   - null / undefined  -> null
 *   - string path       -> { kind:"path", path, sha256: <hash of file if readable> }
 *   - { path, sha256? } -> echoed (sha256 filled in if missing and file readable)
 *   - { kind, ... }     -> passed through after light validation
 * The function never throws on a missing prior file — it records the
 * caller's intent and a `reachable:false` flag instead. That keeps the
 * chain honest when a prior was promised but is not on disk.
 */
function normalizePriorReceipt(prior) {
  if (prior == null) return null;
  if (typeof prior === "string") {
    return resolvePriorPath({ path: prior });
  }
  if (typeof prior === "object") {
    if (prior.kind && prior.kind !== "path") {
      // Pass-through for non-path links (e.g. { kind:"sha256", sha256:"..." }).
      return {
        kind: String(prior.kind),
        sha256: prior.sha256 ? String(prior.sha256) : null,
        ref: prior.ref ? String(prior.ref) : null,
      };
    }
    if (prior.path) return resolvePriorPath(prior);
  }
  return null;
}

function resolvePriorPath(prior) {
  const p = prior.path;
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  let reachable = false;
  let sha = prior.sha256 || null;
  let bytes = null;
  try {
    if (existsSync(abs)) {
      reachable = true;
      const data = readFileSync(abs);
      bytes = data.length;
      if (!sha) sha = sha256Hex(data);
    }
  } catch { /* keep reachable:false */ }
  return {
    kind: "path",
    path: abs,
    reachable,
    sha256: sha,
    bytes,
  };
}

// ---------------------------------------------------------------------------
// Grid rendering (compact, one-screen — mirrors orchestrator.renderDeployGrid
// but kept here so this module is standalone and stays in lockstep with the
// markdown layout we want in the receipt itself).

function fmtDuration(ms) {
  if (ms == null) return "?";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function renderGridText(grid) {
  const lines = [];
  lines.push("╭─ Orange5 Session-Start Grid ─────────────────────────────");
  lines.push(`│ schema     : ${grid.schema || "?"}`);
  lines.push(`│ session_id : ${grid.session_id || "?"}`);
  lines.push(`│ generated  : ${grid.generated_at || "?"}`);
  lines.push(`│ elapsed    : ${fmtDuration(grid.elapsed_ms)}   cache_hit:${!!grid.cache_hit}`);
  const health = grid.health || { band: "?", reds: [], yellows: [] };
  lines.push(`│ HEALTH     : ${health.band}`);
  if (Array.isArray(health.reds) && health.reds.length) {
    lines.push(`│   reds    : ${health.reds.join(", ")}`);
  }
  if (Array.isArray(health.yellows) && health.yellows.length) {
    lines.push(`│   yellows : ${health.yellows.join(", ")}`);
  }
  const steps = grid.steps || {};
  // 1. Soul Genome
  lines.push("├─ 1. Soul Genome");
  const sg = steps.soul_genome;
  if (sg && sg.ok) {
    lines.push(`│   sovereign : ${sg.sovereign?.alias || sg.sovereign?.name || "?"}`);
    lines.push(`│   sha256    : ${String(sg.genome_sha256 || "").slice(0, 16)}…  bytes:${sg.bytes}`);
  } else {
    lines.push(`│   FAIL : ${sg?.reason || "missing"}`);
  }
  // 2. Continuity
  lines.push("├─ 2. Continuity Packet");
  const c = steps.continuity;
  if (c && c.ok) {
    lines.push(`│   date      : ${c.date}   stale:${c.stale}   src:${c.source}`);
    const s = c.summary || {};
    lines.push(`│   progress  : ${s.progress_count}   blockers:${s.open_blockers_count}`);
    if (s.tomorrow_first_action) {
      lines.push(`│   next      : ${String(s.tomorrow_first_action).slice(0, 60)}`);
    }
  } else {
    lines.push(`│   FAIL : ${c?.reason || "missing"}`);
  }
  // 3. Guardrails
  lines.push("├─ 3. 27 Guardrails");
  const g = steps.guardrails;
  if (g && (g.ok || g.violations_count != null)) {
    lines.push(`│   reds:${g.violations_count || 0}   stop:${!!g.stop}   via:${g.transport}   ${fmtDuration(g.elapsed_ms_check)}`);
    for (const v of (g.violations || []).slice(0, 6)) {
      lines.push(`│     • ${v.guardrail_id} [${v.severity}] ${v.name}`);
    }
  } else {
    lines.push(`│   FAIL : ${g?.reason || "missing"}`);
  }
  // 4. Hot currents
  lines.push("├─ 4. Hot Currents (24h)");
  const hc = steps.hot_currents;
  if (hc && hc.ok) {
    lines.push(`│   count : ${hc.count}   src:${hc.source}   stale:${hc.stale}`);
    for (const x of (hc.currents || []).slice(0, 4)) {
      lines.push(`│     • ${x.event_type || "?"}  ${String(x.title || "").slice(0, 50)}`);
    }
  } else {
    lines.push(`│   FAIL : ${hc?.reason || "missing"}`);
  }
  // 5. Not-green ledger
  lines.push("├─ 5. Not-Green Ledger");
  const ng = steps.not_green_ledger;
  if (ng && ng.ok) {
    lines.push(`│   open  : ${ng.total_open}`);
    for (const s of ng.sections || []) {
      lines.push(`│     [${s.count}] ${s.section}`);
    }
  } else {
    lines.push(`│   FAIL : ${ng?.reason || "missing"}`);
  }
  lines.push("╰──────────────────────────────────────────────────────────");
  return lines.join("\n");
}

function renderPriorReceiptBlock(prior) {
  if (!prior) {
    return "_No prior receipt linked (first boot of the chain, or chain reset)._";
  }
  if (prior.kind === "path") {
    return [
      `- **Kind:** path`,
      `- **Path:** \`${prior.path}\``,
      `- **Reachable:** ${prior.reachable ? "yes" : "NO (recorded as link only)"}`,
      `- **SHA-256:** \`${prior.sha256 || "(unknown)"}\``,
      prior.bytes != null ? `- **Bytes:** ${prior.bytes}` : null,
    ].filter(Boolean).join("\n");
  }
  return [
    `- **Kind:** ${prior.kind || "unknown"}`,
    prior.sha256 ? `- **SHA-256:** \`${prior.sha256}\`` : null,
    prior.ref ? `- **Ref:** \`${prior.ref}\`` : null,
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Write a session-start boot receipt.
 *
 * Required:
 *   grid              SessionStartGrid object (as produced by orchestrator.runRitual)
 *
 * Optional:
 *   prior_receipt     null | string (path) | { kind, path?, sha256?, ref? }
 *   dir               override receipts directory (default 10-RECEIPTS/orange5-build)
 *   now               override timestamp (Date or ISO string) for deterministic tests
 *   seq               override the daily sequence integer (>=1); otherwise auto-derived
 *   note              optional one-line operator note included in the markdown
 *
 * Returns:
 *   { receipt_path, md_path, json_path, receipt_id, seq, sha256, prior_receipt, bytes, generated_at }
 *
 * Throws only on hard I/O failure. Caller-side validation errors throw with a
 * descriptive Error so failure modes are visible to the orchestrator.
 */
export function writeBootReceipt({
  grid,
  prior_receipt = null,
  dir = DEFAULT_RECEIPTS_DIR,
  now,
  seq,
  note = null,
} = {}) {
  if (!grid || typeof grid !== "object") {
    throw new Error("writeBootReceipt: `grid` is required and must be an object");
  }

  const generated_at =
    now instanceof Date
      ? now.toISOString()
      : typeof now === "string" && now
        ? now
        : isoNow();
  const date = isoDate(new Date(generated_at));
  const sequence = Number.isInteger(seq) && seq > 0 ? seq : nextSeqForDate(dir, date);
  const receipt_id = `${date}-session-boot-${pad3(sequence)}`;

  mkdirSync(dir, { recursive: true });
  const md_path = resolve(dir, `${receipt_id}.md`);
  const json_path = resolve(dir, `${receipt_id}.json`);

  const prior = normalizePriorReceipt(prior_receipt);

  // Build the receipt payload that will be hashed. The `receipt` self-field
  // is excluded from hashing — it is filled AFTER hashing with the resulting
  // hash so the file can record its own digest without circularity.
  const payload = {
    schema: SCHEMA,
    receipt_id,
    receipt_kind: "session-start-boot",
    generated_at,
    sequence,
    date,
    session_id: grid.session_id || null,
    health: grid.health || null,
    summary: {
      soul_genome_ok: !!grid.steps?.soul_genome?.ok,
      continuity_ok: !!grid.steps?.continuity?.ok,
      continuity_stale: !!grid.steps?.continuity?.stale,
      guardrails_violations: grid.steps?.guardrails?.violations_count ?? null,
      guardrails_stop: !!grid.steps?.guardrails?.stop,
      hot_currents_count: grid.steps?.hot_currents?.count ?? null,
      not_green_open: grid.steps?.not_green_ledger?.total_open ?? null,
    },
    prior_receipt: prior,
    note: note || null,
    grid,
  };

  // Hash input excludes its own future `sha256` field.
  const canonical = canonicalJSON(payload);
  const hash = sha256Hex(canonical);

  // JSON sidecar — full grid, self-referencing hash recorded.
  const jsonOut = {
    ...payload,
    sha256: hash,
    // `prior_sha256` is denormalized here so a chain-walker doesn't need to
    // parse the nested prior_receipt object to verify the link.
    prior_sha256: prior?.sha256 || null,
  };

  // Markdown surface — operator-readable, links the JSON sidecar.
  const healthBand = grid.health?.band || "?";
  const reds = Array.isArray(grid.health?.reds) ? grid.health.reds : [];
  const yellows = Array.isArray(grid.health?.yellows) ? grid.health.yellows : [];
  const md = [
    `# Receipt — Session Start Boot ${receipt_id}`,
    "",
    `**Schema:** \`${SCHEMA}\``,
    `**Receipt ID:** \`${receipt_id}\``,
    `**Generated:** ${generated_at}`,
    `**Session ID:** \`${grid.session_id || "?"}\``,
    `**Sequence (daily):** ${sequence}`,
    `**Health:** \`${healthBand}\``,
    reds.length ? `**Reds:** ${reds.map((r) => `\`${r}\``).join(", ")}` : null,
    yellows.length ? `**Yellows:** ${yellows.map((r) => `\`${r}\``).join(", ")}` : null,
    `**Grid SHA-256:** \`${hash}\``,
    note ? `**Note:** ${note}` : null,
    "",
    "## Prior receipt link (hash chain)",
    "",
    renderPriorReceiptBlock(prior),
    "",
    "## Deploy grid (rendered)",
    "",
    "```",
    renderGridText(grid),
    "```",
    "",
    "## Full grid JSON sidecar",
    "",
    `\`${json_path}\``,
    "",
    "## Inline payload (for offline verification)",
    "",
    "```json",
    JSON.stringify(jsonOut, null, 2),
    "```",
    "",
    "_This receipt was written by `04-CONTROL-PLANE/session-start/write-boot-receipt.mjs`._",
    "",
  ].filter((l) => l !== null).join("\n");

  // Atomic writes — JSON first so the sidecar is always present if the md
  // exists. If the md write fails after the json write, the orphan json is
  // not harmful; it will be linked by the next receipt's prior_receipt if
  // the operator chooses, or pruned manually.
  writeAtomic(json_path, JSON.stringify(jsonOut, null, 2));
  writeAtomic(md_path, md);

  let bytes = 0;
  try { bytes = statSync(md_path).size; } catch { /* swallow */ }

  return {
    receipt_path: md_path,
    md_path,
    json_path,
    receipt_id,
    seq: sequence,
    sha256: hash,
    prior_receipt: prior,
    bytes,
    generated_at,
  };
}

export default writeBootReceipt;

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grid") args.grid = argv[++i];
    else if (a === "--prior") args.prior = argv[++i];
    else if (a === "--dir") args.dir = argv[++i];
    else if (a === "--note") args.note = argv[++i];
    else if (a === "--seq") args.seq = parseInt(argv[++i], 10);
    else if (a === "--now") args.now = argv[++i];
    else if (a === "--print") args.print = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function helpText() {
  return [
    "Orange5 Session-Start Boot Receipt Writer",
    "",
    "Usage:",
    "  node write-boot-receipt.mjs --grid <grid.json> [options]",
    "",
    "Options:",
    "  --grid <path>     Path to a SessionStartGrid JSON file (required)",
    "  --prior <path>    Path to the previous receipt (md or json) for the hash chain",
    "  --dir <path>      Override receipts directory",
    "  --note <text>     Optional one-line note included in the markdown",
    "  --seq <n>         Override the daily sequence integer",
    "  --now <iso>       Override timestamp (ISO 8601) for deterministic tests",
    "  --print           Also print the rendered markdown to stdout",
    "  -h, --help        Show this help",
    "",
    "Exit codes: 0 ok, 1 hard error.",
  ].join("\n");
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch { return false; }
})();

if (isMain) {
  const args = parseArgs(process.argv);
  if (args.help || !args.grid) {
    process.stdout.write(helpText() + "\n");
    process.exit(args.help ? 0 : 1);
  }
  try {
    const gridPath = isAbsolute(args.grid) ? args.grid : resolve(process.cwd(), args.grid);
    const gridText = readFileSync(gridPath, "utf8");
    const parsed = JSON.parse(gridText);
    // Accept either a bare grid or an orchestrator envelope `{ ok, grid, ... }`.
    const grid = parsed && parsed.grid && parsed.grid.schema ? parsed.grid : parsed;
    const out = writeBootReceipt({
      grid,
      prior_receipt: args.prior || null,
      dir: args.dir || undefined,
      note: args.note || null,
      seq: args.seq,
      now: args.now,
    });
    if (args.print) {
      process.stdout.write(readFileSync(out.md_path, "utf8"));
      process.stdout.write("\n");
    }
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exit(0);
  } catch (e) {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        reason: "cli_failed",
        detail: String(e?.message || e),
      }) + "\n",
    );
    process.exit(1);
  }
}
