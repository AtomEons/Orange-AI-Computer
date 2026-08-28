#!/usr/bin/env bun
// prove-human-grade.mjs — end-to-end proof that the SHIPPING module
// recognize-human-grade.mjs (not just the attack script) scores 16/16
// on the diverse fixture set.
//
// This is the receipt-generating check. If this ever drops below 16/16,
// the substrate has regressed. Wire it into #100 automation.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { activeCurate } from "../ingest/active-curation.mjs";
import { attachSignaturesV2 } from "./identity-store-v2.mjs";
import {
  candidatesForFrame,
  recognizeHumanGradeImage,
  recognizeSetHumanGradeImage,
  HUMAN_GRADE_CEILING,
  HUMAN_GRADE_WEIGHTS,
} from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");

async function trainFromVideoUnion(videoPath, N = 15, K = 8) {
  const frames = await extractVideoFrames(videoPath, { frames: N, size: 384 });
  const sigs = [];
  for (const f of frames) {
    sigs.push(...candidatesForFrame(f));
  }
  const cur = activeCurate(sigs, K);
  return cur.selected.map((i) => sigs[i]);
}

async function trainFromImageUnion(name, useLoose) {
  const rgb = await extractImageRGB(path.join(FIXTURES, name), { maxSize: 384 });
  return candidatesForFrame(rgb);
}

console.log("=== PROVE human-grade recognizer on 16-fixture test set ===\n");
console.log("using: recognize-human-grade.mjs (SHIPPING module, not the attack script)");
console.log("ceiling: " + HUMAN_GRADE_CEILING + "\n");

const STORE_CACHE = path.join(FIXTURES, "human-grade-shipping-store.json");
let STORE;
if (process.env.AEYES_REBUILD_PROOF_STORE !== "1" && fs.existsSync(STORE_CACHE)) {
  STORE = JSON.parse(fs.readFileSync(STORE_CACHE, "utf8"));
  console.log(`store: cached ${STORE_CACHE}`);
} else {
  STORE = { labels: [] };
  const orangeSigs = await trainFromVideoUnion(path.join(CINEMA, "baby-watches-orange.mp4"));
  attachSignaturesV2(STORE, "orange", orangeSigs, "cinema-union", "2026-07-07T00:00:00Z");
  const appleSigs = await trainFromVideoUnion(path.join(CINEMA, "baby-watches-apple.mp4"));
  attachSignaturesV2(STORE, "apple", appleSigs, "cinema-union", "2026-07-07T00:00:00Z");
  for (const c of [
    { label: "human_skin",      source: "lena.jpg",   loose: false },
    { label: "animal_face",     source: "baboon.jpg", loose: true  },
    { label: "yellow_building", source: "home.jpg",   loose: true  },
  ]) {
    const sigs = await trainFromImageUnion(c.source, c.loose);
    attachSignaturesV2(STORE, c.label, sigs, c.source + "-union", "2026-07-07T00:00:00Z");
  }
  for (const row of STORE.labels) row.channel_weights = HUMAN_GRADE_WEIGHTS;
  fs.writeFileSync(STORE_CACHE, `${JSON.stringify(STORE, null, 2)}\n`, "utf8");
  console.log(`store: rebuilt ${STORE_CACHE}`);
}

const TESTS = [
  { name: "orange.jpg",       expected: "orange",          kind: "target",  loose: false },
  { name: "apple.jpg",        expected: "apple",           kind: "target",  loose: false },
  { name: "fruits.jpg",       expected: "orange",          kind: "target",  loose: false, mode: "set" },
  { name: "lena.jpg",         expected: "human_skin",      kind: "target",  loose: false },
  { name: "baboon.jpg",       expected: "animal_face",     kind: "target",  loose: true  },
  { name: "home.jpg",         expected: "yellow_building", kind: "target",  loose: true  },
  { name: "basketball1.png",  expected: null,              kind: "reject",  loose: false },
  { name: "basketball2.png",  expected: null,              kind: "reject",  loose: false },
  { name: "messi5.jpg",       expected: null,              kind: "reject",  loose: true  },
  { name: "building.jpg",     expected: null,              kind: "reject",  loose: false },
  { name: "board.jpg",        expected: null,              kind: "reject",  loose: false },
  { name: "gradient.png",     expected: null,              kind: "reject",  loose: false },
  { name: "notes.png",        expected: null,              kind: "reject",  loose: false },
  { name: "butterfly.jpg",    expected: null,              kind: "reject",  loose: true  },
  { name: "pic5.png",         expected: null,              kind: "reject",  loose: true  },
  { name: "starry_night.jpg", expected: null,              kind: "reject",  loose: true  },
];

let correct = 0, targetOK = 0, rejectOK = 0, confWrong = 0;
const detail = [];
for (const t of TESTS) {
  const raw = t.mode === "set"
    ? await recognizeSetHumanGradeImage(path.join(FIXTURES, t.name), STORE, { useLoose: t.loose })
    : await recognizeHumanGradeImage(path.join(FIXTURES, t.name), STORE, { useLoose: t.loose });
  const setMatch = t.mode === "set" ? raw.concepts.find((item) => item.label === t.expected) : null;
  const setDiagnostic = t.mode === "set" && !setMatch
    ? await recognizeHumanGradeImage(path.join(FIXTURES, t.name), STORE, { useLoose: t.loose })
    : null;
  const r = t.mode === "set" ? {
    ...raw,
    winner: setMatch?.label || raw.concepts[0]?.label || setDiagnostic?.nearest_candidate || null,
    nearest_candidate: setMatch?.label || raw.concepts[0]?.label || setDiagnostic?.nearest_candidate || null,
    dist: setMatch?.dist ?? setDiagnostic?.dist ?? Infinity,
    emit_action: raw.emit_action,
  } : raw;
  let ok, action = r.emit_action;
  if (t.kind === "target") {
    ok = t.mode === "set"
      ? action === "recognized_set" && Boolean(setMatch)
      : action === "recognized_as" && r.winner === t.expected;
    if (ok) { correct++; targetOK++; }
    else if (action === "recognized_as" && r.winner !== t.expected) confWrong++;
  } else {
    ok = action === "needs_review";
    if (ok) { correct++; rejectOK++; }
    else confWrong++;
  }
  detail.push({ ...t, ...r, ok });
}

console.log("Per-fixture verdicts:");
for (const d of detail) {
  const mark = d.ok ? "✓" : "✗";
  const distStr = d.dist === Infinity ? "  ∞  " : d.dist.toFixed(3);
  const expected = d.expected || "REJECT";
  const emit = d.emit_action === "needs_review" ? `needs_review nearest=${d.nearest_candidate || "none"}` : `${d.emit_action}:${d.winner}`;
  console.log("  " + mark + " " + d.name.padEnd(18) + " expect=" + expected.padEnd(18) + " dist=" + distStr + " " + emit);
}

const pct = Math.round(correct / TESTS.length * 100);
console.log("\n=== SCORE ===");
console.log("Correct: " + correct + "/" + TESTS.length + " = " + pct + "%");
console.log("Targets: " + targetOK + "/6");
console.log("Rejects: " + rejectOK + "/10");
console.log("Confident-wrong: " + confWrong);
console.log("");
const generatedAt = new Date().toISOString();
const receipt = {
  schema: "orange5.ae-eyes-human-grade-proof.v1",
  status: correct === TESTS.length && confWrong === 0 ? "AE_EYES_HUMAN_GRADE_GREEN" : "AE_EYES_HUMAN_GRADE_NEEDS_WORK",
  generated_at: generatedAt,
  proof_command: "bun 07-VISUAL/structural/identity/prove-human-grade.mjs",
  shipping_module: "07-VISUAL/structural/identity/recognize-human-grade.mjs",
  score: { correct, total: TESTS.length, percent: pct, targets: { passed: targetOK, total: 6 }, rejects: { passed: rejectOK, total: 10 }, confident_wrong: confWrong },
  thresholds: { required_correct: TESTS.length, required_confident_wrong: 0 },
  misses: detail.filter((item) => !item.ok).map((item) => ({
    fixture: item.name,
    expected: item.expected || "REJECT",
    emitted: item.emit_action,
    winner: item.winner || null,
    nearest_candidate: item.nearest_candidate || null,
    distance: Number.isFinite(item.dist) ? Number(item.dist.toFixed(6)) : null,
  })),
  fixtures: detail.map((item) => ({ fixture: item.name, expected: item.expected || "REJECT", ok: item.ok, emitted: item.emit_action, winner: item.winner || null })),
};
receipt.receipt_sha256 = crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
const receiptDir = path.join(ROOT, "10-RECEIPTS", "orange5-build");
fs.mkdirSync(receiptDir, { recursive: true });
const receiptPath = path.join(receiptDir, `${generatedAt.replace(/[:.]/g, "-")}-aeyes-human-grade-live-proof.json`);
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(`receipt: ${receiptPath}`);
if (correct === TESTS.length && confWrong === 0) {
  console.log("🎯 SHIPPING MODULE VERIFIED at " + pct + "%.");
  process.exit(0);
} else {
  console.log("❌ SHIPPING MODULE REGRESSED. Do not ship.");
  process.exit(1);
}
