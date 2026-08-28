// OrangeEye Phase-2 — ColPali / ColQwen2.5 ingestion service.
//
// Bun HTTP server, loopback-only on 127.0.0.1:7440.
// POST /ingest accepts multipart/form-data with field "file" (image or PDF).
// The server sniffs the bytes and dispatches to one of two Python workers:
//
//   - python/colqwen_ingest.py  — single still image (PNG/JPEG/WebP)
//   - python/pdf_ingest.py      — multi-page PDF (Phase-2; Poppler required)
//
// Both workers load vidore/colqwen2-v1.0 and emit Int8 patch embeddings
// (196 patches × 128 dims per page). Bun stays resident; Python is one-shot
// per ingest call.
//
// Response shape:
//   image: { doc_id, page_count: 1, patches: Int8[][][], image_sha256,
//            backend, took_ms }
//   pdf:   { doc_id, page_count: N, patches: Int8[][][],
//            pages: [{page,width,height,sha256}, ...],
//            image_sha256 (== sha of the uploaded PDF bytes),
//            backend, took_ms }
//
// OpenVINO loader switch
// ----------------------
// At boot we look for an IR cache produced by python/openvino_convert.py at
// `$COLPALI_OPENVINO_DIR` (default /opt/atomeons/colqwen2-openvino/). If
// openvino_model.xml + openvino_model.bin + conversion_receipt.json are all
// present, we set COLPALI_USE_OPENVINO=1 on the Python child env so
// pdf_ingest.py and colqwen_ingest.py prefer the OV path (device=AUTO routes
// across CPU + NPU on Codexa's Intel Core Ultra 9 285H). If anything is
// missing or COLPALI_FORCE_TRANSFORMERS=1, we fall back to the transformers
// reference implementation. Either way, the chosen backend tag is surfaced
// on /health and echoed into the /ingest response so the caller can log it.
//
// Hard limits:
//   - 50 MB upload cap (configurable via env COLPALI_MAX_BYTES)
//   - 180 s Python timeout (env COLPALI_TIMEOUT_MS)
//   - bind 127.0.0.1 only — Frontier-Isolation Law forbids external surface
//
// What this does NOT do (yet — see queue.mjs and temporal video worker):
//   - no batched queue: that lives in queue.mjs and is wired in by the
//     Phase-2 `/enqueue` endpoint (separate change).
//   - no Qdrant write — caller is responsible for upserting patches.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { openQueue } from "./queue.mjs";
import { mountQueueRoutes } from "./queue-routes.mjs";
import { ResidentImageWorker } from "./resident-image-worker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_IMAGE_SCRIPT = process.env.COLPALI_IMAGE_SCRIPT || join(HERE, "python", "colqwen_ingest.py");
const PY_PDF_SCRIPT = process.env.COLPALI_PDF_SCRIPT || join(HERE, "python", "pdf_ingest.py");
const PY_RESIDENT_IMAGE_SCRIPT = process.env.COLPALI_RESIDENT_SCRIPT || join(HERE, "python", "resident_image_worker.py");
const PY_BIN = process.env.COLPALI_PYTHON || (process.platform === "win32" ? "python" : "python3");

const HOST = "127.0.0.1";
const PORT = Number(process.env.COLPALI_PORT || 7440);
const MAX_BYTES = Number(process.env.COLPALI_MAX_BYTES || 50 * 1024 * 1024);
const TIMEOUT_MS = Number(process.env.COLPALI_TIMEOUT_MS || 180_000);
const RESIDENT_ENABLED = process.env.COLPALI_RESIDENT_WORKER !== "0";
const QUEUE_DB = process.env.COLPALI_QUEUE_DB || join(
  homedir(), "OrangeBox-Data", "orange5", "ae-eyes-queue.db"
);

// OpenVINO loader switch — resolved once at boot.
const OPENVINO_DIR =
  process.env.COLPALI_OPENVINO_DIR || (process.platform === "win32"
    ? join(homedir(), "OrangeBox-Data", "models", "colqwen2-openvino")
    : "/opt/atomeons/colqwen2-openvino");
const OPENVINO_DEVICE = process.env.COLPALI_OPENVINO_DEVICE || "AUTO";
const FORCE_TRANSFORMERS = process.env.COLPALI_FORCE_TRANSFORMERS === "1";
const TORCH_DEVICE = (process.env.COLPALI_TORCH_DEVICE || "auto").toLowerCase();
const MODEL_ID = process.env.COLPALI_MODEL_ID || "vidore/colqwen2-v1.0-hf";
const BACKEND = resolveBackend();

for (const script of [PY_IMAGE_SCRIPT, PY_PDF_SCRIPT, PY_RESIDENT_IMAGE_SCRIPT]) {
  if (!existsSync(script)) {
    console.error(`[colpali] FATAL: python script missing at ${script}`);
    process.exit(2);
  }
}

/**
 * Decide whether to prefer the OpenVINO IR at boot.
 *
 * Returns one of:
 *   { kind: "openvino", dir, device, receipt }  — IR detected, will be used
 *   { kind: "transformers", reason }            — fall back, with cause
 *
 * The decision is sticky for the life of the process — re-converting the IR
 * requires a service restart so the loader picks up the new receipt.
 */
function resolveBackend() {
  if (FORCE_TRANSFORMERS) {
    return { kind: "transformers", reason: "COLPALI_FORCE_TRANSFORMERS=1" };
  }
  try {
    const xml = join(OPENVINO_DIR, "openvino_model.xml");
    const bin = join(OPENVINO_DIR, "openvino_model.bin");
    const receiptPath = join(OPENVINO_DIR, "conversion_receipt.json");
    for (const p of [xml, bin, receiptPath]) {
      if (!existsSync(p)) {
        return {
          kind: "transformers",
          reason: `missing ${p} (run python/openvino_convert.py to build it)`,
        };
      }
    }
    // Refuse a zero-byte IR — that indicates a crashed previous export.
    const binStat = statSync(bin);
    if (binStat.size === 0) {
      return { kind: "transformers", reason: `${bin} is zero bytes` };
    }
    let receipt = null;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    } catch (e) {
      return {
        kind: "transformers",
        reason: `conversion_receipt.json unreadable: ${e.message}`,
      };
    }
    if (!receipt || receipt.schema !== "atomeons.colpali.openvino_receipt.v1") {
      return {
        kind: "transformers",
        reason: `receipt schema mismatch (got ${receipt && receipt.schema})`,
      };
    }
    return {
      kind: "openvino",
      dir: OPENVINO_DIR,
      device: OPENVINO_DEVICE,
      receipt,
    };
  } catch (e) {
    return { kind: "transformers", reason: `probe failed: ${e.message}` };
  }
}

/** Env overlay the Python child inherits, including OV hints if applicable. */
function pythonEnv() {
  const env = {
    ...process.env,
    HF_HOME: process.env.HF_HOME || (process.platform === "win32"
      ? join(homedir(), "OrangeBox-Data", "models", "huggingface")
      : "/var/lib/colpali/hf"),
    TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE || "0",
    COLPALI_MODEL_ID: MODEL_ID,
  };
  if (BACKEND.kind === "openvino") {
    env.COLPALI_USE_OPENVINO = "1";
    env.COLPALI_OPENVINO_DIR = BACKEND.dir;
    env.COLPALI_OPENVINO_DEVICE = BACKEND.device;
  } else {
    // Make sure a stale env on the parent doesn't bleed through and trick
    // the Python worker into trying to load a non-existent IR.
    env.COLPALI_USE_OPENVINO = "0";
  }
  return env;
}

/** Best-effort backend tag for response bodies / logs. */
function backendTag() {
  return BACKEND.kind === "openvino"
    ? `openvino:${BACKEND.device}`
    : TORCH_DEVICE === "xpu" ? "transformers:xpu" : "transformers:cpu";
}

const residentWorker = RESIDENT_ENABLED
  ? new ResidentImageWorker({
      command: PY_BIN,
      script: PY_RESIDENT_IMAGE_SCRIPT,
      env: pythonEnv(),
      startupTimeoutMs: TIMEOUT_MS,
      requestTimeoutMs: TIMEOUT_MS,
    })
  : null;

if (residentWorker) {
  residentWorker.start().catch((error) => {
    console.error(`[colpali] resident worker warmup failed; one-shot fallback remains available: ${error.message}`);
  });
}

/** Run a Python ingest worker with the given bytes on stdin.
 *
 * `script` is the absolute path of one of PY_IMAGE_SCRIPT / PY_PDF_SCRIPT.
 * The child inherits the OpenVINO loader hints from `pythonEnv()`.
 */
function runOneShotPython(script, bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY_BIN, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: pythonEnv(),
    });

    let stdout = Buffer.alloc(0);
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`python timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (c) => { stdout = Buffer.concat([stdout, c]); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`python exit ${code}: ${stderr.slice(0, 4000)}`));
      }
      try {
        const parsed = JSON.parse(stdout.toString("utf8"));
        resolve(parsed);
      } catch (e) {
        reject(new Error(`bad python output: ${e.message}\nstderr: ${stderr.slice(0, 2000)}`));
      }
    });

    child.stdin.on("error", (err) => {
      // EPIPE if python crashed before reading; let "close" handler resolve the
      // real error from exit code + stderr.
      if (err.code !== "EPIPE" && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.stdin.end(bytes);
  });
}

async function runPython(script, bytes) {
  if (script === PY_IMAGE_SCRIPT && residentWorker) {
    try {
      return await residentWorker.request(bytes);
    } catch (error) {
      console.error(`[colpali] resident worker request failed; using one-shot fallback: ${error.message}`);
    }
  }
  return runOneShotPython(script, bytes);
}

async function ingestPath(row) {
  const bytes = readFileSync(row.path);
  if (bytes.length === 0) throw new Error(`queued file is empty: ${row.path}`);
  if (bytes.length > MAX_BYTES) throw new Error(`queued file too large: ${bytes.length} > ${MAX_BYTES}`);
  const isPdf = bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  const py = await runPython(isPdf ? PY_PDF_SCRIPT : PY_IMAGE_SCRIPT, bytes);
  if (!py || !Array.isArray(py.patches)) throw new Error("python returned no patches");
  return {
    path: row.path,
    page_count: py.page_count ?? (isPdf ? py.patches.length : 1),
    patches: py.patches,
    pages: Array.isArray(py.pages) ? py.pages : undefined,
    image_sha256: createHash("sha256").update(bytes).digest("hex"),
    backend: backendTag(),
    worker: isPdf ? "one-shot-pdf" : (residentWorker ? "resident-image" : "one-shot-image"),
  };
}

const queue = openQueue({ dbPath: QUEUE_DB, runner: ingestPath });
const queueRoutes = mountQueueRoutes({ queue });
queue.start();

/** Validate multipart, pull the first "file" field. Returns {bytes, name}. */
async function readUpload(req) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().startsWith("multipart/form-data")) {
    const err = new Error("expected multipart/form-data");
    err.status = 415;
    throw err;
  }
  let form;
  try {
    form = await req.formData();
  } catch (e) {
    const err = new Error(`multipart parse failed: ${e.message}`);
    err.status = 400;
    throw err;
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    const err = new Error('missing "file" field');
    err.status = 400;
    throw err;
  }
  if (file.size > MAX_BYTES) {
    const err = new Error(`file too large: ${file.size} > ${MAX_BYTES}`);
    err.status = 413;
    throw err;
  }
  const ab = await file.arrayBuffer();
  const bytes = Buffer.from(ab);
  if (bytes.length === 0) {
    const err = new Error("empty file");
    err.status = 400;
    throw err;
  }
  return { bytes, name: file.name || "upload.bin" };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  // 50 MB Bun max body — matches MAX_BYTES default.
  maxRequestBodySize: MAX_BYTES,

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, {
        ok: true,
        service: "colpali-ingest",
        host: HOST,
        port: PORT,
        py_image_script: PY_IMAGE_SCRIPT,
        py_pdf_script: PY_PDF_SCRIPT,
        max_bytes: MAX_BYTES,
        timeout_ms: TIMEOUT_MS,
        backend: backendTag(),
        resident_worker: residentWorker?.status() ?? { state: "disabled" },
        queue: { db: QUEUE_DB, ...queue.counts(), in_flight_id: queue.inFlightId ?? null },
        backend_detail:
          BACKEND.kind === "openvino"
            ? {
                kind: "openvino",
                dir: BACKEND.dir,
                device: BACKEND.device,
                model_id: BACKEND.receipt?.model_id,
                dtype: BACKEND.receipt?.dtype,
                created_utc: BACKEND.receipt?.created_utc,
                ir_bin_sha256: BACKEND.receipt?.ir_bin_sha256,
              }
            : { kind: "transformers", reason: BACKEND.reason },
      });
    }

    const queueResponse = await queueRoutes.handle(req, url);
    if (queueResponse) return queueResponse;

    if (req.method !== "POST" || url.pathname !== "/ingest") {
      return jsonResponse(404, { error: "not found" });
    }

    const t0 = Date.now();
    let upload;
    try {
      upload = await readUpload(req);
    } catch (e) {
      return jsonResponse(e.status || 400, { error: e.message });
    }

    const image_sha256 = createHash("sha256").update(upload.bytes).digest("hex");
    const doc_id = randomUUID();

    // Sniff %PDF- so multi-page docs go to pdf_ingest.py (Phase-2).
    const isPdf =
      upload.bytes.length >= 5 &&
      upload.bytes[0] === 0x25 && // %
      upload.bytes[1] === 0x50 && // P
      upload.bytes[2] === 0x44 && // D
      upload.bytes[3] === 0x46 && // F
      upload.bytes[4] === 0x2d;   // -
    const script = isPdf ? PY_PDF_SCRIPT : PY_IMAGE_SCRIPT;

    let py;
    try {
      py = await runPython(script, upload.bytes);
    } catch (e) {
      const msg = String(e.message || e);
      // OOM, model load fail, decode fail all surface as 5xx with the stderr
      // tail so the caller can log it. Loopback-only — no leak risk.
      const lower = msg.toLowerCase();
      let status = 500;
      if (
        lower.includes("could not decode") ||
        lower.includes("unidentified image") ||
        lower.includes("decode_fail")
      ) status = 422;
      if (lower.includes("pdf_too_large") || lower.includes("pdf_empty")) status = 422;
      if (lower.includes("poppler_missing")) status = 500;
      if (lower.includes("timeout")) status = 504;
      if (lower.includes("out of memory") || lower.includes("oom")) status = 503;
      return jsonResponse(status, {
        error: msg,
        doc_id,
        image_sha256,
        backend: backendTag(),
        kind: isPdf ? "pdf" : "image",
      });
    }

    if (!py || !Array.isArray(py.patches)) {
      return jsonResponse(500, {
        error: "python returned no patches",
        doc_id,
        image_sha256,
        backend: backendTag(),
      });
    }

    const body = {
      doc_id,
      page_count: py.page_count ?? (isPdf ? py.patches.length : 1),
      patches: py.patches,
      image_sha256,
      backend: backendTag(),
      kind: isPdf ? "pdf" : "image",
      took_ms: Date.now() - t0,
    };
    // PDF worker also returns per-page metadata; pass it through verbatim.
    if (isPdf && Array.isArray(py.pages)) body.pages = py.pages;
    return jsonResponse(200, body);
  },

  error(err) {
    console.error("[colpali] server error:", err);
    return jsonResponse(500, { error: String(err.message || err) });
  },
});

console.log(`[colpali] listening on http://${server.hostname}:${server.port}`);
console.log(`[colpali] python=${PY_BIN}`);
console.log(`[colpali]   image-script=${PY_IMAGE_SCRIPT}`);
console.log(`[colpali]   pdf-script  =${PY_PDF_SCRIPT}`);
console.log(`[colpali] max_bytes=${MAX_BYTES} timeout_ms=${TIMEOUT_MS}`);
console.log(`[colpali] resident_worker=${RESIDENT_ENABLED ? "enabled" : "disabled"} queue_db=${QUEUE_DB}`);
if (BACKEND.kind === "openvino") {
  console.log(
    `[colpali] backend=openvino dir=${BACKEND.dir} device=${BACKEND.device} ` +
    `dtype=${BACKEND.receipt?.dtype} ir_sha=${(BACKEND.receipt?.ir_bin_sha256 || "").slice(0, 12)}`
  );
} else {
  console.log(`[colpali] backend=transformers reason=${BACKEND.reason}`);
}

// Clean shutdown so systemd stop is graceful.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log(`[colpali] ${sig} received, stopping`);
    server.stop(false);
    await queue.stop();
    queue.close();
    await residentWorker?.stop();
    process.exit(0);
  });
}
