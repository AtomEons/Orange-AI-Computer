import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSourceBackedWorkbench, SOURCE_BACKED_WORKBENCH_SCHEMA } from '../memory-context.mjs';
import { recordContradictionDebt } from '../memory-runtime.mjs';
import { verifyEquationPacket } from '../numeric-equation-packet.mjs';
import { SourceViewStore, TRANSFORM_N } from '../source-view-store.mjs';
import { hydrateTranscriptHit, ingestTranscript, searchSuperdirectory } from '../superdirectory.mjs';
import { verifyChainStream } from '../../06-ORANGELLM/memory/ae-cobra/flux/reader.mjs';

const roots = [];
const ACCESS = { reader: 'operator', project: 'orange5', purpose: 'evidence-replay' };
const AUTHORITY = { readers: ['operator'], projects: ['orange5'], purposes: ['evidence-replay'] };

const RETRYABLE_REMOVE_ERRORS = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

async function removeTemporaryRoot(root) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!RETRYABLE_REMOVE_ERRORS.has(error?.code) || attempt === 19) throw error;
      await Bun.sleep(50);
    }
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-workbench-'));
  roots.push(root);
  return {
    root,
    sourceViewRoot: path.join(root, 'source-view'),
    superdirectoryRoot: path.join(root, 'superdirectory'),
    fluxRoot: path.join(root, 'flux'),
    debtFluxRoot: path.join(root, 'debt-flux'),
    transcript: path.join(root, 'codex.jsonl'),
  };
}

function putWorkbenchSource(store, record) {
  return store.putSource({
    bytes: Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'),
    authority: AUTHORITY,
    retention: { policy: 'project-history', minimumDays: 365 },
  });
}

function sourceRecord({ id, body, answer, project = 'Orange5', authority, observedAt, semantic, claim, supersedes = [] }) {
  return {
    id,
    title: 'Gateway runtime evidence',
    body,
    acceptedAnswer: { text: answer },
    workbench: {
      project,
      authority_score: authority,
      authority_basis: authority >= 0.9 ? 'receipt' : 'memory',
      observed_at: observedAt,
      semantic_score: semantic,
      semantic_provider: 'fixture-dense-v1',
      claim_key: 'gateway-port',
      claim,
      supersedes,
    },
  };
}

function codexMessage(text, timestamp = '2026-08-28T05:30:00.000Z') {
  return JSON.stringify({
    type: 'response_item',
    timestamp,
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
}

describe('source-backed task workbench', () => {
  test('combines six retrieval signals, supersedes stale evidence, records debt, hydrates disk, and carries residuals', async () => {
    const paths = fixture();
    const store = new SourceViewStore(paths.sourceViewRoot);
    putWorkbenchSource(store, sourceRecord({
      id: 'gateway-stale',
      body: 'An older memory says the gateway port is 7331.',
      answer: 'Gateway port 7331.',
      authority: 0.45,
      observedAt: '2026-08-20T00:00:00.000Z',
      semantic: 0.8,
      claim: '7331',
    }));
    putWorkbenchSource(store, sourceRecord({
      id: 'gateway-current',
      body: 'A fresh exact-path receipt proves the current gateway port is 1337.',
      answer: 'Gateway port 1337.',
      authority: 0.95,
      observedAt: '2026-08-28T05:20:00.000Z',
      semantic: 0.92,
      claim: '1337',
      supersedes: ['gateway-stale'],
    }));
    putWorkbenchSource(store, sourceRecord({
      id: 'gateway-current-support',
      body: 'An independent source agrees that the current gateway port is 1337.',
      answer: 'Gateway port 1337.',
      authority: 0.8,
      observedAt: '2026-08-28T05:15:00.000Z',
      semantic: 0.88,
      claim: '1337',
    }));
    putWorkbenchSource(store, sourceRecord({
      id: 'other-project',
      body: 'Another project uses gateway port 9999.',
      answer: 'Gateway port 9999.',
      project: 'OtherProject',
      authority: 1,
      observedAt: '2026-08-28T05:25:00.000Z',
      semantic: 1,
      claim: '9999',
    }));
    store.rebuildDerivedIndex({ transformVersionForSource: () => TRANSFORM_N });

    fs.writeFileSync(paths.transcript, `${codexMessage('Check the current gateway port receipt and the latency trend before answering.')}\n`);
    await ingestTranscript({ provider: 'codex', sourcePath: paths.transcript }, {
      root: paths.superdirectoryRoot,
      fluxRoot: paths.fluxRoot,
    });
    const transcriptHit = searchSuperdirectory('gateway port latency', { root: paths.superdirectoryRoot, limit: 1 })[0];
    const values = Array.from({ length: 1_000 }, (_, index) => 20 + index * 0.25);
    values[417] += 8;

    const workbench = await buildSourceBackedWorkbench({
      task: 'Which gateway port is current, why, and what does the latency trend show?',
      project: 'Orange5',
      sourceViewStore: store,
      sourceViewAccess: ACCESS,
      transcriptRoot: paths.superdirectoryRoot,
      transcriptHits: [{
        ...transcriptHit,
        workbench: {
          project: 'Orange5', semantic_score: 0.75, authority_score: 0.6,
          authority_basis: 'transcript', observed_at: transcriptHit.ts,
        },
      }],
      numericSeries: [{ name: 'gateway_latency', values, units: 'ms', sourcePointer: 'receipt://gateway-latency' }],
      requiredSourceIds: ['gateway-current'],
      budgetBytes: 5_000,
      now: '2026-08-28T06:00:00.000Z',
      debtRecorder: (debt) => recordContradictionDebt(debt, { fluxRoot: paths.debtFluxRoot }),
    });

    expect(workbench.schema).toBe(SOURCE_BACKED_WORKBENCH_SCHEMA);
    expect(workbench.selected.map((item) => item.id)).toContain('gateway-current');
    expect(workbench.selected.map((item) => item.id)).not.toContain('gateway-stale');
    expect(workbench.rejected).toContainEqual(expect.objectContaining({ id: 'other-project', reason: 'project_mismatch' }));
    const current = workbench.ranked.find((item) => item.id === 'gateway-current');
    expect(Object.keys(current)).toEqual([
      'id', 'content', 'project', 'claim_key', 'claim', 'why', 'source', 'confidence', 'supersession',
    ]);
    expect(Object.keys(current.why.signals)).toEqual(['lexical', 'semantic', 'project', 'authority', 'recency', 'contradiction']);
    expect(current.why).toEqual({
      signals: {
        lexical: { score: 0.2222, matched_terms: ['gateway', 'port'] },
        semantic: { score: 0.92, provider: 'fixture-dense-v1' },
        project: { score: 1, match: true, candidate: 'Orange5', target: 'Orange5' },
        authority: { score: 0.95, basis: 'receipt' },
        recency: {
          score: 0.9991,
          observed_at: '2026-08-28T05:20:00.000Z',
          age_days: 0.0278,
          future_dated: false,
        },
        contradiction: { score: 1, state: 'current' },
      },
      weights: { lexical: 0.22, semantic: 0.22, project: 0.16, authority: 0.18, recency: 0.12, contradiction: 0.1 },
      contributions: { lexical: 0.0489, semantic: 0.2024, project: 0.16, authority: 0.171, recency: 0.1199, contradiction: 0.1 },
      formula: 'sum(signal.score * weight)',
      total_score: 0.8022,
      summary: 'lexical=0.2222; semantic=0.92; project=1; authority=0.95; recency=0.9991; contradiction=1',
    });
    expect(current.source).toMatchObject({ verified: true, authorized: true, source_id: 'gateway-current' });
    expect(Object.keys(current.source)).toEqual([
      'kind', 'path', 'sha256', 'offset', 'bytes', 'event_sha256', 'text_sha256', 'source_id',
      'json_pointer', 'authority_hash', 'retention_hash', 'verification', 'authorized', 'verified',
    ]);
    expect(current.source.verification).toEqual({ algorithm: 'sha256', scope: 'file', matched: true });
    expect(current.source.sha256).toHaveLength(64);
    expect(current.confidence).toBe(0.8022);
    expect(current.supersession).toEqual({
      state: 'current',
      basis: 'explicit-supersession',
      claim_key: 'gateway-port',
      supersedes: ['gateway-stale'],
      superseded_by: null,
      conflicts_with: ['gateway-stale'],
    });

    expect(workbench.superseded[0]).toMatchObject({
      id: 'gateway-stale',
      supersession: { state: 'superseded', basis: 'explicit-supersession', superseded_by: 'gateway-current' },
    });
    expect(workbench.ranked.find((item) => item.id === 'gateway-current-support').supersession)
      .toMatchObject({ state: 'current', basis: 'agrees-with-current', superseded_by: null });
    expect(workbench.contradiction_debt[0]).toMatchObject({
      status: 'resolved', claim_key: 'gateway-port', winner_id: 'gateway-current',
      resolution_basis: 'explicit-supersession',
    });
    expect(workbench.contradiction_debt[0].claim_variants).toHaveLength(2);
    expect(workbench.contradiction_debt_receipts[0]).toMatchObject({ lane: 'reality', deduped: false });
    expect(workbench.contradiction_debt_receipts[0].hash).toHaveLength(64);
    expect(verifyChainStream({ fluxRoot: paths.debtFluxRoot, lane: 'reality' }).ok).toBe(true);

    expect(workbench.transcript_hydration[0].source).toMatchObject({
      verified: true, path: expect.stringContaining('superdirectory'),
    });
    expect(workbench.transcript_hydration[0].source.event_sha256).toHaveLength(64);
    expect(workbench.equation_packets).toHaveLength(1);
    expect(workbench.equation_packets[0].metrics.residual_count).toBe(1);
    expect(verifyEquationPacket(workbench.equation_packets[0], { expectedValues: values }).ok).toBe(true);
    expect(workbench.context_crystal.hot_context).toContain('Gateway port 1337');
    expect(workbench.context_crystal.hot_context).toContain('N:gateway_latency=');
    expect(Object.values(workbench.proof).every(Boolean)).toBe(true);
  }, 30_000);

  test('keeps equally authoritative conflicting claims contested instead of silently choosing', async () => {
    const paths = fixture();
    const store = new SourceViewStore(paths.sourceViewRoot);
    for (const [id, claim] of [['claim-a', 'alpha'], ['claim-b', 'beta']]) {
      putWorkbenchSource(store, sourceRecord({
        id,
        body: `Current release channel claim is ${claim}.`,
        answer: `Release channel ${claim}.`,
        authority: 0.8,
        observedAt: '2026-08-28T05:00:00.000Z',
        semantic: 0.9,
        claim,
      }));
    }
    store.rebuildDerivedIndex({ transformVersionForSource: () => TRANSFORM_N });

    const workbench = await buildSourceBackedWorkbench({
      task: 'What is the current release channel claim?',
      project: 'Orange5',
      sourceViewStore: store,
      sourceViewAccess: ACCESS,
      now: '2026-08-28T06:00:00.000Z',
      limit: 1,
      budgetBytes: 3_000,
    });

    expect(workbench.contradiction_debt[0]).toMatchObject({ status: 'open', winner_id: null });
    expect(workbench.selected.map((item) => item.id).sort()).toEqual(['claim-a', 'claim-b']);
    expect(workbench.selected.every((item) => item.supersession.state === 'contested')).toBe(true);
    expect(workbench.selected.every((item) => item.confidence <= 0.55)).toBe(true);
    expect(workbench.context_crystal.proof.required_sources_retained).toBe(true);
  });

  test('reports a missing required source instead of filtering it from proof', async () => {
    const paths = fixture();
    const store = new SourceViewStore(paths.sourceViewRoot);
    putWorkbenchSource(store, sourceRecord({
      id: 'available-source',
      body: 'The available gateway record is source backed.',
      answer: 'Gateway record available.',
      authority: 0.8,
      observedAt: '2026-08-28T05:00:00.000Z',
      semantic: 0.8,
      claim: 'available',
    }));
    store.rebuildDerivedIndex({ transformVersionForSource: () => TRANSFORM_N });

    const workbench = await buildSourceBackedWorkbench({
      task: 'Find the available gateway record.',
      project: 'Orange5',
      sourceViewStore: store,
      sourceViewAccess: ACCESS,
      requiredSourceIds: ['missing-source'],
      now: '2026-08-28T06:00:00.000Z',
    });

    expect(workbench.context_crystal.proof).toMatchObject({
      required_sources_retained: false,
      missing_required_sources: ['missing-source'],
      complete: false,
    });
    expect(workbench.proof).toMatchObject({ required_sources_retained: false, crystal_complete: false });
  });

  test('rehashes named paths even when a candidate claims prior verification', async () => {
    const paths = fixture();
    const changedPath = path.join(paths.root, 'changed.txt');
    const validPath = path.join(paths.root, 'valid.txt');
    fs.writeFileSync(changedPath, 'before');
    const changedHash = createHash('sha256').update('before').digest('hex');
    fs.writeFileSync(changedPath, 'after');
    fs.writeFileSync(validPath, 'stable');
    const validHash = createHash('sha256').update('stable').digest('hex');

    const workbench = await buildSourceBackedWorkbench({
      task: 'Which evidence path is stable?',
      candidates: [
        {
          id: 'changed', content: 'Changed evidence.',
          source: { path: changedPath, sha256: changedHash, authorized: true, verified: true },
        },
        {
          id: 'stable', content: 'Stable evidence path.',
          source: { path: validPath, sha256: validHash, authorized: true, verified: false },
        },
      ],
      now: '2026-08-28T06:00:00.000Z',
    });

    expect(workbench.selected.map((item) => item.id)).toEqual(['stable']);
    expect(workbench.rejected).toContainEqual({ id: 'changed', reason: 'source_hash_unverified' });
    expect(workbench.selected[0].source.verification).toEqual({ algorithm: 'sha256', scope: 'file', matched: true });
  });

  test('rejects transcript hydration after the disk archive changes', async () => {
    const paths = fixture();
    fs.writeFileSync(paths.transcript, `${codexMessage('Hydrate this exact transcript event.')}\n`);
    const receipt = await ingestTranscript({ provider: 'codex', sourcePath: paths.transcript }, {
      root: paths.superdirectoryRoot,
      fluxRoot: paths.fluxRoot,
    });
    const hit = searchSuperdirectory('exact transcript event', { root: paths.superdirectoryRoot, limit: 1 })[0];
    expect((await hydrateTranscriptHit(hit, { root: paths.superdirectoryRoot })).source.verified).toBe(true);
    fs.appendFileSync(receipt.raw_path, '{}\n');
    expect(hydrateTranscriptHit(hit, { root: paths.superdirectoryRoot })).rejects.toThrow('raw archive hash mismatch');
  }, 30_000);
});
