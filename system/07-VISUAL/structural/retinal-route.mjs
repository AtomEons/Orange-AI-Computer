// 07-VISUAL/structural/retinal-route.mjs
//
// Gateway handler for POST /v1/visual/retinal.
// Accepts two input shapes:
//   A. JSON  { raw_luminance: number[], meta: {...} }               (single frame)
//      JSON  { raw_luminance_frames: [number[]...], meta: {...} }   (sequence)
//   B. multipart image/video/*: uses ffmpeg to extract luminance,
//      then runs the transform.
//
// Response: ae.structural-tokens.v1 record.
// If ffmpeg is required and missing: 501 { ok:false, error:"..." }.
// Body cap: 25 MB (multipart), 4 MB (JSON).

import { Buffer } from "node:buffer";
import { transformImage, transformSequence } from "./retinal-transform.mjs";
import { checkFfmpeg, extractImageLuminance, extractSequenceLuminance } from "./luminance-ffmpeg.mjs";

const JSON_CAP = 4 * 1024 * 1024;     // 4 MB
const MULTIPART_CAP = 25 * 1024 * 1024; // 25 MB
const REQUIRES_FFMPEG = new Set(["image/", "video/"]);

export async function handleRetinalRoute(req) {
  const ct = (req.headers["content-type"] || "").toLowerCase();

  try {
    if (ct.includes("multipart/form-data")) {
      const bodyBuf = await readBinary(req, MULTIPART_CAP);
      const parts = parseMultipart(bodyBuf, ct);
      const file = parts.find((p) => p.filename);
      if (!file) return [400, { ok: false, error: "multipart body missing file part" }];
      const kind = file.contentType || "application/octet-stream";
      const isImage = kind.startsWith("image/");
      const isVideo = kind.startsWith("video/");
      if (!isImage && !isVideo) return [415, { ok: false, error: `unsupported media type: ${kind}` }];

      const ff = await checkFfmpeg();
      if (!ff.available) {
        return [501, { ok: false, error: "luminance extraction requires ffmpeg", reason: ff.reason }];
      }
      if (isImage) {
        const { data, width, height } = await extractImageLuminance(file.data);
        const rec = await transformImage({
          data,
          meta: { width, height, source_kind: pickField(parts, "source_kind") || "camera",
                  color_space: pickField(parts, "color_space") || "srgb",
                  channels: 1, grayscale: true, extracted_at_ms: 0 },
        });
        return [200, rec];
      }
      // video
      const seq = await extractSequenceLuminance(file.data);
      const rec = await transformSequence({
        frames: seq.frames,
        meta: {
          width: seq.width, height: seq.height,
          source_kind: pickField(parts, "source_kind") || "camera",
          color_space: pickField(parts, "color_space") || "srgb",
          channels: 1, grayscale: true,
          sample_rate_hz: seq.sample_rate_hz,
          extracted_at_ms: 0,
        },
      });
      return [200, rec];
    }

    if (ct.includes("application/json") || ct === "") {
      const body = await readJson(req, JSON_CAP);
      if (Array.isArray(body?.raw_luminance)) {
        const meta = body.meta || {};
        const data = new Uint8Array(body.raw_luminance);
        const rec = await transformImage({ data, meta });
        return [200, rec];
      }
      if (Array.isArray(body?.raw_luminance_frames)) {
        const meta = body.meta || {};
        const frames = body.raw_luminance_frames.map((arr, i) => ({
          data: new Uint8Array(arr),
          ts_ms: Number.isFinite(body?.ts_ms?.[i]) ? body.ts_ms[i] : (i * (meta.sample_rate_hz ? Math.round(1000 / meta.sample_rate_hz) : 33)),
        }));
        const rec = await transformSequence({ frames, meta });
        return [200, rec];
      }
      return [400, {
        ok: false,
        error: "JSON body must include raw_luminance (Uint8 array) or raw_luminance_frames (array of arrays) plus meta.{width,height}",
      }];
    }

    return [415, { ok: false, error: `unsupported content-type: ${ct}` }];
  } catch (e) {
    return [400, { ok: false, error: e.message }];
  }
}

// ---- Helpers --------------------------------------------------------------

function readBinary(req, cap) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > cap) { req.destroy(); return reject(new Error(`body > ${cap} bytes`)); }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readJson(req, cap) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > cap) { req.destroy(); return reject(new Error(`body > ${cap} bytes`)); }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        resolve(buf.length ? JSON.parse(buf.toString("utf8")) : {});
      } catch (e) { reject(new Error("invalid JSON body: " + e.message)); }
    });
    req.on("error", reject);
  });
}

/** Minimal RFC-7578 parser (single file + short text fields). */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error("multipart: no boundary");
  const boundary = "--" + (m[1] || m[2]).trim();
  const bBuf = Buffer.from(boundary);
  const parts = [];
  let idx = buf.indexOf(bBuf);
  if (idx < 0) throw new Error("multipart: first boundary not found");
  idx += bBuf.length;
  while (idx < buf.length) {
    // skip CRLF after boundary
    if (buf[idx] === 0x2d && buf[idx + 1] === 0x2d) break; // "--" trailer
    if (buf[idx] === 0x0d) idx += 2; else if (buf[idx] === 0x0a) idx += 1;
    // headers until CRLFCRLF
    const hdrEnd = buf.indexOf(Buffer.from("\r\n\r\n"), idx);
    const hdrTerm = hdrEnd < 0 ? buf.indexOf(Buffer.from("\n\n"), idx) : hdrEnd;
    if (hdrTerm < 0) break;
    const headers = buf.slice(idx, hdrTerm).toString("utf8");
    idx = hdrTerm + (hdrEnd < 0 ? 2 : 4);
    // next boundary
    const nextIdx = buf.indexOf(bBuf, idx);
    if (nextIdx < 0) break;
    // body excludes trailing CRLF
    let bodyEnd = nextIdx;
    if (buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    else if (buf[bodyEnd - 1] === 0x0a) bodyEnd -= 1;
    const bodyBuf = buf.slice(idx, bodyEnd);
    const disp = /Content-Disposition:\s*form-data;([^\r\n]+)/i.exec(headers);
    const cType = /Content-Type:\s*([^\r\n;]+)/i.exec(headers);
    let name = "", filename = "";
    if (disp) {
      const nm = /name="([^"]+)"/i.exec(disp[1]);
      const fn = /filename="([^"]*)"/i.exec(disp[1]);
      name = nm ? nm[1] : "";
      filename = fn ? fn[1] : "";
    }
    parts.push({
      name, filename,
      contentType: cType ? cType[1].trim() : "",
      data: bodyBuf,
    });
    idx = nextIdx + bBuf.length;
  }
  return parts;
}

function pickField(parts, name) {
  const p = parts.find((x) => x.name === name && !x.filename);
  if (!p) return null;
  return p.data.toString("utf8").trim();
}
