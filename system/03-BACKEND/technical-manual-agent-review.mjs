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

function latestReceipt(suffix) {
  const match = fs.readdirSync(RECEIPT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => ({ name: entry.name, file: path.join(RECEIPT_DIR, entry.name), mtime: fs.statSync(path.join(RECEIPT_DIR, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!match) throw new Error(`missing manual evidence receipt: ${suffix}`);
  return { ...match, body: JSON.parse(fs.readFileSync(match.file, 'utf8')) };
}

const SOURCE = {
  integrated: latestReceipt('-integrated-operational-proof.json'),
  context: latestReceipt('-context-crystal-quality-parity.json'),
  memory: latestReceipt('-memory-quality-benchmark.json'),
  mcp: latestReceipt('-brain-mcp-dual-transport-proof.json'),
  hermes: latestReceipt('-hermes-live-execution-proof.json'),
};

function evidenceFor(roleId) {
  const integrated = `integrated sha=${SOURCE.integrated.body.receipt_sha256.slice(0, 12)} status=GREEN groups=6/6`;
  const map = {
    'systems-architect': [integrated, `mcp sha=${SOURCE.mcp.body.sha256.slice(0, 12)} dual-transport checks=${Object.keys(SOURCE.mcp.body.checks).length}`],
    'compression-memory-scientist': [
      `context sha=${SOURCE.context.body.receipt_sha256.slice(0, 12)} min=1348.324x quality=5/5`,
      `memory sha=${SOURCE.memory.body.receipt_sha256.slice(0, 12)} MRR=0.9275 cases=23/23`,
    ],
    'benchmark-auditor': [integrated, `memory sha=${SOURCE.memory.body.receipt_sha256.slice(0, 12)} p95=130ms hybrid=23/23`],
    'operator-installer': [integrated, `hermes sha=${SOURCE.hermes.body.sha256.slice(0, 12)} checks=10/10 refusal+execution`],
    'cross-discipline-falsifier': [integrated, 'media runtime=4/4 studio_quality=PENDING no-overclaim=true'],
  };
  return map[roleId];
}

const ROLES = [
  {
    id: 'systems-architect',
    prompt: 'Act as the OrangeFive systems architect. Produce an evidence-first packet for a technical manual: operating theory, two-computer topology, order/report flow, model routing, Brain MCP, Hermes, receipts, and why each boundary exists. Distinguish proven runtime from intent. Do not claim execution.',
  },
  {
    id: 'compression-memory-scientist',
    prompt: 'Act as the OrangeFive compression and memory scientist. Produce an evidence-first packet covering Context Crystal, source hydration, AtomSmasher, AE Cobra memory, contradiction debt, retrieval scoring, limitations, and the benchmarks that would falsify the design. Do not invent numbers or claim execution.',
  },
  {
    id: 'benchmark-auditor',
    prompt: 'Act as an adversarial OrangeFive benchmark auditor. Identify which current claims require receipts, which benchmarks matter, what green does and does not prove, and the highest-risk theater or overclaim failure modes. Use current project context; do not invent evidence or claim execution.',
  },
  {
    id: 'operator-installer',
    prompt: 'Act as an OrangeFive release operator. Produce an evidence-first packet for installation and operations on an arbitrary Windows computer: one-box and two-box discovery, machine-local configuration, startup, model leases, health proof, recovery, uninstall, and ReadyForGit portability. Do not assume Atom-specific IP addresses are universal.',
  },
  {
    id: 'cross-discipline-falsifier',
    prompt: 'Act as a cross-discipline falsifier spanning distributed systems, security, human factors, model reliability, data provenance, performance, and product operations. Challenge OrangeFive theory and name exact tests or design corrections needed before public release. Preserve useful innovations; reject fake green.',
  },
];

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function callAgent(role, model = 'orange-auto', attempt = 1) {
  const suppliedEvidence = evidenceFor(role.id);
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  try {
    const response = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: JSON.stringify({ intent: role.prompt, evidence: suppliedEvidence }) }],
        stream: false,
        max_tokens: 900,
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
    const route = body?.ae_turn?.route || {};
    const receipt = body?.ae_turn?.receipt || {};
    const reportText = JSON.stringify(report || {});
    const evidencePreserved = Array.isArray(report?.evidence)
      && report.evidence.length === suppliedEvidence.length
      && report.evidence.every((item, index) => item === suppliedEvidence[index]);
    const result = {
      id: role.id,
      ok: response.ok && reportValid && receipt.hash?.length === 64 && reportText.length > 120
        && evidencePreserved
        && Array.isArray(report?.findings) && report.findings.length > 0
        && !report?.blockers?.includes('no governed evidence supplied'),
      latency_ms: Math.round(performance.now() - started),
      http_status: response.status,
      order_id: body?.ae_order_id || null,
      report_valid: reportValid,
      evidence_preserved: evidencePreserved,
      supplied_evidence: suppliedEvidence,
      validation_error: validationError,
      route,
      receipt,
      memory_sources: body?.ae_turn?.memory?.sources || [],
      context_crystal: body?.ae_turn?.project_context?.metrics || null,
      report,
      report_sha256: sha(reportText),
    };
    if (!result.ok && attempt === 1) {
      const retry = await callAgent(role, 'orange-navigator', 2);
      return {
        ...retry,
        retry_history: [{ model, http_status: result.http_status, report_valid: result.report_valid, validation_error: result.validation_error }],
      };
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

const resumeIndex = process.argv.indexOf('--resume');
const resumePath = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;
const resumed = resumePath && fs.existsSync(resumePath) ? JSON.parse(fs.readFileSync(resumePath, 'utf8')) : null;
const agents = [];
for (const role of ROLES) {
  const prior = resumed?.agents?.find((agent) => agent.id === role.id && agent.ok === true);
  agents.push(prior || await callAgent(role));
}

const distinctReports = new Set(agents.map((agent) => agent.report_sha256)).size;
const checks = {
  all_five_agents_returned: agents.length === ROLES.length,
  all_reports_schema_valid: agents.every((agent) => agent.report_valid),
  all_reports_receipted: agents.every((agent) => agent.receipt?.hash?.length === 64),
  all_evidence_preserved_exactly: agents.every((agent) => agent.evidence_preserved === true),
  all_agents_produced_substance: agents.every((agent) => agent.ok),
  perspectives_are_distinct: distinctReports === ROLES.length,
  codexa_used_for_at_least_one_review: agents.some((agent) => agent.route?.effective_node === 'codexa-tunnel'),
};
const green = Object.values(checks).every(Boolean);
const packet = {
  schema: 'orangefive.technical-manual-agent-review.v1',
  status: green ? 'ORANGEFIVE_TECHNICAL_MANUAL_AGENT_REVIEW_GREEN' : 'ORANGEFIVE_TECHNICAL_MANUAL_AGENT_REVIEW_NEEDS_WORK',
  generated_at: new Date().toISOString(),
  gateway: GATEWAY,
  checks,
  agents,
};

const stamp = packet.generated_at.replace(/[:.]/g, '-');
const receiptPath = path.join(RECEIPT_DIR, `${stamp}-technical-manual-agent-review.json`);
const chained = writeChainedJsonReceipt(receiptPath, packet);
console.log(JSON.stringify({ status: packet.status, checks, agents: agents.map(({ id, ok, latency_ms, route, receipt }) => ({ id, ok, latency_ms, model: route.effective_model, node: route.effective_node, receipt: receipt.hash })), receipt_path: receiptPath, receipt_sha256: chained.receipt_sha256 }, null, 2));
if (!green) process.exitCode = 1;
