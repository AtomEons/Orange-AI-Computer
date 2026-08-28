#!/usr/bin/env bun
// prove-gate-7-cache-invalidation.mjs — automated cache invalidation tests.
// GPT doctrine v5 checkpoint 6: gate 7 satisfied only when these pass.

import { extractImageRGB } from "./prism.mjs";
import { buildStaticCaptureWithTaps } from "./build-static-capture.mjs";
import { buildCacheIdentity, isCacheHit, RADIAL_PHOTON_VERSION } from "./cache-identity.mjs";

const passes = [];
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { passes.push(name); console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

const rgb = await extractImageRGB("C:/AtomEons/Orange5/07-VISUAL/fixtures/orange.jpg", { maxSize: 384 });

// ---- test 1: same source + same code + same config → cache hit ----
const { record: r1 } = buildStaticCaptureWithTaps(rgb, { rawRef: "orange.jpg" });
const { record: r2 } = buildStaticCaptureWithTaps(rgb, { rawRef: "orange.jpg" });
check("same_input_same_pipeline_cache_hit",
      isCacheHit(r1.integrity.cacheIdentity, r2.integrity.cacheIdentity),
      `cacheKey=${r1.integrity.cacheKey}`);

check("recordHash_matches_across_runs",
      r1.integrity.recordHash === r2.integrity.recordHash,
      `${r1.integrity.recordHash}`);

// ---- test 2: same source + changed axis version → cache miss ----
const idA = buildCacheIdentity({ sourceHash: r1.integrity.sourceHash }).identity;
const idB = { ...idA, dependencies: { ...idA.dependencies, radial_photon: "radial_photon-9.9.9" } };
check("changed_axis_version_cache_miss",
      !isCacheHit(idA, idB),
      "flipped radial_photon version");

// ---- test 3: same source + changed CAT02 version → cache miss ----
const idC = { ...idA, dependencies: { ...idA.dependencies, cat02: "cat02-9.9.9" } };
check("changed_cat02_version_cache_miss", !isCacheHit(idA, idC));

// ---- test 4: same source + changed numerical precision → cache miss ----
const idD = { ...idA, runtimeNumericMode: "float64-cache" };
check("changed_numeric_mode_cache_miss", !isCacheHit(idA, idD));

// ---- test 5: same source + changed schema → cache miss ----
const idE = { ...idA, captureSchema: "AEYES1-PHOTON-CAPTURE-1.1-TEMPORAL" };
check("changed_schema_cache_miss", !isCacheHit(idA, idE));

// ---- test 6: changed source + identical pipeline → cache miss ----
const idF = { ...idA, sourceHash: "different_source_hash" };
check("changed_source_cache_miss", !isCacheHit(idA, idF));

// ---- test 7: deliberately changed dependency constant with no output difference ----
// If an axis version bumps but the axis implementation was unchanged, the cache
// still invalidates — lineage discipline demands it. This is the point.
const idG = { ...idA, dependencies: { ...idA.dependencies, iris: "iris-1.0-touched" } };
check("changed_dependency_no_output_diff_still_miss", !isCacheHit(idA, idG));

// ---- test 8: identical cache identity across separate processes ----
// (Same-process proxy: rebuild identity twice, hash should match)
const kA = buildCacheIdentity({ sourceHash: r1.integrity.sourceHash }).cacheKey;
const kB = buildCacheIdentity({ sourceHash: r1.integrity.sourceHash }).cacheKey;
check("cacheKey_deterministic", kA === kB, `both=${kA}`);

// ---- test 9: full record identity carries all dep versions ----
const deps = r1.integrity.cacheIdentity.dependencies;
const missingDeps = ["linearize","cat02","retinal12","lgn","v1","v2","v4","it80",
  "spatial_color","radial_photon","persistent_homology","dichromatic","texture","hu_moments"
].filter(k => !deps[k]);
check("all_dep_versions_present", missingDeps.length === 0,
      missingDeps.length ? `missing: ${missingDeps.join(",")}` : `${Object.keys(deps).length} deps`);

console.log(`\ngate 7: ${fails.length === 0 ? "SATISFIED ✓ (" + passes.length + "/" + passes.length + " tests)" : "FAILED " + fails.length + " tests: " + fails.join(", ")}`);
process.exit(fails.length === 0 ? 0 : 1);
