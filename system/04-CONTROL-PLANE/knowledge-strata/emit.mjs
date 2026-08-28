#!/usr/bin/env node
// emit.mjs — Knowledge Strata: durable artifact emission stage
// Path:    04-CONTROL-PLANE/knowledge-strata/emit.mjs
// Runtime: Node >= 20 (Bun-compatible — node: imports only)
//
// Place in the loop
// -----------------
// AtomEons Knowledge Strata is a compiler loop (per .claude doctrine):
//
//   intake  →  canon  →  durable artifact  →  integrity pass  →  reuse
//                          ^^^^^^^^^^^^^^^^
//
// `canonize.mjs` already renders an artifact inside the working
// 04-CONTROL-PLANE/knowledge-strata/ tree (mutable, indexed). That is the
// *living* surface where canon rows are written and re-written under --force.
//
// emit.mjs is different. It freezes a canon row into the long-horizon
// archive under 19-ARCHIVE/strata/<topic>/v<NN>/ as an immutable, hash-chained
// pair (Markdown + JSON sidecar). Each version carries `prior_version` and
// the sha256s of the prior artifact pair, building a tamper-evident chain
// across topic history. This is what survives a working-tree wipe.
//
// Output layout (created lazily on first emit per topic)
// ------------------------------------------------------
//   <ROOT>/19-ARCHIVE/strata/<topic>/v01/<canon-id>.md
//   <ROOT>/19-ARCHIVE/strata/<topic>/v01/<canon-id>.json
//   <ROOT>/19-ARCHIVE/strata/<topic>/v02/<canon-id>.md
//   ...
//   <ROOT>/19-ARCHIVE/strata/<topic>/CHAIN.jsonl   (append-only chain log)
//   <ROOT>/19-ARCHIVE/strata/INDEX.jsonl           (append-only global index)
//
// `<topic>` is a slug derived from either `--topic <slug>`, the canon row's
// first tag matching a topic prefix, or the title (slugged, deduped against
// dept). Topics are operator concepts, not departments — multiple departments
// may share a topic (e.g. "pathwaves", "moms-law", "knowledge-strata").
//
// `<canon-id>` is the canon row's stable id from canonize.mjs.
// `v<NN>` is zero-padded, monotonic per topic. First emission is v01.
//
// JSON sidecar shape (frozen)
// ---------------------------
// {
//   "schema": "knowledge-strata/emit/v1",
//   "topic": "<slug>",
//   "version": 3,
//   "prior_version": {                       // null on v01
//     "version": 2,
//     "canon_id": "...",
//     "md_path": "<absolute>",
//     "json_path": "<absolute>",
//     "md_sha256": "...",
//     "json_sha256": "..."
//   },
//   "canon_id": "<canonize.mjs id>",
//   "department": "AE0".."AE14",
//   "title": "...",
//   "summary": "...",
//   "intake_sha256": "<from canon row>",     // anchors back to raw intake
//   "canon_sha256": "<sha256 of canon row JSON, post-normalize>",
//   "markdown_sha256": "<sha256 of the .md we just wrote>",
//   "chain_sha256": "<sha256(prior.chain_sha256||'' + this.markdown_sha256)>",
//   "emitted_at": "<ISO>",
//   "emitter": "emit.mjs/v1",
//   "extractor": "<canon row.extractor>",
//   "tags": [...],
//   "lineage": {                             // copied from canon row
//     "supersedes": "<prior canon id or null>",
//     "canon_version": <canon row.version>
//   }
// }
//
// The CHAIN.jsonl row is the sidecar minus the heavy fields (entities, claims).
// The global INDEX.jsonl row carries pointer + chain hash for cite-search.
//
// Five gates (matches canonize.mjs idiom — separation of authority)
// -----------------------------------------------------------------
// Gate 1 INTEGRITY  — read canon row from disk; rehash artifact MD; reject if
//                     the canon row's recorded markdown sha256 no longer
//                     matches what's on disk. Anchors back to the intake hash.
// Gate 2 TOPIC      — resolve the topic slug (flag > canon row tag > title).
//                     Reject empties or collisions with reserved words.
// Gate 3 VERSION    — scan 19-ARCHIVE/strata/<topic>/ for prior v* dirs.
//                     Compute next NN. Refuse to overwrite an existing slot
//                     unless --force (chain is broken on --force; flagged
//                     loudly).
// Gate 4 EMIT       — render Markdown (with front-matter front-loaded for
//                     archive scanners), compute hashes, write MD + JSON,
//                     append CHAIN.jsonl row for the topic.
// Gate 5 REUSE      — append a global INDEX.jsonl row so reuse search can
//                     find archived versions, not just the working canon.
//
// Output shape per AtomEons completion law
// ----------------------------------------
//   { ok, id, gates:[...], evidence, blockers, next_action,
//     emitted: { md_path, json_path, chain_sha256, version } }
//
// CLI
// ---
//   node emit.mjs <canon-id>                    look up via strata.index.jsonl
//   node emit.mjs --canon <canon.json>          emit from a specific canon row
//   node emit.mjs --stdin                       read canon row JSON from stdin
//   node emit.mjs --batch                       emit every row in strata.index
//                                               (skips already-archived ids
//                                                whose markdown hash matches)
//   node emit.mjs --verify                      rehash full archive chain
//   node emit.mjs --list                        print archive INDEX
//
// Flags
// -----
//   --topic <slug>           override topic slug (kebab-case, [a-z0-9-])
//   --department <code>      override department lookup hint
//   --root <path>            override Orange5 root (default: ../../..)
//   --force                  permit overwrite of an existing v<NN> slot
//                            (chain_sha256 of new row records FORCE_BREAK)
//   --dry                    do not write anything, print plan
//   --no-index               skip global INDEX.jsonl append (testing only)
//
// Doctrine alignment (binding)
// ----------------------------
// - Mom's Law: never claim green without proof. The chain_sha256 in the JSON
//   sidecar is computed from materialized bytes, not promises. If we lie
//   here, every future receipt that cites this strata row inherits the lie,
//   so we don't lie here.
// - Receipts override recollection. Archive emission is what makes a canon
//   row durable beyond the working tree.
// - Single writer for overlapping files. Each v<NN> slot has exactly one MD
//   and one JSON. We refuse to overwrite without --force.
// - Loopback only. No network. No external deps. Node 20+ stdlib.

import { createHash } from "node:crypto";
import {
  mkdir, readFile, writeFile, appendFile, readdir, stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit, stdin } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const SELF_DIR = dirname(__filename);

// ----- configuration / topology -----

// emit.mjs lives at <ORANGE5>/04-CONTROL-PLANE/knowledge-strata/emit.mjs
// The archive is at <ORANGE5>/19-ARCHIVE/strata/
// So default root is two parents up.
const DEFAULT_ROOT = resolve(SELF_DIR, "..", "..");

const SCHEMA = "knowledge-strata/emit/v1";
const EMITTER = "emit.mjs/v1";

const DEPARTMENTS = Object.freeze([
  "AE0", "AE1", "AE2", "AE3", "AE4", "AE5", "AE6", "AE7",
  "AE8", "AE9", "AE10", "AE11", "AE12", "AE13", "AE14",
]);

const RESERVED_TOPIC_SLUGS = Object.freeze(new Set([
  "", "_", "-", "null", "undefined", "index", "chain",
  "v0", "v00", "v01", "tmp", "temp", "scratch", "draft",
]));

const STRATA_INDEX_FILENAME = "strata.index.jsonl";
const ARCHIVE_INDEX_FILENAME = "INDEX.jsonl";
const CHAIN_FILENAME = "CHAIN.jsonl";

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
  "dry", "force", "stdin", "verify", "batch", "list", "no-index",
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

// Canonical JSON for hashing: stable key order, no whitespace differences.
// We do NOT pretty-print this — we hash a deterministic bytewise form so that
// re-emitting the same canon row produces an identical canon_sha256.
function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

function slugify(s, { maxLen = 60 } = {}) {
  if (!s || typeof s !== "string") return "";
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")  // strip combining marks
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
}

function isValidTopicSlug(slug) {
  if (!slug || typeof slug !== "string") return false;
  if (RESERVED_TOPIC_SLUGS.has(slug)) return false;
  if (slug.length < 2 || slug.length > 80) return false;
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug);
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

// ----- canon row loading -----

// Locate a canon row by id by scanning the working strata.index.jsonl, then
// falling back to a directory walk under canon/. The index is authoritative
// when present (canonize.mjs appends to it on every successful emit).
async function findCanonRowById({ stratumRoot, id }) {
  const indexPath = join(stratumRoot, STRATA_INDEX_FILENAME);
  if (await pathExists(indexPath)) {
    const raw = await readFile(indexPath, "utf8");
    // Walk lines in reverse so the latest version wins.
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]);
        if (row.id === id && row.canon_path) {
          return { canon_path: row.canon_path, index_row: row };
        }
      } catch { /* skip malformed */ }
    }
  }
  // Fallback: scan canon/<dept>/<id>.canon.json
  const canonRoot = join(stratumRoot, "canon");
  if (!existsSync(canonRoot)) return null;
  const depts = await readdir(canonRoot);
  for (const d of depts) {
    const candidate = join(canonRoot, d, `${id}.canon.json`);
    if (await pathExists(candidate)) {
      return { canon_path: candidate, index_row: null };
    }
  }
  return null;
}

async function loadCanonRowFromPath(path) {
  const raw = await readFile(path, "utf8");
  const row = JSON.parse(raw);
  if (!row || typeof row !== "object" || !row.id) {
    throw new Error(`canon row at ${path} missing id`);
  }
  return { row, raw };
}

// ----- gates -----

// Gate 1: INTEGRITY
// Re-read the canon row's recorded artifact path and rehash. If the recorded
// markdown sha256 doesn't match what's on disk, refuse to archive — the
// living artifact has drifted and the operator must rerun canonize.mjs.
async function gateIntegrity({ canonRow }) {
  const blockers = [];
  const evidence = {};

  if (!canonRow.id) blockers.push("canon_row_missing_id");
  if (!canonRow.department || !DEPARTMENTS.includes(canonRow.department)) {
    blockers.push("canon_row_invalid_department");
  }
  if (!canonRow.intake?.sha256) blockers.push("canon_row_missing_intake_sha256");
  if (!canonRow.artifact?.markdown_path) blockers.push("canon_row_missing_artifact_path");
  if (!canonRow.artifact?.sha256) blockers.push("canon_row_missing_artifact_sha256");

  if (blockers.length === 0) {
    const mdPath = canonRow.artifact.markdown_path;
    if (!await pathExists(mdPath)) {
      blockers.push("artifact_markdown_missing_on_disk");
      evidence.expected_path = mdPath;
    } else {
      const md = await readFile(mdPath, "utf8");
      const liveHash = sha256(md);
      evidence.live_markdown_sha256 = liveHash;
      evidence.recorded_markdown_sha256 = canonRow.artifact.sha256;
      if (liveHash !== canonRow.artifact.sha256) {
        blockers.push("artifact_hash_mismatch_canon_drifted");
      }
    }
  }

  evidence.intake_sha256 = canonRow.intake?.sha256 ?? null;
  evidence.canon_id = canonRow.id;
  evidence.canon_version = canonRow.version ?? 1;

  return {
    name: "integrity",
    ok: blockers.length === 0,
    blockers,
    evidence,
  };
}

// Gate 2: TOPIC
// Decide the topic slug. Priority:
//   1. --topic flag (must be a valid slug already, or it is re-slugged).
//   2. First canon row tag that survives slugification AND is not equal to
//      the department code (lowercased).
//   3. Slug of canon row title.
// Reject reserved or empty slugs.
function gateTopic({ canonRow, flags }) {
  const blockers = [];
  const tried = [];
  let slug = null;
  let from = null;

  const candidates = [];
  if (typeof flags.topic === "string") candidates.push({ from: "flag", value: flags.topic });
  for (const t of (canonRow.tags || [])) {
    if (typeof t === "string") candidates.push({ from: `tag:${t}`, value: t });
  }
  if (canonRow.title) candidates.push({ from: "title", value: canonRow.title });

  const deptLower = (canonRow.department || "").toLowerCase();
  for (const c of candidates) {
    const s = slugify(c.value);
    tried.push({ from: c.from, raw: c.value, slug: s });
    if (!isValidTopicSlug(s)) continue;
    if (s === deptLower) continue;
    // Skip housekeeping tags from canonize.mjs.
    if (s === "heuristic" || s === "llm") continue;
    slug = s;
    from = c.from;
    break;
  }

  if (!slug) {
    // Last resort: department-prefixed id slug. Better than nothing, still
    // tamper-evident.
    const fallback = slugify(`${canonRow.department || "ae0"}-${canonRow.id || "row"}`);
    if (isValidTopicSlug(fallback)) {
      slug = fallback;
      from = "fallback:dept-id";
      tried.push({ from: "fallback", raw: fallback, slug: fallback });
    } else {
      blockers.push("topic_slug_could_not_be_derived");
    }
  }

  return {
    name: "topic",
    ok: blockers.length === 0,
    blockers,
    evidence: { slug, from, tried_in_order: tried },
    slug,
  };
}

// Gate 3: VERSION
// Walk 19-ARCHIVE/strata/<topic>/ and find existing v<NN> dirs. Next version
// is max(existing) + 1. Read the prior version's JSON sidecar so we can carry
// prior hashes into the chain.
async function gateVersion({ archiveRoot, topic, canonRow, flags }) {
  const blockers = [];
  const evidence = { topic_dir: join(archiveRoot, topic) };

  const topicDir = join(archiveRoot, topic);
  let nextN = 1;
  let prior = null;

  if (await pathExists(topicDir)) {
    const entries = await readdir(topicDir);
    const versions = entries
      .map(parseVersionDir)
      .filter(n => n !== null)
      .sort((a, b) => a - b);
    if (versions.length) {
      const lastN = versions[versions.length - 1];
      nextN = lastN + 1;
      // Load that prior sidecar. We allow multiple canon ids inside the same
      // topic (canon ids are unique per row, but a topic spans many rows);
      // we want the most-recently emitted sidecar across the topic to be
      // our chain anchor, regardless of which canon id wrote it.
      const priorDir = join(topicDir, padVersion(lastN));
      const sidecars = (await readdir(priorDir)).filter(f => f.endsWith(".json"));
      if (sidecars.length) {
        // Pick the lexicographically-last (canon ids are stable hashes, but
        // we need determinism if more than one sat in a slot somehow).
        sidecars.sort();
        const priorJsonPath = join(priorDir, sidecars[sidecars.length - 1]);
        try {
          const priorRaw = await readFile(priorJsonPath, "utf8");
          const priorObj = JSON.parse(priorRaw);
          const priorMdPath = join(priorDir, basename(priorJsonPath, ".json") + ".md");
          let priorMdHash = priorObj.markdown_sha256;
          let priorJsonHash = sha256(priorRaw);
          if (await pathExists(priorMdPath)) {
            const priorMd = await readFile(priorMdPath, "utf8");
            priorMdHash = sha256(priorMd);
          }
          prior = {
            version: priorObj.version,
            canon_id: priorObj.canon_id,
            md_path: priorMdPath,
            json_path: priorJsonPath,
            md_sha256: priorMdHash,
            json_sha256: priorJsonHash,
            chain_sha256: priorObj.chain_sha256 || null,
          };
        } catch (e) {
          blockers.push("prior_sidecar_unreadable");
          evidence.prior_error = e.message;
        }
      }
    }
  }

  const versionDir = join(topicDir, padVersion(nextN));
  const mdPath = join(versionDir, `${canonRow.id}.md`);
  const jsonPath = join(versionDir, `${canonRow.id}.json`);

  // Check for collision inside the *target* slot. Defensive — should not
  // happen because nextN is strictly above the max, unless the operator
  // pre-created the dir.
  let collision = false;
  if (await pathExists(mdPath) || await pathExists(jsonPath)) collision = true;
  if (collision && !flags.force) {
    blockers.push("target_slot_already_occupied");
  }

  evidence.next_version = nextN;
  evidence.version_dir = versionDir;
  evidence.collision = collision;
  evidence.prior = prior;

  return {
    name: "version",
    ok: blockers.length === 0,
    blockers,
    evidence,
    nextN,
    versionDir,
    mdPath,
    jsonPath,
    prior,
  };
}

// Gate 4: EMIT
// Render the Markdown body and the JSON sidecar, hash both, append the
// per-topic CHAIN.jsonl row, and write everything (unless --dry).
function renderArchiveMarkdown({ canonRow, topic, version, prior, emittedAt }) {
  const lines = [];
  // Front-matter for archive scanners that don't parse the JSON sidecar.
  lines.push("---");
  lines.push(`schema: ${SCHEMA}`);
  lines.push(`topic: ${topic}`);
  lines.push(`version: ${version}`);
  lines.push(`canon_id: ${canonRow.id}`);
  lines.push(`department: ${canonRow.department}`);
  lines.push(`canon_version: ${canonRow.version ?? 1}`);
  lines.push(`prior_version: ${prior ? prior.version : "null"}`);
  lines.push(`prior_canon_id: ${prior ? prior.canon_id : "null"}`);
  lines.push(`emitted_at: ${emittedAt}`);
  lines.push(`emitter: ${EMITTER}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${canonRow.title}`);
  lines.push("");
  lines.push(`> **Archive view.** Topic \`${topic}\` · version \`${padVersion(version)}\` · canon \`${canonRow.id}\``);
  lines.push(`> Department \`${canonRow.department}\` · intake sha256 \`${canonRow.intake?.sha256 ?? "(none)"}\``);
  if (prior) {
    lines.push(`> Supersedes archive \`${padVersion(prior.version)}/${prior.canon_id}\` (md sha256 \`${prior.md_sha256}\`)`);
  } else {
    lines.push(`> First archived version for this topic.`);
  }
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(canonRow.summary || "_no summary_");
  lines.push("");

  if (Array.isArray(canonRow.entities) && canonRow.entities.length) {
    lines.push("## Entities");
    lines.push("");
    for (const e of canonRow.entities) {
      const aliases = (e.aliases && e.aliases.length) ? ` _(aliases: ${e.aliases.join(", ")})_` : "";
      lines.push(`- **${e.name}** — ${e.kind || "thing"}${aliases}`);
    }
    lines.push("");
  }

  if (Array.isArray(canonRow.claims) && canonRow.claims.length) {
    lines.push("## Claims");
    lines.push("");
    for (const c of canonRow.claims) {
      const conf = c.confidence || "low";
      const sup = (c.supports && c.supports.length) ? `  \n  _supports:_ ${c.supports.join("; ")}` : "";
      lines.push(`- [${conf}] ${c.text}${sup}`);
    }
    lines.push("");
  }

  if (Array.isArray(canonRow.cited_doctrine) && canonRow.cited_doctrine.length) {
    lines.push("## Cited doctrine");
    lines.push("");
    for (const d of canonRow.cited_doctrine) {
      const sec = d.section ? ` § ${d.section}` : "";
      lines.push(`- ${d.doc}${sec}`);
    }
    lines.push("");
  }

  if (Array.isArray(canonRow.tags) && canonRow.tags.length) {
    lines.push(`**Tags:** ${canonRow.tags.map(t => `\`${t}\``).join(" ")}`);
    lines.push("");
  }

  if (Array.isArray(canonRow.open_questions) && canonRow.open_questions.length) {
    lines.push("## Open questions");
    lines.push("");
    for (const q of canonRow.open_questions) lines.push(`- ${q}`);
    lines.push("");
  }

  lines.push("---");
  lines.push(`_Frozen by ${EMITTER}. The JSON sidecar is the authoritative chain anchor._`);
  lines.push("");
  return lines.join("\n");
}

function buildChainHash({ priorChainHash, markdownHash, canonHash }) {
  // chain_sha256 = sha256( prior.chain_sha256 || "" + "|" + canon_sha256 + "|" + markdown_sha256 )
  // Using a delimiter that cannot collide with hex chars to prevent length-extension ambiguity.
  return sha256(`${priorChainHash || ""}|${canonHash}|${markdownHash}`);
}

async function gateEmit({
  canonRow, canonRaw, topic, version, versionDir, mdPath, jsonPath, prior, flags,
}) {
  const blockers = [];
  const emittedAt = nowIso();

  const md = renderArchiveMarkdown({ canonRow, topic, version, prior, emittedAt });
  const markdownHash = sha256(md);

  // canon_sha256 is the canonical-form hash of the canon row JSON itself.
  // We hash the parsed-and-renormalized object, not the raw bytes, so that
  // whitespace drift in canonize.mjs's pretty-printer does not break the
  // chain on a re-emit. canonRaw is kept as a tie-breaker.
  const canonHash = sha256(canonicalJson(canonRow));

  const priorChainHash = prior?.chain_sha256 || null;
  const wasForceBreak = (prior && flags.force) ? "FORCE_BREAK" : null;
  const effectivePriorChain = wasForceBreak ? `${priorChainHash}#FORCE_BREAK` : priorChainHash;
  const chainHash = buildChainHash({
    priorChainHash: effectivePriorChain,
    markdownHash,
    canonHash,
  });

  const sidecar = {
    schema: SCHEMA,
    topic,
    version,
    prior_version: prior ? {
      version: prior.version,
      canon_id: prior.canon_id,
      md_path: prior.md_path,
      json_path: prior.json_path,
      md_sha256: prior.md_sha256,
      json_sha256: prior.json_sha256,
      chain_sha256: prior.chain_sha256,
    } : null,
    canon_id: canonRow.id,
    department: canonRow.department,
    title: canonRow.title,
    summary: canonRow.summary,
    intake_sha256: canonRow.intake?.sha256 ?? null,
    canon_sha256: canonHash,
    canon_raw_sha256: sha256(canonRaw),
    markdown_sha256: markdownHash,
    chain_sha256: chainHash,
    force_break: wasForceBreak,
    emitted_at: emittedAt,
    emitter: EMITTER,
    extractor: canonRow.extractor || "unknown",
    tags: Array.isArray(canonRow.tags) ? canonRow.tags : [],
    lineage: {
      supersedes: canonRow.supersedes || null,
      canon_version: canonRow.version ?? 1,
    },
  };

  const sidecarJson = JSON.stringify(sidecar, null, 2);

  if (flags.dry) {
    return {
      name: "emit",
      ok: blockers.length === 0,
      blockers,
      evidence: {
        dry: true,
        md_path: mdPath,
        json_path: jsonPath,
        markdown_sha256: markdownHash,
        chain_sha256: chainHash,
        version,
      },
      sidecar, md, sidecarJson, markdownHash, chainHash, emittedAt,
    };
  }

  await ensureDir(versionDir);
  await writeFile(mdPath, md, "utf8");
  await writeFile(jsonPath, sidecarJson, "utf8");

  // Append to per-topic CHAIN.jsonl. This is the topic's tamper-evident log.
  const topicDir = dirname(versionDir);
  const chainPath = join(topicDir, CHAIN_FILENAME);
  const chainRow = {
    version,
    canon_id: canonRow.id,
    department: canonRow.department,
    title: canonRow.title,
    md_path: mdPath,
    json_path: jsonPath,
    intake_sha256: canonRow.intake?.sha256 ?? null,
    canon_sha256: canonHash,
    markdown_sha256: markdownHash,
    prior_chain_sha256: priorChainHash,
    chain_sha256: chainHash,
    force_break: wasForceBreak,
    emitted_at: emittedAt,
  };
  await appendFile(chainPath, JSON.stringify(chainRow) + "\n", "utf8");

  return {
    name: "emit",
    ok: blockers.length === 0,
    blockers,
    evidence: {
      md_path: mdPath,
      json_path: jsonPath,
      chain_path: chainPath,
      markdown_sha256: markdownHash,
      chain_sha256: chainHash,
      canon_sha256: canonHash,
      version,
    },
    sidecar, md, sidecarJson, markdownHash, chainHash, emittedAt, chainPath,
  };
}

// Gate 5: REUSE
// Append to the global archive INDEX.jsonl so reuse-search can find this
// archived version across topics and departments.
async function gateReuse({ archiveRoot, topic, version, canonRow, emitEvidence, flags }) {
  const blockers = [];
  const indexPath = join(archiveRoot, ARCHIVE_INDEX_FILENAME);

  const indexRow = {
    topic,
    version,
    canon_id: canonRow.id,
    department: canonRow.department,
    title: canonRow.title,
    summary: canonRow.summary,
    tags: Array.isArray(canonRow.tags) ? canonRow.tags : [],
    md_path: emitEvidence.md_path,
    json_path: emitEvidence.json_path,
    intake_sha256: canonRow.intake?.sha256 ?? null,
    canon_sha256: emitEvidence.canon_sha256,
    markdown_sha256: emitEvidence.markdown_sha256,
    chain_sha256: emitEvidence.chain_sha256,
    emitted_at: emitEvidence.emitted_at || nowIso(),
  };

  if (!flags.dry && !flags["no-index"]) {
    await ensureDir(archiveRoot);
    await appendFile(indexPath, JSON.stringify(indexRow) + "\n", "utf8");
  }

  return {
    name: "reuse",
    ok: blockers.length === 0,
    blockers,
    evidence: {
      index_path: indexPath,
      appended: !flags.dry && !flags["no-index"],
      dry: !!flags.dry,
    },
  };
}

// ----- pipeline -----

async function emitOne({ canonRow, canonRaw, flags, stratumRoot, archiveRoot }) {
  const g1 = await gateIntegrity({ canonRow });
  if (!g1.ok) {
    return {
      ok: false,
      id: canonRow.id,
      gates: [g1],
      next_action: "rerun_canonize_to_realign_artifact_hash",
    };
  }

  const g2 = gateTopic({ canonRow, flags });
  if (!g2.ok) {
    return {
      ok: false,
      id: canonRow.id,
      gates: [g1, g2],
      next_action: "pass_--topic_<slug>",
    };
  }

  const topic = g2.slug;
  const stratumArchiveRoot = archiveRoot; // 19-ARCHIVE/strata/

  const g3 = await gateVersion({ archiveRoot: stratumArchiveRoot, topic, canonRow, flags });
  if (!g3.ok) {
    return {
      ok: false,
      id: canonRow.id,
      gates: [g1, g2, g3],
      next_action: "pass_--force_or_clean_slot",
    };
  }

  const g4 = await gateEmit({
    canonRow, canonRaw, topic,
    version: g3.nextN,
    versionDir: g3.versionDir,
    mdPath: g3.mdPath,
    jsonPath: g3.jsonPath,
    prior: g3.prior,
    flags,
  });
  if (!g4.ok) {
    return {
      ok: false,
      id: canonRow.id,
      gates: [g1, g2, g3, g4],
      next_action: "investigate_emit_gate",
    };
  }

  const g5 = await gateReuse({
    archiveRoot: stratumArchiveRoot,
    topic,
    version: g3.nextN,
    canonRow,
    emitEvidence: { ...g4.evidence, emitted_at: g4.emittedAt },
    flags,
  });

  return {
    ok: g5.ok,
    id: canonRow.id,
    topic,
    version: g3.nextN,
    gates: [g1, g2, g3, g4, g5],
    emitted: {
      md_path: g4.evidence.md_path,
      json_path: g4.evidence.json_path,
      markdown_sha256: g4.evidence.markdown_sha256,
      canon_sha256: g4.evidence.canon_sha256,
      chain_sha256: g4.evidence.chain_sha256,
      version: g3.nextN,
      topic,
    },
    next_action: g5.ok ? "cite_archive_in_future_receipts" : "investigate_reuse_gate",
  };
}

async function emitFromCanonRowPath(path, { flags, stratumRoot, archiveRoot }) {
  const { row, raw } = await loadCanonRowFromPath(path);
  return emitOne({ canonRow: row, canonRaw: raw, flags, stratumRoot, archiveRoot });
}

async function emitFromId(id, { flags, stratumRoot, archiveRoot }) {
  const found = await findCanonRowById({ stratumRoot, id });
  if (!found) {
    return {
      ok: false,
      id,
      gates: [],
      next_action: "verify_id_or_pass_--canon_<path>",
      evidence: { searched: stratumRoot, id },
    };
  }
  return emitFromCanonRowPath(found.canon_path, { flags, stratumRoot, archiveRoot });
}

async function emitFromStdin({ flags, stratumRoot, archiveRoot }) {
  const raw = await readStdin();
  let row;
  try {
    row = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      id: null,
      gates: [],
      next_action: "pass_valid_canon_row_json_on_stdin",
      evidence: { parse_error: e.message },
    };
  }
  return emitOne({ canonRow: row, canonRaw: raw, flags, stratumRoot, archiveRoot });
}

async function emitBatch({ flags, stratumRoot, archiveRoot }) {
  const indexPath = join(stratumRoot, STRATA_INDEX_FILENAME);
  if (!await pathExists(indexPath)) {
    return {
      ok: false,
      gates: [],
      next_action: "no_working_strata_index_present",
      evidence: { searched: indexPath },
    };
  }
  const raw = await readFile(indexPath, "utf8");
  // De-dupe by canon id, keeping the latest entry.
  const byId = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.id) byId.set(row.id, row);
    } catch { /* skip */ }
  }
  const results = [];
  for (const [id, indexRow] of byId) {
    if (!indexRow.canon_path) {
      results.push({ ok: false, id, gates: [], next_action: "index_row_missing_canon_path" });
      continue;
    }
    try {
      const out = await emitFromCanonRowPath(indexRow.canon_path, {
        flags, stratumRoot, archiveRoot,
      });
      results.push(out);
    } catch (e) {
      results.push({ ok: false, id, gates: [], next_action: "fix_emit_error", evidence: { error: e.message } });
    }
  }
  return results;
}

async function verifyArchive({ archiveRoot }) {
  if (!await pathExists(archiveRoot)) {
    return { ok: true, evidence: { archive_missing: true, checked: 0 } };
  }
  const topics = (await readdir(archiveRoot)).filter(async (t) => {
    const s = await stat(join(archiveRoot, t)).catch(() => null);
    return s?.isDirectory();
  });
  const failures = [];
  let checked = 0;
  let priorChainHash = null;

  for (const topic of topics) {
    const topicDir = join(archiveRoot, topic);
    const topicStat = await stat(topicDir).catch(() => null);
    if (!topicStat?.isDirectory()) continue;
    if (topic === "INDEX.jsonl" || topic === ARCHIVE_INDEX_FILENAME) continue;

    const versions = (await readdir(topicDir))
      .map(parseVersionDir)
      .filter(n => n !== null)
      .sort((a, b) => a - b);

    priorChainHash = null;
    for (const v of versions) {
      const verDir = join(topicDir, padVersion(v));
      const files = await readdir(verDir);
      const sidecars = files.filter(f => f.endsWith(".json"));
      for (const j of sidecars) {
        checked++;
        const jPath = join(verDir, j);
        const mdPath = join(verDir, basename(j, ".json") + ".md");
        try {
          const sidecar = JSON.parse(await readFile(jPath, "utf8"));
          if (!await pathExists(mdPath)) {
            failures.push({ topic, version: v, reason: "md_missing", path: mdPath });
            continue;
          }
          const md = await readFile(mdPath, "utf8");
          const liveMdHash = sha256(md);
          if (liveMdHash !== sidecar.markdown_sha256) {
            failures.push({
              topic, version: v, canon_id: sidecar.canon_id,
              reason: "md_hash_mismatch",
              expected: sidecar.markdown_sha256, actual: liveMdHash,
            });
            continue;
          }
          // Chain check: recompute chain_sha256 from prior_chain + canon + md.
          const effectivePrior = sidecar.force_break
            ? `${sidecar.prior_version?.chain_sha256 || ""}#FORCE_BREAK`
            : (sidecar.prior_version?.chain_sha256 || null);
          const recomputed = buildChainHash({
            priorChainHash: effectivePrior,
            markdownHash: sidecar.markdown_sha256,
            canonHash: sidecar.canon_sha256,
          });
          if (recomputed !== sidecar.chain_sha256) {
            failures.push({
              topic, version: v, canon_id: sidecar.canon_id,
              reason: "chain_hash_mismatch",
              expected: sidecar.chain_sha256, actual: recomputed,
            });
            continue;
          }
          // Cross-version linkage: this sidecar's prior_version.chain_sha256
          // should equal whatever we last saw in this topic (when v > 1 and
          // not a FORCE_BREAK).
          if (v > 1 && !sidecar.force_break && sidecar.prior_version?.chain_sha256 !== priorChainHash && priorChainHash !== null) {
            failures.push({
              topic, version: v, canon_id: sidecar.canon_id,
              reason: "topic_chain_break",
              expected_prior: priorChainHash,
              actual_prior: sidecar.prior_version?.chain_sha256 ?? null,
            });
          }
          priorChainHash = sidecar.chain_sha256;
        } catch (e) {
          failures.push({ topic, version: v, file: j, reason: "sidecar_unreadable", detail: e.message });
        }
      }
    }
  }
  return { ok: failures.length === 0, evidence: { checked, failures } };
}

async function listArchive({ archiveRoot }) {
  const indexPath = join(archiveRoot, ARCHIVE_INDEX_FILENAME);
  if (!await pathExists(indexPath)) {
    return { ok: true, evidence: { index_missing: true }, rows: [] };
  }
  const raw = await readFile(indexPath, "utf8");
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return { ok: true, evidence: { index_path: indexPath, count: rows.length }, rows };
}

// ----- main -----

async function main() {
  const args = parseArgs(argv);
  const flags = args.flags;

  const orange5Root = typeof flags.root === "string"
    ? resolve(flags.root)
    : DEFAULT_ROOT;
  const stratumRoot = SELF_DIR;
  const archiveRoot = join(orange5Root, "19-ARCHIVE", "strata");

  // Topology echo for receipts.
  const topology = {
    orange5_root: orange5Root,
    stratum_root: stratumRoot,
    archive_root: archiveRoot,
  };

  // Subcommands first.
  if (flags.verify) {
    const out = await verifyArchive({ archiveRoot });
    process.stdout.write(JSON.stringify({
      result: out.ok ? "archive_ok" : "archive_fail",
      topology,
      ...out,
    }, null, 2) + "\n");
    if (!out.ok) exit(1);
    return;
  }

  if (flags.list) {
    const out = await listArchive({ archiveRoot });
    process.stdout.write(JSON.stringify({
      result: "archive_index",
      topology,
      ...out,
    }, null, 2) + "\n");
    return;
  }

  let result;
  if (flags.batch) {
    result = await emitBatch({ flags, stratumRoot, archiveRoot });
  } else if (flags.stdin) {
    result = await emitFromStdin({ flags, stratumRoot, archiveRoot });
  } else if (typeof flags.canon === "string") {
    result = await emitFromCanonRowPath(flags.canon, { flags, stratumRoot, archiveRoot });
  } else if (args._[0]) {
    // Positional: treat as canon id, unless it looks like a path on disk.
    const positional = args._[0];
    if (existsSync(positional)) {
      result = await emitFromCanonRowPath(positional, { flags, stratumRoot, archiveRoot });
    } else {
      result = await emitFromId(positional, { flags, stratumRoot, archiveRoot });
    }
  } else {
    console.error("usage:");
    console.error("  node emit.mjs <canon-id>");
    console.error("  node emit.mjs --canon <canon.json>");
    console.error("  node emit.mjs --stdin");
    console.error("  node emit.mjs --batch");
    console.error("  node emit.mjs --verify");
    console.error("  node emit.mjs --list");
    exit(2);
  }

  const payload = Array.isArray(result)
    ? { result: "batch", topology, count: result.length, items: result }
    : { result: result.ok ? "emitted" : "blocked", topology, ...result };

  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");

  const failed = Array.isArray(result)
    ? result.some(r => !r.ok)
    : !result.ok;
  if (failed) exit(1);
}

main().catch(err => {
  console.error(JSON.stringify({
    result: "fatal",
    error: err?.message || String(err),
    stack: err?.stack,
  }));
  exit(1);
});
