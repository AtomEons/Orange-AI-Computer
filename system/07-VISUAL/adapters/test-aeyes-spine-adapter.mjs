#!/usr/bin/env bun
// test-aeyes-spine-adapter.mjs — smoke test for the spine adapter.
// Builds a mini store, submits a mock order, checks the emit envelope.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../structural/prism.mjs";
import { attachSignaturesV2 } from "../structural/identity/identity-store-v2.mjs";
import { candidatesForFrame, HUMAN_GRADE_WEIGHTS } from "../structural/identity/recognize-human-grade.mjs";
import { executeAeyesRecognize, AEYES_RECOGNIZE_ACTION } from "./aeyes-spine-adapter.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "fixtures");

const STORE = { labels: [] };
const orangeRgb = await extractImageRGB(path.join(FIXTURES, "orange.jpg"), { maxSize: 384 });
const signatures = candidatesForFrame(orangeRgb);
attachSignaturesV2(STORE, "orange", signatures, "orange.jpg", "2026-07-07");
STORE.labels[0].channel_weights = HUMAN_GRADE_WEIGHTS;

console.log("Test 1 — recognized_as:");
const okResult = await executeAeyesRecognize({
  payload: { image_path: path.join(FIXTURES, "orange.jpg"), store: STORE, opts: { useLoose: false } },
});
console.log("  schema:", okResult.schema);
console.log("  action:", okResult.action);
console.log("  status:", okResult.status);
console.log("  summary:", okResult.summary);
console.log("  winner:", okResult.output.winner, "  dist:", okResult.output.dist.toFixed(3));

console.log("\nTest 2 — needs_review:");
const rejResult = await executeAeyesRecognize({
  payload: { image_path: path.join(FIXTURES, "gradient.png"), store: STORE, opts: { useLoose: false } },
});
console.log("  status:", rejResult.status);
console.log("  summary:", rejResult.summary);
console.log("  emit_action:", rejResult.output.emit_action);

const pass = okResult.status === "ok" && okResult.output.winner === "orange" && rejResult.status === "needs_review";
console.log("\n" + (pass ? "✅ spine-adapter smoke test PASSED" : "❌ FAILED"));
console.log("Action registered as: " + AEYES_RECOGNIZE_ACTION);
process.exit(pass ? 0 : 1);
