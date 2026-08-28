// AtomSmasher 2 — module registry.
//
// WHY THIS FILE CHANGED
// The previous version hand-declared a `status` string per module. It was
// wrong about 9 of 12 entries, in both directions:
//
//   * saved-work-certs / canon-pressure / pathwave-compressor were listed as
//     real modules; no implementation file exists anywhere in the repo. The
//     Operational Theory doc §6.9/§6.10/§6.11 goes further and claims live
//     encoders and "56/56 smoke-test" for them. That claim has no code behind it.
//   * commitment-atoms, compression-debt, cartridges, sparse-worksets,
//     least-action-router and expansion-warrants were all marked STUB while
//     carrying real implementations (compression-debt/ledger.mjs alone is a
//     ~700-line API with record/pay/forgive/summary).
//
// ATOMSMASHER_2_OPERATIONAL_THEORY.md §1.3 already named this as an open item —
// "Do not leave status surfaces disagreeing" — and it stayed open because the
// fix attempted was to correct the table. A hand-maintained status table drifts
// the moment anyone touches the tree. So the table is gone.
//
// Status is now DERIVED FROM DISK on every call. The registry declares only
// what it EXPECTS (path + the exports that define the module's contract) and
// then reports what is actually there. It cannot claim a module exists when the
// file does not, and it cannot call something a stub when the code is present.
//
// HONESTY BOUNDARY (Orange5 Operational Law)
// Static inspection can prove code EXISTS and EXPORTS what it promises. It
// cannot prove the code RUNS. So this module never emits `OPERATIONAL` — that
// status requires a fresh proof receipt per ORANGE5_OPERATIONAL_LAW.md, which
// only a real run can produce. The strongest verdict here is CODE_PRESENT.
// Anything that wants to say OPERATIONAL must consult receipts, not this file.
//
// Bun only. Pure built-ins. No imports of the modules themselves — importing to
// probe would execute side effects and would fail closed on an unrelated broken
// dependency, reporting ABSENT for code that is present. We read source text.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { antiFluffGate } from "./anti-fluff.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PILLAR_ROOT = path.resolve(HERE, "..");   // 12-ATOMSMASHER/

export const REGISTRY_SCHEMA = "orange5.atomsmasher.registry.v1";

/**
 * Derived statuses. Ordered weakest → strongest. None of these means
 * "operational"; see the honesty boundary above.
 */
export const STATUS = Object.freeze({
  ABSENT: "ABSENT",                     // the doctrine names it; no code exists
  EXPORTS_MISSING: "EXPORTS_MISSING",   // file is there, contract exports are not — drift
  CODE_PRESENT: "CODE_PRESENT",         // file present, declared exports found
});

/**
 * What each module is EXPECTED to be. `expects` lists exports that constitute
 * the module's contract — if the file no longer provides them, that is drift and
 * the registry says so rather than reporting a healthy stub.
 *
 * `impl` is only set for modules imported directly by this file (in-process
 * callers rely on it). Everything else is probed on disk.
 */
const EXPECTED = {
  "commitment-atoms":    { role: "Irreducible promise units",           file: "commitment-atoms/encoder.mjs",     expects: ["encodeAtom", "mintAtom", "encode"] },
  "air-codec":           { role: "Atomic Information Representation",   file: "air-codec/codec.mjs",              expects: ["encodeAir", "toAir", "encode"] },
  "equation-store":      { role: "Canonical math/logic facts",          file: "equation-store/store.mjs",         expects: ["putEquation", "storeEquation", "fit"] },
  "cartridges":          { role: "Pre-compressed knowledge packs",      file: "cartridges/registry.mjs",          expects: ["loadCartridge", "listCartridges", "load"] },
  "sparse-worksets":     { role: "Only the lines that matter",          file: "sparse-worksets/compressor.mjs",   expects: ["buildWorkset", "compress"] },
  "least-action-router": { role: "Shortest path to answer",             file: "least-action/router.mjs",          expects: ["route", "pickTier", "score"] },
  "expansion-warrants":  { role: "Scope-growth permission",             file: "expansion-warrants/warrant.mjs",   expects: ["issueWarrant", "validateWarrant", "consume"] },
  "compression-debt":    { role: "Tracks verbose fallback",             file: "compression-debt/ledger.mjs",      expects: ["recordDebt", "payDebt", "debtSummary"] },
  "saved-work-certs":    { role: "Recomputation proof",                 file: "saved-work/certificate.mjs",       expects: ["mintCertificate", "redeem", "verify"] },
  "canon-pressure":      { role: "Doctrine promotion detector",         file: "canon-pressure/detector.mjs",      expects: ["observeCandidate", "pressureState"] },
  "pathwave-compressor": { role: "Compresses execution traces",         file: "pathwave/compressor.mjs",          expects: ["compressPathwave", "diffPathwaves"] },
  "anti-fluff-gate":     { role: "Refuses verbose output",              file: "modules/anti-fluff.mjs",           expects: ["antiFluffGate"], impl: antiFluffGate },
};

/** Cheap static export scan. Does NOT execute the module. */
function scanExports(absPath) {
  let src;
  try { src = fs.readFileSync(absPath, "utf8"); } catch { return null; }
  const found = new Set();
  // export function f / export async function f / export const X / export class C
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) found.add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) found.add(name);
    }
  }
  return { exports: [...found].sort(), bytes: src.length, lines: src.split("\n").length };
}

/** Is there any test/smoke file alongside this module? Static signal only. */
function hasTestArtifacts(moduleDir) {
  const abs = path.join(PILLAR_ROOT, moduleDir);
  const hits = [];
  const walk = (dir, depth = 0) => {
    if (depth > 2) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, depth + 1); }
      else if (/\.(test|spec)\.mjs$|smoke.*\.mjs$/i.test(e.name)) hits.push(path.relative(PILLAR_ROOT, p).replace(/\\/g, "/"));
    }
  };
  walk(abs);
  return hits;
}

/**
 * Probe one module against disk. Returns the derived truth, never a claim.
 */
export function probeModule(id) {
  const spec = EXPECTED[id];
  if (!spec) return null;
  const abs = path.join(PILLAR_ROOT, spec.file);
  const scan = scanExports(abs);

  if (!scan) {
    // Look for ANY .mjs under the module's directory before declaring absence —
    // the expected filename may simply differ from what the doctrine assumed.
    const dir = spec.file.split("/")[0];
    let siblings = [];
    try {
      siblings = fs.readdirSync(path.join(PILLAR_ROOT, dir)).filter((f) => f.endsWith(".mjs"));
    } catch { /* directory itself is absent */ }
    return {
      id, role: spec.role, status: STATUS.ABSENT,
      expectedFile: spec.file, found: null,
      siblingsInDir: siblings,
      note: siblings.length
        ? `expected file missing, but ${siblings.length} other .mjs present in ${dir}/ — path in registry may be stale`
        : `no implementation found under ${dir}/`,
      tests: hasTestArtifacts(dir),
    };
  }

  const present = spec.expects.filter((e) => scan.exports.includes(e));
  const status = present.length > 0 ? STATUS.CODE_PRESENT : STATUS.EXPORTS_MISSING;
  return {
    id, role: spec.role, status,
    expectedFile: spec.file, found: spec.file,
    lines: scan.lines, bytes: scan.bytes,
    contractExportsFound: present,
    contractExportsMissing: spec.expects.filter((e) => !present.includes(e)),
    exportCount: scan.exports.length,
    tests: hasTestArtifacts(spec.file.split("/")[0]),
    ...(status === STATUS.EXPORTS_MISSING
      ? { note: `file present (${scan.exports.length} exports) but none of the expected contract exports [${spec.expects.join(", ")}] — registry contract is stale or the module was refactored` }
      : {}),
  };
}

/**
 * The status surface. Derived on every call — it cannot go stale, because
 * there is nothing to keep up to date.
 */
export function listModules() {
  return Object.keys(EXPECTED).map(probeModule);
}

/** Roll-up for a status report. Reports honest gaps, never a green count. */
export function registrySummary() {
  const mods = listModules();
  const by = (s) => mods.filter((m) => m.status === s);
  const absent = by(STATUS.ABSENT);
  const drift = by(STATUS.EXPORTS_MISSING);
  return {
    schema: REGISTRY_SCHEMA,
    total: mods.length,
    codePresent: by(STATUS.CODE_PRESENT).length,
    exportsMissing: drift.length,
    absent: absent.length,
    absentIds: absent.map((m) => m.id),
    driftIds: drift.map((m) => m.id),
    untested: mods.filter((m) => m.status !== STATUS.ABSENT && m.tests.length === 0).map((m) => m.id),
    boundary:
      "Derived by static inspection. CODE_PRESENT proves the file and its contract exports exist — " +
      "it does NOT prove the module runs. Per ORANGE5_OPERATIONAL_LAW.md, OPERATIONAL requires a fresh " +
      "proof receipt and is never emitted by this registry.",
    docConflict:
      absent.length > 0
        ? `ATOMSMASHER_2_OPERATIONAL_THEORY.md describes ${absent.map((m) => m.id).join(", ")} as implemented (§6.9-§6.11 claim live encoders and smoke tests). No code exists for them. The doc overstates the build; this registry reports disk.`
        : null,
  };
}

/** In-process implementations, for callers that need the function itself. */
export const IMPLS = Object.freeze(
  Object.fromEntries(Object.entries(EXPECTED).filter(([, v]) => v.impl).map(([k, v]) => [k, v.impl]))
);

// Back-compat: older callers imported MODULES and read .status/.role.
// Kept as a getter so it reflects disk rather than freezing a stale snapshot.
export const MODULES = new Proxy({}, {
  get: (_t, id) => (typeof id === "string" ? probeModule(id) ?? undefined : undefined),
  has: (_t, id) => typeof id === "string" && id in EXPECTED,
  ownKeys: () => Object.keys(EXPECTED),
  getOwnPropertyDescriptor: (_t, id) =>
    typeof id === "string" && id in EXPECTED
      ? { enumerable: true, configurable: true, value: probeModule(id) }
      : undefined,
});
