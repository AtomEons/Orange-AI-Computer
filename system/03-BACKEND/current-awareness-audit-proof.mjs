#!/usr/bin/env bun
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';
import { readCurrentAwareness } from './current-awareness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_ROOT = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const TESTS = [
  '03-BACKEND/tests/research-capabilities.test.mjs',
  '03-BACKEND/tests/current-awareness.test.mjs',
];
const SOURCE_FILES = [
  '03-BACKEND/current-awareness.mjs',
  '03-BACKEND/research-capabilities.mjs',
  '03-BACKEND/research-capabilities-cli.mjs',
  '03-BACKEND/current-awareness-audit-proof.mjs',
  ...TESTS,
];

export function runCurrentAwarenessAuditProof() {
  const testRun = Bun.spawnSync([process.execPath, 'test', ...TESTS], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const testOutput = `${testRun.stdout.toString()}\n${testRun.stderr.toString()}`.trim();
  const passCount = Number(testOutput.match(/\b(\d+) pass\b/)?.[1] || 0);
  const failCount = Number(testOutput.match(/\b(\d+) fail\b/)?.[1] || 0);
  const awareness = readCurrentAwareness();
  const latest = awareness.latest;
  const packetHashValid = validCanonicalHash(latest);
  const artifact = latest?.evidenceArtifactPath ? readJson(latest.evidenceArtifactPath) : null;
  const artifactHashValid = validJsonPayloadHash(artifact);
  const staleCandidates = (latest?.candidates || []).filter((candidate) => candidate.staleSource);
  const checks = {
    focused_tests_passed: testRun.exitCode === 0 && passCount >= 1 && failCount === 0,
    live_current_awareness_ready: awareness.ready === true && awareness.degraded === false,
    live_packet_hash_valid: packetHashValid,
    live_artifact_hash_valid: artifactHashValid,
    all_live_candidates_quarantined: (latest?.candidates || []).length > 0
      && latest.candidates.every((candidate) => candidate.promotionEligible === false && candidate.quarantineStatus === 'QUARANTINED'),
    stale_sources_require_refresh: staleCandidates.length === 0
      || staleCandidates.every((candidate) => candidate.lifecycle === 'SOURCE_REFRESH_REQUIRED'),
    no_invalid_decisions: awareness.invalidDecisionCount === 0,
  };
  const green = Object.values(checks).every(Boolean);
  const generatedAt = new Date().toISOString();
  const receipt = {
    schema: 'orange5.current-awareness-audit.v1',
    status: green ? 'CURRENT_AWARENESS_AUDIT_GREEN' : 'CURRENT_AWARENESS_AUDIT_NEEDS_WORK',
    generated_at: generatedAt,
    scope: 'Board 7 current-awareness and research-owned backend files only',
    checks,
    focused_tests: {
      command: [process.execPath, 'test', ...TESTS],
      exit_code: testRun.exitCode,
      pass_count: passCount,
      fail_count: failCount,
      output_sha256: sha256(testOutput),
    },
    live_scout: latest ? {
      generated_at: latest.generatedAt,
      budget_ms: latest.budgetMs,
      elapsed_ms: latest.elapsedMs,
      source_count: latest.sourceCount,
      current_source_count: latest.currentSourceCount,
      stale_source_count: latest.staleSourceCount,
      promotion_eligible_count: latest.candidates.filter((candidate) => candidate.promotionEligible).length,
      packet_sha256: latest.sha256,
      evidence_artifact_path: latest.evidenceArtifactPath,
      evidence_artifact_sha256: artifact?.sha256 || null,
    } : null,
    source_files: Object.fromEntries(SOURCE_FILES.map((file) => [file, sha256(fs.readFileSync(path.join(ROOT, file)))])),
    claim_boundary: {
      bounded_ingestion_and_gate_mechanism_proven: green,
      real_candidate_superiority_proven: false,
      reason: 'No production candidate is promoted until a local workload receipt proves it beats the incumbent.',
    },
  };
  const receiptPath = path.join(RECEIPT_ROOT, `${generatedAt.replace(/[:.]/g, '-')}-current-awareness-audit.json`);
  const written = writeChainedJsonReceipt(receiptPath, receipt);
  return {
    ...written,
    receipt_path: receiptPath,
    receipt_file_sha256: sha256(fs.readFileSync(receiptPath)),
  };
}

function validCanonicalHash(value) {
  if (!value || !/^[a-f0-9]{64}$/.test(String(value.sha256 || ''))) return false;
  const { sha256: expected, ...payload } = value;
  return sha256(canonical(payload)) === expected;
}

function validJsonPayloadHash(value) {
  if (!value || !/^[a-f0-9]{64}$/.test(String(value.sha256 || ''))) return false;
  const { sha256: expected, ...payload } = value;
  return sha256(JSON.stringify(payload)) === expected;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

if (import.meta.main) {
  const result = runCurrentAwarenessAuditProof();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'CURRENT_AWARENESS_AUDIT_GREEN') process.exitCode = 1;
}
