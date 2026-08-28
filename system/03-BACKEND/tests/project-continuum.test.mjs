import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { continuityPreflight, enforceContinuityReport, queryProjectContinuum, recordContinuityTurn, refreshProjectContinuum, renderContinuityAir } from '../project-continuum.mjs';

let scratch = null;
afterEach(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); scratch = null; });

function fixture() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-continuum-'));
  fs.mkdirSync(path.join(scratch, '00-CHARTER'), { recursive: true });
  fs.mkdirSync(path.join(scratch, '16-TRAINING', 'adapters', 'navigator'), { recursive: true });
  fs.writeFileSync(path.join(scratch, '00-CHARTER', 'law.md'), '# Law\nNever fake green.');
  fs.writeFileSync(path.join(scratch, '16-TRAINING', 'adapters', 'navigator', 'README.md'), '# Existing LoRA\nOrange Navigator compliance adapter is already trained.');
  return { root: scratch, dbPath: path.join(scratch, 'continuum.db') };
}

describe('Orange project continuum', () => {
  test('indexes exact project sources and finds existing training lineage', () => {
    const options = fixture();
    const receipt = refreshProjectContinuum(options);
    expect(receipt.total_sources).toBe(2);
    expect(receipt.errors).toEqual([]);
    expect(receipt.state_path).toBe(path.join(options.root, 'project-continuum-latest.json'));
    expect(fs.existsSync(receipt.state_path)).toBe(true);
    const result = continuityPreflight('Should we train a Kaggle LoRA for Orange Navigator?', options);
    expect(result.available).toBe(true);
    expect(result.training_lineage_found).toBe(true);
    expect(result.training_paths[0]).toContain('16-TRAINING');
    expect(renderContinuityAir(result)).toContain('Inspect existing lineage');
  });

  test('refresh replaces changed source instead of returning stale text', () => {
    const options = fixture();
    refreshProjectContinuum(options);
    const file = path.join(options.root, '00-CHARTER', 'law.md');
    fs.writeFileSync(file, '# Law\nReceipts outrank claims.');
    refreshProjectContinuum(options);
    expect(queryProjectContinuum('receipts outrank claims', options).hits[0].excerpt).toContain('Receipts outrank claims');
    expect(queryProjectContinuum('never fake green', options).hits).toHaveLength(0);
  });

  test('forces training requests to inspect existing adapters before retraining', () => {
    const envelope = { choices: [{ message: { content: JSON.stringify({
      status: 'needs_action', findings: [], nextAction: 'start a new Kaggle LoRA training run',
    }) } }] };
    const result = enforceContinuityReport(envelope, {
      existing_lineage_found: true,
      duplicate_sensitive: true,
      training_lineage_found: true,
      training_paths: ['16-TRAINING/adapters/navigator/README.md'],
      hits: [{ path: '16-TRAINING/adapters/navigator/README.md' }],
    });
    const report = JSON.parse(envelope.choices[0].message.content);
    expect(result.enforced).toBe(true);
    expect(report.findings[0]).toContain('existing_project_lineage');
    expect(report.nextAction).toContain('benchmark existing training lineage');
  });

  test('records governed turns as searchable cold truth and redacts obvious secrets', () => {
    const options = fixture();
    refreshProjectContinuum(options);
    const recorded = recordContinuityTurn({
      orderId: 'turn-remember-1',
      userText: 'Remember the Aurora routing decision. api_key=sk-example-secret-value',
      assistantText: 'Aurora uses the heavy lease because the proof risk is high.',
      route: { tier: 'heavy' },
      status: 'needs_action',
    }, options);
    expect(recorded.recorded).toBe(true);
    expect(recorded.redactions).toBe(1);
    const recalled = queryProjectContinuum('Aurora routing decision', options);
    expect(recalled.hits[0].path).toBe('runtime://turn/turn-remember-1');
    expect(recalled.hits[0].excerpt).toContain('[REDACTED_SECRET]');
    expect(recalled.hits[0].excerpt).not.toContain('sk-example-secret-value');
  });
});
