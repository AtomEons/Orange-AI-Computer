#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeChainedJsonReceipt } from "../10-RECEIPTS/tools/json-receipt-chain.mjs";

const ROOT = path.resolve(import.meta.dir, "..");
export const RUNTIME_RECEIPT_DIR = path.join(ROOT, "10-RECEIPTS", "orange5-build", "runtime-performance");
export const MIN_QUEUE_OPS_PER_SECOND = 1_000;
export const MAX_SEMANTIC_P95_MS = 1_000;
const QUEUE_ITEMS = 400;
const SEMANTIC_QUERIES = Object.freeze([
  "What evidence proves OrangeFive memory and Codexa routing?",
  "Which receipts establish durable OrangeFive memory behavior?",
  "What runtime proof verifies Codexa routing and semantic recall?",
]);
const ENDPOINTS = Object.freeze([
  ["memory", "http://127.0.0.1:7419/healthz"],
  ["hermes", "http://127.0.0.1:7430/healthz"],
  ["orangellm", "http://127.0.0.1:1337/livez"],
  ["brain_mcp", "http://127.0.0.1:7431/health"],
  ["qdrant", "http://127.0.0.1:6333/collections/orange5-memory"],
  ["codexa_ollama", "http://10.0.0.4:11434/api/tags"],
]);

export async function runBenchmark({ receiptDir = RUNTIME_RECEIPT_DIR } = {}) {
  const started = performance.now();
  const endpointRows = await Promise.all(ENDPOINTS.map(([name, url]) => timedFetch(name, url)));
  const serialStarted = performance.now();
  for (const [name, url] of ENDPOINTS) await timedFetch(name, url);
  const serialMs = performance.now() - serialStarted;
  const parallelStarted = performance.now();
  await Promise.all(ENDPOINTS.map(([name, url]) => timedFetch(name, url)));
  const parallelMs = performance.now() - parallelStarted;

  const queue = await benchmarkQueue();
  const semantic = await benchmarkSemantic();
  const report = {
    schema: "orange5.bun-runtime-benchmark.v2",
    bun: { version: Bun.version, revision: Bun.revision },
    host: os.hostname(),
    status: endpointRows.every((row) => row.ok) && queue.ok && semantic.ok
      ? "BUN_RUNTIME_BENCHMARK_GREEN"
      : "BUN_RUNTIME_BENCHMARK_NEEDS_WORK",
    endpoints: endpointRows,
    probe_strategy: {
      serial_ms: round(serialMs),
      parallel_ms: round(parallelMs),
      speedup: round(serialMs / Math.max(parallelMs, 0.001)),
    },
    queue,
    semantic,
    process_memory: process.memoryUsage(),
    total_ms: round(performance.now() - started),
    generated_at: new Date().toISOString(),
  };
  const receiptPath = path.join(receiptDir, `${report.generated_at.replace(/[:.]/g, "-")}-bun-runtime-benchmark.json`);
  const chained = writeChainedJsonReceipt(receiptPath, report);
  return { report, chained, receiptPath };
}

async function timedFetch(name, url) {
  const start = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    await response.arrayBuffer();
    return { name, url, ok: response.ok, status: response.status, latency_ms: round(performance.now() - start) };
  } catch (error) {
    return { name, url, ok: false, status: null, latency_ms: round(performance.now() - start), error: error.message };
  }
}

export async function benchmarkQueue({ itemCount = QUEUE_ITEMS } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orange5-bun-bench-"));
  const dbPath = path.join(root, "learning.sqlite");
  let store = null;
  try {
    const { LearningQueueStore } = await import("../03-BACKEND/learning-queue.mjs");
    const initStart = performance.now();
    store = new LearningQueueStore(dbPath);
    const initMs = performance.now() - initStart;
    const count = Math.max(1, Math.floor(Number(itemCount) || QUEUE_ITEMS));
    let lastItemId = null;
    const runStart = performance.now();
    for (let index = 0; index < count; index += 1) {
      const hash = sha256(`bun-runtime-benchmark-${index}`);
      const item = store.enqueue({ action: "benchmark.queue", status: "completed", hash, receipt_id: `bench-${index}` });
      const leased = store.leaseNext({ owner: "bun-runtime-benchmark" });
      if (!leased || leased.item_id !== item.item_id) throw new Error("queue lease order drifted");
      store.complete(item.item_id, { accepted: true, index });
      lastItemId = item.item_id;
    }
    const operationMs = performance.now() - runStart;
    const pragmas = readQueuePragmas(store);
    store.close();
    store = null;

    const reopenStart = performance.now();
    store = new LearningQueueStore(dbPath);
    const reopenMs = performance.now() - reopenStart;
    const stats = store.stats();
    const verification = store.verify(lastItemId);
    const reopenedPragmas = readQueuePragmas(store);
    const operations = count * 3;
    const operationsPerSecond = operations / (operationMs / 1_000);
    return {
      ok: stats.total === count && stats.by_status.completed === count && stats.failed === 0
        && verification.ok && pragmas.journal_mode === "wal" && reopenedPragmas.journal_mode === "wal"
        && Number(pragmas.synchronous) === 1 && Number(reopenedPragmas.synchronous) === 1
        && operationsPerSecond >= MIN_QUEUE_OPS_PER_SECOND,
      init_ms: round(initMs),
      reopen_ms: round(reopenMs),
      items: count,
      operations,
      operation_ms: round(operationMs),
      operations_per_second: round(operationsPerSecond),
      minimum_operations_per_second: MIN_QUEUE_OPS_PER_SECOND,
      pragmas,
      reopened_pragmas: reopenedPragmas,
      durability_verified_after_reopen: verification.ok,
      stats,
    };
  } catch (error) {
    return { ok: false, error: error.message, minimum_operations_per_second: MIN_QUEUE_OPS_PER_SECOND };
  } finally {
    try { store?.close(); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readQueuePragmas(store) {
  return {
    journal_mode: store.db.query("PRAGMA journal_mode;").get()?.journal_mode,
    synchronous: store.db.query("PRAGMA synchronous;").get()?.synchronous,
    foreign_keys: store.db.query("PRAGMA foreign_keys;").get()?.foreign_keys,
  };
}

export async function benchmarkSemantic({ queryMemory = null, queries = SEMANTIC_QUERIES } = {}) {
  try {
    process.env.AE_COBRA_EMBED_URL ||= "http://10.0.0.4:11434";
    const moduleStarted = performance.now();
    const query = queryMemory || (await import("../06-ORANGELLM/memory/ae-cobra/semantic-index.mjs")).querySemanticMemory;
    const moduleInitMs = performance.now() - moduleStarted;
    const runs = [];
    for (const text of queries) {
      const runStarted = performance.now();
      const result = await query(text, { limit: 3 });
      runs.push({
        query: text,
        latency_ms: round(performance.now() - runStarted),
        reported_elapsed_ms: result.elapsed_ms,
        hits: result.hits.length,
        candidates: result.candidates,
        model: result.model,
        component_latency_ms: result.component_latency_ms,
      });
    }
    const latencies = runs.map((run) => run.latency_ms);
    const p50Ms = percentile(latencies, 0.5);
    const p95Ms = percentile(latencies, 0.95);
    return {
      ok: runs.every((run) => run.hits > 0) && p95Ms <= MAX_SEMANTIC_P95_MS,
      module_init_ms: round(moduleInitMs),
      runs: runs.length,
      first_query_ms: latencies[0],
      p50_ms: p50Ms,
      p95_ms: p95Ms,
      max_ms: Math.max(...latencies),
      hits_per_run: runs.map((run) => run.hits),
      candidates_per_run: runs.map((run) => run.candidates),
      model: runs[0]?.model || null,
      samples: runs,
      threshold_ms: MAX_SEMANTIC_P95_MS,
    };
  } catch (error) {
    return { ok: false, error: error.message, threshold_ms: MAX_SEMANTIC_P95_MS };
  }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function round(value) { return Number(Number(value).toFixed(3)); }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }

if (import.meta.main) {
  try {
    const { report, chained, receiptPath } = await runBenchmark();
    process.stdout.write(`${JSON.stringify({ ...chained, receipt_path: receiptPath })}\n`);
    if (report.status !== "BUN_RUNTIME_BENCHMARK_GREEN") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
