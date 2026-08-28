#!/usr/bin/env bun
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '#sqlite';
import { classifyReflexIntent } from '../06-ORANGELLM/server/reflex-compiler.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const DEFAULT_DB = path.join(os.homedir(), 'OrangeBox-Data', 'orange5', 'knowledge', 'orange5-project-continuum.db');
const DEFAULT_CHAIN = path.join(ROOT, '10-RECEIPTS', 'spine-chain.jsonl');
const DEFAULT_RECEIPTS = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
// Must match orange5-spine.mjs exactly. A verifier that invents its own
// sentinel rejects a healthy historical chain and can never earn promotion.
const SPINE_GENESIS = crypto.createHash('sha256').update('orange5-spine-genesis').digest('hex');

const HOLDOUTS = Object.freeze({
  'health-route': {
    positive: [
      'Report the OrangeFive health endpoint.',
      'Which health route should I probe?',
      'Where is the system health check?',
    ],
    negative: [
      'Use this health report as evidence and diagnose the failure.',
      'Edit the health route implementation and run tests.',
      'Design a new health architecture for OrangeFive.',
    ],
  },
  'memory-recall-route': {
    positive: [
      'Which project memory route should answer recall?',
      'Where is the OrangeFive project recall endpoint?',
    ],
    negative: [
      'Redesign OrangeFive memory for semantic reasoning.',
      'Delete stale project memory records.',
    ],
  },
  'visual-route': {
    positive: [
      'Route this screenshot inspection to the correct visual organ.',
      'Which organ should analyze this document image?',
    ],
    negative: [
      'Implement a new visual renderer.',
      'Use this screenshot as proof the deployment is healthy.',
    ],
  },
  'codexa-offline-policy': {
    positive: ['Codexa is unreachable. What is the honest fallback?'],
    negative: ['Reconnect Codexa and restart every model service.'],
  },
  'mutation-proof-boundary': {
    positive: ['Plan an edit but do not claim it executed without a receipt.'],
    negative: ['Edit the source file now and run its tests.'],
  },
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedReportFingerprint(report) {
  const normalized = { ...report, orderId: '<order>', receiptPath: null };
  return sha256(stableJson(normalized));
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`invalid JSONL at ${file}:${index + 1}: ${error.message}`); }
  });
}

export function verifySpineChain(file = DEFAULT_CHAIN) {
  const rows = readJsonLines(file);
  const broken = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const { prev_hash, hash, ...body } = row;
    const expectedPrev = index === 0 ? SPINE_GENESIS : rows[index - 1].hash;
    const expectedHash = sha256(`${prev_hash}|${JSON.stringify(body)}`);
    if (row.seq !== index) broken.push({ seq: row.seq, reason: 'sequence' });
    if (prev_hash !== expectedPrev) broken.push({ seq: row.seq, reason: 'previous_hash' });
    if (hash !== expectedHash) broken.push({ seq: row.seq, reason: 'content_hash' });
  }
  return { ok: broken.length === 0, count: rows.length, broken, rows };
}

function evaluateHoldouts(intentId, classify = classifyReflexIntent) {
  const vectors = HOLDOUTS[intentId];
  if (!vectors) return { available: false, passed: false, positives: [], negatives: [] };
  const positives = vectors.positive.map((prompt) => ({ prompt, pass: classify([{ role: 'user', content: prompt }])?.id === intentId }));
  const negatives = vectors.negative.map((prompt) => ({ prompt, pass: classify([{ role: 'user', content: prompt }])?.id !== intentId }));
  return {
    available: true,
    passed: positives.every((item) => item.pass) && negatives.every((item) => item.pass),
    positives,
    negatives,
  };
}

function trustedTurns({ dbPath, chainPath, classify }) {
  const chain = verifySpineChain(chainPath);
  if (!chain.ok) return { chain, turns: [], rejected: [{ reason: 'spine_chain_invalid', count: chain.broken.length }] };
  const bySeq = new Map(chain.rows.map((row) => [row.seq, row]));
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query("SELECT id,title,text,text_hash,created_at FROM sources WHERE source_type='continuum:interaction' ORDER BY created_at,id").all();
  db.close();
  const turns = [];
  const rejected = [];
  for (const source of rows) {
    if (sha256(source.text) !== source.text_hash) {
      rejected.push({ source: source.title, reason: 'source_hash_mismatch' });
      continue;
    }
    let payload;
    let report;
    try {
      payload = JSON.parse(source.text);
      report = JSON.parse(payload.assistant);
    } catch {
      rejected.push({ source: source.title, reason: 'turn_or_report_invalid_json' });
      continue;
    }
    // Continuum stores many model and specialist turns that can never nominate
    // a deterministic reflex. Exclude them before receipt joining so ordinary
    // non-reflex history is not mislabeled as failed evidence debt.
    if (payload.route?.execution_tier !== 'reflex') continue;
    const receipt = bySeq.get(payload.receipt?.seq);
    if (!receipt || receipt.hash !== payload.receipt?.hash || receipt.receipt_id !== payload.receipt?.id) {
      rejected.push({ source: source.title, reason: 'receipt_join_failed' });
      continue;
    }
    if (receipt.status !== 'completed' || receipt.lane !== 'reflex') continue;
    if (report.schema !== 'orange.report.v1' || report.actionsTaken?.length || report.evidence?.length) {
      rejected.push({ source: source.title, reason: 'unsafe_or_nonreport_output' });
      continue;
    }
    const decision = classify([{ role: 'user', content: payload.user }]);
    if (!decision) continue;
    turns.push({
      intent_id: decision.id,
      source_id: source.id,
      source_path: source.title,
      source_hash: source.text_hash,
      receipt_seq: receipt.seq,
      receipt_hash: receipt.hash,
      created_at: source.created_at,
      prompt: payload.user,
      report_fingerprint: normalizedReportFingerprint(report),
    });
  }
  return { chain, turns, rejected };
}

export function mineReflexCandidates({
  dbPath = DEFAULT_DB,
  chainPath = DEFAULT_CHAIN,
  minSupport = 3,
  minPromptShapes = 3,
  classify = classifyReflexIntent,
} = {}) {
  const evidence = trustedTurns({ dbPath, chainPath, classify });
  const grouped = new Map();
  for (const turn of evidence.turns) {
    const rows = grouped.get(turn.intent_id) || [];
    rows.push(turn);
    grouped.set(turn.intent_id, rows);
  }
  const candidates = [...grouped].map(([intentId, turns]) => {
    const fingerprints = [...new Set(turns.map((turn) => turn.report_fingerprint))];
    const holdout = evaluateHoldouts(intentId, classify);
    const enoughSupport = turns.length >= minSupport;
    const promptShapes = new Set(turns.map((turn) => turn.prompt.replace(/\/no_think/g, '').trim().toLowerCase())).size;
    const enoughPromptShapes = promptShapes >= minPromptShapes;
    const stableOutcome = fingerprints.length === 1;
    const eligible = enoughSupport && enoughPromptShapes && stableOutcome && holdout.available && holdout.passed;
    return {
      schema: 'orange5.reflex-candidate.v1',
      intent_id: intentId,
      status: eligible ? 'ACTIVE_REFLEX_REVALIDATED' : (holdout.available && !holdout.passed ? 'REJECTED_BY_HELD_OUT_FALSIFIER' : 'INSUFFICIENT_EVIDENCE'),
      support: turns.length,
      minimum_support: minSupport,
      independent_prompt_shapes: promptShapes,
      minimum_prompt_shapes: minPromptShapes,
      stable_outcome: stableOutcome,
      report_fingerprints: fingerprints,
      held_out: holdout,
      evidence: turns.map(({ prompt, ...turn }) => turn),
      auto_promoted: false,
      promotion_requires_operator: true,
    };
  }).sort((a, b) => b.support - a.support || a.intent_id.localeCompare(b.intent_id));
  const rejectedByReason = Object.fromEntries([...new Set(evidence.rejected.map((item) => item.reason))]
    .sort()
    .map((reason) => [reason, evidence.rejected.filter((item) => item.reason === reason).length]));
  return {
    schema: 'orange5.receipt-to-reflex-proof.v1',
    generated_at: new Date().toISOString(),
    status: evidence.chain.ok && candidates.every((item) => item.status !== 'REJECTED_BY_HELD_OUT_FALSIFIER')
      ? 'REFLEX_MINER_PROOF_COMPLETE'
      : 'REFLEX_MINER_NEEDS_WORK',
    chain: { ok: evidence.chain.ok, receipts: evidence.chain.count, broken: evidence.chain.broken },
    trusted_turns: evidence.turns.length,
    rejected_sources: evidence.rejected,
    rejected_source_debt: {
      total: evidence.rejected.length,
      by_reason: rejectedByReason,
      disposition: 'excluded_from_training_and_promotion',
    },
    candidates,
    auto_promotion: false,
    law: 'Receipts may nominate a reflex. Held-out falsification and operator authority decide promotion.',
  };
}

export function writeReflexProof(result, { receiptDir = DEFAULT_RECEIPTS } = {}) {
  const stamp = result.generated_at.replace(/[:.]/g, '-');
  const target = path.join(receiptDir, `${stamp}-receipt-to-reflex-proof.json`);
  writeChainedJsonReceipt(target, result);
  return target;
}

if (import.meta.main) {
  const result = mineReflexCandidates();
  const receiptPath = writeReflexProof(result);
  console.log(JSON.stringify({ ...result, receiptPath }, null, 2));
  if (result.status !== 'REFLEX_MINER_PROOF_COMPLETE') process.exitCode = 1;
}

export const __receiptToReflexInternals = Object.freeze({ sha256, stableJson, normalizedReportFingerprint, evaluateHoldouts, trustedTurns, SPINE_GENESIS });
