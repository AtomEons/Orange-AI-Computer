// compression-debt/smoke-test.mjs
//
// AtomSmasher Compression Debt Ledger — END-TO-END smoke test.
//
// Exercises the LIVE round-trip:
//   recordDebt (Flux Reality lane + SQLite insert)
//     -> getDebt / listDebts re-reads
//       -> payDebt (Flux payment record + SQLite update)
//         -> debtSummary (honest accounting, regressions surfaced)
//           -> forgiveDebt (operator write-off, audit trail intact)
//
// Doctrine:
//   - Three debts are recorded across two surfaces, with realistic verbose
//     prose. One is paid with a real compression (positive savings), one is
//     paid with a "regression" (longer than the verbose form — kept honestly),
//     and one is forgiven (load-bearing verbose form on inspection).
//   - debt_id determinism is asserted: identical (verbose, surface, actor,
//     recorded_at) tuples yield the same debt_id and a duplicate=true flag
//     rather than minting a second row.
//   - debtSummary numbers are asserted against the inputs end-to-end.
//   - Pay-with-different-compression on an already-paid debt is rejected
//     (you cannot rewrite the receipt).
//
// Run with (must resolve better-sqlite3 — Orange5 has it under
// 06-CONTROL-PLANE/receipts/node_modules):
//   cd C:/AtomEons/Orange5/06-CONTROL-PLANE/receipts
//   node C:/AtomEons/Orange5/12-ATOMSMASHER/compression-debt/smoke-test.mjs
//
// Exits non-zero on any failure. No test framework dep.

import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as ledger from './ledger.mjs';

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
  const root = path.join(os.tmpdir(), `compression-debt-smoke-${ts}`);
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    fluxRoot: path.join(root, 'flux'),
    dbPath: path.join(root, 'compression-debt.db'),
  };
}

async function cleanup(ws) {
  try {
    // Close cached handles so Windows releases the WAL files before rm.
    ledger._closeAllForTests();
    await fsp.rm(ws.root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Test bodies — real prose, real measures, no theater
// ---------------------------------------------------------------------------

const VERBOSE_LEGAL = [
  'Pursuant to the terms and conditions set forth herein, the parties hereto',
  'do hereby acknowledge, covenant, and agree, by their execution below, that',
  'the foregoing recitals are true and correct in all material respects and',
  'are incorporated by reference into this Agreement as if fully set forth herein.',
].join(' ');

const COMPRESSED_LEGAL = 'The recitals above are true and part of this Agreement.';

const VERBOSE_PLAN = [
  'I am pleased to inform you that we have, after careful consideration and',
  'deliberation amongst the relevant stakeholders, arrived at the conclusion',
  'that the proposed initiative shall, in fact, proceed to the next phase of',
  'execution, contingent upon the satisfactory completion of preliminary tasks.',
].join(' ');

// Deliberately LONGER than the verbose form — the smoke test asserts that
// the ledger records this regression honestly rather than swallowing it.
const REGRESSED_PLAN =
  'After careful consideration and deliberation amongst the relevant stakeholders, ' +
  'we have arrived at the conclusion that the proposed initiative shall proceed ' +
  'to the next phase of execution, contingent upon the satisfactory completion ' +
  'of all preliminary tasks identified by the program management office. ' +
  'This decision was reached unanimously and is effective immediately.';

const VERBOSE_LOAD_BEARING =
  'Warning: do not remove the safety interlock; the device discharges 480 VAC ' +
  'into the chassis ground if the interlock is bypassed.';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const ws = mkWorkspace();
  console.log(`workspace: ${ws.root}`);

  console.log('0. ledger module sanity');
  assertExports(
    ledger,
    ['recordDebt', 'payDebt', 'forgiveDebt', 'getDebt', 'listDebts', 'debtSummary'],
    'ledger',
  );
  if (failed > 0) {
    console.log('aborting — ledger contract incomplete');
    return;
  }

  // -------------------------------------------------------------------------
  // 1. Record debt #1 — verbose legal boilerplate
  // -------------------------------------------------------------------------
  console.log('1. record legal-boilerplate debt');
  const r1 = ledger.recordDebt({
    verboseText: VERBOSE_LEGAL,
    context: {
      surface: 'cartridge:legal',
      actor: 'model:opus-4-7',
      ref: 'receipts/2026-06-24/contract-draft-001.md',
      reason: 'no codec for legal boilerplate yet',
    },
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
    recordedAt: '2026-06-24T10:00:00.000Z',
  });
  check('record #1 ok', r1.ok === true, JSON.stringify(r1));
  check('record #1 returned sha256 debt_id', /^[0-9a-f]{64}$/.test(r1.debt_id || ''));
  check(
    'record #1 flux_record_hash is sha256',
    typeof r1.flux_record_hash === 'string' && /^[a-f0-9]{64}$/.test(r1.flux_record_hash),
  );
  check('record #1 was NOT a duplicate', !r1.duplicate);

  // -------------------------------------------------------------------------
  // 1b. Idempotency — same tuple yields duplicate
  // -------------------------------------------------------------------------
  console.log('1b. recording same tuple again returns duplicate=true');
  const r1dup = ledger.recordDebt({
    verboseText: VERBOSE_LEGAL,
    context: {
      surface: 'cartridge:legal',
      actor: 'model:opus-4-7',
      // different ref/reason — should NOT affect identity
      ref: 'totally-different-ref',
      reason: 'changed reason',
    },
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
    recordedAt: '2026-06-24T10:00:00.000Z',
  });
  check('record #1 dup ok', r1dup.ok === true);
  check('record #1 dup flagged duplicate=true', r1dup.duplicate === true);
  check('record #1 dup returned same debt_id', r1dup.debt_id === r1.debt_id);

  // -------------------------------------------------------------------------
  // 2. Record debt #2 — verbose plan announcement
  // -------------------------------------------------------------------------
  console.log('2. record plan-announcement debt');
  const r2 = ledger.recordDebt({
    verboseText: VERBOSE_PLAN,
    context: {
      surface: 'pathwave:plan',
      actor: 'system:atomsmasher',
    },
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
    recordedAt: '2026-06-24T11:00:00.000Z',
  });
  check('record #2 ok', r2.ok === true, JSON.stringify(r2));
  check('record #2 distinct debt_id', r2.debt_id !== r1.debt_id);

  // -------------------------------------------------------------------------
  // 3. Record debt #3 — load-bearing safety warning (will be forgiven later)
  // -------------------------------------------------------------------------
  console.log('3. record load-bearing-safety debt');
  const r3 = ledger.recordDebt({
    verboseText: VERBOSE_LOAD_BEARING,
    context: {
      surface: 'manual:safety',
      actor: 'operator:atom',
      reason: 'safety-critical text, suspected un-compressible',
    },
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
    recordedAt: '2026-06-24T12:00:00.000Z',
  });
  check('record #3 ok', r3.ok === true, JSON.stringify(r3));

  // -------------------------------------------------------------------------
  // 4. getDebt round-trips
  // -------------------------------------------------------------------------
  console.log('4. getDebt returns the right entries');
  const e1 = ledger.getDebt(r1.debt_id, { dbPath: ws.dbPath });
  check('debt #1 retrievable', e1 != null);
  check('debt #1 status is open', e1?.status === 'open');
  check('debt #1 verbose_chars matches input', e1?.verbose_chars === VERBOSE_LEGAL.length);
  check('debt #1 has surface', e1?.context.surface === 'cartridge:legal');

  const e404 = ledger.getDebt('a'.repeat(64), { dbPath: ws.dbPath });
  check('unknown debt_id returns null', e404 === null);

  // -------------------------------------------------------------------------
  // 5. listDebts filters
  // -------------------------------------------------------------------------
  console.log('5. listDebts filters work');
  const allOpen = ledger.listDebts({ status: 'open', dbPath: ws.dbPath });
  check('all 3 debts listed as open', Array.isArray(allOpen) && allOpen.length === 3,
        `got ${allOpen?.length}`);

  const legalOnly = ledger.listDebts({ surface: 'cartridge:legal', dbPath: ws.dbPath });
  check('surface filter returns 1 debt', legalOnly.length === 1);
  check('surface filter returns the right debt', legalOnly[0]?.debt_id === r1.debt_id);

  const sinceMidday = ledger.listDebts({ since: '2026-06-24T11:00:00.000Z', dbPath: ws.dbPath });
  check('since filter returns 2 debts (11:00 + 12:00)', sinceMidday.length === 2);

  // -------------------------------------------------------------------------
  // 6. payDebt #1 with real compression (positive savings)
  // -------------------------------------------------------------------------
  console.log('6. pay debt #1 with real compression');
  const p1 = ledger.payDebt({
    debtId: r1.debt_id,
    compressedText: COMPRESSED_LEGAL,
    paymentEvidence: 'receipts/2026-06-24/legal-codec-pass-001.json',
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
    paidAt: '2026-06-24T13:00:00.000Z',
  });
  check('pay #1 ok', p1.ok === true, JSON.stringify(p1));
  const expectedSavings1 = VERBOSE_LEGAL.length - COMPRESSED_LEGAL.length;
  check(
    `pay #1 savings_chars === ${expectedSavings1}`,
    p1.savings_chars === expectedSavings1,
    `got ${p1.savings_chars}`,
  );
  check('pay #1 not a regression', p1.regression === false);

  const e1Paid = ledger.getDebt(r1.debt_id, { dbPath: ws.dbPath });
  check('debt #1 now status=paid', e1Paid?.status === 'paid');
  check('debt #1 has compressed_chars stamped', e1Paid?.compressed_chars === COMPRESSED_LEGAL.length);
  check('debt #1 has paid_at stamped', e1Paid?.paid_at === '2026-06-24T13:00:00.000Z');
  check('debt #1 has payment_evidence stamped', typeof e1Paid?.payment_evidence === 'string');

  // -------------------------------------------------------------------------
  // 6b. Re-paying #1 with SAME compression returns already=true
  // -------------------------------------------------------------------------
  console.log('6b. re-paying #1 with same compressed_hash is idempotent');
  const p1again = ledger.payDebt({
    debtId: r1.debt_id,
    compressedText: COMPRESSED_LEGAL,
    paymentEvidence: 'receipts/2026-06-24/legal-codec-pass-001.json',
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
  });
  check('re-pay #1 ok', p1again.ok === true);
  check('re-pay #1 flagged already=true', p1again.already === true);

  // -------------------------------------------------------------------------
  // 6c. Re-paying #1 with DIFFERENT compression is rejected
  // -------------------------------------------------------------------------
  console.log('6c. re-paying #1 with different compressed_hash is rejected');
  const p1bad = ledger.payDebt({
    debtId: r1.debt_id,
    compressedText: 'something else entirely',
    paymentEvidence: 'evidence',
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
  });
  check('mismatched re-pay rejected', p1bad.ok === false);
  check('mismatched re-pay surfaced existing hash', typeof p1bad.existing_compressed_hash === 'string');

  // -------------------------------------------------------------------------
  // 7. payDebt #2 with a REGRESSION (compressed form is longer)
  // -------------------------------------------------------------------------
  console.log('7. pay debt #2 with a regression (honest record kept)');
  const p2 = ledger.payDebt({
    debtId: r2.debt_id,
    compressedText: REGRESSED_PLAN,
    paymentEvidence: 'receipts/2026-06-24/plan-rewrite-001.json',
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
    paidAt: '2026-06-24T14:00:00.000Z',
  });
  check('pay #2 ok', p2.ok === true, JSON.stringify(p2));
  check('pay #2 flagged as regression', p2.regression === true);
  check('pay #2 savings_chars is negative', p2.savings_chars < 0,
        `got ${p2.savings_chars}`);

  // -------------------------------------------------------------------------
  // 8. forgiveDebt #3 — load-bearing verbose form
  // -------------------------------------------------------------------------
  console.log('8. forgive debt #3 with inspection receipt');
  const f3 = ledger.forgiveDebt({
    debtId: r3.debt_id,
    paymentEvidence: 'receipts/2026-06-24/safety-text-inspection.md',
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
    paidAt: '2026-06-24T15:00:00.000Z',
  });
  check('forgive #3 ok', f3.ok === true, JSON.stringify(f3));
  check('forgive #3 status is forgiven', f3.status === 'forgiven');

  const e3Forgiven = ledger.getDebt(r3.debt_id, { dbPath: ws.dbPath });
  check('debt #3 now status=forgiven', e3Forgiven?.status === 'forgiven');

  // Re-forgive is idempotent
  const f3again = ledger.forgiveDebt({
    debtId: r3.debt_id,
    paymentEvidence: 'same evidence',
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
  });
  check('re-forgive #3 ok', f3again.ok === true);
  check('re-forgive #3 already=true', f3again.already === true);

  // Forgiving a paid debt is rejected
  const fBad = ledger.forgiveDebt({
    debtId: r1.debt_id,
    paymentEvidence: 'evidence',
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
  });
  check('forgiving an already-paid debt rejected', fBad.ok === false);

  // -------------------------------------------------------------------------
  // 9. debtSummary — honest accounting
  // -------------------------------------------------------------------------
  console.log('9. debtSummary returns honest numbers');
  const summary = ledger.debtSummary({ dbPath: ws.dbPath });
  check('summary.total === 3', summary.total === 3, `got ${summary.total}`);
  check('summary.open_count === 0', summary.open_count === 0);
  check('summary.paid_count === 2', summary.paid_count === 2);
  check('summary.forgiven_count === 1', summary.forgiven_count === 1);
  check('summary.regression_count === 1', summary.regression_count === 1);
  check('summary.regression_chars < 0', summary.regression_chars < 0);
  // paid_savings_chars = (verbose1 - compressed1) + (verbose2 - regressed2);
  // the regression contributes a NEGATIVE number to the sum, which is honest.
  const expectedNet =
    (VERBOSE_LEGAL.length - COMPRESSED_LEGAL.length) +
    (VERBOSE_PLAN.length - REGRESSED_PLAN.length);
  check(
    `summary.paid_savings_chars === ${expectedNet} (net of regression)`,
    summary.paid_savings_chars === expectedNet,
    `got ${summary.paid_savings_chars}`,
  );
  check('summary.by_surface includes 3 surfaces', Array.isArray(summary.by_surface) && summary.by_surface.length === 3);

  // -------------------------------------------------------------------------
  // 10. Determinism — same verbose+surface+actor+ts yields same debt_id
  // -------------------------------------------------------------------------
  console.log('10. debt_id determinism');
  const det1 = ledger.__internals.computeDebtId({
    verbose_hash: ledger.__internals.sha256Hex('xyz'),
    recorded_at: '2026-06-24T00:00:00.000Z',
    context: { surface: 's', actor: 'a' },
  });
  const det2 = ledger.__internals.computeDebtId({
    verbose_hash: ledger.__internals.sha256Hex('xyz'),
    recorded_at: '2026-06-24T00:00:00.000Z',
    context: { surface: 's', actor: 'a' },
  });
  check('identical inputs -> identical debt_id', det1 === det2);
  const det3 = ledger.__internals.computeDebtId({
    verbose_hash: ledger.__internals.sha256Hex('xyz'),
    recorded_at: '2026-06-24T00:00:00.000Z',
    context: { surface: 's', actor: 'a-different' },
  });
  check('different actor -> different debt_id', det3 !== det1);

  // -------------------------------------------------------------------------
  // 11. Bad-input rejection
  // -------------------------------------------------------------------------
  console.log('11. bad-input rejection');
  const badEmpty = ledger.recordDebt({
    verboseText: '',
    context: { surface: 's', actor: 'a' },
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
  });
  check('empty verboseText rejected', badEmpty.ok === false);
  const badCtx = ledger.recordDebt({
    verboseText: 'hi',
    context: { surface: '', actor: 'a' },
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
  });
  check('empty surface rejected', badCtx.ok === false);
  const badPay = ledger.payDebt({
    debtId: 'not-sha256',
    compressedText: 'x',
    paymentEvidence: 'e',
    fluxRoot: ws.fluxRoot,
    dbPath: ws.dbPath,
  });
  check('non-sha256 debtId rejected on pay', badPay.ok === false);

  // -------------------------------------------------------------------------
  // 12. Flux Reality lane was actually written
  // -------------------------------------------------------------------------
  console.log('12. Flux Reality lane integrity');
  const realityDir = path.join(ws.fluxRoot, 'events', 'reality');
  const files = fs.existsSync(realityDir) ? fs.readdirSync(realityDir) : [];
  check('reality lane has at least one jsonl file', files.length >= 1);
  if (files.length >= 1) {
    const lines = fs.readFileSync(path.join(realityDir, files[0]), 'utf8')
      .split('\n').filter(Boolean);
    // 3 record events + 2 payments + 1 forgiveness = 6 events minimum
    check('reality lane has >= 6 events', lines.length >= 6, `got ${lines.length}`);
    const kinds = lines.map((l) => JSON.parse(l).kind);
    check('reality has compression-debt records', kinds.includes('compression-debt'));
    check('reality has compression-debt-payment records', kinds.includes('compression-debt-payment'));
    check('reality has compression-debt-forgiveness records', kinds.includes('compression-debt-forgiveness'));
    // Chain check: every record's prev_hash points to the prior record's hash
    let prior = null;
    let chainOk = true;
    for (const line of lines) {
      const rec = JSON.parse(line);
      if (prior && rec.prev_hash !== prior.hash) { chainOk = false; break; }
      prior = rec;
    }
    check('flux hash-chain links across all events', chainOk);
  }

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
      console.log('PASS — AtomSmasher compression-debt end-to-end smoke green');
      process.exit(0);
    } else {
      console.log(`FAIL — ${failed} check(s) failed`);
      process.exit(1);
    }
  });
