// expansion-warrants/smoke-test.mjs
//
// AtomSmasher Expansion Warrants — END-TO-END smoke test.
//
// Exercises the encoder + index round-trip:
//   encodeWarrant
//     -> validateWarrant
//       -> index.register
//         -> index.consume (×N to exhaustion)
//           -> isExpired / isExhausted predicates
//
// Doctrine asserted:
//   - id is content-derived: equal {scope_from, scope_to, signature,
//     expires_at, max_uses, nonce} -> equal id. Random-nonce mints do NOT
//     collide (each fresh mint gets a fresh random nonce).
//   - validateWarrant rejects tampering: change any id-payload field after
//     mint and the integrity check fires.
//   - Anti-fluff rejects forbidden words in scope strings.
//   - max_uses=0, negative, or exceeding ceiling are rejected at mint.
//   - scope_to === scope_from is rejected at mint.
//   - operator_signature empty/missing is rejected at mint.
//   - expires_at in the past at mint is rejected.
//   - consume() decrements remaining exactly once per call; final call
//     returns ok=true with remaining=0; subsequent call returns
//     warrant_exhausted.
//   - Expired warrant cannot be consumed (clock advanced past expires_at).
//   - register() is idempotent on the same id and never resets used_count.
//
// This file requires no test framework and writes nothing to disk. Exits
// non-zero on any failure.
// Run with: node 12-ATOMSMASHER/expansion-warrants/smoke-test.mjs

import {
  encodeWarrant,
  validateWarrant,
  createWarrantIndex,
  isExpired,
  isExhausted,
  WARRANT_SCHEMA_ID,
} from "./warrants.mjs";

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function expectThrow(fn, matcher, label) {
  try {
    fn();
    check(label, false, "no throw");
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (typeof matcher === "string") {
      check(label, msg.includes(matcher), `actual: ${msg}`);
    } else if (matcher instanceof RegExp) {
      check(label, matcher.test(msg), `actual: ${msg}`);
    } else {
      check(label, true);
    }
  }
}

// Future-dated expiry so warrants are valid through the test run.
const FUTURE_ISO = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
const PAST_ISO = new Date(Date.now() - 60 * 1000).toISOString(); // -1m

// ---------------------------------------------------------------------------
// 1. encodeWarrant happy path
// ---------------------------------------------------------------------------

console.log("1. encodeWarrant happy path");

const w1 = encodeWarrant({
  scope_from: "orange5:read",
  scope_to: "orange5:read+write",
  operator_signature: "ed25519:atom:0xABCDEF",
  expires_at: FUTURE_ISO,
  max_uses: 3,
  nonce: "smoke-nonce-1",
});

check("w1 schema field set", w1.schema === WARRANT_SCHEMA_ID);
check("w1.id is 64-char hex", /^[a-f0-9]{64}$/.test(w1.id));
check("w1.used_count starts at 0", w1.used_count === 0);
check("w1.max_uses preserved", w1.max_uses === 3);
check("w1.nonce preserved", w1.nonce === "smoke-nonce-1");
check("w1.created_at is ISO", typeof w1.created_at === "string" && !Number.isNaN(Date.parse(w1.created_at)));

const v1 = validateWarrant(w1);
check("w1 validates", v1.valid, JSON.stringify(v1.errors));

// ---------------------------------------------------------------------------
// 2. Content determinism — equal authorization (with explicit nonce) -> equal id
// ---------------------------------------------------------------------------

console.log("2. content determinism");

const w1Twin = encodeWarrant({
  scope_from: "orange5:read",
  scope_to: "orange5:read+write",
  operator_signature: "ed25519:atom:0xABCDEF",
  expires_at: FUTURE_ISO,
  max_uses: 3,
  nonce: "smoke-nonce-1",
});
check("equal authorization + same nonce -> equal id", w1Twin.id === w1.id);
check("twin used_count is fresh 0", w1Twin.used_count === 0);

// Different nonce => different id even with identical authorization
const w1DiffNonce = encodeWarrant({
  scope_from: "orange5:read",
  scope_to: "orange5:read+write",
  operator_signature: "ed25519:atom:0xABCDEF",
  expires_at: FUTURE_ISO,
  max_uses: 3,
  nonce: "smoke-nonce-2",
});
check("different nonce -> different id", w1DiffNonce.id !== w1.id);

// Random-nonce default — two mints without an explicit nonce should NOT collide
const wA = encodeWarrant({
  scope_from: "a",
  scope_to: "a+b",
  operator_signature: "sig",
  expires_at: FUTURE_ISO,
  max_uses: 1,
});
const wB = encodeWarrant({
  scope_from: "a",
  scope_to: "a+b",
  operator_signature: "sig",
  expires_at: FUTURE_ISO,
  max_uses: 1,
});
check("random-nonce mints do not collide", wA.id !== wB.id);
check("random-nonce is 32 hex chars", /^[a-f0-9]{32}$/.test(wA.nonce));

// ---------------------------------------------------------------------------
// 3. validateWarrant — tampering detection
// ---------------------------------------------------------------------------

console.log("3. validateWarrant tampering detection");

// Tamper with scope_to AFTER mint; id no longer matches recomputation
const tampered = JSON.parse(JSON.stringify(w1));
tampered.scope_to = "orange5:root";
const tv = validateWarrant(tampered);
check("scope_to tamper detected", !tv.valid && tv.errors.some((e) => e.includes("id integrity")));

// Tamper with max_uses
const tampered2 = JSON.parse(JSON.stringify(w1));
tampered2.max_uses = 999;
const tv2 = validateWarrant(tampered2);
check("max_uses tamper detected", !tv2.valid && tv2.errors.some((e) => e.includes("id integrity")));

// used_count is NOT in the id payload, so bumping it (within bounds) should
// validate structurally and pass id integrity. This is the documented
// contract: consumption is index state, not identity.
const consumed = JSON.parse(JSON.stringify(w1));
consumed.used_count = 1;
const cv = validateWarrant(consumed);
check("used_count change does NOT break id integrity", cv.valid, JSON.stringify(cv.errors));

// used_count > max_uses is index corruption — caught structurally
const corrupted = JSON.parse(JSON.stringify(w1));
corrupted.used_count = w1.max_uses + 1;
const corv = validateWarrant(corrupted);
check("used_count > max_uses caught", !corv.valid && corv.errors.some((e) => e.includes("used_count cannot exceed max_uses")));

// Unknown field
const extraField = JSON.parse(JSON.stringify(w1));
extraField.extra = "nope";
const efv = validateWarrant(extraField);
check("unknown field rejected", !efv.valid && efv.errors.some((e) => e.includes("unknown field: extra")));

// ---------------------------------------------------------------------------
// 4. Encoder hard rejects
// ---------------------------------------------------------------------------

console.log("4. encoder hard rejects");

expectThrow(
  () => encodeWarrant({ scope_from: "", scope_to: "x", operator_signature: "s", expires_at: FUTURE_ISO, max_uses: 1 }),
  /scope_from must be a non-empty string/,
  "empty scope_from rejected",
);
expectThrow(
  () => encodeWarrant({ scope_from: "x", scope_to: "x", operator_signature: "s", expires_at: FUTURE_ISO, max_uses: 1 }),
  /scope_to must differ/,
  "scope_to === scope_from rejected",
);
expectThrow(
  () => encodeWarrant({ scope_from: "a", scope_to: "b", operator_signature: "", expires_at: FUTURE_ISO, max_uses: 1 }),
  /operator_signature must be a non-empty string/,
  "empty operator_signature rejected",
);
expectThrow(
  () => encodeWarrant({ scope_from: "a", scope_to: "b", operator_signature: "s", expires_at: "not-a-date", max_uses: 1 }),
  /expires_at not parseable/,
  "unparseable expires_at rejected",
);
expectThrow(
  () => encodeWarrant({ scope_from: "a", scope_to: "b", operator_signature: "s", expires_at: PAST_ISO, max_uses: 1 }),
  /must be in the future/,
  "past expires_at rejected",
);
expectThrow(
  () => encodeWarrant({ scope_from: "a", scope_to: "b", operator_signature: "s", expires_at: FUTURE_ISO, max_uses: 0 }),
  /max_uses must be a positive integer/,
  "max_uses=0 rejected",
);
expectThrow(
  () => encodeWarrant({ scope_from: "a", scope_to: "b", operator_signature: "s", expires_at: FUTURE_ISO, max_uses: -1 }),
  /max_uses must be a positive integer/,
  "negative max_uses rejected",
);
expectThrow(
  () => encodeWarrant({ scope_from: "a", scope_to: "b", operator_signature: "s", expires_at: FUTURE_ISO, max_uses: 1.5 }),
  /max_uses must be a positive integer/,
  "non-integer max_uses rejected",
);
expectThrow(
  () => encodeWarrant({ scope_from: "a", scope_to: "b", operator_signature: "s", expires_at: FUTURE_ISO, max_uses: 1001 }),
  /exceeds hard ceiling/,
  "max_uses above ceiling rejected",
);

// Anti-fluff: forbidden word in scope_to
expectThrow(
  () => encodeWarrant({ scope_from: "a", scope_to: "probably-admin", operator_signature: "s", expires_at: FUTURE_ISO, max_uses: 1 }),
  /anti-fluff reject/,
  "anti-fluff 'probably' rejected",
);
expectThrow(
  () => encodeWarrant({ scope_from: "looks_ok-mode", scope_to: "b", operator_signature: "s", expires_at: FUTURE_ISO, max_uses: 1 }),
  /anti-fluff reject/,
  "anti-fluff 'looks_ok' rejected",
);

// nonce shape: empty string rejected (but undefined is fine -> random)
expectThrow(
  () => encodeWarrant({ scope_from: "a", scope_to: "b", operator_signature: "s", expires_at: FUTURE_ISO, max_uses: 1, nonce: "" }),
  /nonce must be a non-empty string/,
  "empty nonce string rejected",
);

// ---------------------------------------------------------------------------
// 5. Index round-trip
// ---------------------------------------------------------------------------

console.log("5. index round-trip");

const idx = createWarrantIndex();

const registered = idx.register(w1);
check("register returns clone with same id", registered.id === w1.id);
check("register sets used_count to 0", registered.used_count === 0);
check("has(id) true after register", idx.has(w1.id));
check("get(id) returns warrant after register", idx.get(w1.id)?.id === w1.id);
check("get(missing) returns null", idx.get("0".repeat(64)) === null);
check("has(missing) false", !idx.has("0".repeat(64)));

// Idempotent re-register: should not throw, should not reset used_count if it
// were already incremented.
const r2 = idx.consume(w1.id);
check("consume #1 ok", r2.ok && r2.used_count === 1 && r2.remaining === 2);

const reRegistered = idx.register(w1);
check("re-register preserves used_count", reRegistered.used_count === 1);

// Caller cannot mutate index by holding the object they passed in: encoder
// returned w1 with used_count=0, mutating that should not leak into index.
const externalCopy = idx.get(w1.id);
externalCopy.used_count = 999;
const reread = idx.get(w1.id);
check("index returns defensive clones (external mutation isolated)", reread.used_count === 1);

// ---------------------------------------------------------------------------
// 6. Consume to exhaustion
// ---------------------------------------------------------------------------

console.log("6. consume to exhaustion");

const r3 = idx.consume(w1.id);
check("consume #2 ok", r3.ok && r3.used_count === 2 && r3.remaining === 1);

const r4 = idx.consume(w1.id);
check("consume #3 ok and exhausts", r4.ok && r4.used_count === 3 && r4.remaining === 0);

const r5 = idx.consume(w1.id);
check("consume #4 returns warrant_exhausted", r5.ok === false && r5.reason === "warrant_exhausted");
check("exhausted result includes remaining=0", r5.remaining === 0);

// Missing id
const rMiss = idx.consume("a".repeat(64));
check("consume missing id returns warrant_not_found", rMiss.ok === false && rMiss.reason === "warrant_not_found");

// Bad input
const rBad = idx.consume("");
check("consume empty id returns id_required", rBad.ok === false && rBad.reason === "id_required");

// ---------------------------------------------------------------------------
// 7. Expiry
// ---------------------------------------------------------------------------

console.log("7. expiry semantics");

// Encode a warrant that expires soon, then probe with future nowMs
const wShort = encodeWarrant({
  scope_from: "a",
  scope_to: "a+b",
  operator_signature: "s",
  expires_at: new Date(Date.now() + 10 * 1000).toISOString(), // +10s
  max_uses: 5,
  nonce: "short",
});
const idx2 = createWarrantIndex();
idx2.register(wShort);

check("isExpired(now) false", !isExpired(wShort, Date.now()));
check("isExpired(future) true", isExpired(wShort, Date.now() + 60 * 1000));

const rNow = idx2.consume(wShort.id);
check("consume before expiry ok", rNow.ok === true);

const rFuture = idx2.consume(wShort.id, { nowMs: Date.now() + 60 * 1000 });
check("consume after expiry returns warrant_expired", rFuture.ok === false && rFuture.reason === "warrant_expired");
check("expired consume does NOT increment used_count", idx2.get(wShort.id).used_count === 1);

// Cannot register an already-expired warrant
const wDead = encodeWarrant({
  scope_from: "a",
  scope_to: "a+b",
  operator_signature: "s",
  expires_at: new Date(Date.now() + 50).toISOString(), // 50ms in the future
  max_uses: 1,
  nonce: "dead",
});
// busy-wait past expiry
const deadline = Date.parse(wDead.expires_at) + 5;
while (Date.now() < deadline) { /* spin briefly */ }
expectThrow(
  () => idx2.register(wDead),
  /already expired at register-time/,
  "register rejects already-expired warrant",
);

// ---------------------------------------------------------------------------
// 8. isExhausted predicate
// ---------------------------------------------------------------------------

console.log("8. isExhausted predicate");

check("fresh warrant not exhausted", !isExhausted({ used_count: 0, max_uses: 1 }));
check("partially used not exhausted", !isExhausted({ used_count: 2, max_uses: 3 }));
check("equal exhausted", isExhausted({ used_count: 3, max_uses: 3 }));
check("over exhausted", isExhausted({ used_count: 4, max_uses: 3 }));
check("null is exhausted", isExhausted(null));
check("missing max_uses is exhausted", isExhausted({ used_count: 0 }));

// ---------------------------------------------------------------------------
// 9. list filtering
// ---------------------------------------------------------------------------

console.log("9. list filtering");

const idx3 = createWarrantIndex();
const wRead = encodeWarrant({
  scope_from: "base",
  scope_to: "base+read",
  operator_signature: "s",
  expires_at: FUTURE_ISO,
  max_uses: 1,
  nonce: "r",
});
const wWrite = encodeWarrant({
  scope_from: "base",
  scope_to: "base+write",
  operator_signature: "s",
  expires_at: FUTURE_ISO,
  max_uses: 1,
  nonce: "w",
});
const wOther = encodeWarrant({
  scope_from: "other",
  scope_to: "other+admin",
  operator_signature: "s",
  expires_at: FUTURE_ISO,
  max_uses: 1,
  nonce: "o",
});
idx3.register(wRead);
idx3.register(wWrite);
idx3.register(wOther);

const all = idx3.list();
check("list() returns all 3", all.length === 3);

const fromBase = idx3.list({ scope_from: "base" });
check("filter scope_from=base returns 2", fromBase.length === 2);
check(
  "filter scope_from=base excludes other",
  !fromBase.some((w) => w.id === wOther.id),
);

const toWrite = idx3.list({ scope_to: "base+write" });
check("filter scope_to=base+write returns 1", toWrite.length === 1 && toWrite[0].id === wWrite.id);

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.log("");
if (failed === 0) {
  console.log("PASS — AtomSmasher expansion-warrants end-to-end smoke green");
  process.exit(0);
} else {
  console.log(`FAIL — ${failed} check(s) failed`);
  process.exit(1);
}
