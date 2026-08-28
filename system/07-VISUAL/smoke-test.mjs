#!/usr/bin/env bun
// 07-VISUAL/smoke-test.mjs — OrangeEye Phase-1 end-to-end smoke test.
//
// Five steps, all green or the visual lane is not shippable. The vision model
// is configurable via ORANGE5_CORTEX_MODEL / OLLAMA_VISION_MODEL (default
// glm-4.6v; falls back to llava:7b for now).
//   1. Pre-flight: Qdrant :6333, ColPali :7440, Ollama :11434 (CORTEX_MODEL
//      present), AE Cobra :7419.
//   2. Ingest:   POST a generated PDF to <gateway>/v1/visual/ingest;
//                assert pages_ingested >= 1.
//   3. Query:    POST a query string drawn from the PDF text to
//                <gateway>/v1/visual/query; assert results.length >= 1 and
//                results[0].score > 0.
//   4. Describe: POST top hit's doc_id + page to <gateway>/v1/visual/describe;
//                assert answer.length > 20 and cortex_model === CORTEX_MODEL.
//   5. Mirage recall: POST <cobra>/state-brief with the query; assert
//                     reality.length >= 1 and reality[0].kind === 'observation'.
//
// Exit codes:
//   0 — 5/5 green
//   1 — any assertion failed (specific step printed in red)
//   2 — pre-flight fatal (a dependency is unreachable; see ./README.md)
//   3 — internal smoke harness bug (PDF fixture build failed, etc.)
//
// Frontier-Isolation: this script ONLY talks to loopback ports. It never
// resolves external DNS. If you find an outbound call here, file an incident.
//
// What this does NOT do:
//   - no retries / no backoff; this is a binary green/red check
//   - no perf assertions (latency is logged but does not fail the suite)
//   - no cleanup of the Qdrant point we just inserted — the fixture text is
//     deterministic, so repeat runs are idempotent at the doc level
//   - no auth: every endpoint is loopback-only by Frontier-Isolation Law

import { buildSmokePdf, SMOKE_TEXT_LINES } from "./test-pdf-generator.mjs";
import { createHash } from "node:crypto";

const GATEWAY     = process.env.ORANGELLM_GATEWAY || "http://127.0.0.1:1337";
const QDRANT_BASE = process.env.QDRANT_BASE       || "http://127.0.0.1:6333";
const COLPALI_BASE = process.env.COLPALI_BASE     || "http://127.0.0.1:7440";
const OLLAMA_BASE = process.env.OLLAMA_BASE       || "http://127.0.0.1:11434";
const COBRA_BASE  = process.env.AE_COBRA_BASE     || "http://127.0.0.1:7419";
const CORTEX_MODEL = process.env.ORANGE5_CORTEX_MODEL || process.env.OLLAMA_VISION_MODEL || "glm-4.6v";

const FETCH_TIMEOUT_MS = Number(process.env.SMOKE_FETCH_TIMEOUT_MS || 30_000);

// ANSI colours — terminal-only; fall back to plain text if NO_COLOR is set.
const NO_COLOR = process.env.NO_COLOR != null || !process.stdout.isTTY;
const c = {
  green: (s) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  red:   (s) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  yel:   (s) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  dim:   (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
  bold:  (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
};

// -------------------- fetch helper --------------------

async function timedFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const ms = Math.round(performance.now() - start);
    return { ok: res.ok, status: res.status, res, ms };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    return { ok: false, status: 0, err: String(err?.message || err), ms };
  } finally {
    clearTimeout(timer);
  }
}

// -------------------- step runner --------------------

const results = [];

function record(step, ok, summary, detail = null) {
  results.push({ step, ok, summary, detail });
  const tag = ok ? c.green("PASS") : c.red("FAIL");
  console.log(`[${tag}] ${step}: ${summary}`);
  if (!ok && detail) {
    const lines = String(detail).split("\n").slice(0, 6);
    for (const line of lines) console.log(c.dim(`        ${line}`));
  }
}

// -------------------- step 1: pre-flight --------------------

async function step1_preflight() {
  const probes = [];

  // Qdrant root
  {
    const r = await timedFetch(`${QDRANT_BASE}/`);
    probes.push({
      name: "Qdrant :6333",
      ok: r.ok,
      detail: r.ok ? `${r.ms}ms` : (r.err || `HTTP ${r.status}`),
    });
  }

  // ColPali health
  {
    // Most ColPali services expose / or /health. Try /health first, then /.
    const a = await timedFetch(`${COLPALI_BASE}/health`);
    const r = a.status === 404 ? await timedFetch(`${COLPALI_BASE}/`) : a;
    probes.push({
      name: "ColPali :7440",
      ok: r.ok || r.status === 200 || r.status === 405, // 405 = endpoint refuses GET
      detail: r.ok ? `${r.ms}ms` : (r.err || `HTTP ${r.status}`),
    });
  }

  // Ollama: must respond AND have CORTEX_MODEL (configurable via env) in its
  // model list. Default is glm-4.6v but any Ollama vision tag (e.g. llava:7b)
  // works when ORANGE5_CORTEX_MODEL or OLLAMA_VISION_MODEL is set.
  let modelPresent = false;
  let ollamaDetail;
  {
    const r = await timedFetch(`${OLLAMA_BASE}/api/tags`);
    if (!r.ok) {
      ollamaDetail = r.err || `HTTP ${r.status}`;
    } else {
      try {
        const body = await r.res.json();
        const names = (body?.models || []).map((m) => String(m.name || m.model || ""));
        const target = CORTEX_MODEL.toLowerCase();
        modelPresent = names.some((n) => {
          const nl = n.toLowerCase();
          return nl === target || nl.startsWith(target + ":") || nl.startsWith(target);
        });
        ollamaDetail = modelPresent
          ? `${r.ms}ms · ${CORTEX_MODEL} present`
          : `${CORTEX_MODEL} missing; have: ${names.join(", ") || "(none)"}`;
      } catch (err) {
        ollamaDetail = `bad JSON from /api/tags: ${err.message}`;
      }
    }
    probes.push({
      name: `Ollama :11434 + ${CORTEX_MODEL}`,
      ok: modelPresent,
      detail: ollamaDetail,
    });
  }

  // AE Cobra: any 2xx/4xx response on /state-brief (it expects POST; GET should
  // 405 or 404 — either confirms the daemon is up).
  {
    const r = await timedFetch(`${COBRA_BASE}/state-brief`, { method: "GET" });
    const reachable = r.status > 0; // any HTTP status means the daemon answered
    probes.push({
      name: "AE Cobra :7419",
      ok: reachable,
      detail: reachable ? `${r.ms}ms (HTTP ${r.status})` : (r.err || "unreachable"),
    });
  }

  const allGreen = probes.every((p) => p.ok);
  const summary = probes
    .map((p) => `${p.ok ? c.green("ok") : c.red("down")} ${p.name}`)
    .join(" · ");
  record("step-1 preflight", allGreen, summary, probes
    .filter((p) => !p.ok)
    .map((p) => `${p.name}: ${p.detail}`)
    .join("\n"));

  return allGreen;
}

// -------------------- step 2: ingest --------------------

let INGEST_OUT = null;
let SMOKE_TEXT_FOR_QUERY = null;

async function step2_ingest() {
  // Build PDF in-memory and POST as multipart.
  let pdfBytes;
  try {
    pdfBytes = buildSmokePdf(SMOKE_TEXT_LINES);
  } catch (err) {
    record("step-2 ingest", false, "fixture build failed", err.message);
    process.exit(3);
  }
  const sha = createHash("sha256").update(pdfBytes).digest("hex").slice(0, 16);

  // Pick a substring of the smoke text as the future query — must be unique
  // enough to outrank any other doc that might already live in the index.
  SMOKE_TEXT_FOR_QUERY = "OrangeEye Phase-1 smoke fixture Codexa visual stack";

  const boundary = `----orangeeye-smoke-${sha}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="orangeeye-smoke.pdf"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`,
  );
  const mid = enc.encode(
    `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="source_hint"\r\n\r\n` +
      `orangeeye smoke fixture\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="lane"\r\n\r\n` +
      `doc\r\n` +
      `--${boundary}--\r\n`,
  );
  const body = new Uint8Array(head.length + pdfBytes.length + mid.length);
  body.set(head, 0);
  body.set(pdfBytes, head.length);
  body.set(mid, head.length + pdfBytes.length);

  const r = await timedFetch(`${GATEWAY}/v1/visual/ingest`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });

  if (!r.ok) {
    let detail = r.err || `HTTP ${r.status}`;
    if (r.res) {
      try { detail += `\n${await r.res.text()}`; } catch {}
    }
    record("step-2 ingest", false, "POST /v1/visual/ingest failed", detail);
    return false;
  }

  let body2;
  try { body2 = await r.res.json(); }
  catch (err) {
    record("step-2 ingest", false, "non-JSON response", err.message);
    return false;
  }

  const pages = Number(body2.pages_ingested ?? 0);
  if (!(pages >= 1)) {
    record("step-2 ingest", false,
      `pages_ingested=${pages} (want >= 1)`,
      JSON.stringify(body2, null, 2));
    return false;
  }

  INGEST_OUT = body2;
  record("step-2 ingest", true,
    `pages_ingested=${pages} doc_id=${body2.doc_id} (${r.ms}ms)`);
  return true;
}

// -------------------- step 3: query --------------------

let TOP_HIT = null;

async function step3_query() {
  const r = await timedFetch(`${GATEWAY}/v1/visual/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: SMOKE_TEXT_FOR_QUERY, top_k: 8 }),
  });

  if (!r.ok) {
    let detail = r.err || `HTTP ${r.status}`;
    if (r.res) { try { detail += `\n${await r.res.text()}`; } catch {} }
    record("step-3 query", false, "POST /v1/visual/query failed", detail);
    return false;
  }

  let body;
  try { body = await r.res.json(); }
  catch (err) {
    record("step-3 query", false, "non-JSON response", err.message);
    return false;
  }

  const results2 = Array.isArray(body.results) ? body.results : [];
  if (results2.length < 1) {
    record("step-3 query", false,
      `results.length=${results2.length} (want >= 1)`,
      JSON.stringify(body, null, 2));
    return false;
  }
  const top = results2.find((hit) => hit.doc_id === INGEST_OUT?.doc_id) || results2[0];
  if (!(typeof top.score === "number" && top.score > 0)) {
    record("step-3 query", false,
      `results[0].score=${top.score} (want > 0)`,
      JSON.stringify(top, null, 2));
    return false;
  }
  TOP_HIT = top;
  record("step-3 query", true,
    `results=${results2.length} top.score=${top.score.toFixed(4)} doc_id=${top.doc_id} (${r.ms}ms)`);
  return true;
}

// -------------------- step 4: describe --------------------

async function step4_describe() {
  const target = {
    doc_id: TOP_HIT?.doc_id ?? INGEST_OUT?.doc_id,
    page: Number.isInteger(TOP_HIT?.page) ? TOP_HIT.page : 0,
    prompt: "Briefly describe the content of this page in one sentence.",
    max_tokens: 256,
  };
  if (!target.doc_id) {
    record("step-4 describe", false, "no doc_id available from prior steps");
    return false;
  }

  const r = await timedFetch(`${GATEWAY}/v1/visual/describe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target),
  });

  if (!r.ok) {
    let detail = r.err || `HTTP ${r.status}`;
    if (r.res) { try { detail += `\n${await r.res.text()}`; } catch {} }
    record("step-4 describe", false, "POST /v1/visual/describe failed", detail);
    return false;
  }

  let body;
  try { body = await r.res.json(); }
  catch (err) {
    record("step-4 describe", false, "non-JSON response", err.message);
    return false;
  }

  const answer = typeof body.answer === "string"
    ? body.answer
    : typeof body.answer?.summary === "string"
      ? body.answer.summary
      : "";
  const cortex = typeof body.cortex_model === "string" ? body.cortex_model : "";

  if (!(answer.length > 20)) {
    record("step-4 describe", false,
      `answer.length=${answer.length} (want > 20)`,
      JSON.stringify(body, null, 2));
    return false;
  }
  if (cortex !== CORTEX_MODEL) {
    record("step-4 describe", false,
      `cortex_model='${cortex}' (want '${CORTEX_MODEL}')`,
      JSON.stringify(body, null, 2));
    return false;
  }
  record("step-4 describe", true,
    `answer ${answer.length}ch cortex=${cortex} frontier=${Boolean(body.frontier_used)} (${r.ms}ms)`);
  return true;
}

// -------------------- step 5: mirage recall --------------------

async function step5_mirage() {
  const expectedSummary = "Ingested 1 page(s) from orangeeye-smoke.pdf";
  const r = await timedFetch(`${COBRA_BASE}/state-brief`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: expectedSummary,
      lanes: ["reality"],
      limit: 8,
    }),
  });

  if (!r.ok) {
    let detail = r.err || `HTTP ${r.status}`;
    if (r.res) { try { detail += `\n${await r.res.text()}`; } catch {} }
    record("step-5 mirage", false, "POST :7419/state-brief failed", detail);
    return false;
  }

  let body;
  try { body = await r.res.json(); }
  catch (err) {
    record("step-5 mirage", false, "non-JSON response", err.message);
    return false;
  }

  const reality = Array.isArray(body.reality) ? body.reality : [];
  if (reality.length < 1) {
    record("step-5 mirage", false,
      `reality.length=${reality.length} (want >= 1)`,
      JSON.stringify(body, null, 2).slice(0, 600));
    return false;
  }
  const first = reality.find((event) =>
    event?.origin === "orangeeye" &&
    event?.kind === "observation" &&
    String(event?.summary || "").includes(expectedSummary)
  );
  const kind = String(first?.kind || "");
  if (!first) {
    record("step-5 mirage", false,
      "current OrangeEye ingest event was not recalled",
      JSON.stringify(reality, null, 2).slice(0, 1200));
    return false;
  }
  if (kind !== "observation") {
    record("step-5 mirage", false,
      `reality[0].kind='${kind}' (want 'observation')`,
      JSON.stringify(first, null, 2));
    return false;
  }
  record("step-5 mirage", true,
    `reality=${reality.length} first.kind=${kind} (${r.ms}ms)`);
  return true;
}

// -------------------- main --------------------

async function main() {
  console.log(c.bold("OrangeEye Phase-1 smoke test"));
  console.log(c.dim(`  gateway=${GATEWAY}`));
  console.log(c.dim(`  qdrant=${QDRANT_BASE}  colpali=${COLPALI_BASE}`));
  console.log(c.dim(`  ollama=${OLLAMA_BASE}  cobra=${COBRA_BASE}  cortex=${CORTEX_MODEL}`));
  console.log("");

  const t0 = performance.now();
  let preflightOk = false;
  try {
    preflightOk = await step1_preflight();
  } catch (err) {
    record("step-1 preflight", false, "harness error", err.stack || err.message);
  }
  if (!preflightOk) {
    console.log(c.red("\npre-flight failed — see README.md 'failure modes'"));
    process.exit(2);
  }

  const stepFns = [step2_ingest, step3_query, step4_describe, step5_mirage];
  for (const fn of stepFns) {
    try {
      const ok = await fn();
      if (!ok) break;
    } catch (err) {
      record(fn.name, false, "harness error", err.stack || err.message);
      break;
    }
  }

  const totalMs = Math.round(performance.now() - t0);
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const allGreen = passed === total && total === 5;

  console.log("");
  console.log(c.bold(`result: ${passed}/${total} green · ${totalMs}ms total`));
  if (allGreen) {
    console.log(c.green("OrangeEye Phase-1 lane is OPEN."));
    process.exit(0);
  } else {
    console.log(c.red("OrangeEye Phase-1 lane is NOT shippable."));
    process.exit(1);
  }
}

await main();
