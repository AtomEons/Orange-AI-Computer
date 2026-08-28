// cartridges/smoke-test.mjs
//
// AtomSmasher Cartridges — END-TO-END smoke test.
//
// Exercises the LIVE round-trip:
//   createLoader -> init -> list -> describe
//     -> load (new)        -> list contains it
//     -> swap (version++)  -> list reflects swap, prev_version reported
//     -> unload            -> list no longer contains it
//     -> persist           -> rewrite registry.json atomically
//     -> reload from disk  -> state survives
//
// Plus negative cases that the LIVE label requires:
//   - malformed schema string rejected
//   - bad name pattern rejected
//   - duplicate tool name within a cartridge rejected
//   - load() on existing name rejected (must use swap)
//   - swap() on missing name rejected (must use load)
//   - swap() with mismatched expected_version rejected
//   - swap() with same version rejected
//   - persist + re-init round-trip is byte-deterministic on the cartridge_id
//
// Each cartridge_id is content-addressed (sha256). The smoke asserts ids are
// stable across processes by recomputing them after a fresh load from disk.
//
// Run with: node 12-ATOMSMASHER/cartridges/smoke-test.mjs
// Exits non-zero on any failure. No test framework dep.

import { promises as fsp } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createLoader,
  validateCartridge,
  computeCartridgeId,
  CARTRIDGE_SCHEMA_ID,
  REGISTRY_SCHEMA_ID,
} from "./loader.mjs";

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function mkWorkspace() {
  const root = path.join(os.tmpdir(), `cartridges-smoke-${Date.now()}-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, registryPath: path.join(root, "registry.json") };
}

async function cleanup(ws) {
  try {
    await fsp.rm(ws.root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Test cartridge bodies — match Mom's Law: real content, no theater words
// ---------------------------------------------------------------------------

function mkCartridge(overrides = {}) {
  return {
    schema: CARTRIDGE_SCHEMA_ID,
    name: "smoke-test-domain",
    version: "0.1.0",
    summary: "Synthetic cartridge used only by the smoke test.",
    capabilities: ["test.echo", "test.assert"],
    system_prompt: "You are a smoke-test agent. Echo input deterministically.",
    tool_cards: [
      {
        name: "echo",
        description: "Return the input string unchanged.",
        input_schema: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" } },
        },
      },
    ],
    tags: ["test"],
    ...overrides,
  };
}

function seedRegistry(registryPath, cartridges) {
  const payload = {
    schema: REGISTRY_SCHEMA_ID,
    version: 1,
    generated_at: new Date().toISOString(),
    cartridges,
  };
  fs.writeFileSync(registryPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const ws = mkWorkspace();
  console.log(`workspace: ${ws.root}`);

  // -------------------------------------------------------------------------
  // 0. Validator unit-level checks (no I/O)
  // -------------------------------------------------------------------------
  console.log("0. validateCartridge unit checks");
  check("valid cartridge validates", validateCartridge(mkCartridge()).valid);

  const badSchema = validateCartridge(mkCartridge({ schema: "wrong" }));
  check("wrong schema rejected", !badSchema.valid);

  const badName = validateCartridge(mkCartridge({ name: "Bad_Name" }));
  check("bad name pattern rejected", !badName.valid);

  const badVersion = validateCartridge(mkCartridge({ version: "1" }));
  check("bad semver rejected", !badVersion.valid);

  const emptyCaps = validateCartridge(mkCartridge({ capabilities: [] }));
  check("empty capabilities rejected", !emptyCaps.valid);

  const badCap = validateCartridge(mkCartridge({ capabilities: ["Bad Cap"] }));
  check("bad capability pattern rejected", !badCap.valid);

  const emptyPrompt = validateCartridge(mkCartridge({ system_prompt: "" }));
  check("empty system_prompt rejected", !emptyPrompt.valid);

  const dupeTool = validateCartridge(
    mkCartridge({
      tool_cards: [
        { name: "dup", description: "first", input_schema: { type: "object" } },
        { name: "dup", description: "second", input_schema: { type: "object" } },
      ],
    }),
  );
  check("duplicate tool name within cartridge rejected", !dupeTool.valid);

  const badToolSchema = validateCartridge(
    mkCartridge({
      tool_cards: [{ name: "x", description: "ok", input_schema: "not-an-object" }],
    }),
  );
  check("non-object input_schema rejected", !badToolSchema.valid);

  // -------------------------------------------------------------------------
  // 1. Init from seeded registry
  // -------------------------------------------------------------------------
  console.log("1. init from seeded registry");
  const seedA = mkCartridge({ name: "alpha", version: "0.1.0" });
  const seedB = mkCartridge({
    name: "bravo",
    version: "0.2.0",
    capabilities: ["test.parse"],
    tool_cards: [
      {
        name: "parse",
        description: "Parse input.",
        input_schema: { type: "object" },
      },
    ],
  });
  seedRegistry(ws.registryPath, [seedA, seedB]);

  const loader = createLoader({ registryPath: ws.registryPath });
  const initRes = await loader.init();
  check("init ok", initRes.ok === true && initRes.loaded === 2, JSON.stringify(initRes));
  check("loader isReady", loader.isReady() === true);

  // -------------------------------------------------------------------------
  // 2. list + describe
  // -------------------------------------------------------------------------
  console.log("2. list + describe");
  const listed = loader.list();
  check("list returns 2 entries", listed.length === 2);
  const names = new Set(listed.map((x) => x.name));
  check("alpha in list", names.has("alpha"));
  check("bravo in list", names.has("bravo"));
  const alphaSummary = listed.find((x) => x.name === "alpha");
  check("alpha has cartridge_id", typeof alphaSummary?.cartridge_id === "string");
  check(
    "alpha cartridge_id is 64-char hex",
    /^[a-f0-9]{64}$/.test(alphaSummary?.cartridge_id || ""),
  );
  check("alpha tool_count = 1", alphaSummary?.tool_count === 1);

  const alphaFull = loader.describe("alpha");
  check("describe returns full cartridge", alphaFull?.name === "alpha");
  check("describe includes system_prompt", typeof alphaFull?.system_prompt === "string");
  check("describe tool_cards present", Array.isArray(alphaFull?.tool_cards) && alphaFull.tool_cards.length === 1);
  check("describe of unknown returns null", loader.describe("nope") === null);

  // -------------------------------------------------------------------------
  // 3. Content-addressed id determinism
  // -------------------------------------------------------------------------
  console.log("3. cartridge_id determinism");
  const idDirect = computeCartridgeId(seedA);
  check(
    "computeCartridgeId matches loader id for alpha",
    idDirect === alphaSummary?.cartridge_id,
  );
  const seedAReordered = {
    // Same content, different key insertion order — id must be identical.
    tool_cards: seedA.tool_cards,
    name: seedA.name,
    version: seedA.version,
    capabilities: seedA.capabilities,
    summary: seedA.summary,
    schema: seedA.schema,
    system_prompt: seedA.system_prompt,
  };
  check(
    "key-order independence: same content -> same id",
    computeCartridgeId(seedAReordered) === idDirect,
  );

  // -------------------------------------------------------------------------
  // 4. load() a new cartridge
  // -------------------------------------------------------------------------
  console.log("4. load() new cartridge");
  const seedC = mkCartridge({ name: "charlie", version: "0.1.0" });

  // Capture emitted events.
  const events = [];
  loader.on("event", (e) => events.push(e));

  const loadRes = loader.load(seedC);
  check("load charlie ok", loadRes.ok === true);
  check("load returns cartridge_id", /^[a-f0-9]{64}$/.test(loadRes.cartridge_id || ""));
  check("loader now has 3 entries", loader.list().length === 3);
  check("loaded event emitted", events.some((e) => e.kind === "loaded" && e.name === "charlie"));

  const dupLoad = loader.load(seedC);
  check("re-loading same name fails", !dupLoad.ok);
  check(
    "duplicate load error mentions swap",
    Array.isArray(dupLoad.errors) && /swap/.test(dupLoad.errors.join(" ")),
  );

  // -------------------------------------------------------------------------
  // 5. swap() — happy path + negatives
  // -------------------------------------------------------------------------
  console.log("5. swap() compare-and-set");
  const charlieV2 = mkCartridge({
    name: "charlie",
    version: "0.2.0",
    capabilities: ["test.echo", "test.assert", "test.replay"],
  });

  const swapBadExpected = loader.swap(charlieV2, { expected_version: "9.9.9" });
  check("swap with wrong expected_version fails", !swapBadExpected.ok);

  const swapSameVersion = loader.swap(mkCartridge({ name: "charlie", version: "0.1.0", summary: "different summary same version" }));
  check("swap that doesn't bump version fails", !swapSameVersion.ok);

  const swapOk = loader.swap(charlieV2, { expected_version: "0.1.0" });
  check("swap charlie 0.1.0 -> 0.2.0 ok", swapOk.ok === true);
  check("swap reports prev_version", swapOk.prev_version === "0.1.0");
  const charlieNow = loader.describe("charlie");
  check("charlie version is 0.2.0", charlieNow?.version === "0.2.0");
  check(
    "swapped event emitted",
    events.some((e) => e.kind === "swapped" && e.name === "charlie" && e.prev_version === "0.1.0"),
  );

  const swapMissing = loader.swap(mkCartridge({ name: "missing", version: "0.2.0" }));
  check("swap on missing cartridge fails", !swapMissing.ok);

  // -------------------------------------------------------------------------
  // 6. unload()
  // -------------------------------------------------------------------------
  console.log("6. unload()");
  const unloadOk = loader.unload("bravo");
  check("unload bravo ok", unloadOk.ok === true);
  check("loader now has 2 entries", loader.list().length === 2);
  check("describe bravo now null", loader.describe("bravo") === null);
  check("unloaded event emitted", events.some((e) => e.kind === "unloaded" && e.name === "bravo"));

  const unloadMissing = loader.unload("bravo");
  check("unload of already-removed fails", !unloadMissing.ok);

  // -------------------------------------------------------------------------
  // 7. persist() + re-load round-trip
  // -------------------------------------------------------------------------
  console.log("7. persist + re-load round-trip");
  const persistRes = await loader.persist();
  check("persist ok", persistRes.ok === true);
  check("persist count = 2 (alpha + charlie)", persistRes.count === 2);
  check("persisted event emitted", events.some((e) => e.kind === "persisted"));
  check("registry.json exists", fs.existsSync(ws.registryPath));

  // Read the file back manually and assert the cartridge_id is NOT stored on
  // disk (it's derived; persisting it would create two sources of truth).
  const onDisk = JSON.parse(fs.readFileSync(ws.registryPath, "utf8"));
  check("on-disk schema set", onDisk.schema === REGISTRY_SCHEMA_ID);
  check("on-disk cartridges length 2", onDisk.cartridges.length === 2);
  const diskAlpha = onDisk.cartridges.find((c) => c.name === "alpha");
  check("on-disk alpha has no cartridge_id field", !("cartridge_id" in (diskAlpha || {})));

  // Spin a fresh loader pointing at the same file.
  const loader2 = createLoader({ registryPath: ws.registryPath });
  const init2 = await loader2.init();
  check("fresh loader init ok", init2.ok === true && init2.loaded === 2);
  const charlie2 = loader2.describe("charlie");
  check("charlie survived persist+reload", charlie2?.version === "0.2.0");
  check(
    "cartridge_id stable across process boundary",
    charlie2?.cartridge_id === loader.describe("charlie")?.cartridge_id,
  );

  // -------------------------------------------------------------------------
  // 8. Malformed registry handling
  // -------------------------------------------------------------------------
  console.log("8. malformed registry refused without partial-load");
  const ws2 = mkWorkspace();
  // One good, one malformed.
  const malformedRegistry = {
    schema: REGISTRY_SCHEMA_ID,
    version: 1,
    cartridges: [
      mkCartridge({ name: "good", version: "0.1.0" }),
      mkCartridge({ name: "Bad Name", version: "0.1.0" }),
    ],
  };
  fs.writeFileSync(ws2.registryPath, JSON.stringify(malformedRegistry), "utf8");
  const loaderBad = createLoader({ registryPath: ws2.registryPath });
  const initBad = await loaderBad.init();
  check("init refuses to half-load malformed registry", initBad.ok === false);
  check("init surfaces structured errors", Array.isArray(initBad.errors) && initBad.errors.length > 0);
  check("loader stayed empty after refused init", loaderBad.list().length === 0);
  await cleanup(ws2);

  // -------------------------------------------------------------------------
  // 9. Missing registry file is OK — empty start
  // -------------------------------------------------------------------------
  console.log("9. missing registry file -> empty loader, not crash");
  const ws3 = mkWorkspace();
  await fsp.rm(ws3.registryPath, { force: true });
  const loaderEmpty = createLoader({ registryPath: ws3.registryPath });
  const initEmpty = await loaderEmpty.init();
  check("init ok with no file", initEmpty.ok === true && initEmpty.loaded === 0);
  check("init reports registry_missing", initEmpty.registry_missing === true);
  const persistEmpty = await loaderEmpty.persist();
  check("persist creates the file fresh", persistEmpty.ok === true && fs.existsSync(ws3.registryPath));
  await cleanup(ws3);

  // -------------------------------------------------------------------------
  // 10. Real seed registry loads cleanly (the one we ship with)
  // -------------------------------------------------------------------------
  console.log("10. shipped registry.json loads cleanly");
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const shippedPath = path.resolve(here, "registry.json");
  if (fs.existsSync(shippedPath)) {
    const shippedLoader = createLoader({ registryPath: shippedPath });
    const shippedInit = await shippedLoader.init();
    check("shipped registry init ok", shippedInit.ok === true, JSON.stringify(shippedInit.errors));
    const shippedList = shippedLoader.list();
    check("shipped registry has the 3 seeded cartridges", shippedList.length >= 3);
    const shippedNames = new Set(shippedList.map((x) => x.name));
    check("orange5-doctrine present", shippedNames.has("orange5-doctrine"));
    check("ae-cobra-memory present", shippedNames.has("ae-cobra-memory"));
    check("orangeeye-visual present", shippedNames.has("orangeeye-visual"));
  } else {
    check("shipped registry.json present (skipped — file missing)", false, shippedPath);
  }

  await cleanup(ws);
}

main()
  .catch((err) => {
    console.error(`smoke test crashed: ${err.stack || err.message}`);
    failed++;
  })
  .finally(() => {
    console.log("");
    if (failed === 0) {
      console.log("PASS — AtomSmasher cartridges end-to-end smoke green");
      process.exit(0);
    } else {
      console.log(`FAIL — ${failed} check(s) failed`);
      process.exit(1);
    }
  });
