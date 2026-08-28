#!/usr/bin/env node
// classifier.live.smoke.mjs — end-to-end smoke against a running daemon.
//
// What it does:
//   1. Spawn daemon.mjs on an ephemeral loopback port (env override).
//   2. POST /classify with reality / thought / unknown origins.
//   3. GET /healthz; expect 'ok' or 'degraded' (degraded is fine if Ollama
//      is not running — we still want a 200 with structured counters).
//   4. GET /model — verify default model is reported.
//   5. Tear the daemon down.
//
// This test does NOT require Ollama. Unknown-origin → thought (default).
//
// Run:
//   node C:/AtomEons/Orange5/06-ORANGELLM/n150-utility/classifier/tests/classifier.live.smoke.mjs

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const HERE = dirname(__filename);
const DAEMON = resolve(HERE, "..", "daemon.mjs");

const PORT = 17480; // ephemeral test port, not the production 7480
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  ${tag} ${name}${detail ? "  — " + detail : ""}`);
}

async function waitForListen(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

async function main() {
  console.log(`[live] launching daemon on ${BASE}`);
  const child = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      N150_CLASSIFIER_HOST: HOST,
      N150_CLASSIFIER_PORT: String(PORT),
      // Point at a deliberately closed port so unknown-origin defaults to
      // thought instead of waiting for the real Ollama.
      N150_OLLAMA_BASE: "http://127.0.0.1:1",
      N150_OLLAMA_TIMEOUT_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  child.stderr.on("data", d => { stderrBuf += d.toString(); });

  const up = await waitForListen();
  if (!up) {
    console.log("  FAIL daemon did not bind");
    console.log("  stderr tail:", stderrBuf.slice(-500));
    child.kill("SIGTERM");
    process.exit(1);
  }
  check("daemon bound", true);

  try {
    // /healthz
    const h = await (await fetch(`${BASE}/healthz`)).json();
    check("/healthz returns service name", h.service === "n150-classifier",
      `service=${h.service}`);
    check("/healthz reports a bind", typeof h.bind === "string" && h.bind.includes(":"));
    check("/healthz reports counters object", h.counters && typeof h.counters.total === "number");

    // /model
    const m = await (await fetch(`${BASE}/model`)).json();
    check("/model reports active_model", typeof m.active_model === "string" && m.active_model.length > 0);

    // /classify — reality
    const rReal = await (await fetch(`${BASE}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "receipt.cobra.write", event_metadata: { id: "abc" } }),
    })).json();
    check("reality origin → reality lane", rReal.lane === "reality", JSON.stringify(rReal));
    check("reality lane source = origin_rule", rReal.source === "origin_rule");

    // /classify — thought
    const rTh = await (await fetch(`${BASE}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "chat.user.msg", event_metadata: {} }),
    })).json();
    check("thought origin → thought lane", rTh.lane === "thought", JSON.stringify(rTh));

    // /classify — unknown, Ollama unreachable → default thought
    const rUnk = await (await fetch(`${BASE}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "novel.unknown.prefix", event_metadata: { k: 1 } }),
    })).json();
    check("unknown origin + Ollama down → thought", rUnk.lane === "thought", JSON.stringify(rUnk));
    check("unknown origin source = model_unreachable_default_thought",
      rUnk.source === "model_unreachable_default_thought");

    // /classify — empty origin
    const rEmpty = await (await fetch(`${BASE}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })).json();
    check("empty origin lane is a string", typeof rEmpty.lane === "string");

    // /healthz again — counters should have advanced
    const h2 = await (await fetch(`${BASE}/healthz`)).json();
    check("counters advanced", h2.counters.total >= 4, `total=${h2.counters.total}`);

    // 404
    const r404 = await fetch(`${BASE}/nope`);
    check("unknown path returns 404", r404.status === 404, `status=${r404.status}`);
  } finally {
    child.kill("SIGTERM");
    // Give it a moment to flush; SIGKILL fallback is in the OS.
    await sleep(200);
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log("");
  console.log(`[live] ${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error("[live] fatal:", err);
  process.exit(1);
});
