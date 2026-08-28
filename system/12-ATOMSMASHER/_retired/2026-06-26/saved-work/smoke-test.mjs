// saved-work/smoke-test.mjs
//
// AtomSmasher Saved Work Certificates — END-TO-END smoke test.
//
// Exercises the LIVE pure-encoder round-trip:
//
//   mint -> verify -> redeem -> verify -> (single_use replay reject)
//                  \-> revoke -> verify -> (post-revoke redeem reject)
//
// No file I/O, no DB, no HTTP. This test pins the cryptographic + policy
// guarantees the certs module promises. Sibling store/gateway layers are
// out of scope for this drop and have their own smoke tests when they land.
//
// Run with: node 12-ATOMSMASHER/saved-work/smoke-test.mjs
// Exits non-zero on any failure. No test-framework dep.

import crypto from 'node:crypto';

import {
  mint,
  verify,
  redeem,
  revoke,
  CERT_SCHEMA_ID,
  VALID_POLICIES,
  VALID_STATUSES,
  SAVED_WORK_CERT_SCHEMA,
  __internals,
} from './certs.mjs';

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function expectThrow(label, fn, matchRe) {
  try {
    fn();
    check(label, false, 'no throw');
  } catch (err) {
    if (matchRe && !matchRe.test(err.message)) {
      check(label, false, `wrong error: ${err.message}`);
      return;
    }
    check(label, true);
  }
}

// ---------------------------------------------------------------------------
// Sample work payloads — Mom's Law: real content, no theater words
// ---------------------------------------------------------------------------

const WORK_SPEC = {
  goal: 'Compile AtomSmasher Saved Work Certificates encoder.mjs',
  inputs: ['12-ATOMSMASHER/saved-work/certs.mjs'],
  tooling: 'node v22 ESM',
};
const OUTPUT_ARTIFACT = {
  artifact_path: '12-ATOMSMASHER/saved-work/certs.mjs',
  bytes: 14072,
  exports: ['mint', 'verify', 'redeem', 'revoke', 'SAVED_WORK_CERT_SCHEMA'],
};

const WORK_HASH = sha256(JSON.stringify(WORK_SPEC));
const OUTPUT_HASH = sha256(JSON.stringify(OUTPUT_ARTIFACT));
const INPUTS_DIGEST = `node:${process.version}|cwd:Orange5/12-ATOMSMASHER`;

const MINT_BASE = Object.freeze({
  work_kind: 'authoring',
  work_hash: WORK_HASH,
  output_hash: OUTPUT_HASH,
  inputs_digest: INPUTS_DIGEST,
  output_summary:
    'Authored saved-work/certs.mjs (mint/verify/redeem/revoke). Pure module, zero deps, deterministic content-derived cert_id, append-only signature_chain.',
  references_receipt: [
    'receipts/2026-06-24/atomsmasher-saved-work-cert-author.md',
    'receipts/2026-06-24/atomsmasher-saved-work-smoke.json',
  ],
  actor: 'system:atomsmasher',
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('0. module surface sanity');
  check('CERT_SCHEMA_ID is the v0 id', CERT_SCHEMA_ID === 'orange5.atomsmasher.saved-work-cert.v0');
  check('VALID_POLICIES has single_use + multi_use', VALID_POLICIES.includes('single_use') && VALID_POLICIES.includes('multi_use'));
  check('VALID_STATUSES has minted, redeemed, revoked',
    ['minted', 'redeemed', 'revoked'].every((s) => VALID_STATUSES.includes(s)));
  check('schema is frozen', Object.isFrozen(SAVED_WORK_CERT_SCHEMA));
  check('__internals exposes sealCert', typeof __internals.sealCert === 'function');

  // -------------------------------------------------------------------------
  // 1. Mint a single_use cert (prevHash=GENESIS)
  // -------------------------------------------------------------------------
  console.log('1. mint single_use cert (prevHash=GENESIS)');
  const certA = mint({ ...MINT_BASE, prevHash: 'GENESIS' });
  check('certA.schema is the v0 id', certA.schema === CERT_SCHEMA_ID);
  check('certA.cert_id is 64-char hex', /^[a-f0-9]{64}$/.test(certA.cert_id));
  check('certA.status is minted', certA.status === 'minted');
  check('certA.policy is single_use', certA.policy === 'single_use');
  check('certA.signature_chain has exactly 1 link', certA.signature_chain.length === 1);
  check('certA chain head prev_hash is GENESIS', certA.signature_chain[0].prev_hash === 'GENESIS');
  check('certA chain head event is mint', certA.signature_chain[0].event === 'mint');
  check('certA chain head hash is 64-char hex', /^[a-f0-9]{64}$/.test(certA.signature_chain[0].hash));

  const vA = verify(certA);
  check('certA verifies', vA.valid, JSON.stringify(vA.errors));

  // -------------------------------------------------------------------------
  // 2. Content determinism: equal {work, output, inputs, references} -> equal cert_id
  // -------------------------------------------------------------------------
  console.log('2. content-derived cert_id determinism');
  const certA_twin = mint({ ...MINT_BASE, prevHash: 'GENESIS' });
  check('twin cert_id equals original cert_id', certA_twin.cert_id === certA.cert_id);
  // ...but a different prevHash should NOT change cert_id, only the signature_chain head hash.
  const otherPrev = sha256('not-genesis');
  const certA_alt = mint({ ...MINT_BASE, prevHash: otherPrev });
  check('different prevHash keeps cert_id stable', certA_alt.cert_id === certA.cert_id);
  check(
    'different prevHash changes signature_chain head hash',
    certA_alt.signature_chain[0].hash !== certA.signature_chain[0].hash,
  );

  // -------------------------------------------------------------------------
  // 3. Tamper detection
  // -------------------------------------------------------------------------
  console.log('3. tamper detection');
  const tampered = JSON.parse(JSON.stringify(certA));
  tampered.output_summary = 'I changed this after the seal.';
  const vt = verify(tampered);
  check('tampered output_summary fails verify', !vt.valid);
  check(
    'tamper error names signature_chain tail hash integrity',
    vt.errors.some((e) => /signature_chain tail hash integrity/.test(e)),
  );

  const tamperedId = JSON.parse(JSON.stringify(certA));
  tamperedId.cert_id = 'f'.repeat(64);
  const vti = verify(tamperedId);
  check('tampered cert_id fails verify', !vti.valid);
  check(
    'tamper error names cert_id integrity',
    vti.errors.some((e) => /cert_id integrity/.test(e)),
  );

  // -------------------------------------------------------------------------
  // 4. Anti-fluff hard reject
  // -------------------------------------------------------------------------
  console.log('4. anti-fluff hard reject');
  expectThrow(
    'should_work in output_summary throws',
    () => mint({ ...MINT_BASE, prevHash: 'GENESIS', output_summary: 'should_work in production' }),
    /anti-fluff/,
  );
  expectThrow(
    'looks_ok in references_receipt throws',
    () =>
      mint({
        ...MINT_BASE,
        prevHash: 'GENESIS',
        references_receipt: ['receipts/looks_ok-skip-2026.md'],
      }),
    /anti-fluff/,
  );

  // -------------------------------------------------------------------------
  // 5. Required-evidence (references_receipt) enforcement
  // -------------------------------------------------------------------------
  console.log('5. references_receipt is required + non-empty');
  expectThrow(
    'empty references_receipt throws',
    () => mint({ ...MINT_BASE, prevHash: 'GENESIS', references_receipt: [] }),
    /non-empty array/,
  );
  expectThrow(
    'non-array references_receipt throws',
    () => mint({ ...MINT_BASE, prevHash: 'GENESIS', references_receipt: 'receipts/x.md' }),
    /non-empty array/,
  );

  // -------------------------------------------------------------------------
  // 6. Bad-shape hashes
  // -------------------------------------------------------------------------
  console.log('6. work_hash / output_hash must be 64-char hex');
  expectThrow(
    'short work_hash throws',
    () => mint({ ...MINT_BASE, prevHash: 'GENESIS', work_hash: 'abc' }),
    /work_hash/,
  );
  expectThrow(
    'uppercase output_hash throws',
    () =>
      mint({
        ...MINT_BASE,
        prevHash: 'GENESIS',
        output_hash: WORK_HASH.toUpperCase(),
      }),
    /output_hash/,
  );

  // -------------------------------------------------------------------------
  // 7. Redeem single_use: status flips, chain extends, second redeem rejected
  // -------------------------------------------------------------------------
  console.log('7. redeem single_use cert');
  const redeemedA = redeem(certA, { consumer: 'task:replay-001', reason: 'cache hit on identical work spec' });
  check('redeem returns new object (not mutated)', redeemedA !== certA);
  check('original cert still minted', certA.status === 'minted');
  check('original chain still length 1', certA.signature_chain.length === 1);
  check('redeemed status is redeemed', redeemedA.status === 'redeemed');
  check('redeemed chain length is 2', redeemedA.signature_chain.length === 2);
  check(
    'redeemed chain link[1].prev_hash equals link[0].hash',
    redeemedA.signature_chain[1].prev_hash === redeemedA.signature_chain[0].hash,
  );
  check('redeemed chain link[1].event is redeem', redeemedA.signature_chain[1].event === 'redeem');
  check('redeemed cert_id is stable', redeemedA.cert_id === certA.cert_id);
  const vR = verify(redeemedA);
  check('redeemed cert verifies', vR.valid, JSON.stringify(vR.errors));

  expectThrow(
    'second redeem of single_use throws',
    () => redeem(redeemedA, { consumer: 'task:replay-002' }),
    /already redeemed/,
  );

  // -------------------------------------------------------------------------
  // 8. Multi-use redeem: status stays minted, chain still extends per redeem
  // -------------------------------------------------------------------------
  console.log('8. multi_use redeem extends chain without flipping status');
  const certM = mint({ ...MINT_BASE, prevHash: 'GENESIS', policy: 'multi_use' });
  const r1 = redeem(certM, { consumer: 'task:replay-A' });
  const r2 = redeem(r1, { consumer: 'task:replay-B' });
  const r3 = redeem(r2, { consumer: 'task:replay-C' });
  check('multi_use r3 status still minted', r3.status === 'minted');
  check('multi_use chain length is 4 (mint + 3 redeems)', r3.signature_chain.length === 4);
  check('multi_use chain link[3].consumer is task:replay-C', r3.signature_chain[3].consumer === 'task:replay-C');
  // Linkage integrity check across every hop:
  for (let i = 1; i < r3.signature_chain.length; i++) {
    check(
      `multi_use chain link[${i}].prev_hash == link[${i - 1}].hash`,
      r3.signature_chain[i].prev_hash === r3.signature_chain[i - 1].hash,
    );
  }
  const vM = verify(r3);
  check('multi_use r3 verifies after 3 redeems', vM.valid, JSON.stringify(vM.errors));

  // -------------------------------------------------------------------------
  // 9. Revoke: status flips, chain extends, post-revoke redeem rejected
  // -------------------------------------------------------------------------
  console.log('9. revoke');
  const certB = mint({ ...MINT_BASE, prevHash: 'GENESIS' });
  const revoked = revoke(certB, { actor: 'operator:atom', reason: 'replaced by certB-v2' });
  check('revoked status is revoked', revoked.status === 'revoked');
  check('revoked chain length is 2', revoked.signature_chain.length === 2);
  check('revoked chain link[1].event is revoke', revoked.signature_chain[1].event === 'revoke');
  const vRev = verify(revoked);
  check('revoked cert verifies', vRev.valid, JSON.stringify(vRev.errors));

  expectThrow(
    'redeeming a revoked cert throws',
    () => redeem(revoked, { consumer: 'task:replay-X' }),
    /status=revoked/,
  );
  expectThrow(
    'double revoke throws',
    () => revoke(revoked, { actor: 'operator:atom' }),
    /already revoked/,
  );

  // -------------------------------------------------------------------------
  // 10. Schema strictness: extra field rejected by verify
  // -------------------------------------------------------------------------
  console.log('10. additionalProperties: false');
  const extra = JSON.parse(JSON.stringify(certA));
  extra.surprise = 'i should not be allowed';
  const vE = verify(extra);
  check('unknown field rejected', !vE.valid);
  check(
    'unknown field error names the offending key',
    vE.errors.some((e) => /unknown field: surprise/.test(e)),
  );

  // -------------------------------------------------------------------------
  // 11. Chain-rewrite resistance: editing an earlier link breaks the tail hash
  // -------------------------------------------------------------------------
  console.log('11. chain-rewrite resistance');
  const rewrite = JSON.parse(JSON.stringify(redeemedA));
  rewrite.signature_chain[0].event = 'mint-but-i-changed-my-mind';
  const vRW = verify(rewrite);
  check('mid-chain edit breaks verify', !vRW.valid);
  check(
    'mid-chain edit error names tail hash integrity',
    vRW.errors.some((e) => /signature_chain tail hash integrity/.test(e)),
  );
}

main()
  .catch((err) => {
    console.error(`smoke test crashed: ${err.stack || err.message}`);
    failed++;
  })
  .finally(() => {
    console.log('');
    if (failed === 0) {
      console.log('PASS — AtomSmasher saved-work end-to-end smoke green');
      process.exit(0);
    } else {
      console.log(`FAIL — ${failed} check(s) failed`);
      process.exit(1);
    }
  });
