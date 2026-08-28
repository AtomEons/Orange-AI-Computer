#!/usr/bin/env bun
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeDelegation } from './orange5-headless-core.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const generatedAt = new Date().toISOString();
const orderId = `awareness-live-${crypto.randomUUID()}`;

const result = await executeDelegation({
  execute: true,
  maxAgents: 1,
  order: {
    schema: 'orange.order.v1',
    orderId,
    action: 'research.system-gap-sweep',
    intent: 'Find current primary-source evidence about durable idempotent custody for distributed AI agent work.',
    targetProject: ROOT,
    scope: 'read-only current-awareness proof',
    allowedActions: ['research.system-gap-sweep', 'analyze.agent', 'synthesize.delegation'],
    forbiddenActions: ['filesystem.write', 'shell.execute', 'service.restart'],
    riskLevel: 'low',
    requiresReceipt: true,
    payload: { query: 'durable idempotent custody distributed AI agent work current research' },
  },
});

const evidence = result?.governance?.researchEvidence || null;
const reports = Array.isArray(result?.reports) ? result.reports : [];
const childReceipt = reports[0]?.result?.receipt || null;
const synthesisReceipt = result?.synthesis?.result?.receipt || null;
const receiptBacked = (receipt) => (
  typeof receipt?.receipt_id === 'string'
  && receipt.receipt_id.length > 0
  && typeof receipt?.hash === 'string'
  && /^[a-f0-9]{64}$/i.test(receipt.hash)
);
const checks = {
  delegation_complete: result?.status === 'DELEGATION_COMPLETE',
  current_source_evidence_present: evidence?.ok === true && Number(evidence?.sourceCount || 0) > 0,
  evidence_artifact_present: typeof evidence?.artifactPath === 'string' && fs.existsSync(evidence.artifactPath),
  hermes_lease_minted: Boolean(result?.governance?.hermesLeaseId),
  one_bounded_child_complete: reports.length === 1
    && reports[0]?.ok === true
    && reports[0]?.result?.status === 'completed',
  child_receipt_backed: receiptBacked(childReceipt),
  synthesis_complete: result?.synthesis?.ok === true
    && result?.synthesis?.result?.status === 'completed',
  synthesis_receipt_backed: receiptBacked(synthesisReceipt),
  hermes_authorized_both_actions: result?.governance?.hermesAuthorizedActions === 2,
  hermes_lease_revoked: result?.governance?.hermesLeaseRevoked === true,
  no_execution_error: !result?.error,
};
const green = Object.values(checks).every(Boolean);
const proof = {
  schema: 'orange5.current-awareness-delegation-live-proof.v1',
  status: green ? 'CURRENT_AWARENESS_DELEGATION_GREEN' : 'CURRENT_AWARENESS_DELEGATION_NEEDS_WORK',
  generated_at: generatedAt,
  order_id: orderId,
  scope: 'live read-only AE2 evidence acquisition through Navigator and Hermès',
  checks,
  evidence: evidence ? {
    status: evidence.status,
    source_count: evidence.sourceCount,
    artifact_path: evidence.artifactPath,
    sha256: evidence.sha256,
    recovered_from_current_awareness: evidence.recoveredFromCurrentAwareness === true,
  } : null,
  route: result?.route || null,
  governance: {
    lease_id: result?.governance?.hermesLeaseId || null,
    authorized_actions: result?.governance?.hermesAuthorizedActions || 0,
    lease_revoked: result?.governance?.hermesLeaseRevoked === true,
  },
  reports: reports.map((report) => ({
    ok: report?.ok === true,
    status: report?.result?.status || null,
    lane: report?.result?.report?.lane || null,
    model: report?.result?.report?.model || null,
    receipt: report?.result?.receipt || null,
  })),
  synthesis: result?.synthesis ? {
    ok: result.synthesis?.ok === true,
    status: result.synthesis?.result?.status || null,
    lane: result.synthesis?.result?.report?.lane || null,
    model: result.synthesis?.result?.report?.model || null,
    receipt: synthesisReceipt,
  } : null,
  blockers: result?.blockers || [],
  result_sha256: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  claim_boundary: {
    evidence_continuity_proven_for_this_order: green,
    universal_research_recall_proven: false,
    candidate_promoted_to_production: false,
  },
};
const receiptPath = path.join(RECEIPT_DIR, `${generatedAt.replace(/[:.]/g, '-')}-current-awareness-delegation-live.json`);
const written = writeChainedJsonReceipt(receiptPath, proof);
console.log(JSON.stringify({ ...written, receipt_path: receiptPath }, null, 2));
if (!green) process.exitCode = 1;
