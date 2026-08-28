#!/usr/bin/env node
// integrity.mjs — Knowledge Strata: Integrity gate
// Path: 04-CONTROL-PLANE/knowledge-strata/integrity.mjs
// Runtime: Node >= 20 (no external deps; loopback only)
//
// AtomEons canon: intake -> canon -> durable artifact -> INTEGRITY PASS -> reuse.
//
// This is the fourth gate of the compiler loop. canonize.mjs already runs a
// cheap lexical-negation check inline; integrity.mjs is the heavyweight,
// vector-aware integrity pass that runs against the FULL prior canon corpus
// plus the durable 19-ARCHIVE artifacts. It speaks to the Graph Weaver
// embedder daemon on the N150 (loopback http://127.0.0.1:8798) — the same
// embedder that backs the Graph Weaver SQLite ontology — and computes
// cosine-similarity neighborhoods. For each near-neighbor it then performs a
// claim-vs-claim contradiction check (semantic similarity + polarity flip)
// and tags conflicts as HARD or SOFT.
//
// Hard conflict   = high-similarity claim with opposite polarity, prior claim
//                   is canon-locked (department doctrine, charter, Mom's Law,
//                   release law) OR confidence == high on both sides.
//                   -> refuse emit. exit 1. nothing is written downstream.
//
// Soft conflict   = same shape, but at least one side is medium/low confidence
//                   or the prior canon row is itself flagged
//                   (tags include 'frontier', 'speculative', or 'misfit').
//                   -> log to strata.integrity.log.jsonl for operator review,
//                   permit emit, but the artifact carries a 'soft_conflicts'
//                   sidecar so downstream readers see the open question.
//
// Drift          = near-duplicate artifact (cosine >= 0.92, no polarity flip)
//                   -> logged, surfaced as next_action='deduplicate', not a
//                   refuse-condition.
//
// Output shape (AtomEons completion law): { result, evidence, blockers,
// next_action }.
//
// CLI
// ---
//   node integrity.mjs <canon-path>                      single canon row
//   node integrity.mjs --markdown <artifact.md>          markdown artifact
//   node integrity.mjs --id <canon-id>                   look up by canon id
//   node integrity.mjs --sweep                           every prior canon row
//   node integrity.mjs --rebuild-index                   rebuild embedding cache
//   node integrity.mjs --verify                          re-emit integrity over
//                                                        the full canon set,
//                                                        useful after corpus
//                                                        drift / mass edits
//
// Flags
//   --embedder <url>      override embedder URL (default loopback :8798)
//   --topk <n>            neighbors to compare per claim (default 6)
//   --threshold <f>       cosine threshold for "near" (default 0.78)
//   --hard-threshold <f>  polarity-flip cosine threshold for HARD (0.83)
//   --no-archive          skip 19-ARCHIVE pass (canon-only)
//   --no-embed            disable embedder entirely; lexical fallback only,
//                         flagged honestly in evidence
//   --json                machine-readable single-line JSON to stdout
//   --quiet               suppress soft-conflict log writes
//   --force               write integrity verdict even on hard conflict
//                         (operator override, audited in receipt)
//
// Receipts
// --------
//   strata.integrity.log.jsonl   append-only log of every integrity run
//   strata.embeddings.cache.json key-value cache: sha256(text) -> vector
//                                (rebuilt on --rebuild-index)
//
// Boundary
// --------
// - Loopback only. Embedder daemon is on 127.0.0.1:8798 per N150 doctrine.
// - No external deps. No network calls outside loopback.
// - If embedder unreachable: degrade to lexical Jaccard + polarity heuristic
//   from canonize.mjs and label evidence.degraded=true. We never silently
//   green a degraded pass — Mom's Law.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, basename, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(__filename);
const ORANGE5_ROOT = resolve(ROOT, "..", "..");
const ARCHIVE_DIR = join(ORANGE5_ROOT, "19-ARCHIVE");

// ----- configuration -----

const DEFAULT_EMBEDDER_URL =
  process.env.N150_EMBEDDER_URL ||
  process.env.ORANGE5_EMBEDDER_URL ||
  "http://127.0.0.1:8798";
const DEFAULT_EMBED_MODEL =
  process.env.N150_EMBEDDER_MODEL || "nomic-embed-text:v1.5";
const EMBEDDER_TIMEOUT_MS = Number(process.env.ORANGE5_KS_EMBED_TIMEOUT_MS || 20_000);

const DEFAULT_TOPK = 6;
const DEFAULT_THRESHOLD = 0.78;          // "near-neighbor" cutoff
const DEFAULT_HARD_THRESHOLD = 0.83;     // polarity flip at/above => HARD
const DEFAULT_DUP_THRESHOLD = 0.92;      // near-duplicate cutoff

const DEPARTMENTS = Object.freeze([
  "AE0", "AE1", "AE2", "AE3", "AE4", "AE5", "AE6", "AE7",
  "AE8", "AE9", "AE10", "AE11", "AE12", "AE13", "AE14",
]);

// Tags that mark a prior canon row as deliberately flagged / frontier.
// A conflict against one of these rows is at most SOFT, never HARD.
const FRONTIER_TAGS = new Set([
  "frontier", "speculative", "misfit", "misfit-beta",
  "rebels", "hack-the-planet", "draft", "proposal",
]);

// Tags that lift a prior canon row to canon-lock (charter / doctrine /
// release law). A polarity flip against one of these rows escalates to HARD
// regardless of confidence levels.
const CANON_LOCK_TAGS = new Set([
  "charter", "doctrine", "moms-law", "release-law", "constitution",
  "invariant", "guardrail", "law",
]);

// ----- utilities -----

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function nowIso() { return new Date().toISOString(); }

async function ensureDir(p) { await mkdir(p, { recursive: true }); }

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

const BOOLEAN_FLAGS = new Set([
  "sweep", "rebuild-index", "verify", "no-archive", "no-embed",
  "json", "quiet", "force",
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ----- embedder client -----

async function probeEmbedder(baseUrl) {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/readyz`, {}, 3_000);
    if (!res.ok) return { ok: false, reason: `readyz_${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `unreachable:${e?.message || e}` };
  }
}

async function embedOne({ baseUrl, model, text }) {
  const body = JSON.stringify({ text, model });
  const res = await fetchWithTimeout(`${baseUrl}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }, EMBEDDER_TIMEOUT_MS);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`embedder ${res.status}: ${raw.slice(0, 300)}`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error(`embedder bad json: ${raw.slice(0, 200)}`);
  }
  const vec = parsed?.embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("embedder returned empty embedding");
  }
  return { embedding: vec, model: parsed?.model || model, dim: vec.length };
}

async function embedBatch({ baseUrl, model, inputs }) {
  // Use /embed/batch when more than one input — saves round-trips.
  if (inputs.length === 1) {
    const r = await embedOne({ baseUrl, model, text: inputs[0] });
    return [{ ok: true, embedding: r.embedding }];
  }
  const body = JSON.stringify({ inputs, model });
  const res = await fetchWithTimeout(`${baseUrl}/embed/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }, EMBEDDER_TIMEOUT_MS);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`embedder batch ${res.status}: ${raw.slice(0, 300)}`);
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("embedder batch returned non-array");
  }
  return parsed;
}

// ----- embedding cache -----
//
// Cache key = sha256(text). Values stored as base64 of Float32Array bytes to
// keep the file compact. The cache is best-effort; an unwritable cache must
// not block integrity, only the operator's review experience.

const CACHE_PATH = join(ROOT, "strata.embeddings.cache.json");

function vecToB64(vec) {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64");
}

function vecFromB64(b64) {
  const buf = Buffer.from(b64, "base64");
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

async function loadEmbeddingCache() {
  if (!await pathExists(CACHE_PATH)) return { dim: null, entries: {} };
  try {
    const raw = await readFile(CACHE_PATH, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || !obj.entries) {
      return { dim: null, entries: {} };
    }
    return obj;
  } catch {
    return { dim: null, entries: {} };
  }
}

async function saveEmbeddingCache(cache) {
  try {
    await writeFile(CACHE_PATH, JSON.stringify(cache), "utf8");
    return true;
  } catch {
    return false;
  }
}

// ----- math -----

function cosine(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ----- text utilities (claim sites + polarity) -----

const NEGATORS = [
  " not ", " no ", " never ", " cannot ", " can't ", " won't ",
  " isn't ", " aren't ", " doesn't ", " don't ", " shouldn't ",
  " wouldn't ", " hasn't ", " haven't ", " hadn't ", " without ",
];

function normalizeClaim(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function isNegativePolarity(s) {
  const padded = ` ${normalizeClaim(s)} `;
  return NEGATORS.some(n => padded.includes(n));
}

function stripNegators(s) {
  const padded = ` ${normalizeClaim(s)} `;
  const stripped = NEGATORS.reduce((acc, n) => acc.split(n).join(" "), padded);
  return stripped.replace(/\s+/g, " ").trim();
}

function jaccard(a, b) {
  const ta = new Set(stripNegators(a).split(" ").filter(Boolean));
  const tb = new Set(stripNegators(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

// Truncate to keep embedding cost predictable. Most embedders accept much
// more, but Graph Weaver doctrine batches short claim-sized payloads.
function truncForEmbed(s, n = 1200) {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  return t.length <= n ? t : t.slice(0, n);
}

// ----- canon + archive loaders -----

async function loadAllCanon({ excludeId = null } = {}) {
  const out = [];
  for (const dept of DEPARTMENTS) {
    const dir = join(ROOT, "canon", dept);
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = await readdir(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".canon.json")) continue;
      const p = join(dir, f);
      try {
        const row = JSON.parse(await readFile(p, "utf8"));
        if (row && row.id && row.id !== excludeId) out.push({ ...row, _path: p });
      } catch {
        // skip malformed; not our job to fix here
      }
    }
  }
  return out;
}

async function loadCanonById(id) {
  for (const dept of DEPARTMENTS) {
    const p = join(ROOT, "canon", dept, `${id}.canon.json`);
    if (await pathExists(p)) {
      const row = JSON.parse(await readFile(p, "utf8"));
      return { ...row, _path: p };
    }
  }
  return null;
}

async function loadCanonByPath(path) {
  const abs = resolve(path);
  const row = JSON.parse(await readFile(abs, "utf8"));
  return { ...row, _path: abs };
}

// Markdown artifacts in 19-ARCHIVE are durable read-only canon. We mine them
// for paragraph-level "archive claims" — heuristic, but anchored to bullets
// and short paragraphs (the shape Knowledge Strata artifacts emit).
async function loadArchiveClaims({ maxFiles = 400, maxPerFile = 24 } = {}) {
  if (!existsSync(ARCHIVE_DIR)) return [];
  const claims = [];
  const stack = [ARCHIVE_DIR];
  let filesSeen = 0;
  while (stack.length && filesSeen < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      if (!/\.(md|markdown|txt)$/i.test(e.name)) continue;
      filesSeen++;
      let raw;
      try { raw = await readFile(p, "utf8"); } catch { continue; }
      const localClaims = extractArchiveClaims(raw, maxPerFile);
      const rel = relative(ORANGE5_ROOT, p).replace(/\\/g, "/");
      for (const text of localClaims) {
        claims.push({
          archive_id: `archive:${rel}#${sha256(text).slice(0, 10)}`,
          text,
          source_path: p,
          source_rel: rel,
        });
      }
      if (filesSeen >= maxFiles) break;
    }
  }
  return claims;
}

function extractArchiveClaims(markdown, maxPerFile) {
  const out = [];
  // Bullet lines are the highest-signal claim sites.
  const bulletRe = /^\s*(?:[-*+]|\d+\.)\s+(.+)$/gm;
  let m;
  while ((m = bulletRe.exec(markdown)) && out.length < maxPerFile) {
    const t = m[1].trim();
    if (t.length >= 16 && t.length <= 420) out.push(t.replace(/`+/g, ""));
  }
  if (out.length >= maxPerFile) return out;
  // Short paragraphs (single-line factual statements).
  const paras = markdown.split(/\n\s*\n/);
  for (const p of paras) {
    if (out.length >= maxPerFile) break;
    const t = p.trim().replace(/\s+/g, " ");
    if (t.startsWith("#") || t.startsWith(">")) continue;
    if (t.length >= 40 && t.length <= 320) out.push(t.replace(/`+/g, ""));
  }
  return out;
}

// ----- claim site builder -----
//
// A "claim site" is the smallest checkable unit. For the new artifact we mine
// claim sites from canonRow.claims[].text and the title+summary. For prior
// canon rows we mine the same. For 19-ARCHIVE we mine paragraph/bullet sites.

function newRowClaimSites(canonRow) {
  const sites = [];
  const baseId = canonRow.id || "new";
  if (canonRow.title) {
    sites.push({
      site_id: `${baseId}#title`,
      text: canonRow.title,
      confidence: "high",
      kind: "title",
    });
  }
  if (canonRow.summary) {
    sites.push({
      site_id: `${baseId}#summary`,
      text: canonRow.summary,
      confidence: "high",
      kind: "summary",
    });
  }
  for (let i = 0; i < (canonRow.claims || []).length; i++) {
    const c = canonRow.claims[i];
    sites.push({
      site_id: `${baseId}#claim_${i}`,
      text: c.text,
      confidence: c.confidence || "low",
      kind: "claim",
    });
  }
  return sites;
}

function priorRowClaimSites(row) {
  const sites = [];
  const baseId = row.id;
  const tagSet = new Set((row.tags || []).map(t => String(t).toLowerCase()));
  const canonLocked = [...tagSet].some(t => CANON_LOCK_TAGS.has(t));
  const frontier = [...tagSet].some(t => FRONTIER_TAGS.has(t));
  const sharedMeta = {
    canon_id: row.id,
    canon_version: row.version,
    department: row.department,
    canon_locked: canonLocked,
    frontier,
  };
  for (let i = 0; i < (row.claims || []).length; i++) {
    const c = row.claims[i];
    sites.push({
      site_id: `${baseId}#claim_${i}`,
      text: c.text,
      confidence: c.confidence || "low",
      kind: "claim",
      ...sharedMeta,
    });
  }
  // Title and summary are also legitimate prior assertions worth checking.
  if (row.title) {
    sites.push({
      site_id: `${baseId}#title`,
      text: row.title,
      confidence: "high",
      kind: "title",
      ...sharedMeta,
    });
  }
  if (row.summary) {
    sites.push({
      site_id: `${baseId}#summary`,
      text: row.summary,
      confidence: "high",
      kind: "summary",
      ...sharedMeta,
    });
  }
  return sites;
}

function archiveClaimSites(claims) {
  return claims.map(c => ({
    site_id: c.archive_id,
    text: c.text,
    confidence: "medium",
    kind: "archive",
    archive_path: c.source_rel,
    canon_locked: true,   // archive is durable canon
    frontier: false,
  }));
}

// ----- embedding orchestration -----

async function embedSites({ sites, baseUrl, model, cache, useEmbedder }) {
  const out = new Map(); // site_id -> vector
  if (!useEmbedder) return { vectors: out, degraded: true, reason: "embedder_disabled" };

  const toEmbed = [];
  const toEmbedKeys = [];
  for (const s of sites) {
    const text = truncForEmbed(s.text);
    if (!text) continue;
    const key = sha256(text);
    if (cache.entries[key]) {
      out.set(s.site_id, vecFromB64(cache.entries[key]));
      continue;
    }
    toEmbed.push(text);
    toEmbedKeys.push({ site_id: s.site_id, key });
  }
  if (toEmbed.length === 0) {
    return { vectors: out, degraded: false, reason: null };
  }
  // Batch in chunks of 32 to stay friendly to the N150.
  const CHUNK = 32;
  for (let i = 0; i < toEmbed.length; i += CHUNK) {
    const inputs = toEmbed.slice(i, i + CHUNK);
    const meta = toEmbedKeys.slice(i, i + CHUNK);
    let results;
    try {
      results = await embedBatch({ baseUrl, model, inputs });
    } catch (e) {
      return { vectors: out, degraded: true, reason: `embed_failed:${e.message}` };
    }
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (!r || !r.ok || !Array.isArray(r.embedding)) continue;
      const { site_id, key } = meta[j];
      out.set(site_id, r.embedding);
      cache.entries[key] = vecToB64(r.embedding);
      if (cache.dim == null) cache.dim = r.embedding.length;
    }
  }
  return { vectors: out, degraded: false, reason: null };
}

// ----- contradiction analysis -----

function classifyPair({ newSite, priorSite, similarity, hardThreshold, dupThreshold }) {
  // Returns { kind: 'hard'|'soft'|'drift'|'none', reason, similarity }
  if (similarity >= dupThreshold && isNegativePolarity(newSite.text) === isNegativePolarity(priorSite.text)) {
    return { kind: "drift", reason: "near_duplicate_same_polarity", similarity };
  }
  if (similarity < (hardThreshold - 0.05)) {
    return { kind: "none", reason: "below_polarity_threshold", similarity };
  }
  const newNeg = isNegativePolarity(newSite.text);
  const oldNeg = isNegativePolarity(priorSite.text);
  if (newNeg === oldNeg) {
    return { kind: "none", reason: "same_polarity", similarity };
  }
  // Polarity flip. Severity depends on confidence and canon-lock.
  const newHigh = newSite.confidence === "high";
  const oldHigh = priorSite.confidence === "high";
  const canonLocked = priorSite.canon_locked === true;
  const frontier = priorSite.frontier === true;

  if (canonLocked || (newHigh && oldHigh && similarity >= hardThreshold)) {
    return { kind: "hard", reason: canonLocked ? "polarity_flip_vs_canon_lock" : "polarity_flip_high_conf_both", similarity };
  }
  if (frontier) {
    return { kind: "soft", reason: "polarity_flip_vs_frontier_row", similarity };
  }
  return { kind: "soft", reason: "polarity_flip_medium_low_conf", similarity };
}

// Lexical fallback when embedder is unreachable. Jaccard on stripped tokens
// gives a coarse "near-neighbor" signal; we run the same classifyPair logic
// on top of it, but every verdict is labeled degraded.
function lexicalSim(a, b) {
  return jaccard(a, b);
}

// ----- integrity pipeline -----

async function runIntegrity({ canonRow, flags }) {
  const startedAt = nowIso();
  const blockers = [];
  const evidence = {
    embedder: { url: null, used: false, degraded: false, reason: null },
    archive: { used: !flags["no-archive"], files_compared: 0, claims_compared: 0 },
    canon: { rows_compared: 0, claim_sites: 0 },
    thresholds: {
      near: Number(flags.threshold || DEFAULT_THRESHOLD),
      hard: Number(flags["hard-threshold"] || DEFAULT_HARD_THRESHOLD),
      dup: DEFAULT_DUP_THRESHOLD,
      topk: Number(flags.topk || DEFAULT_TOPK),
    },
  };

  // 1. Build new-row claim sites.
  const newSites = newRowClaimSites(canonRow);
  if (newSites.length === 0) {
    return {
      ok: false,
      blockers: ["no_claim_sites_in_new_row"],
      next_action: "fix_canon_row_has_no_title_or_claims",
      evidence,
    };
  }
  evidence.new_sites = newSites.length;

  // 2. Load prior canon + (optionally) archive.
  const priorCanon = await loadAllCanon({ excludeId: canonRow.id });
  let priorSites = [];
  for (const row of priorCanon) priorSites.push(...priorRowClaimSites(row));
  evidence.canon.rows_compared = priorCanon.length;
  evidence.canon.claim_sites = priorSites.length;

  let archiveClaimList = [];
  if (!flags["no-archive"]) {
    archiveClaimList = await loadArchiveClaims();
    const archSites = archiveClaimSites(archiveClaimList);
    priorSites.push(...archSites);
    evidence.archive.files_compared = new Set(archiveClaimList.map(c => c.source_rel)).size;
    evidence.archive.claims_compared = archiveClaimList.length;
  }

  // 3. Determine embedder posture.
  const baseUrl = String(flags.embedder || DEFAULT_EMBEDDER_URL).replace(/\/+$/, "");
  evidence.embedder.url = baseUrl;
  let useEmbedder = !flags["no-embed"];
  if (useEmbedder) {
    const probe = await probeEmbedder(baseUrl);
    if (!probe.ok) {
      useEmbedder = false;
      evidence.embedder.degraded = true;
      evidence.embedder.reason = probe.reason;
    }
  } else {
    evidence.embedder.degraded = true;
    evidence.embedder.reason = "no_embed_flag";
  }

  // 4. Embed both sides (with cache).
  const cache = await loadEmbeddingCache();
  const model = DEFAULT_EMBED_MODEL;
  let newVectors = new Map();
  let priorVectors = new Map();
  if (useEmbedder) {
    const newRes = await embedSites({ sites: newSites, baseUrl, model, cache, useEmbedder });
    if (newRes.degraded) {
      useEmbedder = false;
      evidence.embedder.degraded = true;
      evidence.embedder.reason = newRes.reason || "new_side_failed";
    } else {
      newVectors = newRes.vectors;
    }
  }
  if (useEmbedder) {
    const priorRes = await embedSites({ sites: priorSites, baseUrl, model, cache, useEmbedder });
    if (priorRes.degraded) {
      // Partial failure on prior side: degrade overall, but keep what we got.
      evidence.embedder.degraded = true;
      evidence.embedder.reason = priorRes.reason || "prior_side_partial_failure";
      priorVectors = priorRes.vectors;
    } else {
      priorVectors = priorRes.vectors;
    }
    evidence.embedder.used = true;
  }
  await saveEmbeddingCache(cache);

  // 5. Find top-K near neighbors per new site.
  const topK = evidence.thresholds.topk;
  const near = evidence.thresholds.near;
  const hard = evidence.thresholds.hard;
  const dup = evidence.thresholds.dup;

  const findings = {
    hard: [],
    soft: [],
    drift: [],
    nearest: [],   // top neighbor per new site, for transparency
  };

  for (const ns of newSites) {
    const nv = useEmbedder ? newVectors.get(ns.site_id) : null;
    const scored = [];
    for (const ps of priorSites) {
      let sim;
      if (useEmbedder) {
        const pv = priorVectors.get(ps.site_id);
        if (!pv || !nv) continue;
        sim = cosine(nv, pv);
      } else {
        sim = lexicalSim(ns.text, ps.text);
      }
      if (sim >= near || sim >= dup) {
        scored.push({ ps, sim });
      }
    }
    scored.sort((a, b) => b.sim - a.sim);
    const neighbors = scored.slice(0, topK);
    if (neighbors[0]) {
      findings.nearest.push({
        new_site: ns.site_id,
        new_text: ns.text,
        nearest_id: neighbors[0].ps.site_id,
        nearest_text: neighbors[0].ps.text,
        similarity: Number(neighbors[0].sim.toFixed(4)),
      });
    }
    for (const { ps, sim } of neighbors) {
      const verdict = classifyPair({
        newSite: ns,
        priorSite: ps,
        similarity: sim,
        hardThreshold: hard,
        dupThreshold: dup,
      });
      if (verdict.kind === "none") continue;
      const record = {
        new_site: ns.site_id,
        new_text: ns.text,
        new_confidence: ns.confidence,
        prior_site: ps.site_id,
        prior_text: ps.text,
        prior_confidence: ps.confidence,
        prior_canon_id: ps.canon_id || null,
        prior_department: ps.department || null,
        prior_archive_path: ps.archive_path || null,
        canon_locked: ps.canon_locked === true,
        frontier: ps.frontier === true,
        similarity: Number(sim.toFixed(4)),
        reason: verdict.reason,
        method: useEmbedder ? "cosine" : "jaccard_fallback",
      };
      if (verdict.kind === "hard") findings.hard.push(record);
      else if (verdict.kind === "soft") findings.soft.push(record);
      else if (verdict.kind === "drift") findings.drift.push(record);
    }
  }

  // 6. Decide.
  const hardCount = findings.hard.length;
  const softCount = findings.soft.length;
  const driftCount = findings.drift.length;
  if (hardCount > 0 && !flags.force) {
    blockers.push("contradicts_canon_hard");
  }
  if (evidence.embedder.degraded && !flags["no-embed"]) {
    // Honest about degradation. Not a blocker by itself; the caller can
    // re-run when the embedder is up. But the verdict carries the flag.
    blockers.push("integrity_degraded_embedder_unreachable");
  }

  const verdict = {
    canon_id: canonRow.id,
    department: canonRow.department,
    title: canonRow.title,
    started_at: startedAt,
    finished_at: nowIso(),
    ok: blockers.length === 0,
    hard_conflicts: hardCount,
    soft_conflicts: softCount,
    drift_signals: driftCount,
    blockers,
    findings,
    evidence,
    next_action:
      hardCount > 0
        ? (flags.force ? "operator_override_recorded_review_required" : "resolve_contradiction_or_pass_--force")
        : softCount > 0
          ? "review_soft_conflicts_then_ship"
          : driftCount > 0
            ? "deduplicate_or_supersede"
            : "promote_to_reuse",
  };

  // 7. Write the durable integrity record.
  await ensureDir(ROOT);
  if (!flags.quiet) {
    const logPath = join(ROOT, "strata.integrity.log.jsonl");
    await appendFile(logPath, JSON.stringify({
      ts: verdict.finished_at,
      canon_id: verdict.canon_id,
      ok: verdict.ok,
      hard: verdict.hard_conflicts,
      soft: verdict.soft_conflicts,
      drift: verdict.drift_signals,
      blockers: verdict.blockers,
      embedder: { used: evidence.embedder.used, degraded: evidence.embedder.degraded, reason: evidence.embedder.reason },
      force: !!flags.force,
    }) + "\n", "utf8");
    verdict.evidence.log_path = logPath;
  }

  // 8. If soft conflicts exist (and we know the canon path), write a sidecar
  //    next to the artifact so downstream readers see the open question.
  if (softCount > 0 && canonRow._path) {
    const sidecarPath = canonRow._path.replace(/\.canon\.json$/, ".soft-conflicts.json");
    try {
      await writeFile(sidecarPath, JSON.stringify({
        canon_id: canonRow.id,
        recorded_at: verdict.finished_at,
        soft_conflicts: findings.soft,
      }, null, 2), "utf8");
      verdict.evidence.soft_conflicts_sidecar = sidecarPath;
    } catch {
      // Sidecar is best-effort.
    }
  }

  return verdict;
}

// ----- sweep / verify -----

async function sweepAll(flags) {
  const rows = await loadAllCanon();
  const results = [];
  for (const row of rows) {
    const r = await runIntegrity({ canonRow: row, flags });
    results.push({ canon_id: row.id, ok: r.ok, hard: r.hard_conflicts, soft: r.soft_conflicts, drift: r.drift_signals });
  }
  const failed = results.filter(r => !r.ok);
  return {
    ok: failed.length === 0,
    checked: results.length,
    failed_count: failed.length,
    failed,
    results,
    next_action: failed.length === 0 ? "all_canon_integrity_clean" : "resolve_failed_rows",
  };
}

async function rebuildIndex(flags) {
  // Drop the cache and re-embed every prior site + every archive claim.
  const baseUrl = String(flags.embedder || DEFAULT_EMBEDDER_URL).replace(/\/+$/, "");
  const probe = await probeEmbedder(baseUrl);
  if (!probe.ok) {
    return {
      ok: false,
      blockers: ["embedder_unreachable"],
      evidence: { url: baseUrl, reason: probe.reason },
      next_action: "start_n150_embedder_then_retry",
    };
  }
  const cache = { dim: null, entries: {} };
  await saveEmbeddingCache(cache);

  const priorCanon = await loadAllCanon();
  const sites = [];
  for (const row of priorCanon) sites.push(...priorRowClaimSites(row));
  if (!flags["no-archive"]) {
    const archive = await loadArchiveClaims();
    sites.push(...archiveClaimSites(archive));
  }
  const { degraded, reason } = await embedSites({
    sites, baseUrl, model: DEFAULT_EMBED_MODEL, cache, useEmbedder: true,
  });
  await saveEmbeddingCache(cache);
  return {
    ok: !degraded,
    blockers: degraded ? ["embedder_failed_during_rebuild"] : [],
    evidence: {
      url: baseUrl,
      sites_embedded: Object.keys(cache.entries).length,
      degraded,
      reason,
      cache_path: CACHE_PATH,
    },
    next_action: degraded ? "investigate_embedder_then_retry" : "cache_warm_ready_for_integrity_runs",
  };
}

// ----- main -----

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function printPretty(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(argv);
  const flags = args.flags;
  const emit = flags.json ? printJson : printPretty;

  if (flags["rebuild-index"]) {
    const out = await rebuildIndex(flags);
    emit({ result: out.ok ? "rebuilt" : "rebuild_failed", ...out });
    if (!out.ok) exit(1);
    return;
  }

  if (flags.sweep || flags.verify) {
    const out = await sweepAll(flags);
    emit({ result: out.ok ? "integrity_ok_full_sweep" : "integrity_fail_full_sweep", ...out });
    if (!out.ok) exit(1);
    return;
  }

  // Single-row mode: --id, positional canon path, or --markdown path.
  let canonRow = null;
  if (typeof flags.id === "string") {
    canonRow = await loadCanonById(flags.id);
    if (!canonRow) {
      emit({ result: "not_found", blockers: ["canon_id_not_found"], next_action: "list_canon", id: flags.id });
      exit(2);
    }
  } else if (typeof flags.markdown === "string") {
    // For markdown-only input we synthesize a thin canon row so the integrity
    // pass can still vector-check it. The synthetic row is NEVER written to
    // the canon store — it exists only inside this run.
    const md = await readFile(resolve(flags.markdown), "utf8");
    const title = (md.match(/^#\s+(.+)$/m)?.[1] || basename(flags.markdown, extname(flags.markdown))).trim();
    canonRow = {
      id: `ephemeral_${sha256(md).slice(0, 10)}`,
      department: DEPARTMENTS.includes(String(flags.dept || "").toUpperCase()) ? String(flags.dept).toUpperCase() : "AE0",
      title,
      summary: md.replace(/\s+/g, " ").trim().slice(0, 280),
      claims: extractArchiveClaims(md, 32).map(t => ({ text: t, confidence: "medium", supports: [] })),
      tags: ["ephemeral", "markdown-only"],
    };
  } else {
    const target = args._[0];
    if (!target) {
      process.stderr.write([
        "usage:",
        "  node integrity.mjs <canon-path>",
        "  node integrity.mjs --id <canon-id>",
        "  node integrity.mjs --markdown <artifact.md>",
        "  node integrity.mjs --sweep",
        "  node integrity.mjs --rebuild-index",
        "  node integrity.mjs --verify",
        "",
        "flags: --embedder <url> --topk <n> --threshold <f> --hard-threshold <f>",
        "       --no-archive --no-embed --json --quiet --force",
        "",
      ].join("\n"));
      exit(2);
    }
    canonRow = await loadCanonByPath(target);
  }

  const verdict = await runIntegrity({ canonRow, flags });
  emit({
    result: verdict.ok ? "integrity_pass" : "integrity_blocked",
    ...verdict,
  });
  if (!verdict.ok) exit(1);
}

main().catch(err => {
  process.stderr.write(JSON.stringify({
    result: "fatal",
    error: err?.message || String(err),
    stack: err?.stack,
  }) + "\n");
  exit(1);
});
