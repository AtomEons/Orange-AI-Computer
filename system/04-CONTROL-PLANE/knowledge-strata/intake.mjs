#!/usr/bin/env node
// Orange5 — Knowledge Strata: Intake stage
// Path:    04-CONTROL-PLANE/knowledge-strata/intake.mjs
// Runtime: Node >= 20 (Bun-compatible — node: imports only)
// Mounts:  POST /v1/strata/intake  on the OrangeLLM gateway
//
// What this stage does
// --------------------
// Stage 1 of the Knowledge Strata compiler loop:
//
//   intake  →  canon  →  durable artifact  →  integrity pass  →  reuse
//   ^^^^^^
//
// Accepts raw operator/agent input (notes, transcripts, receipts, JSON
// blobs) over POST /v1/strata/intake. Stamps each submission with:
//
//   - received_at  (ISO timestamp, server clock)
//   - source       (declared by caller; "unknown" if absent)
//   - raw_sha256   (sha256 of the canonical-form raw bytes)
//   - intake_id    (sha256[0..16] of {raw_sha256, received_at} — stable handle)
//
// Then writes ONE event to Reality Flux with:
//
//   origin     = 'strata_intake'
//   event_type = 'strata_intake'
//   body       = { intake_id, source, content_type, received_at,
//                  raw_sha256, bytes, payload, meta }
//
// Reality lane is authoritative (per loader.mjs doctrine). The intake
// stage never writes to the Thought lane. The downstream canonizer reads
// origin='strata_intake' events and continues the loop.
//
// Local fallback file
// -------------------
// If the Reality Flux adapter is unreachable, the intake is still
// preserved as a deterministic file under
//   01-DOCTRINE/strata/intake/YYYY-MM-DD/<intake_id>.json
// and the response advertises `flux_persisted:false, local_path:...`.
// No fake-green: the caller always knows where the bytes landed.
//
// Doctrine alignment (binding)
// ----------------------------
// - Mom's Law: never claim green without proof. Every response carries
//   the receipt path or names the source explicitly.
// - Loopback only. The flux adapter (11-MIRAGE/adapters/flux.mjs) is the
//   only network hop, and it already enforces 127.0.0.1:7419 Cobra and
//   Codexa-rail fallback.
// - Frontier-only-via-gateway. This module never binds a port of its
//   own — it is mounted by the OrangeLLM gateway router.
// - Receipts override recollection. Reality Flux is the receipted store.
// - Knowledge Strata gate discipline: intake has its own gate. It does
//   NOT canonize, embed, or interpret — those are later stages.
//
// HTTP contract
// -------------
//   POST /v1/strata/intake
//   Content-Type: application/json | text/plain | text/markdown
//
//   200 OK  { ok:true, intake_id, raw_sha256, received_at, source,
//             flux_persisted, flux_source?, local_path?, bytes }
//   400     { ok:false, reason }       (empty body, bad json, oversize)
//   500     reserved for unhandled exceptions
//
// JSON body shape (preferred):
//   {
//     "source": "operator|agent:builder|skill:atomeons-prime|<freeform>",
//     "content_type": "text/markdown" | "application/json" | "text/plain",
//     "payload": <string | object | array>,        // the raw thing
//     "meta": { ... }                              // optional caller tags
//   }
//
// Raw-text body (POST application/json with a string, or text/* with raw
// body) is also accepted; in that case content_type defaults to the
// request header and source defaults to "unknown".
//
// Programmatic API
// ----------------
//   import { intake, intakeHandler } from './intake.mjs';
//   const r = await intake({ source, payload, content_type, meta });
//
// CLI
// ---
//   node intake.mjs --source operator --file note.md
//   node intake.mjs --source agent:builder --json '{"k":"v"}'
//   node intake.mjs --stdin --content-type text/markdown
//   node intake.mjs --no-flux                 # force local-only persist
//   node intake.mjs --pretty
//
// Exit codes: 0 ok, 2 partial (local persist, flux down), 1 hard error.

import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants

const ORANGE5_ROOT =
  process.env.ORANGE5_ROOT || resolve(__dirname, "..", "..");

const FLUX_ADAPTER_PATH =
  process.env.ORANGE5_FLUX_ADAPTER ||
  resolve(ORANGE5_ROOT, "11-MIRAGE", "adapters", "flux.mjs");

const LOCAL_INTAKE_ROOT =
  process.env.ORANGE5_STRATA_INTAKE_DIR ||
  resolve(ORANGE5_ROOT, "01-DOCTRINE", "strata", "intake");

const ORIGIN = "strata_intake";
const EVENT_TYPE = "strata_intake";
const SCHEMA = "orange5.strata.intake.v1";

// 4 MB is the operator-facing soft limit. Above this we refuse rather
// than truncate — better to honestly say "too big" than to silently
// hash a slice of the bytes.
const MAX_PAYLOAD_BYTES = parseInt(
  process.env.ORANGE5_STRATA_INTAKE_MAX_BYTES || String(4 * 1024 * 1024),
  10,
);

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)

export function nowIso(d = new Date()) {
  return d.toISOString();
}

export function dayIso(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Canonicalize the payload into the exact bytes we hash and persist.
 *
 * - Objects/arrays: deterministic JSON with sorted keys at every level.
 *   Two callers submitting the same object with different key order
 *   get the same raw_sha256.
 * - Strings: passed through as-is (operator notes / markdown are
 *   whitespace-sensitive; we do NOT trim or normalize).
 * - Numbers / booleans / null: JSON.stringify.
 * - Buffers: treated as UTF-8 strings (rare on this path).
 */
export function canonicalize(payload) {
  if (payload == null) return "null";
  if (typeof payload === "string") return payload;
  if (Buffer.isBuffer && Buffer.isBuffer(payload)) return payload.toString("utf8");
  if (typeof payload !== "object") return JSON.stringify(payload);
  return stableStringify(payload);
}

function stableStringify(v) {
  if (v == null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map(stableStringify).join(",") + "]";
  }
  if (typeof v === "object") {
    const keys = Object.keys(v).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + stableStringify(v[k]),
    );
    return "{" + parts.join(",") + "}";
  }
  return "null";
}

/**
 * Validate the inbound submission before we hash or persist anything.
 * Returns { ok, normalized? , reason? }.
 *
 * Normalized shape:
 *   { source, content_type, payload, meta }
 */
export function validateSubmission(raw) {
  if (raw == null) {
    return { ok: false, reason: "empty_submission" };
  }

  // Allow three caller shapes:
  //   1. { source, content_type, payload, meta }
  //   2. raw string  → wrap as {payload:string, content_type:'text/plain'}
  //   3. plain object/array → wrap as {payload:obj, content_type:'application/json'}
  let s = raw;
  if (typeof raw === "string") {
    s = { payload: raw, content_type: "text/plain" };
  } else if (
    typeof raw === "object" &&
    !("payload" in raw) &&
    !("source" in raw) &&
    !("content_type" in raw)
  ) {
    s = { payload: raw, content_type: "application/json" };
  }

  if (typeof s !== "object" || Array.isArray(s)) {
    return { ok: false, reason: "submission_not_an_object" };
  }
  if (!("payload" in s) || s.payload == null) {
    return { ok: false, reason: "payload_required" };
  }

  const source =
    typeof s.source === "string" && s.source.trim() ? s.source.trim() : "unknown";
  const content_type =
    typeof s.content_type === "string" && s.content_type.trim()
      ? s.content_type.trim()
      : inferContentType(s.payload);
  const meta = s.meta && typeof s.meta === "object" && !Array.isArray(s.meta)
    ? s.meta
    : {};

  return {
    ok: true,
    normalized: {
      source,
      content_type,
      payload: s.payload,
      meta,
    },
  };
}

function inferContentType(payload) {
  if (typeof payload === "string") return "text/plain";
  if (typeof payload === "object") return "application/json";
  return "application/octet-stream";
}

/**
 * Build the stamped intake record. Pure — no I/O. Exposed so the smoke
 * test and the canonizer can re-derive intake_id deterministically.
 */
export function stamp({ submission, now = new Date() }) {
  const received_at = nowIso(now);
  const bytes = canonicalize(submission.payload);
  const byte_len = Buffer.byteLength(bytes, "utf8");
  const raw_sha256 = sha256(bytes);
  // intake_id mixes the hash with the receive time so two identical
  // submissions at different moments stay distinguishable. First 16 hex
  // chars = 64 bits of collision space, plenty for a per-instance index.
  const intake_id = sha256(`${raw_sha256}|${received_at}`).slice(0, 16);
  return {
    schema: SCHEMA,
    intake_id,
    source: submission.source,
    content_type: submission.content_type,
    received_at,
    raw_sha256,
    bytes: byte_len,
    payload: submission.payload,
    meta: submission.meta,
  };
}

// ---------------------------------------------------------------------------
// Flux adapter (lazy-loaded; injectable for tests)

async function defaultFluxAdapterLoader() {
  try {
    const url = pathToFileURL(FLUX_ADAPTER_PATH);
    const mod = await import(url.href);
    return mod.fluxAdapter || mod.default || null;
  } catch (e) {
    return { __err: String(e?.message || e) };
  }
}

async function writeToFlux({ adapter, record }) {
  const a = adapter || (await defaultFluxAdapterLoader());
  if (!a || typeof a.write !== "function") {
    return {
      ok: false,
      reason: "flux_adapter_unavailable",
      detail: a && a.__err ? a.__err : "no_write_method",
    };
  }
  let res;
  try {
    res = await a.write({
      origin: ORIGIN,
      event_type: EVENT_TYPE,
      body: record,
    });
  } catch (e) {
    return { ok: false, reason: "flux_write_threw", detail: String(e?.message || e) };
  }
  if (!res || res.ok === false) {
    return {
      ok: false,
      reason: "flux_write_not_ok",
      detail: res?.reason || res?.detail || "unknown",
    };
  }
  return { ok: true, source: res.source || "reality_flux", receipt: res.receipt };
}

// ---------------------------------------------------------------------------
// Local-disk fallback

function localPathFor(record) {
  const day = record.received_at.slice(0, 10); // YYYY-MM-DD
  return resolve(LOCAL_INTAKE_ROOT, day, `${record.intake_id}.json`);
}

function writeLocal(record) {
  const path = localPathFor(record);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: "local_write_failed", detail: String(e?.message || e), path };
  }
}

// ---------------------------------------------------------------------------
// Public API — intake()

/**
 * Stamp a submission and persist it.
 *
 * Options
 * -------
 *   source        : string  (defaults to "unknown")
 *   content_type  : string  (inferred from payload if absent)
 *   payload       : string|object|array|number|boolean   (required)
 *   meta          : object  (optional caller tags)
 *   adapter       : injectable flux adapter (test seam)
 *   skipFlux      : bool — force local-only persist
 *   skipLocal     : bool — refuse to write local fallback (test seam)
 *   now           : Date override (test seam)
 *
 * Return shape (always; never throws on the request path):
 *   { ok, intake_id, raw_sha256, received_at, source, content_type,
 *     bytes, flux_persisted, flux_source?, local_path?, attempts }
 *
 *   ok:false means we could persist NEITHER to flux NOR to disk, OR the
 *   submission failed validation. In both cases `reason` is set and the
 *   caller knows exactly why.
 */
export async function intake(opts = {}) {
  // Validation FIRST — never hash or persist a bad submission.
  const v = validateSubmission(opts);
  if (!v.ok) {
    return { ok: false, reason: v.reason };
  }

  const bytesPreview = canonicalize(v.normalized.payload);
  const byte_len = Buffer.byteLength(bytesPreview, "utf8");
  if (byte_len > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      reason: "payload_too_large",
      bytes: byte_len,
      max_bytes: MAX_PAYLOAD_BYTES,
    };
  }

  const record = stamp({ submission: v.normalized, now: opts.now });
  const attempts = [];

  // 1. Reality Flux (PRIMARY)
  let flux_persisted = false;
  let flux_source = null;
  if (!opts.skipFlux) {
    const fr = await writeToFlux({ adapter: opts.adapter, record });
    attempts.push({ target: "reality_flux", ok: fr.ok, reason: fr.reason });
    if (fr.ok) {
      flux_persisted = true;
      flux_source = fr.source;
    }
  } else {
    attempts.push({ target: "reality_flux", skipped: true });
  }

  // 2. Local-disk fallback (always written when flux fails; ALSO written
  //    when flux succeeds, so we keep a doctrine-side audit trail and the
  //    canonizer can still read intake even if Cobra is later wiped).
  let local_path = null;
  if (!opts.skipLocal) {
    const lr = writeLocal(record);
    attempts.push({ target: "local_disk", ok: lr.ok, reason: lr.reason, path: lr.path });
    if (lr.ok) local_path = lr.path;
  } else {
    attempts.push({ target: "local_disk", skipped: true });
  }

  const persisted_anywhere = flux_persisted || !!local_path;
  if (!persisted_anywhere) {
    return {
      ok: false,
      reason: "no_persistence_target_succeeded",
      intake_id: record.intake_id,
      raw_sha256: record.raw_sha256,
      received_at: record.received_at,
      attempts,
    };
  }

  return {
    ok: true,
    intake_id: record.intake_id,
    raw_sha256: record.raw_sha256,
    received_at: record.received_at,
    source: record.source,
    content_type: record.content_type,
    bytes: record.bytes,
    flux_persisted,
    flux_source,
    local_path,
    attempts,
  };
}

// ---------------------------------------------------------------------------
// Gateway handler — POST /v1/strata/intake

async function readRequestBody(req, { limit = MAX_PAYLOAD_BYTES } = {}) {
  return await new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        rej(new Error("payload_too_large"));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) => rej(e));
  });
}

function jsonReply(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

/**
 * Node http handler for POST /v1/strata/intake.
 *
 * Body parsing rules:
 *   - Content-Type: application/json  → parse JSON, expect submission shape.
 *   - Content-Type: text/*            → wrap raw text as {payload, content_type}.
 *   - missing / other                 → treat as text/plain.
 *
 * Errors return 200 with {ok:false} for caller-fixable problems
 * (matches the loader.mjs convention) EXCEPT for hard request-shape
 * issues (wrong method, malformed json) which use 4xx so curl/clients
 * surface them obviously.
 */
export async function intakeHandler(req, res) {
  try {
    if (!req.method || req.method.toUpperCase() !== "POST") {
      jsonReply(res, 405, {
        ok: false,
        reason: "method_not_allowed",
        allow: "POST",
      });
      return;
    }

    const ct = (req.headers?.["content-type"] || "").toLowerCase();
    let bodyText;
    try {
      bodyText = await readRequestBody(req);
    } catch (e) {
      if (String(e?.message) === "payload_too_large") {
        jsonReply(res, 413, {
          ok: false,
          reason: "payload_too_large",
          max_bytes: MAX_PAYLOAD_BYTES,
        });
        return;
      }
      jsonReply(res, 400, { ok: false, reason: "body_read_failed", detail: String(e?.message || e) });
      return;
    }

    if (!bodyText || !bodyText.length) {
      jsonReply(res, 400, { ok: false, reason: "empty_body" });
      return;
    }

    let submission;
    if (ct.includes("application/json")) {
      try {
        submission = JSON.parse(bodyText);
      } catch (e) {
        jsonReply(res, 400, {
          ok: false,
          reason: "malformed_json",
          detail: String(e?.message || e),
        });
        return;
      }
    } else if (ct.startsWith("text/") || ct === "") {
      submission = {
        payload: bodyText,
        content_type: ct || "text/plain",
        source: req.headers?.["x-strata-source"] || "unknown",
      };
    } else {
      // application/octet-stream and friends — preserve as text.
      submission = {
        payload: bodyText,
        content_type: ct,
        source: req.headers?.["x-strata-source"] || "unknown",
      };
    }

    const out = await intake(submission);
    jsonReply(res, out.ok ? 200 : 200, out);
  } catch (e) {
    // Defense in depth — intake() should not throw, but if it does we
    // refuse to silently swallow. Mom's Law.
    jsonReply(res, 500, {
      ok: false,
      reason: "intake_threw",
      detail: String(e?.message || e),
    });
  }
}

/**
 * Object surface for gateway routers that prefer it.
 */
export const routes = Object.freeze({
  "POST /v1/strata/intake": intakeHandler,
});

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = { pretty: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i];
    else if (a === "--content-type") args.content_type = argv[++i];
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--json") args.jsonArg = argv[++i];
    else if (a === "--stdin") args.stdin = true;
    else if (a === "--no-flux") args.skipFlux = true;
    else if (a === "--no-local") args.skipLocal = true;
    else if (a === "--pretty") args.pretty = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function helpText() {
  return [
    "Orange5 Knowledge Strata — Intake",
    "",
    "Usage:",
    "  node intake.mjs --source <s> --file <path>",
    "  node intake.mjs --source <s> --json '<json>'",
    "  node intake.mjs --source <s> --stdin [--content-type text/markdown]",
    "  [--no-flux] [--no-local] [--pretty]",
    "",
    "Exit codes: 0 ok, 2 partial (no flux), 1 hard error.",
  ].join("\n");
}

async function readStdin() {
  return await new Promise((res, rej) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => res(buf));
    process.stdin.on("error", rej);
  });
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(helpText() + "\n");
    process.exit(0);
  }
  (async () => {
    let payload;
    let content_type = args.content_type;
    if (args.file) {
      payload = readFileSync(args.file, "utf8");
      if (!content_type) {
        content_type = args.file.endsWith(".json")
          ? "application/json"
          : args.file.endsWith(".md")
          ? "text/markdown"
          : "text/plain";
      }
      // If it's a .json file, parse so we hash the structured shape.
      if (content_type === "application/json") {
        try { payload = JSON.parse(payload); } catch { /* keep as string */ }
      }
    } else if (args.jsonArg) {
      try {
        payload = JSON.parse(args.jsonArg);
        content_type = content_type || "application/json";
      } catch {
        payload = args.jsonArg;
        content_type = content_type || "text/plain";
      }
    } else if (args.stdin) {
      payload = await readStdin();
      content_type = content_type || "text/plain";
    } else {
      process.stderr.write("intake.mjs: need --file, --json, or --stdin\n");
      process.exit(1);
    }

    const out = await intake({
      source: args.source || "cli",
      content_type,
      payload,
      skipFlux: !!args.skipFlux,
      skipLocal: !!args.skipLocal,
    });
    const txt = args.pretty ? JSON.stringify(out, null, 2) : JSON.stringify(out);
    process.stdout.write(txt + "\n");
    if (!out.ok) process.exit(1);
    if (out.ok && !out.flux_persisted) process.exit(2);
    process.exit(0);
  })().catch((err) => {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        reason: "cli_unhandled",
        detail: String(err?.message || err),
      }) + "\n",
    );
    process.exit(1);
  });
}

export default intake;
