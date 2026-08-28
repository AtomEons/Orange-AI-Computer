#!/usr/bin/env node
// AE OrangeLLM — gateway server
// The ONLY legal door from frontier to Orange5.
// Native mode binds 127.0.0.1:1337. Docker mode may bind 0.0.0.0 inside
// the container while the host publish policy keeps the external boundary.

import { createServer } from "node:http";
import { URL } from "node:url";
import { boundary } from "./boundary.mjs";
import { handleV1ChatCompletions, handleV1Models } from "./routes/v1.mjs";
import { handleHealthz } from "./routes/healthz.mjs";
import { __memoryHandlers, createMemoryRouteConfig } from "./routes/memory.mjs";
import { dispatchCobra, isCobraPath } from "./routes/cobra.mjs";
import {
  startRailTokenWatcher,
  stopRailTokenWatcher,
} from "./middleware/rail-token-watcher.mjs";
import { dispatchGuardrails, isGuardrailsPath } from "./routes/guardrails.mjs";
import { completionToSse } from "./openai-sse.mjs";
import { startLearningQueueWorker, stopLearningQueueWorker } from "../../03-BACKEND/learning-queue.mjs";
import { startProjectContinuumWorker } from "../../03-BACKEND/project-continuum.mjs";
import { applyNodeLocalAppCors } from "../../03-BACKEND/local-app-cors.mjs";
import { handleOpsLearning, handleOpsTraces, OPS_LEARNING_PATH, OPS_TRACES_PATH } from "./routes/ops-observability.mjs";
import {
  PARTY_LINE_HYDRATE_PATH,
  PARTY_LINE_PATH,
  PARTY_LINE_STREAM_PATH,
  handlePartyLineGet,
  handlePartyLineHydrate,
  handlePartyLinePost,
  handlePartyLineStream,
} from "./routes/party-line.mjs";
import {
  handleBuildRuns,
  isBuildRunPath,
} from "./routes/build-runs.mjs";
import {
  TOOLMESH_LABS_PATH,
  TOOLMESH_SEARCH_PATH,
  handleToolmeshLabsList,
  handleToolmeshLabCards,
  handleToolmeshSearch,
  isToolmeshLabCardsPath,
} from "./routes/toolmesh.mjs";
import {
  HERMES_LEASE_PATH,
  HERMES_ACTION_PATH,
  HERMES_APPROVALS_PATH,
  HERMES_LEASE_REVOKE_RX,
  HERMES_UPSTREAM,
  handleHermesLease,
  handleHermesLeaseRevoke,
  handleHermesAction,
  handleHermesApprovals,
} from "./routes/hermes.mjs";
import {
  handleHermesMcp,
  isHermesMcpPath,
} from "./routes/hermes-mcp.mjs";
// M3 — AE Eyes retinal transform (Path 2). See
// 07-VISUAL/structural/retinal-transform.mjs and AE_STRUCTURAL_TOKENS_v1.md.
import { handleRetinalRoute } from "../../07-VISUAL/structural/retinal-route.mjs";
// M2 — AE Eyes codec translator (Path 1). See
// 07-VISUAL/structural/codec-translator.mjs and AE_STRUCTURAL_TOKENS_v1.md.
import { handleVisualStructureRoute } from "./routes/visual-structure.mjs";
import {
  VISUAL_ROUTE_TABLE,
  __handlers as visualHandlers,
} from "./routes/visual.mjs";

// ToolMesh routes share one lazy-loaded registry across the process; see
// 06-ORANGELLM/server/routes/toolmesh.mjs for the cache + fs.watch contract.
const TOOLMESH_CFG = { watch: true };
const TOOLMESH_LAB_CARDS_RX = /^\/v1\/toolmesh\/labs\/([a-z][a-z0-9-]{0,30})\/cards$/;
const HERMES_CFG = { upstream: HERMES_UPSTREAM };

const HOST = process.env.ORANGE5_ORANGELLM_HOST || "127.0.0.1";
const PORT = Number(process.env.ORANGE5_ORANGELLM_PORT || 1337);
const VERSION = "orange5.orangellm.v0.7.0-party-line";
const MEMORY_CFG = createMemoryRouteConfig();
const LEARNING_WORKER = startLearningQueueWorker();
const CONTINUUM_WORKER = startProjectContinuumWorker();
const RAIL_TOKEN_WATCHER = await startRailTokenWatcher();

function jsonResponse(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorResponse(res, message, status = 400) {
  jsonResponse(res, { error: { message, type: "invalid_request_error", code: status } }, status);
}

function sseResponse(res, completion, status = 200) {
  res.writeHead(status, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.end(completionToSse(completion));
}

function beginSseResponse(res, status = 200) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function writeSseChunk(res, chunk) {
  beginSseResponse(res);
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function finishLiveSse(res, completion, status = 200) {
  beginSseResponse(res, status);
  if (completion?.error) {
    res.write(`data: ${JSON.stringify(completion)}\n\n`);
  } else {
    const metadata = Object.fromEntries(
      Object.entries(completion || {}).filter(([key]) => key.startsWith('ae_'))
    );
    const choice = completion?.choices?.[0] || {};
    res.write(`data: ${JSON.stringify({
      id: completion?.id || `chatcmpl-orange-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: completion?.created || Math.floor(Date.now() / 1000),
      model: completion?.model || 'orange-auto',
      ...metadata,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }],
    })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

async function readBody(req, capBytes = 1_000_000) {
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
      try { resolve(buf.length ? JSON.parse(buf.toString("utf8")) : {}); }
      catch (e) { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const method = req.method.toUpperCase();
  const path = url.pathname;
  const corsOrigin = applyNodeLocalAppCors(req, res);

  if (method === "OPTIONS") {
    if (!corsOrigin) return errorResponse(res, "browser origin is not an allowed local Orange app", 403);
    res.writeHead(204);
    return res.end();
  }

  // Boundary check — runs FIRST on every request
  const guard = boundary({ method, path, headers: req.headers });
  if (guard.reject) {
    console.warn(`[boundary] REJECT ${method} ${path} :: ${guard.reason}`);
    return errorResponse(res, guard.reason, guard.status || 400);
  }

  try {
    if (method === "GET" && path === "/livez") {
      return jsonResponse(res, {
        status: "ok",
        service: "orangellm-gateway",
        version: VERSION,
        generated_at: new Date().toISOString(),
      });
    }
    if (method === "GET" && path === "/healthz") {
      return jsonResponse(res, await handleHealthz({ version: VERSION }));
    }
    if (method === "GET" && path === "/v1/models") {
      return jsonResponse(res, await handleV1Models());
    }
    if (method === "GET" && path === OPS_LEARNING_PATH) {
      const result = handleOpsLearning(url);
      return jsonResponse(res, result.body, result.status);
    }
    if (method === "GET" && path === OPS_TRACES_PATH) {
      const result = handleOpsTraces(url);
      return jsonResponse(res, result.body, result.status);
    }
    if (method === "GET" && path === PARTY_LINE_PATH) {
      const result = await handlePartyLineGet(url);
      return jsonResponse(res, result.body, result.status);
    }
    if (method === "POST" && path === PARTY_LINE_PATH) {
      const body = await readBody(req, 256 * 1024);
      const result = await handlePartyLinePost(body);
      return jsonResponse(res, result.body, result.status);
    }
    if (method === "GET" && path === PARTY_LINE_STREAM_PATH) {
      return handlePartyLineStream(req, res, url);
    }
    if (method === "POST" && path === PARTY_LINE_HYDRATE_PATH) {
      const body = await readBody(req, 256 * 1024);
      const result = await handlePartyLineHydrate(body);
      return jsonResponse(res, result.body, result.status);
    }
    if (isBuildRunPath(path)) {
      const body = method === 'POST' || method === 'PATCH'
        ? await readBody(req, 512 * 1024)
        : null;
      const result = await handleBuildRuns(method, url, body);
      return jsonResponse(res, result.body, result.status);
    }
    if (isCobraPath(path)) {
      const result = await dispatchCobra(req, url, { readBody });
      if (result) {
        const status = result._ae_http_status || 200;
        delete result._ae_http_status;
        return jsonResponse(res, result, status);
      }
    }
    if (method === "GET" && path === "/v1/memory/healthz") {
      return jsonResponse(res, await __memoryHandlers.handleMemoryHealth(MEMORY_CFG));
    }
    if (method === "POST" && path === "/v1/memory/state-brief") {
      const body = await readBody(req, 256 * 1024);
      const result = await __memoryHandlers.handleStateBrief(body, MEMORY_CFG);
      return jsonResponse(res, result.body, result.status);
    }
    if (method === "POST" && path === "/v1/memory/recall") {
      const body = await readBody(req, 256 * 1024);
      const result = await __memoryHandlers.handleRecall(body, MEMORY_CFG);
      return jsonResponse(res, result.body, result.status);
    }
    if (method === "POST" && path === "/v1/chat/completions") {
      const body = await readBody(req);
      let liveChunkWritten = false;
      const result = await handleV1ChatCompletions(body, {
        onStreamChunk: body.stream === true
          ? (chunk) => {
              liveChunkWritten = true;
              writeSseChunk(res, chunk);
            }
          : null,
      });
      const status = result._ae_http_status || 200;
      delete result._ae_http_status;
      const liveStreamed = result._ae_live_streamed === true;
      delete result._ae_live_streamed;
      if (body.stream === true && (liveStreamed || liveChunkWritten)) {
        return finishLiveSse(res, result, status);
      }
      if (body.stream === true && status === 200) return sseResponse(res, result, status);
      return jsonResponse(res, result, status);
    }
    if (method === "POST" && path === HERMES_LEASE_PATH) {
      const body = await readBody(req, 256 * 1024);
      const { status, body: result } = await handleHermesLease(body, HERMES_CFG);
      return jsonResponse(res, result, status);
    }
    if (method === "POST" && HERMES_LEASE_REVOKE_RX.test(path)) {
      const body = await readBody(req, 256 * 1024);
      const { status, body: result } = await handleHermesLeaseRevoke(path, body, HERMES_CFG);
      return jsonResponse(res, result, status);
    }
    if (method === "POST" && path === HERMES_ACTION_PATH) {
      const body = await readBody(req, 256 * 1024);
      const { status, body: result } = await handleHermesAction(body, HERMES_CFG);
      return jsonResponse(res, result, status);
    }
    if (method === "GET" && path === HERMES_APPROVALS_PATH) {
      const { status, body: result } = await handleHermesApprovals(HERMES_CFG);
      return jsonResponse(res, result, status);
    }
    if (method === "POST" && isHermesMcpPath(path)) {
      const body = await readBody(req, 256 * 1024);
      const { status, body: result } = await handleHermesMcp({ pathname: path, body });
      return jsonResponse(res, result, status);
    }
    // M3 — AE Eyes retinal transform. Streams the request body itself
    // (large multipart uploads bypass the 1 MB JSON cap in readBody).
    if (method === "POST" && path === "/v1/visual/retinal") {
      const [status, resultBody] = await handleRetinalRoute(req);
      return jsonResponse(res, resultBody, status);
    }
    // M2 — AE Eyes codec translator. Streams the request body itself
    // (multipart video uploads bypass the 1 MB JSON cap in readBody).
    if (method === "POST" && path === "/v1/visual/structure") {
      const [status, resultBody] = await handleVisualStructureRoute(req);
      return jsonResponse(res, resultBody, status);
    }
    // OrangeEye operational surface. These handlers own their request streams
    // so multipart uploads never pass through the generic 1 MB JSON reader.
    const visualRoute = VISUAL_ROUTE_TABLE.find(
      (route) => route.method === method && route.path === path,
    );
    if (visualRoute) {
      return await visualRoute.handler(req, res);
    }
    const visualQueueMatch = /^\/v1\/visual\/queue\/([^/]+)$/.exec(path);
    if (visualQueueMatch && (method === "GET" || method === "DELETE")) {
      const id = decodeURIComponent(visualQueueMatch[1]);
      return method === "GET"
        ? await visualHandlers.handleQueueGet(req, res, id)
        : await visualHandlers.handleQueueDelete(req, res, id);
    }
    // 27 Guardrails / Soul Genome / Continuity Packet — read+gated-write surface.
    if (isGuardrailsPath(path)) {
      const result = await dispatchGuardrails(req, url, { readBody });
      if (result) {
        const status = result._ae_http_status || 200;
        delete result._ae_http_status;
        return jsonResponse(res, result, status);
      }
    }
    // ToolMesh capability discovery (read-only). The boundary has already
    // confirmed reachability for these three GET routes; here we dispatch.
    if (method === "GET" && path === TOOLMESH_LABS_PATH) {
      const { status, body } = await handleToolmeshLabsList(TOOLMESH_CFG);
      return jsonResponse(res, body, status);
    }
    if (method === "GET" && path === TOOLMESH_SEARCH_PATH) {
      const { status, body } = await handleToolmeshSearch(url, TOOLMESH_CFG);
      return jsonResponse(res, body, status);
    }
    if (method === "GET" && isToolmeshLabCardsPath(path)) {
      const labMatch = TOOLMESH_LAB_CARDS_RX.exec(path);
      const labId = labMatch ? labMatch[1] : "";
      const { status, body } = await handleToolmeshLabCards(labId, url, TOOLMESH_CFG);
      return jsonResponse(res, body, status);
    }
    return errorResponse(res, `Not found: ${method} ${path}`, 404);
  } catch (err) {
    console.error(`[server] error on ${method} ${path}:`, err);
    return errorResponse(res, err.message || "internal error", 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[orangellm] listening on ${HOST}:${PORT} (${VERSION})`);
  console.log(`[orangellm] frontier-isolation law active`);
  console.log(`[orangellm] default: orange-auto deterministic conductor -> least sufficient live lane`);
  console.log(`[orangellm] upstream: smart-skinny @ http://127.0.0.1:8797 (PR-03 wired)`);
  console.log(`[orangellm] durable learning queue: ${LEARNING_WORKER.path}`);
  console.log(`[orangellm] rail token watcher: ${RAIL_TOKEN_WATCHER.disabled ? "disabled" : "active"}`);
});

const shutdown = async (signal) => {
  console.log(`[orangellm] ${signal} received, closing`);
  server.close(async () => {
    await stopRailTokenWatcher();
    stopLearningQueueWorker();
    process.exit(0);
  });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
