#!/usr/bin/env bun
/**
 * test-migrate-v1-v2.mjs — proves the migrator is pure, never drops fields,
 * produces valid v2, and is exactly reversible (round-trip identity), across
 * hand fixtures + seeded fuzz. Standalone harness.
 *
 *   Summary: N pass / M fail of T
 */

import {
  upgradeV1ToV2,
  downgradeV2ToV1,
  isReversible,
} from "../migrate-v1-v2.mjs";
import {
  validateOrderEnvelope,
  ORDER_V1_ID,
  ORDER_V2_ID,
  V2_FIELD_NAMES,
} from "../envelope-validate.mjs";
import { FIXTURES } from "../fixtures.mjs";

let pass = 0, fail = 0, total = 0;
const check = (name, cond) => { total++; cond ? pass++ : (fail++, console.log(`  FAIL ${name}`)); };

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

// --- 1. Every valid v1 fixture upgrades to a VALID v2 order.
for (const f of FIXTURES.order_v1.valid) {
  // Skip the fixture that already carries a v2-shaped extra field only if it
  // also collides with x_migration — none do; but the "carries-extra" fixture
  // carries `seed`, which is fine (migrator preserves it, doesn't add it).
  let up;
  let threw = false;
  try { up = upgradeV1ToV2(f.doc); } catch (e) { threw = true; console.log(`    (upgrade threw for ${f.name}: ${e.message})`); }
  check(`upgrade ${f.name} does not throw`, !threw);
  if (threw) continue;
  check(`upgrade ${f.name} => schema v2`, up.schema === ORDER_V2_ID);
  check(`upgrade ${f.name} => valid v2`, validateOrderEnvelope(up).ok === true);
}

// --- 2. NEVER drops a field: every key on the v1 doc is present on the v2 doc,
//        and every field EXCEPT the `schema` discriminator is byte-verbatim.
//        (`schema` is intentionally bumped v1 -> v2; that is the whole point.)
for (const f of FIXTURES.order_v1.valid) {
  let up;
  try { up = upgradeV1ToV2(f.doc); } catch { continue; }
  const present = Object.keys(f.doc).every((k) => Object.hasOwn(up, k));
  const verbatim = Object.keys(f.doc)
    .filter((k) => k !== "schema")
    .every((k) => deepEqual(up[k], f.doc[k]));
  check(`upgrade ${f.name} keeps every v1 key`, present);
  check(`upgrade ${f.name} preserves non-schema fields verbatim`, verbatim);
  check(`upgrade ${f.name} bumps schema v1->v2`, f.doc.schema === ORDER_V1_ID && up.schema === ORDER_V2_ID);
}

// --- 3. Adds defaults ONLY for absent additions; records them in x_migration.added.
{
  const base = FIXTURES.order_v1.valid[0].doc; // golden, no v2 fields
  const up = upgradeV1ToV2(base);
  check("golden upgrade adds all 4 additions", up.x_migration.added.length === 4);
  check("golden upgrade defaults seed=null", up.seed === null);
  check("golden upgrade defaults dry_run=false", up.dry_run === false);
  check("golden upgrade defaults budget=null", up.budget === null);
  check("golden upgrade defaults egress=[]", Array.isArray(up.egress_declared) && up.egress_declared.length === 0);
  check("x_migration.from=v1", up.x_migration.from === ORDER_V1_ID);
  check("x_migration.to=v2", up.x_migration.to === ORDER_V2_ID);

  // the fixture that already carries seed:7 must NOT re-add seed
  const withSeed = FIXTURES.order_v1.valid.find((x) => x.name === "carries-extra-field-allowed").doc;
  const up2 = upgradeV1ToV2(withSeed);
  check("pre-existing seed preserved (not overwritten)", up2.seed === 7);
  check("pre-existing seed NOT listed in added", !up2.x_migration.added.includes("seed"));
  check("absent additions still listed in added", up2.x_migration.added.includes("budget"));
}

// --- 4. REVERSIBILITY: downgrade(upgrade(x)) deep-equals x, every valid v1 fixture.
for (const f of FIXTURES.order_v1.valid) {
  let ok = false;
  try { ok = isReversible(f.doc); } catch (e) { console.log(`    (reversibility threw for ${f.name}: ${e.message})`); }
  check(`round-trip identity: ${f.name}`, ok);
}

// --- 5. Purity: upgrade does not mutate its argument.
{
  const original = FIXTURES.order_v1.valid[0].doc;
  const snapshot = structuredClone(original);
  upgradeV1ToV2(original);
  check("upgrade does not mutate input", deepEqual(original, snapshot));
}

// --- 6. Guardrails: refuses non-v1 input and already-migrated input.
{
  let threw = false;
  try { upgradeV1ToV2({ schema: ORDER_V2_ID }); } catch { threw = true; }
  check("refuses non-v1 schema", threw);

  threw = false;
  const alreadyV2 = upgradeV1ToV2(FIXTURES.order_v1.valid[0].doc);
  // upgrading a v2 (has schema v2) must throw
  try { upgradeV1ToV2(alreadyV2); } catch { threw = true; }
  check("refuses to upgrade a v2 doc", threw);

  threw = false;
  try { downgradeV2ToV1({ schema: ORDER_V2_ID }); } catch { threw = true; }
  check("downgrade refuses missing x_migration", threw);
}

// --- 7. Seeded fuzz: build random-but-valid v1 orders, assert round-trip identity.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0xC0FFEE);
const RISK = ["read_only", "low", "medium", "high", "destructive", "production"];
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
let fuzzOk = 0, fuzzN = 200;
for (let i = 0; i < fuzzN; i++) {
  const order = {
    schema: ORDER_V1_ID,
    orderId: "ord-" + Math.floor(rnd() * 1e9).toString(36).padStart(3, "0"),
    action: "fuzz.action." + (i % 7),
    intent: "intent-" + i,
    scope: "scope/" + i,
    allowedActions: Array.from({ length: Math.floor(rnd() * 4) }, (_, j) => "act" + j),
    forbiddenActions: Array.from({ length: Math.floor(rnd() * 3) }, (_, j) => "forbid" + j),
    targetProject: pick(["orange5", "atomsmasher", "hermes"]),
    riskLevel: pick(RISK),
    requiresReceipt: rnd() > 0.5,
  };
  if (rnd() > 0.5) order.operatorApproved = rnd() > 0.5;
  if (rnd() > 0.5) order.createdAt = "2026-07-04T00:00:0" + (i % 10) + "Z";
  // sometimes carry a pre-existing v2-shaped field (legal under v1 open schema)
  if (rnd() > 0.7) order.dry_run = rnd() > 0.5;
  if (rnd() > 0.8) order.extra_meta = { note: "x" + i };
  // precondition: must be a valid v1 order
  if (!validateOrderEnvelope(order).ok) continue;
  try { if (isReversible(order)) fuzzOk++; } catch { /* counts as fail below */ }
}
check(`seeded fuzz: all ${fuzzN} round-trip identical`, fuzzOk === fuzzN);

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail > 0 ? 1 : 0);
