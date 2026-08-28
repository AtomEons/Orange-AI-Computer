#!/usr/bin/env node
// Smart Skinny compatibility adapter.
// Serves the OpenAI-compatible surface expected by OrangeLLM at 127.0.0.1:8797.
// Backend is local Ollama by default; final LoRA import can replace the model env.

import { createServer } from "node:http";
import { URL } from "node:url";

const HOST = process.env.ORANGE5_SMART_SKINNY_HOST || "127.0.0.1";
const PORT = Number(process.env.ORANGE5_SMART_SKINNY_PORT || 8797);
const OLLAMA_BASE_URL = process.env.ORANGE5_OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const BACKEND_MODEL = process.env.ORANGE5_SMART_SKINNY_MODEL || "qwen3:0.6b";
const KEEP_ALIVE = process.env.ORANGE5_SMART_SKINNY_KEEP_ALIVE || "5m";
const PUBLIC_MODEL = "orangellm-smart-skinny-0.5b";

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req, capBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > capBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaTags() {
  const res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, {}, 5_000);
  if (!res.ok) throw new Error(`ollama tags returned ${res.status}`);
  return await res.json();
}

async function chatCompletions(body) {
  const payload = {
    model: BACKEND_MODEL,
    messages: body.messages,
    stream: false,
    think: false,
    keep_alive: KEEP_ALIVE,
    options: {
      temperature: body.temperature ?? 0.2,
      num_predict: body.max_tokens ?? body.max_completion_tokens ?? 512,
      num_ctx: 2048,
      num_thread: 4,
    },
  };

  const res = await fetchWithTimeout(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, 90_000);

  const text = await res.text();
  if (!res.ok) {
    return {
      status: res.status,
      body: {
        error: {
          message: `ollama backend returned ${res.status}`,
          type: "upstream_error",
          code: "ollama_backend_error",
          detail: text.slice(0, 500),
        },
      },
    };
  }

  const data = JSON.parse(text);
  if (Array.isArray(data.choices)) {
    for (const choice of data.choices) {
      if (choice?.message && typeof choice.message === "object") {
        delete choice.message.reasoning;
        delete choice.message.reasoning_content;
        delete choice.message.thinking;
      }
    }
  }
  data.model = PUBLIC_MODEL;
  data.ae_lane = "reflex";
  data.ae_host = "n150";
  data.ae_upstream = "smart-skinny-compatible-ollama";
  data.ae_backend_model = BACKEND_MODEL;
  return { status: 200, body: data };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const method = req.method.toUpperCase();
  const path = url.pathname;

  try {
    if (method === "GET" && path === "/healthz") {
      const tags = await ollamaTags();
      const backendModelPresent = Array.isArray(tags.models)
        && tags.models.some((item) => item.name === BACKEND_MODEL || item.model === BACKEND_MODEL);
      return json(res, backendModelPresent ? 200 : 503, {
        status: backendModelPresent ? "ok" : "degraded",
        service: "orange5-smart-skinny-compatible-adapter",
        public_model: PUBLIC_MODEL,
        backend_model: BACKEND_MODEL,
        backend: "ollama",
        backend_base_url: OLLAMA_BASE_URL,
        backend_model_present: backendModelPresent,
        keep_alive: KEEP_ALIVE,
        note: "Compatibility reflex endpoint. Final Smart Skinny LoRA can replace backend_model.",
        generated_at: new Date().toISOString(),
      });
    }

    if (method === "GET" && path === "/v1/models") {
      return json(res, 200, {
        object: "list",
        data: [{
          id: PUBLIC_MODEL,
          object: "model",
          created: 1735000000,
          owned_by: "atomeons",
          root: PUBLIC_MODEL,
          parent: BACKEND_MODEL,
          ae_backend_model: BACKEND_MODEL,
          ae_adapter: "smart-skinny-compatible-ollama",
        }],
      });
    }

    if (method === "POST" && path === "/v1/chat/completions") {
      const body = await readJson(req);
      if (!body || !Array.isArray(body.messages) || !body.messages.length) {
        return json(res, 400, {
          error: {
            message: "messages array required",
            type: "invalid_request_error",
            code: "messages_required",
          },
        });
      }
      const result = await chatCompletions(body);
      return json(res, result.status, result.body);
    }

    return json(res, 404, {
      error: {
        message: `not found: ${method} ${path}`,
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  } catch (err) {
    return json(res, 502, {
      error: {
        message: "smart skinny adapter upstream failure",
        type: "upstream_error",
        code: "adapter_upstream_failure",
        detail: err.message,
      },
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[smart-skinny] listening on ${HOST}:${PORT}`);
  console.log(`[smart-skinny] backend ${OLLAMA_BASE_URL} model=${BACKEND_MODEL}`);
});

const shutdown = (signal) => {
  console.log(`[smart-skinny] ${signal} received, closing`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
