// attestation-meter.test.mjs
//
// The tests that matter here are the ones run from the CUSTOMER's side.
// Anyone can build a meter that adds up its own numbers. The product claim is
// that a customer can independently DISPROVE a bad invoice — so the suite is
// written adversarially: fabricate lines, tamper with receipts, inflate totals,
// break the chain, and require that each is caught.
//
// Run: bun 10-RECEIPTS/tools/tests/attestation-meter.test.mjs

import { meterPeriod, verifyInvoice, settlementExport, billableUnit, PRICE_BOOK_V1 } from '../attestation-meter.mjs';
import { loadChain } from '../trajectory.mjs';

let pass = 0, fail = 0;
function t(n, f) { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m); }

console.log('\nAttestation meter — the ledger is the invoice\n');

const FIX = [
  { seq: 0, receipt_id: 'r0', hash: 'h0', action: 'verify.claim', status: 'ok', epistemic_score: 0.9, expert_id: 'opus' },
  { seq: 1, receipt_id: 'r1', hash: 'h1', prev_hash: 'h0', action: 'verify.claim', status: 'halted', epistemic_score: 0.4, expert_id: 'opus' },
  { seq: 2, receipt_id: 'r2', hash: 'h2', prev_hash: 'h1', action: 'read.status', status: 'ok' },              // no attestation -> free
  { seq: 3, receipt_id: 'r3', hash: 'h3', prev_hash: 'h2', action: 'counterfactual.replay', status: 'ok', epistemic_score: 1.0 },
  { seq: 4, receipt_id: 'r4', hash: 'h4', prev_hash: 'h3', action: 'awe.receipt.relabel', status: 'ok', epistemic_score: 1.0 }, // internal -> free
];

// ── CLASSIFICATION ───────────────────────────────────────────────────────
t('an unattested action is not billable — no evaluation, no charge', () => {
  assert(billableUnit(FIX[2]) === null, 'read.status must not bill');
});

t('internal bookkeeping is never billed', () => {
  assert(billableUnit(FIX[4]) === null, 'awe.receipt.* must not bill');
});

t('a REFUSED attestation bills the same as an accepted one', () => {
  assert(billableUnit(FIX[1]) === 'attestation_halted', 'halt must classify');
  const a = PRICE_BOOK_V1.units.attestation.milliCents;
  const h = PRICE_BOOK_V1.units.attestation_halted.milliCents;
  assert(a === h, 'pricing a refusal lower creates an incentive to say yes — must be equal');
});

t('dispute resolution is free — never charge to prove your own invoice', () => {
  assert(PRICE_BOOK_V1.units.dispute_resolution.milliCents === 0, 'must be zero');
});

// ── METERING ─────────────────────────────────────────────────────────────
t('meters only attested work', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  assert(inv.billableEvents === 3, `expected 3 billable, got ${inv.billableEvents}`);
  assert(inv.lines.length === 3, `expected 3 lines, got ${inv.lines.length}`);
});

t('free tier zeroes the charge but still itemises the work', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 100 });
  assert(inv.netMilliCents === 0, `free tier should bill 0, got ${inv.netMilliCents}`);
  assert(inv.lines.length === 3, 'work is still recorded');
  assert(inv.lines.every(l => l.billed === 0), 'all lines free');
});

t('fractional pricing does not round to zero at low volume', () => {
  // Attestations are sub-penny by design; a heavy counterfactual replay is not,
  // and should not be. Assert per-unit, not on a mixed basket.
  const attestationOnly = FIX.filter(r => r.seq === 0 || r.seq === 1);
  const inv = meterPeriod({ chain: attestationOnly, freeTierRemaining: 0 });
  assert(inv.netMilliCents > 0, 'must accrue rather than round away');
  assert(inv.netUsd < 0.01, `two attestations must stay sub-penny, got $${inv.netUsd}`);
  // and the heavy unit is deliberately priced far above a penny
  assert(PRICE_BOOK_V1.units.counterfactual_replay.milliCents > 1000,
    'replay is expensive work and must not be priced as if it were an attestation');
});

t('every line carries its receipt hash — the dispute anchor', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  assert(inv.lines.every(l => typeof l.hash === 'string' && l.hash.length > 0), 'each line needs a hash');
});

t('the invoice itself is hashed', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  assert(typeof inv.invoiceHash === 'string' && inv.invoiceHash.length === 64, 'invoice must be tamper-evident');
});

// ── THE CUSTOMER'S SIDE — adversarial ────────────────────────────────────
t('an honest invoice verifies', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  const v = verifyInvoice(inv, { chain: FIX });
  assert(v.valid === true, `honest invoice must verify: ${JSON.stringify(v.problems)}`);
  assert(v.linesVerified === 3, `verified ${v.linesVerified}`);
});

t('CUSTOMER CATCHES: a fabricated line with no receipt', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  inv.lines.push({ seq: 999, receipt_id: 'ghost', hash: 'fake', action: 'verify.claim', unit: 'attestation', milliCents: 100, billed: 100 });
  const v = verifyInvoice(inv, { chain: FIX });
  assert(v.valid === false, 'must reject');
  assert(v.problems.some(p => p.issue === 'NO_SUCH_RECEIPT'), `problems: ${JSON.stringify(v.problems)}`);
});

t('CUSTOMER CATCHES: a receipt altered after billing', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  const tampered = FIX.map(r => (r.seq === 0 ? { ...r, hash: 'h0-ALTERED' } : r));
  const v = verifyInvoice(inv, { chain: tampered });
  assert(v.valid === false, 'must reject');
  assert(v.problems.some(p => p.issue === 'HASH_MISMATCH'), `problems: ${JSON.stringify(v.problems)}`);
});

t('CUSTOMER CATCHES: an inflated total that the lines do not support', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  inv.netMilliCents = inv.netMilliCents * 10;
  const v = verifyInvoice(inv, { chain: FIX });
  assert(v.valid === false, 'must reject');
  assert(v.problems.some(p => p.issue === 'TOTAL_MISMATCH'), `problems: ${JSON.stringify(v.problems)}`);
});

t('CUSTOMER CATCHES: unbillable work billed as an attestation', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  inv.lines.push({ seq: 2, receipt_id: 'r2', hash: 'h2', action: 'read.status', unit: 'attestation', milliCents: 100, billed: 100 });
  inv.netMilliCents += 100;
  const v = verifyInvoice(inv, { chain: FIX });
  assert(v.valid === false, 'must reject');
  assert(v.problems.some(p => p.issue === 'UNIT_MISCLASSIFIED'), `problems: ${JSON.stringify(v.problems)}`);
});

t('CUSTOMER CATCHES: a broken chain across the billed window', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  const broken = FIX.map(r => (r.seq === 1 ? { ...r, prev_hash: 'WRONG' } : r));
  const v = verifyInvoice(inv, { chain: broken });
  assert(v.valid === false, 'must reject');
  assert(v.problems.some(p => p.issue === 'CHAIN_BREAK'), `problems: ${JSON.stringify(v.problems)}`);
});

t('the verdict tells the customer plainly they are right to dispute', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  inv.netMilliCents *= 5;
  const v = verifyInvoice(inv, { chain: FIX });
  assert(/right to dispute/.test(v.verdict), `verdict: ${v.verdict}`);
});

// ── SETTLEMENT — aggregate, never per-call ───────────────────────────────
t('settlement is ONE aggregated record, not one charge per event', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  const s = settlementExport(inv, { format: 'stripe_meter' });
  assert(s.event.payload.value === String(inv.billableEvents), 'quantity aggregated');
  assert(s.common.amount_usd === inv.netUsd, 'amount aggregated');
});

t('the settlement carries the invoice hash so disputes survive the handoff', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  const s = settlementExport(inv, { format: 'stripe_meter' });
  assert(s.event.payload.invoice_hash === inv.invoiceHash, 'anchor must travel with the charge');
});

t('the module holds no keys and contacts no processor', () => {
  const inv = meterPeriod({ chain: FIX, freeTierRemaining: 0 });
  const s = settlementExport(inv, { format: 'stripe_meter' });
  assert(/never holds keys/.test(s.note), 'boundary must be stated in the export itself');
  assert(s.event.payload.stripe_customer_id === '<operator-supplied>', 'customer id is not ours to invent');
});

// ── AGAINST THE REAL CHAIN ───────────────────────────────────────────────
t('meters the live chain and the live invoice self-verifies', () => {
  const chain = loadChain();
  const inv = meterPeriod({ chain, accountId: 'atomeons-self', freeTierRemaining: 0 });
  assert(inv.receiptsScanned === chain.length, 'must scan all');
  const v = verifyInvoice(inv, { chain });
  assert(v.valid === true, `live invoice must verify: ${JSON.stringify(v.problems?.slice(0, 3))}`);
  console.log(`        (live chain: ${chain.length} receipts, ${inv.billableEvents} billable, $${inv.netUsd.toFixed(5)} at list)`);
});

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${pass + fail}\n`);
if (fail > 0) process.exit(1);
