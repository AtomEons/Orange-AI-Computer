#!/usr/bin/env node
// upsert.mjs
// OrangeEye Phase-1 — write a single multi-vector page point into 'orange5-vision'.
//
// One Qdrant point = one page (or one frame / screenshot / chart / whiteboard image).
// `patches` is the matrix of ColPali-style patch embeddings for that page.
//
// Shape contract:
//   upsertVisualDoc({
//     doc_id,                    // stable id of the source document/asset
//     page,                      // 1-based page number (1 for single-image lanes)
//     patches,                   // number[][]  — N patches x 128 dims, Int/uint8 values 0..255
//     payload,                   // object — lane, source, ingested_at, sha256, etc.
//     point_id,                  // optional — caller-provided UUID; otherwise we derive one
//     qdrantUrl, collection,     // optional overrides
//   }) -> { ok, point_id, status, error? }
//
// Notes Night-1:
//   - We don't enforce 196 patches; ColQwen2.5 emits variable counts depending on page geometry.
//     We do enforce: 1 <= patches.length <= 1024 and every row.length === 128.
//   - We coerce floats to uint8 if the caller passes float patches (0..1 scale) — but we warn.
//   - Frontier-Isolation Law: this script never reaches outside QDRANT_URL.

import crypto from "node:crypto";

const DEFAULT_QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const DEFAULT_COLLECTION = process.env.ORANGE5_VISION_COLLECTION || "orange5-vision";
const VECTOR_DIM = 128;
const MAX_PATCHES = 1024;
const REQUIRED_PAYLOAD_KEYS = ["lane", "source"]; // ingested_at filled if absent

function deriveDeterministicPointId(doc_id, page) {
  // Qdrant requires unsigned int or UUID. Derive a stable UUIDv5-like from sha256(doc_id|page).
  const h = crypto.createHash("sha256").update(`${doc_id}|${page}`).digest("hex");
  // Format as 8-4-4-4-12 (16 bytes / 32 hex) — Qdrant accepts any UUID-shaped string.
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

function validatePatches(patches) {
  if (!Array.isArray(patches) || patches.length === 0) {
    return { ok: false, error: "patches must be a non-empty array" };
  }
  if (patches.length > MAX_PATCHES) {
    return { ok: false, error: `patches.length=${patches.length} exceeds MAX_PATCHES=${MAX_PATCHES}` };
  }
  let needsCoerce = false;
  for (let i = 0; i < patches.length; i++) {
    const row = patches[i];
    if (!Array.isArray(row) || row.length !== VECTOR_DIM) {
      return { ok: false, error: `patches[${i}] must be length ${VECTOR_DIM}, got ${row?.length}` };
    }
    for (let j = 0; j < VECTOR_DIM; j++) {
      const v = row[j];
      if (typeof v !== "number" || Number.isNaN(v)) {
        return { ok: false, error: `patches[${i}][${j}] is not a finite number` };
      }
      if (v < 0 || v > 255 || !Number.isInteger(v)) {
        needsCoerce = true;
      }
    }
  }
  return { ok: true, needsCoerce };
}

function coercePatchesToUint8(patches) {
  // Caller passed something float-shaped. Assume in [0,1]; map to [0,255]. Out-of-range gets clamped.
  return patches.map((row) =>
    row.map((v) => {
      if (Number.isInteger(v) && v >= 0 && v <= 255) return v;
      const scaled = v <= 1 && v >= 0 ? Math.round(v * 255) : Math.round(v);
      return Math.max(0, Math.min(255, scaled));
    })
  );
}

export async function upsertVisualDoc({
  doc_id,
  page,
  patches,
  payload,
  point_id,
  qdrantUrl = DEFAULT_QDRANT_URL,
  collection = DEFAULT_COLLECTION,
  silent = false,
} = {}) {
  // Argument hygiene.
  if (!doc_id || typeof doc_id !== "string") {
    return { ok: false, error: "doc_id (string) required" };
  }
  if (!Number.isInteger(page) || page < 1) {
    return { ok: false, error: "page must be a positive integer (1-based)" };
  }
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "payload object required" };
  }
  for (const k of REQUIRED_PAYLOAD_KEYS) {
    if (!payload[k]) return { ok: false, error: `payload.${k} required` };
  }

  const v = validatePatches(patches);
  if (!v.ok) return { ok: false, error: v.error };
  let vectors = patches;
  if (v.needsCoerce) {
    if (!silent) console.warn("[upsert] non-uint8 patches detected; coercing into 0..255");
    vectors = coercePatchesToUint8(patches);
  }

  const id = point_id || deriveDeterministicPointId(doc_id, page);
  const fullPayload = {
    doc_id,
    page,
    ingested_at: payload.ingested_at || new Date().toISOString(),
    ...payload,
  };

  const body = {
    points: [
      {
        id,
        vector: vectors, // multi-vector: array of arrays — Qdrant accepts this when collection is multi-vector
        payload: fullPayload,
      },
    ],
  };

  let res, text;
  try {
    res = await fetch(`${qdrantUrl}/collections/${collection}/points?wait=true`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (err) {
    return { ok: false, point_id: id, error: `Qdrant unreachable: ${err.message}` };
  }

  if (!res.ok) {
    return { ok: false, point_id: id, status: res.status, error: `Qdrant ${res.status}: ${text}` };
  }

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* tolerate empty */ }
  const opStatus = parsed?.result?.status || "ok";

  return { ok: true, point_id: id, status: opStatus };
}

// CLI smoke-test:
//   echo '{"doc_id":"smoke","page":1,"patches":[[0,0,...]],"payload":{"lane":"doc","source":"smoke.pdf"}}' | node upsert.mjs
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("upsert.mjs")) {
  const isMain = process.argv[1] && process.argv[1].endsWith("upsert.mjs");
  if (isMain) {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", async () => {
      if (!buf.trim()) {
        console.error("upsert.mjs: pipe a JSON object on stdin (see header for shape).");
        process.exit(2);
      }
      let arg;
      try { arg = JSON.parse(buf); } catch (e) {
        console.error("upsert.mjs: invalid JSON on stdin:", e.message);
        process.exit(2);
      }
      const out = await upsertVisualDoc(arg);
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
    });
  }
}
