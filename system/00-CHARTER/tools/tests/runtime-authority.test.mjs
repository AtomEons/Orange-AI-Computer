import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const charter = resolve(here, '..', '..');
const authority = readFileSync(resolve(charter, 'ORANGE5_RUNTIME_AUTHORITY.md'), 'utf8');
const master = readFileSync(resolve(charter, 'ORANGE5_MASTER_PLAN.md'), 'utf8');
const manual = readFileSync(resolve(charter, 'ORANGEFIVE_HOW_TO_USE.md'), 'utf8');

const checks = [
  ['runtime authority names the two-computer topology', authority.includes('OrangeFive is a two-computer system')],
  ['N150 is explicitly model-free by default', authority.includes('No answer model is required to remain resident')],
  ['Navigator current model is authoritative', authority.includes('orange-navigator:ornith-1.5-9b-q4km')],
  ['retired Q8 is not current manual authority', !manual.includes('orange-navigator:ornith-1.5-9b-q8')],
  ['heavy lane is bounded', authority.includes('qwen3-coder:30b') && authority.includes('bounded Codexa lease')],
  ['master plan points to runtime authority', master.includes('ORANGE5_RUNTIME_AUTHORITY.md')],
  ['operator manual no longer calls Smart Skinny active', !manual.includes('| Light | Smart Skinny | N150 |')],
  ['operator manual names zero-resident reflex', manual.includes('| Reflex | Bun Navigator Kernel | N150 |')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed += 1;
}
console.log(`runtime authority: ${checks.length - failed}/${checks.length}`);
if (failed) process.exit(1);
