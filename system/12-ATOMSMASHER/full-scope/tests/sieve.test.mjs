#!/usr/bin/env bun
// AtomSmasher Full-Scope — sieve.test.mjs
//
// Standalone Bun harness for sieve.mjs — the in-line compression pass that
// gates every orange.order.v1 / orange.report.v1 before it crosses the
// dispatch boundary (the sieve→dispatcher gap closer, Pillar 5).
//
// Run: bun 12-ATOMSMASHER/full-scope/tests/sieve.test.mjs
// Emits: "Summary: N pass / M fail of T"  (same convention as the 8 green suites)
// Exit code: 0 iff all cases pass.
//
// Proves, on REAL canonical order/report samples:
//   - the crossing payload is byte-exact lossless (sha256 roundtrip)
//   - the debt receipt carries the required keys
//     { raw_bytes, compressed_bytes, ratio, modules_applied, lossless }
//   - honest ratio: shrinks big envelopes, and HONESTLY flags regression
//     (regression_flag) when a tiny envelope can't beat the frame header
//   - AIR / anti-fluff / sparse-workset / pathwave modules are all applied
//   - anti-fluff fires on fake-green / fluff-only text
//   - non-ASCII payloads still roundtrip byte-for-byte
//   - identity degradation never ships a bigger payload than raw

import crypto from 'node:crypto';

import { sieveOrder, sieveReport, sievePair, __internals } from '../sieve.mjs';
import { sha256Text } from '../utils.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)} — ${msg}`);
}
function assertGT(a, b, msg) {
  if (!(a > b)) throw new Error(`expected ${a} > ${b} — ${msg}`);
}
function assertGE(a, b, msg) {
  if (!(a >= b)) throw new Error(`expected ${a} >= ${b} — ${msg}`);
}
function runCase(name, fn) {
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  try {
    fn();
    const t1 = Number(process.hrtime.bigint() / 1000000n);
    console.log(`  PASS  ${name.padEnd(52)} ${String(t1 - t0).padStart(5)}ms`);
    passed++;
  } catch (e) {
    const t1 = Number(process.hrtime.bigint() / 1000000n);
    console.log(`  FAIL  ${name.padEnd(52)} ${String(t1 - t0).padStart(5)}ms  ${e.message}`);
    failed++;
    failures.push([name, e.message, e.stack]);
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;

// Reconstruct the exact original JSON from whatever the sieve chose to ship.
// 'identity' ships raw JSON verbatim; any other form is a reversible frame
// decodable via crossDecode. This mirrors crossing.decode's contract.
function reconstruct(crossing) {
  return crossing.form === 'identity'
    ? crossing.payload
    : __internals.crossDecode(crossing.payload);
}

// ---------------------------------------------------------------------------
// Real canonical samples
// ---------------------------------------------------------------------------

// A realistic, sizeable order — the kind that actually crosses the boundary
// in an Orange run. Repeated JSON keys + action tokens give the reversible
// codec real, honest headroom.
function bigOrder() {
  return {
    schema: 'orange.order.v1',
    orderId: 'ord-2026-07-03-sieve-close-pillar5-0001',
    intent: 'Close the AtomSmasher sieve to dispatcher gap so that every order and every report passes a compression pass before it leaves the boundary, as required by the Master Plan section nine and the operational theory steps one two eleven and twelve.',
    scope: 'Backend only. Add sieve.mjs and its standalone Bun test. Do not modify engines.mjs or storage.mjs or the existing green test files. Frame the work as project management tool compression, not security.',
    allowedActions: [
      'read_files', 'write_new_file', 'run_bun_test', 'emit_receipt',
      'import_pure_siblings', 'measure_bytes', 'prove_roundtrip',
    ],
    forbiddenActions: [
      'modify_engines_mjs', 'modify_storage_mjs', 'modify_green_tests',
      'inflate_ratios', 'claim_lossless_without_proof', 'add_ui', 'call_model_api',
    ],
    targetProject: 'Orange5 / 12-ATOMSMASHER / full-scope',
    riskLevel: 'low',
    requiresReceipt: true,
    operatorApproved: true,
    createdAt: '2026-07-03T22:00:00Z',
  };
}

function bigReport() {
  return {
    schema: 'orange.report.v1',
    orderId: 'ord-2026-07-03-sieve-close-pillar5-0001',
    status: 'complete',
    confidence: 0.94,
    actionsTaken: [
      'read engines.mjs surface', 'read utils.mjs signatures',
      'read order and report schemas', 'wrote sieve.mjs',
      'wrote sieve.test.mjs', 'ran bun sieve test', 'emitted compression debt receipt',
    ],
    evidence: [
      { kind: 'test', name: 'sieve.test.mjs', result: 'green' },
      { kind: 'roundtrip', sha256_match: true },
      { kind: 'bytes', raw: 0, compressed: 0 },
    ],
    blockers: [],
    nextAction: 'wire sieveOrder and sieveReport into the live dispatcher path in a follow-up',
    receiptPath: '12-ATOMSMASHER/full-scope/receipts/sieve-close.json',
    ae_lane: 'Orangebox Ops backend',
    ae_host: 'N150',
  };
}

// A minimal valid order — deliberately tiny so the reversible frame's header
// cost may exceed the savings. Exercises the HONEST regression path.
function tinyOrder() {
  return {
    schema: 'orange.order.v1',
    orderId: 'ord-x1',
    intent: 'ping',
    scope: 'x',
    allowedActions: [],
    forbiddenActions: [],
    targetProject: 'x',
    riskLevel: 'read_only',
    requiresReceipt: false,
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

console.log('AtomSmasher Full-Scope — sieve.mjs Bun test sweep');
console.log(`Bun ${process.versions.bun ?? '?'}`);
console.log('');

runCase('reversible_codec_roundtrips_arbitrary_string', () => {
  const { crossEncode, crossDecode } = __internals;
  const samples = [
    JSON.stringify(bigOrder()),
    JSON.stringify(bigReport()),
    '{"a":"b","c":["d","e"],"f":{"g":true,"h":null}}',
    'plain text with  spaces and  control and 😀 emoji and "quotes"',
    '',
    ' ', // a literal sentinel byte in source must survive
  ];
  for (const s of samples) {
    const { frame } = crossEncode(s);
    const back = crossDecode(frame);
    assertEqual(back, s, `roundtrip exact for ${JSON.stringify(s.slice(0, 24))}`);
    assertEqual(sha256Text(back), sha256Text(s), 'sha256 roundtrip');
  }
});

runCase('sieveOrder_crossing_is_byte_exact_lossless', () => {
  const order = bigOrder();
  const raw = JSON.stringify(order);
  const res = sieveOrder(order);
  assert(res.crossing.lossless === true, 'crossing.lossless true');
  assert(res.debt.lossless === true, 'debt.lossless true');
  assert(SHA256_RE.test(res.crossing.raw_sha256), 'raw_sha256 is sha256 hex');
  assertEqual(res.crossing.raw_sha256, sha256Text(raw), 'raw_sha256 matches raw');

  // Reconstruct from the shipped crossing and prove byte-exactness.
  const reconstructed = reconstruct(res.crossing);
  assertEqual(reconstructed, raw, 'reconstructed === raw JSON');
  assertEqual(sha256Text(reconstructed), res.crossing.raw_sha256, 'sha256 of reconstruction matches');
});

runCase('sieveReport_crossing_is_byte_exact_lossless', () => {
  const report = bigReport();
  const raw = JSON.stringify(report);
  const res = sieveReport(report);
  assert(res.crossing.lossless === true, 'report crossing lossless');
  assertEqual(reconstruct(res.crossing), raw, 'report reconstructed === raw');
});

runCase('debt_receipt_has_required_keys', () => {
  const res = sieveOrder(bigOrder());
  const d = res.debt;
  for (const k of ['raw_bytes', 'compressed_bytes', 'ratio', 'modules_applied', 'lossless']) {
    assert(k in d, `debt.${k} present`);
  }
  assertEqual(typeof d.raw_bytes, 'number', 'raw_bytes number');
  assertEqual(typeof d.compressed_bytes, 'number', 'compressed_bytes number');
  assertEqual(typeof d.ratio, 'number', 'ratio number');
  assert(Array.isArray(d.modules_applied), 'modules_applied array');
  assertEqual(typeof d.lossless, 'boolean', 'lossless boolean');
  assertEqual(d.schema, __internals.DEBT_SCHEMA_ID, 'debt schema id');
});

runCase('big_order_actually_compresses_ratio_gt_1', () => {
  const res = sieveOrder(bigOrder());
  // Honest claim: on a realistic envelope the reversible frame shrinks it.
  assertGT(res.debt.raw_bytes, 0, 'raw_bytes > 0');
  assert(res.debt.compressed_bytes <= res.debt.raw_bytes, 'compressed <= raw (never inflate the shipped payload)');
  assertGT(res.debt.ratio, 1.0, 'ratio > 1 on big order');
  assertEqual(res.debt.regression_flag, false, 'no regression on big order');
  assertEqual(res.crossing.form, 'deflate', 'ships the reversible deflate frame');
  assertGT(res.debt.savings_bytes, 0, 'positive savings');
  // compressed_bytes is the true binary deflate size, not the base64 transport.
  assert(res.debt.compressed_bytes === res.debt.deflate_bytes, 'compressed_bytes is binary deflate size');
  assert(res.debt.transport_base64_bytes > res.debt.deflate_bytes, 'base64 transport is larger than binary (honestly reported)');
});

runCase('big_report_actually_compresses_ratio_gt_1', () => {
  const res = sieveReport(bigReport());
  assertGT(res.debt.ratio, 1.0, 'ratio > 1 on big report');
  assertEqual(res.debt.regression_flag, false, 'no regression on big report');
});

runCase('tiny_order_never_ships_bigger_than_raw_and_reconstructs', () => {
  const res = sieveOrder(tinyOrder());
  // Universal invariant: the shipped payload is never bigger than raw, and it
  // always reconstructs byte-exact regardless of which form was chosen.
  assert(res.debt.compressed_bytes <= res.debt.raw_bytes, 'never ship bigger than raw');
  const raw = JSON.stringify(tinyOrder());
  assertEqual(reconstruct(res.crossing), raw, 'tiny order reconstructs exactly');
  assert(res.crossing.lossless === true, 'tiny order crossing still lossless');
  // Consistency: identity <=> regression_flag <=> ratio 1.
  if (res.crossing.form === 'identity') {
    assertEqual(res.debt.regression_flag, true, 'identity => regression flagged');
    assertEqual(res.debt.ratio, 1.0, 'identity ratio == 1');
    assertEqual(res.debt.compressed_bytes, res.debt.raw_bytes, 'identity: compressed == raw');
  } else {
    assertEqual(res.debt.regression_flag, false, 'shrank => no regression');
    assertGT(res.debt.ratio, 1.0, 'shrank => ratio > 1');
  }
});

runCase('regression_path_ships_identity_and_flags_debt', () => {
  // The regression guarantee (§6.2): when the compressed form does NOT beat
  // raw, the sieve ships identity, flags regression, reports ratio 1, and
  // never claims a saving it didn't earn. Tested deterministically at the
  // buildDebt boundary so it does not depend on out-compressing the deflate
  // codec (real orange.* envelopes almost always deflate smaller).
  const { buildDebt, DEBT_SCHEMA_ID } = __internals;
  const rawBytes = 100;
  const binaryBytes = 140; // compressed form is LARGER than raw (pathological)
  const debt = buildDebt({
    kind: 'order',
    rawBytes,
    binaryBytes,
    transportBytes: 200,
    crossSha: 'f'.repeat(64),
    rawSha: 'a'.repeat(64),
    lossless: true,
    smaller: binaryBytes < rawBytes, // false
    modulesApplied: ['air_encode'],
  });
  assertEqual(debt.schema, DEBT_SCHEMA_ID, 'debt schema');
  assertEqual(debt.regression_flag, true, 'regression flagged when not smaller');
  assertEqual(debt.shipped_form, 'identity', 'ships identity under regression');
  assertEqual(debt.compressed_bytes, rawBytes, 'compressed_bytes clamped to raw (never bigger)');
  assertEqual(debt.ratio, 1.0, 'ratio exactly 1 under regression');
  assertEqual(debt.savings_bytes, 0, 'zero savings claimed');
  assertEqual(debt.deflate_bytes, binaryBytes, 'true deflate size still recorded for audit');
});

runCase('shipped_bytes_never_exceed_raw_across_many_envelopes', () => {
  // Fuzz the universal invariant on a spread of real-shaped envelopes: no
  // matter what, compressed_bytes <= raw_bytes and the crossing reconstructs.
  for (let i = 0; i < 25; i++) {
    const o = bigOrder();
    o.orderId = `ord-fuzz-${i}-${crypto.randomBytes(3).toString('hex')}`;
    o.intent = o.intent + ' '.repeat(i) + crypto.randomBytes(i).toString('hex');
    const res = sieveOrder(o);
    assert(res.debt.compressed_bytes <= res.debt.raw_bytes, `envelope ${i}: never bigger than raw`);
    assert(res.crossing.lossless === true, `envelope ${i}: lossless`);
    assertEqual(reconstruct(res.crossing), JSON.stringify(o), `envelope ${i}: exact reconstruct`);
  }
});

runCase('all_four_named_modules_applied', () => {
  const res = sieveOrder(bigOrder());
  const m = res.debt.modules_applied;
  for (const mod of ['air_encode', 'anti_fluff_gate', 'sparse_workset_trim', 'pathwave_anchor']) {
    assert(m.includes(mod), `module ${mod} applied`);
  }
  // Orders additionally get a least-action route hint.
  assert(m.includes('least_action_route'), 'least_action_route applied on order');
});

runCase('anti_fluff_gate_flags_fake_green', () => {
  const { antiFluff } = __internals;
  assertEqual(antiFluff('probably green, should work').verdict, 'warn', 'fake-green => warn');
  assert(antiFluff('probably green').reasons.some(r => r.startsWith('fake_green:')), 'reason tagged');
  assertEqual(antiFluff('tbd').verdict, 'reject', 'tbd => reject');
  assertEqual(antiFluff('').verdict, 'reject', 'empty => reject');
  assertEqual(antiFluff('write the sieve and prove the roundtrip').verdict, 'pass', 'clean => pass');
});

runCase('report_with_fluffy_status_surfaces_warning', () => {
  const r = bigReport();
  r.status = 'looks ok'; // theatrical certainty (>= 2 chars, valid schema-wise)
  const res = sieveReport(r);
  assert(res.warnings.some(w => w.startsWith('anti_fluff_warn')), 'anti-fluff warn surfaced');
  assert(res.frame.fluff_verdict === 'warn', 'frame fluff verdict warn');
  // Still lossless — anti-fluff is a view-level verdict, never mutates crossing.
  assert(res.crossing.lossless === true, 'still lossless with fluffy status');
});

runCase('non_ascii_payload_roundtrips_byte_exact', () => {
  const order = bigOrder();
  order.intent = 'Comprimé: gère la rivière de données 河流 — Ω≈±∞ 😀 with "quotes" and \\backslashes\\';
  order.scope = 'Ünïcödé scope with emoji 🚀 and CJK 圧縮';
  const raw = JSON.stringify(order);
  const res = sieveOrder(order);
  assert(res.crossing.lossless === true, 'non-ascii crossing lossless');
  assertEqual(reconstruct(res.crossing), raw, 'non-ascii reconstructed exactly');
  // raw_bytes must be the utf8 byte length, strictly greater than the JS
  // string length for this multibyte payload.
  assertGT(res.debt.raw_bytes, raw.length, 'raw_bytes counts utf8 bytes, not code units');
});

runCase('deterministic_same_input_same_debt_hashes', () => {
  const a = sieveOrder(bigOrder());
  const b = sieveOrder(bigOrder());
  assertEqual(a.debt.sha256_raw, b.debt.sha256_raw, 'raw sha stable');
  assertEqual(a.debt.sha256_crossing, b.debt.sha256_crossing, 'crossing sha stable');
  assertEqual(a.debt.raw_bytes, b.debt.raw_bytes, 'raw_bytes stable');
  assertEqual(a.debt.compressed_bytes, b.debt.compressed_bytes, 'compressed_bytes stable');
});

runCase('sievePair_combines_order_and_report', () => {
  const res = sievePair(bigOrder(), bigReport());
  assert(res.pair.both_lossless === true, 'both lossless');
  assertGT(res.pair.total_raw_bytes, 0, 'total raw > 0');
  assert(res.pair.total_shipped_bytes <= res.pair.total_raw_bytes, 'pair never inflates');
  assertGT(res.pair.total_ratio, 1.0, 'pair ratio > 1');
  assert(res.pair.modules_applied.includes('air_encode'), 'pair lists modules');
});

runCase('malformed_input_is_rejected_not_silently_passed', () => {
  let threw = false;
  try { sieveOrder(null); } catch { threw = true; }
  assert(threw, 'null order throws');
  threw = false;
  try { sieveReport([1, 2, 3]); } catch { threw = true; }
  assert(threw, 'array report throws');
  // Wrong schema is a soft warning, not a crash (boundary must stay up).
  const res = sieveOrder({ ...bigOrder(), schema: 'wrong.schema' });
  assert(res.warnings.some(w => w.startsWith('schema_mismatch')), 'schema mismatch warned');
  assert(res.crossing.lossless === true, 'still processes losslessly despite schema warn');
});

// ---------------------------------------------------------------------------
console.log('');
console.log(`Summary: ${passed} pass / ${failed} fail of ${passed + failed}`);
if (failed > 0) {
  console.log('');
  console.log('Failures:');
  for (const [name, msg, stack] of failures) {
    console.log(`  ${name}:`);
    console.log(`    ${msg}`);
    if (process.env.VERBOSE) console.log(stack);
  }
  process.exit(1);
}
process.exit(0);
