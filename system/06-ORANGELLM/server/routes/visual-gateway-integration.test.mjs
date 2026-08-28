import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "orange5-visual-gateway-"));
const gatewayPort = 18_000 + Math.floor(Math.random() * 5_000);
const peerPort = gatewayPort + 5_000;
const gateway = `http://127.0.0.1:${gatewayPort}`;
const peer = `http://127.0.0.1:${peerPort}`;
let peers;
let child;
let lastGenerateBody = null;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitForGateway() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${gateway}/healthz`);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("OrangeLLM test gateway did not become healthy");
}

beforeAll(async () => {
  peers = Bun.serve({
    hostname: "127.0.0.1",
    port: peerPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/ingest" && req.method === "POST") {
        return json({
          doc_id: "visual-proof-doc",
          page_count: 1,
          image_sha256: "a".repeat(64),
          patches: [Array(128).fill(7)],
        });
      }
      if (url.pathname === "/queue" && req.method === "GET") {
        return json({ rows: [{ id: 9, status: "done" }], counts: { done: 1 } });
      }
      if (url.pathname === "/queue/9" && req.method === "GET") {
        return json({ id: 9, status: "done", result: { worker: "resident-image" } });
      }
      if (url.pathname === "/api/embeddings" && req.method === "POST") {
        return json({ embedding: Array(768).fill(0.25) });
      }
      if (url.pathname === "/api/generate" && req.method === "POST") {
        lastGenerateBody = await req.json();
        return json({
          response: JSON.stringify({
            summary: "Fallback cortex saw the proof image.",
            entities: ["proof image"],
            files: [],
            commands: [],
            risk: "low",
            next_action: "respond",
            confidence: 0.93,
          }),
        });
      }
      if (url.pathname === "/proof.png" && req.method === "GET") {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" },
        });
      }
      if (url.pathname.endsWith("/points") && req.method === "PUT") {
        return json({ result: { status: "completed" } });
      }
      if (url.pathname.endsWith("/points/query") && req.method === "POST") {
        return json({
          result: {
            points: [{
              id: "point-1",
              score: 0.91,
              payload: { doc_id: "visual-proof-doc", page: 1, lane: "doc" },
            }],
          },
        });
      }
      return json({ error: "not found", path: url.pathname }, 404);
    },
  });

  child = spawn(process.execPath, ["06-ORANGELLM/server/index.mjs"], {
    cwd: join(import.meta.dir, "..", "..", ".."),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ORANGE5_ORANGELLM_HOST: "127.0.0.1",
      ORANGE5_ORANGELLM_PORT: String(gatewayPort),
      ORANGE5_GATEWAY_SELF_URL: gateway,
      ORANGE5_COLPALI_URL: peer,
      QDRANT_URL: peer,
      OLLAMA_URL: peer,
      ORANGE5_CORTEX_MODEL: "unreachable-primary",
      ORANGE5_CORTEX_OLLAMA_URL: `http://127.0.0.1:${peerPort + 1}`,
      ORANGE5_CORTEX_FALLBACK_MODEL: "vision-fallback",
      ORANGE5_CORTEX_FALLBACK_URL: peer,
      AE_FLUX_ROOT: join(temp, "flux"),
    },
  });
  await waitForGateway();
});

afterAll(async () => {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      Bun.sleep(2_000),
    ]);
  }
  peers?.stop(true);
  rmSync(temp, { recursive: true, force: true });
});

describe("OrangeLLM mounted visual routes", () => {
  test("boundary rejects reserved visual control headers", async () => {
    const response = await fetch(`${gateway}/v1/visual/query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-orangeeye-route": "bypass" },
      body: JSON.stringify({ query: "proof" }),
    });
    expect(response.status).toBe(403);
  });

  test("ingest reaches ColPali, Qdrant, and the Reality ledger", async () => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "proof.png");
    form.set("lane", "doc");
    const response = await fetch(`${gateway}/v1/visual/ingest`, { method: "POST", body: form });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.doc_id).toBe("visual-proof-doc");
    expect(body.patches_indexed).toBe(1);
    expect(body.visual_event_written).toBe(true);
    const day = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(temp, "flux", "events", "reality", `${day}.jsonl`))).toBe(true);
  });

  test("query reaches the embedder and Qdrant search", async () => {
    const response = await fetch(`${gateway}/v1/visual/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Orange visual proof", top_k: 3 }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].doc_id).toBe("visual-proof-doc");
    expect(body.results[0].score).toBe(0.91);
  });

  test("queue list and item routes proxy through the gateway", async () => {
    const list = await (await fetch(`${gateway}/v1/visual/queue`)).json();
    expect(list.rows[0].id).toBe(9);
    const item = await (await fetch(`${gateway}/v1/visual/queue/9`)).json();
    expect(item.result.worker).toBe("resident-image");
  });

  test("describe is mounted and validates its contract", async () => {
    const response = await fetch(`${gateway}/v1/visual/describe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).not.toBe(404);
  });

  test("describe falls back with explicit model and route provenance", async () => {
    const response = await fetch(`${gateway}/v1/visual/describe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_url: `${peer}/proof.png`, max_tokens: 96 }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.answer.summary).toContain("proof image");
    expect(body.cortex_model).toBe("vision-fallback");
    expect(body.cortex_fallback_used).toBe(true);
    expect(body.cortex_primary_error).toContain("Ollama unreachable");
    expect(lastGenerateBody.think).toBe(false);
    expect(lastGenerateBody.options.num_predict).toBe(96);
    expect(lastGenerateBody.format.required).toEqual(["summary", "confidence"]);
    const day = new Date().toISOString().slice(0, 10);
    const ledger = readFileSync(join(temp, "flux", "events", "reality", `${day}.jsonl`), "utf8")
      .trim().split("\n").filter(Boolean).map(JSON.parse);
    expect(ledger).toHaveLength(2);
    expect(ledger[1].body.ae_visual.cortex_model).toBe("vision-fallback");
  });
});
