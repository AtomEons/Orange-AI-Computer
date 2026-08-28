// AE OrangeLLM — Knowledge Strata routes
// Path: 06-ORANGELLM/server/routes/strata.mjs
//
// Doctrine (AtomEons canon, .claude/CLAUDE.md):
//
//   "Knowledge Strata is a compiler loop: intake -> canon -> durable artifact
//    -> integrity pass -> reuse."
//
// This file implements that loop as five gated stages, each with its own
// endpoint. Each stage is a real step with a real check, not theater:
//
//   1. POST /v1/strata/intake     -- raw input (notes, transcripts, receipts)
//                                    is admitted, hashed, and parked in a
//                                    durable inbox file. Idempotent by
//                                    content hash. No canonization yet.
//
//   2. POST /v1/strata/canonize   -- an intake row is canonized: classified
//                                    against the doctrine vocabulary,
//                                    normalized (trim, NFC), and assigned a
//                                    canon_id. Doctrine vocab is loaded from
//                                    .claude/rules + CLAUDE.md prefixes if
//                                    present; otherwise the embedded
//                                    minimum is used. Rejects intake rows
//                                    that contradict prior canon (see emit
//                                    gate also re-checks).
//
//   3. POST /v1/strata/emit       -- one or more canonized rows are emitted
//                                    as a durable artifact: a versioned
//                                    Markdown file PLUS a sidecar JSON
//                                    descriptor under <stratumDir>/artifacts/.
//                                    Each artifact carries SHA-256, parents,
//                                    and the doctrine bucket it belongs to.
//
//   4. POST /v1/strata/query      -- search canon/artifacts by free-text
//                                    query, bucket, or time range. This is
//                                    the "reuse" surface: future receipts
//                                    cite by artifact_id returned here.
//
//   5. POST /v1/strata/resolve    -- given an artifact_id (or list), return
//                                    the full artifact body + integrity
//                                    receipt (hash re-check, parent chain
//                                    walk, contradiction scan). This is the
//                                    integrity pass that gates reuse.
//
//   GET  /v1/strata/healthz       -- liveness + counts + last-emit time.
//
// Storage layout (file-backed; no extra deps):
//
//   <stratumDir>/
//     inbox/<sha256>.json                -- raw intake (write-once)
//     canon/<canon_id>.json              -- canonized rows
//     artifacts/<artifact_id>.md         -- durable artifact body
//     artifacts/<artifact_id>.json       -- sidecar descriptor + integrity
//     index/strata-index.jsonl           -- append-only event log
//     index/contradictions.jsonl         -- append-only contradiction log
//     meta.json                          -- counts + last_emit_ts
//
// Boundary: paths added to strata-boundary.mjs and folded into the main
// gateway allow-list before exposure.
//
// Exports:
//   registerStrataRoutes(server, opts)
//     - server : node:http Server
//     - opts   : { stratumDir?: string, doctrineDir?: string,
//                  doctrineVocab?: string[], log?: (line) => void }
//
//   __strataHandlers : the underlying pure-ish handlers (intake / canonize /
//   emit / query / resolve / healthz) for direct wiring or tests.

import { URL } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Defaults + constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB cap for intake payloads
const MAX_TEXT_BYTES = 512 * 1024;      // 512 KiB cap for a single text blob
const ARTIFACT_VERSION = 1;
const SCHEMA_VERSION = "strata.v1";

// Doctrine bucket vocabulary — the minimum canon. If the operator's
// .claude/rules/*.md files surface additional bucket headers, they are merged
// in on load (see loadDoctrineVocab).
const DEFAULT_DOCTRINE_VOCAB = Object.freeze([
  "pathwaves",
  "life-migration",
  "neon",
  "knowledge-strata",
  "misfit-frontier",
  "relax-zen",
  "create",
  "learn",
  "release-law",
  "completion-law",
  "moms-law",
  "teams-and-authority",
  "product-and-room-doctrine",
  "build-and-receipts",
  "game-dev-doctrine",
  "core",
  "uncategorized",
]);

const ALLOWED_INTAKE_KINDS = new Set([
  "note",
  "transcript",
  "receipt",
  "decision",
  "observation",
  "artifact-draft",
]);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function sha256OfBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function nfc(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFC");
}

function shortId(prefix, hex, len = 12) {
  return `${prefix}_${hex.slice(0, len)}`;
}

function jsonResponse(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorResponse(res, message, status = 400, code = "invalid_request_error") {
  jsonResponse(
    res,
    { error: { message, type: code, code: status } },
    status,
  );
}

async function readJsonBody(req, capBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", chunk => {
      total += chunk.length;
      if (total > capBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try { resolve(JSON.parse(buf.toString("utf8"))); }
      catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function atomicWrite(filePath, contents) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, contents, "utf8");
  await fs.rename(tmp, filePath);
}

async function appendJsonl(file, obj) {
  // node:fs.promises.appendFile is OS-level append; sufficient for an
  // event log written by a single Node 20 process.
  await fs.appendFile(file, JSON.stringify(obj) + "\n", "utf8");
}

async function readJsonFile(file) {
  try {
    const buf = await fs.readFile(file, "utf8");
    return JSON.parse(buf);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function listDir(dir, extFilter = null) {
  try {
    const entries = await fs.readdir(dir);
    if (!extFilter) return entries;
    return entries.filter(e => e.endsWith(extFilter));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function resolveDefaultStratumDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // server/routes/strata.mjs -> server/routes -> server -> 06-ORANGELLM
  return path.resolve(here, "..", "..", "memory", "strata");
}

function resolveDefaultDoctrineDir() {
  // Best-effort: walk up looking for a .claude/rules sibling of an
  // AtomEons repo root. Not fatal if missing; falls back to defaults.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..", ".claude", "rules");
}

// ---------------------------------------------------------------------------
// Doctrine vocabulary loader
// ---------------------------------------------------------------------------

async function loadDoctrineVocab(doctrineDir) {
  const vocab = new Set(DEFAULT_DOCTRINE_VOCAB);
  if (!doctrineDir) return Array.from(vocab);
  try {
    const files = await listDir(doctrineDir, ".md");
    for (const f of files) {
      // Strip leading digits + dash, drop .md, lowercase.
      // 00-moms-law.md -> moms-law
      const bucket = f
        .replace(/\.md$/i, "")
        .replace(/^[0-9]+[-_]?/, "")
        .toLowerCase()
        .trim();
      if (bucket) vocab.add(bucket);
    }
  } catch {
    // Doctrine dir missing is acceptable; we have defaults.
  }
  return Array.from(vocab);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyToBucket(text, vocab) {
  // Deterministic classifier:
  //   1. Verbatim bucket-name phrase match (whole-word, case-insensitive)
  //      scores HEAVY (10 per hit) — operator-named primitives win.
  //   2. Per-token whole-word match scores light (1 per hit, capped at 8).
  //   3. Ties broken by vocab order (so the canon listing it earlier wins).
  // No hits -> "uncategorized".
  if (!text || typeof text !== "string") return "uncategorized";
  const hay = text.toLowerCase();
  let best = { bucket: "uncategorized", score: 0, order: Infinity };
  vocab.forEach((b, idx) => {
    if (b === "uncategorized") return;
    let score = 0;
    // 1. Verbatim phrase ("life-migration" or "life migration") — exclusive.
    //    If the full bucket name appears verbatim, score it and SKIP token
    //    scoring (avoids double-counting that lets multi-word buckets
    //    drown single-word primitives).
    const phrases = [b, b.replace(/[-_]/g, " "), b.replace(/[-_]/g, "")];
    let phraseHit = false;
    for (const phrase of phrases) {
      if (phrase.length < 3) continue;
      const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "gi");
      const hits = (hay.match(re) || []).length;
      if (hits) { score += 10 * hits; phraseHit = true; break; }
    }
    if (!phraseHit) {
      // 2. Token-level whole-word hits — only if the phrase missed.
      const tokens = b.split(/[-_]/).filter(t => t.length >= 4);
      for (const t of tokens) {
        const re = new RegExp(`\\b${escapeRegex(t)}\\b`, "gi");
        const hits = Math.min((hay.match(re) || []).length, 8);
        score += hits;
      }
    }
    if (score > best.score || (score === best.score && idx < best.order)) {
      best = { bucket: b, score, order: idx };
    }
  });
  return best.score > 0 ? best.bucket : "uncategorized";
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function dirsFor(stratumDir) {
  return {
    root: stratumDir,
    inbox: path.join(stratumDir, "inbox"),
    canon: path.join(stratumDir, "canon"),
    artifacts: path.join(stratumDir, "artifacts"),
    index: path.join(stratumDir, "index"),
    indexLog: path.join(stratumDir, "index", "strata-index.jsonl"),
    contradictionsLog: path.join(stratumDir, "index", "contradictions.jsonl"),
    meta: path.join(stratumDir, "meta.json"),
  };
}

async function ensureLayout(stratumDir) {
  const d = dirsFor(stratumDir);
  await Promise.all([
    ensureDir(d.inbox),
    ensureDir(d.canon),
    ensureDir(d.artifacts),
    ensureDir(d.index),
  ]);
  const meta = await readJsonFile(d.meta);
  if (!meta) {
    await atomicWrite(d.meta, JSON.stringify({
      schema: SCHEMA_VERSION,
      created_at: nowIso(),
      last_emit_at: null,
      counts: { intake: 0, canon: 0, artifacts: 0, contradictions: 0 },
    }, null, 2));
  }
}

async function bumpMeta(stratumDir, mutator) {
  const d = dirsFor(stratumDir);
  const meta = (await readJsonFile(d.meta)) || {
    schema: SCHEMA_VERSION,
    created_at: nowIso(),
    last_emit_at: null,
    counts: { intake: 0, canon: 0, artifacts: 0, contradictions: 0 },
  };
  mutator(meta);
  await atomicWrite(d.meta, JSON.stringify(meta, null, 2));
  return meta;
}

// ---------------------------------------------------------------------------
// Stage 1 — intake
// ---------------------------------------------------------------------------

function normalizeIntakeBody(body) {
  const src = body && typeof body === "object" ? body : {};
  const text = nfc(typeof src.text === "string" ? src.text : "").trim();
  const kind = typeof src.kind === "string" && ALLOWED_INTAKE_KINDS.has(src.kind)
    ? src.kind
    : "note";
  const source = typeof src.source === "string"
    ? src.source.slice(0, 256).trim()
    : "operator";
  const tags = Array.isArray(src.tags)
    ? src.tags
        .filter(t => typeof t === "string")
        .map(t => t.toLowerCase().trim())
        .filter(Boolean)
        .slice(0, 32)
    : [];
  const metadata = src.metadata && typeof src.metadata === "object"
    ? src.metadata
    : {};
  return { text, kind, source, tags, metadata };
}

async function handleIntake(rawBody, cfg) {
  const norm = normalizeIntakeBody(rawBody);
  if (!norm.text) {
    return { status: 400, body: { error: {
      message: "intake requires non-empty {text}",
      type: "invalid_request_error", code: 400,
    } } };
  }
  if (Buffer.byteLength(norm.text, "utf8") > MAX_TEXT_BYTES) {
    return { status: 413, body: { error: {
      message: `intake text exceeds cap (${MAX_TEXT_BYTES} bytes)`,
      type: "payload_too_large", code: 413,
    } } };
  }

  const hash = sha256Hex(norm.text);
  const intakeId = shortId("in", hash);
  const d = dirsFor(cfg.stratumDir);
  const file = path.join(d.inbox, `${hash}.json`);

  // Idempotent by content hash. If the file exists, return existing row.
  const existing = await readJsonFile(file);
  if (existing) {
    return {
      status: 200,
      body: {
        intake_id: existing.intake_id,
        hash,
        kind: existing.kind,
        idempotent_hit: true,
        received_at: existing.received_at,
        bytes: Buffer.byteLength(existing.text, "utf8"),
      },
    };
  }

  const row = {
    schema: SCHEMA_VERSION,
    intake_id: intakeId,
    hash,
    kind: norm.kind,
    source: norm.source,
    tags: norm.tags,
    metadata: norm.metadata,
    text: norm.text,
    received_at: nowIso(),
    canonized: false,
  };

  await atomicWrite(file, JSON.stringify(row, null, 2));
  await appendJsonl(d.indexLog, {
    stage: "intake", intake_id: intakeId, hash, kind: norm.kind, ts: row.received_at,
  });
  await bumpMeta(cfg.stratumDir, m => { m.counts.intake = (m.counts.intake || 0) + 1; });

  return {
    status: 201,
    body: {
      intake_id: intakeId,
      hash,
      kind: norm.kind,
      idempotent_hit: false,
      received_at: row.received_at,
      bytes: Buffer.byteLength(norm.text, "utf8"),
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — canonize
// ---------------------------------------------------------------------------
//
// A canon row references an intake row, picks a doctrine bucket, normalizes
// the body, and records a brief integrity statement. We do NOT emit a public
// artifact yet — that is stage 3.

async function findIntakeByRef(stratumDir, ref) {
  const d = dirsFor(stratumDir);
  // ref may be a hash, an intake_id ("in_<12hex>"), or a filename.
  if (!ref || typeof ref !== "string") return null;
  const candidate = ref.startsWith("in_") ? ref.slice(3) : ref;
  // Try direct hash match first.
  if (/^[0-9a-f]{64}$/i.test(ref)) {
    const file = path.join(d.inbox, `${ref}.json`);
    return readJsonFile(file);
  }
  // Otherwise scan inbox (cheap — file count bounded by operator throughput).
  const files = await listDir(d.inbox, ".json");
  for (const f of files) {
    const row = await readJsonFile(path.join(d.inbox, f));
    if (!row) continue;
    if (row.intake_id === ref || row.hash === ref ||
        row.hash.startsWith(candidate)) {
      return row;
    }
  }
  return null;
}

async function loadAllCanon(stratumDir) {
  const d = dirsFor(stratumDir);
  const files = await listDir(d.canon, ".json");
  const out = [];
  for (const f of files) {
    const row = await readJsonFile(path.join(d.canon, f));
    if (row) out.push(row);
  }
  return out;
}

// Contradiction detection: two canon rows are flagged as contradictory if
// they share a bucket AND share at least one "subject token" AND one says
// "is X" while another says "is not X" (or "never X"). This is a deliberate
// floor — it catches the most common operator slip ("Pathwaves IS X" later
// "Pathwaves is NOT X") without trying to be a SAT solver.
function extractSubjects(text) {
  // Cheap noun-phrase-ish extractor: lowercased tokens of length >= 4,
  // de-duped, capped at 16.
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 4);
  return Array.from(new Set(tokens)).slice(0, 16);
}

// Polarity helpers. Negative patterns are checked first; if any negative
// marker fires, that text is "negative polarity" and the positive scan is
// suppressed (so "is not" doesn't also count as "is").
const NEG_RE = /\b(is\s+not|isn['’]t|are\s+not|aren['’]t|never|must\s+not|mustn['’]t|do\s+not|don['’]t|cannot|can['’]t|won['’]t|should\s+not|shouldn['’]t)\b/i;
const POS_RE = /\b(is|are|must|should|always|will|shall)\b/i;

function polarity(text) {
  if (NEG_RE.test(text)) return "neg";
  if (POS_RE.test(text)) return "pos";
  return "neutral";
}

function findContradiction(candidate, priorCanon) {
  const aPol = polarity(candidate.text);
  if (aPol === "neutral") return null;
  const aSubs = new Set(extractSubjects(candidate.text));
  for (const c of priorCanon) {
    if (c.bucket !== candidate.bucket) continue;
    if (c.canon_id === candidate.canon_id) continue;
    const bPol = polarity(c.text);
    if (bPol === "neutral") continue;
    if (aPol === bPol) continue; // same polarity ≠ contradiction
    const bSubs = extractSubjects(c.text);
    const shared = bSubs.filter(t => aSubs.has(t));
    if (shared.length >= 2) {
      return { against: c.canon_id, shared_subjects: shared.slice(0, 8) };
    }
  }
  return null;
}

async function handleCanonize(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" ? rawBody : {};
  const ref = src.intake_id || src.hash || src.ref;
  if (!ref) {
    return { status: 400, body: { error: {
      message: "canonize requires {intake_id} or {hash}",
      type: "invalid_request_error", code: 400,
    } } };
  }
  const intake = await findIntakeByRef(cfg.stratumDir, ref);
  if (!intake) {
    return { status: 404, body: { error: {
      message: `intake not found: ${ref}`,
      type: "not_found", code: 404,
    } } };
  }

  const text = nfc(intake.text).trim();
  const vocab = await cfg.vocabPromise;
  const requestedBucket = typeof src.bucket === "string"
    ? src.bucket.toLowerCase().trim()
    : null;
  const bucket = requestedBucket && vocab.includes(requestedBucket)
    ? requestedBucket
    : classifyToBucket(text, vocab);

  const canonHash = sha256Hex(`${bucket}\n${text}`);
  const canonId = shortId("cn", canonHash);
  const d = dirsFor(cfg.stratumDir);

  // Idempotent — same (bucket,text) maps to same canon_id.
  const canonFile = path.join(d.canon, `${canonId}.json`);
  const existing = await readJsonFile(canonFile);
  if (existing) {
    return {
      status: 200,
      body: {
        canon_id: existing.canon_id,
        bucket: existing.bucket,
        hash: existing.hash,
        intake_id: existing.intake_id,
        idempotent_hit: true,
        contradiction: existing.contradiction || null,
      },
    };
  }

  // Contradiction check against prior canon in same bucket.
  const prior = await loadAllCanon(cfg.stratumDir);
  const candidate = {
    canon_id: canonId,
    bucket,
    text,
  };
  const contradiction = findContradiction(candidate, prior);

  const row = {
    schema: SCHEMA_VERSION,
    canon_id: canonId,
    intake_id: intake.intake_id,
    intake_hash: intake.hash,
    hash: canonHash,
    bucket,
    text,
    tags: intake.tags || [],
    source: intake.source || "operator",
    kind: intake.kind || "note",
    canonized_at: nowIso(),
    contradiction,
  };

  await atomicWrite(canonFile, JSON.stringify(row, null, 2));
  await appendJsonl(d.indexLog, {
    stage: "canonize", canon_id: canonId, bucket, intake_id: intake.intake_id,
    contradiction: !!contradiction, ts: row.canonized_at,
  });
  if (contradiction) {
    await appendJsonl(d.contradictionsLog, {
      ts: row.canonized_at, canon_id: canonId, against: contradiction.against,
      bucket, shared_subjects: contradiction.shared_subjects,
    });
    await bumpMeta(cfg.stratumDir, m => {
      m.counts.canon = (m.counts.canon || 0) + 1;
      m.counts.contradictions = (m.counts.contradictions || 0) + 1;
    });
  } else {
    await bumpMeta(cfg.stratumDir, m => { m.counts.canon = (m.counts.canon || 0) + 1; });
  }

  // Mark the intake row as canonized (best-effort update).
  try {
    intake.canonized = true;
    intake.canon_id = canonId;
    await atomicWrite(
      path.join(d.inbox, `${intake.hash}.json`),
      JSON.stringify(intake, null, 2),
    );
  } catch { /* non-fatal */ }

  return {
    status: 201,
    body: {
      canon_id: canonId,
      bucket,
      hash: canonHash,
      intake_id: intake.intake_id,
      idempotent_hit: false,
      contradiction,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — emit (durable artifact)
// ---------------------------------------------------------------------------

function buildArtifactMarkdown({ artifactId, title, bucket, body, canonIds,
                                 generatedAt, parents }) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> Artifact: \`${artifactId}\`  `);
  lines.push(`> Bucket: \`${bucket}\`  `);
  lines.push(`> Generated: ${generatedAt}  `);
  lines.push(`> Schema: \`${SCHEMA_VERSION}\` v${ARTIFACT_VERSION}`);
  lines.push("");
  if (parents && parents.length) {
    lines.push(`Parents: ${parents.map(p => `\`${p}\``).join(", ")}`);
    lines.push("");
  }
  lines.push("## Body");
  lines.push("");
  lines.push(body.trim());
  lines.push("");
  if (canonIds && canonIds.length) {
    lines.push("## Canon sources");
    lines.push("");
    for (const id of canonIds) lines.push(`- \`${id}\``);
    lines.push("");
  }
  return lines.join("\n");
}

async function handleEmit(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" ? rawBody : {};
  const canonIds = Array.isArray(src.canon_ids)
    ? src.canon_ids.filter(s => typeof s === "string" && s.startsWith("cn_"))
    : [];
  if (!canonIds.length) {
    return { status: 400, body: { error: {
      message: "emit requires {canon_ids: string[]} with at least one cn_* id",
      type: "invalid_request_error", code: 400,
    } } };
  }
  const title = nfc(typeof src.title === "string" ? src.title : "").trim();
  if (!title || title.length > 256) {
    return { status: 400, body: { error: {
      message: "emit requires {title} (1..256 chars)",
      type: "invalid_request_error", code: 400,
    } } };
  }
  const parents = Array.isArray(src.parents)
    ? src.parents.filter(s => typeof s === "string" && s.startsWith("art_")).slice(0, 16)
    : [];

  const d = dirsFor(cfg.stratumDir);
  // Resolve canon rows.
  const rows = [];
  for (const id of canonIds) {
    const row = await readJsonFile(path.join(d.canon, `${id}.json`));
    if (!row) {
      return { status: 404, body: { error: {
        message: `canon row not found: ${id}`,
        type: "not_found", code: 404,
      } } };
    }
    rows.push(row);
  }

  // Integrity gate: refuse to emit if ANY referenced canon row carries an
  // unresolved contradiction flag. Operator must reconcile before the
  // doctrine is permitted to harden into a durable artifact.
  const unresolved = rows.filter(r => r.contradiction);
  if (unresolved.length && !src.allow_contradictions) {
    return {
      status: 409,
      body: {
        error: {
          message: `cannot emit: ${unresolved.length} canon row(s) carry unresolved contradictions`,
          type: "integrity_violation",
          code: 409,
        },
        contradictions: unresolved.map(r => ({
          canon_id: r.canon_id,
          bucket: r.bucket,
          against: r.contradiction.against,
          shared_subjects: r.contradiction.shared_subjects,
        })),
        hint:
          "Reconcile prior canon (or pass {allow_contradictions: true} to override; the override is logged).",
      },
    };
  }

  // Single-bucket artifacts are the norm; mixed buckets are allowed but
  // labeled "mixed".
  const buckets = Array.from(new Set(rows.map(r => r.bucket)));
  const bucket = buckets.length === 1 ? buckets[0] : "mixed";

  // Compose body: by default concatenate canon texts. Caller may override
  // with {body} (NFC normalized).
  let body;
  if (typeof src.body === "string" && src.body.trim()) {
    body = nfc(src.body).trim();
  } else {
    body = rows.map(r => `### ${r.canon_id}\n\n${r.text}`).join("\n\n");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_TEXT_BYTES) {
    return { status: 413, body: { error: {
      message: `artifact body exceeds cap (${MAX_TEXT_BYTES} bytes)`,
      type: "payload_too_large", code: 413,
    } } };
  }

  const artifactHash = sha256Hex(`${bucket}\n${title}\n${body}\n${canonIds.join(",")}`);
  const artifactId = shortId("art", artifactHash, 16);
  const generatedAt = nowIso();

  const md = buildArtifactMarkdown({
    artifactId, title, bucket, body, canonIds,
    generatedAt, parents,
  });
  const bodyHash = sha256OfBuffer(Buffer.from(md, "utf8"));

  const descriptor = {
    schema: SCHEMA_VERSION,
    artifact_id: artifactId,
    version: ARTIFACT_VERSION,
    title,
    bucket,
    canon_ids: canonIds,
    parents,
    generated_at: generatedAt,
    body_hash_sha256: bodyHash,
    body_path: `artifacts/${artifactId}.md`,
    bytes: Buffer.byteLength(md, "utf8"),
    integrity: {
      contradictions_overridden: !!src.allow_contradictions && unresolved.length > 0,
      overridden_count: src.allow_contradictions ? unresolved.length : 0,
    },
  };

  const mdPath = path.join(d.artifacts, `${artifactId}.md`);
  const jsonPath = path.join(d.artifacts, `${artifactId}.json`);
  // Refuse to overwrite an existing artifact at the same id — content hash
  // collisions are vanishingly rare; this is an idempotency guard.
  const existed = await readJsonFile(jsonPath);
  if (existed) {
    return {
      status: 200,
      body: {
        artifact_id: existed.artifact_id,
        bucket: existed.bucket,
        body_hash_sha256: existed.body_hash_sha256,
        idempotent_hit: true,
        body_path: existed.body_path,
      },
    };
  }
  await atomicWrite(mdPath, md);
  await atomicWrite(jsonPath, JSON.stringify(descriptor, null, 2));
  await appendJsonl(d.indexLog, {
    stage: "emit", artifact_id: artifactId, bucket, canon_ids: canonIds,
    parents, hash: bodyHash, ts: generatedAt,
  });
  await bumpMeta(cfg.stratumDir, m => {
    m.counts.artifacts = (m.counts.artifacts || 0) + 1;
    m.last_emit_at = generatedAt;
  });

  return {
    status: 201,
    body: {
      artifact_id: artifactId,
      bucket,
      title,
      body_hash_sha256: bodyHash,
      body_path: `artifacts/${artifactId}.md`,
      bytes: descriptor.bytes,
      canon_ids: canonIds,
      parents,
      generated_at: generatedAt,
      idempotent_hit: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 4 — query (reuse surface)
// ---------------------------------------------------------------------------

async function loadAllArtifacts(stratumDir) {
  const d = dirsFor(stratumDir);
  const files = await listDir(d.artifacts, ".json");
  const out = [];
  for (const f of files) {
    const row = await readJsonFile(path.join(d.artifacts, f));
    if (row) out.push(row);
  }
  return out;
}

function scoreArtifact(art, q) {
  if (!q) return 1; // browsing
  const needle = q.toLowerCase();
  let score = 0;
  if (art.title && art.title.toLowerCase().includes(needle)) score += 5;
  if (art.bucket && art.bucket.toLowerCase().includes(needle)) score += 3;
  if (Array.isArray(art.canon_ids) &&
      art.canon_ids.some(id => id.toLowerCase().includes(needle))) score += 2;
  return score;
}

async function handleQuery(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" ? rawBody : {};
  const q = typeof src.q === "string" ? src.q.trim().slice(0, 512) : "";
  const bucket = typeof src.bucket === "string"
    ? src.bucket.toLowerCase().trim()
    : null;
  const sinceMs = Number.isFinite(src.since_ms) ? Math.floor(src.since_ms) : null;
  const limit = Number.isFinite(src.limit)
    ? Math.max(1, Math.min(200, Math.floor(src.limit)))
    : 25;

  const all = await loadAllArtifacts(cfg.stratumDir);
  const now = Date.now();
  const filtered = all.filter(a => {
    if (bucket && a.bucket !== bucket) return false;
    if (sinceMs != null) {
      const t = Date.parse(a.generated_at);
      if (!Number.isFinite(t) || now - t > sinceMs) return false;
    }
    if (q) return scoreArtifact(a, q) > 0;
    return true;
  });

  const ranked = filtered
    .map(a => ({ a, s: scoreArtifact(a, q) }))
    .sort((x, y) => y.s - x.s || y.a.generated_at.localeCompare(x.a.generated_at))
    .slice(0, limit)
    .map(({ a, s }) => ({
      artifact_id: a.artifact_id,
      title: a.title,
      bucket: a.bucket,
      generated_at: a.generated_at,
      body_hash_sha256: a.body_hash_sha256,
      bytes: a.bytes,
      canon_ids: a.canon_ids,
      parents: a.parents || [],
      score: s,
    }));

  return {
    status: 200,
    body: {
      query: { q, bucket, since_ms: sinceMs, limit },
      total_matched: filtered.length,
      returned: ranked.length,
      results: ranked,
      generated_at: nowIso(),
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 5 — resolve (integrity pass before reuse)
// ---------------------------------------------------------------------------

async function resolveOne(stratumDir, artifactId) {
  const d = dirsFor(stratumDir);
  const desc = await readJsonFile(path.join(d.artifacts, `${artifactId}.json`));
  if (!desc) return { found: false, artifact_id: artifactId };

  let bodyText = null;
  let actualHash = null;
  let hashMatches = false;
  try {
    const buf = await fs.readFile(path.join(d.artifacts, `${artifactId}.md`), "utf8");
    bodyText = buf;
    actualHash = sha256OfBuffer(Buffer.from(buf, "utf8"));
    hashMatches = actualHash === desc.body_hash_sha256;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  // Walk parent chain (depth-limited).
  const parentChain = [];
  const seen = new Set([artifactId]);
  let frontier = Array.isArray(desc.parents) ? desc.parents.slice() : [];
  let depth = 0;
  while (frontier.length && depth < 16) {
    const next = [];
    for (const pid of frontier) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = await readJsonFile(path.join(d.artifacts, `${pid}.json`));
      if (p) {
        parentChain.push({
          artifact_id: p.artifact_id, title: p.title, bucket: p.bucket,
          generated_at: p.generated_at,
        });
        if (Array.isArray(p.parents)) next.push(...p.parents);
      } else {
        parentChain.push({ artifact_id: pid, missing: true });
      }
    }
    frontier = next;
    depth += 1;
  }

  // Re-scan referenced canon rows for late-arriving contradictions.
  const canon = [];
  let lateContradictions = 0;
  for (const cid of (desc.canon_ids || [])) {
    const c = await readJsonFile(path.join(d.canon, `${cid}.json`));
    if (c) {
      canon.push({
        canon_id: c.canon_id,
        bucket: c.bucket,
        contradiction: c.contradiction || null,
      });
      if (c.contradiction) lateContradictions += 1;
    } else {
      canon.push({ canon_id: cid, missing: true });
    }
  }

  return {
    found: true,
    artifact_id: artifactId,
    descriptor: desc,
    body: bodyText,
    integrity: {
      hash_matches: hashMatches,
      declared_hash: desc.body_hash_sha256,
      actual_hash: actualHash,
      parent_chain: parentChain,
      canon_summary: canon,
      late_contradictions: lateContradictions,
      reuse_ok: hashMatches && lateContradictions === 0,
      checked_at: nowIso(),
    },
  };
}

async function handleResolve(rawBody, cfg) {
  const src = rawBody && typeof rawBody === "object" ? rawBody : {};
  const ids = Array.isArray(src.artifact_ids)
    ? src.artifact_ids.filter(s => typeof s === "string" && s.startsWith("art_"))
    : (typeof src.artifact_id === "string" && src.artifact_id.startsWith("art_")
        ? [src.artifact_id]
        : []);
  if (!ids.length) {
    return { status: 400, body: { error: {
      message: "resolve requires {artifact_id} or {artifact_ids: string[]}",
      type: "invalid_request_error", code: 400,
    } } };
  }
  if (ids.length > 32) {
    return { status: 400, body: { error: {
      message: "resolve accepts at most 32 ids per call",
      type: "invalid_request_error", code: 400,
    } } };
  }

  const out = [];
  for (const id of ids) {
    out.push(await resolveOne(cfg.stratumDir, id));
  }
  const reuseOk = out.every(r => r.found && r.integrity && r.integrity.reuse_ok);
  return {
    status: 200,
    body: {
      count: out.length,
      reuse_ok: reuseOk,
      artifacts: out,
      generated_at: nowIso(),
      law: "intake -> canon -> durable artifact -> integrity pass -> reuse",
    },
  };
}

// ---------------------------------------------------------------------------
// Healthz
// ---------------------------------------------------------------------------

async function handleStrataHealth(cfg) {
  const d = dirsFor(cfg.stratumDir);
  const meta = await readJsonFile(d.meta);
  const vocab = await cfg.vocabPromise;

  let inboxCount, canonCount, artifactCount;
  try {
    [inboxCount, canonCount, artifactCount] = await Promise.all([
      listDir(d.inbox, ".json").then(a => a.length),
      listDir(d.canon, ".json").then(a => a.length),
      listDir(d.artifacts, ".json").then(a => a.length),
    ]);
  } catch (err) {
    return {
      status: "down",
      service: "orangellm-strata",
      error: err.message,
      generated_at: nowIso(),
    };
  }

  return {
    status: "ok",
    service: "orangellm-strata",
    stratum_dir: cfg.stratumDir,
    schema: SCHEMA_VERSION,
    counts: {
      inbox: inboxCount,
      canon: canonCount,
      artifacts: artifactCount,
      contradictions: meta?.counts?.contradictions ?? 0,
    },
    last_emit_at: meta?.last_emit_at || null,
    doctrine_vocab_size: vocab.length,
    law: "intake -> canon -> durable artifact -> integrity pass -> reuse",
    generated_at: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Public registration
// ---------------------------------------------------------------------------

export function registerStrataRoutes(server, opts = {}) {
  if (!server || typeof server.on !== "function") {
    throw new TypeError("registerStrataRoutes: server must be a node:http Server");
  }

  const stratumDir = opts.stratumDir || resolveDefaultStratumDir();
  const doctrineDir = opts.doctrineDir || resolveDefaultDoctrineDir();
  const log = typeof opts.log === "function" ? opts.log : (line) => {
    // eslint-disable-next-line no-console
    console.log(line);
  };

  // Layout + vocab are prepared at registration; both promises are awaited
  // inside each handler. Failures are logged but non-fatal — the routes
  // will surface real errors when invoked.
  ensureLayout(stratumDir).catch(err => {
    log(`[strata] layout setup failed: ${err.message}`);
  });

  const vocabPromise = (async () => {
    if (Array.isArray(opts.doctrineVocab) && opts.doctrineVocab.length) {
      const merged = new Set(DEFAULT_DOCTRINE_VOCAB);
      for (const b of opts.doctrineVocab) {
        if (typeof b === "string" && b.trim()) merged.add(b.toLowerCase().trim());
      }
      return Array.from(merged);
    }
    return loadDoctrineVocab(doctrineDir);
  })();

  const cfg = { stratumDir, doctrineDir, log, vocabPromise };

  const ROUTES = [
    { method: "POST", path: "/v1/strata/intake"   },
    { method: "POST", path: "/v1/strata/canonize" },
    { method: "POST", path: "/v1/strata/emit"     },
    { method: "POST", path: "/v1/strata/query"    },
    { method: "POST", path: "/v1/strata/resolve"  },
    { method: "GET",  path: "/v1/strata/healthz"  },
  ];

  server.prependListener("request", async (req, res) => {
    if (res.writableEnded) return;

    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return;
    }
    const method = (req.method || "GET").toUpperCase();
    const pathName = url.pathname;
    if (!pathName.startsWith("/v1/strata/")) return;

    const match = ROUTES.find(r => r.method === method && r.path === pathName);
    if (!match) {
      return errorResponse(
        res,
        `strata route not found: ${method} ${pathName}`,
        404,
        "strata_route_not_found",
      );
    }

    try {
      if (method === "GET" && pathName === "/v1/strata/healthz") {
        const body = await handleStrataHealth(cfg);
        return jsonResponse(res, body);
      }

      const raw = await readJsonBody(req);
      let result;
      switch (pathName) {
        case "/v1/strata/intake":   result = await handleIntake(raw, cfg);   break;
        case "/v1/strata/canonize": result = await handleCanonize(raw, cfg); break;
        case "/v1/strata/emit":     result = await handleEmit(raw, cfg);     break;
        case "/v1/strata/query":    result = await handleQuery(raw, cfg);    break;
        case "/v1/strata/resolve":  result = await handleResolve(raw, cfg);  break;
        default:
          return errorResponse(res, "unreachable", 500);
      }
      return jsonResponse(res, result.body, result.status);
    } catch (err) {
      log(`[strata] handler error on ${method} ${pathName}: ${err.message}`);
      return errorResponse(
        res,
        err.message || "strata internal error",
        500,
        "strata_internal_error",
      );
    }
  });

  return { cfg, routes: ROUTES };
}

export const __strataHandlers = {
  handleIntake,
  handleCanonize,
  handleEmit,
  handleQuery,
  handleResolve,
  handleStrataHealth,
  readJsonBody,
  // Exposed for tests:
  classifyToBucket,
  findContradiction,
  loadDoctrineVocab,
  DEFAULT_DOCTRINE_VOCAB,
  SCHEMA_VERSION,
};
