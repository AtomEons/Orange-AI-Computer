// canon-pressure/smoke-test.mjs
//
// AtomSmasher Canon Pressure Detector — END-TO-END smoke test.
//
// Exercises:
//   ingestReceiptReference (idempotency, mission-coherence guard)
//     -> candidateStatus (inert -> receipt -> receipt+op transitions)
//       -> recordOperatorPromotion (promote / reject precedence)
//         -> listPromotionCandidates (ordering, inert exclusion)
//           -> pressureSummary (honest counts, no theater)
//
// Run with (must resolve better-sqlite3 — Orange5 has it under
// 06-CONTROL-PLANE/receipts/node_modules):
//   cd C:/AtomEons/Orange5/06-CONTROL-PLANE/receipts
//   node C:/AtomEons/Orange5/12-ATOMSMASHER/canon-pressure/smoke-test.mjs
//
// Exits non-zero on any failure. No test framework dep.

import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as detector from './detector.mjs';

let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function assertExports(mod, names, label) {
  for (const name of names) {
    const present = typeof mod[name] === 'function';
    check(`${label}.${name} is exported`, present);
  }
}

function mkWorkspace() {
  const ts = Date.now();
  const root = path.join(os.tmpdir(), `canon-pressure-smoke-${ts}`);
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    dbPath: path.join(root, 'canon-pressure.db'),
  };
}

async function cleanup(ws) {
  try {
    detector._closeAllForTests();
    await fsp.rm(ws.root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Real candidates, real receipts, real mission ids. No theater.
// ---------------------------------------------------------------------------

const CANDIDATE_PATHWAVES = 'Pathwaves';
const CANDIDATE_NEON      = 'Neon';
const CANDIDATE_KSTRATA   = 'Knowledge Strata';

const MISSION_ORANGE5     = 'mission:orange5-build';
const MISSION_MISFITS     = 'mission:misfits-frontier';
const MISSION_RECEIPTS    = 'mission:receipts-pipeline';

async function main() {
  const ws = mkWorkspace();
  console.log(`workspace: ${ws.root}`);

  // -------------------------------------------------------------------------
  // 0. Module surface
  // -------------------------------------------------------------------------
  console.log('0. detector module sanity');
  assertExports(
    detector,
    [
      'ingestReceiptReference',
      'recordOperatorPromotion',
      'candidateStatus',
      'listPromotionCandidates',
      'pressureSummary',
      '_closeAllForTests',
    ],
    'detector',
  );
  check(
    'PRESSURE_THRESHOLDS.MIN_RECEIPTS === 5',
    detector.PRESSURE_THRESHOLDS.MIN_RECEIPTS === 5,
  );
  check(
    'PRESSURE_THRESHOLDS.MIN_MISSIONS === 2',
    detector.PRESSURE_THRESHOLDS.MIN_MISSIONS === 2,
  );
  if (failed > 0) {
    console.log('aborting — contract incomplete');
    await cleanup(ws);
    return;
  }

  // -------------------------------------------------------------------------
  // 1. Honest-empty baseline
  // -------------------------------------------------------------------------
  console.log('1. empty DB returns honest zeros');
  const sum0 = detector.pressureSummary({ dbPath: ws.dbPath });
  check('summary total_candidates is 0', sum0.total_candidates === 0);
  check('summary total_receipts is 0', sum0.total_receipts === 0);
  check('summary total_missions is 0', sum0.total_missions === 0);
  check(
    'summary state buckets all zero',
    sum0.states.inert === 0 &&
      sum0.states.receipt === 0 &&
      sum0.states.operator === 0 &&
      sum0.states['receipt+op'] === 0,
  );
  const list0 = detector.listPromotionCandidates({ dbPath: ws.dbPath });
  check('listPromotionCandidates returns [] when empty', Array.isArray(list0) && list0.length === 0);

  // -------------------------------------------------------------------------
  // 2. Ingest 4 receipts for Pathwaves across 2 missions — BELOW receipt threshold (need 5)
  // -------------------------------------------------------------------------
  console.log('2. ingest 4 Pathwaves receipts (2 missions) — should stay inert (<5)');
  const ingest = (cand, rid, mid, actor) =>
    detector.ingestReceiptReference({
      candidate: cand,
      receiptId: rid,
      missionId: mid,
      refActor: actor,
      dbPath: ws.dbPath,
    });

  check('ingest pw-r1 ok', ingest(CANDIDATE_PATHWAVES, 'pw-r1', MISSION_ORANGE5, 'system:atomeons').ok === true);
  check('ingest pw-r2 ok', ingest(CANDIDATE_PATHWAVES, 'pw-r2', MISSION_ORANGE5, 'system:atomeons').ok === true);
  check('ingest pw-r3 ok', ingest(CANDIDATE_PATHWAVES, 'pw-r3', MISSION_MISFITS, 'operator:atom').ok === true);
  check('ingest pw-r4 ok', ingest(CANDIDATE_PATHWAVES, 'pw-r4', MISSION_MISFITS, 'operator:atom').ok === true);

  const pwStatusBelow = detector.candidateStatus(CANDIDATE_PATHWAVES, { dbPath: ws.dbPath });
  check('pw receipt_count === 4', pwStatusBelow.receipt_count === 4, `got ${pwStatusBelow.receipt_count}`);
  check('pw mission_count === 2', pwStatusBelow.mission_count === 2, `got ${pwStatusBelow.mission_count}`);
  check('pw threshold NOT tripped (<5 receipts)', pwStatusBelow.threshold_tripped === false);
  check('pw state === inert', pwStatusBelow.state === 'inert', `got '${pwStatusBelow.state}'`);
  check(
    'pw missions sorted ASC',
    JSON.stringify(pwStatusBelow.missions) === JSON.stringify([MISSION_MISFITS, MISSION_ORANGE5]),
  );

  // -------------------------------------------------------------------------
  // 3. Idempotency: re-ingest same (candidate, receipt_id) — no double count
  // -------------------------------------------------------------------------
  console.log('3. idempotency on (candidate, receipt_id)');
  const dup = ingest(CANDIDATE_PATHWAVES, 'pw-r1', MISSION_ORANGE5, 'system:atomeons');
  check('duplicate ingest returns ok=true duplicate=true', dup.ok === true && dup.duplicate === true);
  const pwAfterDup = detector.candidateStatus(CANDIDATE_PATHWAVES, { dbPath: ws.dbPath });
  check('receipt_count unchanged after duplicate', pwAfterDup.receipt_count === 4);

  // -------------------------------------------------------------------------
  // 4. Mission-coherence guard: same receipt under a different mission is rejected
  // -------------------------------------------------------------------------
  console.log('4. mission-coherence guard');
  const conflict = detector.ingestReceiptReference({
    candidate: CANDIDATE_PATHWAVES,
    receiptId: 'pw-r1',
    missionId: MISSION_RECEIPTS,
    dbPath: ws.dbPath,
  });
  check('conflicting mission_id rejected', conflict.ok === false);
  check(
    'rejection mentions both mission ids',
    typeof conflict.error === 'string' &&
      conflict.error.includes(MISSION_ORANGE5) &&
      conflict.error.includes(MISSION_RECEIPTS),
    `actual error: ${conflict.error}`,
  );

  // -------------------------------------------------------------------------
  // 5. Tip into receipt-threshold state: add 5th receipt
  // -------------------------------------------------------------------------
  console.log('5. add 5th Pathwaves receipt — threshold trips');
  check('ingest pw-r5 ok', ingest(CANDIDATE_PATHWAVES, 'pw-r5', MISSION_MISFITS, 'operator:atom').ok === true);
  const pwTripped = detector.candidateStatus(CANDIDATE_PATHWAVES, { dbPath: ws.dbPath });
  check('pw receipt_count === 5', pwTripped.receipt_count === 5);
  check('pw threshold tripped', pwTripped.threshold_tripped === true);
  check('pw state === receipt', pwTripped.state === 'receipt');
  check('pw operator_promoted false', pwTripped.operator_promoted === false);

  // -------------------------------------------------------------------------
  // 6. Receipts concentrated in ONE mission must NOT trip (need >= 2 missions)
  // -------------------------------------------------------------------------
  console.log('6. single-mission concentration does NOT trip threshold');
  for (let i = 1; i <= 6; i++) {
    const r = ingest(CANDIDATE_NEON, `neon-r${i}`, MISSION_ORANGE5, 'system:atomeons');
    check(`ingest neon-r${i} ok`, r.ok === true);
  }
  const neonStatus = detector.candidateStatus(CANDIDATE_NEON, { dbPath: ws.dbPath });
  check('neon receipt_count === 6', neonStatus.receipt_count === 6);
  check('neon mission_count === 1', neonStatus.mission_count === 1);
  check('neon threshold NOT tripped (one mission)', neonStatus.threshold_tripped === false);
  check('neon state === inert', neonStatus.state === 'inert');

  // -------------------------------------------------------------------------
  // 7. Operator promotion path on a candidate with NO receipts at all
  // -------------------------------------------------------------------------
  console.log('7. operator promotion alone -> state=operator');
  const promoKS = detector.recordOperatorPromotion({
    candidate: CANDIDATE_KSTRATA,
    decision: 'promote',
    actor: 'operator:atom',
    rationale: 'Knowledge Strata is referenced across receipts, mission briefs, and runtime memory; promote.',
    dbPath: ws.dbPath,
  });
  check('promote KS ok', promoKS.ok === true && typeof promoKS.decision_id === 'string');
  const ksStatus = detector.candidateStatus(CANDIDATE_KSTRATA, { dbPath: ws.dbPath });
  check('KS receipt_count === 0', ksStatus.receipt_count === 0);
  check('KS operator_promoted true', ksStatus.operator_promoted === true);
  check('KS state === operator', ksStatus.state === 'operator');

  // -------------------------------------------------------------------------
  // 8. Operator promotion ON TOP of receipt threshold -> receipt+op
  // -------------------------------------------------------------------------
  console.log('8. operator promotion stacked on receipt threshold -> receipt+op');
  const promoPW = detector.recordOperatorPromotion({
    candidate: CANDIDATE_PATHWAVES,
    decision: 'promote',
    actor: 'operator:atom',
    rationale: 'Pathwaves is the canonical routing doctrine; promote to canon.',
    dbPath: ws.dbPath,
  });
  check('promote PW ok', promoPW.ok === true);
  const pwBoth = detector.candidateStatus(CANDIDATE_PATHWAVES, { dbPath: ws.dbPath });
  check('PW state === receipt+op', pwBoth.state === 'receipt+op');
  check('PW operator_promoted true', pwBoth.operator_promoted === true);

  // -------------------------------------------------------------------------
  // 9. Anti-fluff rationale rejection
  // -------------------------------------------------------------------------
  console.log('9. anti-fluff rationale rejected');
  const fluffy = detector.recordOperatorPromotion({
    candidate: 'FluffCandidate',
    decision: 'promote',
    actor: 'operator:atom',
    rationale: 'should_work',
    dbPath: ws.dbPath,
  });
  check('fluffy promotion rejected', fluffy.ok === false);
  check(
    'fluffy error names the offending token',
    typeof fluffy.error === 'string' && fluffy.error.includes('should_work'),
  );

  // -------------------------------------------------------------------------
  // 10. Reject decision overrides earlier promote
  // -------------------------------------------------------------------------
  console.log('10. later reject overrides earlier promote');
  const rejectKS = detector.recordOperatorPromotion({
    candidate: CANDIDATE_KSTRATA,
    decision: 'reject',
    actor: 'operator:atom',
    rationale: 'Pulled back to incubation — Knowledge Strata needs a stricter intake spec first.',
    dbPath: ws.dbPath,
    decidedAt: new Date(Date.now() + 1000).toISOString(),
  });
  check('reject KS ok', rejectKS.ok === true);
  const ksAfter = detector.candidateStatus(CANDIDATE_KSTRATA, { dbPath: ws.dbPath });
  check('KS operator_promoted now false (reject overrides)', ksAfter.operator_promoted === false);
  check('KS state back to inert', ksAfter.state === 'inert');
  check(
    'KS decision log preserves both decisions',
    ksAfter.operator_decisions.length === 2 &&
      ksAfter.operator_decisions[0].decision === 'promote' &&
      ksAfter.operator_decisions[1].decision === 'reject',
  );

  // -------------------------------------------------------------------------
  // 11. listPromotionCandidates ordering and inert exclusion
  // -------------------------------------------------------------------------
  console.log('11. listPromotionCandidates ordering');
  const promoList = detector.listPromotionCandidates({ dbPath: ws.dbPath });
  // Active non-inert at this point: PW(receipt+op). KS reverted to inert; Neon still inert.
  check('promoList length === 1', promoList.length === 1, `got ${promoList.length}`);
  check('promoList[0] is Pathwaves', promoList[0]?.candidate === CANDIDATE_PATHWAVES);
  check('promoList[0].state === receipt+op', promoList[0]?.state === 'receipt+op');

  const promoListAll = detector.listPromotionCandidates({ dbPath: ws.dbPath, includeInert: true });
  const names = promoListAll.map((c) => c.candidate);
  check('includeInert=true returns all 3 candidates', promoListAll.length === 3, `got ${promoListAll.length}`);
  check('includeInert includes Neon', names.includes(CANDIDATE_NEON));
  check('includeInert includes Knowledge Strata', names.includes(CANDIDATE_KSTRATA));
  check(
    'first in ordering is receipt+op',
    promoListAll[0]?.state === 'receipt+op',
  );

  // -------------------------------------------------------------------------
  // 12. pressureSummary honest accounting
  // -------------------------------------------------------------------------
  console.log('12. pressureSummary honest accounting');
  const sum = detector.pressureSummary({ dbPath: ws.dbPath });
  check('summary total_candidates === 3', sum.total_candidates === 3, `got ${sum.total_candidates}`);
  // 5 PW + 6 Neon = 11 receipts. KS has none.
  check('summary total_receipts === 11', sum.total_receipts === 11, `got ${sum.total_receipts}`);
  // Distinct missions across all references: orange5-build + misfits-frontier = 2.
  check('summary total_missions === 2', sum.total_missions === 2, `got ${sum.total_missions}`);
  check('summary states[receipt+op] === 1', sum.states['receipt+op'] === 1);
  check('summary states[receipt] === 0', sum.states.receipt === 0);
  check('summary states[operator] === 0', sum.states.operator === 0);
  check('summary states[inert] === 2', sum.states.inert === 2);
  check('summary thresholds echo PRESSURE_THRESHOLDS', sum.thresholds.MIN_RECEIPTS === 5 && sum.thresholds.MIN_MISSIONS === 2);
  check('summary schema discriminator', sum.schema === 'orange5.canon-pressure.v0');

  // -------------------------------------------------------------------------
  // 13. Input validation: bad inputs surface honestly
  // -------------------------------------------------------------------------
  console.log('13. input validation');
  check(
    'empty candidate rejected',
    detector.ingestReceiptReference({ candidate: '   ', receiptId: 'x', missionId: 'm', dbPath: ws.dbPath }).ok === false,
  );
  check(
    'missing receiptId rejected',
    detector.ingestReceiptReference({ candidate: 'X', receiptId: '', missionId: 'm', dbPath: ws.dbPath }).ok === false,
  );
  check(
    'bad decision value rejected',
    detector.recordOperatorPromotion({
      candidate: 'X',
      decision: 'maybe',
      actor: 'operator:atom',
      rationale: 'real',
      dbPath: ws.dbPath,
    }).ok === false,
  );

  // -------------------------------------------------------------------------
  // 14. Candidate normalization (whitespace collapse) without case merge
  // -------------------------------------------------------------------------
  console.log('14. normalization: whitespace collapses, case does not');
  check(
    'whitespace-padded candidate normalizes',
    detector.ingestReceiptReference({
      candidate: '  Pathwaves  ',
      receiptId: 'pw-r1',
      missionId: MISSION_ORANGE5,
      dbPath: ws.dbPath,
    }).duplicate === true,
  );
  // Different case = different candidate (intentional).
  check(
    'case-different candidate is its own row',
    detector.ingestReceiptReference({
      candidate: 'pathwaves',
      receiptId: 'pw-lc-r1',
      missionId: MISSION_ORANGE5,
      dbPath: ws.dbPath,
    }).ok === true,
  );
  const lcStatus = detector.candidateStatus('pathwaves', { dbPath: ws.dbPath });
  check('lowercase candidate has receipt_count === 1', lcStatus.receipt_count === 1);
  check('lowercase candidate state === inert', lcStatus.state === 'inert');

  // -------------------------------------------------------------------------
  // Done
  // -------------------------------------------------------------------------
  await cleanup(ws);
}

main()
  .catch((err) => {
    console.error(`smoke test crashed: ${err.stack || err.message}`);
    failed++;
  })
  .finally(() => {
    console.log('');
    if (failed === 0) {
      console.log('PASS — AtomSmasher canon-pressure end-to-end smoke green');
      process.exit(0);
    } else {
      console.log(`FAIL — ${failed} check(s) failed`);
      process.exit(1);
    }
  });
