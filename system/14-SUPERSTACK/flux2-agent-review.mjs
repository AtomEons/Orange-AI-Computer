#!/usr/bin/env bun

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOrangeReport } from '../06-ORANGELLM/contracts/orange-report.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const GATEWAY = process.env.ORANGE5_ORANGEBRAIN_URL || 'http://127.0.0.1:1337';
const EVIDENCE = [
  'FLUX2_KLEIN_4B=36.006s@1280x768',
  'FLUX2_STUDIO_QUALITY=false',
];

const roles = [
  {
    id: 'flux2-workflow-architect',
    intent: 'Design the smallest serious FLUX.2-only image production workflow that can close the observed quality gap. Keep FLUX.2 as the engine. Address candidate generation, Base or Dev finalization, image editing, multi-reference control, defect rejection, ranking, restoration, receipts, and exact promotion tests. Return concrete next actions, dependencies, memory cost, falsifiers, and rollback.',
  },
  {
    id: 'intel-xpu-performance-engineer',
    intent: 'Optimize the current ComfyUI FLUX.2 Klein 4B FP8 workflow on Windows Intel Arc 140T XPU. Identify only realistic supported optimizations: startup residency, model reuse, PyTorch XPU and torch.compile compatibility, batching, memory ceiling, quantization, workflow partial execution, and benchmark design. Reject CUDA-only advice. Return prioritized changes with expected benefit and proof commands.',
  },
  {
    id: 'visual-quality-falsifier',
    intent: 'Act as a strict visual-generation falsifier. The local FLUX.2 outputs are runtime-proven but contain pseudo-text and weak hierarchy. Define an automated rejection and pairwise benchmark system using OCR/text-region checks, prompt-object coverage, candidate ranking, visual reward, human review, and artifact receipts. Name what cannot be automated and prevent Midjourney or Seedance parity claims without broad evidence.',
  },
];

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function callAgent(role) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  try {
    const response = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: 'orange-auto',
        messages: [{ role: 'user', content: JSON.stringify({ intent: role.intent, evidence: EVIDENCE }) }],
        stream: false,
        max_tokens: 1200,
        temperature: 0,
        ae_response_contract: 'orange.report.v1',
        ae_evidence_policy: 'preserve_exact',
      }),
      signal: controller.signal,
    });
    const body = await response.json();
    let report = null;
    try { report = JSON.parse(body?.choices?.[0]?.message?.content || ''); } catch {}
    let reportValid = false;
    let validationError = null;
    try {
      validateOrangeReport(report, body?.ae_order_id);
      reportValid = true;
    } catch (error) {
      validationError = error?.message || String(error);
    }
    const evidencePreserved = Array.isArray(report?.evidence)
      && report.evidence.length === EVIDENCE.length
      && report.evidence.every((item, index) => item === EVIDENCE[index]);
    const receipt = body?.ae_turn?.receipt || {};
    const route = body?.ae_turn?.route || {};
    return {
      id: role.id,
      ok: response.ok && reportValid && evidencePreserved && receipt.hash?.length === 64,
      http_status: response.status,
      latency_ms: Math.round(performance.now() - started),
      report_valid: reportValid,
      validation_error: validationError,
      evidence_preserved: evidencePreserved,
      report,
      report_sha256: sha(JSON.stringify(report || {})),
      route,
      receipt,
    };
  } catch (error) {
    return {
      id: role.id,
      ok: false,
      latency_ms: Math.round(performance.now() - started),
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const agents = await Promise.all(roles.map(callAgent));
const checks = {
  all_agents_returned: agents.length === roles.length,
  all_agents_green: agents.every((agent) => agent.ok),
  all_reports_schema_valid: agents.every((agent) => agent.report_valid),
  all_evidence_preserved: agents.every((agent) => agent.evidence_preserved),
  all_reports_receipted: agents.every((agent) => agent.receipt?.hash?.length === 64),
  reports_are_distinct: new Set(agents.map((agent) => agent.report_sha256)).size === roles.length,
  codexa_used: agents.some((agent) => ['codexa', 'codexa-tunnel'].includes(agent.route?.effective_node)),
};
const green = Object.values(checks).every(Boolean);
const packet = {
  schema: 'orangefive.flux2-agent-review.v1',
  status: green ? 'ORANGEFIVE_FLUX2_AGENT_REVIEW_GREEN' : 'ORANGEFIVE_FLUX2_AGENT_REVIEW_NEEDS_WORK',
  generated_at: new Date().toISOString(),
  gateway: GATEWAY,
  evidence: EVIDENCE,
  checks,
  agents,
  warning: 'Agent findings are advisory. Deterministic tests and human visual review own promotion.',
};
const stamp = packet.generated_at.replace(/[:.]/g, '-');
const receiptPath = path.join(RECEIPT_DIR, `${stamp}-flux2-agent-review.json`);
const chained = writeChainedJsonReceipt(receiptPath, packet);
console.log(JSON.stringify({
  status: packet.status,
  checks,
  agents: agents.map((agent) => ({
    id: agent.id,
    ok: agent.ok,
    latency_ms: agent.latency_ms,
    model: agent.route?.effective_model,
    node: agent.route?.effective_node,
    error: agent.error,
  })),
  receipt_path: receiptPath,
  receipt_sha256: chained.receipt_sha256,
}, null, 2));
if (!green) process.exitCode = 1;
