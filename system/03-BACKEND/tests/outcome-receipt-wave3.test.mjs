import { describe, expect, test } from 'bun:test';

import {
  OutcomeReceiptSession,
  TERMINAL_OUTCOMES,
  sha256Canonical,
  verifyOutcomeReceipt,
} from '../outcome-receipt.mjs';
import { normalizePartyLineEvent } from '../../04-CONTROL-PLANE/party-line/ledger.mjs';

function activationBitset(activeMechanismIds) {
  const active = new Set(activeMechanismIds);
  const bits = Array.from({ length: 100 }, (_, index) => (
    active.has(`W3K-${String(index + 1).padStart(3, '0')}`) ? '1' : '0'
  )).join('');
  return bits.match(/.{4}/g)
    .map((nibble) => Number.parseInt(nibble, 2).toString(16))
    .join('');
}

const activeMechanismIds = Object.freeze([
  'W3K-001',
  'W3K-061',
  'W3K-077',
  'W3K-087',
  'W3K-100',
]);
const wave3Kernel = Object.freeze({
  activationBitset: activationBitset(activeMechanismIds),
  manifestHash: 'a'.repeat(64),
  worksetHash: 'b'.repeat(64),
  activeMechanismIds,
});

function identity(id, hashCharacter) {
  return { id, implementation_sha256: hashCharacter.repeat(64) };
}

function receiptInput() {
  const state = { content_sha256: 'c'.repeat(64), size: 12 };
  const request = {
    request_id: 'request:wave3-outcome',
    domain: 'artifact',
    target: 'artifact://wave3-outcome',
    expected_state: state,
    expected_state_sha256: sha256Canonical(state),
    expected_artifact_sha256: state.content_sha256,
  };
  const observedEffect = {
    request_id: request.request_id,
    target: request.target,
    state,
    state_sha256: request.expected_state_sha256,
    artifact_sha256: state.content_sha256,
    observed_at_ms: 3,
    observer_identity: identity('observer:wave3', 'd'),
  };
  return {
    receipt_id: 'outcome-receipt:wave3-propagation',
    issued_at: '2026-08-28T12:00:00.000Z',
    wave3_kernel: wave3Kernel,
    request,
    authorization: {
      granted: true,
      request_id: request.request_id,
      authorization_id: 'authorization:wave3-outcome',
      principal: { id: 'operator' },
      scope_sha256: sha256Canonical({
        domain: request.domain,
        expected_state_sha256: request.expected_state_sha256,
        target: request.target,
      }),
      authorized_at_ms: 1,
    },
    executor_attestation: {
      identity: identity('executor:wave3', 'e'),
      request_id: request.request_id,
      authorization_id: 'authorization:wave3-outcome',
      claimed_success: true,
      claimed_state_sha256: request.expected_state_sha256,
      completed_at_ms: 2,
    },
    observed_effect: observedEffect,
    independent_verifier: {
      identity: identity('verifier:wave3', 'f'),
      request_id: request.request_id,
      observed_effect_sha256: sha256Canonical(observedEffect),
      oracle_state_sha256: request.expected_state_sha256,
      effect_satisfied: true,
      verified_at_ms: 5,
    },
    limitations: ['Wave 3 propagation fixture only.'],
    public_claim: {
      claim_id: 'claim:wave3-outcome',
      request_id: request.request_id,
      statement: 'The bounded Wave 3 outcome is proven.',
      limitations: ['Wave 3 propagation fixture only.'],
    },
    max_observation_age_ms: 10,
    oracle: {
      identity: identity('oracle:wave3', '1'),
      request_id: request.request_id,
      target: request.target,
      state,
      state_sha256: request.expected_state_sha256,
      artifact_sha256: state.content_sha256,
      captured_at_ms: 4,
    },
  };
}

function rehash(record) {
  const rehashed = structuredClone(record);
  const unsigned = structuredClone(rehashed);
  delete unsigned.chain.receipt_hash;
  rehashed.chain.receipt_hash = sha256Canonical(unsigned);
  return rehashed;
}

describe('outcome receipt Wave 3 kernel propagation', () => {
  test('seals all four summary fields and independently binds them into the receipt', () => {
    const input = receiptInput();
    const session = new OutcomeReceiptSession(input);
    session.proposeTerminal(TERMINAL_OUTCOMES.PROVEN);
    const receipt = session.seal({ oracle: input.oracle });

    expect(receipt.wave3Kernel).toEqual(wave3Kernel);
    expect(receipt.binding_hashes.wave3_kernel_sha256).toBe(sha256Canonical(wave3Kernel));
    expect(receipt.terminal_outcome).toBe(TERMINAL_OUTCOMES.PROVEN);
    expect(verifyOutcomeReceipt(receipt)).toEqual({ ok: true, errors: [] });

    const partyLineEvent = normalizePartyLineEvent({
      actor: { id: 'outcome-receipt', kind: 'system' },
      eventType: 'receipt',
      summary: 'Wave 3 outcome receipt sealed',
      detail: { receipt },
    }, { now: '2026-08-28T12:00:01.000Z' });
    expect(partyLineEvent.wave3Kernel).toEqual(wave3Kernel);
  });

  test('detects a rehashed receipt whose active IDs disagree with its activation bitset', () => {
    const input = receiptInput();
    const session = new OutcomeReceiptSession(input);
    session.proposeTerminal(TERMINAL_OUTCOMES.PROVEN);
    const receipt = session.seal({ oracle: input.oracle });
    const tampered = structuredClone(receipt);
    tampered.wave3Kernel.activeMechanismIds.pop();

    const verification = verifyOutcomeReceipt(rehash(tampered));
    expect(verification.ok).toBe(false);
    expect(verification.errors).toContain('WAVE3_KERNEL_ACTIVATION_MISMATCH');
  });

  test('keeps receipts without a Wave 3 summary backward compatible', () => {
    const input = receiptInput();
    delete input.wave3_kernel;
    const session = new OutcomeReceiptSession(input);
    session.proposeTerminal(TERMINAL_OUTCOMES.PROVEN);
    const receipt = session.seal({ oracle: input.oracle });

    expect(Object.hasOwn(receipt, 'wave3Kernel')).toBe(false);
    expect(Object.hasOwn(receipt.binding_hashes, 'wave3_kernel_sha256')).toBe(false);
    expect(verifyOutcomeReceipt(receipt)).toEqual({ ok: true, errors: [] });
  });
});
