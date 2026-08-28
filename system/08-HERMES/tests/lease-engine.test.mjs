#!/usr/bin/env node
// 08-HERMES / tests / lease-engine.test.mjs
//
// Hermetic tests for the Hermes lease engine. Each test uses a temp SQLite
// file under the OS temp dir so the production leases.db is never touched,
// and the reaper interval is disabled — we drive reapOnce() directly.

import {
  createLease,
  checkAction,
  revokeLease,
  listActive,
  reapOnce,
  init,
  close,
  REFUSAL,
  DEFAULT_FORBIDDEN,
  HermesError,
} from "../src/lease-engine.mjs";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const results = [];

function assert(cond, msg) {
  if (cond) { pass += 1; results.push(["PASS", msg]); }
  else      { fail += 1; results.push(["FAIL", msg]); }
}

function assertEq(actual, expected, msg) {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function freshEngine() {
  close();
  const dir = mkdtempSync(join(tmpdir(), "hermes-test-"));
  const dbPath = join(dir, "leases.db");
  init({ dbPath, startReaper: false });
  return { dir, dbPath };
}

// ── 1. lease shape and defaults ────────────────────────────────────────────
{
  freshEngine();
  const lease = createLease({
    actor: "orangellm-light",
    allowed: ["read_file", "grep", "list_dir"],
    forbidden: ["delete_file"],
    targetProject: "orange5",
    riskLevel: "low",
  });
  assert(lease.id.startsWith("lease_"), "lease id is minted with lease_ prefix");
  assertEq(lease.status, "active", "new lease is active");
  assertEq(lease.actor, "orangellm-light", "actor is preserved");
  assertEq(lease.targetProject, "orange5", "targetProject is preserved");
  assertEq(lease.riskLevel, "low", "riskLevel is preserved");
  for (const f of DEFAULT_FORBIDDEN) {
    assert(lease.forbidden.includes(f), `default forbidden auto-merged: ${f}`);
  }
  assert(lease.forbidden.includes("delete_file"), "custom forbidden preserved");
  assert(lease.expires_at > Date.now(), "expires_at is in the future");
}

// ── 2. checkAction: closed-world allow / forbid / scope ────────────────────
{
  freshEngine();
  const lease = createLease({
    actor: "a",
    allowed: ["read_file", "grep"],
    targetProject: "orange5",
    riskLevel: "low",
  });
  assertEq(checkAction(lease, "read_file").allowed, true, "allowed action passes");
  const grepRes = checkAction(lease, "grep");
  assertEq(grepRes.allowed, true, "second allowed action passes");

  const forb = checkAction(lease, "destructive_write");
  assertEq(forb.allowed, false, "default-forbidden action denied");
  assertEq(forb.reason, REFUSAL.ACTION_FORBIDDEN, "refusal reason = action_forbidden");

  const scope = checkAction(lease, "write_file");
  assertEq(scope.allowed, false, "unlisted action denied");
  assertEq(scope.reason, REFUSAL.SCOPE_VIOLATION, "refusal reason = scope_violation");
}

// ── 3. checkAction: expiry ─────────────────────────────────────────────────
{
  freshEngine();
  const lease = createLease({
    actor: "a",
    allowed: ["read_file"],
    targetProject: "orange5",
    ttl_ms: 50,
  });
  // Pin the clock to a pre-expiry instant. A 50ms TTL can lapse before this
  // synchronous check runs when the process is busy, so drive `now` explicitly
  // rather than racing wall-clock — the very next case does the same for expiry.
  const fresh = lease.expires_at - 1;
  assertEq(checkAction(lease, "read_file", { now: fresh }).allowed, true, "fresh lease allows action");
  const future = lease.expires_at + 1;
  const res = checkAction(lease, "read_file", { now: future });
  assertEq(res.allowed, false, "expired lease blocks action");
  assertEq(res.reason, REFUSAL.LEASE_EXPIRED, "refusal reason = lease_expired");
}

// ── 4. high-risk auto-flags requires_approval ──────────────────────────────
{
  freshEngine();
  const high = createLease({
    actor: "heavy",
    allowed: ["push_branch"],
    targetProject: "orange5",
    riskLevel: "high",
  });
  assertEq(high.requires_approval, true, "high risk → requires_approval=true");
  const denied = checkAction(high, "push_branch");
  assertEq(denied.allowed, false, "no operator approval blocks high-risk action");
  assertEq(denied.reason, REFUSAL.OPERATOR_APPROVAL_REQUIRED, "refusal = operator_approval_required");
  const ok = checkAction(high, "push_branch", { operator_approved: true });
  assertEq(ok.allowed, true, "operator_approved=true allows high-risk action");
}

// ── 5. allowed/forbidden conflict throws structured error ──────────────────
{
  freshEngine();
  let err;
  try {
    createLease({
      actor: "x",
      allowed: ["destructive_write"],
      targetProject: "orange5",
    });
  } catch (e) { err = e; }
  assert(err instanceof HermesError, "conflict raises HermesError");
  assertEq(err?.code, "lease_conflict", "conflict code = lease_conflict");
}

// ── 6. revokeLease ─────────────────────────────────────────────────────────
{
  freshEngine();
  const lease = createLease({
    actor: "a",
    allowed: ["read_file"],
    targetProject: "orange5",
  });
  const r = revokeLease(lease.id, "operator killed");
  assertEq(r.ok, true, "revokeLease returns ok=true");
  assertEq(r.lease?.status, "revoked", "lease status flipped to revoked");
  const denied = checkAction(r.lease, "read_file");
  assertEq(denied.allowed, false, "revoked lease blocks action");
  assertEq(denied.reason, REFUSAL.LEASE_EXPIRED, "revoked lease reports lease_expired");

  const r2 = revokeLease(lease.id, "again");
  assertEq(r2.ok, false, "double-revoke returns ok=false");

  const r3 = revokeLease("lease_does_not_exist", "x");
  assertEq(r3.ok, false, "revoking missing lease returns ok=false");
}

// ── 7. listActive: filters expired and revoked ─────────────────────────────
{
  freshEngine();
  const a = createLease({ actor: "a", allowed: ["x"], targetProject: "orange5" });
  const b = createLease({ actor: "b", allowed: ["y"], targetProject: "orange5" });
  const c = createLease({ actor: "c", allowed: ["z"], targetProject: "orange5", ttl_ms: 10 });

  revokeLease(b.id, "test");

  // Force c to expire then run reaper.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(25);
  reapOnce();

  const live = listActive();
  const ids = live.map(l => l.id);
  assert(ids.includes(a.id), "active lease appears in listActive");
  assert(!ids.includes(b.id), "revoked lease excluded from listActive");
  assert(!ids.includes(c.id), "expired lease excluded from listActive");
}

// ── 8. background reaper: reapOnce expires past-due leases ─────────────────
{
  freshEngine();
  const short = createLease({
    actor: "a",
    allowed: ["read_file"],
    targetProject: "orange5",
    ttl_ms: 10,
  });
  const long = createLease({
    actor: "b",
    allowed: ["read_file"],
    targetProject: "orange5",
    ttl_ms: 60_000,
  });
  await new Promise(r => setTimeout(r, 25));
  const expired = reapOnce();
  assertEq(expired, 1, "reapOnce expires exactly the past-due lease");
  const live = listActive();
  assertEq(live.length, 1, "one lease remains after reap");
  assertEq(live[0].id, long.id, "remaining lease is the non-expired one");
}

// ── 9. SQLite durability across init/close ─────────────────────────────────
{
  const { dir, dbPath } = freshEngine();
  const lease = createLease({
    actor: "persisted",
    allowed: ["read_file"],
    targetProject: "orange5",
    ttl_ms: 60_000,
  });
  close();
  // Reopen the same DB file
  init({ dbPath, startReaper: false });
  const live = listActive();
  const found = live.find(l => l.id === lease.id);
  assert(Boolean(found), "lease rehydrated from SQLite after close/reopen");
  assertEq(found?.actor, "persisted", "rehydrated lease preserves actor");
  assertEq(found?.allowed[0], "read_file", "rehydrated lease preserves allowed[]");
  close();
  // Best-effort temp cleanup. On Windows the SQLite file handle can linger for
  // a beat after db.close(), so a bare rmSync races EBUSY. Retry briefly; never
  // let teardown failure mask the assertions above.
  safeRm(dir);
}

function safeRm(dir) {
  for (let i = 0; i < 10; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) {
      if (e?.code !== "EBUSY" && e?.code !== "EPERM" && e?.code !== "ENOTEMPTY") return;
      Bun.sleepSync(20);
    }
  }
}

// ── 10. input validation: structured errors ────────────────────────────────
{
  freshEngine();
  for (const [opts, code] of [
    [null, "invalid_options"],
    [{ targetProject: "p" }, "invalid_actor"],
    [{ actor: "a" }, "invalid_target"],
    [{ actor: "a", targetProject: "p", riskLevel: "nuclear" }, "invalid_risk_level"],
    [{ actor: "a", targetProject: "p", ttl_ms: -1 }, "invalid_ttl"],
    [{ actor: "a", targetProject: "p", allowed: [1, 2] }, "invalid_allowed"],
  ]) {
    let err;
    try { createLease(opts); } catch (e) { err = e; }
    assert(err instanceof HermesError, `bad input rejected → ${code}`);
    assertEq(err?.code, code, `bad input code = ${code}`);
  }
}

// ── 11. checkAction with bogus inputs degrades safely ──────────────────────
{
  freshEngine();
  const r1 = checkAction(null, "anything");
  assertEq(r1.allowed, false, "checkAction(null) denies safely");
  const r2 = checkAction({}, "");
  assertEq(r2.allowed, false, "checkAction with empty action denies");
}

// ── report ─────────────────────────────────────────────────────────────────
close();
for (const [tag, msg] of results) console.log(`  ${tag} ${msg}`);
console.log(`\n[hermes-lease-engine] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
