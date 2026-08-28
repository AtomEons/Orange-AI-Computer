import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  WAVE3_KERNEL_MANIFEST_HASH,
  WAVE3_MECHANISMS,
  WAVE3_MECHANISM_ABI,
  WAVE3_MECHANISM_ABI_MANIFEST,
} from './wave3-intelligent-kernel.mjs';
import {
  DEFAULT_WAVE3_KERNEL_STATE_LEDGER,
  getLatestWave3KernelStates,
} from './wave3-kernel-state.mjs';

export const WAVE3_KERNEL_COVERAGE_SCHEMA = 'orange.wave3-kernel-coverage.v1';

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function resolveEvidenceReference(reference, projectRoot) {
  const value = String(reference ?? '').trim();
  if (!value) return Object.freeze({ reference: value, local: false, exists: false });
  if (/^[a-z]+:\/\//i.test(value) || /^[a-z-]+:/i.test(value)) {
    return Object.freeze({ reference: value, local: false, exists: true });
  }
  const absolute = path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
  return Object.freeze({ reference: value, local: true, exists: fs.existsSync(absolute), absolute });
}

export function buildWave3KernelCoverage({
  projectRoot = path.resolve(import.meta.dir, '..'),
  ledgerPath = DEFAULT_WAVE3_KERNEL_STATE_LEDGER,
} = {}) {
  const states = getLatestWave3KernelStates({ ledgerPath });
  const records = states.map(({ mechanism, state }) => {
    const adapter = WAVE3_MECHANISM_ABI.get(mechanism.id);
    const evidence = (state.evidenceRefs ?? []).map((reference) => resolveEvidenceReference(reference, projectRoot));
    const abiComplete = Boolean(adapter)
      && ['select', 'preflight', 'enforce', 'observe', 'falsify', 'settle', 'rollback']
        .every((method) => typeof adapter[method] === 'function');
    const evidenceBackedActive = state.status === 'active'
      && evidence.length > 0
      && evidence.every(({ exists }) => exists === true)
      && String(state.enforcementReference ?? '').trim().length > 0
      && String(state.falsifier ?? '').trim().length > 0;
    return Object.freeze({
      mechanismId: mechanism.id,
      name: mechanism.name,
      organId: mechanism.organId,
      abiComplete,
      state: state.status,
      evidence,
      evidenceBackedActive,
      proofStatus: evidenceBackedActive ? 'PROVEN_ACTIVE' : 'NOT_PROVEN',
    });
  });
  const counts = Object.freeze({
    mechanisms: records.length,
    abiComplete: records.filter(({ abiComplete }) => abiComplete).length,
    provenActive: records.filter(({ evidenceBackedActive }) => evidenceBackedActive).length,
    notProven: records.filter(({ evidenceBackedActive }) => !evidenceBackedActive).length,
  });
  const payload = {
    schema: WAVE3_KERNEL_COVERAGE_SCHEMA,
    manifestHash: WAVE3_KERNEL_MANIFEST_HASH,
    mechanismAbiHash: WAVE3_MECHANISM_ABI_MANIFEST.abiHash,
    ledgerPath: path.resolve(ledgerPath),
    counts,
    records,
    honestGreen: counts.mechanisms === 100 && counts.abiComplete === 100 && counts.provenActive === 100,
  };
  return Object.freeze({ ...payload, coverageHash: sha256(payload) });
}

export function renderWave3KernelCoverageMarkdown(coverage) {
  const lines = [
    '# Wave 3 Intelligent Kernel Coverage',
    '',
    `- Manifest: \`${coverage.manifestHash}\``,
    `- ABI: \`${coverage.mechanismAbiHash}\``,
    `- ABI complete: ${coverage.counts.abiComplete}/${coverage.counts.mechanisms}`,
    `- Evidence-backed active: ${coverage.counts.provenActive}/${coverage.counts.mechanisms}`,
    `- Honest green: ${coverage.honestGreen}`,
    '',
    '| ID | Mechanism | ABI | State | Proof |',
    '|---|---|---:|---|---|',
    ...coverage.records.map((record) => `| ${record.mechanismId} | ${record.name.replace(/\|/g, '\\|')} | ${record.abiComplete ? 'yes' : 'no'} | ${record.state} | ${record.proofStatus} |`),
    '',
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  const coverage = buildWave3KernelCoverage();
  const outputIndex = process.argv.indexOf('--out');
  if (outputIndex >= 0) {
    const outputPath = path.resolve(process.argv[outputIndex + 1]);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(coverage, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(coverage, null, 2));
}
