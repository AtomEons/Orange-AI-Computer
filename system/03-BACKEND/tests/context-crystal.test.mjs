#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { __contextCrystalInternals, compileContextCrystal, verifyContextCrystal } from '../context-crystal.mjs';

function corpus() {
  const sources = [{
    id: 'law',
    pointer: 'inline://law',
    pinned: true,
    authority: 1,
    content: 'OrangeFive law: live receipts outrank prose. Never fake green. Codexa runs heavy compute.',
  }];
  for (let i = 0; i < 1_000; i += 1) {
    sources.push({
      id: `noise-${i}`,
      pointer: `fixture://noise-${i}`,
      content: `Unrelated archive record ${i}. ${'historical filler '.repeat(30)}`,
    });
  }
  sources.push({
    id: 'memory-route',
    pointer: 'fixture://memory-route',
    content: 'Project recall requests route through POST /v1/memory/recall with source-backed evidence.',
  });
  return sources;
}

describe('proof-carrying Context Crystal', () => {
  test('exceeds 200x operational context reduction without hiding source truth', () => {
    const sources = corpus();
    const crystal = compileContextCrystal({
      task: 'Which memory route recalls the OrangeFive project and what law prevents fake green?',
      sources,
      budgetBytes: 2_000,
      requiredSourceIds: ['law'],
    });
    expect(crystal.proof.complete).toBe(true);
    expect(crystal.metrics.target_200x_met).toBe(true);
    expect(crystal.hot_context).toContain('/v1/memory/recall');
    expect(crystal.hot_context).toContain('Never fake green');
    expect(crystal.metrics.tokens_not_injected).toBeGreaterThan(100_000);
    const byId = new Map(sources.map((source) => [source.id, source.content]));
    expect(verifyContextCrystal(crystal, (id) => byId.get(id)).ok).toBe(true);
    expect(crystal.hot_context).toContain('AIR:CC1');
    expect(crystal.selected[0].source_sha256).toHaveLength(64);
    expect(crystal.selected[0].chunk_sha256).toHaveLength(64);
  });

  test('detects changed source instead of serving stale truth', () => {
    const sources = corpus();
    const crystal = compileContextCrystal({
      task: 'Which memory route recalls the project?',
      sources,
      budgetBytes: 1_500,
      requiredSourceIds: ['law'],
    });
    const byId = new Map(sources.map((source) => [source.id, source.content]));
    byId.set('memory-route', 'changed source');
    const verified = verifyContextCrystal(crystal, (id) => byId.get(id));
    expect(verified.ok).toBe(false);
    expect(verified.errors.some((error) => error.includes('source changed'))).toBe(true);
  });

  test('is deterministic except for no timestamps or process state', () => {
    const input = {
      task: 'Which memory route recalls the project?',
      sources: corpus(),
      budgetBytes: 1_500,
      requiredSourceIds: ['law'],
    };
    expect(compileContextCrystal(input).crystal_id).toBe(compileContextCrystal(input).crystal_id);
  });

  test('ranks exact capability law above generic architecture prose', () => {
    const task = 'What is the Capability Covenant and what happens when a specialist answer is too weak?';
    const generic = 'The architecture includes a capability covenant and specialist routes inside a larger operating system.';
    const exact = 'Capability Covenant: every specialist receives a minimum intelligence class. A weaker fallback cannot impersonate it; repair once or block.';
    expect(__contextCrystalInternals.lexicalScore(task, exact)).toBeGreaterThan(__contextCrystalInternals.lexicalScore(task, generic));
  });

  test('keeps markdown headings attached to the section body', () => {
    const prefix = `${'preface filler '.repeat(48)}\n`;
    const content = `${prefix}## Receipt-to-Reflex Compiler\nHeld-out counterexamples test a bounded reversible rule before promotion.\n${'later section detail '.repeat(24)}`;
    const chunks = __contextCrystalInternals.chunkSource({
      id: 'doctrine',
      content,
      pointer: 'inline://doctrine',
      authority: 1,
      pinned: false,
      source_sha256: 'fixture',
    });
    const section = chunks.find((chunk) => chunk.content.includes('Receipt-to-Reflex Compiler'));
    expect(section.content.startsWith('## Receipt-to-Reflex Compiler')).toBe(true);
    expect(section.content).toContain('Held-out counterexamples');
  });

  test('does not use source authority as a substitute for task relevance', () => {
    const crystal = compileContextCrystal({
      task: 'Explain receipt-to-reflex held-out counterexamples and reversible demotion.',
      budgetBytes: 1_100,
      sources: [
        {
          id: 'unrelated-charter',
          pointer: 'inline://unrelated-charter',
          authority: 1,
          content: 'Premium visual styling and window motion settings. '.repeat(18),
        },
        {
          id: 'learning-law',
          pointer: 'inline://learning-law',
          authority: 0.1,
          content: 'Receipt-to-Reflex candidates must pass held-out counterexamples. Promotion is bounded and reversible; contradiction or source change demotes the rule.',
        },
      ],
      requiredSourceIds: ['learning-law'],
    });
    expect(crystal.hot_context).toContain('held-out counterexamples');
    expect(crystal.hot_context).not.toContain('Premium visual styling');
  });
});
