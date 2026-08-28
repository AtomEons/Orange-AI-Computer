#!/usr/bin/env node
// N150 utility embedder — HTTP daemon entrypoint.
// Path: 06-ORANGELLM/n150-utility/embedder/server.mjs
//
// Exposes a tiny HTTP surface on N150_EMBEDDER_HOST:N150_EMBEDDER_PORT:
//   POST /embed        { text, model? }                  -> { embedding, model, dim }
//   POST /embed/batch  { inputs, chunk?, model? }        -> [{ ok, embedding?, error? }, ...]
//   POST /admin/swap   { model }                         -> hotSwapModel() result
//   GET  /healthz                                        -> pool.stats()
//   GET  /readyz                                         -> 200 if at least one /api/tags probe succeeded
//
// Why this exists and stays small:
//   - Graph Weaver and the lane classifier call this via loopback. No public
//     network exposure. Hardening enforced by the systemd unit.
//   - The pool module owns all behavior. This file is the HTTP shim.
//   - Wave 1 doctrine: STOCK ONLY. The /admin/swap route flips between stock
//     tags (e.g. nomic-embed-text:v1.5 <-> nomic-embed-text:latest) only;
//     callers cannot inject arbitrary fine-tuned weights because the pool
//     validates against /api/tags before flipping.
//
// Run standalone:
//   node server.mjs

import { createServer } from "node:http";
import { pool } from "./pool.mjs";

const HOST = process.env.N150_EMBEDDER_HOST ?? "127.0.0.1";
const PORT = Number(process.env.N150_EMBEDDER_PORT ?? 8798);

const p = pool();

function send(res, status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-AE-Host": "n150",
    "X-AE-Lane": "utility-embedder",
  });
  res.end(text);
}

async function readJson(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        reject(new Error("payload_too_large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      return send(res, 200, p.stats());
    }
    if (req.method === "GET" && req.url === "/readyz") {
      // Cheap readiness: stats() always works; pool may not yet have run a call.
      const s = p.stats();
      return send(res, s.state === "open" ? 200 : 503, { ready: s.state === "open", state: s.state });
    }
    if (req.method === "POST" && req.url === "/embed") {
      const body = await readJson(req);
      if (typeof body.text !== "string" || body.text.length === 0) {
        return send(res, 400, { error: "text_required" });
      }
      const out = await p.embed(body.text, body.model);
      return send(res, 200, out);
    }
    if (req.method === "POST" && req.url === "/embed/batch") {
      const body = await readJson(req);
      if (!Array.isArray(body.inputs)) {
        return send(res, 400, { error: "inputs_must_be_array" });
      }
      const out = await p.embedBatch(body.inputs, { chunk: body.chunk, perCallModel: body.model });
      return send(res, 200, out);
    }
    if (req.method === "POST" && req.url === "/admin/swap") {
      const body = await readJson(req);
      if (typeof body.model !== "string" || body.model.length === 0) {
        return send(res, 400, { error: "model_required" });
      }
      const out = await p.hotSwapModel(body.model);
      return send(res, 200, out);
    }
    return send(res, 404, { error: "not_found", path: req.url });
  } catch (err) {
    const msg = err?.message ?? String(err);
    const status = /queue_timeout/.test(msg) ? 503
      : /invalid_json|payload_too_large|required/.test(msg) ? 400
      : /pool_closed/.test(msg) ? 503
      : 500;
    return send(res, status, { error: msg });
  }
});

server.listen(PORT, HOST, () => {
  // Structured stdout line for journald/log shippers.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    evt: "n150_embedder_listening",
    host: HOST,
    port: PORT,
    model: p.currentModel(),
    ts: new Date().toISOString(),
  }));
});

// Graceful shutdown for systemd TimeoutStopSec.
function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ evt: "n150_embedder_shutdown", signal, ts: new Date().toISOString() }));
  server.close(async () => {
    await p.close();
    process.exit(0);
  });
  // Hard exit after 40s if close hangs (systemd will SIGKILL at 45s).
  setTimeout(() => process.exit(0), 40_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
