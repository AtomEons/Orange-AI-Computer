import { describe, expect, test } from 'bun:test';
import { __qualityInternals } from '../context-crystal-quality-benchmark.mjs';

describe('Context Crystal model-output repair', () => {
  test('uses the canonical current Navigator instead of the retired hot-v1 default', () => {
    expect(__qualityInternals.resolvedModel).not.toBe('orange-navigator:hot-v1');
    expect(__qualityInternals.resolvedModel).toBe('orange-navigator:ornith-1.5-9b-q4km');
  });

  test('never marks an incomplete case set green', () => {
    const complete = __qualityInternals.qualityStatus([{ passed: true }, { passed: true }], 2);
    const incomplete = __qualityInternals.qualityStatus([{ passed: true }], 2);
    const empty = __qualityInternals.qualityStatus([], 0);
    expect(complete).toMatchObject({ complete: true, passed: 2, failed: 0, status: 'ORANGE5_CONTEXT_CRYSTAL_QUALITY_GREEN' });
    expect(incomplete).toMatchObject({ complete: false, passed: 1, failed: 1, status: 'ORANGE5_CONTEXT_CRYSTAL_QUALITY_NEEDS_WORK' });
    expect(empty).toMatchObject({ complete: false, status: 'ORANGE5_CONTEXT_CRYSTAL_QUALITY_NEEDS_WORK' });
  });

  test('names required evidence explicitly instead of relying on source order', () => {
    const prompt = __qualityInternals.evidencePrompt('Question?', 'AIR:CC1', ['a.md', 'b.md'], ['b.md']);
    expect(prompt).toContain('Allowed source ids: a.md, b.md');
    expect(prompt).toContain('Required direct source ids: b.md');
    expect(prompt).toContain('At least one source_ids entry MUST be from the Required direct source ids list.');
  });

  test('unwraps complete nested JSON emitted inside the answer field', () => {
    const value = JSON.stringify({ answer: JSON.stringify({ answer: 'Direct answer.', source_ids: ['00-CHARTER/LAW.md'] }), source_ids: [] });
    expect(__qualityInternals.parseModelJson(value)).toMatchObject({
      answer: 'Direct answer.',
      source_ids: ['00-CHARTER/LAW.md'],
      repair: 'nested_json_unwrap',
    });
  });

  test('repairs a truncated nested packet only when answer and source evidence exist', () => {
    const nested = '{"answer":"Boundary retained.","source_ids":["01-DOCTRINE/LAW.md","00-CHARTER/PLAN.md"';
    const value = JSON.stringify({ answer: nested, source_ids: [] });
    expect(__qualityInternals.parseModelJson(value)).toMatchObject({
      answer: 'Boundary retained.',
      source_ids: ['01-DOCTRINE/LAW.md', '00-CHARTER/PLAN.md'],
      repair: 'truncated_nested_json_repair',
    });
  });

  test('repairs a directly truncated live packet after complete citations', () => {
    const value = '{"answer":"Boundary retained with source truth.","source_ids":["01-DOCTRINE/LAW.md","00-CHARTER/PLAN.md","12-ATOMSMASHER';
    expect(__qualityInternals.parseModelJson(value)).toMatchObject({
      answer: 'Boundary retained with source truth.',
      source_ids: ['01-DOCTRINE/LAW.md', '00-CHARTER/PLAN.md'],
      repair: 'truncated_json_repair',
    });
  });

  test('does not let a large context ratio rescue lower task quality', () => {
    const baseline = { coverage: 1, forbidden_hits: 0, source_ids_valid: true };
    const compressed = { coverage: 0.75, forbidden_hits: 0, source_ids_valid: true };
    expect(__qualityInternals.evaluateTurnPair(baseline, compressed)).toMatchObject({
      baseline_quality: true,
      compressed_quality: true,
      coverage_delta: -0.25,
      quality_parity: false,
      passed: false,
    });
  });

  test('requires the same quality floor and no coverage loss for parity', () => {
    const baseline = { coverage: 0.75, forbidden_hits: 0, source_ids_valid: true };
    const compressed = { coverage: 1, forbidden_hits: 0, source_ids_valid: true };
    expect(__qualityInternals.evaluateTurnPair(baseline, compressed)).toMatchObject({
      baseline_quality: true,
      compressed_quality: true,
      coverage_delta: 0.25,
      quality_parity: true,
      passed: true,
    });
  });

  test('rejects forged citations and predeclared forbidden claims', () => {
    const testCase = {
      required: ['law.md'],
      concepts: [/source truth/i],
      forbidden: [/model completion proves execution/i],
    };
    expect(__qualityInternals.scoreAnswer(testCase, {
      answer: 'Source truth says model completion proves execution.',
      source_ids: ['forged.md'],
    }, ['law.md'])).toMatchObject({
      coverage: 1,
      forbidden_hits: 1,
      source_ids_valid: false,
    });
  });

  test('sizes live context to the prompt instead of forcing 32K', () => {
    expect(__qualityInternals.contextWindowForPrompt('short prompt')).toBe(8_192);
    expect(__qualityInternals.contextWindowForPrompt('x'.repeat(26_000))).toBe(10_240);
    expect(__qualityInternals.contextWindowForPrompt('x'.repeat(100_000))).toBe(32_768);
  });

  test('builds a source-hashed oracle from fixed markdown sections', () => {
    const sourceMap = new Map([['law.md', [
      '# Law',
      'preamble',
      '## Target',
      'Direct governing evidence.',
      '### Detail',
      'Required nuance.',
      '## Next',
      'Unrelated material.',
    ].join('\n')]]);
    const testCase = {
      required: ['law.md'],
      oracleSections: [{ sourceId: 'law.md', heading: '## Target' }],
    };
    const oracle = __qualityInternals.buildOracleEvidence(testCase, sourceMap);
    expect(oracle.evidence).toContain('Direct governing evidence.');
    expect(oracle.evidence).toContain('Required nuance.');
    expect(oracle.evidence).not.toContain('Unrelated material.');
    expect(oracle.sections[0].source_sha256).toHaveLength(64);
    expect(oracle.sections[0].excerpt_sha256).toHaveLength(64);

    sourceMap.set('law.md', sourceMap.get('law.md').replace('## Target', '## Renamed'));
    expect(() => __qualityInternals.buildOracleEvidence(testCase, sourceMap)).toThrow('oracle heading missing');
  });
});
