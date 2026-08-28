#!/usr/bin/env bun
// 07-VISUAL/structural/tests/retinal-transform.test.mjs
//
// Standalone Bun harness for M3 — AE Eyes RETINAL TRANSFORM.
// Prints: Summary: N pass / M fail of T
//
// Coverage:
//   1. Determinism         — same input → identical record byte-for-byte
//   2. Schema validity     — every required field / type / enum honored
//   3. Still-image path    — gradient_energy_mean > 0, ≥ 1 entity, notes disclose no-∂L/∂t
//   4. Sequence path       — motion coherence > 0.5, ≥ 1 entity motion_field sample
//   5. Notes discipline    — non-empty, contains single-frame-∂L/∂t disclosure on still
//   6. Gateway integration — POST /v1/visual/retinal returns a valid record

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  transformImage,
  transformSequence,
  __retinalInternals,
} from "../retinal-transform.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(HERE, "..", "..", "..", "09-SCHEMAS", "ae-structural-tokens.v1.schema.json");
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });
const ok = (c, m) => { if (!c) throw new Error(m || "expected truthy"); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const gt = (a, b, m) => { if (!(a > b)) throw new Error(`${m || "expected >"}: ${a} > ${b}`); };

// ---- Test fixtures --------------------------------------------------------

function makeGradientImage(w = 64, h = 64) {
  // A ramp: left dark, right bright — pure horizontal gradient. Sobel-X should
  // pick this up strongly everywhere except the two 1-pixel border columns.
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      data[y * w + x] = Math.round((x / (w - 1)) * 255);
    }
  }
  return { data, width: w, height: h };
}

function makeCheckerBoard(w = 64, h = 64, tile = 8) {
  // High-frequency texture with clear orientation. Should yield multiple
  // texture codes and at least one entity cluster.
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = ((Math.floor(x / tile) + Math.floor(y / tile)) & 1);
      data[y * w + x] = on ? 220 : 40;
    }
  }
  return { data, width: w, height: h };
}

function makeShiftingSquareSequence(w = 64, h = 64, N = 3, step = 6) {
  // A bright square that shifts right by `step` pixels each frame on a dim bg.
  // Motion is globally coherent — coherence should be high.
  const size = 20;
  const frames = new Array(N);
  for (let f = 0; f < N; f++) {
    const buf = new Uint8Array(w * h).fill(30);
    const x0 = 10 + f * step;
    const y0 = 20;
    for (let y = y0; y < y0 + size && y < h; y++) {
      for (let x = x0; x < x0 + size && x < w; x++) {
        if (x >= 0 && x < w) buf[y * w + x] = 220;
      }
    }
    frames[f] = { data: buf, ts_ms: f * 100 };
  }
  return { frames, meta: { width: w, height: h, source_kind: "synthetic", color_space: "linear", channels: 1, sample_rate_hz: 10 } };
}

// ---- Schema validator (structural, ajv-free) -----------------------------

function validateAgainst(schema, obj) {
  const errors = [];
  walk(schema, obj, "", errors, schema);
  return { valid: errors.length === 0, errors };
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function walk(schema, value, prefix, errors, rootSchema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.const !== undefined) {
    if (value !== schema.const) errors.push(`${prefix}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) errors.push(`${prefix}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
    return;
  }
  // type check
  if (schema.type) {
    const actual = typeOf(value);
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    // "number" accepts integer too
    const match = wanted.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!match) {
      errors.push(`${prefix}: expected type ${schema.type}, got ${actual}`);
      return;
    }
  }
  if (schema.type === "object" || (!schema.type && schema.properties)) {
    if (typeof value !== "object" || Array.isArray(value) || value === null) return;
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!(r in value)) errors.push(`${prefix}: missing required "${r}"`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(value)) {
        if (!(k in schema.properties)) errors.push(`${prefix}: additional property "${k}" not allowed`);
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) walk(sub, value[k], `${prefix}.${k}`, errors, rootSchema);
      }
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return;
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${prefix}: array shorter than minItems ${schema.minItems}`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${prefix}: array longer than maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        walk(schema.items, value[i], `${prefix}[${i}]`, errors, rootSchema);
      }
    }
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value === "number") {
      if (Number.isFinite(schema.minimum) && value < schema.minimum) {
        errors.push(`${prefix}: ${value} < minimum ${schema.minimum}`);
      }
      if (Number.isFinite(schema.maximum) && value > schema.maximum) {
        errors.push(`${prefix}: ${value} > maximum ${schema.maximum}`);
      }
    }
  }
}

// ---- Tests ---------------------------------------------------------------

test("determinism_still_image_bit_exact", async () => {
  const { data, width, height } = makeGradientImage(64, 64);
  const meta = { width, height, source_kind: "synthetic", color_space: "linear", channels: 1, extracted_at_ms: 1000 };
  const a = await transformImage({ data, meta });
  const b = await transformImage({ data, meta });
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  eq(ja, jb, "same still input must produce byte-identical record");
  eq(a.id, b.id, "id must be stable");
  return `ok (record id=${a.id.slice(0, 8)}…, ${ja.length} bytes)`;
});

test("determinism_sequence_bit_exact", async () => {
  const { frames, meta } = makeShiftingSquareSequence();
  const metaWithSeed = { ...meta, extracted_at_ms: 2000 };
  const a = await transformSequence({ frames, meta: metaWithSeed });
  const b = await transformSequence({ frames, meta: metaWithSeed });
  eq(JSON.stringify(a), JSON.stringify(b), "same sequence input must produce byte-identical record");
  return `ok (id=${a.id.slice(0, 8)}…)`;
});

test("schema_valid_still", async () => {
  const { data, width, height } = makeCheckerBoard(64, 64, 8);
  const meta = { width, height, source_kind: "synthetic", color_space: "linear", channels: 1, extracted_at_ms: 3000 };
  const rec = await transformImage({ data, meta });
  const { valid, errors } = validateAgainst(SCHEMA, rec);
  if (!valid) throw new Error(`schema errors:\n  - ${errors.slice(0, 6).join("\n  - ")}`);
  eq(rec.schema, "ae.structural-tokens.v1", "schema tag");
  eq(rec.provenance.path, "retinal", "path");
  ok(rec.retinal_fields, "retinal_fields present");
  return `ok (${Object.keys(rec).length} top-level fields, ${rec.entities.length} entities, ${rec.texture_vocabulary.length} texture codes)`;
});

test("schema_valid_sequence", async () => {
  const { frames, meta } = makeShiftingSquareSequence();
  const rec = await transformSequence({ frames, meta: { ...meta, extracted_at_ms: 4000 } });
  const { valid, errors } = validateAgainst(SCHEMA, rec);
  if (!valid) throw new Error(`schema errors:\n  - ${errors.slice(0, 8).join("\n  - ")}`);
  eq(rec.temporal.frame_count, 3, "frame_count");
  gt(rec.temporal.duration_ms, 0, "duration_ms > 0");
  return `ok (frame_count=${rec.temporal.frame_count}, duration_ms=${rec.temporal.duration_ms})`;
});

test("still_image_gradient_energy_and_entities", async () => {
  const { data, width, height } = makeCheckerBoard(64, 64, 8);
  const meta = { width, height, source_kind: "synthetic", color_space: "linear", channels: 1, extracted_at_ms: 5000 };
  const rec = await transformImage({ data, meta });
  gt(rec.retinal_fields.gradient_energy_mean, 0, "checkerboard must have non-zero gradient energy");
  ok(rec.entities.length >= 1, `expected ≥ 1 entity on checkerboard, got ${rec.entities.length}`);
  eq(rec.retinal_fields.motion_correlation_coherence, 0, "still image must report 0 motion coherence");
  eq(rec.retinal_fields.temporal_derivative_mean, 0, "still image must report 0 temporal derivative");
  return `ok (grad_energy=${rec.retinal_fields.gradient_energy_mean.toFixed(3)}, entities=${rec.entities.length})`;
});

test("sequence_motion_detected", async () => {
  const { frames, meta } = makeShiftingSquareSequence();
  const rec = await transformSequence({ frames, meta: { ...meta, extracted_at_ms: 6000 } });
  gt(rec.retinal_fields.motion_correlation_coherence, 0.5,
    `shifting-square sequence must have coherence > 0.5, got ${rec.retinal_fields.motion_correlation_coherence.toFixed(3)}`);
  ok(rec.entities.length >= 1, `expected ≥ 1 entity on sequence, got ${rec.entities.length}`);
  // At least one entity must have at least one motion_field sample.
  const hasMotion = rec.entities.some((e) => Array.isArray(e.motion_field) && e.motion_field.length > 0);
  ok(hasMotion, "at least one entity must emit ≥ 1 motion_field sample");
  gt(rec.retinal_fields.temporal_derivative_mean, 0, "temporal_derivative_mean must be positive on a moving sequence");
  return `ok (coherence=${rec.retinal_fields.motion_correlation_coherence.toFixed(3)}, entities=${rec.entities.length}, ∂L/∂t=${rec.retinal_fields.temporal_derivative_mean.toFixed(4)})`;
});

test("still_image_notes_disclose_no_temporal_derivative", async () => {
  const { data, width, height } = makeGradientImage(64, 64);
  const meta = { width, height, source_kind: "synthetic", color_space: "linear", channels: 1, extracted_at_ms: 7000 };
  const rec = await transformImage({ data, meta });
  ok(Array.isArray(rec.notes) && rec.notes.length > 0, "notes[] must be non-empty");
  const joined = rec.notes.join("\n");
  ok(/single-frame/.test(joined) && /∂L\/∂t|temporal derivative/.test(joined),
    `expected single-frame + ∂L/∂t disclosure in notes, got:\n${joined}`);
  return `ok (${rec.notes.length} note(s))`;
});

test("gradient_signature_matches_intuition", async () => {
  const { data, width, height } = makeGradientImage(32, 32);
  const gradField = __retinalInternals.sobel(new Float32Array(Array.from(data, (v) => v / 255)), width, height);
  // Middle row, middle column should have strong X-gradient magnitude.
  const mid = gradField[16 * 32 + 16];
  gt(mid, 0.05, `Sobel on horizontal ramp must produce non-trivial magnitude at center, got ${mid}`);
  // Interior magnitude should be roughly constant across a linear ramp.
  // Note the source is Uint8-quantized (~ 8.2/255 step per column) so the
  // exact Sobel output varies by at most one quantization step. Tolerance
  // is 2 * (4/255) ≈ 0.031 — one step above quantization noise.
  const samples = [gradField[16*32+8], gradField[16*32+16], gradField[16*32+24]];
  const s0 = samples[0];
  const QUANTIZATION_TOL = 2 * (4 / 255); // 2 Uint8 discrete steps
  for (const s of samples) {
    if (Math.abs(s - s0) > QUANTIZATION_TOL) {
      throw new Error(`interior gradient exceeds Uint8 quantization tolerance ${QUANTIZATION_TOL.toFixed(4)}: ${samples}`);
    }
  }
  return `ok (interior grad mag ≈ ${mid.toFixed(4)} ± ${QUANTIZATION_TOL.toFixed(4)})`;
});

test("gateway_integration_end_to_end", async () => {
  // Start the gateway on a scratch port, POST a synthetic image, check the record.
  const port = 13370 + Math.floor(Math.random() * 900);
  const gatewayPath = path.resolve(HERE, "..", "..", "..", "06-ORANGELLM", "server", "index.mjs");

  const child = spawn(process.execPath, [gatewayPath], {
    env: {
      ...process.env,
      ORANGE5_ORANGELLM_HOST: "127.0.0.1",
      ORANGE5_ORANGELLM_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });

  const shutdown = () => new Promise((res) => {
    if (child.exitCode !== null) return res();
    child.once("exit", () => res());
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {}; res(); }, 2000);
  });

  try {
    // Wait for the listener.
    let up = false;
    const start = Date.now();
    while (Date.now() - start < 8000) {
      await sleep(150);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (r.ok) { up = true; break; }
      } catch {}
    }
    if (!up) throw new Error(`gateway did not come up on :${port}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);

    // Build a synthetic raw-luminance payload and POST it as JSON.
    const w = 32, h = 32;
    const data = Array.from({ length: w * h }, (_, i) => (i % w) * 8);
    const body = {
      raw_luminance: data,
      meta: {
        width: w, height: h,
        source_kind: "synthetic",
        color_space: "linear",
        channels: 1,
        extracted_at_ms: 8000,
      },
    };
    const r = await fetch(`http://127.0.0.1:${port}/v1/visual/retinal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`retinal route returned ${r.status}: ${txt}`);
    }
    const rec = await r.json();
    const { valid, errors } = validateAgainst(SCHEMA, rec);
    if (!valid) throw new Error(`gateway record fails schema:\n  - ${errors.slice(0, 6).join("\n  - ")}`);
    eq(rec.schema, "ae.structural-tokens.v1", "schema tag");
    eq(rec.provenance.path, "retinal", "path");
    ok(rec.notes && rec.notes.length > 0, "notes non-empty");
    return `ok (id=${rec.id.slice(0, 8)}…, ${rec.entities.length} entities)`;
  } finally {
    await shutdown();
  }
});

// ---- Runner --------------------------------------------------------------

console.log("AE Eyes retinal transform — M3");
console.log("Bun " + (process.versions?.bun || "unknown"));
console.log("");
let pass = 0, fail = 0;
for (const t of TESTS) {
  const t0 = Date.now();
  try {
    const note = await t.fn();
    pass++;
    console.log(`  PASS  ${t.name.padEnd(52)} ${(Date.now() - t0).toString().padStart(5)}ms  ${note || ""}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${t.name.padEnd(52)} ${(Date.now() - t0).toString().padStart(5)}ms  ${e.message}`);
  }
}
console.log("");
console.log(`Summary: ${pass} pass / ${fail} fail of ${TESTS.length}`);
if (fail > 0) process.exit(1);
