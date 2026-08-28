#!/usr/bin/env node
// health-monitor.smoke.mjs — hermetic unit smoke for the N150 health monitor.
// No real network. No Ollama. No Cockpit. Uses a fake fetchImpl injected into
// the exported helpers so every probe is deterministic.
//
// Run:
//   node C:/AtomEons/Orange5/06-ORANGELLM/n150-utility/tests/health-monitor.smoke.mjs
//
// Exit 0 = all pass. Exit 1 = at least one fail (with the failing case).

import {
  probeTarget,
  pushShadow,
  summarize,
  buildSnapshot,
  recordSample,
  runOneTick,
  TARGETS,
  VERSION,
} from "../health-monitor.mjs";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log(`[smoke] n150-health-monitor ${VERSION}`);
console.log("");

// Tiny fake-fetch builder. Each call returns the next scripted response.
function scriptedFetch(script) {
  let i = 0;
  return async function fakeFetch(url, opts) {
    const entry = script[i++] ?? script[script.length - 1];
    if (entry instanceof Error) throw entry;
    if (typeof entry === "function") return entry(url, opts);
    const { status = 200, body = {}, delayMs = 0, throwErr } = entry;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (throwErr) throw throwErr;
    return {
      status,
      async text() { return typeof body === "string" ? body : JSON.stringify(body); },
    };
  };
}

console.log("[1] probeTarget — happy path 200 records ok=true with latency");
{
  const fetchImpl = scriptedFetch([{ status: 200, body: { ok: true, model: "qwen3:0.6b" } }]);
  const sample = await probeTarget(
    { name: "classifier", url: "http://x/healthz", optional: false },
    { fetchImpl, timeoutMs: 1000, nowFn: () => 1000 },
  );
  check("ok=true",        sample.ok === true);
  check("status=200",     sample.status === 200);
  check("latency_ms>=0",  typeof sample.latency_ms === "number" && sample.latency_ms >= 0);
  check("model captured", sample.model === "qwen3:0.6b");
  eq("t=1000", sample.t, 1000);
}

console.log("");
console.log("[2] probeTarget — 5xx records ok=false but does not throw");
{
  const fetchImpl = scriptedFetch([{ status: 503, body: { ok: false } }]);
  const sample = await probeTarget(
    { name: "embedder", url: "http://x/healthz", optional: false },
    { fetchImpl, timeoutMs: 1000 },
  );
  check("ok=false on 503 when not optional", sample.ok === false);
  check("status=503 recorded",               sample.status === 503);
}

console.log("");
console.log("[3] probeTarget — 503 on optional target is 'gated alive'");
{
  const fetchImpl = scriptedFetch([{ status: 503, body: { gated: true } }]);
  const sample = await probeTarget(
    { name: "fallback-chat", url: "http://x/healthz", optional: true },
    { fetchImpl, timeoutMs: 1000 },
  );
  check("optional 503 ok=true", sample.ok === true);
  check("gated flag set",       sample.gated === true);
}

console.log("");
console.log("[4] probeTarget — network error encoded, no throw");
{
  const fetchImpl = async () => { const e = new Error("ECONNREFUSED"); throw e; };
  const sample = await probeTarget(
    { name: "ollama", url: "http://x/api/tags", optional: false },
    { fetchImpl, timeoutMs: 1000 },
  );
  check("network err -> ok=false", sample.ok === false);
  check("status=0",                sample.status === 0);
  check("error captured",          typeof sample.error === "string" && sample.error.includes("ECONNREFUSED"));
}

console.log("");
console.log("[5] summarize — empty samples returns null-ish rollup");
{
  const r = summarize([]);
  eq("samples=0", r.samples, 0);
  eq("up=false",  r.up, false);
  eq("p50=null",  r.latency_ms_p50, null);
}

console.log("");
console.log("[6] summarize — mixed ok/fail computes error_rate & percentiles");
{
  const now = 1000;
  const samples = [
    { t: now + 0, ok: true,  status: 200, latency_ms: 10 },
    { t: now + 1, ok: true,  status: 200, latency_ms: 20 },
    { t: now + 2, ok: false, status: 503, latency_ms: 30, error: "down" },
    { t: now + 3, ok: true,  status: 200, latency_ms: 40 },
  ];
  const r = summarize(samples);
  eq("samples=4",       r.samples, 4);
  eq("up=true (last)",  r.up, true);
  eq("error_rate=0.25", r.error_rate, 0.25);
  eq("p50=20",          r.latency_ms_p50, 20);
  eq("last=40",         r.latency_ms_last, 40);
}

console.log("");
console.log("[7] pushShadow — happy + failure paths");
{
  const ok = await pushShadow({ schema: "x" }, { fetchImpl: scriptedFetch([{ status: 204 }]), timeoutMs: 500, url: "http://x" });
  eq("push ok",  { ok: ok.ok, status: ok.status }, { ok: true, status: 204 });
  const fail = await pushShadow({ schema: "x" }, { fetchImpl: async () => { throw new Error("nope"); }, timeoutMs: 500, url: "http://x" });
  eq("push fail", { ok: fail.ok, status: fail.status }, { ok: false, status: 0 });
  check("push fail has error", typeof fail.error === "string");
}

console.log("");
console.log("[8] runOneTick — drives all targets, builds schema-v1 snapshot");
{
  // Script enough responses for every target. Order: classifier, embedder,
  // fallback-chat, ollama — TARGETS order. Promise.all means we cannot
  // guarantee call order in fakeFetch indexing, so use a URL-aware fake.
  const fetchImpl = async (url) => {
    if (url.includes("7480")) return { status: 200, async text() { return JSON.stringify({ ok: true, model: "qwen3:0.6b" }); } };
    if (url.includes("8798")) return { status: 200, async text() { return JSON.stringify({ ok: true, model: "nomic-embed-text" }); } };
    if (url.includes("7481")) return { status: 503, async text() { return JSON.stringify({ gated: true }); } };
    if (url.includes("11434")) return { status: 200, async text() { return JSON.stringify({ models: [] }); } };
    // Cockpit shadow push lands here too — return 204.
    return { status: 204, async text() { return ""; } };
  };
  const snap = await runOneTick({ fetchImpl, nowFn: () => 5000 });
  eq("schema",          snap.schema, "ae.n150.health.snapshot.v1");
  eq("host",            snap.host, "n150");
  check("targets keys present", TARGETS.every((t) => snap.targets[t.name] !== undefined));
  check("classifier up",    snap.targets.classifier.up === true);
  check("embedder up",      snap.targets.embedder.up === true);
  check("fallback gated",   snap.targets["fallback-chat"].gated === true);
  check("fallback up=true (gated counts as alive)", snap.targets["fallback-chat"].up === true);
  check("ollama up",        snap.targets.ollama.up === true);
}

console.log("");
console.log("[9] buildSnapshot — bounded window honored, no leaks");
{
  // Fire 200 fake samples into classifier buffer; window cap = 60.
  for (let i = 0; i < 200; i++) {
    recordSample("classifier", { t: i, ok: true, status: 200, latency_ms: i }, { nowFn: () => i });
  }
  const snap = buildSnapshot({ nowFn: () => 999 });
  check("classifier samples capped at 60", snap.targets.classifier.samples === 60);
}

console.log("");
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`[smoke] ${passed} passed, ${failed} failed, ${results.length} total`);
process.exit(failed === 0 ? 0 : 1);
