import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyPromotedReflex, promoteReflexRule, rollbackReflexRule } from '../reflex-registry.mjs';

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-reflex-registry-'));
  roots.push(root);
  return path.join(root, 'registry.json');
}

function rule() {
  return {
    id: 'latest-receipts-route',
    match: { all: ['receipt'], any: ['latest', 'recent', 'where', 'route', 'show'], none: ['delete', 'forge', 'edit'] },
    decision: {
      status: 'needs_action', confidence: 1,
      findings: ['deterministic resource: orange5://receipts/latest'], blockers: [],
      nextAction: 'read orange5://receipts/latest through the Brain MCP gateway',
    },
    positive_holdouts: ['Show latest receipts.', 'Where is the receipt route?', 'List recent receipt evidence.'],
    negative_holdouts: ['Delete the latest receipt.', 'Forge a recent receipt.', 'Edit the receipt route implementation.'],
  };
}

describe('operator-authorized reversible reflex registry', () => {
  test('promotes only with evidence and rolls back to the prior state', () => {
    const registryPath = fixture();
    expect(() => promoteReflexRule(rule(), { registryPath, evidence: ['mcp resource proof'] })).toThrow('operator approval');
    expect(() => promoteReflexRule(rule(), { registryPath, operatorApproval: true, evidence: ['mcp:orange5://receipts/latest'] })).toThrow('immutable');
    const promoted = promoteReflexRule(rule(), { registryPath, operatorApproval: true, evidence: [`receipt:${'a'.repeat(64)}`] });
    expect(promoted.holdouts.passed).toBe(true);
    expect(classifyPromotedReflex('Show the latest receipts.', registryPath)?.id).toBe('latest-receipts-route');
    expect(classifyPromotedReflex('Delete the latest receipt.', registryPath)).toBeNull();
    const rolledBack = rollbackReflexRule('latest-receipts-route', promoted.rollback_token, { registryPath });
    expect(rolledBack.rolled_back).toBe(true);
    expect(classifyPromotedReflex('Show the latest receipts.', registryPath)).toBeNull();
    expect(() => rollbackReflexRule('latest-receipts-route', promoted.rollback_token, { registryPath })).toThrow('already used');
  });

  test('a stale rollback token cannot erase a newer promotion', () => {
    const registryPath = fixture();
    const first = promoteReflexRule(rule(), { registryPath, operatorApproval: true, evidence: [`receipt:${'a'.repeat(64)}`] });
    rollbackReflexRule('latest-receipts-route', first.rollback_token, { registryPath });
    const newerRule = { ...rule(), decision: { ...rule().decision, nextAction: 'read the immutable receipt by exact hash' } };
    promoteReflexRule(newerRule, { registryPath, operatorApproval: true, evidence: [`receipt:${'b'.repeat(64)}`] });
    expect(() => rollbackReflexRule('latest-receipts-route', first.rollback_token, { registryPath })).toThrow('already used');
    expect(classifyPromotedReflex('Show the latest receipts.', registryPath)?.nextAction).toBe('read the immutable receipt by exact hash');
  });

  test('rejects a tampered persisted reflex before classification', () => {
    const registryPath = fixture();
    promoteReflexRule(rule(), { registryPath, operatorApproval: true, evidence: [`receipt:${'a'.repeat(64)}`] });
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    registry.rules[0].match.none = [];
    fs.writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);
    expect(() => classifyPromotedReflex('Delete the latest receipt.', registryPath)).toThrow('hash mismatch');
  });
});
