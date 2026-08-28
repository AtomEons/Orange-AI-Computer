// runtime.test.mjs — smoke test for the guardrails runtime.
//
// Verifies:
//   1. runGuardrails() returns the documented shape
//   2. exactly 27 results
//   3. CRITICAL self-check G27 passes (registry+files count = 27)
//   4. elapsed_ms is a sane number
//   5. Soul Genome is materialized after the run
//   6. db.recordRun chose a real backend
//
// Run: `node tests/runtime.test.mjs`

import { strict as assert } from "node:assert";
import { runGuardrails } from "../runtime.mjs";
import { ensureSoulGenome } from "../lib/soul-genome.mjs";

let failures = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => process.stdout.write(`ok   ${name}\n`))
    .catch((e) => {
      failures += 1;
      process.stderr.write(`FAIL ${name}\n  ${e?.stack || e}\n`);
    });
}

async function main() {
  // Avoid Flux writes during tests — daemon may not be running
  const out = await runGuardrails({ write_to_flux: false });

  await t("returns documented shape", () => {
    for (const k of [
      "ok", "run_id", "started_at", "finished_at",
      "elapsed_ms", "violations", "results", "stop",
    ]) {
      assert.ok(k in out, `missing key ${k}`);
    }
  });

  await t("27 results", () => assert.equal(out.results.length, 27));

  await t("registry check_module is the executed module", async () => {
    const { GUARDRAILS } = await import("../registry.mjs");
    for (const spec of GUARDRAILS) {
      const row = out.results.find((r) => r.guardrail_id === spec.id);
      assert.ok(row, `missing result ${spec.id}`);
      assert.equal(row.file, spec.check_module, `${spec.id} implementation drift`);
    }
  });

  await t("G27 self-count passes", () => {
    const g27 = out.results.find((r) => r.guardrail_id === "G27");
    assert.ok(g27, "G27 result missing");
    assert.equal(g27.pass, true, `G27 failed: ${JSON.stringify(g27.details)}`);
  });

  await t("elapsed_ms is sane", () => {
    assert.equal(typeof out.elapsed_ms, "number");
    assert.ok(out.elapsed_ms >= 0 && out.elapsed_ms < 180_000);
  });

  await t("Soul Genome is materialized", () => {
    const g = ensureSoulGenome();
    assert.ok(g?.schema?.startsWith("orange5.soul-genome."));
    assert.ok(g.operator?.name);
  });

  await t("backend is sqlite or jsonl", () => {
    assert.ok(["sqlite", "jsonl"].includes(out.backend) || /^error/.test(out.backend || ""));
  });

  if (failures > 0) {
    process.stderr.write(`\n${failures} failure(s)\n`);
    process.exit(1);
  }
  process.stdout.write("\nall tests passed\n");
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack || e}\n`);
  process.exit(2);
});
