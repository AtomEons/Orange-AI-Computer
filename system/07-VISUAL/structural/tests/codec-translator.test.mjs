#!/usr/bin/env bun
// 07-VISUAL/structural/tests/codec-translator.test.mjs
//
// Standalone Bun harness for the M2 codec translator + gateway route.
// Not a framework test — prints `Summary: N pass / M fail of T` and exits
// non-zero on any red. Picked up by 00-CHARTER/orange5-full-verifier.mjs
// via the *.test.mjs glob.

import { statSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { translateH264, _internal, TRANSLATOR_VERSION, probeFfmpegVersion, _resetFfmpegVersionCache } from "../codec-translator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const FIXTURE = path.join(REPO, "07-VISUAL", "fixtures", "testsrc-2s-320x240.mp4");
const CUTMIX = path.join(REPO, "07-VISUAL", "fixtures", "cutmix-2s-320x240.mp4");
const SCHEMA_PATH = path.join(REPO, "09-SCHEMAS", "ae-structural-tokens.v1.schema.json");
const SERVER_ENTRY = path.join(REPO, "06-ORANGELLM", "server", "index.mjs");
const GEN_FIXTURES = path.join(REPO, "07-VISUAL", "fixtures", "gen-fixtures.mjs");

// ---------- test harness ----------

const results = [];
async function test(name, fn) {
  const t0 = performance.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Math.round(performance.now() - t0) });
    console.log(`  PASS  ${name}  (${Math.round(performance.now() - t0)}ms)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Math.round(performance.now() - t0), err: e.message });
    console.log(`  FAIL  ${name}  (${Math.round(performance.now() - t0)}ms)`);
    console.log(`         ${e.stack?.split("\n").slice(0, 5).join("\n         ")}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEqual(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
  }
}

// ---------- ensure fixtures exist ----------

async function ensureFixtures() {
  try { statSync(FIXTURE); return; } catch {}
  const proc = Bun.spawn(["bun", GEN_FIXTURES], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  try { statSync(FIXTURE); } catch (e) {
    throw new Error(`fixture generation failed; is ffmpeg installed? tried ${GEN_FIXTURES}`);
  }
}

// ---------- schema-required field walker ----------

function checkSchemaFields(record, schema, ptr = "$") {
  // Walk the required[] fields at each level and check presence + basic type.
  if (schema.type === "object") {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        assert(Object.prototype.hasOwnProperty.call(record, key), `${ptr}.${key} required by schema`);
      }
    }
    if (schema.properties && record && typeof record === "object") {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(record, k) && record[k] != null) {
          const v = record[k];
          if (sub.const !== undefined) assertEqual(v, sub.const, `${ptr}.${k} const mismatch`);
          if (sub.enum && !sub.enum.includes(v)) throw new Error(`${ptr}.${k} = ${JSON.stringify(v)} not in enum ${JSON.stringify(sub.enum)}`);
          if (sub.type === "integer") assert(Number.isInteger(v), `${ptr}.${k} must be integer, got ${typeof v} ${v}`);
          if (sub.type === "number") assert(Number.isFinite(v), `${ptr}.${k} must be number`);
          if (sub.type === "string") assert(typeof v === "string", `${ptr}.${k} must be string`);
          if (sub.type === "array") {
            assert(Array.isArray(v), `${ptr}.${k} must be array`);
            if (sub.minItems != null) assert(v.length >= sub.minItems, `${ptr}.${k} minItems=${sub.minItems}, got ${v.length}`);
            if (sub.maxItems != null) assert(v.length <= sub.maxItems, `${ptr}.${k} maxItems=${sub.maxItems}, got ${v.length}`);
            if (sub.items && sub.items.type === "object" && v.length > 0) {
              for (let i = 0; i < v.length; i++) checkSchemaFields(v[i], sub.items, `${ptr}.${k}[${i}]`);
            }
          }
          if (sub.type === "object") checkSchemaFields(v, sub, `${ptr}.${k}`);
        }
      }
    }
  }
}

// ---------- port helper for the integration test ----------

async function pickFreePort() {
  // Bind :0 to a Bun server briefly to grab a free port.
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  await delay(20);
  return port;
}

async function waitFor(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {}
    await delay(120);
  }
  return false;
}

// ---------- tests ----------

await ensureFixtures();

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

// (1) Deterministic output on same input.
await test("deterministic: same input + same opts → identical record.id", async () => {
  const a = await translateH264({ path: FIXTURE, opts: { extractedAtMs: 1000, source_id: "test-fixed" } });
  const b = await translateH264({ path: FIXTURE, opts: { extractedAtMs: 1000, source_id: "test-fixed" } });
  assertEqual(a.id, b.id, "record.id differs across runs");
  // Non-timestamp portions must also match. Extraction time is 0 by default.
  const stripA = { ...a }; delete stripA.provenance;
  const stripB = { ...b }; delete stripB.provenance;
  assertEqual(JSON.stringify(stripA), JSON.stringify(stripB), "non-provenance record differs");
});

// (2) Schema validity — required fields at every level, enums honored.
await test("schema: record passes required-fields + enum walk", async () => {
  const rec = await translateH264({ path: FIXTURE, opts: { source_id: "test-schema" } });
  assertEqual(rec.schema, "ae.structural-tokens.v1", "schema const");
  checkSchemaFields(rec, schema);
  // Extra invariants that the schema hints at but doesn't enforce with const.
  assert(rec.provenance.path === "codec", "provenance.path must be 'codec' for codec translator");
  assert(rec.provenance.source_kind === "h264", `expected h264 got ${rec.provenance.source_kind}`);
  assert(typeof rec.provenance.translator_version === "string" && rec.provenance.translator_version.includes(TRANSLATOR_VERSION), "translator_version must include base version");
  assert(Array.isArray(rec.entities), "entities must be array");
  assert(Array.isArray(rec.notes), "notes must be array");
  assert(Array.isArray(rec.temporal_markers), "temporal_markers must be array");
  assert(Array.isArray(rec.texture_vocabulary), "texture_vocabulary must be array");
  assert(rec.texture_vocabulary.length <= 64, `texture_vocabulary cap 64, got ${rec.texture_vocabulary.length}`);
  assert(rec.temporal.frame_count >= 1, "frame_count >= 1");
  assert(rec.photometric.resolution[0] === 320 && rec.photometric.resolution[1] === 240, "resolution [320,240]");
});

// (3) At least one entity emitted on a real video fixture.
await test("emits at least one entity on the testsrc fixture", async () => {
  const rec = await translateH264({ path: FIXTURE });
  assert(rec.entities.length >= 1, `expected >=1 entity, got ${rec.entities.length}`);
  // The primary entity must cover the majority of the timeline.
  const e0 = rec.entities[0];
  assert(e0.first_seen_ms === 0, `first entity should start at 0ms, got ${e0.first_seen_ms}`);
  assert(e0.last_seen_ms > 0, `first entity last_seen_ms should be > 0`);
  assert(e0.motion_field.length >= 1, `entity should have at least 1 motion sample`);
  assert(Number.isFinite(e0.prediction_residual_norm), `entity prediction_residual_norm must be number`);
});

// (4) Honest notes[] declared.
await test("notes[] non-empty and discloses codec blind spots", async () => {
  const rec = await translateH264({ path: FIXTURE });
  assert(rec.notes.length >= 3, `expected >=3 honest notes, got ${rec.notes.length}`);
  const joined = rec.notes.join(" | ").toLowerCase();
  assert(joined.includes("motion-vector components"), `notes must disclose MV component blind spot; got: ${joined}`);
  assert(joined.includes("dct"), `notes must disclose DCT blind spot`);
  assert(joined.includes("residual"), `notes must disclose residual approximation`);
});

// (5) Scene-cut fixture surfaces a scene_cut temporal marker.
await test("cutmix fixture surfaces a scene_cut marker", async () => {
  try { statSync(CUTMIX); }
  catch { throw new Error("cutmix fixture missing"); }
  const rec = await translateH264({ path: CUTMIX });
  const cuts = rec.temporal_markers.filter(m => m.kind === "scene_cut");
  assert(cuts.length >= 1, `expected >=1 scene_cut marker, got ${cuts.length} (markers: ${JSON.stringify(rec.temporal_markers)})`);
  // The synthetic cut is at ~1000ms — allow a wide window.
  const near = cuts.find(m => m.ts_ms >= 800 && m.ts_ms <= 1200);
  assert(near, `scene_cut expected near 1000ms, got: ${JSON.stringify(cuts.map(c => c.ts_ms))}`);
});

// (6) Missing-ffmpeg fallback returns well-formed error.
await test("missing ffmpeg: translator surfaces FFMPEG_UNAVAILABLE without crashing", async () => {
  // Simulate a broken ffmpeg by placing a stub named `ffmpeg` FIRST on PATH.
  // The stub exits non-zero, so probeFfmpegVersion() returns null and
  // translateH264 throws FFMPEG_UNAVAILABLE. Bun itself remains reachable
  // because we preserve the rest of PATH after our stub dir.
  const stubDir = mkdtempSync(path.join(tmpdir(), "ae-ffstub-"));
  const isWin = process.platform === "win32";
  const stubName = isWin ? "ffmpeg.cmd" : "ffmpeg";
  const stubBody = isWin ? "@echo off\nexit /b 1\n" : "#!/bin/sh\nexit 1\n";
  writeFileSync(path.join(stubDir, stubName), stubBody, { mode: 0o755 });
  // The Bun subprocess needs a fresh module cache to re-probe ffmpeg.
  const scriptPath = path.join(stubDir, "probe.mjs");
  const modUrl = new URL(path.resolve(HERE, "..", "codec-translator.mjs").split(path.sep).join("/"), "file:///").href;
  const fixtureLit = JSON.stringify(FIXTURE);
  writeFileSync(scriptPath, `
    import { translateH264 } from ${JSON.stringify(modUrl)};
    try {
      const r = await translateH264({ path: ${fixtureLit} });
      process.stdout.write("UNEXPECTED_OK");
    } catch (e) {
      process.stdout.write(String(e.code) + ":" + e.message);
    }
  `);
  const pathSep = isWin ? ";" : ":";
  const env = { ...process.env, PATH: stubDir + pathSep + (process.env.PATH || process.env.Path || "") };
  const proc = Bun.spawn(["bun", scriptPath], { stdout: "pipe", stderr: "pipe", env });
  const out = await new Response(proc.stdout).text();
  const errOut = await new Response(proc.stderr).text();
  await proc.exited;
  try { rmSync(stubDir, { recursive: true, force: true }); } catch {}
  assert(
    out.startsWith("FFMPEG_UNAVAILABLE:"),
    `expected FFMPEG_UNAVAILABLE prefix, got: '${out}' stderr='${errOut.slice(0,200)}'`
  );
});

// (7) INTEGRATION: spawn gateway, POST fixture to /v1/visual/structure.
await test("integration: POST /v1/visual/structure returns a valid record", async () => {
  const port = await pickFreePort();
  const env = {
    ...process.env,
    ORANGE5_ORANGELLM_HOST: "127.0.0.1",
    ORANGE5_ORANGELLM_PORT: String(port),
    // Point Hermes upstream at a bogus port so its init doesn't try to reach
    // anything real. We don't call Hermes routes here.
    HERMES_UPSTREAM: "http://127.0.0.1:65530",
  };
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // Best-effort stderr capture for debugging.
  let stderrBuf = "";
  child.stderr.on("data", (b) => { stderrBuf += b.toString(); });
  child.stdout.on("data", () => {});
  try {
    const ready = await waitFor(`http://127.0.0.1:${port}/healthz`, 10_000);
    if (!ready) throw new Error(`gateway did not come up on :${port} — stderr tail: ${stderrBuf.slice(-500)}`);

    const bytes = readFileSync(FIXTURE);
    const boundary = "----AEStructTest" + Math.random().toString(16).slice(2);
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="source_id"\r\n\r\nintegration\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.mp4"\r\n` +
      `Content-Type: video/mp4\r\n\r\n`,
      "utf8"
    );
    const trailer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([preamble, bytes, trailer]);

    const r = await fetch(`http://127.0.0.1:${port}/v1/visual/structure`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const json = await r.json();
    assert(r.status === 200, `expected 200, got ${r.status} body=${JSON.stringify(json).slice(0, 400)}`);
    assertEqual(json.schema, "ae.structural-tokens.v1", "gateway response schema const");
    assertEqual(json.provenance.path, "codec", "provenance.path");
    assertEqual(json.provenance.source_kind, "h264", "provenance.source_kind");
    assertEqual(json.provenance.source_id, "integration", "source_id echoed from form field");
    assert(json.entities.length >= 1, `entities >=1, got ${json.entities.length}`);
    assert(json.notes.length >= 3, `notes >=3, got ${json.notes.length}`);
  } finally {
    try { child.kill("SIGKILL"); } catch {}
  }
});

// ---------- Summary ----------

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok).length;
console.log("");
console.log(`Summary: ${pass} pass / ${fail} fail of ${results.length}`);
process.exit(fail === 0 ? 0 : 1);
