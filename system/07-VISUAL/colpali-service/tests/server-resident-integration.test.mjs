import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, "..");
const fixture = join(here, "fixtures", "fake-resident-worker.mjs");
const serverScript = join(serviceRoot, "server.mjs");
const temp = mkdtempSync(join(tmpdir(), "orange5-ae-eyes-resident-"));
const port = 17_000 + Math.floor(Math.random() * 10_000);
const base = `http://127.0.0.1:${port}`;
let child;

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return response.json();
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("test service did not become healthy");
}

async function waitForQueue(id) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/queue/${id}`);
    const body = await response.json();
    if (["done", "error"].includes(body.status)) return body;
    await Bun.sleep(50);
  }
  throw new Error(`queue item ${id} did not finish`);
}

beforeAll(async () => {
  child = spawn(process.execPath, [serverScript], {
    cwd: serviceRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      COLPALI_PORT: String(port),
      COLPALI_PYTHON: process.execPath,
      COLPALI_RESIDENT_SCRIPT: fixture,
      COLPALI_QUEUE_DB: join(temp, "queue.db"),
      COLPALI_TIMEOUT_MS: "5000",
      COLPALI_FORCE_TRANSFORMERS: "1",
      COLPALI_TORCH_DEVICE: "cpu",
    },
  });
  await waitForHealth();
});

afterAll(async () => {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      Bun.sleep(2_000),
    ]);
  }
  rmSync(temp, { recursive: true, force: true });
});

describe("AE Eyes resident service", () => {
  test("health exposes resident worker and persistent queue", async () => {
    const body = await (await fetch(`${base}/health`)).json();
    expect(body.ok).toBe(true);
    expect(["starting", "ready"]).toContain(body.resident_worker.state);
    expect(body.queue.db).toBe(join(temp, "queue.db"));
  });

  test("synchronous ingest uses the resident worker", async () => {
    const data = new FormData();
    data.set("file", new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" }), "fixture.png");
    const response = await fetch(`${base}/ingest`, { method: "POST", body: data });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.patches[0][0]).toEqual([3, 7]);
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.resident_worker.completed).toBeGreaterThanOrEqual(1);
  });

  test("queued file drains through the same resident worker", async () => {
    const imagePath = join(temp, "queued.png");
    writeFileSync(imagePath, Buffer.from([11, 12, 13, 14]));
    const enqueued = await (await fetch(`${base}/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: imagePath, kind: "image" }),
    })).json();
    const row = await waitForQueue(enqueued.id);
    expect(row.status).toBe("done");
    expect(row.result.worker).toBe("resident-image");
    expect(row.result.patches[0][0]).toEqual([4, 11]);
  });
});
