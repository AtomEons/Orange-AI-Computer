import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMissionOrder, runCrossOrganMission } from './cross-organ-mission.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const SPINE_CHAIN = path.join(ROOT, '10-RECEIPTS', 'spine-chain.jsonl');
const MISSION_CHAIN = path.join(RECEIPT_DIR, 'cross-organ-mission-chain.jsonl');

function lineCount(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length; }
  catch { return 0; }
}

function jsonLinesSince(file, offset) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(offset)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

const order = createMissionOrder('Prove OrangeFive durable cross-organ resume without duplicate effects');
const receiptPath = path.join(RECEIPT_DIR, `${order.orderId}.json`);
const before = { spine: lineCount(SPINE_CHAIN), mission: lineCount(MISSION_CHAIN) };

const firstStarted = performance.now();
const first = await runCrossOrganMission({ order, receiptPath });
const firstMs = Math.round((performance.now() - firstStarted) * 100) / 100;
const afterFirst = { spine: lineCount(SPINE_CHAIN), mission: lineCount(MISSION_CHAIN) };
const firstSpineEffects = jsonLinesSince(SPINE_CHAIN, before.spine);

const secondStarted = performance.now();
const second = await runCrossOrganMission({ order, receiptPath });
const secondMs = Math.round((performance.now() - secondStarted) * 100) / 100;
const afterSecond = { spine: lineCount(SPINE_CHAIN), mission: lineCount(MISSION_CHAIN) };
const canonicalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
const governedCampaignEffect = firstSpineEffects.find((row) => row.campaign_id === order.orderId);

const checks = {
  first_green: first.ok === true && first.status === 'GREEN',
  second_green: second.ok === true && second.status === 'GREEN',
  first_integrity: first.durableProof?.ok === true && first.durableProof?.completed === 12,
  second_integrity: second.durableProof?.ok === true && second.durableProof?.completed === 12,
  first_trace_integrity: first.traceProof?.ok === true && first.traceProof?.spans === 13,
  second_trace_integrity: second.traceProof?.ok === true && second.traceProof?.spans === 26,
  resumed_trace_visible: second.traceProof?.resumed === 12,
  stable_trace_identity: first.traceProof?.trace_id === second.traceProof?.trace_id,
  same_receipt_hash: first.receipt?.hash === second.receipt?.hash,
  one_governed_campaign_effect: firstSpineEffects.filter((row) => row.campaign_id === order.orderId).length === 1,
  refuter_gate_visible: governedCampaignEffect?.topology === 'adversarial_pair'
    && governedCampaignEffect?.adversarial_review?.completed === true
    && governedCampaignEffect?.adversarial_review?.pre_execution === true
    && governedCampaignEffect?.adversarial_review?.refuted === false,
  one_mission_effect: afterFirst.mission - before.mission === 1,
  no_second_spine_effect: afterSecond.spine === afterFirst.spine,
  no_second_mission_effect: afterSecond.mission === afterFirst.mission,
  canonical_receipt_restored: canonicalReceipt.status === 'GREEN' && canonicalReceipt.hash === first.receipt?.hash,
  resume_faster: secondMs < firstMs,
};
const ok = Object.values(checks).every(Boolean);
const proof = {
  schema: 'orange5.durable-cross-organ-proof.v1',
  status: ok ? 'DURABLE_RESUME_GREEN' : 'DURABLE_RESUME_NEEDS_WORK',
  generated_at: new Date().toISOString(),
  order_id: order.orderId,
  checks,
  timing_ms: { first: firstMs, resumed: secondMs, speedup: secondMs > 0 ? Number((firstMs / secondMs).toFixed(2)) : null },
  chain_counts: { before, after_first: afterFirst, after_second: afterSecond },
  first_spine_effects: firstSpineEffects.map(({ seq, receipt_id, action, status, campaign_id, executed }) => ({
    seq,
    receipt_id,
    action,
    status,
    campaign_id,
    executed,
  })),
  durable: { first: first.durableProof, second: second.durableProof },
  traces: { first: first.traceProof, second: second.traceProof },
  mission_receipt: receiptPath,
};
proof.proof_sha256 = sha256(JSON.stringify(proof));
fs.mkdirSync(RECEIPT_DIR, { recursive: true });
const outputPath = path.join(RECEIPT_DIR, `${proof.generated_at.replace(/[:.]/g, '-')}-durable-cross-organ-proof.json`);
fs.writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...proof, receipt_path: outputPath }, null, 2));
if (!ok) process.exitCode = 1;
