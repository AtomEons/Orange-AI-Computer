// attestation-meter.mjs — metered billing where the LEDGER IS THE INVOICE.
//
// ── WHY THIS SHAPE ───────────────────────────────────────────────────────
// Per-call card charges are impossible at this price point. Stripe takes roughly
// $0.30 + 2.9% per transaction; a one-cent charge loses about thirty times its
// value. Every micropayment system that has ever worked does the same thing:
// meter fractions locally, settle in bulk.
//
// ── THE ACTUAL EDGE ──────────────────────────────────────────────────────
// Metering is a commodity. Stripe, AWS and a hundred SaaS vendors do it.
// What none of them can do is prove a disputed line item.
//
// Here the billable event and the hash-chained receipt are the SAME RECORD.
// A customer disputing usage is answered by replaying the chain: every charge
// resolves to a receipt, every receipt to a prev_hash, all the way to genesis.
// The invoice is not a claim about work performed — it IS the work, signed.
//
// That is a property a neutral instrument can offer and a model vendor cannot,
// because billing-neutrality requires being neutral about whose model ran.
//
// ── SCOPE BOUNDARY (deliberate) ──────────────────────────────────────────
// This module NEVER moves money, holds a key, or contacts a payment processor.
// It meters and exports. Connecting a live account is an operator action.

import { loadChain, buildTrajectory } from './trajectory.mjs';
import { createHash } from 'node:crypto';

export const METER_SCHEMA_ID = 'orange5.attestation-meter.v1';

// ─────────────────────────────────────────────────────────────────────────
// PRICE BOOK — fractional cents, so volume does not round to zero.
// Free tier exists to remove adoption friction: an evaluator must be able to
// prove the thing works before anyone asks finance for a purchase order.
// ─────────────────────────────────────────────────────────────────────────
export const PRICE_BOOK_V1 = Object.freeze({
  version: 'aecp-price-v1',
  currency: 'usd',
  freeTierPerMonth: 1000,
  units: {
    // the core unit: a claim crossed the gate and was scored
    attestation:        { milliCents: 100, label: 'epistemic attestation (claim scored + receipted)' },
    // a claim that was BLOCKED — priced the same. Refusing to certify is the
    // product. Charging less for a "no" would create an incentive to say yes.
    attestation_halted: { milliCents: 100, label: 'attestation refused (block, with reason)' },
    // multi-expert crossing costs more because it consumes a second opinion
    adversarial_pass:   { milliCents: 500, label: 'adversarial refute-pass (second expert)' },
    // replaying history under a corrected assumption is heavy and rare
    counterfactual_replay: { milliCents: 2000, label: 'counterfactual replay over a receipt window' },
    // answering a dispute: free. Charging to prove your own invoice is extortion.
    dispute_resolution: { milliCents: 0, label: 'dispute resolution by chain replay (never billed)' },
  },
  volumeDiscounts: [
    { fromUnits: 100000, multiplier: 0.8 },
    { fromUnits: 1000000, multiplier: 0.6 },
  ],
});

const MILLICENTS_PER_DOLLAR = 100000; // 1 dollar = 100 cents = 100000 millicents

/** Classify a receipt into a billable unit. Unbillable receipts return null. */
export function billableUnit(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  const action = String(receipt.action || '');
  // internal bookkeeping is never billed
  if (/^awe\.(receipt|campaign)\./.test(action)) return null;
  if (/dispute|replay\.audit/.test(action)) return 'dispute_resolution';
  if (/counterfactual|replay/.test(action)) return 'counterfactual_replay';
  if (receipt.status === 'halted' && receipt.epistemic_score != null) return 'attestation_halted';
  if (receipt.epistemic_score != null) return 'attestation';
  return null; // no epistemic evaluation happened -> nothing was attested -> no charge
}

/**
 * meterPeriod({ chain, accountId, fromSeq, toSeq, priceBook })
 * Produces an invoice in which every line resolves to a hash-linked receipt.
 */
export function meterPeriod({
  chain: injected, chainPath, accountId = 'self',
  fromSeq = 0, toSeq = Infinity, priceBook = PRICE_BOOK_V1,
  freeTierRemaining = null,
} = {}) {
  const chain = injected || loadChain(chainPath);
  const window = chain.filter(r => r.seq >= fromSeq && r.seq <= toSeq);

  const lines = [];
  const byUnit = {};
  let billableCount = 0;

  for (const r of window) {
    const unit = billableUnit(r);
    if (!unit) continue;
    const price = priceBook.units[unit];
    if (!price) continue;
    byUnit[unit] = (byUnit[unit] || 0) + 1;
    if (price.milliCents > 0) billableCount++;
    lines.push({
      seq: r.seq,
      receipt_id: r.receipt_id,
      hash: r.hash,          // <- the proof. dispute this line, replay this hash.
      action: r.action,
      unit,
      milliCents: price.milliCents,
      expert_id: r.expert_id ?? null,
      epistemic_score: r.epistemic_score ?? null,
    });
  }

  // free tier
  const freeAllowance = freeTierRemaining == null ? priceBook.freeTierPerMonth : freeTierRemaining;
  const freeApplied = Math.min(freeAllowance, billableCount);
  let charged = 0, freeUsed = 0;
  for (const l of lines) {
    if (l.milliCents === 0) { l.billed = 0; l.freeTier = false; continue; }
    if (freeUsed < freeApplied) { l.billed = 0; l.freeTier = true; freeUsed++; continue; }
    l.billed = l.milliCents; l.freeTier = false; charged += l.milliCents;
  }

  // volume discount on the charged remainder
  let multiplier = 1;
  for (const d of priceBook.volumeDiscounts) if (billableCount >= d.fromUnits) multiplier = d.multiplier;
  const discountedMilliCents = Math.round(charged * multiplier);

  const body = {
    schema: METER_SCHEMA_ID,
    priceBookVersion: priceBook.version,
    accountId,
    period: { fromSeq, toSeq: Number.isFinite(toSeq) ? toSeq : (window.at(-1)?.seq ?? fromSeq) },
    receiptsScanned: window.length,
    billableEvents: billableCount,
    freeTierApplied: freeUsed,
    byUnit,
    grossMilliCents: charged,
    volumeMultiplier: multiplier,
    netMilliCents: discountedMilliCents,
    netUsd: discountedMilliCents / MILLICENTS_PER_DOLLAR,
    currency: priceBook.currency,
    lines,
  };

  // The invoice is itself hashed and chainable. An invoice you can tamper with
  // is not evidence — and evidence is the entire product.
  const invoiceHash = createHash('sha256')
    .update(JSON.stringify({ ...body, lines: lines.map(l => l.hash) }))
    .digest('hex');

  return { ...body, invoiceHash, settlementRequired: discountedMilliCents > 0 };
}

/**
 * verifyInvoice(invoice, chain) — a customer, or their auditor, runs this.
 * Every line must resolve to a receipt whose hash matches, and the chain those
 * receipts sit in must be unbroken. Disputes end in arithmetic, not argument.
 */
export function verifyInvoice(invoice, { chain: injected, chainPath } = {}) {
  const chain = injected || loadChain(chainPath);
  const bySeq = new Map(chain.map(r => [r.seq, r]));
  const problems = [];
  let verified = 0;

  for (const line of invoice.lines || []) {
    const r = bySeq.get(line.seq);
    if (!r) { problems.push({ seq: line.seq, issue: 'NO_SUCH_RECEIPT', detail: 'billed for work with no receipt in the chain' }); continue; }
    if (r.hash !== line.hash) { problems.push({ seq: line.seq, issue: 'HASH_MISMATCH', detail: 'receipt was altered after billing, or the line was fabricated' }); continue; }
    const unit = billableUnit(r);
    if (unit !== line.unit) { problems.push({ seq: line.seq, issue: 'UNIT_MISCLASSIFIED', detail: `billed as ${line.unit}, receipt classifies as ${unit}` }); continue; }
    verified++;
  }

  // recompute the total independently — do not trust the stated figure
  const recomputed = (invoice.lines || []).reduce((s, l) => s + (l.billed ?? 0), 0);
  const expected = Math.round(recomputed * (invoice.volumeMultiplier ?? 1));
  if (expected !== invoice.netMilliCents) {
    problems.push({ issue: 'TOTAL_MISMATCH', detail: `lines sum to ${expected} millicents, invoice states ${invoice.netMilliCents}` });
  }

  // chain linkage across the billed window
  const seqs = (invoice.lines || []).map(l => l.seq).sort((a, b) => a - b);
  for (let i = 1; i < seqs.length; i++) {
    const prev = bySeq.get(seqs[i] - 1), cur = bySeq.get(seqs[i]);
    if (prev && cur && cur.prev_hash && cur.prev_hash !== prev.hash) {
      problems.push({ seq: seqs[i], issue: 'CHAIN_BREAK', detail: 'receipt chain broken across the billed window' });
    }
  }

  return {
    schema: METER_SCHEMA_ID,
    valid: problems.length === 0,
    linesVerified: verified,
    linesTotal: (invoice.lines || []).length,
    problems,
    verdict: problems.length === 0
      ? `all ${verified} billed lines resolve to unaltered hash-chained receipts`
      : `${problems.length} problem(s) — the customer is right to dispute`,
  };
}

/**
 * settlementExport(invoice, { format })
 * Emits an aggregated usage record for a processor. Aggregation is the point:
 * one settlement per period, not one charge per attestation.
 *
 * NO KEYS. NO NETWORK CALLS. NO MONEY MOVES. Operator connects the account.
 */
export function settlementExport(invoice, { format = 'generic' } = {}) {
  const common = {
    account: invoice.accountId,
    period: invoice.period,
    quantity: invoice.billableEvents,
    amount_usd: invoice.netUsd,
    amount_cents: Math.round(invoice.netMilliCents / 1000),
    currency: invoice.currency,
    invoice_hash: invoice.invoiceHash,   // dispute anchor travels with the charge
    price_book: invoice.priceBookVersion,
  };
  if (format === 'stripe_meter') {
    // Shape matching a usage-based billing meter event. The operator supplies
    // the meter name and customer id; nothing here authenticates or transmits.
    return {
      format, note: 'aggregated usage record — operator submits under their own credentials; this module never holds keys or contacts a processor',
      event: {
        event_name: 'aecp_attestation',
        payload: {
          stripe_customer_id: '<operator-supplied>',
          value: String(invoice.billableEvents),
          invoice_hash: invoice.invoiceHash,
        },
      },
      common,
    };
  }
  return { format: 'generic', common };
}

export const __meterInternals = Object.freeze({ MILLICENTS_PER_DOLLAR, billableUnit });
