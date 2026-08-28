#!/usr/bin/env bun
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import {
  collectPromotionCandidates,
  detectSecretRules,
  scanPromotionRepository,
} from '../git-promotion-preflight.mjs';

const repositoryRoot = resolve(import.meta.dir, '..', '..');
const autoqaScripts = join(repositoryRoot, '02-ATOMIC-ORANGE-V1', 'autoqa', 'scripts');
const temporaryRoots = [];
const fakeOpenAiKey = ['sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz', '123456'].join('');
const fakeRailToken = ['abcdefghijklmnop', '123456'].join('');

function makeTemporaryRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(root, ...args) {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function createGitFixture() {
  const root = makeTemporaryRoot('orange5-promotion-');
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'release-safety@example.invalid');
  git(root, 'config', 'user.name', 'Release Safety Test');
  write(root, '.gitignore', 'ignored/**\n');
  write(root, 'tracked.mjs', 'export const state = "baseline";\n');
  git(root, 'add', '.gitignore', 'tracked.mjs');
  git(root, 'commit', '--quiet', '-m', 'fixture baseline');
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('portable SSH identity defaults', () => {
  const scripts = [
    ['scripts/ensure-codexa-vulkan-navigator.ps1', 'KeyPath'],
    ['scripts/ensure-codexa-eyes-tunnel.ps1', 'KeyPath'],
    ['scripts/ensure-codexa-ollama-tunnel.ps1', 'KeyPath'],
    ['scripts/ensure-codexa-qdrant-tunnel.ps1', 'KeyPath'],
    ['scripts/sync-codexa-rail-token.ps1', 'IdentityFile'],
    ['14-SUPERSTACK/invoke-captain-planet-route.ps1', 'SshKey'],
  ];

  test('derives each default from USERPROFILE and retains the public override', () => {
    for (const [relativePath, parameter] of scripts) {
      const source = readFileSync(join(repositoryRoot, relativePath), 'utf8');
      expect(source).toContain(`[string]$${parameter} = (Join-Path $env:USERPROFILE '.ssh\\orange_codexa_automation_ed25519')`);
      expect(source).not.toMatch(/[A-Za-z]:[\\/]Users[\\/]a[\\/]\.ssh/i);
      expect(source).toContain(`$${parameter}`);
    }
  });
});

describe('cleanup safety contract', () => {
  const shellScripts = [
    'macos_cleanup.sh',
    'macos_post_cleanup.sh',
    'ubuntu_cleanup.sh',
    'ubuntu_post_cleanup.sh',
  ];

  test('shell cleanups are dry-run first, explicitly confirmed, and allowlist-gated', () => {
    for (const name of shellScripts) {
      const source = readFileSync(join(autoqaScripts, name), 'utf8');
      expect(source).toContain('--confirm-destruction');
      expect(source).toContain('[DRY-RUN]');
      expect(source).toContain('assert_allowed_target');
      expect(source).toContain('pkill -x');
      expect(source).not.toContain('pkill -f');
    }
    expect(readFileSync(join(autoqaScripts, 'ubuntu_post_cleanup.sh'), 'utf8')).not.toContain('apt-get autoremove');
  });

  test('Windows cleanups leave sentinel data untouched without confirmation', () => {
    const root = makeTemporaryRoot('orange5-cleanup-');
    const environment = {
      ...process.env,
      APPDATA: join(root, 'appdata'),
      LOCALAPPDATA: join(root, 'localappdata'),
      USERPROFILE: join(root, 'profile'),
      TEMP: join(root, 'temp'),
    };
    for (const value of [environment.APPDATA, environment.LOCALAPPDATA, environment.USERPROFILE, environment.TEMP]) {
      mkdirSync(value, { recursive: true });
    }
    const sentinel = join(environment.APPDATA, 'Jan', 'sentinel.txt');
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, 'keep');

    for (const name of ['windows_cleanup.ps1', 'windows_post_cleanup.ps1']) {
      const result = Bun.spawnSync([
        'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(autoqaScripts, name),
      ], { env: environment, stdout: 'pipe', stderr: 'pipe' });
      expect(result.stderr.toString()).toBe('');
      expect(result.stdout.toString()).toContain('[DRY-RUN]');
      expect(result.exitCode).toBe(0);
      expect(existsSync(sentinel)).toBe(true);
    }
  }, 30_000);

  test('Windows cleanup rejects a filesystem root before planning actions', () => {
    const root = makeTemporaryRoot('orange5-cleanup-root-');
    const environment = {
      ...process.env,
      APPDATA: parse(root).root,
      LOCALAPPDATA: join(root, 'localappdata'),
      USERPROFILE: join(root, 'profile'),
      TEMP: join(root, 'temp'),
    };
    for (const value of [environment.LOCALAPPDATA, environment.USERPROFILE, environment.TEMP]) {
      mkdirSync(value, { recursive: true });
    }

    const result = Bun.spawnSync([
      'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(autoqaScripts, 'windows_cleanup.ps1'),
    ], { env: environment, stdout: 'pipe', stderr: 'pipe' });
    expect(`${result.stdout}${result.stderr}`).toContain('resolves to a filesystem root');
    expect(result.exitCode).not.toBe(0);
  }, 30_000);
});

describe('Git promotion preflight coverage', () => {
  test('collects staged, unstaged tracked, and non-ignored untracked files', () => {
    const root = createGitFixture();
    write(root, 'tracked.mjs', 'export const state = "modified";\n');
    write(root, 'staged.mjs', 'export const staged = true;\n');
    write(root, 'untracked.mjs', 'export const untracked = true;\n');
    write(root, 'ignored/receipt.mjs', `ORANGEBOX_RAIL_TOKEN=${fakeRailToken}\n`);
    git(root, 'add', 'staged.mjs');

    const candidates = collectPromotionCandidates(root);
    expect(candidates.staged).toContain('staged.mjs');
    expect(candidates.unstagedTracked).toContain('tracked.mjs');
    expect(candidates.untrackedPromotable).toContain('untracked.mjs');
    expect(candidates.candidates).not.toContain('ignored/receipt.mjs');
  }, 30_000);

  test('blocks secrets in unstaged tracked and untracked promotable source', () => {
    const root = createGitFixture();
    write(root, 'tracked.mjs', `const key = "${fakeOpenAiKey}";\n`);
    write(root, 'untracked.env.mjs', `ORANGEBOX_RAIL_TOKEN=${fakeRailToken}\n`);

    const report = scanPromotionRepository(root);
    expect(report.status).toBe('BLOCKED');
    expect(report.unstaged_tracked_files).toBe(1);
    expect(report.untracked_promotable_files).toBe(1);
    expect(report.secret_findings).toContainEqual({ path: 'tracked.mjs', rule: 'openai_key' });
    expect(report.secret_findings).toContainEqual({ path: 'untracked.env.mjs', rule: 'rail_token_value' });
  }, 30_000);

  test('does not treat environment-variable references as literal rail tokens', () => {
    const references = [
      'process.env.ORANGEBOX_RAIL_TOKEN = canonicalRailToken;',
      'Bun.env.ORANGEBOX_RAIL_TOKEN = canonicalRailToken;',
      '$env:ORANGEBOX_RAIL_TOKEN = $token',
      'export ORANGEBOX_RAIL_TOKEN="${ORANGEBOX_RAIL_TOKEN:-}"',
    ].join('\n');
    expect(detectSecretRules(references)).not.toContain('rail_token_value');
    expect(detectSecretRules(`process.env.ORANGEBOX_RAIL_TOKEN = '${fakeRailToken}';`)).toContain('rail_token_value');
  });
});
