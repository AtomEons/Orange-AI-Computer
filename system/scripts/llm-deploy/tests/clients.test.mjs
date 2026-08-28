#!/usr/bin/env bun
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureOrangeClients, rollbackOrangeClients, verifyOrangeClients } from '../deploy-clients.mjs';
import { deployPaths } from '../deploy-core.mjs';

const cleanup = [];
afterEach(() => {
  delete process.env.ORANGE5_CLIENT_TEST_ROOT;
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

describe('OrangeFive deploy client configuration rollback', () => {
  test('restores unchanged installed files and preserves operator edits made after apply', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orangefive-client-deploy-test-'));
    cleanup.push(root);
    process.env.ORANGE5_CLIENT_TEST_ROOT = root;
    const sourceRoot = path.join(root, 'payload');
    const modulePath = path.join(sourceRoot, 'fake-client-installer.mjs');
    mkdirSync(path.dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, `
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.ORANGE5_CLIENT_TEST_ROOT;
export const CLIENTS = { codex: path.join(root, 'clients', 'codex.toml'), claude: path.join(root, 'clients', 'claude.json') };
export const SKILL_ROOTS = { shared: path.join(root, 'skills') };
export function install({ dryRun = false } = {}) {
  const desired = { codex: 'orangefive-codex\\n', claude: '{"OrangeFive":true}\\n' };
  const results = Object.entries(CLIENTS).map(([client, file]) => {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const changed = current !== desired[client];
    if (!dryRun && changed) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, desired[client]); }
    return { client, file, status: changed ? (dryRun ? 'WOULD_UPDATE' : 'UPDATED') : 'CURRENT' };
  });
  const skillFile = path.join(SKILL_ROOTS.shared, 'orange5', 'SKILL.md');
  const primerFile = path.join(SKILL_ROOTS.shared, 'orangebox-primer', 'SKILL.md');
  const skills = [skillFile, primerFile].map((file) => {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const changed = current !== 'orangefive-skill\\n';
    if (!dryRun && changed) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'orangefive-skill\\n'); }
    return { status: changed ? (dryRun ? 'WOULD_UPDATE' : 'SYNCED') : 'CURRENT', path: file };
  });
  return { ok: true, results, skills, receiptPath: path.join(root, 'client-receipt.json') };
}
`, 'utf8');

    const codex = path.join(root, 'clients', 'codex.toml');
    const claude = path.join(root, 'clients', 'claude.json');
    mkdirSync(path.dirname(codex), { recursive: true });
    writeFileSync(codex, 'before-codex\n');
    writeFileSync(claude, '{"before":true}\n');
    const plan = {
      sourceRoot,
      planSha256: 'b'.repeat(64),
      actions: [{ kind: 'orange.clients.configure', installer: 'fake-client-installer.mjs' }],
    };
    const paths = deployPaths(path.join(root, 'state'));

    const configured = await configureOrangeClients(plan, paths);
    expect(configured.status).toBe('ORANGEFIVE_CLIENTS_CONFIGURED');
    expect((await verifyOrangeClients(plan)).ok).toBe(true);
    writeFileSync(claude, '{"operatorChanged":true}\n');

    const rollback = rollbackOrangeClients(plan, paths);
    expect(readFileSync(codex, 'utf8')).toBe('before-codex\n');
    expect(readFileSync(claude, 'utf8')).toBe('{"operatorChanged":true}\n');
    expect(rollback.preserved.some((item) => item.file === claude && item.reason === 'changed-after-deploy')).toBe(true);
  });
});
