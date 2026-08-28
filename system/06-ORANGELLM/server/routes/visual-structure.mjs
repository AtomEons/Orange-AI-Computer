// AE OrangeLLM — /v1/visual/structure (M2 CODEC TRANSLATOR gateway route)
// Path: 06-ORANGELLM/server/routes/visual-structure.mjs
//
// This route is deliberately independent of routes/visual.mjs (M3 sibling
// pillar). M2 owns ONLY /v1/visual/structure. M3 (retinal) owns
// /v1/visual/retinal. Any existing /v1/visual/{ingest,query,describe} in
// routes/visual.mjs is not exposed at this gateway seam yet.
//
// Handler shape follows the retinal-route contract: (req) → [status, body].
// The gateway (server/index.mjs) reads the tuple and JSON-responds.
//
// Contract:
//   POST /v1/visual/structure
//     Content-Type: multipart/form-data
//     field: file       (video file, required)
//     field: source_id  (optional string, echoed into provenance.source_id)
//   →
//     200 { schema:"ae.structural-tokens.v1", ... }  translated record
//     400 { ok:false, error }                        bad request
//     413 { ok:false, error }                        body over 50 MB
//     501 { ok:false, error:"ffmpeg unavailable" }   Mom's-Law honest 501
//     500 { ok:false, error }                        translator crash
//
// Storage: this route is stateless. Returned record is the sole output.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { translateH264, probeFfmpegVersion } from "../../../07-VISUAL/structural/codec-translator.mjs";

const MAX_BYTES = Number(process.env.ORANGE5_VISUAL_STRUCTURE_MAX_BYTES || 50 * 1024 * 1024);

// --- HTTP body reader -------------------------------------------------------

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

// --- Minimal multipart parser (single file + short text fields) -------------

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

function parseMultipart(buf, boundary) {
  if (!boundary) throw Object.assign(new Error("missing multipart boundary"), { code: "MULTIPART_NO_BOUNDARY", status: 400 });
  const dash = Buffer.from(`--${boundary}`, "utf8");
  const crlf = Buffer.from("\r\n", "utf8");
  const headerSep = Buffer.from("\r\n\r\n", "utf8");

  const fields = {};
  let file = null;

  let pos = buf.indexOf(dash, 0);
  if (pos < 0) throw Object.assign(new Error("multipart: opening boundary not found"), { code: "MULTIPART_MALFORMED", status: 400 });

  while (pos >= 0) {
    const lineEnd = buf.indexOf(crlf, pos);
    if (lineEnd < 0) break;
    const after = buf.slice(pos + dash.length, lineEnd).toString("utf8");
    if (after.startsWith("--")) break;

    const partStart = lineEnd + crlf.length;
    const headerEnd = buf.indexOf(headerSep, partStart);
    if (headerEnd < 0) break;
    const rawHeaders = buf.slice(partStart, headerEnd).toString("utf8");
    const bodyStart = headerEnd + headerSep.length;
    const nextBoundary = buf.indexOf(dash, bodyStart);
    if (nextBoundary < 0) break;
    const bodyEnd = nextBoundary - crlf.length;
    if (bodyEnd < bodyStart) break;
    const bodyBuf = buf.slice(bodyStart, bodyEnd);

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

    if (filename) file = { name: name || "file", filename, contentType, bytes: bodyBuf };
    else if (name) fields[name] = bodyBuf.toString("utf8");

    pos = nextBoundary;
  }

  return { fields, file };
}

// --- The handler ------------------------------------------------------------

/**
 * Gateway handler for POST /v1/visual/structure.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<[number, object]>} [status, body]
 */
export async function handleVisualStructureRoute(req) {
  // ffmpeg availability check first — Mom's-Law 501 rather than 500.
  const ver = await probeFfmpegVersion();
  if (!ver) return [501, { ok: false, error: "ffmpeg unavailable" }];

  const ct = parseContentType(req.headers?.["content-type"] || "");
  if (ct.type !== "multipart/form-data") {
    return [400, { ok: false, error: "Content-Type must be multipart/form-data" }];
  }

  let raw;
  try {
    raw = await readRawBody(req, MAX_BYTES);
  } catch (e) {
    if (e.status === 413) return [413, { ok: false, error: `body too large (max ${MAX_BYTES} bytes)` }];
    return [400, { ok: false, error: e.message || "read error" }];
  }

  let parsed;
  try {
    parsed = parseMultipart(raw, ct.boundary);
  } catch (e) {
    return [e.status || 400, { ok: false, error: e.message }];
  }
  if (!parsed.file || !parsed.file.bytes || parsed.file.bytes.length === 0) {
    return [400, { ok: false, error: "multipart 'file' field required" }];
  }

  const tmp = mkdtempSync(path.join(tmpdir(), "ae-vis-struct-"));
  const inputPath = path.join(tmp, safeFilename(parsed.file.filename || "input.bin"));
  try {
    writeFileSync(inputPath, parsed.file.bytes);
    const record = await translateH264({
      path: inputPath,
      opts: { source_id: parsed.fields.source_id || undefined },
    });
    return [200, record];
  } catch (e) {
    if (e.code === "FFMPEG_UNAVAILABLE") return [501, { ok: false, error: "ffmpeg unavailable" }];
    return [500, { ok: false, error: e.message || "translator failed", code: e.code || "TRANSLATOR_ERROR" }];
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function safeFilename(name) {
  return String(name || "input.bin").replace(/[^A-Za-z0-9._\-]/g, "_").slice(0, 128);
}
