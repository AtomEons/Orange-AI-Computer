// 11-MIRAGE/tests/github.test.mjs
//
// Tests for the GitHub adapter that DO NOT require a real PAT, gh CLI, or a
// real @octokit/rest install. Anything that hits GitHub itself is gated behind
// MIRAGE_GITHUB_LIVE=1 and skipped by default — Mom's Law: no fake green from
// a test that pretends to exercise an external API it can't reach.
//
// Strategy:
//   - Spin up a local loopback HTTP server that impersonates the Hermes lease
//     endpoint, so write() can prove its fail-closed + lease-acquisition path.
//   - Force the token-lookup path into the "no creds" branch by deleting env
//     vars AND pointing PATH at a directory with no `gh` binary, so the CLI
//     fallback fails predictably.
//   - Verify healthz() emits honest stubs when creds / octokit are absent.
//   - Verify read()/write() refuse cleanly (no throws) under stub conditions.
//
// Run:
//   node --test 11-MIRAGE/tests/github.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { githubAdapter, __resetForTests } from '../adapters/github.mjs';

// ─── tiny hermes mock ───────────────────────────────────────────────────────

function startHermesMock({ approve = true, malformed = false, status = 200 } = {}) {
  return new Promise((resolve) => {
    let lastBody = null;
    let lastHeaders = null;
    const server = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => (buf += c));
      req.on('end', () => {
        try { lastBody = JSON.parse(buf); } catch { lastBody = buf; }
        lastHeaders = req.headers;
        if (malformed) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('not-json-lease');
          return;
        }
        const requires = !approve;
        const lease = {
          id: 'lease_test_' + Date.now(),
          actor: 'mirage.github',
          allowed: lastBody?.allowed || [],
          forbidden: ['destructive_write', 'production_deploy', 'scope_expansion', 'egress_unbounded'],
          targetProject: 'orange5',
          riskLevel: lastBody?.riskLevel || 'medium',
          expires_at: Date.now() + 60_000,
          requires_approval: requires,
          status: 'active',
        };
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(lease));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        get lastBody() { return lastBody; },
        get lastHeaders() { return lastHeaders; },
        async close() { return new Promise((r) => server.close(() => r())); },
      });
    });
  });
}

// Force the gh-CLI fallback to fail by pointing PATH at an empty temp dir.
// Saves the previous PATH so the rest of the run is unaffected.
let _savedPath = null;
function muteGhCli() {
  if (_savedPath !== null) return;
  _savedPath = process.env.PATH;
  const empty = mkdtempSync(join(os.tmpdir(), 'mirage-no-gh-'));
  process.env.PATH = empty;
}
function restoreGhCli() {
  if (_savedPath !== null) {
    process.env.PATH = _savedPath;
    _savedPath = null;
  }
}

function clearGhEnv() {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  muteGhCli();
  __resetForTests();
}

// ─── healthz: honest stubs ──────────────────────────────────────────────────

test('healthz() reports degraded_no_creds when env unset and gh CLI absent', async () => {
  clearGhEnv();
  const h = await githubAdapter.healthz();
  assert.equal(h.ok, false);
  assert.equal(h.status, 'degraded_no_creds');
  assert.ok(typeof h.detail === 'string');
  assert.match(h.detail, /GITHUB_TOKEN/);
  assert.equal(h.spec, '11-MIRAGE/SPEC.md#github');
  assert.equal(h.adapter, 'github');
  assert.equal(h.writes_require_approval, true);
  assert.equal(h.family, 'data');
  restoreGhCli();
});

test('healthz() does not throw when called twice in a row', async () => {
  clearGhEnv();
  await githubAdapter.healthz();
  const h = await githubAdapter.healthz();
  assert.equal(h.status, 'degraded_no_creds');
  restoreGhCli();
});

// ─── read: refuses cleanly when creds missing ───────────────────────────────

test('read({op:list_repos}) returns ok:false with creds_missing when no token', async () => {
  clearGhEnv();
  const r = await githubAdapter.read({ op: 'list_repos' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
  assert.equal(r.spec, '11-MIRAGE/SPEC.md#github');
  restoreGhCli();
});

test('read() defaults op to list_repos', async () => {
  clearGhEnv();
  const r = await githubAdapter.read({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
  restoreGhCli();
});

test('read({op:get_file}) refuses cleanly with creds missing', async () => {
  clearGhEnv();
  const r = await githubAdapter.read({ op: 'get_file', owner: 'o', repo: 'r', path: 'README.md' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
  restoreGhCli();
});

test('read({op:list_prs}) refuses cleanly with creds missing', async () => {
  clearGhEnv();
  const r = await githubAdapter.read({ op: 'list_prs', owner: 'o', repo: 'r' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
  restoreGhCli();
});

test('read({op:list_issues}) refuses cleanly with creds missing', async () => {
  clearGhEnv();
  const r = await githubAdapter.read({ op: 'list_issues', owner: 'o', repo: 'r' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
  restoreGhCli();
});

test('read() with unknown op refuses cleanly (no throw)', async () => {
  clearGhEnv();
  const r = await githubAdapter.read({ op: 'definitely_not_a_real_op' });
  assert.equal(r.ok, false);
  assert.ok(String(r.reason).startsWith('unknown_op'));
  assert.deepEqual(r.allowed_ops, ['list_repos', 'get_file', 'list_prs', 'list_issues']);
  restoreGhCli();
});

// ─── write: surface validation runs before Hermes ───────────────────────────

test('write() rejects unknown op without Hermes', async () => {
  const r = await githubAdapter.write({ op: 'force_push' });
  assert.equal(r.ok, false);
  assert.ok(String(r.reason).startsWith('unknown_op'));
  assert.deepEqual(r.allowed_ops, ['create_issue', 'create_comment', 'create_pr']);
});

test('write(create_issue) requires owner/repo/title', async () => {
  let r = await githubAdapter.write({ op: 'create_issue' });
  assert.equal(r.reason, 'owner_required');

  r = await githubAdapter.write({ op: 'create_issue', owner: 'o' });
  assert.equal(r.reason, 'repo_required');

  r = await githubAdapter.write({ op: 'create_issue', owner: 'o', repo: 'r' });
  assert.equal(r.reason, 'title_required');
});

test('write(create_comment) requires owner/repo/issue_number/body', async () => {
  let r = await githubAdapter.write({ op: 'create_comment', owner: 'o', repo: 'r' });
  assert.equal(r.reason, 'issue_number_required');

  r = await githubAdapter.write({ op: 'create_comment', owner: 'o', repo: 'r', issue_number: 5 });
  assert.equal(r.reason, 'body_required');

  r = await githubAdapter.write({
    op: 'create_comment', owner: 'o', repo: 'r', issue_number: 'not-a-number', body: 'hi',
  });
  assert.equal(r.reason, 'issue_number_invalid');
});

test('write(create_pr) requires owner/repo/title/head/base', async () => {
  let r = await githubAdapter.write({ op: 'create_pr', owner: 'o', repo: 'r', title: 't' });
  assert.equal(r.reason, 'head_required');

  r = await githubAdapter.write({ op: 'create_pr', owner: 'o', repo: 'r', title: 't', head: 'feature' });
  assert.equal(r.reason, 'base_required');
});

// ─── write: fail-closed without Hermes ──────────────────────────────────────

test('write() is fail-closed when Hermes is unreachable', async () => {
  clearGhEnv();
  process.env.HERMES_BASE = 'http://127.0.0.1:1';
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';
  process.env.MIRAGE_HERMES_TIMEOUT_MS = '300';

  const r = await githubAdapter.write({
    op: 'create_issue',
    owner: 'AtomEons', repo: 'orange5',
    title: 'hi',
    body: 'hello',
    approval_token: 'op-approves',
  });
  assert.equal(r.ok, false);
  assert.ok(['hermes_unreachable', 'hermes_lease_denied'].includes(r.reason),
    `unexpected reason: ${r.reason}`);
  restoreGhCli();
});

// ─── write: Hermes lease handshake (mocked) ─────────────────────────────────

test('write(create_issue) acquires a Hermes lease with actor=mirage.github and approval header', async () => {
  clearGhEnv();
  const hermes = await startHermesMock({ approve: true });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';
  process.env.MIRAGE_HERMES_TIMEOUT_MS = '2000';

  const r = await githubAdapter.write({
    op: 'create_issue',
    owner: 'AtomEons', repo: 'orange5',
    title: 'test issue',
    body: 'body text',
    approval_token: 'sovereign-ok',
  });

  // Hermes side must have received a well-shaped lease request.
  assert.ok(hermes.lastBody, 'Hermes mock saw no request');
  assert.equal(hermes.lastBody.actor, 'mirage.github');
  assert.equal(hermes.lastBody.targetProject, 'orange5');
  assert.equal(hermes.lastBody.riskLevel, 'medium');
  assert.deepEqual(hermes.lastBody.allowed, ['github.create_issue']);
  assert.equal(hermes.lastBody.requires_approval, true);
  assert.equal(hermes.lastHeaders['x-operator-approval'], 'sovereign-ok');

  // After lease, the call falls through to octokit. Without creds the adapter
  // must refuse with creds_missing (NOT throw, NOT fake-green).
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');

  await hermes.close();
  restoreGhCli();
});

test('write(create_pr) escalates riskLevel to high', async () => {
  clearGhEnv();
  const hermes = await startHermesMock({ approve: true });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  await githubAdapter.write({
    op: 'create_pr',
    owner: 'AtomEons', repo: 'orange5',
    title: 'wire github adapter',
    head: 'feature/github', base: 'main',
    approval_token: 'sovereign-ok',
  });

  assert.equal(hermes.lastBody.riskLevel, 'high');
  assert.deepEqual(hermes.lastBody.allowed, ['github.create_pr']);

  await hermes.close();
  restoreGhCli();
});

test('write() refuses when Hermes returns malformed body', async () => {
  clearGhEnv();
  const hermes = await startHermesMock({ malformed: true });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await githubAdapter.write({
    op: 'create_issue',
    owner: 'o', repo: 'r', title: 't',
    approval_token: 'sov',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hermes_lease_malformed');

  await hermes.close();
  restoreGhCli();
});

test('write() refuses when lease requires approval and no token supplied', async () => {
  clearGhEnv();
  const hermes = await startHermesMock({ approve: false });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await githubAdapter.write({
    op: 'create_issue',
    owner: 'o', repo: 'r', title: 't',
    // no approval_token
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'operator_approval_required');

  await hermes.close();
  restoreGhCli();
});

test('write() refuses on Hermes 4xx', async () => {
  clearGhEnv();
  const hermes = await startHermesMock({ status: 403 });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await githubAdapter.write({
    op: 'create_comment',
    owner: 'o', repo: 'r', issue_number: 1, body: 'hi',
    approval_token: 'sov',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hermes_lease_denied');
  assert.equal(r.status, 403);

  await hermes.close();
  restoreGhCli();
});

// ─── live tier (off by default) ─────────────────────────────────────────────

test('live: GitHub getAuthenticated round-trip', { skip: process.env.MIRAGE_GITHUB_LIVE !== '1' }, async () => {
  const h = await githubAdapter.healthz();
  assert.equal(h.ok, true, `healthz not ready: ${JSON.stringify(h)}`);
});
