// commitment-atoms/_smoke.mjs
//
// Minimal proof the encoder works as advertised. Run with:
//   node 12-ATOMSMASHER/commitment-atoms/_smoke.mjs
//
// Exits non-zero on any failure. No test framework dep.

import { encodeCommitmentAtom, validateCommitmentAtom } from './encoder.mjs';

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}
function expectThrow(label, fn, needle) {
  try {
    fn();
    console.log(`  FAIL ${label} — expected throw, none raised`);
    failed++;
  } catch (e) {
    if (needle && !e.message.includes(needle)) {
      console.log(`  FAIL ${label} — wrong message: ${e.message}`);
      failed++;
    } else {
      console.log(`  ok   ${label}`);
    }
  }
}

console.log('1. round-trip encode -> validate');
const a = encodeCommitmentAtom({
  kind: 'decision',
  body: { statement: 'OrangeLLM-fatty is the only trained brain.' },
  actor: 'operator:atom',
  prevHash: 'GENESIS',
});
const v1 = validateCommitmentAtom(a);
check('valid=true', v1.valid, JSON.stringify(v1.errors));
check('atom_id is sha256', /^[a-f0-9]{64}$/.test(a.atom_id));
check('signature.hash is sha256', /^[a-f0-9]{64}$/.test(a.signature.hash));
check('status active', a.status === 'active');

console.log('2. determinism — same content -> same atom_id');
const b = encodeCommitmentAtom({
  kind: 'decision',
  body: { statement: 'OrangeLLM-fatty is the only trained brain.' },
  actor: 'someone:else', // actor not in id payload
  prevHash: 'OTHER',
});
check('atom_ids match', a.atom_id === b.atom_id);
check('signature.hash differs (prevHash differs)', a.signature.hash !== b.signature.hash);

console.log('3. key-order independence');
const c1 = encodeCommitmentAtom({
  kind: 'decision',
  body: { a: 1, b: 2, c: 3 },
  actor: 'operator:atom',
  prevHash: 'GENESIS',
});
const c2 = encodeCommitmentAtom({
  kind: 'decision',
  body: { c: 3, b: 2, a: 1 },
  actor: 'operator:atom',
  prevHash: 'GENESIS',
});
check('canonical hashes equal', c1.atom_id === c2.atom_id);

console.log('4. tamper detection');
const tampered = JSON.parse(JSON.stringify(a));
tampered.body.statement = 'OrangeLLM-fatty has been quietly replaced.';
const vt = validateCommitmentAtom(tampered);
check('tamper caught', !vt.valid, JSON.stringify(vt.errors));

console.log('5. anti-fluff — forbidden words hard reject');
for (const word of ['green_assumed', 'looks_ok', 'probably', 'should_work']) {
  expectThrow(
    `reject body containing "${word}"`,
    () =>
      encodeCommitmentAtom({
        kind: 'decision',
        body: { note: `this ${word} fine` },
        actor: 'operator:atom',
        prevHash: 'GENESIS',
      }),
    'anti-fluff',
  );
}

console.log('6. evidence required for invariant + promise');
expectThrow(
  'invariant with empty evidence rejected',
  () =>
    encodeCommitmentAtom({
      kind: 'invariant',
      body: { rule: 'runtime/node.py is the sole cognitive center' },
      actor: 'system:atomeons',
      prevHash: 'GENESIS',
    }),
  'evidence',
);
expectThrow(
  'promise with empty evidence rejected',
  () =>
    encodeCommitmentAtom({
      kind: 'promise',
      body: { commitment: 'ship Orange5 v0.7 by Friday' },
      actor: 'operator:atom',
      prevHash: 'GENESIS',
    }),
  'evidence',
);
const inv = encodeCommitmentAtom({
  kind: 'invariant',
  body: { rule: 'FOUNDER_SALARY_PER_INSTALL_CENTS is enforced in payout logic' },
  evidence: ['receipts/2026-06-24/drift-audit-001.json'],
  actor: 'system:atomeons',
  prevHash: 'GENESIS',
});
check('invariant with evidence accepted', validateCommitmentAtom(inv).valid);

console.log('7. supersede chain links via prev_hash');
const next = encodeCommitmentAtom({
  kind: 'decision',
  body: { statement: 'OrangeLLM-fatty retired in favor of fatty-v2.' },
  supersedes: [a.atom_id],
  evidence: ['receipts/2026-09-01/fatty-v2-eval.json'],
  actor: 'operator:atom',
  prevHash: a.signature.hash,
});
check('next.prev_hash === a.signature.hash', next.signature.prev_hash === a.signature.hash);
check('next.supersedes includes a.atom_id', next.supersedes.includes(a.atom_id));
check('next validates', validateCommitmentAtom(next).valid);

console.log('8. bad inputs throw');
expectThrow('invalid kind', () =>
  encodeCommitmentAtom({ kind: 'wish', body: {}, actor: 'x', prevHash: 'g' }),
  'invalid kind',
);
expectThrow('missing prevHash', () =>
  encodeCommitmentAtom({ kind: 'decision', body: {}, actor: 'x' }),
  'prevHash',
);
expectThrow('non-object body', () =>
  encodeCommitmentAtom({ kind: 'decision', body: 'string', actor: 'x', prevHash: 'g' }),
  'body',
);
expectThrow('bad expires_at', () =>
  encodeCommitmentAtom({
    kind: 'decision',
    body: { x: 1 },
    actor: 'x',
    prevHash: 'g',
    expires_at: 'not-a-date',
  }),
  'expires_at',
);

console.log('');
if (failed === 0) {
  console.log(`PASS — all checks green`);
  process.exit(0);
} else {
  console.log(`FAIL — ${failed} check(s) failed`);
  process.exit(1);
}
