import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ORANGE5_ROOT as gateRoot } from '../../../04-CONTROL-PLANE/nine-gate-stack/root.mjs';
import { ORANGE5_ROOT as guardrailsRoot } from '../../../01-DOCTRINE/27-guardrails/lib/paths.mjs';
import { __trajectoryInternals } from '../../../10-RECEIPTS/tools/trajectory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const RUNTIME_FILES = [
  '01-DOCTRINE/27-guardrails/lib/paths.mjs',
  '01-DOCTRINE/27-guardrails/lib/soul-genome.mjs',
  '01-DOCTRINE/27-guardrails/checks/25-no-silent-routing-bypass.mjs',
  '01-DOCTRINE/27-guardrails/checks/g26-routing-law-honored.mjs',
  '04-CONTROL-PLANE/knowledge-strata/index.db.mjs',
  '04-CONTROL-PLANE/knowledge-strata/query.mjs',
  '04-CONTROL-PLANE/nine-gate-stack/root.mjs',
  '04-CONTROL-PLANE/nine-gate-stack/gates/00-lbce.mjs',
  '04-CONTROL-PLANE/nine-gate-stack/gates/03-triad.mjs',
  '04-CONTROL-PLANE/nine-gate-stack/gates/04-hre.mjs',
  '04-CONTROL-PLANE/nine-gate-stack/gates/05-security.mjs',
  '04-CONTROL-PLANE/nine-gate-stack/gates/06-drift.mjs',
  '04-CONTROL-PLANE/nine-gate-stack/gates/07-receipt.mjs',
  '04-CONTROL-PLANE/nine-gate-stack/gates/08-checkmate.mjs',
  '10-RECEIPTS/tools/trajectory.mjs',
  '11-MIRAGE/adapters/flux.mjs',
  '11-MIRAGE/adapters/graph.mjs',
  '11-MIRAGE/adapters/receipts.mjs',
  '16-TRAINING/scripts/expand-corpus.mjs',
  '16-TRAINING/minieyes/promote.mjs',
  '16-TRAINING/minieyes/eval.mjs',
  '16-TRAINING/minieyes/assemble.mjs',
  '16-TRAINING/ae-black-mamba/promote.mjs',
  '16-TRAINING/ae-black-mamba/pipeline.mjs',
  '16-TRAINING/ae-black-mamba/gbnf-alignment.mjs',
  '16-TRAINING/adapters/ae-misfit-v0/verify.mjs',
  '16-TRAINING/corpus/_tmp/merge.py',
  '06-ORANGELLM/reasoning/spiral/anchor.mjs',
  '07-VISUAL/all-run-gate/enumerate.mjs',
];

describe('OrangeFive runtime portability', () => {
  test('shared runtime roots resolve to the executing checkout', () => {
    expect(resolve(gateRoot)).toBe(ROOT);
    expect(resolve(guardrailsRoot)).toBe(ROOT);
    expect(resolve(__trajectoryInternals.DEFAULT_CHAIN)).toBe(
      resolve(ROOT, '10-RECEIPTS', 'spine-chain.jsonl'),
    );
  });

  test('core runtime modules contain no canonical-machine literal', () => {
    for (const relativePath of RUNTIME_FILES) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source).not.toMatch(/C:[\\/]AtomEons[\\/]Orange5/i);
    }
  });

  test('active routing doctrine cannot point back to the archived Orange3 cockpit', () => {
    const doctrineFiles = [
      '01-DOCTRINE/27-guardrails/lib/soul-genome.mjs',
      '01-DOCTRINE/27-guardrails/checks/25-no-silent-routing-bypass.mjs',
      '01-DOCTRINE/27-guardrails/checks/g26-routing-law-honored.mjs',
      '01-DOCTRINE/27-guardrails/registry.mjs',
      '01-DOCTRINE/27-guardrails/tools/triage-reds.mjs',
    ];
    for (const relativePath of doctrineFiles) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source).not.toMatch(/8787\/orange3|Orange3\/Orangebox routing/i);
    }
  });
});
