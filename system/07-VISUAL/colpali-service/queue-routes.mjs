// OrangeEye Phase-2 — HTTP routes for the persistent ingest queue.
//
// Extends server.mjs without rewriting it. server.mjs already owns the
// per-request /ingest path (synchronous, one file in -> patches out). This
// module adds the async/batched path that the Vault lane needs so a folder
// of 200 PDFs doesn't try to stampede ColQwen2.5 through a single python
// spawn.
//
// Wiring (server.mjs Phase-2 patch, conceptually):
//   import { openQueue } from "./queue.mjs";
//   import { mountQueueRoutes } from "./queue-routes.mjs";
//   const queue = openQueue({ runner: ingestRunner });
//   queue.start();
//   const routes = mountQueueRoutes({ queue });
//   // inside Bun.serve fetch():
//   const handled = await routes.handle(req, url);
//   if (handled) return handled;
//
// Endpoints (all loopback-only, inherits the 127.0.0.1 bind from server.mjs):
//
//   POST   /enqueue          body: { "path": "<abs>", "kind"?: "image"|"pdf"|"video" }
//                            body: { "paths": ["<abs>", ...] }   (batch form)
//                          -> 202 { id, status, kind } | { ids[], status, count }
//
//   GET    /queue            ?status=queued|running|done|error|cancelled
//                            &limit=N (1..1000, default 100)
//                            &offset=N
//                          -> 200 { counts: {...}, rows: [row, ...] }
//
//   GET    /queue/:id      -> 200 { ...row, result: <parsed result_json or null> }
//                            404 if no such id
//
//   DELETE /queue/:id      -> 200 { id, cancelled: true }   (was queued)
//                            409 { id, cancelled: false, status }   (already running/done/error)
//                            404 if no such id
//
// Surfacing to the Vault lane:
//   - Vault polls GET /queue with no filter (or status=running,queued separately)
//     for the dashboard. counts.* drives the progress chip; rows[].path + status
//     drive the file list.
//   - On a 202 from /enqueue, Vault stores the id and polls GET /queue/:id every
//     ~1s until status leaves {queued,running}. Result is then in `.result`.
//
// Quality contract (Mom's Law):
//   - JSON in, JSON out. No HTML, no leaked stack traces, no theatrical errors.
//   - Validate every input. Path must be absolute (this is loopback-only, but
//     we still reject relative paths so a misconfigured caller can't accidentally
//     enqueue $PWD-relative junk that resolves differently at drain time).
//   - The router itself does NO Python spawn, NO file IO beyond an existence
//     hint at enqueue time. All heavy work happens in the queue runner.
//   - `kind` is currently informational metadata (stored in the result_json
//     downstream by the runner; the queue table itself stays kind-agnostic).
//     Phase-2 sniffs kind from extension if not provided; image/pdf/video
//     vocabularies are the only ones accepted. Unknown extensions get rejected
//     here so the Python worker isn't burned on garbage.

import { isAbsolute } from "node:path";
import { existsSync, statSync } from "node:fs";

const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif",
]);
const PDF_EXT = new Set([".pdf"]);
const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
]);

function extOf(p) {
  const i = p.lastIndexOf(".");
  if (i < 0) return "";
  return p.slice(i).toLowerCase();
}

function sniffKind(path) {
  const e = extOf(path);
  if (IMAGE_EXT.has(e)) return "image";
  if (PDF_EXT.has(e)) return "pdf";
  if (VIDEO_EXT.has(e)) return "video";
  return null;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Decorate a raw queue row with a parsed `result` (from result_json) and a
 * sniffed `kind` so callers don't have to re-derive it. Never throws — bad
 * JSON in result_json comes back as `result: null` plus `result_parse_error`.
 */
function decorate(row) {
  if (!row) return null;
  const out = { ...row };
  out.kind = sniffKind(row.path);
  if (row.result_json) {
    try {
      out.result = JSON.parse(row.result_json);
    } catch (e) {
      out.result = null;
      out.result_parse_error = e.message;
    }
  } else {
    out.result = null;
  }
  return out;
}

/**
 * Parse and validate a single path + optional kind. Throws on bad input with
 * a `.status` so the route handler can map to 400/415 cleanly.
 */
function validatePath(path, kindHint) {
  if (typeof path !== "string" || path.length === 0) {
    const err = new Error("path required (non-empty string)");
    err.status = 400;
    throw err;
  }
  if (!isAbsolute(path)) {
    const err = new Error(`path must be absolute, got: ${path}`);
    err.status = 400;
    throw err;
  }
  const kind = kindHint || sniffKind(path);
  if (!kind) {
    const err = new Error(
      `unknown kind for ${path} — supported extensions: ` +
      `${[...IMAGE_EXT, ...PDF_EXT, ...VIDEO_EXT].join(",")}`
    );
    err.status = 415;
    throw err;
  }
  if (!["image", "pdf", "video"].includes(kind)) {
    const err = new Error(`invalid kind "${kind}" — expected image|pdf|video`);
    err.status = 400;
    throw err;
  }
  // Soft existence check. We do NOT hard-fail on a missing file at enqueue
  // time because queue is durable and the file may land before drain. But we
  // do warn the caller in the response so Vault can flag it in the UI.
  let exists = false;
  let size = null;
  if (existsSync(path)) {
    exists = true;
    try { size = statSync(path).size; } catch { /* race-tolerant */ }
  }
  return { path, kind, exists, size };
}

/**
 * Mount queue HTTP routes onto a shared router object the Bun.serve handler
 * can delegate to. Returns `{ handle(req, url) }` — handle resolves to a
 * Response if the request matched a queue route, or `null` if it didn't (so
 * server.mjs can fall through to /ingest / /health / 404).
 *
 * @param {object} opts
 * @param {object} opts.queue   - instance returned by openQueue()
 * @param {(line: string) => void} [opts.log] - optional logger (defaults to console.log)
 */
export function mountQueueRoutes({ queue, log } = {}) {
  if (!queue || typeof queue.enqueue !== "function") {
    throw new Error("mountQueueRoutes: queue instance required");
  }
  const logLine = typeof log === "function"
    ? log
    : (s) => console.log(`[colpali:routes] ${s}`);

  async function handleEnqueue(req) {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return json(400, { error: `invalid JSON body: ${e.message}` });
    }
    if (!body || typeof body !== "object") {
      return json(400, { error: "JSON object body required" });
    }

    // Batch form takes precedence if both are present — explicit beats implicit.
    if (Array.isArray(body.paths)) {
      if (body.paths.length === 0) {
        return json(400, { error: "paths array must be non-empty" });
      }
      if (body.paths.length > 1000) {
        return json(400, { error: `paths too long (${body.paths.length} > 1000)` });
      }
      const validated = [];
      for (const p of body.paths) {
        try {
          validated.push(validatePath(p, body.kind));
        } catch (e) {
          return json(e.status || 400, {
            error: e.message,
            offending_path: p,
          });
        }
      }
      let result;
      try {
        result = queue.enqueueBatch(validated.map((v) => v.path));
      } catch (e) {
        logLine(`enqueueBatch failed: ${e.message}`);
        return json(500, { error: e.message });
      }
      logLine(`enqueued batch n=${result.ids.length}`);
      return json(202, {
        ids: result.ids,
        status: result.status,
        count: result.ids.length,
        items: validated.map((v, i) => ({
          id: result.ids[i],
          path: v.path,
          kind: v.kind,
          exists: v.exists,
          size: v.size,
        })),
      });
    }

    // Single-path form.
    let v;
    try {
      v = validatePath(body.path, body.kind);
    } catch (e) {
      return json(e.status || 400, { error: e.message });
    }
    let result;
    try {
      result = queue.enqueue(v.path);
    } catch (e) {
      logLine(`enqueue failed: ${e.message}`);
      return json(500, { error: e.message });
    }
    logLine(`enqueued id=${result.id} kind=${v.kind} path=${v.path}`);
    return json(202, {
      id: result.id,
      status: result.status,
      kind: v.kind,
      path: v.path,
      exists: v.exists,
      size: v.size,
    });
  }

  function handleList(url) {
    const status = url.searchParams.get("status") || undefined;
    const limitRaw = url.searchParams.get("limit");
    const offsetRaw = url.searchParams.get("offset");
    const opts = {};
    if (status) opts.status = status;
    if (limitRaw !== null) {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n < 1 || n > 1000) {
        return json(400, { error: `limit out of range (1..1000), got ${limitRaw}` });
      }
      opts.limit = n;
    }
    if (offsetRaw !== null) {
      const n = Number(offsetRaw);
      if (!Number.isFinite(n) || n < 0) {
        return json(400, { error: `offset must be >= 0, got ${offsetRaw}` });
      }
      opts.offset = n;
    }
    let rows;
    try {
      rows = queue.list(opts);
    } catch (e) {
      return json(400, { error: e.message });
    }
    return json(200, {
      counts: queue.counts(),
      in_flight_id: queue.inFlightId ?? null,
      rows: rows.map(decorate),
    });
  }

  function handleGet(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      return json(400, { error: `invalid id: ${id}` });
    }
    const row = queue.get(n);
    if (!row) return json(404, { error: `no such id: ${n}` });
    return json(200, decorate(row));
  }

  function handleDelete(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      return json(400, { error: `invalid id: ${id}` });
    }
    const row = queue.get(n);
    if (!row) return json(404, { error: `no such id: ${n}` });
    if (row.status !== "queued") {
      // Cancellation is intentionally only allowed for queued rows. A running
      // row would require killing the python worker mid-spawn, which risks a
      // half-written Qdrant upsert. Done/error/cancelled are terminal.
      return json(409, {
        id: n,
        cancelled: false,
        status: row.status,
        reason: `cannot cancel a row in status "${row.status}" (only queued rows)`,
      });
    }
    const ok = queue.cancel(n);
    if (!ok) {
      // Lost the race — another caller cancelled or the drain loop just claimed
      // it between our get() and cancel(). Re-read to tell the truth.
      const fresh = queue.get(n);
      return json(409, {
        id: n,
        cancelled: false,
        status: fresh ? fresh.status : "unknown",
        reason: "row was claimed or cancelled by another caller",
      });
    }
    logLine(`cancelled id=${n}`);
    return json(200, { id: n, cancelled: true });
  }

  /**
   * Route dispatcher. Returns a Response if the request matched a queue route,
   * otherwise null (so the caller can fall through to its own handlers).
   */
  async function handle(req, url) {
    const path = url.pathname;
    const method = req.method;

    if (method === "POST" && path === "/enqueue") {
      return handleEnqueue(req);
    }
    if (method === "GET" && path === "/queue") {
      return handleList(url);
    }
    // /queue/:id (GET or DELETE). Match strictly to avoid eating /queue/foo/bar.
    const m = path.match(/^\/queue\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === "GET") return handleGet(id);
      if (method === "DELETE") return handleDelete(id);
      return json(405, { error: `method ${method} not allowed on /queue/:id` });
    }

    return null;
  }

  return { handle };
}

// Exported for tests + for the Phase-2 runner module that needs to classify
// files before dispatching to the image / PDF-page-split / video-frame paths.
export const _internals = {
  IMAGE_EXT,
  PDF_EXT,
  VIDEO_EXT,
  sniffKind,
  validatePath,
  decorate,
};
