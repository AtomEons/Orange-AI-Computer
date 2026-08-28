#!/usr/bin/env bun
import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '#sqlite';
import { mineReflexCandidates, verifySpineChain, __receiptToReflexInternals } from '../receipt-to-reflex.mjs';

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fixture({ prompts = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-reflex-'));
  roots.push(root);
  const dbPath = path.join(root, 'continuum.db');
  const chainPath = path.join(root, 'spine.jsonl');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE sources(id TEXT PRIMARY KEY,title TEXT,source_type TEXT,text TEXT,text_hash TEXT,created_at TEXT);');
  const rows = [];
  let prev = __receiptToReflexInternals.SPINE_GENESIS;
  const add = (index, prompt, { sourceHashValid = true } = {}) => {
    const orderId = `order-${index}`;
    const report = { schema: 'orange.report.v1', orderId, status: 'needs_action', confidence: 1, actionsTaken: [], evidence: [], findings: ['deterministic route: GET /healthz'], blockers: [], nextAction: 'call GET /healthz and inspect its evidence before claiming system status', receiptPath: null };
    const body = { schema: 'orange5.spine.order-flow.v1', seq: index, receipt_id: `receipt-${index}`, ts: 1000 + index, action: 'query.chat', status: 'completed', summary: 'governed reflex', lane: 'reflex', executed: false };
    const hash = sha256(`${prev}|${JSON.stringify(body)}`);
    const receipt = { ...body, prev_hash: prev, hash };
    rows.push(receipt);
    prev = hash;
    const turn = JSON.stringify({ schema: 'orange5.continuity-turn.v1', order_id: orderId, created_at: new Date(1000 + index).toISOString(), status: 'needs_action', route: { execution_tier: 'reflex' }, receipt: { id: receipt.receipt_id, seq: index, hash, path: chainPath }, user: prompt, assistant: JSON.stringify(report), redactions: 0 }, null, 2);
    db.query('INSERT INTO sources VALUES(?,?,?,?,?,?)').run(`source-${index}`, `runtime://turn/${orderId}`, 'continuum:interaction', turn, sourceHashValid ? sha256(turn) : 'bad', new Date(1000 + index).toISOString());
  };
  const selectedPrompts = prompts || [
    'Report the OrangeFive health endpoint.',
    'Which health route should I probe?',
    'Where is the system health check?',
  ];
  selectedPrompts.forEach((prompt, index) => add(index, prompt));
  fs.writeFileSync(chainPath, `${rows.map(JSON.stringify).join('\n')}\n`);
  db.close();
  return { root, dbPath, chainPath };
}

describe('Receipt-to-Reflex compiler', () => {
  test('joins exact Continuum turns to a valid receipt chain and revalidates a stable reflex', () => {
    const f = fixture();
    const result = mineReflexCandidates({ dbPath: f.dbPath, chainPath: f.chainPath });
    expect(result.chain.ok).toBe(true);
    expect(result.trusted_turns).toBe(3);
    expect(result.candidates[0].intent_id).toBe('health-route');
    expect(result.candidates[0].status).toBe('ACTIVE_REFLEX_REVALIDATED');
    expect(result.candidates[0].held_out.passed).toBe(true);
    expect(result.candidates[0].auto_promoted).toBe(false);
  });

  test('rejects an overbroad proposed classifier on held-out counterexamples', () => {
    const f = fixture();
    const overbroad = () => ({ id: 'health-route' });
    const result = mineReflexCandidates({ dbPath: f.dbPath, chainPath: f.chainPath, classify: overbroad });
    expect(result.candidates[0].status).toBe('REJECTED_BY_HELD_OUT_FALSIFIER');
    expect(result.status).toBe('REFLEX_MINER_NEEDS_WORK');
  });

  test('does not treat replayed copies of one prompt as independent evidence', () => {
    const repeated = 'Report the OrangeFive health endpoint.';
    const f = fixture({ prompts: [repeated, repeated, repeated] });
    const result = mineReflexCandidates({ dbPath: f.dbPath, chainPath: f.chainPath });
    expect(result.candidates[0]).toMatchObject({
      support: 3, independent_prompt_shapes: 1, minimum_prompt_shapes: 3, status: 'INSUFFICIENT_EVIDENCE',
    });
  });

  test('refuses a tampered receipt chain before candidate mining', () => {
    const f = fixture();
    const rows = fs.readFileSync(f.chainPath, 'utf8').trim().split('\n').map(JSON.parse);
    rows[1].summary = 'tampered';
    fs.writeFileSync(f.chainPath, `${rows.map(JSON.stringify).join('\n')}\n`);
    expect(verifySpineChain(f.chainPath).ok).toBe(false);
    const result = mineReflexCandidates({ dbPath: f.dbPath, chainPath: f.chainPath });
    expect(result.trusted_turns).toBe(0);
    expect(result.status).toBe('REFLEX_MINER_NEEDS_WORK');
  });

  test('does not count ordinary non-reflex turns as failed receipt joins', () => {
    const f = fixture();
    const db = new Database(f.dbPath);
    const payload = JSON.stringify({
      route: { execution_tier: 'navigator' }, receipt: { seq: 999, hash: 'missing', id: 'missing' },
      user: 'Explain the architecture.', assistant: JSON.stringify({ schema: 'orange.report.v1' }),
    });
    db.query('INSERT INTO sources VALUES(?,?,?,?,?,?)').run('non-reflex', 'runtime://turn/non-reflex', 'continuum:interaction', payload, sha256(payload), new Date().toISOString());
    db.close();
    const result = mineReflexCandidates({ dbPath: f.dbPath, chainPath: f.chainPath });
    expect(result.rejected_source_debt.total).toBe(0);
    expect(result.trusted_turns).toBe(3);
  });
});
