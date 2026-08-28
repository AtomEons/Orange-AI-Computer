#!/usr/bin/env node
// AE OrangeLLM — Guardrails / Soul Genome / Continuity Packet smoke test
// Path: 06-ORANGELLM/tests/guardrails-smoke.test.mjs
//
// Doctrine: end-to-end against a real in-process gateway. We do NOT mock
// the doctrine layer — the whole point of this surface is to prove the
// real 27-check runtime, real SQLite/JSONL store, and real Soul Genome
// roundtrip work through the boundary-gated frontier door.
//
// Isolation: every state path the routes touch (SQLite DB, soul-genome.json,
// continuity dir) is redirected to a fresh tmp dir via the
// ORANGE5_GUARDRAILS_* env vars defined in lib/paths.mjs. The operator's
// real state on disk is never touched.
//
// Run:
//   node C:/AtomEons/Orange5/06-ORANGELLM/tests/guardrails-smoke.test.mjs
//
// Exit code: 0 if all checks pass, 1 otherwise.

import { createServer } from "node:http";
import { URL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Isolate state BEFORE importing anything that reads paths.mjs
// ---------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "ae-guardrails-smoke-"));
const STATE_DIR = join(TMP_ROOT, "state");
process.env.ORANGE5_GUARDRAILS_STATE = STATE_DIR;
process.env.ORANGE5_GUARDRAILS_DB = join(STATE_DIR, "guardrails.sqlite");
process.env.ORANGE5_SOUL_GENOME = join(STATE_DIR, "soul-genome.json");
process.env.ORANGE5_CONTINUITY_DIR = join(STATE_DIR, "continuity");

// Set the operator secret to a known value so we can exercise the gate.
const OPERATOR_SECRET = "smoke-operator-secret-only-on-test-host-9F7A";
process.env.ATOMEONS_IDENTITY_SECRET = OPERATOR_SECRET;

// Imports go AFTER env overrides — paths.mjs reads env at module load.
const { boundary } = await import("../server/boundary.mjs");
const { dispatchGuardrails, isGuardrailsPath } = await import("../server/routes/guardrails.mjs");
const { isGuardrailsRouteAllowed, GUARDRAILS_ALLOWED, OPERATOR_TOKEN_HEADER } =
  await import("../server/routes/guardrails-boundary.mjs");

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  ${tag} ${name}${detail ? "  — " + detail : ""}`);
}
function assertEqual(name, actual, expected) {
  const ok = actual === expected;
  check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// 1. Boundary wiring
// ---------------------------------------------------------------------------

console.log("[guardrails-smoke] 1. boundary wiring");

check(
  "GUARDRAILS_ALLOWED has exactly 5 entries",
  GUARDRAILS_ALLOWED.length === 5,
);
const paths = GUARDRAILS_ALLOWED.map(r => `${r.method} ${r.path}`);
for (const need of [
  "GET /v1/guardrails/status",
  "POST /v1/guardrails/run",
  "GET /v1/genome",
  "POST /v1/genome",
  "GET /v1/continuity-packet",
]) {
  check(`allow-list contains ${need}`, paths.includes(need));
}

check(
  "isGuardrailsRouteAllowed accepts GET /v1/guardrails/status",
  isGuardrailsRouteAllowed("GET", "/v1/guardrails/status") === true,
);
check(
  "isGuardrailsRouteAllowed rejects POST /v1/guardrails/status",
  isGuardrailsRouteAllowed("POST", "/v1/guardrails/status") === false,
);

// Main boundary accepts the read routes
for (const p of ["/v1/guardrails/status", "/v1/genome", "/v1/continuity-packet"]) {
  const g = boundary({ method: "GET", path: p, headers: { "content-type": "application/json" } });
  check(`main boundary allows GET ${p}`, g.reject === false);
}
for (const p of ["/v1/guardrails/run", "/v1/genome"]) {
  const g = boundary({ method: "POST", path: p, headers: { "content-type": "application/json" } });
  check(`main boundary allows POST ${p}`, g.reject === false);
}

// Forbidden header families still block on this namespace
const bad = boundary({
  method: "GET",
  path: "/v1/guardrails/status",
  headers: { "x-mirage-mount": "anything" },
});
check("forbidden header still blocked on guardrails route", bad.reject === true);

// ---------------------------------------------------------------------------
// 2. In-process gateway — round trip every route
// ---------------------------------------------------------------------------

console.log("\n[guardrails-smoke] 2. http round-trip");

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
      catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const method = req.method.toUpperCase();
  const path = url.pathname;
  const guard = boundary({ method, path, headers: req.headers });
  if (guard.reject) {
    res.writeHead(guard.status || 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: guard.reason, type: "boundary_violation" } }));
    return;
  }
  if (isGuardrailsPath(path)) {
    try {
      const result = await dispatchGuardrails(req, url, { readBody });
      if (result) {
        const status = result._ae_http_status || 200;
        delete result._ae_http_status;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e?.message || e), type: "internal" } }));
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `Not found: ${method} ${path}` } }));
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function rj(path, init = {}) {
  const r = await fetch(`${base}${path}`, init);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

try {
  // ------------------------------------------------------------------
  // 2a. GET /v1/guardrails/status — fresh system, no run yet
  // ------------------------------------------------------------------
  {
    const r = await rj("/v1/guardrails/status");
    assertEqual("status: fresh system returns 200", r.status, 200);
    assertEqual("status: fresh.fresh === false", r.body?.fresh, false);
    check(
      "status: fresh.note mentions seeding",
      typeof r.body?.note === "string" && /seed/i.test(r.body.note),
    );
  }

  // ------------------------------------------------------------------
  // 2b. POST /v1/guardrails/run without operator token → 403
  // ------------------------------------------------------------------
  {
    const r = await rj("/v1/guardrails/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ write_to_flux: false }),
    });
    assertEqual("run: missing token → 403", r.status, 403);
    assertEqual(
      "run: missing token surfaces operator_token_missing",
      r.body?.error?.reason,
      "operator_token_missing",
    );
  }

  // ------------------------------------------------------------------
  // 2c. POST /v1/guardrails/run with WRONG token → 403
  // ------------------------------------------------------------------
  {
    const r = await rj("/v1/guardrails/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [OPERATOR_TOKEN_HEADER]: "totally-wrong-token-same-length-as-real-",
      },
      body: JSON.stringify({ write_to_flux: false }),
    });
    assertEqual("run: wrong token → 403", r.status, 403);
    assertEqual(
      "run: wrong token surfaces operator_token_mismatch",
      r.body?.error?.reason,
      "operator_token_mismatch",
    );
  }

  // ------------------------------------------------------------------
  // 2d. POST /v1/guardrails/run with correct token — kicks real sweep
  // ------------------------------------------------------------------
  let runId = null;
  {
    const r = await rj("/v1/guardrails/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [OPERATOR_TOKEN_HEADER]: OPERATOR_SECRET,
      },
      body: JSON.stringify({ write_to_flux: false, timeout_ms_per_check: 3000 }),
    });
    assertEqual("run: authorized → 200", r.status, 200);
    check(
      "run: returned run_id",
      typeof r.body?.run_id === "string" && r.body.run_id.startsWith("gr_"),
    );
    check(
      "run: total_checks > 0",
      typeof r.body?.total_checks === "number" && r.body.total_checks > 0,
    );
    check(
      "run: backend is sqlite or jsonl",
      r.body?.backend === "sqlite" || r.body?.backend === "jsonl",
    );
    // Per task spec: assert at least one check passed. The fail-shaped checks
    // in this isolated tmp env may flag missing-file violations for things
    // like the App router or Frontier doc, but Mom's Law check (#01) and
    // several env-bound checks pass deterministically.
    check(
      "run: at least one check passed",
      typeof r.body?.total_checks === "number" &&
        Array.isArray(r.body.violations) &&
        r.body.total_checks - r.body.violations.length >= 1,
      `passed = ${r.body?.total_checks - (r.body?.violations?.length ?? 0)}`,
    );
    runId = r.body?.run_id || null;
  }

  // ------------------------------------------------------------------
  // 2e. GET /v1/guardrails/status — now fresh=true with run_id
  // ------------------------------------------------------------------
  {
    const r = await rj("/v1/guardrails/status");
    assertEqual("status: post-run → 200", r.status, 200);
    assertEqual("status: post-run fresh === true", r.body?.fresh, true);
    assertEqual("status: run_id matches latest run", r.body?.run_id, runId);
    check(
      "status: violations is an array",
      Array.isArray(r.body?.violations),
    );
  }

  // ------------------------------------------------------------------
  // 2f. GET /v1/genome — auto-initializes and returns
  // ------------------------------------------------------------------
  let initialGenome;
  {
    const r = await rj("/v1/genome");
    assertEqual("genome: GET → 200", r.status, 200);
    check(
      "genome: schema is orange5.soul-genome.v1",
      r.body?.genome?.schema === "orange5.soul-genome.v1",
    );
    check(
      "genome: operator.name present",
      typeof r.body?.genome?.operator?.name === "string" &&
        r.body.genome.operator.name.length > 0,
    );
    check(
      "genome: intent_anchors non-empty",
      Array.isArray(r.body?.genome?.intent_anchors) &&
        r.body.genome.intent_anchors.length > 0,
    );
    check("genome: health.ok === true", r.body?.health?.ok === true);
    initialGenome = r.body.genome;
  }

  // ------------------------------------------------------------------
  // 2g. POST /v1/genome without token → 403
  // ------------------------------------------------------------------
  {
    const r = await rj("/v1/genome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ genome: initialGenome }),
    });
    assertEqual("genome POST: no token → 403", r.status, 403);
  }

  // ------------------------------------------------------------------
  // 2h. POST /v1/genome with bad schema → 422
  // ------------------------------------------------------------------
  {
    const r = await rj("/v1/genome", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [OPERATOR_TOKEN_HEADER]: OPERATOR_SECRET,
      },
      body: JSON.stringify({ genome: { schema: "bogus", operator: {} } }),
    });
    assertEqual("genome POST: bad schema → 422", r.status, 422);
    assertEqual(
      "genome POST: bad schema surfaces schema_mismatch",
      r.body?.error?.code,
      "schema_mismatch",
    );
  }

  // ------------------------------------------------------------------
  // 2i. POST /v1/genome with valid v1 update — full load/update/reload roundtrip
  // ------------------------------------------------------------------
  {
    const updated = {
      ...initialGenome,
      intent_anchors: [
        ...initialGenome.intent_anchors,
        "Smoke-test marker: 9F7A",
      ],
    };
    const r = await rj("/v1/genome", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [OPERATOR_TOKEN_HEADER]: OPERATOR_SECRET,
      },
      body: JSON.stringify({ genome: updated }),
    });
    assertEqual("genome POST: valid update → 200", r.status, 200);
    check("genome POST: written === true", r.body?.written === true);
    check(
      "genome POST: sha256 is 64 hex chars",
      typeof r.body?.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.body.sha256),
    );
    check(
      "genome POST: updated_at stamped",
      typeof r.body?.genome?.updated_at === "number" && r.body.genome.updated_at > 0,
    );

    // Now GET again and confirm the round-trip persisted.
    const after = await rj("/v1/genome");
    assertEqual("genome reload: GET → 200", after.status, 200);
    check(
      "genome reload: intent_anchors contains smoke marker",
      Array.isArray(after.body?.genome?.intent_anchors) &&
        after.body.genome.intent_anchors.includes("Smoke-test marker: 9F7A"),
    );
  }

  // ------------------------------------------------------------------
  // 2j. GET /v1/continuity-packet — empty tmp state, present:false
  // ------------------------------------------------------------------
  {
    const r = await rj("/v1/continuity-packet");
    assertEqual("continuity GET: empty → 200", r.status, 200);
    assertEqual("continuity GET: present === false", r.body?.present, false);
    check(
      "continuity GET: note mentions cron",
      typeof r.body?.note === "string" && /cron/i.test(r.body.note),
    );
  }

  // ------------------------------------------------------------------
  // 2k. Write a continuity packet via the lib, then GET it back
  // ------------------------------------------------------------------
  {
    const { writeContinuity } = await import(
      "../../01-DOCTRINE/27-guardrails/lib/continuity-packet.mjs"
    );
    const written = await writeContinuity({
      progress: ["Authored gateway guardrails routes", "Smoke-tested roundtrip"],
      open_blockers: [],
      tomorrow_first_action: "Wire AECC banner to /v1/guardrails/status",
      notes: "smoke-test marker 9F7A",
    });
    check(
      "continuity write: returned sha256",
      typeof written.sha256 === "string" && /^[0-9a-f]{64}$/.test(written.sha256),
    );
    const r = await rj("/v1/continuity-packet");
    assertEqual("continuity GET: after write → 200", r.status, 200);
    assertEqual("continuity GET: present === true", r.body?.present, true);
    check(
      "continuity GET: packet has schema v1",
      r.body?.packet?.schema === "orange5.continuity-packet.v1",
    );
    check(
      "continuity GET: tomorrow_first_action carried through",
      r.body?.packet?.tomorrow_first_action === "Wire AECC banner to /v1/guardrails/status",
    );
  }

  // ------------------------------------------------------------------
  // 2l. Method-not-on-allow-list → 404 from main boundary
  // ------------------------------------------------------------------
  {
    const r = await rj("/v1/guardrails/status", { method: "DELETE" });
    assertEqual("DELETE on status → 404", r.status, 404);
  }
} finally {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise(r => server.close(r));
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log(`\n[guardrails-smoke] ${pass}/${results.length} passed`);
if (fail > 0) {
  console.log(`[guardrails-smoke] failures:`);
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  - ${r.name}: ${r.detail}`);
  }
  process.exit(1);
}
process.exit(0);
