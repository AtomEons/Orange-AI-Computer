#!/usr/bin/env node
// classifier.smoke.mjs — hermetic unit smoke for the lane classifier.
// No network. No Ollama. Exercises classifyByOrigin + classify() with the
// Ollama tiebreak monkey-patched to a deterministic fake.
//
// Run:
//   node C:/AtomEons/Orange5/06-ORANGELLM/n150-utility/classifier/tests/classifier.smoke.mjs
//
// Exit 0 = all pass. Exit 1 = at least one fail (with the failing case).

import {
  classifyByOrigin,
  classify,
  REALITY_ORIGIN_PREFIXES,
  THOUGHT_ORIGIN_PREFIXES,
  VERSION,
} from "../daemon.mjs";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  ${tag} ${name}${detail ? "  — " + detail : ""}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log(`[smoke] n150-classifier ${VERSION}`);
console.log("");
console.log("[1] classifyByOrigin: reality prefixes route to reality");
for (const p of REALITY_ORIGIN_PREFIXES) {
  const r = classifyByOrigin(`${p}example.event`);
  eq(`  ${p}* → reality`, { lane: r.lane, source: r.source }, { lane: "reality", source: "origin_rule" });
}

console.log("");
console.log("[2] classifyByOrigin: thought prefixes route to thought");
for (const p of THOUGHT_ORIGIN_PREFIXES) {
  const r = classifyByOrigin(`${p}example.event`);
  eq(`  ${p}* → thought`, { lane: r.lane, source: r.source }, { lane: "thought", source: "origin_rule" });
}

console.log("");
console.log("[3] classifyByOrigin: unknown origin returns merge with confidence 0");
const unknown = classifyByOrigin("totally.unrecognized.origin");
eq("  unknown → merge", unknown.lane, "merge");
eq("  unknown confidence 0", unknown.confidence, 0.0);

console.log("");
console.log("[4] classifyByOrigin: empty/missing origin returns merge");
eq("  '' → merge", classifyByOrigin("").lane, "merge");
eq("  null → merge", classifyByOrigin(null).lane, "merge");
eq("  undefined → merge", classifyByOrigin(undefined).lane, "merge");

console.log("");
console.log("[5] classifyByOrigin: case-insensitive prefix match");
eq("  RECEIPT.X → reality", classifyByOrigin("RECEIPT.signed.event").lane, "reality");
eq("  Chat.Foo → thought", classifyByOrigin("Chat.Foo").lane, "thought");

console.log("");
console.log("[6] classify(): origin-rule short-circuits the model (no Ollama call)");
// Save and stub global fetch — if classify hits the model, fetch would be
// called and we'd see it in the spy. For reality/thought origins, no call.
const fetchSpy = { calls: 0 };
const origFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchSpy.calls += 1; return { ok: false, status: 599 }; };
try {
  const r1 = await classify({ origin: "receipt.cobra.write" });
  eq("  reality origin → reality lane", r1.lane, "reality");
  const r2 = await classify({ origin: "chat.user.msg" });
  eq("  thought origin → thought lane", r2.lane, "thought");
  eq("  no fetch calls for ruled origins", fetchSpy.calls, 0);
} finally {
  globalThis.fetch = origFetch;
}

console.log("");
console.log("[7] classify(): merge-origin + Ollama unreachable defaults to thought");
const origFetch2 = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
try {
  const r = await classify({ origin: "weird.unknown.origin", event_metadata: { x: 1 } });
  eq("  unreachable → thought", r.lane, "thought");
  eq("  source = model_unreachable_default_thought", r.source, "model_unreachable_default_thought");
} finally {
  globalThis.fetch = origFetch2;
}

console.log("");
console.log("[8] classify(): merge-origin + valid model tiebreak picks the model's lane");
const origFetch3 = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  // Sanity: hits /api/generate with our prompt + active model.
  const body = JSON.parse(init?.body || "{}");
  if (!body.prompt || !body.model) throw new Error("missing prompt/model");
  return {
    ok: true,
    status: 200,
    json: async () => ({ response: "reality" }),
  };
};
try {
  const r = await classify({ origin: "novel.signal.x", event_metadata: { fd: "f1" } });
  eq("  tiebreak → reality", r.lane, "reality");
  eq("  source = model_tiebreak", r.source, "model_tiebreak");
  check("  confidence in (0,1)", r.confidence > 0 && r.confidence < 1, `got ${r.confidence}`);
} finally {
  globalThis.fetch = origFetch3;
}

console.log("");
console.log("[9] classify(): malformed model output defaults to thought");
const origFetch4 = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ response: "I think it could maybe be a sort of thing" }),
});
try {
  const r = await classify({ origin: "very.unknown.prefix" });
  eq("  malformed → thought", r.lane, "thought");
  eq("  source = model_unreachable_default_thought", r.source, "model_unreachable_default_thought");
} finally {
  globalThis.fetch = origFetch4;
}

console.log("");
console.log("[10] classify(): non-string origin → invalid_input_default_thought");
const rBad = await classify({ origin: 42 });
eq("  numeric origin → thought", rBad.lane, "thought");
eq("  source = invalid_input_default_thought", rBad.source, "invalid_input_default_thought");

// Summary
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log("");
console.log(`[smoke] ${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed === 0 ? 0 : 1);
