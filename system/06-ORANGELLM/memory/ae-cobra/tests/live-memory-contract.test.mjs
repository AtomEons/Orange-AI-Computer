import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFluxRecord, verifyChain, tailState, _internal } from '../flux/writer.mjs';
import { countEvents, readFlux } from '../flux/reader.mjs';
import { computeStateBrief } from '../mirage/state-brief.mjs';

const roots = [];
function root() {
  const value = mkdtempSync(join(tmpdir(), 'cobra-live-contract-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('live Flux contract', () => {
  test('writer output is readable and hash-verifiable', async () => {
    const fluxRoot = root();
    const record = await writeFluxRecord({
      lane: 'reality',
      origin: 'test',
      kind: 'receipt',
      body: { summary: 'OrangeFive memory contract proof', entities: ['OrangeFive'] },
      fluxRoot,
    });

    expect(record.hash).toHaveLength(64);
    expect(readFlux({ fluxRoot, lanes: ['reality'] })).toHaveLength(1);
    expect(countEvents({ fluxRoot }).reality).toBe(1);
    expect(verifyChain({ lane: 'reality', fluxRoot }).ok).toBe(true);
  });

  test('multi-term recall finds non-contiguous matching evidence', async () => {
    const fluxRoot = root();
    await writeFluxRecord({
      lane: 'reality',
      origin: 'test',
      kind: 'receipt',
      body: {
        summary: 'OrangeFive integrated AtomSmasher and repaired Cobra memory ingestion.',
        entities: ['rcpt_test'],
        files: ['06-ORANGELLM/memory/ae-cobra/mirage/state-brief.mjs'],
        commands: ['bun run verify'],
        risk: 'low',
        next_action: 'hydrate the source only when exact proof is required',
        confidence: 1,
      },
      fluxRoot,
    });

    const brief = computeStateBrief({ fluxRoot, query: 'AtomSmasher Cobra memory' });
    expect(brief.reality).toHaveLength(1);
    expect(brief.reality[0].id).not.toBe('unknown');
    expect(brief.reality[0].commands).toEqual(['bun run verify']);
    expect(brief.reality[0].source_pointer.hash).toHaveLength(64);
    expect(brief.reality[0].source_pointer.lane).toBe('reality');
    expect(brief.reality[0].next_action).toContain('hydrate');
  });

  test('natural-language query does not dilute the decisive recall terms', async () => {
    const fluxRoot = root();
    await writeFluxRecord({
      lane: 'reality',
      origin: 'test',
      kind: 'error',
      body: {
        summary: 'analyze.agent halted: adversarial gate halted: markerless refuter report lacks an explicit verification action',
        entities: ['analyze.agent', 'refuter'],
        confidence: 1,
      },
      fluxRoot,
    });

    const brief = computeStateBrief({
      fluxRoot,
      query: 'According to injected Orange memory, report why the markerless refuter halted analyze.agent. Do not invent anything.',
    });
    expect(brief.reality).toHaveLength(1);
    expect(brief.reality[0].summary).toContain('explicit verification action');
    expect(brief.retrieval.method).toBe('deterministic_ranked_token_overlap_v1');
  });

  test('rejection internals stay in cold truth but do not pollute hot recall', async () => {
    const fluxRoot = root();
    await writeFluxRecord({
      lane: 'thought', origin: 'ae_cobra_reject', kind: 'risk',
      body: { reason: 'parse_fail', raw_event: { summary: 'OrangeFive internal rejection' } },
      fluxRoot,
    });
    await writeFluxRecord({
      lane: 'reality', origin: 'operator', kind: 'receipt',
      body: { summary: 'OrangeFive grounded receipt', entities: ['OrangeFive'], confidence: 1 },
      fluxRoot,
    });

    expect(readFlux({ fluxRoot, lanes: ['thought'] })).toHaveLength(1);
    const brief = computeStateBrief({ fluxRoot, query: 'OrangeFive' });
    expect(brief.reality).toHaveLength(1);
    expect(brief.thought).toHaveLength(0);
    expect(brief.reality[0].summary).toBe('OrangeFive grounded receipt');
    expect(brief.recommended_next_action).toContain('grounded receipt');
  });

  test('durable writer extends a ledger containing historical learning-loop hashes', async () => {
    const fluxRoot = root();
    const lane = 'thought';
    const ts = Date.parse('2026-07-28T12:00:00Z');
    const legacy = {
      ts,
      lane,
      origin: 'historical-learning-loop',
      kind: 'mistake:proof',
      body: { summary: 'historical compatible record' },
      prev_hash: 'GENESIS',
    };
    legacy.hash = _internal.computeLegacyRecordHash(legacy);
    const dir = join(fluxRoot, 'events', lane);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-28.jsonl'), `${JSON.stringify(legacy)}\n`);

    const current = await writeFluxRecord({
      lane,
      origin: 'current-writer',
      kind: 'receipt',
      body: { summary: 'current canonical record' },
      fluxRoot,
      ts: Date.parse('2026-07-29T12:00:00Z'),
    });

    expect(current.prev_hash).toBe(legacy.hash);
    expect(verifyChain({ lane, fluxRoot })).toMatchObject({ ok: true, count: 2 });
    expect(tailState({ lane, fluxRoot })).toMatchObject({ priorSha: current.hash, count: 2, torn: false });
  });
});
