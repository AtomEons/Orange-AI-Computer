#!/usr/bin/env bun
// Orange5 — Control-Plane Observability + Receipt-Chain Integrity tests.
// Path: 04-CONTROL-PLANE/tests/control-plane-observability.test.mjs
// Run:  bun 04-CONTROL-PLANE/tests/control-plane-observability.test.mjs
//
// Standalone Bun harness. No external test runner. Prints a final
//   Summary: N pass / M fail of T
// line and exits non-zero on any failure. Offline: builds synthetic chains in
// an in-memory #sqlite database, so no files are written and no live DB is
// touched. Mom's Law: the intact chain must pass AND the tampered chain must
// be caught — both are asserted, with named expectations.

import Database from "#sqlite";
import { createHash } from "node:crypto";
import { verifyChain, chainHash, GENESIS } from "../receipt-integrity.mjs";
import { snapshot, HEALTH_SCHEMA } from "../health.mjs";

let pass = 0,
  fail = 0;
function ok(cond, name, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`);
  }
}
function eq(a, b, name) {
  ok(a === b, name, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}

const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

// A NATIVE hash-chain log: seq + receipt_id + sha256 + prev_hash + entry_hash.
// This is the purpose-built tamper-evident table shape verifyChain checks in
// native mode. We build it with the SAME chainHash primitive the verifier uses,
// so a correctly-built chain is intact by construction.
function newNativeChainDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE receipts (
      seq        INTEGER PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      sha256     TEXT NOT NULL,
      prev_hash  TEXT NOT NULL,
      entry_hash TEXT NOT NULL
    );
  `);
  return db;
}

// Insert `n` well-formed, correctly-chained rows. Returns the entries so tests
// can reason about expected values. sha256[i] is a stand-in content hash.
function seedNativeChain(db, n) {
  const insert = db.prepare(
    `INSERT INTO receipts (seq, receipt_id, sha256, prev_hash, entry_hash)
     VALUES (@seq, @receipt_id, @sha256, @prev_hash, @entry_hash)`
  );
  const entries = [];
  let prev = GENESIS;
  for (let i = 0; i < n; i++) {
    const receipt_id = `2026-06-25-r${String(i).padStart(3, "0")}`;
    const sha256 = sha256hex(`content-of-${receipt_id}`);
    const entry_hash = chainHash(prev, { seq: i, receipt_id, sha256 });
    insert.run({ seq: i, receipt_id, sha256, prev_hash: prev, entry_hash });
    entries.push({ seq: i, receipt_id, sha256, prev_hash: prev, entry_hash });
    prev = entry_hash;
  }
  return entries;
}

// A DERIVED-mode table: the canonical receipts mirror shape (receipt_id +
// sha256, NO chain columns), matching the live 06 store's queryable columns.
function newMirrorDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE receipts (
      receipt_id    TEXT PRIMARY KEY NOT NULL,
      prior_receipt TEXT,
      hash_chain    TEXT,
      sha256        TEXT NOT NULL
    );
  `);
  return db;
}

// --------------------------------------------------------------------------
// 1. primitive
// --------------------------------------------------------------------------
console.log("\n[1] chainHash primitive");
{
  const a = chainHash(GENESIS, { seq: 0, receipt_id: "x", sha256: "ab" });
  const b = chainHash(GENESIS, { seq: 0, receipt_id: "x", sha256: "ab" });
  eq(a, b, "chainHash is deterministic (same inputs -> same hash)");
  ok(/^[0-9a-f]{64}$/.test(a), "chainHash returns 64-char hex");
  ok(chainHash(GENESIS, { seq: 0, receipt_id: "x", sha256: "ab" }) !==
     chainHash(GENESIS, { seq: 1, receipt_id: "x", sha256: "ab" }),
     "chainHash is sensitive to seq");
  ok(chainHash(GENESIS, { seq: 0, receipt_id: "x", sha256: "ab" }) !==
     chainHash(GENESIS, { seq: 0, receipt_id: "x", sha256: "ac" }),
     "chainHash is sensitive to content sha256");
  ok(/^[0-9a-f]{64}$/.test(GENESIS), "GENESIS is 64-char hex");
}

// --------------------------------------------------------------------------
// 2. NATIVE — intact chain PASSES
// --------------------------------------------------------------------------
console.log("\n[2] native mode — intact chain passes");
{
  const db = newNativeChainDb();
  const entries = seedNativeChain(db, 5);
  const rep = verifyChain({ db });

  eq(rep.mode, "native", "detected native mode (seq/prev_hash/entry_hash present)");
  eq(rep.ok, true, "intact chain: ok === true");
  eq(rep.total, 5, "intact chain: total === 5");
  eq(rep.broken_links.length, 0, "intact chain: zero broken links");
  eq(rep.tampered.length, 0, "intact chain: zero tampered entries");
  eq(rep.head_hash, entries[4].entry_hash, "head_hash === last entry_hash");
  eq(rep.genesis, GENESIS, "report carries GENESIS anchor");
  db.close();
}

// --------------------------------------------------------------------------
// 3. NATIVE — tampered content is CAUGHT
// --------------------------------------------------------------------------
console.log("\n[3] native mode — tampered chain is caught");
{
  // Case A: silent content edit. Rewrite the middle row's content hash but
  // leave its stored entry_hash (and every link field) untouched — the classic
  // "someone edited a persisted receipt after the fact" attack. The row's own
  // seal no longer matches its bytes, so it is caught as TAMPER at that row,
  // and the finding is localized there (no spurious downstream link breaks).
  const db = newNativeChainDb();
  seedNativeChain(db, 5);
  db.prepare("UPDATE receipts SET sha256 = ? WHERE seq = 2").run(sha256hex("EVIL-swapped-content"));

  const rep = verifyChain({ db });
  eq(rep.ok, false, "case A: ok === false");
  eq(rep.total, 5, "case A: total still 5");

  const tam = rep.tampered.find((t) => t.index === 2);
  ok(!!tam, "case A: tamper detected at the edited row (index 2)");
  eq(tam?.reason, "entry_hash_mismatch", "case A: tamper reason is entry_hash_mismatch");
  ok(tam?.expected_hash !== tam?.actual_hash, "case A: tamper record shows expected != actual hash");
  eq(rep.tampered.length, 1, "case A: exactly one tamper finding (localized to the edit)");
  eq(rep.broken_links.length, 0, "case A: no spurious downstream link breaks");
  db.close();

  // Case B: re-sealed content edit. Rewrite the middle row's content hash AND
  // re-seal its entry_hash over its (unchanged) stored prev, so the row is
  // internally self-consistent (tamper check on IT passes). The chain still
  // catches it: the NEXT row's stored prev_hash was the OLD entry_hash, which
  // no longer equals this row's NEW entry_hash -> BROKEN LINK downstream.
  const db2 = newNativeChainDb();
  seedNativeChain(db2, 5);
  const mid = db2.prepare("SELECT seq, receipt_id, prev_hash FROM receipts WHERE seq = 2").get();
  const evilSha = sha256hex("EVIL-but-resealed");
  const resealed = chainHash(mid.prev_hash, { seq: mid.seq, receipt_id: mid.receipt_id, sha256: evilSha });
  db2.prepare("UPDATE receipts SET sha256 = ?, entry_hash = ? WHERE seq = 2").run(evilSha, resealed);

  const rep2 = verifyChain({ db: db2 });
  eq(rep2.ok, false, "case B: ok === false");
  ok(rep2.tampered.find((t) => t.index === 2) === undefined,
     "case B: re-sealed row is internally consistent (not flagged as self-tamper)");
  const brk = rep2.broken_links.find((b) => b.index === 3);
  ok(!!brk, "case B: broken link detected at the row AFTER the re-sealed edit (index 3)");
  ok(brk && brk.expected_prev !== brk.actual_prev,
     "case B: broken link shows expected_prev != actual_prev");
  db2.close();
}

// --------------------------------------------------------------------------
// 4. NATIVE — a severed prev pointer is a broken link
// --------------------------------------------------------------------------
console.log("\n[4] native mode — severed link is caught");
{
  const db = newNativeChainDb();
  seedNativeChain(db, 4);
  // Overwrite prev_hash of seq 2 with garbage but leave entry_hash consistent
  // with THAT garbage prev (so it's a pure link break, not self-tamper): we
  // must recompute entry_hash for the row so only the LINK is wrong.
  const garbage = "deadbeef".repeat(8); // 64 hex chars
  const row = db.prepare("SELECT seq, receipt_id, sha256 FROM receipts WHERE seq = 2").get();
  const consistentEntry = chainHash(garbage, { seq: row.seq, receipt_id: row.receipt_id, sha256: row.sha256 });
  db.prepare("UPDATE receipts SET prev_hash = ?, entry_hash = ? WHERE seq = 2").run(garbage, consistentEntry);

  const rep = verifyChain({ db });
  eq(rep.ok, false, "severed-link chain: ok === false");
  const brk = rep.broken_links.find((b) => b.index === 2);
  ok(!!brk, "broken link detected at index 2");
  eq(brk?.actual_prev, garbage, "broken link reports the garbage actual_prev");
  ok(brk && brk.expected_prev !== garbage, "broken link expected_prev is the real prior hash");
  db.close();
}

// --------------------------------------------------------------------------
// 5. NATIVE — empty chain is trivially intact
// --------------------------------------------------------------------------
console.log("\n[5] native mode — empty chain");
{
  const db = newNativeChainDb();
  const rep = verifyChain({ db });
  eq(rep.total, 0, "empty chain: total === 0");
  eq(rep.ok, true, "empty chain: ok === true (trivially intact)");
  eq(rep.head_hash, GENESIS, "empty chain: head_hash === GENESIS");
  db.close();
}

// --------------------------------------------------------------------------
// 6. DERIVED — mirror table (receipt_id + sha256, no chain columns)
// --------------------------------------------------------------------------
console.log("\n[6] derived mode — receipts mirror");
{
  const db = newMirrorDb();
  const ins = db.prepare(
    "INSERT INTO receipts (receipt_id, prior_receipt, hash_chain, sha256) VALUES (?, ?, ?, ?)"
  );
  // Include the kind of dirty prose prior_receipt the live store actually holds,
  // to prove we do NOT false-alarm on it.
  ins.run("2026-06-23-a", null, "#011 (final)", sha256hex("a"));
  ins.run("2026-06-23-b", "`2026-06-23-a` (#012)", "#012", sha256hex("b"));
  ins.run("2026-06-23-c", "2026-06-23-b.md", "#013", sha256hex("c"));

  const rep = verifyChain({ db });
  eq(rep.mode, "derived", "detected derived mode (no chain columns)");
  eq(rep.total, 3, "derived: total === 3");
  eq(rep.ok, true, "derived: clean mirror passes despite dirty prior_receipt prose");
  eq(rep.broken_links.length, 0, "derived: no false broken links from prose pointers");
  ok(/^[0-9a-f]{64}$/.test(rep.head_hash), "derived: head_hash is a real reproducible hash");

  // Determinism: same rows -> same derived head across a fresh verify.
  const rep2 = verifyChain({ db });
  eq(rep2.head_hash, rep.head_hash, "derived: head_hash is deterministic across runs");
  db.close();
}

// --------------------------------------------------------------------------
// 7. DERIVED — a row with no valid content hash is flagged
// --------------------------------------------------------------------------
console.log("\n[7] derived mode — invalid content hash flagged");
{
  const db = newMirrorDb();
  const ins = db.prepare(
    "INSERT INTO receipts (receipt_id, prior_receipt, hash_chain, sha256) VALUES (?, ?, ?, ?)"
  );
  ins.run("2026-06-23-a", null, "#1", sha256hex("a"));
  ins.run("2026-06-23-b", null, "#2", "not-a-sha"); // unhashable -> can't anchor
  const rep = verifyChain({ db });
  eq(rep.ok, false, "derived: ok === false when a row lacks a valid content hash");
  const bad = rep.tampered.find((t) => t.receipt_id === "2026-06-23-b");
  ok(!!bad, "derived: the bad-hash row is reported");
  eq(bad?.reason, "invalid_content_hash", "derived: reason is invalid_content_hash");
  db.close();
}

// --------------------------------------------------------------------------
// 8. health.snapshot — shape + integrity roll-up (adapters injected)
// --------------------------------------------------------------------------
console.log("\n[8] health.snapshot — shape and integrity roll-up");
{
  const db = newNativeChainDb();
  const entries = seedNativeChain(db, 3);
  const injected = [
    { id: "mock-local-deterministic", name: "Mock", lane: "mock", status: "READY" },
    { id: "local-llama-cpp-listener", name: "llama.cpp", lane: "local_endpoint", status: "READY" },
    { id: "ai-box-triad-readonly", name: "Triad", lane: "subscription_cli", status: "PLANNED" },
  ];
  const snap = await snapshot({ db, adapters: injected });

  eq(snap.schema, HEALTH_SCHEMA, "snapshot carries the health schema id");
  ok(typeof snap.generated_at === "string" && snap.generated_at.includes("T"),
     "snapshot.generated_at is an ISO-8601 string");
  ok(Number.isInteger(snap.uptime_ms) && snap.uptime_ms >= 0, "snapshot.uptime_ms is a non-negative int");

  eq(snap.receipts.total, 3, "snapshot.receipts.total reflects the chain");
  eq(snap.receipts.last_hash, entries[2].entry_hash, "snapshot.receipts.last_hash === chain head");
  eq(snap.receipts.integrity.ok, true, "snapshot.receipts.integrity.ok === true for intact chain");
  eq(snap.receipts.integrity.mode, "native", "snapshot.receipts.integrity.mode === native");

  eq(snap.adapters.registered, 3, "snapshot.adapters.registered === 3 (injected)");
  eq(snap.adapters.ready, 2, "snapshot.adapters.ready === 2");
  eq(snap.adapters.by_status.READY, 2, "snapshot.adapters.by_status.READY === 2");
  eq(snap.adapters.by_status.PLANNED, 1, "snapshot.adapters.by_status.PLANNED === 1");
  ok(Array.isArray(snap.warm_lanes) && snap.warm_lanes.includes("mock") &&
     snap.warm_lanes.includes("local_endpoint"),
     "snapshot.warm_lanes lists distinct READY lanes");
  ok(!snap.warm_lanes.includes("subscription_cli"),
     "snapshot.warm_lanes excludes non-READY lanes");
  db.close();
}

// --------------------------------------------------------------------------
// 9. health.snapshot — tampered chain surfaces in the roll-up
// --------------------------------------------------------------------------
console.log("\n[9] health.snapshot — tamper surfaces in roll-up");
{
  const db = newNativeChainDb();
  seedNativeChain(db, 4);
  db.prepare("UPDATE receipts SET sha256 = ? WHERE seq = 1").run(sha256hex("EVIL"));
  const snap = await snapshot({ db, adapters: [] });
  eq(snap.receipts.integrity.ok, false, "roll-up integrity.ok === false when chain tampered");
  ok(snap.receipts.integrity.tampered >= 1, "roll-up reports >=1 tampered entry");
  eq(snap.receipts.integrity.mode, "native", "roll-up integrity.mode === native");
  db.close();
}

// --------------------------------------------------------------------------
// 10. health.snapshot — degrades gracefully with no DB
// --------------------------------------------------------------------------
console.log("\n[10] health.snapshot — graceful with no db");
{
  const snap = await snapshot({ adapters: [] });
  eq(snap.receipts.total, null, "no-db: receipts.total === null");
  eq(snap.receipts.last_hash, null, "no-db: receipts.last_hash === null");
  ok(Array.isArray(snap.notes) && snap.notes.includes("no_db_handle"),
     "no-db: notes include 'no_db_handle'");
  eq(snap.adapters.registered, 0, "no-db: injected empty adapters -> registered 0");
  db_noop();
}
function db_noop() {}

// --------------------------------------------------------------------------
// 11. health.snapshot — real registry loads (integration, no injection)
// --------------------------------------------------------------------------
console.log("\n[11] health.snapshot — real adapter registry integration");
{
  const snap = await snapshot({}); // no db, no injected adapters -> loads src/registry.mjs
  ok(snap.adapters.registered >= 4,
     `real registry yields >=4 adapters (got ${snap.adapters.registered})`);
  ok(snap.adapters.by_status.READY >= 1, "real registry has >=1 READY adapter");
  ok(Array.isArray(snap.warm_lanes) && snap.warm_lanes.length >= 1,
     "real registry surfaces >=1 warm lane");
}

// --------------------------------------------------------------------------
console.log(`\nSummary: ${pass} pass / ${fail} fail of ${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
