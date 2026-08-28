#!/usr/bin/env bun
import { pathToFileURL } from 'node:url';

const requiredReportFields = ['workerId', 'status', 'evidence', 'confidence', 'blockers', 'nextAction'];
const asTime = (value) => value ? new Date(value).getTime() : NaN;

function overlaps(a, b) {
  const aStart = asTime(a.startedAt); const aEnd = asTime(a.endedAt);
  const bStart = asTime(b.startedAt); const bEnd = asTime(b.endedAt);
  return [aStart, aEnd, bStart, bEnd].every(Number.isFinite) && aStart < bEnd && bStart < aEnd;
}

export function inspectSwarm(input) {
  const expected = new Set((input.plan?.executionWaves || []).flatMap((wave) => wave.workers || []).map((worker) => worker.id));
  const reports = input.workerReports || [];
  const findings = [];
  const seen = new Set();
  const evidenceHashes = new Map();

  for (const report of reports) {
    for (const field of requiredReportFields) if (!(field in report)) findings.push({ severity: 'HALT', code: 'REPORT_FIELD_MISSING', workerId: report.workerId || null, field });
    if (seen.has(report.workerId)) findings.push({ severity: 'HALT', code: 'DUPLICATE_WORKER_REPORT', workerId: report.workerId });
    seen.add(report.workerId);
    if (expected.size && !expected.has(report.workerId)) findings.push({ severity: 'WARN', code: 'UNPLANNED_WORKER', workerId: report.workerId });
    const evidence = Array.isArray(report.evidence) ? report.evidence : [];
    if (/^(green|pass|complete|done)$/i.test(report.status) && evidence.length === 0) findings.push({ severity: 'HALT', code: 'FALSE_GREEN_NO_EVIDENCE', workerId: report.workerId });
    for (const item of evidence) {
      const hash = typeof item === 'string' ? item : item?.sha256 || item?.hash;
      if (!hash) continue;
      if (evidenceHashes.has(hash)) findings.push({ severity: 'WARN', code: 'DUPLICATE_EVIDENCE', workerId: report.workerId, sameAs: evidenceHashes.get(hash) });
      else evidenceHashes.set(hash, report.workerId);
    }
  }

  for (const workerId of expected) if (!seen.has(workerId)) findings.push({ severity: 'WAIT', code: 'WORKER_REPORT_PENDING', workerId });
  for (let i = 0; i < reports.length; i++) for (let j = i + 1; j < reports.length; j++) {
    const shared = (reports[i].writesPerformed || []).filter((path) => (reports[j].writesPerformed || []).includes(path));
    if (shared.length && overlaps(reports[i], reports[j])) findings.push({ severity: 'HALT', code: 'OVERLAPPING_SHARED_WRITE', workers: [reports[i].workerId, reports[j].workerId], paths: shared });
  }

  const memoryUsed = Number(input.system?.liveMemoryUsedGb ?? 0);
  const memoryBudget = Number(input.system?.liveMemoryBudgetGb ?? 50);
  if (memoryUsed > memoryBudget) findings.push({ severity: 'HALT', code: 'MEMORY_BUDGET_EXCEEDED', memoryUsed, memoryBudget });
  else if (memoryUsed >= memoryBudget * 0.9) findings.push({ severity: 'WARN', code: 'MEMORY_PRESSURE', memoryUsed, memoryBudget });

  const settled = reports.filter((report) => !/pending|running/i.test(report.status || ''));
  const failures = settled.filter((report) => /fail|error|block/i.test(report.status || '')).length;
  if (settled.length >= 3 && failures / settled.length > 0.34) findings.push({ severity: 'HALT', code: 'FAILURE_AMPLIFICATION', failures, settled: settled.length });

  const halted = findings.some((finding) => finding.severity === 'HALT');
  const waiting = findings.some((finding) => finding.severity === 'WAIT');
  const warned = findings.some((finding) => finding.severity === 'WARN');
  return {
    schema: 'orange5.swarm-sentinel-report.v1',
    status: halted ? 'SWARM_HALTED' : waiting ? 'SWARM_RUNNING' : warned ? 'SWARM_DEGRADED' : 'SWARM_HEALTHY',
    admitNewWorkers: !halted && memoryUsed < memoryBudget * 0.9,
    expectedWorkers: expected.size,
    reportedWorkers: reports.length,
    findings,
    nextAction: halted ? 'Stop new dispatch and return findings to Navigator.' : waiting ? 'Continue current wave; do not duplicate pending workers.' : warned ? 'Finish current wave and repair warnings before expansion.' : 'Admit the next Swarmgate wave.'
  };
}

async function main() {
  const index = process.argv.indexOf('--input');
  const raw = index >= 0 ? process.argv[index + 1] : await Bun.stdin.text();
  if (!raw) throw new Error('Provide sentinel JSON with --input or stdin');
  const report = inspectSwarm(JSON.parse(raw));
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'SWARM_HALTED') process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(JSON.stringify({ schema: 'orange5.swarm-sentinel-report.v1', status: 'SWARM_HALTED', error: error.message }));
  process.exit(2);
});
