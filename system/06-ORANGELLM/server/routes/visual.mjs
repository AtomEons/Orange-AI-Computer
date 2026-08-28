// AE OrangeLLM — visual routes (/v1/visual/*)
// Path: 06-ORANGELLM/server/routes/visual.mjs
//
// Three OrangeEye Phase-1 gateway endpoints, all loopback-only via the parent
// server (127.0.0.1:1337). Routes:
//
//   POST /v1/visual/ingest      multipart {file, source_hint, lane}
//   POST /v1/visual/query       json     {query, top_k, lane}
//   POST /v1/visual/describe    json     {doc_id, page} OR {image_url}, optional flags
//
// Doctrine refs:
//   - 07-VISUAL/AE_ORANGEEYE_FOUNDATION_SPEC.md
//   - Frontier-Isolation Law: external frontier models are reached ONLY via
//     our own /v1/chat/completions on 127.0.0.1:1337. Never direct.
//   - Mom's Law: every branch earns its place. Honest failure modes only.
//
// What this file does NOT do (yet — see README):
//   - No streaming responses (visual results are usually small; non-stream is fine).
//   - No auth gating beyond the boundary middleware (operator runs loopback).
//   - No multipart parsing dependency — uses a minimal RFC-7578 parser tuned
//     for single-file uploads + a couple short text fields. Big uploads should
//     still go directly to the ColPali service if more headroom is needed.
//   - No deep-flag JWT validation — the operator sets it on their side.
//   - No image fetch from `image_url` outside the loopback; remote URLs are rejected
//     unless they resolve to 127.0.0.1 (defense against SSRF via gateway).

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// --- Sibling module paths ---------------------------------------------------
//
// This file sits at: 06-ORANGELLM/server/routes/visual.mjs
// Its target peers live at: 07-VISUAL/qdrant/*.mjs and 07-VISUAL/visual-event/writer.mjs
//
// We resolve relative to this file rather than process.cwd() so the gateway
// works whether you launch it from the repo root or from server/.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VISUAL_ROOT = path.resolve(HERE, "..", "..", "..", "07-VISUAL");
const QDRANT_UPSERT_PATH = path.join(VISUAL_ROOT, "qdrant", "upsert.mjs");
const QDRANT_QUERY_PATH = path.join(VISUAL_ROOT, "qdrant", "query.mjs");
const VISUAL_EVENT_PATH = path.join(VISUAL_ROOT, "visual-event", "writer.mjs");

// --- Endpoint constants -----------------------------------------------------

const COLPALI_URL = process.env.ORANGE5_COLPALI_URL || "http://127.0.0.1:7440";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const CORTEX_MODEL = process.env.ORANGE5_CORTEX_MODEL || "glm-4.6v";
const CORTEX_OLLAMA_URL = process.env.ORANGE5_CORTEX_OLLAMA_URL || OLLAMA_URL;
const CORTEX_FALLBACK_MODEL = process.env.ORANGE5_CORTEX_FALLBACK_MODEL || "";
const CORTEX_FALLBACK_URL = process.env.ORANGE5_CORTEX_FALLBACK_URL || "";
const CONFIDENCE_THRESHOLD = Number(process.env.ORANGE5_CORTEX_CONFIDENCE || 0.7);
const GATEWAY_SELF_URL = process.env.ORANGE5_GATEWAY_SELF_URL || "http://127.0.0.1:1337";
const AE_FLUX_ROOT = process.env.AE_FLUX_ROOT || undefined;

const MAX_INGEST_BYTES = Number(process.env.ORANGE5_VISUAL_MAX_BYTES || 50 * 1024 * 1024);
const MAX_JSON_BYTES = Number(process.env.ORANGE5_VISUAL_MAX_JSON || 1_000_000);

const ALLOWED_LANES = new Set(["doc", "ui-screenshot", "video-frame", "chart", "whiteboard"]);

// --- Phase-2 batch / video constants ---------------------------------------
//
// The colpali-service Phase-2 endpoints (/enqueue, /queue, /queue/:id) live on
// the same loopback host as /ingest. We proxy through the gateway so that:
//   1. boundary policy is enforced once (here), not duplicated downstream;
//   2. the Vault lane only ever talks to /v1/visual/* on 127.0.0.1:1337;
//   3. callers outside the visual stack can never hit the queue surface
//      directly — the FORBIDDEN_PATH_PATTERNS regex still blocks /codexa/* etc.

const FFMPEG_BIN = process.env.ORANGE5_FFMPEG_BIN || "ffmpeg";
const FFPROBE_BIN = process.env.ORANGE5_FFPROBE_BIN || "ffprobe";

// Hard ceiling on video-frame extraction. Without it a 4-hour 1080p clip at
// interval_sec=1 would emit 14400 frames and OOM Codexa long before they ever
// reach the queue runner. The cap is intentionally below the colpali-service
// /enqueue batch cap (1000) so a partial extract still rolls through.
const VIDEO_FRAME_LIMIT_DEFAULT = Number(process.env.ORANGE5_VIDEO_MAX_FRAMES || 600);
const VIDEO_INTERVAL_DEFAULT_SEC = Number(process.env.ORANGE5_VIDEO_INTERVAL_SEC || 2);
const VIDEO_INTERVAL_MIN_SEC = 0.1;   // 10 fps is the floor we accept
const VIDEO_INTERVAL_MAX_SEC = 3600;  // 1-frame-per-hour is the ceiling

// ffmpeg/ffprobe must terminate in bounded time. Long-running shell-outs are
// always a smell; if a real-world video needs more than this, the operator
// should pre-segment offline before ingest.
const FFMPEG_TIMEOUT_MS = Number(process.env.ORANGE5_FFMPEG_TIMEOUT_MS || 300_000);

// --- HTTP helpers -----------------------------------------------------------

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message, extra) {
  sendJson(res, status, {
    error: {
      type: "visual_error",
      code,
      message,
      ...(extra || {}),
    },
  });
}

async function readRawBody(req, cap) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > cap) {
        req.destroy();
        reject(Object.assign(new Error("body too large"), { code: "PAYLOAD_TOO_LARGE", status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const buf = await readRawBody(req, MAX_JSON_BYTES);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    const e = new Error(`invalid JSON body: ${err.message}`);
    e.code = "INVALID_JSON";
    e.status = 400;
    throw e;
  }
}

// --- Minimal multipart/form-data parser -------------------------------------
//
// We deliberately avoid a heavyweight dep. The /ingest contract is tiny:
//   - one file field
//   - one or two short text fields
// This parser handles that and returns a flat { fields: {}, file: {name, contentType, bytes} } shape.
// It does NOT support multiple files, nested boundaries, or charset gymnastics.

function parseContentType(header) {
  if (!header || typeof header !== "string") return { type: "", boundary: "" };
  const parts = header.split(";").map((p) => p.trim());
  const type = parts.shift() || "";
  let boundary = "";
  for (const p of parts) {
    const m = p.match(/^boundary=(?:"([^"]+)"|([^;]+))$/i);
    if (m) boundary = m[1] || m[2];
  }
  return { type, boundary };
}

function indexOfBuf(haystack, needle, fromIndex = 0) {
  return haystack.indexOf(needle, fromIndex);
}

function parseMultipart(buf, boundary) {
  if (!boundary) {
    const e = new Error("missing multipart boundary");
    e.code = "MULTIPART_NO_BOUNDARY";
    e.status = 400;
    throw e;
  }
  const dash = Buffer.from(`--${boundary}`, "utf8");
  const crlf = Buffer.from("\r\n", "utf8");
  const headerSep = Buffer.from("\r\n\r\n", "utf8");

  const fields = {};
  let file = null;

  let pos = indexOfBuf(buf, dash, 0);
  if (pos < 0) {
    const e = new Error("multipart: opening boundary not found");
    e.code = "MULTIPART_MALFORMED";
    e.status = 400;
    throw e;
  }

  while (pos >= 0) {
    // Move past the boundary line.
    let lineEnd = indexOfBuf(buf, crlf, pos);
    if (lineEnd < 0) break;
    // Check if this is the closing boundary "--boundary--"
    const after = buf.slice(pos + dash.length, lineEnd).toString("utf8");
    if (after.startsWith("--")) break;

    const partStart = lineEnd + crlf.length;
    const headerEnd = indexOfBuf(buf, headerSep, partStart);
    if (headerEnd < 0) break;
    const rawHeaders = buf.slice(partStart, headerEnd).toString("utf8");
    const bodyStart = headerEnd + headerSep.length;
    const nextBoundary = indexOfBuf(buf, dash, bodyStart);
    if (nextBoundary < 0) break;
    // Strip the trailing CRLF that precedes the next boundary.
    const bodyEnd = nextBoundary - crlf.length;
    if (bodyEnd < bodyStart) break;
    const bodyBuf = buf.slice(bodyStart, bodyEnd);

    // Parse the headers we care about.
    let name = "";
    let filename = "";
    let contentType = "application/octet-stream";
    for (const line of rawHeaders.split(/\r\n/)) {
      const lower = line.toLowerCase();
      if (lower.startsWith("content-disposition:")) {
        const mn = line.match(/name="([^"]*)"/i);
        if (mn) name = mn[1];
        const mf = line.match(/filename="([^"]*)"/i);
        if (mf) filename = mf[1];
      } else if (lower.startsWith("content-type:")) {
        contentType = line.slice(line.indexOf(":") + 1).trim();
      }
    }

    if (filename) {
      file = { name: name || "file", filename, contentType, bytes: bodyBuf };
    } else if (name) {
      fields[name] = bodyBuf.toString("utf8");
    }

    pos = nextBoundary;
  }

  return { fields, file };
}

// --- Lazy dynamic imports of sibling modules --------------------------------
//
// The gateway must start even when the 07-VISUAL/* peers are absent (e.g. dev
// box without the visual stack). We import lazily so a missing module yields a
// clean 503 from the specific route rather than a cold-boot crash.

let _upsertMod = null;
let _queryMod = null;
let _visualEventMod = null;

async function loadUpsert() {
  if (_upsertMod) return _upsertMod;
  try {
    _upsertMod = await import(pathToFileURL(QDRANT_UPSERT_PATH).href);
  } catch (err) {
    const e = new Error(`qdrant/upsert.mjs unavailable: ${err.message}`);
    e.code = "VISUAL_DEPS_MISSING";
    e.status = 503;
    throw e;
  }
  return _upsertMod;
}

async function loadQuery() {
  if (_queryMod) return _queryMod;
  try {
    _queryMod = await import(pathToFileURL(QDRANT_QUERY_PATH).href);
  } catch (err) {
    const e = new Error(`qdrant/query.mjs unavailable: ${err.message}`);
    e.code = "VISUAL_DEPS_MISSING";
    e.status = 503;
    throw e;
  }
  return _queryMod;
}

async function loadVisualEvent() {
  if (_visualEventMod) return _visualEventMod;
  try {
    _visualEventMod = await import(pathToFileURL(VISUAL_EVENT_PATH).href);
  } catch (err) {
    const e = new Error(`visual-event/writer.mjs unavailable: ${err.message}`);
    e.code = "VISUAL_DEPS_MISSING";
    e.status = 503;
    throw e;
  }
  return _visualEventMod;
}

// --- Cortex helpers ---------------------------------------------------------
//
// Ollama /api/generate is a streaming JSON-lines API by default. We pass
// stream=false to get one consolidated JSON response. The GLM-4.6V wrapper is
// expected to return a JSON-string payload in `response`. If the model emits
// freeform text we fall back to a low-confidence summary.

function tryParseCortexResponse(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { summary: "(empty cortex response)", confidence: 0 };
  }
  // GLM-4.6V often wraps JSON in code fences. Strip them defensively.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_) { /* fall through */ }
  return { summary: raw.slice(0, 4000), confidence: 0.3 };
}

async function callOllamaCortex({ baseUrl, model, prompt, images, maxTokens, timeoutMs }) {
  // Ollama /api/generate expects { model, prompt, images: [b64,...], stream:false }
  const body = {
    model,
    prompt,
    images: images || [],
    stream: false,
    think: false,
    format: {
      type: "object",
      properties: {
        summary: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" } },
        commands: { type: "array", items: { type: "string" } },
        risk: { type: "string" },
        next_action: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        layout_complexity_high: { type: "boolean" },
        token_budget_exceeded: { type: "boolean" },
      },
      required: ["summary", "confidence"],
    },
    options: { temperature: 0.2, num_predict: maxTokens },
  };
  let res, text;
  try {
    res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    const e = new Error(`Ollama unreachable at ${baseUrl}: ${err.message}`);
    e.code = "CORTEX_UNREACHABLE";
    e.status = 503;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Ollama /api/generate ${res.status}: ${text.slice(0, 500)}`);
    e.code = "CORTEX_HTTP_ERROR";
    e.status = 502;
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) {
    const e = new Error(`Ollama returned non-JSON: ${err.message}`);
    e.code = "CORTEX_BAD_RESPONSE";
    e.status = 502;
    throw e;
  }
  const cortex = tryParseCortexResponse(parsed.response);
  return { cortex, raw: parsed, model_used: model, ollama_url: baseUrl };
}

async function callLocalCortex({ prompt, images, maxTokens = 256 }) {
  const timeoutMs = Math.max(5_000, Math.min(
    Number(process.env.ORANGE5_CORTEX_TIMEOUT_MS || 90_000),
    300_000,
  ));
  try {
    return await callOllamaCortex({
      baseUrl: CORTEX_OLLAMA_URL,
      model: CORTEX_MODEL,
      prompt,
      images,
      maxTokens,
      timeoutMs,
    });
  } catch (primaryError) {
    const fallbackConfigured = CORTEX_FALLBACK_URL && CORTEX_FALLBACK_MODEL && (
      CORTEX_FALLBACK_URL !== CORTEX_OLLAMA_URL ||
      CORTEX_FALLBACK_MODEL !== CORTEX_MODEL
    );
    if (!fallbackConfigured) throw primaryError;
    try {
      const fallback = await callOllamaCortex({
        baseUrl: CORTEX_FALLBACK_URL,
        model: CORTEX_FALLBACK_MODEL,
        prompt,
        images,
        maxTokens,
        timeoutMs,
      });
      fallback.primary_error = primaryError.message;
      return fallback;
    } catch (fallbackError) {
      const error = new Error(
        `primary cortex failed: ${primaryError.message}; fallback failed: ${fallbackError.message}`,
      );
      error.code = "CORTEX_ALL_ROUTES_FAILED";
      error.status = fallbackError.status || primaryError.status || 502;
      throw error;
    }
  }
}

async function callFrontierViaGateway({ prompt, imageB64, model, authorization }) {
  // Frontier-Isolation Law: we loopback to our own /v1/chat/completions.
  // The gateway already enforces BYO bearer auth and forbidden-header rules.
  const messages = [
    {
      role: "user",
      content: imageB64
        ? [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imageB64}` } },
          ]
        : prompt,
    },
  ];
  const body = {
    model: model || "orangellm-fatty-pending",
    messages,
    temperature: 0.2,
    stream: false,
  };
  const headers = { "content-type": "application/json" };
  if (authorization) headers["authorization"] = authorization;

  let res, text;
  try {
    res = await fetch(`${GATEWAY_SELF_URL}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (err) {
    const e = new Error(`gateway self-call unreachable: ${err.message}`);
    e.code = "FRONTIER_GATEWAY_UNREACHABLE";
    e.status = 503;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`gateway self-call ${res.status}: ${text.slice(0, 500)}`);
    e.code = "FRONTIER_HTTP_ERROR";
    e.status = 502;
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) {
    const e = new Error(`gateway returned non-JSON: ${err.message}`);
    e.code = "FRONTIER_BAD_RESPONSE";
    e.status = 502;
    throw e;
  }
  const content = parsed.choices?.[0]?.message?.content || "";
  const summary = typeof content === "string" ? content : JSON.stringify(content);
  return {
    answer: { summary, confidence: 0.9 },
    model_used: parsed.model || body.model,
    raw: parsed,
  };
}

// --- Image fetch (loopback URL or inline image data for /describe) ----------

function dataImageB64(imageUrl) {
  const match = /^data:(image\/(?:png|jpe?g|webp|gif|bmp));base64,([a-z0-9+/=\s]+)$/i.exec(imageUrl);
  if (!match) return null;
  const encoded = match[2].replace(/\s+/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) {
    const e = new Error("image data URL decoded to an empty payload");
    e.code = "IMAGE_DATA_INVALID";
    e.status = 400;
    throw e;
  }
  if (bytes.length > MAX_INGEST_BYTES) {
    const e = new Error(`image exceeds ${MAX_INGEST_BYTES} bytes`);
    e.code = "IMAGE_TOO_LARGE";
    e.status = 413;
    throw e;
  }
  return bytes.toString("base64");
}

function isLoopbackUrl(u) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch { return false; }
}

async function fetchImageB64(imageUrl) {
  const inline = dataImageB64(imageUrl);
  if (inline) return inline;
  if (!isLoopbackUrl(imageUrl)) {
    const e = new Error("image_url must be an image data URL or resolve to loopback (127.0.0.1/localhost/::1) — SSRF guard");
    e.code = "IMAGE_URL_NOT_LOOPBACK";
    e.status = 400;
    throw e;
  }
  let res, buf;
  try {
    res = await fetch(imageUrl);
    if (!res.ok) {
      const e = new Error(`image fetch ${res.status} for ${imageUrl}`);
      e.code = "IMAGE_FETCH_FAILED";
      e.status = 502;
      throw e;
    }
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err.code === "IMAGE_FETCH_FAILED" || err.code === "IMAGE_URL_NOT_LOOPBACK") throw err;
    const e = new Error(`image fetch failed: ${err.message}`);
    e.code = "IMAGE_FETCH_FAILED";
    e.status = 502;
    throw e;
  }
  if (buf.length > MAX_INGEST_BYTES) {
    const e = new Error(`image exceeds ${MAX_INGEST_BYTES} bytes`);
    e.code = "IMAGE_TOO_LARGE";
    e.status = 413;
    throw e;
  }
  return buf.toString("base64");
}

// --- ColPali ingest call ---------------------------------------------------

async function callColpaliIngest({ fileBytes, filename, contentType }) {
  // Re-pack into multipart for the downstream service so it sees the same
  // shape its own multipart parser expects.
  const boundary = `----orangellm-${createHash("sha256").update(`${Date.now()}-${filename}`).digest("hex").slice(0, 24)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename || "upload.bin"}"\r\n` +
    `Content-Type: ${contentType || "application/octet-stream"}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, fileBytes, tail]);

  let res, text;
  try {
    res = await fetch(`${COLPALI_URL}/ingest`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    text = await res.text();
  } catch (err) {
    const e = new Error(`ColPali service unreachable at ${COLPALI_URL}: ${err.message}`);
    e.code = "COLPALI_UNREACHABLE";
    e.status = 503;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`ColPali /ingest ${res.status}: ${text.slice(0, 500)}`);
    e.code = "COLPALI_HTTP_ERROR";
    e.status = 502;
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) {
    const e = new Error(`ColPali returned non-JSON: ${err.message}`);
    e.code = "COLPALI_BAD_RESPONSE";
    e.status = 502;
    throw e;
  }
  return parsed;
}

// --- Route handlers ---------------------------------------------------------

/**
 * POST /v1/visual/ingest
 *   multipart/form-data:
 *     file        — required, binary (image or PDF)
 *     source_hint — optional, free-form string ("invoice", "schematic", "screenshot Q3")
 *     lane        — optional, one of: doc | ui-screenshot | video-frame | chart | whiteboard
 *
 *   200 -> { doc_id, pages_ingested, patches_indexed, image_sha256 }
 *   413 if file > MAX_INGEST_BYTES
 *   400 if multipart parse fails or no file
 *   503 if ColPali / Qdrant / visual-event peers unreachable
 */
async function handleIngest(req, res) {
  const ctype = parseContentType(req.headers["content-type"]);
  if (!/^multipart\/form-data$/i.test(ctype.type)) {
    return sendError(res, 415, "EXPECT_MULTIPART", "Content-Type must be multipart/form-data");
  }

  let raw;
  try {
    raw = await readRawBody(req, MAX_INGEST_BYTES);
  } catch (err) {
    const status = err.status || 400;
    return sendError(res, status, err.code || "READ_BODY_FAILED", err.message);
  }

  let parsed;
  try {
    parsed = parseMultipart(raw, ctype.boundary);
  } catch (err) {
    return sendError(res, err.status || 400, err.code || "MULTIPART_PARSE_FAILED", err.message);
  }

  if (!parsed.file || !parsed.file.bytes || parsed.file.bytes.length === 0) {
    return sendError(res, 400, "FILE_REQUIRED", 'multipart field "file" is required and must be non-empty');
  }

  const sourceHint = (parsed.fields.source_hint || "").slice(0, 256);
  const lane = (parsed.fields.lane || "doc").trim();
  if (!ALLOWED_LANES.has(lane)) {
    return sendError(res, 400, "INVALID_LANE", `lane must be one of: ${[...ALLOWED_LANES].join(", ")}`);
  }

  // 1. ColPali ingest -> { doc_id, page_count, patches, image_sha256 }
  let colpali;
  try {
    colpali = await callColpaliIngest({
      fileBytes: parsed.file.bytes,
      filename: parsed.file.filename,
      contentType: parsed.file.contentType,
    });
  } catch (err) {
    return sendError(res, err.status || 502, err.code || "COLPALI_FAILED", err.message);
  }

  const docId = colpali.doc_id || `doc-${createHash("sha256").update(parsed.file.bytes).digest("hex").slice(0, 16)}`;
  const imageSha = colpali.image_sha256 || createHash("sha256").update(parsed.file.bytes).digest("hex");
  const pageCount = Number(colpali.page_count || 1);

  // ColPali single-page emits patches as a 2-D matrix; multi-page emits 3-D.
  // Normalize to: pages[page_index] -> patchesMatrix
  let pagesPatches = [];
  if (Array.isArray(colpali.patches)) {
    if (Array.isArray(colpali.patches[0]) && Array.isArray(colpali.patches[0][0])) {
      // 3-D: [page][patch][dim]
      pagesPatches = colpali.patches;
    } else if (Array.isArray(colpali.patches[0])) {
      // 2-D: [patch][dim] -> wrap as single page
      pagesPatches = [colpali.patches];
    }
  }
  if (pagesPatches.length === 0) {
    return sendError(res, 502, "COLPALI_NO_PATCHES", "ColPali returned no patch matrix");
  }

  // 2. Upsert each page to Qdrant.
  let upsertMod, eventMod;
  try { upsertMod = await loadUpsert(); }
  catch (err) { return sendError(res, err.status || 503, err.code || "UPSERT_LOAD_FAILED", err.message); }
  try { eventMod = await loadVisualEvent(); }
  catch (err) { return sendError(res, err.status || 503, err.code || "VEVENT_LOAD_FAILED", err.message); }

  let patchesIndexed = 0;
  const upsertResults = [];
  for (let p = 0; p < pagesPatches.length; p++) {
    const page = p + 1; // 1-based
    const patches = pagesPatches[p];
    const result = await upsertMod.upsertVisualDoc({
      doc_id: docId,
      page,
      patches,
      payload: {
        lane,
        source: parsed.file.filename || "upload.bin",
        source_hint: sourceHint || null,
        image_sha256: imageSha,
        content_type: parsed.file.contentType || "application/octet-stream",
      },
    });
    upsertResults.push(result);
    if (result.ok) {
      patchesIndexed += patches.length;
    } else {
      // Qdrant backpressure: surface immediately. Partial ingest is honest about what landed.
      return sendError(res, 502, "QDRANT_UPSERT_FAILED", result.error || "qdrant upsert failed", {
        doc_id: docId,
        page_failed: page,
        pages_succeeded: p,
      });
    }
  }

  // 3. Write a Reality-lane visual event (one per ingest; summary is structural).
  try {
    eventMod.writeVisualEvent({
      image_sha256: imageSha,
      qdrant_doc_id: docId,
      page: 0,
      cortex_model: "none/ingest-only",
      cortex_response: {
        summary: `Ingested ${pageCount} page(s) from ${parsed.file.filename || "upload"} into lane=${lane}.`,
        entities: sourceHint ? [sourceHint] : [],
        files: [parsed.file.filename || "upload.bin"],
        commands: [],
        risk: "low",
        next_action: "wait for query",
        confidence: 1,
      },
      patch_grounding: [],
      frontier_used: false,
      fluxRoot: AE_FLUX_ROOT,
    });
  } catch (err) {
    // Non-fatal: index succeeded, but Reality lane append failed. Tell the caller honestly.
    return sendJson(res, 207, {
      doc_id: docId,
      pages_ingested: pageCount,
      patches_indexed: patchesIndexed,
      image_sha256: imageSha,
      visual_event_written: false,
      warning: `visual-event writer failed: ${err.message}`,
    });
  }

  return sendJson(res, 200, {
    doc_id: docId,
    pages_ingested: pageCount,
    patches_indexed: patchesIndexed,
    image_sha256: imageSha,
    visual_event_written: true,
  });
}

/**
 * POST /v1/visual/query
 *   json: { query: string, top_k?: number = 8, lane?: string|string[]|null }
 *
 *   200 -> { results: [{doc_id, page, score, payload, patch_grounding}], stand_in, note? }
 *   400 invalid input
 *   503 Qdrant / Ollama embedder unreachable
 */
async function handleQuery(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendError(res, err.status || 400, err.code || "READ_BODY_FAILED", err.message); }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return sendError(res, 400, "QUERY_REQUIRED", "query (non-empty string) required");
  }
  let topK = Number.isInteger(body.top_k) ? body.top_k : 8;
  if (topK < 1) topK = 1;
  if (topK > 64) topK = 64;

  const lane = body.lane ?? null;
  if (lane !== null && lane !== undefined) {
    const laneArr = Array.isArray(lane) ? lane : [lane];
    for (const l of laneArr) {
      if (typeof l !== "string" || !ALLOWED_LANES.has(l)) {
        return sendError(res, 400, "INVALID_LANE", `lane must be one of: ${[...ALLOWED_LANES].join(", ")}`);
      }
    }
  }

  let queryMod;
  try { queryMod = await loadQuery(); }
  catch (err) { return sendError(res, err.status || 503, err.code || "QUERY_LOAD_FAILED", err.message); }

  let out;
  try {
    out = await queryMod.queryMaxSim({
      queryText: query,
      topK,
      laneFilter: lane,
    });
  } catch (err) {
    return sendError(res, 502, "QUERY_FAILED", err.message);
  }

  if (!out.ok) {
    // Distinguish embedder-unreachable from qdrant-unreachable in the message.
    const status = /Ollama unreachable/i.test(out.error || "") || /Qdrant unreachable/i.test(out.error || "")
      ? 503
      : 502;
    return sendError(res, status, "QUERY_FAILED", out.error || "query failed", {
      stand_in: out.stand_in,
    });
  }

  const results = (out.hits || []).map((h) => ({
    doc_id: h.payload?.doc_id || null,
    page: h.payload?.page ?? null,
    score: h.score,
    payload: h.payload || {},
    // patch_grounding: not emitted by Night-1 query path (block-pooled stand-in
    // has no per-patch attribution). Surface an empty array honestly; Phase-2
    // ColQwen2.5 query embeddings will fill this in.
    patch_grounding: [],
  }));

  return sendJson(res, 200, {
    results,
    stand_in: out.stand_in,
    note: out.note || null,
  });
}

/**
 * POST /v1/visual/describe
 *   json:
 *     EITHER { doc_id: string, page?: number }
 *     OR     { image_url: string }   (image data URL or loopback URL)
 *     plus   { prompt?: string, deep?: boolean, allow_frontier?: boolean, max_tokens?: number, model?: string }
 *
 *   200 -> { answer, grounding, cortex_model, frontier_used, frontier_model? }
 *   400 invalid input
 *   503 Ollama / gateway-self / qdrant unreachable
 */
async function handleDescribe(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendError(res, err.status || 400, err.code || "READ_BODY_FAILED", err.message); }

  const hasDoc = typeof body.doc_id === "string" && body.doc_id.length > 0;
  const hasUrl = typeof body.image_url === "string" && body.image_url.length > 0;
  if (!hasDoc && !hasUrl) {
    return sendError(res, 400, "TARGET_REQUIRED", "provide either {doc_id, page?} or {image_url}");
  }
  if (hasDoc && hasUrl) {
    return sendError(res, 400, "TARGET_AMBIGUOUS", "provide exactly one of {doc_id} or {image_url}");
  }

  const deepFlag = Boolean(body.deep);
  const userPrompt = typeof body.prompt === "string" && body.prompt.trim()
    ? body.prompt.trim()
    : "Describe what is shown. List entities, files, commands. Return JSON with keys: summary, entities, files, commands, risk, next_action, confidence (0..1).";

  // --- Resolve target into an inline base64 image when possible ---
  // For Night-1 the gateway does not re-render Qdrant pages back into images
  // (the source asset lives on the operator's disk and the Reality lane has
  // the SHA, not the bytes). So {doc_id} mode runs the cortex with text-only
  // grounding pulled from Qdrant payload, and {image_url} mode passes bytes.
  let imageB64 = null;
  let grounding = null;
  let imageSha = null;

  if (hasUrl) {
    try {
      imageB64 = await fetchImageB64(body.image_url);
      imageSha = createHash("sha256").update(Buffer.from(imageB64, "base64")).digest("hex");
    } catch (err) {
      return sendError(res, err.status || 502, err.code || "IMAGE_FETCH_FAILED", err.message);
    }
  } else {
    // Doc-id mode: look up Qdrant payload for prompt context.
    let queryMod;
    try { queryMod = await loadQuery(); }
    catch (err) { return sendError(res, err.status || 503, err.code || "QUERY_LOAD_FAILED", err.message); }

    // Use the doc title / source as the query text to retrieve the actual point.
    // This is a Night-1 hack: a real implementation would expose a points/get
    // call. We surface enough info for the cortex to be useful.
    const lookup = await queryMod.queryMaxSim({
      queryText: body.doc_id,
      topK: 8,
      laneFilter: null,
    }).catch((err) => ({ ok: false, hits: [], error: err.message }));

    const hits = (lookup.hits || []).filter((h) => h.payload?.doc_id === body.doc_id);
    const requestedPage = Number.isInteger(body.page) ? body.page : null;
    const match = requestedPage != null
      ? hits.find((h) => Number(h.payload?.page) === requestedPage)
      : hits[0];
    if (!match) {
      return sendError(res, 404, "DOC_NOT_FOUND",
        `no point found for doc_id=${body.doc_id}${requestedPage != null ? ` page=${requestedPage}` : ""}`);
    }
    grounding = {
      doc_id: match.payload?.doc_id,
      page: match.payload?.page,
      lane: match.payload?.lane,
      source: match.payload?.source,
      source_hint: match.payload?.source_hint,
    };
    imageSha = match.payload?.image_sha256 || null;
  }

  // --- Local cortex pass ---
  let cortexOut;
  try {
    const prompt = grounding
      ? `${userPrompt}\n\nContext:\n${JSON.stringify(grounding, null, 2)}`
      : userPrompt;
    const requestedMaxTokens = Number(body.max_tokens ?? 256);
    const maxTokens = Number.isFinite(requestedMaxTokens)
      ? Math.max(32, Math.min(Math.trunc(requestedMaxTokens), 1024))
      : 256;
    cortexOut = await callLocalCortex({
      prompt,
      images: imageB64 ? [imageB64] : [],
      maxTokens,
    });
  } catch (err) {
    return sendError(res, err.status || 502, err.code || "CORTEX_FAILED", err.message);
  }

  const localConfidence = Number(cortexOut.cortex?.confidence ?? 0);
  const cortexModelUsed = cortexOut.model_used || CORTEX_MODEL;
  const layoutComplex = Boolean(cortexOut.cortex?.layout_complexity_high);
  const tokenBudgetExceeded = Boolean(cortexOut.cortex?.token_budget_exceeded);

  const shouldOffload = body.allow_frontier !== false && (
    deepFlag
      || layoutComplex
      || tokenBudgetExceeded
      || localConfidence < CONFIDENCE_THRESHOLD
  );

  let answer = cortexOut.cortex;
  let frontierUsed = false;
  let frontierModel = null;

  if (shouldOffload) {
    try {
      const offload = await callFrontierViaGateway({
        prompt: grounding
          ? `${userPrompt}\n\nContext:\n${JSON.stringify(grounding, null, 2)}`
          : userPrompt,
        imageB64,
        model: body.model,
        authorization: req.headers["authorization"],
      });
      answer = offload.answer;
      frontierUsed = true;
      frontierModel = offload.model_used;
    } catch (err) {
      // Honest: local cortex result still available, but the deep pass failed.
      return sendJson(res, 207, {
        answer,
        grounding,
        cortex_model: cortexModelUsed,
        frontier_used: false,
        frontier_error: err.message,
        note: "local cortex result returned; frontier offload failed",
      });
    }
  }

  // --- Reality lane record (best-effort) ---
  if (imageSha) {
    try {
      const eventMod = await loadVisualEvent();
      eventMod.writeVisualEvent({
        image_sha256: imageSha,
        qdrant_doc_id: hasUrl ? `inline-${imageSha.slice(0, 16)}` : body.doc_id,
        page: Number.isInteger(body.page) ? body.page : 0,
        cortex_model: cortexModelUsed,
        cortex_response: {
          summary: typeof answer?.summary === "string" ? answer.summary.slice(0, 4000) : "(describe)",
          entities: Array.isArray(answer?.entities) ? answer.entities : [],
          files: Array.isArray(answer?.files) ? answer.files : [],
          commands: [],
          risk: answer?.risk || "low",
          next_action: answer?.next_action || "respond",
          confidence: Number.isFinite(answer?.confidence) ? answer.confidence : localConfidence,
        },
        patch_grounding: [],
        frontier_used: frontierUsed,
        frontier_model: frontierModel || undefined,
        fluxRoot: AE_FLUX_ROOT,
      });
    } catch (_) {
      // Don't fail describe just because the ledger append did. The frontier
      // call already counts as an event the operator will see in receipts upstream.
    }
  }

  return sendJson(res, 200, {
    answer,
    grounding,
    cortex_model: cortexModelUsed,
    cortex_route: cortexOut.ollama_url,
    cortex_fallback_used: cortexModelUsed !== CORTEX_MODEL,
    cortex_primary_error: cortexOut.primary_error || null,
    frontier_used: frontierUsed,
    frontier_model: frontierModel,
  });
}

// --- Phase-2: ColPali queue proxies ----------------------------------------
//
// The colpali-service exposes /enqueue, /queue, /queue/:id on the same loopback
// host as /ingest. We forward through the gateway instead of letting callers
// hit the service directly so all visual surface stays under /v1/visual/*.

async function proxyJson(method, downstreamPath, body) {
  let res, text;
  try {
    res = await fetch(`${COLPALI_URL}${downstreamPath}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (err) {
    const e = new Error(`ColPali service unreachable at ${COLPALI_URL}: ${err.message}`);
    e.code = "COLPALI_UNREACHABLE";
    e.status = 503;
    throw e;
  }
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch (err) {
      const e = new Error(`ColPali returned non-JSON for ${downstreamPath}: ${err.message}`);
      e.code = "COLPALI_BAD_RESPONSE";
      e.status = 502;
      throw e;
    }
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

/**
 * POST /v1/visual/ingest/batch
 *   json: { paths: string[], lane?, source_hint?, kind? }
 *
 *   202 -> { ids:number[], status:'queued', count:number, items:[{id,path,kind,exists,size}] }
 *   400 invalid input (empty array, relative path, unknown extension)
 *   503 colpali-service unreachable
 *
 * Notes:
 *   - lane / source_hint are accepted and echoed back in the gateway response
 *     so the Vault caller can correlate, but they are NOT stored on the queue
 *     row itself. The runner stamps them onto the Qdrant payload at drain time
 *     by re-reading them from the result_json (see colpali-service runner).
 *     Until that wiring lands, we surface them in the response as an
 *     authoritative echo so the caller knows what they asked for.
 *   - The gateway does NOT pre-stat each path. The downstream /enqueue does a
 *     soft-existence check and returns { exists, size } per item; we pass that
 *     through verbatim.
 */
async function handleIngestBatch(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendError(res, err.status || 400, err.code || "READ_BODY_FAILED", err.message); }

  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    return sendError(res, 400, "PATHS_REQUIRED",
      "paths (non-empty array of absolute file paths) required");
  }
  if (body.paths.length > 1000) {
    return sendError(res, 400, "PATHS_TOO_MANY",
      `paths exceeds cap (got ${body.paths.length}, max 1000)`);
  }
  for (const p of body.paths) {
    if (typeof p !== "string" || p.length === 0) {
      return sendError(res, 400, "PATH_INVALID",
        "every entry in paths must be a non-empty string");
    }
  }

  const lane = body.lane != null ? String(body.lane).trim() : "doc";
  if (!ALLOWED_LANES.has(lane)) {
    return sendError(res, 400, "INVALID_LANE", `lane must be one of: ${[...ALLOWED_LANES].join(", ")}`);
  }
  const sourceHint = typeof body.source_hint === "string" ? body.source_hint.slice(0, 256) : null;

  // Downstream payload: colpali-service /enqueue accepts {paths, kind?}.
  const downstreamBody = { paths: body.paths };
  if (typeof body.kind === "string") downstreamBody.kind = body.kind;

  let down;
  try { down = await proxyJson("POST", "/enqueue", downstreamBody); }
  catch (err) { return sendError(res, err.status || 502, err.code || "COLPALI_FAILED", err.message); }

  if (!down.ok) {
    // Forward the downstream error verbatim — the colpali-service already
    // produces JSON errors with shape { error, offending_path? }.
    return sendJson(res, down.status, {
      error: {
        type: "visual_error",
        code: down.body?.error ? "COLPALI_REJECTED" : "COLPALI_HTTP_ERROR",
        message: down.body?.error || `colpali /enqueue returned ${down.status}`,
        ...(down.body || {}),
      },
    });
  }

  return sendJson(res, 202, {
    ids: down.body?.ids || [],
    status: down.body?.status || "queued",
    count: down.body?.count || (down.body?.ids?.length ?? 0),
    items: down.body?.items || [],
    lane,
    source_hint: sourceHint,
  });
}

/**
 * GET /v1/visual/queue        — list queue rows + summary counts
 *   query: status=queued|running|done|error|cancelled, limit, offset
 *   200 -> { counts, in_flight_id, rows }
 *
 * GET /v1/visual/queue/:id    — fetch one queue row by id
 *   200 -> { ...row, result, kind }
 *   404 if no such id
 */
async function handleQueueList(req, res) {
  const u = new URL(req.url, "http://127.0.0.1");
  const qs = u.searchParams.toString();
  const downstreamPath = qs ? `/queue?${qs}` : "/queue";
  let down;
  try { down = await proxyJson("GET", downstreamPath); }
  catch (err) { return sendError(res, err.status || 502, err.code || "COLPALI_FAILED", err.message); }
  if (!down.ok) {
    return sendJson(res, down.status, {
      error: {
        type: "visual_error",
        code: "COLPALI_HTTP_ERROR",
        message: down.body?.error || `colpali /queue returned ${down.status}`,
      },
    });
  }
  return sendJson(res, 200, down.body || { counts: {}, rows: [] });
}

async function handleQueueGet(req, res, id) {
  if (!/^\d+$/.test(id)) {
    return sendError(res, 400, "INVALID_ID", `queue id must be a positive integer, got: ${id}`);
  }
  let down;
  try { down = await proxyJson("GET", `/queue/${encodeURIComponent(id)}`); }
  catch (err) { return sendError(res, err.status || 502, err.code || "COLPALI_FAILED", err.message); }
  if (down.status === 404) {
    return sendError(res, 404, "QUEUE_ROW_NOT_FOUND", `no such queue id: ${id}`);
  }
  if (!down.ok) {
    return sendJson(res, down.status, {
      error: {
        type: "visual_error",
        code: "COLPALI_HTTP_ERROR",
        message: down.body?.error || `colpali /queue/${id} returned ${down.status}`,
      },
    });
  }
  return sendJson(res, 200, down.body || {});
}

async function handleQueueDelete(req, res, id) {
  if (!/^\d+$/.test(id)) {
    return sendError(res, 400, "INVALID_ID", `queue id must be a positive integer, got: ${id}`);
  }
  let down;
  try { down = await proxyJson("DELETE", `/queue/${encodeURIComponent(id)}`); }
  catch (err) { return sendError(res, err.status || 502, err.code || "COLPALI_FAILED", err.message); }
  return sendJson(res, down.status, down.body || {});
}

// --- Phase-2: video-frame extractor ----------------------------------------
//
// Temporal video ingest splits the clip into still frames at a fixed interval,
// writes them to a temp dir, and enqueues every frame as a separate row in the
// colpali queue. We deliberately do NOT block the response on drain — the
// caller gets back the frame ids and polls /v1/visual/queue to watch progress.
//
// Why ffmpeg and not a Bun/Node decoder?
//   - ffmpeg is already on every Orange5 box (used by the recording lane).
//   - Pure-Node MP4 decoders either ship as WASM (slow) or pin native deps
//     (heavy). ffmpeg's `-vf fps=` is the standard, well-understood path.
//   - We rely ONLY on the binary's exit code and the resulting filenames; no
//     stdout parsing, no progress scraping. Anything fancier becomes fragile.

function spawnBin(bin, args, { timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, code: -1, signal: null, stdout: "", stderr: String(err.message || err) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) { /* already dead */ }
    }, timeoutMs);
    child.stdout?.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, signal: null, stdout, stderr: stderr || String(err.message || err) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, signal, stdout, stderr });
    });
  });
}

/**
 * POST /v1/visual/video/ingest
 *   json: {
 *     path: string,            // absolute path to video file
 *     interval_sec?: number,   // sample every N seconds (default 2.0, min 0.1, max 3600)
 *     max_frames?: number,     // cap output (default 600)
 *     lane?: string,           // ALLOWED_LANES; default 'video-frame'
 *     source_hint?: string,    // free-form context
 *   }
 *
 *   202 -> {
 *     video_path, frames_extracted, frames_dir,
 *     ids:number[], status:'queued', count, items:[...],
 *     lane, source_hint, interval_sec, took_ms
 *   }
 *   400 invalid input (missing path, bad interval, no ffmpeg)
 *   404 video file does not exist
 *   500 ffmpeg crashed mid-extract
 *   503 ffmpeg/ffprobe not on PATH, or colpali-service unreachable
 *
 * Frame filenames follow `frame-%06d.png` so they sort lexically in time order.
 * The temp dir is *not* cleaned up by this handler — the queue runner owns the
 * file until ingest finishes, and the operator's cleanup cron sweeps stale
 * directories under os.tmpdir()/orangeeye-frames-* (out of scope here).
 */
async function handleVideoIngest(req, res) {
  const t0 = Date.now();
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendError(res, err.status || 400, err.code || "READ_BODY_FAILED", err.message); }

  const videoPath = typeof body.path === "string" ? body.path : "";
  if (!videoPath) {
    return sendError(res, 400, "PATH_REQUIRED", "path (absolute string to video file) required");
  }
  if (!path.isAbsolute(videoPath)) {
    return sendError(res, 400, "PATH_NOT_ABSOLUTE", `path must be absolute, got: ${videoPath}`);
  }
  if (!existsSync(videoPath)) {
    return sendError(res, 404, "VIDEO_NOT_FOUND", `no such file: ${videoPath}`);
  }
  let sourceSize = null;
  try { sourceSize = statSync(videoPath).size; } catch { /* race-tolerant */ }

  const interval = body.interval_sec != null ? Number(body.interval_sec) : VIDEO_INTERVAL_DEFAULT_SEC;
  if (!Number.isFinite(interval) || interval < VIDEO_INTERVAL_MIN_SEC || interval > VIDEO_INTERVAL_MAX_SEC) {
    return sendError(res, 400, "INTERVAL_OUT_OF_RANGE",
      `interval_sec must be in [${VIDEO_INTERVAL_MIN_SEC}, ${VIDEO_INTERVAL_MAX_SEC}], got ${body.interval_sec}`);
  }
  const fps = 1 / interval; // ffmpeg -vf fps= expects frames-per-second

  let maxFrames = body.max_frames != null ? Number(body.max_frames) : VIDEO_FRAME_LIMIT_DEFAULT;
  if (!Number.isInteger(maxFrames) || maxFrames < 1) {
    return sendError(res, 400, "MAX_FRAMES_INVALID", `max_frames must be a positive integer`);
  }
  if (maxFrames > 1000) maxFrames = 1000; // colpali enqueue batch ceiling

  const lane = body.lane != null ? String(body.lane).trim() : "video-frame";
  if (!ALLOWED_LANES.has(lane)) {
    return sendError(res, 400, "INVALID_LANE", `lane must be one of: ${[...ALLOWED_LANES].join(", ")}`);
  }
  const sourceHint = typeof body.source_hint === "string" ? body.source_hint.slice(0, 256) : null;

  // Allocate a unique temp dir for this extract. mkdtempSync atomically creates
  // os.tmpdir()/orangeeye-frames-<random>/ — we use that exact prefix so the
  // operator's cleanup pass can scope its sweep.
  let framesDir;
  try {
    framesDir = mkdtempSync(path.join(os.tmpdir(), "orangeeye-frames-"));
  } catch (err) {
    return sendError(res, 500, "TMPDIR_FAILED", `mkdtemp failed: ${err.message}`);
  }

  // ffmpeg arg notes:
  //   -y               : overwrite (defensive; dir is fresh, but PATH races happen)
  //   -i <video>       : input
  //   -vf fps=<rate>   : sample at fixed wall-clock rate. NOT keyframe-based —
  //                      we want temporally-uniform sampling, not whatever the
  //                      encoder chose to mark as I-frames.
  //   -vsync vfr       : drop duplicates rather than stuffing same frames in
  //   -frames:v <cap>  : hard cap so a long clip can't blow past max_frames
  //   -loglevel error  : silence the banner; only real errors hit stderr
  //   <out_pattern>    : %06d → up to 999999 frames; cap keeps us far below that
  const outPattern = path.join(framesDir, "frame-%06d.png");
  const ffArgs = [
    "-y",
    "-i", videoPath,
    "-vf", `fps=${fps}`,
    "-vsync", "vfr",
    "-frames:v", String(maxFrames),
    "-loglevel", "error",
    outPattern,
  ];

  const ff = await spawnBin(FFMPEG_BIN, ffArgs);
  if (!ff.ok) {
    // ENOENT from spawn() comes back as code -1 with a "spawn ffmpeg" stderr.
    const looksMissing = ff.code === -1 && /spawn .* ENOENT|not recognized|not found/i.test(ff.stderr);
    return sendError(
      res,
      looksMissing ? 503 : 500,
      looksMissing ? "FFMPEG_MISSING" : "FFMPEG_FAILED",
      `ffmpeg exit=${ff.code} signal=${ff.signal || "-"}: ${ff.stderr.slice(0, 500) || "(no stderr)"}`,
      { frames_dir: framesDir },
    );
  }

  // Collect the produced frames in natural order. ffmpeg already wrote them as
  // frame-000001.png … frame-NNNNNN.png so a lex sort is correct.
  let frameNames;
  try {
    frameNames = readdirSync(framesDir).filter((n) => /^frame-\d{6,}\.png$/.test(n)).sort();
  } catch (err) {
    return sendError(res, 500, "FRAMES_READ_FAILED", `readdir failed: ${err.message}`);
  }
  if (frameNames.length === 0) {
    return sendError(res, 500, "NO_FRAMES_PRODUCED",
      `ffmpeg returned ok but produced no frames in ${framesDir} — interval too large for clip length?`,
      { frames_dir: framesDir });
  }
  const framePaths = frameNames.map((n) => path.join(framesDir, n));

  // Enqueue the batch. We pass kind:'image' explicitly — the frames are PNGs
  // and we don't want colpali-service to sniff and second-guess them.
  let down;
  try {
    down = await proxyJson("POST", "/enqueue", { paths: framePaths, kind: "image" });
  } catch (err) {
    return sendError(res, err.status || 502, err.code || "COLPALI_FAILED", err.message, {
      frames_dir: framesDir,
      frames_extracted: framePaths.length,
    });
  }
  if (!down.ok) {
    return sendJson(res, down.status, {
      error: {
        type: "visual_error",
        code: "COLPALI_REJECTED",
        message: down.body?.error || `colpali /enqueue returned ${down.status}`,
        frames_dir: framesDir,
        frames_extracted: framePaths.length,
        ...(down.body || {}),
      },
    });
  }

  return sendJson(res, 202, {
    video_path: videoPath,
    video_size_bytes: sourceSize,
    interval_sec: interval,
    frames_extracted: framePaths.length,
    frames_dir: framesDir,
    ids: down.body?.ids || [],
    status: down.body?.status || "queued",
    count: down.body?.count || (down.body?.ids?.length ?? 0),
    items: down.body?.items || [],
    lane,
    source_hint: sourceHint,
    took_ms: Date.now() - t0,
  });
}

// --- Public registration ----------------------------------------------------
//
// The gateway's index.mjs uses an if-ladder over (method, path). We expose a
// registerVisualRoutes(server) entrypoint that wraps the same pattern so the
// operator can splice in a single line. We also export the bare handlers so
// the server can call them directly if it prefers.

export const VISUAL_ROUTE_TABLE = Object.freeze([
  { method: "POST", path: "/v1/visual/ingest",        handler: handleIngest },
  { method: "POST", path: "/v1/visual/ingest/batch",  handler: handleIngestBatch },
  { method: "POST", path: "/v1/visual/query",         handler: handleQuery },
  { method: "POST", path: "/v1/visual/describe",      handler: handleDescribe },
  { method: "GET",  path: "/v1/visual/queue",         handler: handleQueueList },
  { method: "POST", path: "/v1/visual/video/ingest",  handler: handleVideoIngest },
]);

// Routes that match by prefix and pull an id segment off the tail. Kept
// separate from the flat table so the existing exact-match find() stays simple.
const VISUAL_PREFIX_ROUTES = Object.freeze([
  { method: "GET",    prefix: "/v1/visual/queue/", handler: handleQueueGet },
  { method: "DELETE", prefix: "/v1/visual/queue/", handler: handleQueueDelete },
]);

function matchPrefixRoute(method, pathName) {
  for (const r of VISUAL_PREFIX_ROUTES) {
    if (r.method !== method) continue;
    if (!pathName.startsWith(r.prefix)) continue;
    const tail = pathName.slice(r.prefix.length);
    if (!tail || tail.includes("/")) continue; // single segment only
    return { handler: r.handler, id: decodeURIComponent(tail) };
  }
  return null;
}

export function registerVisualRoutes(server) {
  if (!server || typeof server.on !== "function") {
    throw new Error("registerVisualRoutes(server): expected a Node http.Server");
  }
  server.on("request", async (req, res) => {
    // If a prior listener already wrote, do nothing.
    if (res.headersSent || res.writableEnded) return;
    const method = (req.method || "").toUpperCase();
    const pathName = (req.url || "").split("?")[0];

    const exact = VISUAL_ROUTE_TABLE.find((r) => r.method === method && r.path === pathName);
    if (exact) {
      try {
        await exact.handler(req, res);
      } catch (err) {
        console.error(`[visual] unhandled ${method} ${pathName}:`, err);
        sendError(res, 500, "INTERNAL_ERROR", err.message || "internal error");
      }
      return;
    }

    const prefixed = matchPrefixRoute(method, pathName);
    if (prefixed) {
      try {
        await prefixed.handler(req, res, prefixed.id);
      } catch (err) {
        console.error(`[visual] unhandled ${method} ${pathName}:`, err);
        sendError(res, 500, "INTERNAL_ERROR", err.message || "internal error");
      }
      return;
    }
    // not ours; let other listeners or the default 404 handle it
  });
}

export const __handlers = {
  handleIngest,
  handleIngestBatch,
  handleQuery,
  handleDescribe,
  handleQueueList,
  handleQueueGet,
  handleQueueDelete,
  handleVideoIngest,
};
