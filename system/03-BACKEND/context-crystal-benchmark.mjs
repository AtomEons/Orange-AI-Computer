#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileContextCrystal, verifyContextCrystal } from './context-crystal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const ROOTS = ['00-CHARTER', '03-BACKEND', '06-ORANGELLM', '12-ATOMSMASHER'];
const REQUIRED = [
  '00-CHARTER/ORANGE5_RUNTIME_AUTHORITY.md',
  '00-CHARTER/ORANGE5_OPERATIONAL_LAW.md',
  '00-CHARTER/ORANGE5_MASTER_PLAN.md',
];
const ALLOWED = /\.(?:md|mjs|json|jsonl)$/i;
const MAX_FILE_BYTES = 1_500_000;
const MAX_CORPUS_BYTES = 40_000_000;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function walk(relativeRoot, output) {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return;
  const stack = [absoluteRoot];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && ALLOWED.test(entry.name)) output.push(absolute);
    }
  }
}

const files = [];
for (const root of ROOTS) walk(root, files);
files.push(path.join(ROOT, '10-RECEIPTS', 'spine-chain.jsonl'));
const unique = [...new Set(files)].sort();
const sources = [];
const sourceMap = new Map();
let corpusBytes = 0;
for (const absolute of unique) {
  if (!fs.existsSync(absolute)) continue;
  const stat = fs.statSync(absolute);
  if (stat.size <= 0 || stat.size > MAX_FILE_BYTES || corpusBytes + stat.size > MAX_CORPUS_BYTES) continue;
  const content = fs.readFileSync(absolute, 'utf8');
  const id = path.relative(ROOT, absolute).replaceAll('\\', '/');
  corpusBytes += Buffer.byteLength(content);
  sourceMap.set(id, content);
  sources.push({
    id,
    pointer: `file://${absolute.replaceAll('\\', '/')}`,
    content,
    authority: REQUIRED.includes(id) ? 0.3 : 0,
  });
}

const task = 'Explain the current OrangeFive runtime authority, no-fake-green receipt law, N150 and Codexa roles, AtomSmasher compression, memory recall, Hermes execution, and OrangeLLM routing.';
const started = performance.now();
const crystal = compileContextCrystal({ task, sources, budgetBytes: 7_000, requiredSourceIds: REQUIRED });
const verification = verifyContextCrystal(crystal, (id) => sourceMap.get(id));
const hot = crystal.hot_context.toLowerCase();
const probes = {
  orangefive: hot.includes('orangefive') || hot.includes('orange5'),
  receipt_truth: hot.includes('receipt') && (hot.includes('fake') || hot.includes('evidence')),
  topology: hot.includes('n150') && hot.includes('codexa'),
  compression: hot.includes('atomsmasher') || hot.includes('compression'),
  execution: hot.includes('hermes') || hot.includes('orangellm'),
};
const probeCount = Object.values(probes).filter(Boolean).length;
const receipt = {
  schema: 'orange5.context-crystal-benchmark.v1',
  status: verification.ok && crystal.proof.complete && crystal.metrics.target_200x_met && probeCount === Object.keys(probes).length
    ? 'ORANGE5_CONTEXT_CRYSTAL_200X_GREEN'
    : 'ORANGE5_CONTEXT_CRYSTAL_NEEDS_WORK',
  generated_at: new Date().toISOString(),
  elapsed_ms: Number((performance.now() - started).toFixed(2)),
  corpus: { sources: sources.length, bytes: corpusBytes, roots: [...ROOTS, '10-RECEIPTS/spine-chain.jsonl'] },
  probes,
  proof: crystal.proof,
  verification,
  metrics: crystal.metrics,
  crystal_id: crystal.crystal_id,
  selected: crystal.selected,
  hot_context_sha256: sha256(crystal.hot_context),
};
receipt.receipt_hash = sha256(JSON.stringify(receipt));
fs.mkdirSync(RECEIPT_DIR, { recursive: true });
const stamp = receipt.generated_at.replace(/[:.]/g, '-');
const output = path.join(RECEIPT_DIR, `${stamp}-context-crystal-benchmark.json`);
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...receipt, receipt_path: output }, null, 2));
if (!receipt.status.endsWith('_GREEN')) process.exitCode = 1;
