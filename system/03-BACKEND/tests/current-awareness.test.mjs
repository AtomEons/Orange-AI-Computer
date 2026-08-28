import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildAwarenessBrief, buildScoutQuery, exportBehaviorLearningPack, getCurrentAwareness, projectTechnologySignals, readCurrentAwareness, recordCandidateBenchmark, sanitizeScoutIntent, shouldScoutIntent } from '../current-awareness.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('Orange current awareness', () => {
  test('triggers for technical creation and explicit freshness, not casual talk', () => {
    expect(shouldScoutIntent('build a local AI tool for receipts')).toBe(true);
    expect(shouldScoutIntent('what is the newest MCP runtime today')).toBe(true);
    expect(shouldScoutIntent('what is the current best Qwen model')).toBe(true);
    expect(shouldScoutIntent('report current runtime health')).toBe(false);
    expect(shouldScoutIntent('hello there')).toBe(false);
    expect(shouldScoutIntent('explain our existing architecture')).toBe(false);
  });

  test('adds exact project technologies to the scout query', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-project-'));
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fresh-app', dependencies: { hono: '^4.0.0', zod: '^3.0.0' } }));
    const project = { project: { root, name: 'Fresh App' } };
    expect(projectTechnologySignals(project)).toEqual(expect.arrayContaining(['fresh-app', 'hono', 'zod']));
    expect(buildScoutQuery('build an API', project)).toContain('hono');
  });

  test('extracts real intent from ChatML memory envelopes instead of scouting protocol tokens', () => {
    const chatml = `<|im_start|>system\nYou are a memory daemon. Emit only JSON.\n<|im_end|>\n<|im_start|>user\n{"summary":"Model routing option reviewed","reasoning":"replace Smart Skinny with a fast Qwen utility model"}\n<|im_end|>\n<|im_start|>assistant`;
    const clean = sanitizeScoutIntent(chatml);
    expect(clean).toContain('Model routing option reviewed');
    expect(clean).toContain('fast Qwen utility model');
    expect(clean).not.toContain('im_start');
    expect(clean).not.toContain('memory daemon');
    expect(buildScoutQuery(chatml)).toBe(clean);
  });

  test('persists a deduplicated candidate registry and reuses a fresh cache', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-awareness-'));
    dirs.push(root);
    let calls = 0;
    const collector = async () => {
      calls++;
      return {
        status: 'EVIDENCE_COLLECTED', elapsedMs: 12, errors: [], artifactPath: path.join(root, 'evidence.json'),
        sources: [
          { provider: 'github', title: 'lab/fresh-tool', url: 'https://github.com/lab/fresh-tool', summary: 'Fresh tool for local agent receipts', updatedAt: '2026-08-25T09:30:00Z', license: 'MIT', relevance: { score: 0.8, matched: 3, queryTerms: 4, terms: ['tool', 'agent', 'receipts'] }, authorityTier: 'registry_discovery' },
          { provider: 'npm', title: 'fresh-tool', url: 'https://www.npmjs.com/package/fresh-tool', summary: 'Fresh tool for agent receipts', updatedAt: '2026-08-25T09:45:00Z', version: '1.0.0', license: 'MIT', relevance: { score: 0.7, matched: 3, queryTerms: 4, terms: ['tool', 'agent', 'receipts'] }, authorityTier: 'registry_discovery' },
        ],
      };
    };
    const now = () => new Date('2026-08-25T10:00:00Z');
    const first = await getCurrentAwareness({ query: 'build a fresh agent receipt tool', ttlMs: 60_000 }, { root, collector, now });
    const second = await getCurrentAwareness({ query: 'build a fresh agent receipt tool', ttlMs: 60_000 }, { root, collector, now });
    expect(first.status).toBe('CURRENT_EVIDENCE_READY');
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(calls).toBe(1);
    expect(first.candidates.every((item) => item.lifecycle === 'BENCHMARK_REQUIRED' && item.promotionEligible === false)).toBe(true);
    expect(first.candidates.every((item) => item.freshness === 'NOW')).toBe(true);
    expect(first.brief).toContain('AIR:CURRENT.v1');
    expect(first.brief).toContain('not installed capability');
    const status = readCurrentAwareness({ root });
    expect(status.candidateCount).toBe(2);
    expect(status.lifecycle.BENCHMARK_REQUIRED).toBe(2);
  });

  test('does not preserve terminal lifecycle claims without a verifiable benchmark receipt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-awareness-'));
    dirs.push(root);
    const firstSeenAt = '2026-08-24T08:00:00Z';
    const provisionalHistory = [{ lifecycle: 'SOURCE_VERIFICATION_REQUIRED', at: firstSeenAt, reason: 'registry discovery' }];
    fs.writeFileSync(path.join(root, 'candidate-registry.json'), JSON.stringify({ candidates: [
      { provider: 'github', title: 'lab/provisional', url: 'https://github.com/lab/provisional', lifecycle: 'SOURCE_VERIFICATION_REQUIRED', firstSeenAt, lastSeenAt: firstSeenAt, seenCount: 3, history: provisionalHistory },
      { provider: 'github', title: 'lab/promoted', url: 'https://github.com/lab/promoted', lifecycle: 'PROMOTED', firstSeenAt, lastSeenAt: firstSeenAt, seenCount: 4, decisionReceiptSha256: 'a'.repeat(64) },
      { provider: 'github', title: 'lab/rejected', url: 'https://github.com/lab/rejected', lifecycle: 'REJECTED', firstSeenAt, lastSeenAt: firstSeenAt, seenCount: 5, decisionReceiptSha256: 'b'.repeat(64) },
    ] }));
    const collector = async () => ({
      status: 'EVIDENCE_COLLECTED', elapsedMs: 5, errors: [],
      sources: ['provisional', 'promoted', 'rejected'].map((name) => ({
        provider: 'github', title: `lab/${name}`, url: `https://github.com/lab/${name}`, summary: `${name} candidate`,
        updatedAt: '2026-08-25T09:30:00Z', license: 'MIT', lifecycle: 'BENCHMARK_REQUIRED',
        relevance: { score: 0.8, matched: 1, queryTerms: 1, terms: [name] }, authorityTier: 'registry_discovery',
      })),
    });

    await getCurrentAwareness({ query: 'refresh candidate lifecycle', force: true }, { root, collector, now: () => new Date('2026-08-25T10:00:00Z') });

    const registry = JSON.parse(fs.readFileSync(path.join(root, 'candidate-registry.json'), 'utf8'));
    const byName = new Map(registry.candidates.map((item) => [item.title, item]));
    expect(byName.get('lab/provisional')).toMatchObject({ lifecycle: 'BENCHMARK_REQUIRED', firstSeenAt, seenCount: 4, history: provisionalHistory, promotionEligible: false });
    expect(byName.get('lab/promoted')).toMatchObject({ lifecycle: 'BENCHMARK_REQUIRED', firstSeenAt, seenCount: 5, promotionEligible: false });
    expect(byName.get('lab/rejected')).toMatchObject({ lifecycle: 'BENCHMARK_REQUIRED', firstSeenAt, seenCount: 6, promotionEligible: false });
    expect(byName.get('lab/promoted').decisionReceiptSha256).toBeUndefined();
    expect(byName.get('lab/rejected').decisionReceiptSha256).toBeUndefined();
  });

  test('AtomSmasher bounds the live brief and reports saved work', () => {
    const candidates = Array.from({ length: 30 }, (_, index) => ({
      id: `c-${index}`, provider: 'github', title: `agent tool ${index}`, url: `https://github.com/lab/agent-${index}`,
      summary: `agent runtime receipt workflow ${'detail '.repeat(20)}`, freshness: 'RECENT', lifecycle: 'BENCHMARK_REQUIRED', license: 'MIT', relevance: { score: 0.8 },
    }));
    const result = buildAwarenessBrief({ query: 'build agent runtime receipt workflow', candidates, budgetBytes: 1_500 });
    expect(result.compression.keptItems).toBeLessThan(30);
    expect(result.compression.savedBytes).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.text)).toBeLessThan(3_000);
  });

  test('a failed scout attempt does not erase the last ready awareness snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-awareness-'));
    dirs.push(root);
    const readyCollector = async () => ({
      status: 'EVIDENCE_COLLECTED', elapsedMs: 4, errors: [],
      sources: [{
        provider: 'github', title: 'lab/current-tool', url: 'https://github.com/lab/current-tool', summary: 'Current local agent tool',
        updatedAt: '2026-08-25T09:30:00Z', license: 'MIT', relevance: { score: 0.9, matched: 3, queryTerms: 3, terms: ['current', 'agent', 'tool'] }, authorityTier: 'registry_discovery',
      }],
    });
    await getCurrentAwareness({ query: 'current agent tool', force: true }, { root, collector: readyCollector, now: () => new Date('2026-08-25T10:00:00Z') });
    await getCurrentAwareness({ query: 'failed second scout', force: true }, {
      root,
      collector: async () => ({ status: 'NO_EVIDENCE', elapsedMs: 3, errors: ['offline'], sources: [] }),
      now: () => new Date('2026-08-25T10:01:00Z'),
    });
    const status = readCurrentAwareness({ root });
    expect(status.ready).toBe(true);
    expect(status.degraded).toBe(true);
    expect(status.latest.status).toBe('CURRENT_EVIDENCE_READY');
    expect(status.latest.query).toBe('current agent tool');
    expect(status.latestAttempt.status).toBe('CURRENT_EVIDENCE_UNAVAILABLE');
  });

  test('quarantines stale, undated, and future-dated sources without replacing ready evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-awareness-'));
    dirs.push(root);
    const now = () => new Date('2026-08-25T10:00:00Z');
    await getCurrentAwareness({ query: 'known current tool', force: true }, { root, collector: candidateCollector(), now });
    const staleAttempt = await getCurrentAwareness({ query: 'stale tool scan', force: true }, {
      root,
      now,
      collector: async () => ({
        status: 'EVIDENCE_COLLECTED', elapsedMs: 4, errors: [],
        sources: [
          researchSource({ title: 'lab/stale', url: 'https://github.com/lab/stale', updatedAt: '2026-06-01T00:00:00Z' }),
          researchSource({ title: 'lab/undated', url: 'https://github.com/lab/undated', updatedAt: null }),
          researchSource({ title: 'lab/future', url: 'https://github.com/lab/future', updatedAt: '2026-08-26T10:00:00Z' }),
        ],
      }),
    });
    expect(staleAttempt.status).toBe('CURRENT_EVIDENCE_STALE');
    expect(staleAttempt).toMatchObject({ currentSourceCount: 0, staleSourceCount: 1, unverifiedFreshnessCount: 2 });
    const byTitle = new Map(staleAttempt.candidates.map((item) => [item.title, item]));
    expect(byTitle.get('lab/stale')).toMatchObject({ freshness: 'STALE', lifecycle: 'SOURCE_REFRESH_REQUIRED', quarantineStatus: 'QUARANTINED', promotionEligible: false });
    expect(byTitle.get('lab/undated')).toMatchObject({ freshnessStatus: 'UNDATED', lifecycle: 'FRESHNESS_VERIFICATION_REQUIRED' });
    expect(byTitle.get('lab/future')).toMatchObject({ freshnessStatus: 'FUTURE_DATED', lifecycle: 'SOURCE_TIMESTAMP_INVALID' });
    const status = readCurrentAwareness({ root });
    expect(status.ready).toBe(true);
    expect(status.degraded).toBe(true);
    expect(status.latest.query).toBe('known current tool');
    expect(status.latestAttempt.status).toBe('CURRENT_EVIDENCE_STALE');
  });

  test('refreshes a cached scout before a source crosses its stale boundary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-awareness-'));
    dirs.push(root);
    let calls = 0;
    const collector = async () => {
      calls++;
      return { status: 'EVIDENCE_COLLECTED', elapsedMs: 4, errors: [], sources: [researchSource()] };
    };
    const first = await getCurrentAwareness({ query: 'cache freshness boundary', ttlMs: 86_400_000, staleAfterMs: 3_600_000 }, {
      root, collector, now: () => new Date('2026-08-25T10:00:00Z'),
    });
    const second = await getCurrentAwareness({ query: 'cache freshness boundary', ttlMs: 86_400_000, staleAfterMs: 3_600_000 }, {
      root, collector, now: () => new Date('2026-08-25T10:31:00Z'),
    });
    expect(first.status).toBe('CURRENT_EVIDENCE_READY');
    expect(second.status).toBe('CURRENT_EVIDENCE_STALE');
    expect(second.cacheHit).toBe(false);
    expect(calls).toBe(2);
    expect(readCurrentAwareness({ root, now: new Date('2026-08-25T10:31:00Z') }).ready).toBe(false);
  });

  test('promotes only a fresh candidate whose measured receipt beats the incumbent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-awareness-'));
    dirs.push(root);
    const now = () => new Date('2026-08-25T10:00:00Z');
    const scout = await getCurrentAwareness({ query: 'candidate proof', force: true }, { root, collector: candidateCollector(), now });
    const decision = recordCandidateBenchmark(benchmarkInput(root, scout.candidates[0].id), { now: () => new Date('2026-08-25T10:01:00Z') });
    expect(decision).toMatchObject({ status: 'CANDIDATE_PROMOTED', lifecycle: 'PROMOTED', promotionEligible: true });
    expect(decision.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(decision.receiptPath)).toBe(true);

    let status = readCurrentAwareness({ root });
    expect(status.invalidDecisionCount).toBe(0);
    expect(status.lifecycle.PROMOTED).toBe(1);

    await getCurrentAwareness({ query: 'candidate proof refresh', force: true }, { root, collector: candidateCollector(), now: () => new Date('2026-08-25T10:02:00Z') });
    status = readCurrentAwareness({ root });
    expect(status.lifecycle.PROMOTED).toBe(1);

    fs.appendFileSync(decision.receiptPath, ' ');
    status = readCurrentAwareness({ root });
    expect(status.invalidDecisionCount).toBe(1);
    expect(status.lifecycle.BENCHMARK_REQUIRED).toBe(1);
    expect(status.lifecycle.PROMOTED).toBeUndefined();
  });

  test('retains the incumbent when required metrics regress', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-awareness-'));
    dirs.push(root);
    const scout = await getCurrentAwareness({ query: 'candidate regression', force: true }, {
      root, collector: candidateCollector(), now: () => new Date('2026-08-25T10:00:00Z'),
    });
    const input = benchmarkInput(root, scout.candidates[0].id);
    input.comparisons[0].candidate = 0.7;
    const decision = recordCandidateBenchmark(input, { now: () => new Date('2026-08-25T10:01:00Z') });
    expect(decision).toMatchObject({ status: 'INCUMBENT_RETAINED', lifecycle: 'REJECTED', promotionEligible: false });
    expect(readCurrentAwareness({ root }).lifecycle.REJECTED).toBe(1);
  });

  test('refuses promotion when a benchmark artifact does not match its claimed hash', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-awareness-'));
    dirs.push(root);
    const scout = await getCurrentAwareness({ query: 'candidate artifact integrity', force: true }, {
      root, collector: candidateCollector(), now: () => new Date('2026-08-25T10:00:00Z'),
    });
    const input = benchmarkInput(root, scout.candidates[0].id);
    fs.appendFileSync(input.candidate.artifactPath, 'tampered');
    expect(() => recordCandidateBenchmark(input)).toThrow('candidate benchmark artifact hash mismatch');
    expect(readCurrentAwareness({ root }).lifecycle.BENCHMARK_REQUIRED).toBe(1);
  });

  test('refuses a benchmark decision after the registered source expires', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-awareness-'));
    dirs.push(root);
    const scout = await getCurrentAwareness({ query: 'expired candidate proof', force: true }, {
      root, collector: candidateCollector(), now: () => new Date('2026-08-25T10:00:00Z'),
    });
    const input = benchmarkInput(root, scout.candidates[0].id);
    expect(() => recordCandidateBenchmark(input, { now: () => new Date('2026-09-25T10:00:00Z') }))
      .toThrow('candidate freshness gate is not satisfied: STALE');
    expect(readCurrentAwareness({ root }).lifecycle.BENCHMARK_REQUIRED).toBe(1);
  });

  test('LoRA export learns resolved decision discipline, not current facts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-awareness-'));
    dirs.push(root);
    const now = () => new Date('2026-08-25T10:00:00Z');
    return getCurrentAwareness({ query: 'learning candidate', force: true }, { root, collector: candidateCollector(), now }).then((scout) => {
      recordCandidateBenchmark(benchmarkInput(root, scout.candidates[0].id), { now: () => new Date('2026-08-25T10:01:00Z') });
      const result = exportBehaviorLearningPack({ root });
      expect(result.rows).toBe(1);
      expect(result.factsBakedIntoWeights).toBe(false);
      expect(fs.readFileSync(result.path, 'utf8')).toContain('requires_benchmark_receipt');
    });
  });
});

function researchSource(overrides = {}) {
  return {
    provider: 'github',
    sourceId: 'lab/current-tool',
    title: 'lab/current-tool',
    url: 'https://github.com/lab/current-tool',
    summary: 'Current local agent tool with benchmark receipts',
    updatedAt: '2026-08-25T09:30:00Z',
    license: 'MIT',
    relevance: { score: 0.9, matched: 3, queryTerms: 3, terms: ['current', 'agent', 'tool'] },
    authorityTier: 'creator_registry_source',
    sourceQuality: 0.9,
    lifecycle: 'BENCHMARK_REQUIRED',
    ...overrides,
  };
}

function candidateCollector() {
  return async () => ({ status: 'EVIDENCE_COLLECTED', elapsedMs: 4, errors: [], sources: [researchSource()] });
}

function benchmarkInput(root, candidateId) {
  const workload = benchmarkArtifact(root, 'held-out-orange-workload-v1', { cases: ['a', 'b', 'c'] });
  const incumbent = benchmarkArtifact(root, 'current-orange-path', { quality: 0.8, latencyMs: 100 });
  const candidate = benchmarkArtifact(root, 'lab-current-tool', { quality: 0.9, latencyMs: 95 });
  return {
    root,
    candidateId,
    workload,
    incumbent,
    candidate,
    gates: {
      sourceVerified: true,
      freshnessVerified: true,
      licenseAccepted: true,
      localCompatibilityPassed: true,
      riskAccepted: true,
    },
    comparisons: [
      { name: 'task-quality', direction: 'higher', incumbent: 0.8, candidate: 0.9, tolerance: 0.01 },
      { name: 'latency-ms', direction: 'lower', incumbent: 100, candidate: 95, tolerance: 5 },
    ],
  };
}

function benchmarkArtifact(root, name, value) {
  const artifactRoot = path.join(root, 'benchmark-artifacts');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const artifactPath = path.join(artifactRoot, `${name}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(value)}\n`);
  return {
    name,
    artifactPath,
    artifactSha256: crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex'),
  };
}
