#!/usr/bin/env bun
import { beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTCOME_ALPHA_PROOF_SCHEMA,
  OUTCOME_RECEIPT_MODE,
  OUTCOME_RECEIPT_SCHEMA,
  OutcomeReceiptError,
  OutcomeReceiptSession,
  RECEIPT_GENESIS,
  TERMINAL_OUTCOMES,
  canonicalJson,
  countTerminalOutcomes,
  sha256Canonical,
  verifyCanonicalRecord,
  verifyOutcomeReceipt,
} from '../outcome-receipt.mjs';
import {
  OUTCOME_ALPHA_DOMAINS,
  OUTCOME_ALPHA_SCENARIOS,
  runOutcomeReceiptAlphaProof,
} from '../outcome-receipt-proof.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXED_PROOF_TIME = '2026-08-28T12:00:00.000Z';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REQUIRED_REFUSAL = Object.freeze({
  'false-executor-success': 'EXECUTOR_ORACLE_DISAGREEMENT',
  'stale-observation': 'STALE_OBSERVATION',
  'partial-write': 'ORACLE_EFFECT_NOT_SATISFIED',
  'verifier-disagreement': 'VERIFIER_ORACLE_DISAGREEMENT',
  'missing-identity': 'VERIFIER_IDENTITY_MISSING',
  'duplicate-terminal-attempt': 'DUPLICATE_TERMINAL_ATTEMPT',
  'limitation-omission': 'LIMITATIONS_NOT_CARRIED',
});

let proof;

beforeAll(async () => {
  proof = await runOutcomeReceiptAlphaProof({ generatedAt: FIXED_PROOF_TIME });
}, 30_000);

function receiptsForScenario(scenario) {
  return proof.caseReceipts.filter((receipt) => receipt.receipt_id.endsWith(`-${scenario}`));
}

function rehash(record) {
  const clone = structuredClone(record);
  delete clone.chain.receipt_hash;
  clone.chain.receipt_hash = sha256Canonical(clone);
  return clone;
}

describe('ranked alpha 3 outcome receipts', () => {
  test('canonicalizes structured data and rejects non-canonical values', () => {
    const left = { z: [3, { b: true, a: 'x' }], a: 1 };
    const right = { a: 1, z: [3, { a: 'x', b: true }] };
    expect(canonicalJson(left)).toBe('{"a":1,"z":[3,{"a":"x","b":true}]}');
    expect(sha256Canonical(left)).toBe(sha256Canonical(right));
    expect(() => canonicalJson({ invalid: undefined })).toThrow(OutcomeReceiptError);
    expect(() => canonicalJson({ invalid: Number.POSITIVE_INFINITY })).toThrow('non-finite number');
  });

  test('runs 32 deterministic cases across file, process, HTTP, and artifact outcomes', () => {
    expect(proof.ok).toBe(true);
    expect(proof.cases).toHaveLength(32);
    expect(proof.caseReceipts).toHaveLength(32);
    expect(proof.receipt.schema).toBe(OUTCOME_ALPHA_PROOF_SCHEMA);
    expect(proof.receipt.mode).toBe(OUTCOME_RECEIPT_MODE);
    expect(proof.receipt.production_wired).toBe(false);
    expect(proof.receipt.observed_effect.total_case_count).toBe(32);
    expect(proof.receipt.observed_effect.false_proven_count).toBe(0);
    expect(proof.receipt.observed_effect.mismatch_proven_count).toBe(0);
    for (const domain of OUTCOME_ALPHA_DOMAINS) {
      expect(proof.receipt.observed_effect.domain_counts[domain]).toBe(8);
    }
    for (const scenario of OUTCOME_ALPHA_SCENARIOS) {
      expect(proof.receipt.observed_effect.scenario_counts[scenario]).toBe(4);
    }
  });

  test('replays to the same case-chain head and canonical aggregate hash', async () => {
    const replay = await runOutcomeReceiptAlphaProof({ generatedAt: FIXED_PROOF_TIME });
    expect(replay.ok).toBe(true);
    expect(replay.receipt.chain.previous_receipt_hash)
      .toBe(proof.receipt.chain.previous_receipt_hash);
    expect(replay.receipt.artifact_state_hashes.case_index_sha256)
      .toBe(proof.receipt.artifact_state_hashes.case_index_sha256);
    expect(replay.receipt.chain.receipt_hash).toBe(proof.receipt.chain.receipt_hash);
    expect(replay.canonical).toBe(proof.canonical);
  }, 30_000);

  test('lets the independent oracle refuse every false-success and mismatch path', () => {
    for (const scenario of OUTCOME_ALPHA_SCENARIOS) {
      const receipts = receiptsForScenario(scenario);
      expect(receipts).toHaveLength(4);
      for (const receipt of receipts) {
        if (scenario === 'happy-path') {
          expect(receipt.terminal_outcome).toBe(TERMINAL_OUTCOMES.PROVEN);
          expect(receipt.verification.refusal_codes).toEqual([]);
          continue;
        }
        expect(receipt.terminal_outcome).toBe(TERMINAL_OUTCOMES.REFUSED);
        expect(receipt.verification.refusal_codes).toContain(REQUIRED_REFUSAL[scenario]);
      }
    }

    for (const receipt of proof.caseReceipts) {
      if (receipt.verification.refusal_codes.length > 0) {
        expect(receipt.terminal_outcome).not.toBe(TERMINAL_OUTCOMES.PROVEN);
      }
    }
  });

  test('binds every required component and verifies the complete SHA-256 chain', () => {
    let previousReceiptHash = RECEIPT_GENESIS;
    for (const receipt of proof.caseReceipts) {
      expect(receipt.schema).toBe(OUTCOME_RECEIPT_SCHEMA);
      expect(receipt.request.request_id).toBe(receipt.authorization.request_id);
      expect(receipt.executor_attestation.request_id).toBe(receipt.request.request_id);
      expect(receipt.observed_effect.request_id).toBe(receipt.request.request_id);
      expect(receipt.independent_verifier.request_id).toBe(receipt.request.request_id);
      expect(receipt.independent_oracle.request_id).toBe(receipt.request.request_id);
      expect(receipt.independent_verifier.identity?.id ?? null)
        .not.toBe(receipt.executor_attestation.identity.id);
      expect(receipt.public_claim.limitations).toEqual(receipt.limitations);
      expect(Object.values(receipt.binding_hashes).every((hash) => HASH_PATTERN.test(hash))).toBe(true);
      expect(HASH_PATTERN.test(receipt.artifact_state_hashes.expected_state_sha256)).toBe(true);
      expect(HASH_PATTERN.test(receipt.artifact_state_hashes.observed_state_sha256)).toBe(true);
      expect(HASH_PATTERN.test(receipt.artifact_state_hashes.oracle_state_sha256)).toBe(true);
      expect(verifyOutcomeReceipt(receipt, { expectedPreviousReceiptHash: previousReceiptHash }))
        .toEqual({ ok: true, errors: [] });
      previousReceiptHash = receipt.chain.receipt_hash;
    }
    expect(proof.receipt.chain.previous_receipt_hash).toBe(previousReceiptHash);
    expect(verifyCanonicalRecord(proof.receipt, { expectedPreviousReceiptHash: previousReceiptHash }))
      .toEqual({ ok: true, errors: [] });
  });

  test('emits exactly one terminal outcome and permanently closes a sealed session', () => {
    for (const receipt of proof.caseReceipts) expect(countTerminalOutcomes(receipt)).toBe(1);
    expect(countTerminalOutcomes(proof.receipt)).toBe(1);

    const happy = receiptsForScenario('happy-path')[0];
    const session = new OutcomeReceiptSession({
      authorization: happy.authorization,
      executor_attestation: happy.executor_attestation,
      independent_verifier: happy.independent_verifier,
      issued_at: happy.issued_at,
      limitations: happy.limitations,
      max_observation_age_ms: happy.max_observation_age_ms,
      observed_effect: happy.observed_effect,
      public_claim: happy.claim_submission,
      receipt_id: 'outcome-receipt:post-seal-guard',
      request: happy.request,
    });
    session.proposeTerminal(TERMINAL_OUTCOMES.PROVEN);
    const sealed = session.seal({ oracle: happy.independent_oracle });
    expect(countTerminalOutcomes(sealed)).toBe(1);
    try {
      session.proposeTerminal(TERMINAL_OUTCOMES.PROVEN);
      throw new Error('post-seal terminal proposal unexpectedly succeeded');
    } catch (error) {
      expect(error).toBeInstanceOf(OutcomeReceiptError);
      expect(error.code).toBe('RECEIPT_ALREADY_SEALED');
    }
  });

  test('rejects byte tampering and semantic forgery even after an attacker recomputes the hash', () => {
    const partial = structuredClone(receiptsForScenario('partial-write')[0]);
    partial.request.target = 'file://tampered';
    expect(verifyOutcomeReceipt(partial).errors).toContain('RECEIPT_HASH_MISMATCH');

    const forged = structuredClone(receiptsForScenario('partial-write')[0]);
    forged.terminal_outcome = TERMINAL_OUTCOMES.PROVEN;
    const rehashedForgery = rehash(forged);
    const semanticResult = verifyOutcomeReceipt(rehashedForgery);
    expect(semanticResult.errors).not.toContain('RECEIPT_HASH_MISMATCH');
    expect(semanticResult.errors).toContain('TERMINAL_OUTCOME_MISMATCH');

    const duplicateTerminal = structuredClone(receiptsForScenario('happy-path')[0]);
    duplicateTerminal.public_claim.terminal_outcome = TERMINAL_OUTCOMES.PROVEN;
    const cardinalityResult = verifyOutcomeReceipt(rehash(duplicateTerminal));
    expect(cardinalityResult.errors).toContain('TERMINAL_OUTCOME_CARDINALITY');
  });

  test('proof CLI emits one canonical hash-chained alpha receipt and no production wiring', () => {
    const child = Bun.spawnSync(['bun', '03-BACKEND/outcome-receipt-proof.mjs'], {
      cwd: ROOT,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const stderr = child.stderr.toString('utf8').trim();
    const output = child.stdout.toString('utf8').trim();
    expect(child.exitCode, stderr).toBe(0);
    const receipt = JSON.parse(output);
    expect(output).toBe(canonicalJson(receipt));
    expect(receipt.schema).toBe(OUTCOME_ALPHA_PROOF_SCHEMA);
    expect(receipt.production_wired).toBe(false);
    expect(receipt.observed_effect.total_case_count).toBe(32);
    expect(receipt.terminal_outcome).toBe(TERMINAL_OUTCOMES.PROVEN);
    expect(countTerminalOutcomes(receipt)).toBe(1);
    expect(verifyCanonicalRecord(receipt).ok).toBe(true);
  }, 30_000);
});
