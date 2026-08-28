import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const script = resolve(root, '00-CHARTER', 'services', 'orange5-operational-audit.ps1');
const run = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script], {
  cwd: root,
  encoding: 'utf8',
  timeout: 60_000,
});

if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  process.exit(1);
}

const receiptPath = run.stdout.trim().split(/\r?\n/).at(-1);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8').replace(/^\uFEFF/, ''));
const required = receipt.features.filter((feature) => feature.releaseRequired);
const retiredProxy = receipt.features.find((feature) => feature.id === 'codexa_ollama_proxy');
const rail = receipt.features.find((feature) => feature.id === 'codexa_command_rail');
const mirror = receipt.features.find((feature) => feature.id === 'ae_cobra_mirror');
const recall = receipt.features.find((feature) => feature.id === 'ae_memory_recall');
const countSum = Object.values(receipt.counts).reduce((sum, count) => sum + count, 0);

const checks = [
  ['all required features are operational', required.every((feature) => feature.status === 'OPERATIONAL')],
  ['all required features have semantic probes', required.every((feature) => feature.semantic?.checked === true)],
  ['all required semantic probes pass', required.every((feature) => feature.semantic?.ok === true)],
  ['counts equal feature inventory', countSum === receipt.features.length],
  ['retired proxy is outside release scope', retiredProxy?.status === 'REMOVED_FROM_SCOPE' && retiredProxy.releaseRequired === false],
  ['Codexa rail proves authenticated remote execution', rail?.semantic?.ok === true && rail.semantic.evidence.includes('hostname=CODEXA') && rail.semantic.evidence.includes('receipt=')],
  ['Cobra mirror proves fresh process-backed continuity', mirror?.semantic?.ok === true && mirror.semantic.evidence.includes('pid_alive=True')],
  ['AE Memory recall is grounded and hot-context clean', recall?.semantic?.ok === true && recall.semantic.evidence.includes('source_hashes_valid=True') && recall.semantic.evidence.includes('empty_thoughts=0')],
  ['verdict names required operational truth', receipt.verdict === 'ORANGE5_ALL_REQUIRED_OPERATIONAL'],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed += 1;
}
console.log(`operational audit: ${checks.length - failed}/${checks.length}`);
if (failed) process.exit(1);
