#!/usr/bin/env node
// reuse.mjs — Knowledge Strata: cite resolver (final loop stage)
// Path:    04-CONTROL-PLANE/knowledge-strata/reuse.mjs
// Runtime: Node >= 20 (no external deps; loopback-friendly)
//
// AtomEons canon: intake -> canon -> durable artifact -> integrity pass -> REUSE.
//
// Place in the loop
// -----------------
// reuse.mjs is the fifth and terminal gate of the Knowledge Strata compiler
// loop. It closes the cycle by making prior canon citable inside future
// receipts. When a receipt or LLM output cites `strata/<id>` (or any of the
// equivalent cite forms below), this module:
//
//   1. RESOLVE the cite to a concrete artifact pair (md + json sidecar),
//      preferring the durable 19-ARCHIVE pair (frozen, chained) over the
//      working canon row (mutable, indexed).
//   2. EXIST — verify both files are still present on disk.
//   3. SIGNATURE — rehash the live markdown and (where present) the canon
//      row JSON; compare against the recorded sha256s. Recompute the
//      chain_sha256 from prior_chain + canon + markdown and compare against
//      the sidecar's stored chain_sha256. Any mismatch is a hard refusal.
//   4. RETURN — render a full receipt-ready content block:
//        - title, summary, department, tags, claims
//        - markdown body (verbatim)
//        - intake_sha256, canon_sha256, markdown_sha256, chain_sha256
//        - resolved paths (absolute)
//        - cite_form (the form the caller used)
//
// This is what gives a citation legal force: the resolver proves the artifact
// the cite points at still exists, has not drifted, and is downstream of an
// unbroken hash chain. Mom's Law: a cite is only as honest as the receipt
// that backs it.
//
// Supported cite forms
// --------------------
//   strata/<canon-id>                  canonical short form
//   strata:<canon-id>                  colon-delimited variant
//   strata/<topic>/v<NN>               archive-by-topic+version
//   strata/<topic>/v<NN>/<canon-id>    fully qualified archive cite
//   strata/<canon-id>@v<NN>            canon-id pinned to archive version
//   strata://<topic>/<canon-id>        URI-shaped form (for transport)
//   <canon-id>                         bare id (only when --bare is allowed
//                                      or the caller passes --form=bare)
//
// Resolution priority
// -------------------
//   1. If cite names a topic + version, hit 19-ARCHIVE/strata/<topic>/v<NN>/.
//   2. If cite names a canon-id, scan archive INDEX.jsonl for the latest
//      archived version of that id. If found, use it.
//   3. Else fall back to the working canon row (canon/<dept>/<id>.canon.json)
//      and its rendered artifact (artifacts/<dept>/<id>.md).
//   4. Else: not_found.
//
// Verification layers
// -------------------
//   - exist: both md and json paths resolvable and readable.
//   - md_hash: sha256(live markdown) == sidecar.markdown_sha256
//   - canon_hash: sha256(live canon row JSON) == sidecar.canon_raw_sha256
//                 (only when working canon row is reachable; archive cites
//                  are still valid without a working canon row — the archive
//                  is the durable record).
//   - chain_hash: recomputed from prior_chain + canon_sha256 + markdown_sha256
//                 matches sidecar.chain_sha256. FORCE_BREAK rows are allowed
//                 but surfaced as a degradation flag, not a refusal — the
//                 operator already accepted the break at emit time.
//
// Output shape per AtomEons completion law
// ----------------------------------------
//   { result, evidence, blockers, next_action,
//     resolved: { ...artifact, content, hashes, paths, chain } }
//
// CLI
// ---
//   node reuse.mjs <cite>                   resolve a single cite
//   node reuse.mjs --cite <cite>            same, explicit
//   node reuse.mjs --batch                  read cite per line from stdin
//   node reuse.mjs --list                   list all resolvable strata cites
//                                           (working canon + archive)
//   node reuse.mjs --verify                 resolve and re-verify every cite
//                                           known to this stratum
//
// Flags
//   --form <form>          one of: short, colon, qualified, uri, bare
//                          (only used to control output cite_form rendering)
//   --topic <slug>         hint when cite is ambiguous
//   --version <NN>         pin to a specific archive version
//   --no-archive           skip 19-ARCHIVE; resolve from working canon only
//   --no-canon             skip working canon; resolve from 19-ARCHIVE only
//   --content              include full markdown body in the JSON output
//                          (default: include; pass --no-content to omit)
//   --no-content           omit markdown body (header + hashes only)
//   --json                 single-line JSON on stdout (default: pretty)
//   --quiet                suppress writes to strata.reuse.log.jsonl
//   --strict               treat soft-conflict sidecars as blockers
//   --allow-bare           accept bare canon ids (no "strata/" prefix)
//
// Receipts
// --------
//   strata.reuse.log.jsonl   append-only log of every resolution attempt
//                            (cite, found, verified, degraded, blockers)
//
// Boundary
// --------
// - No network. No external deps. Node 20+ stdlib.
// - Read-only with respect to canon and archive. Only writes the reuse log
//   (and only when --quiet is not set).
// - Single writer policy: this module never edits canon or archive. If a
//   verification fails, the operator must rerun canonize.mjs / emit.mjs /
//   integrity.mjs in the right order.

import { createHash } from "node:crypto";
import {
  mkdir, readFile, appendFile, readdir, stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit, stdin } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const SELF_DIR = dirname(__filename);
const DEFAULT_ROOT = resolve(SELF_DIR, "..", "..");

const SCHEMA = "knowledge-strata/reuse/v1";
const RESOLVER = "reuse.mjs/v1";

const DEPARTMENTS = Object.freeze([
  "AE0", "AE1", "AE2", "AE3", "AE4", "AE5", "AE6", "AE7",
  "AE8", "AE9", "AE10", "AE11", "AE12", "AE13", "AE14",
]);

const STRATA_INDEX_FILENAME = "strata.index.jsonl";
const ARCHIVE_INDEX_FILENAME = "INDEX.jsonl";
const REUSE_LOG_FILENAME = "strata.reuse.log.jsonl";

// ----- utilities -----

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function nowIso() { return new Date().toISOString(); }

async function ensureDir(p) { await mkdir(p, { recursive: true }); }

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const BOOLEAN_FLAGS = new Set([
  "batch", "list", "verify",
  "no-archive", "no-canon", "content", "no-content",
  "json", "quiet", "strict", "allow-bare",
]);

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { args.flags[key] = true; continue; }
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { args.flags[key] = next; i++; }
      else args.flags[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

// Canonical JSON for hashing — matches emit.mjs exactly so canon_sha256 cross-
// checks line up bit-for-bit.
function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

// Matches emit.mjs's buildChainHash. Kept here verbatim so a chain check
// does not need to import emit.mjs (one-way dependency hygiene).
function buildChainHash({ priorChainHash, markdownHash, canonHash }) {
  return sha256(`${priorChainHash || ""}|${canonHash}|${markdownHash}`);
}

function padVersion(n) {
  return "v" + String(n).padStart(2, "0");
}

function parseVersionDir(name) {
  const m = /^v(\d{2,})$/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// ----- cite parsing -----
//
// Returns:
//   { ok, raw, form, canon_id, topic, version, blockers }
function parseCite(raw, { allowBare = false } = {}) {
  const out = {
    ok: false,
    raw,
    form: null,
    canon_id: null,
    topic: null,
    version: null,
    blockers: [],
  };
  if (typeof raw !== "string" || !raw.trim()) {
    out.blockers.push("cite_empty");
    return out;
  }
  let s = raw.trim();

  // URI form: strata://<topic>/<canon-id>
  if (s.startsWith("strata://")) {
    const rest = s.slice("strata://".length);
    const parts = rest.split("/").filter(Boolean);
    if (parts.length === 1) {
      out.canon_id = parts[0];
      out.form = "uri";
      out.ok = true;
      return out;
    }
    if (parts.length === 2) {
      out.topic = parts[0];
      out.canon_id = parts[1];
      out.form = "uri";
      out.ok = true;
      return out;
    }
    out.blockers.push("cite_uri_shape_unrecognized");
    return out;
  }

  // Colon form: strata:<canon-id>
  if (s.startsWith("strata:")) {
    const rest = s.slice("strata:".length);
    if (!rest) {
      out.blockers.push("cite_colon_missing_id");
      return out;
    }
    out.canon_id = rest;
    out.form = "colon";
    out.ok = true;
    return out;
  }

  // Slash forms beginning with "strata/"
  if (s.startsWith("strata/")) {
    const rest = s.slice("strata/".length);
    // Detect @v<NN> suffix.
    let pinned = null;
    const atIdx = rest.lastIndexOf("@v");
    let body = rest;
    if (atIdx > 0) {
      const tail = rest.slice(atIdx + 1); // includes 'v'
      const n = parseVersionDir(tail);
      if (n !== null) {
        pinned = n;
        body = rest.slice(0, atIdx);
      }
    }
    const parts = body.split("/").filter(Boolean);
    if (parts.length === 0) {
      out.blockers.push("cite_strata_empty");
      return out;
    }
    if (parts.length === 1) {
      // strata/<canon-id> (optionally @vNN)
      out.canon_id = parts[0];
      out.version = pinned;
      out.form = pinned == null ? "short" : "pinned";
      out.ok = true;
      return out;
    }
    if (parts.length === 2) {
      // strata/<topic>/v<NN>
      const v = parseVersionDir(parts[1]);
      if (v !== null) {
        out.topic = parts[0];
        out.version = v;
        out.form = "topic_version";
        out.ok = true;
        return out;
      }
      // strata/<topic>/<canon-id>  (no v dir given)
      out.topic = parts[0];
      out.canon_id = parts[1];
      out.version = pinned;
      out.form = pinned == null ? "topic_id" : "topic_id_pinned";
      out.ok = true;
      return out;
    }
    if (parts.length === 3) {
      // strata/<topic>/v<NN>/<canon-id>
      const v = parseVersionDir(parts[1]);
      if (v === null) {
        out.blockers.push("cite_qualified_shape_unrecognized");
        return out;
      }
      out.topic = parts[0];
      out.version = v;
      out.canon_id = parts[2];
      out.form = "qualified";
      out.ok = true;
      return out;
    }
    out.blockers.push("cite_strata_too_many_segments");
    return out;
  }

  // Bare canon-id (only with --allow-bare).
  if (allowBare && /^[A-Za-z0-9_]+_[0-9a-f]{4,}$/.test(s)) {
    out.canon_id = s;
    out.form = "bare";
    out.ok = true;
    return out;
  }

  // Bare strata-shaped id (more permissive when allowed).
  if (allowBare && /^[A-Za-z0-9_.-]+$/.test(s)) {
    out.canon_id = s;
    out.form = "bare";
    out.ok = true;
    return out;
  }

  out.blockers.push("cite_unrecognized_form");
  return out;
}

// ----- resolution: archive -----

async function readArchiveIndex(archiveRoot) {
  const indexPath = join(archiveRoot, ARCHIVE_INDEX_FILENAME);
  if (!await pathExists(indexPath)) return { rows: [], indexPath };
  const raw = await readFile(indexPath, "utf8");
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return { rows, indexPath };
}

// Resolve cite to a concrete archive (topic, version, canon_id) entry by
// scanning the archive INDEX.jsonl. Returns the LATEST matching row.
async function resolveFromArchive({ archiveRoot, parsed }) {
  if (!await pathExists(archiveRoot)) return null;
  const { rows, indexPath } = await readArchiveIndex(archiveRoot);
  if (rows.length === 0) return null;

  // Filter candidates by what the cite specified.
  let candidates = rows;
  if (parsed.canon_id) candidates = candidates.filter(r => r.canon_id === parsed.canon_id);
  if (parsed.topic) candidates = candidates.filter(r => r.topic === parsed.topic);
  if (parsed.version != null) candidates = candidates.filter(r => r.version === parsed.version);

  // Topic+version form without canon_id: pick the only row in that slot.
  if (candidates.length === 0) {
    // Last resort for topic+version cites: walk the slot directly.
    if (parsed.topic && parsed.version != null) {
      const slot = join(archiveRoot, parsed.topic, padVersion(parsed.version));
      if (await pathExists(slot)) {
        const files = await readdir(slot);
        const sidecars = files.filter(f => f.endsWith(".json")).sort();
        if (sidecars.length) {
          const lastSidecar = sidecars[sidecars.length - 1];
          return {
            source: "archive_slot_walk",
            md_path: join(slot, basename(lastSidecar, ".json") + ".md"),
            json_path: join(slot, lastSidecar),
            index_row: null,
            index_path: indexPath,
          };
        }
      }
    }
    return null;
  }

  // Sort by emitted_at desc, version desc.
  candidates.sort((a, b) => {
    const ta = Date.parse(a.emitted_at || "") || 0;
    const tb = Date.parse(b.emitted_at || "") || 0;
    if (tb !== ta) return tb - ta;
    return (b.version || 0) - (a.version || 0);
  });
  const pick = candidates[0];
  return {
    source: "archive_index",
    md_path: pick.md_path,
    json_path: pick.json_path,
    index_row: pick,
    index_path: indexPath,
  };
}

// ----- resolution: working canon -----

async function readStrataIndex(stratumRoot) {
  const indexPath = join(stratumRoot, STRATA_INDEX_FILENAME);
  if (!await pathExists(indexPath)) return { rows: [], indexPath };
  const raw = await readFile(indexPath, "utf8");
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return { rows, indexPath };
}

async function resolveFromCanon({ stratumRoot, parsed }) {
  if (!parsed.canon_id) return null;
  // First try the strata.index.jsonl (canonize.mjs writes here).
  const { rows, indexPath } = await readStrataIndex(stratumRoot);
  let hit = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.id === parsed.canon_id) { hit = r; break; }
  }
  if (hit && hit.canon_path && await pathExists(hit.canon_path)) {
    // Recover artifact md path from the canon row payload (canonize.mjs
    // records it inside artifact.markdown_path).
    let mdPath = hit.markdown_path || null;
    if (!mdPath) {
      try {
        const row = JSON.parse(await readFile(hit.canon_path, "utf8"));
        mdPath = row?.artifact?.markdown_path || null;
      } catch { /* fall through */ }
    }
    return {
      source: "canon_index",
      canon_path: hit.canon_path,
      md_path: mdPath,
      index_row: hit,
      index_path: indexPath,
    };
  }

  // Fallback: walk canon/<dept>/<id>.canon.json.
  const canonRoot = join(stratumRoot, "canon");
  if (await pathExists(canonRoot)) {
    let depts;
    try { depts = await readdir(canonRoot); } catch { depts = []; }
    for (const d of depts) {
      const cp = join(canonRoot, d, `${parsed.canon_id}.canon.json`);
      if (await pathExists(cp)) {
        let mdPath = null;
        try {
          const row = JSON.parse(await readFile(cp, "utf8"));
          mdPath = row?.artifact?.markdown_path || null;
        } catch { /* ignore */ }
        return {
          source: "canon_walk",
          canon_path: cp,
          md_path: mdPath,
          index_row: null,
          index_path: indexPath,
        };
      }
    }
  }
  return null;
}

// ----- verification -----

// Verify an archive pair (md + json sidecar). Returns full evidence.
async function verifyArchivePair({ mdPath, jsonPath }) {
  const blockers = [];
  const evidence = {
    md_path: mdPath,
    json_path: jsonPath,
    md_exists: false,
    json_exists: false,
    md_sha256: null,
    sidecar_md_sha256: null,
    sidecar_chain_sha256: null,
    recomputed_chain_sha256: null,
    canon_sha256: null,
    force_break: null,
    md_hash_match: null,
    chain_hash_match: null,
  };

  let md = null;
  let sidecar = null;

  if (!mdPath || !await pathExists(mdPath)) {
    blockers.push("archive_md_missing");
  } else {
    evidence.md_exists = true;
    try { md = await readFile(mdPath, "utf8"); }
    catch (e) { blockers.push("archive_md_unreadable"); evidence.md_error = e.message; }
  }
  if (!jsonPath || !await pathExists(jsonPath)) {
    blockers.push("archive_sidecar_missing");
  } else {
    evidence.json_exists = true;
    try {
      const raw = await readFile(jsonPath, "utf8");
      sidecar = JSON.parse(raw);
    } catch (e) {
      blockers.push("archive_sidecar_unreadable");
      evidence.json_error = e.message;
    }
  }

  if (md && sidecar) {
    const liveMd = sha256(md);
    evidence.md_sha256 = liveMd;
    evidence.sidecar_md_sha256 = sidecar.markdown_sha256 || null;
    evidence.canon_sha256 = sidecar.canon_sha256 || null;
    evidence.sidecar_chain_sha256 = sidecar.chain_sha256 || null;
    evidence.force_break = sidecar.force_break || null;
    evidence.md_hash_match = (liveMd === sidecar.markdown_sha256);
    if (!evidence.md_hash_match) blockers.push("archive_md_hash_mismatch");

    // Chain recompute.
    const priorChain = sidecar.prior_version?.chain_sha256 || null;
    const effectivePrior = sidecar.force_break
      ? `${priorChain || ""}#FORCE_BREAK`
      : priorChain;
    const recomputed = buildChainHash({
      priorChainHash: effectivePrior,
      markdownHash: sidecar.markdown_sha256,
      canonHash: sidecar.canon_sha256,
    });
    evidence.recomputed_chain_sha256 = recomputed;
    evidence.chain_hash_match = (recomputed === sidecar.chain_sha256);
    if (!evidence.chain_hash_match) blockers.push("archive_chain_hash_mismatch");
  }

  return { blockers, evidence, md, sidecar };
}

// Verify a working canon pair (canon JSON + rendered md artifact).
async function verifyCanonPair({ canonPath, mdPath }) {
  const blockers = [];
  const evidence = {
    canon_path: canonPath,
    md_path: mdPath,
    canon_exists: false,
    md_exists: false,
    canon_raw_sha256: null,
    canon_sha256: null,
    md_sha256: null,
    recorded_md_sha256: null,
    md_hash_match: null,
  };

  let canonRow = null;
  let canonRaw = null;
  let md = null;

  if (!canonPath || !await pathExists(canonPath)) {
    blockers.push("canon_row_missing");
  } else {
    evidence.canon_exists = true;
    try {
      canonRaw = await readFile(canonPath, "utf8");
      canonRow = JSON.parse(canonRaw);
      evidence.canon_raw_sha256 = sha256(canonRaw);
      evidence.canon_sha256 = sha256(canonicalJson(canonRow));
    } catch (e) {
      blockers.push("canon_row_unreadable");
      evidence.canon_error = e.message;
    }
  }

  const effectiveMdPath = mdPath || canonRow?.artifact?.markdown_path || null;
  evidence.md_path = effectiveMdPath;
  if (!effectiveMdPath) {
    blockers.push("canon_artifact_path_missing");
  } else if (!await pathExists(effectiveMdPath)) {
    blockers.push("canon_artifact_md_missing");
  } else {
    evidence.md_exists = true;
    try {
      md = await readFile(effectiveMdPath, "utf8");
      evidence.md_sha256 = sha256(md);
      evidence.recorded_md_sha256 = canonRow?.artifact?.sha256
        || canonRow?.markdown_sha256
        || null;
      if (evidence.recorded_md_sha256) {
        evidence.md_hash_match = (evidence.md_sha256 === evidence.recorded_md_sha256);
        if (!evidence.md_hash_match) blockers.push("canon_md_hash_mismatch");
      } else {
        evidence.md_hash_match = null; // unknown — no recorded hash
      }
    } catch (e) {
      blockers.push("canon_artifact_md_unreadable");
      evidence.md_error = e.message;
    }
  }

  return { blockers, evidence, canonRow, canonRaw, md };
}

// Look for a soft-conflicts sidecar next to a canon row.
async function loadSoftConflicts(canonPath) {
  if (!canonPath) return null;
  const sidecarPath = canonPath.replace(/\.canon\.json$/, ".soft-conflicts.json");
  if (!await pathExists(sidecarPath)) return null;
  try {
    return JSON.parse(await readFile(sidecarPath, "utf8"));
  } catch {
    return null;
  }
}

// ----- top-level resolve -----

async function resolveCite({
  cite, flags, stratumRoot, archiveRoot,
}) {
  const startedAt = nowIso();
  const parsed = parseCite(cite, { allowBare: !!flags["allow-bare"] });
  const includeContent = !flags["no-content"];

  if (!parsed.ok) {
    return {
      ok: false,
      result: "cite_parse_failed",
      cite,
      parsed,
      blockers: parsed.blockers,
      next_action: "fix_cite_form",
      evidence: { resolver: RESOLVER, started_at: startedAt },
    };
  }

  // Try archive first (durable, chained) unless --no-archive.
  let archiveHit = null;
  let archiveCheck = null;
  if (!flags["no-archive"]) {
    archiveHit = await resolveFromArchive({ archiveRoot, parsed });
    if (archiveHit) {
      archiveCheck = await verifyArchivePair({
        mdPath: archiveHit.md_path,
        jsonPath: archiveHit.json_path,
      });
    }
  }

  // Try working canon for cross-reference (and as fallback when archive
  // missed) unless --no-canon.
  let canonHit = null;
  let canonCheck = null;
  if (!flags["no-canon"]) {
    canonHit = await resolveFromCanon({ stratumRoot, parsed });
    if (canonHit) {
      canonCheck = await verifyCanonPair({
        canonPath: canonHit.canon_path,
        mdPath: canonHit.md_path,
      });
    }
  }

  // Decide which side is authoritative.
  let primary = null;
  if (archiveHit && archiveCheck && archiveCheck.blockers.length === 0) {
    primary = { kind: "archive", hit: archiveHit, check: archiveCheck };
  } else if (canonHit && canonCheck && canonCheck.blockers.length === 0) {
    primary = { kind: "canon", hit: canonHit, check: canonCheck };
  } else if (archiveHit && archiveCheck) {
    // Archive found but verification failed — surface as a hard error rather
    // than silently falling back. A degraded archive is a bigger problem than
    // a missing one.
    primary = { kind: "archive", hit: archiveHit, check: archiveCheck };
  } else if (canonHit && canonCheck) {
    primary = { kind: "canon", hit: canonHit, check: canonCheck };
  }

  if (!primary) {
    const out = {
      ok: false,
      result: "not_found",
      cite,
      parsed,
      blockers: ["cite_not_resolvable_in_archive_or_canon"],
      next_action: "verify_id_or_run_canonize_emit_pipeline",
      evidence: {
        resolver: RESOLVER,
        started_at: startedAt,
        searched_archive: !flags["no-archive"],
        searched_canon: !flags["no-canon"],
        archive_root: archiveRoot,
        stratum_root: stratumRoot,
      },
    };
    await maybeLog(out, { stratumRoot, flags });
    return out;
  }

  // Surface soft-conflict sidecar if present on the canon row.
  let softConflicts = null;
  if (canonHit) {
    softConflicts = await loadSoftConflicts(canonHit.canon_path);
  }

  // Build the resolved content block.
  const blockers = [...primary.check.blockers];
  if (softConflicts && flags.strict) {
    blockers.push("soft_conflicts_present_strict_mode");
  }

  // Optional cross-check: when both sides are present and verified, the
  // archive sidecar's canon_raw_sha256 should match the live canon row's
  // raw sha256 if the canon row has not been edited since archive emission.
  let crossCheck = null;
  if (primary.kind === "archive" && primary.check.sidecar && canonCheck && canonCheck.evidence.canon_raw_sha256) {
    const archivedRaw = primary.check.sidecar.canon_raw_sha256 || null;
    const liveRaw = canonCheck.evidence.canon_raw_sha256;
    if (archivedRaw && archivedRaw !== liveRaw) {
      crossCheck = {
        kind: "canon_drifted_since_archive",
        archived_canon_raw_sha256: archivedRaw,
        live_canon_raw_sha256: liveRaw,
      };
      // Not a hard blocker — the archive is the durable record. Surface as
      // a degradation signal so the caller knows the working tree moved.
    } else if (archivedRaw && archivedRaw === liveRaw) {
      crossCheck = { kind: "canon_unchanged_since_archive" };
    }
  }

  // Hash-chain degradation (FORCE_BREAK at any level) is a flag, not a fail.
  let degraded = false;
  const degradedReasons = [];
  if (primary.kind === "archive" && primary.check.evidence.force_break) {
    degraded = true;
    degradedReasons.push("archive_force_break_in_chain");
  }
  if (primary.kind === "canon") {
    degraded = true;
    degradedReasons.push("served_from_working_canon_not_durable_archive");
  }
  if (crossCheck && crossCheck.kind === "canon_drifted_since_archive") {
    degraded = true;
    degradedReasons.push("working_canon_drifted_from_archive");
  }

  // Pull the renderable fields.
  let title = null, summary = null, department = null, tags = [], claims = [];
  let intakeSha = null, canonSha = null, mdSha = null, chainSha = null;
  let topic = parsed.topic;
  let version = parsed.version;

  if (primary.kind === "archive" && primary.check.sidecar) {
    const sc = primary.check.sidecar;
    title = sc.title;
    summary = sc.summary;
    department = sc.department;
    tags = Array.isArray(sc.tags) ? sc.tags : [];
    intakeSha = sc.intake_sha256 || null;
    canonSha = sc.canon_sha256 || null;
    mdSha = sc.markdown_sha256 || null;
    chainSha = sc.chain_sha256 || null;
    topic = sc.topic || topic;
    version = sc.version || version;
  }
  if (canonCheck && canonCheck.canonRow) {
    const row = canonCheck.canonRow;
    title = title || row.title || null;
    summary = summary || row.summary || null;
    department = department || row.department || null;
    if (!tags.length && Array.isArray(row.tags)) tags = row.tags;
    claims = Array.isArray(row.claims) ? row.claims : claims;
    intakeSha = intakeSha || row.intake?.sha256 || row.intake_sha256 || null;
  }

  const content = primary.kind === "archive"
    ? primary.check.md
    : canonCheck?.md || null;

  const resolved = {
    schema: SCHEMA,
    resolver: RESOLVER,
    cite,
    cite_form: parsed.form,
    canon_id: parsed.canon_id || canonCheck?.canonRow?.id || primary.check.sidecar?.canon_id || null,
    topic,
    version,
    department,
    title,
    summary,
    tags,
    claims,
    served_from: primary.kind,
    paths: {
      md: primary.kind === "archive" ? archiveHit?.md_path : canonHit?.md_path,
      json: primary.kind === "archive" ? archiveHit?.json_path : null,
      canon: canonHit?.canon_path || null,
    },
    hashes: {
      intake_sha256: intakeSha,
      canon_sha256: canonSha,
      markdown_sha256: mdSha,
      chain_sha256: chainSha,
    },
    chain: primary.kind === "archive" && primary.check.sidecar ? {
      version: primary.check.sidecar.version,
      prior_version: primary.check.sidecar.prior_version || null,
      force_break: primary.check.sidecar.force_break || null,
      recomputed_chain_sha256: primary.check.evidence.recomputed_chain_sha256,
      chain_hash_match: primary.check.evidence.chain_hash_match,
    } : null,
    soft_conflicts: softConflicts || null,
    cross_check: crossCheck,
    degraded,
    degraded_reasons: degradedReasons,
    content: includeContent ? content : null,
    content_omitted: !includeContent,
    resolved_at: nowIso(),
  };

  const out = {
    ok: blockers.length === 0,
    result: blockers.length === 0 ? "resolved" : "verification_failed",
    cite,
    parsed,
    blockers,
    next_action:
      blockers.length === 0
        ? (degraded ? "cite_usable_but_flagged_review_degradation" : "cite_to_receipt")
        : (primary.kind === "archive"
            ? "archive_integrity_failure_rerun_emit_or_investigate_tamper"
            : "canon_drift_detected_rerun_canonize"),
    evidence: {
      resolver: RESOLVER,
      started_at: startedAt,
      finished_at: resolved.resolved_at,
      archive: archiveHit ? {
        source: archiveHit.source,
        md_path: archiveHit.md_path,
        json_path: archiveHit.json_path,
        check: archiveCheck?.evidence,
      } : null,
      canon: canonHit ? {
        source: canonHit.source,
        canon_path: canonHit.canon_path,
        md_path: canonHit.md_path,
        check: canonCheck?.evidence,
      } : null,
      archive_root: archiveRoot,
      stratum_root: stratumRoot,
    },
    resolved,
  };

  await maybeLog(out, { stratumRoot, flags });
  return out;
}

async function maybeLog(out, { stratumRoot, flags }) {
  if (flags.quiet) return;
  try {
    await ensureDir(stratumRoot);
    const logPath = join(stratumRoot, REUSE_LOG_FILENAME);
    const row = {
      ts: nowIso(),
      cite: out.cite,
      ok: !!out.ok,
      result: out.result,
      served_from: out.resolved?.served_from || null,
      canon_id: out.resolved?.canon_id || out.parsed?.canon_id || null,
      topic: out.resolved?.topic || null,
      version: out.resolved?.version || null,
      degraded: !!out.resolved?.degraded,
      degraded_reasons: out.resolved?.degraded_reasons || [],
      blockers: out.blockers || [],
      md_sha256: out.resolved?.hashes?.markdown_sha256 || null,
      chain_sha256: out.resolved?.hashes?.chain_sha256 || null,
    };
    await appendFile(logPath, JSON.stringify(row) + "\n", "utf8");
  } catch {
    // Logging is best-effort; never block reuse on a log write.
  }
}

// ----- batch / list / verify -----

async function batchResolve({ flags, stratumRoot, archiveRoot }) {
  const raw = await readStdin();
  const cites = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const items = [];
  for (const c of cites) {
    items.push(await resolveCite({ cite: c, flags, stratumRoot, archiveRoot }));
  }
  return { result: "batch", count: items.length, items };
}

async function listAll({ stratumRoot, archiveRoot }) {
  const archive = await readArchiveIndex(archiveRoot);
  const canon = await readStrataIndex(stratumRoot);
  const seen = new Map();
  for (const r of archive.rows) {
    const key = r.canon_id;
    if (!key) continue;
    const cite = `strata/${r.topic}/v${String(r.version).padStart(2, "0")}/${r.canon_id}`;
    seen.set(`${key}@${r.version}`, {
      cite,
      short_cite: `strata/${r.canon_id}`,
      canon_id: r.canon_id,
      topic: r.topic,
      version: r.version,
      department: r.department,
      title: r.title,
      served_from: "archive",
      md_path: r.md_path,
      json_path: r.json_path,
      chain_sha256: r.chain_sha256,
    });
  }
  for (const r of canon.rows) {
    const key = r.id;
    if (!key) continue;
    if ([...seen.keys()].some(k => k.startsWith(`${key}@`))) continue;
    seen.set(`${key}@canon`, {
      cite: `strata/${r.id}`,
      short_cite: `strata/${r.id}`,
      canon_id: r.id,
      topic: null,
      version: null,
      department: r.department || null,
      title: r.title || null,
      served_from: "canon",
      md_path: r.markdown_path || null,
      canon_path: r.canon_path || null,
    });
  }
  return {
    result: "cites",
    archive_index: archive.indexPath,
    strata_index: canon.indexPath,
    count: seen.size,
    cites: [...seen.values()],
  };
}

async function verifyAll({ flags, stratumRoot, archiveRoot }) {
  const list = await listAll({ stratumRoot, archiveRoot });
  const results = [];
  let failed = 0;
  for (const c of list.cites) {
    const r = await resolveCite({
      cite: c.cite, flags: { ...flags, "no-content": true, quiet: true },
      stratumRoot, archiveRoot,
    });
    results.push({
      cite: c.cite,
      ok: r.ok,
      served_from: r.resolved?.served_from || null,
      degraded: !!r.resolved?.degraded,
      blockers: r.blockers || [],
    });
    if (!r.ok) failed++;
  }
  return {
    result: failed === 0 ? "verify_ok" : "verify_fail",
    checked: results.length,
    failed,
    results,
    next_action: failed === 0
      ? "all_cites_resolvable_and_verified"
      : "investigate_failed_cites",
  };
}

// ----- main -----

function emitJson(obj, flags) {
  const text = flags.json
    ? JSON.stringify(obj)
    : JSON.stringify(obj, null, 2);
  process.stdout.write(text + "\n");
}

async function main() {
  const args = parseArgs(argv);
  const flags = args.flags;

  const orange5Root = typeof flags.root === "string"
    ? resolve(flags.root)
    : DEFAULT_ROOT;
  const stratumRoot = SELF_DIR;
  const archiveRoot = join(orange5Root, "19-ARCHIVE", "strata");

  if (flags.list) {
    const out = await listAll({ stratumRoot, archiveRoot });
    emitJson(out, flags);
    return;
  }

  if (flags.verify) {
    const out = await verifyAll({ flags, stratumRoot, archiveRoot });
    emitJson(out, flags);
    if (out.failed > 0) exit(1);
    return;
  }

  if (flags.batch) {
    const out = await batchResolve({ flags, stratumRoot, archiveRoot });
    emitJson(out, flags);
    const anyFailed = out.items.some(i => !i.ok);
    if (anyFailed) exit(1);
    return;
  }

  const cite = typeof flags.cite === "string" ? flags.cite : args._[0];
  if (!cite) {
    process.stderr.write([
      "usage:",
      "  node reuse.mjs <cite>",
      "  node reuse.mjs --cite <cite>",
      "  node reuse.mjs --batch                  (stdin: one cite per line)",
      "  node reuse.mjs --list",
      "  node reuse.mjs --verify",
      "",
      "cite forms:",
      "  strata/<canon-id>",
      "  strata:<canon-id>",
      "  strata/<topic>/v<NN>",
      "  strata/<topic>/v<NN>/<canon-id>",
      "  strata/<canon-id>@v<NN>",
      "  strata://<topic>/<canon-id>",
      "",
      "flags: --topic <slug> --version <NN> --no-archive --no-canon",
      "       --no-content --json --quiet --strict --allow-bare",
      "",
    ].join("\n"));
    exit(2);
  }

  // Hoist --version flag into the parsed cite if the user passed it
  // alongside a short cite.
  const out = await resolveCite({ cite, flags, stratumRoot, archiveRoot });
  if (typeof flags.version === "string" && out.parsed) {
    const v = parseVersionDir("v" + String(flags.version).replace(/^v/, ""));
    if (v !== null && out.parsed.version == null) {
      out.parsed.version = v;
    }
  }
  emitJson(out, flags);
  if (!out.ok) exit(1);
}

main().catch(err => {
  process.stderr.write(JSON.stringify({
    result: "fatal",
    error: err?.message || String(err),
    stack: err?.stack,
  }) + "\n");
  exit(1);
});
