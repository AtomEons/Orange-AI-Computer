// 11-MIRAGE/tests/drive.test.mjs
//
// Tests for the Drive adapter that DO NOT require real Google creds or a real
// googleapis install. Anything that hits Drive itself is gated behind a
// MIRAGE_DRIVE_LIVE=1 env flag and skipped by default — Mom's Law: no fake
// green from a test that pretends to exercise an external API it can't reach.
//
// Strategy:
//   - Spin up a local loopback HTTP server that impersonates the Hermes lease
//     endpoint, so write() can prove its fail-closed + lease-acquisition path.
//   - Verify healthz() emits honest stubs when creds / googleapis are absent.
//   - Verify read()/write() refuse cleanly (no throws) under stub conditions.
//
// Run:
//   node --test 11-MIRAGE/tests/drive.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { driveAdapter, __resetForTests } from '../adapters/drive.mjs';

// ─── tiny hermes mock ───────────────────────────────────────────────────────

function startHermesMock({ approve = true, malformed = false, status = 200 } = {}) {
  return new Promise((resolve) => {
    let lastBody = null;
    const server = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => (buf += c));
      req.on('end', () => {
        try { lastBody = JSON.parse(buf); } catch { lastBody = buf; }
        if (malformed) {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('not-json-lease');
          return;
        }
        const requires = !approve;
        const lease = {
          id: 'lease_test_' + Date.now(),
          actor: 'mirage.drive',
          allowed: lastBody?.allowed || [],
          forbidden: ['destructive_write', 'production_deploy', 'scope_expansion', 'egress_unbounded'],
          targetProject: 'orange5',
          riskLevel: 'medium',
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
        async close() { return new Promise((r) => server.close(() => r())); },
      });
    });
  });
}

function clearDriveEnv() {
  delete process.env.GOOGLE_DRIVE_CLIENT_ID;
  delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  delete process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  __resetForTests();
}

// ─── healthz: honest stubs ──────────────────────────────────────────────────

test('healthz() reports degraded_no_creds when env vars are unset', async () => {
  clearDriveEnv();
  const h = await driveAdapter.healthz();
  assert.equal(h.ok, false);
  assert.equal(h.status, 'degraded_no_creds');
  assert.ok(Array.isArray(h.detail) || typeof h.detail === 'string');
  assert.equal(h.spec, '11-MIRAGE/SPEC.md#drive');
  assert.equal(h.adapter, 'drive');
  assert.equal(h.writes_require_approval, true);
});

test('healthz() does not throw when called twice in a row', async () => {
  clearDriveEnv();
  await driveAdapter.healthz();
  const h = await driveAdapter.healthz();
  assert.equal(h.status, 'degraded_no_creds');
});

// ─── read: refuses cleanly when creds missing ───────────────────────────────

test('read() returns ok:false with creds_missing when env unset', async () => {
  clearDriveEnv();
  const r = await driveAdapter.read({ op: 'list_files', folder_id: 'root' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
  assert.ok(Array.isArray(r.missing) && r.missing.length === 3);
});

test('read() with unknown op refuses cleanly (no throw)', async () => {
  // Set fake creds so we get past the creds gate; googleapis may or may not be
  // installed — either way, the op check must surface first only if creds pass.
  // To keep this test deterministic, we keep creds unset and assert creds_missing
  // (the adapter checks creds before op, by design).
  clearDriveEnv();
  const r = await driveAdapter.read({ op: 'definitely_not_a_real_op' });
  assert.equal(r.ok, false);
  // Either creds_missing (preferred order) or unknown_op; both are honest.
  assert.ok(r.reason === 'creds_missing' || String(r.reason).startsWith('unknown_op'));
});

// ─── write: fail-closed without Hermes ──────────────────────────────────────

test('write() is fail-closed when Hermes is unreachable', async () => {
  clearDriveEnv();
  process.env.HERMES_BASE = 'http://127.0.0.1:1'; // closed port
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';
  process.env.MIRAGE_HERMES_TIMEOUT_MS = '300';

  const r = await driveAdapter.write({
    op: 'create_file',
    name: 'hello.txt',
    content: 'hi',
    approval_token: 'op-approves',
  });
  assert.equal(r.ok, false);
  // Either hermes_unreachable or hermes_lease_denied — both are honest failures.
  assert.ok(['hermes_unreachable', 'hermes_lease_denied'].includes(r.reason),
    `unexpected reason: ${r.reason}`);
});

test('write() refuses unknown op without ever touching Hermes', async () => {
  const r = await driveAdapter.write({ op: 'delete_everything' });
  assert.equal(r.ok, false);
  assert.ok(String(r.reason).startsWith('unknown_op'));
});

test('write() requires op', async () => {
  const r = await driveAdapter.write({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'op_required');
});

// ─── write: Hermes lease handshake (mocked) ─────────────────────────────────

test('write() acquires a Hermes lease and posts an actor=mirage.drive payload', async () => {
  clearDriveEnv();
  const hermes = await startHermesMock({ approve: true });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';
  process.env.MIRAGE_HERMES_TIMEOUT_MS = '2000';

  const r = await driveAdapter.write({
    op: 'create_file',
    name: 'note.txt',
    content: 'body',
    approval_token: 'sovereign-ok',
  });

  // Hermes side must have received a well-shaped lease request.
  assert.ok(hermes.lastBody, 'Hermes mock saw no request');
  assert.equal(hermes.lastBody.actor, 'mirage.drive');
  assert.equal(hermes.lastBody.targetProject, 'orange5');
  assert.deepEqual(hermes.lastBody.allowed, ['drive.create_file']);
  assert.equal(hermes.lastBody.requires_approval, true);

  // After lease, the call falls through to googleapis. Without real creds the
  // adapter must refuse with creds_missing (NOT throw, NOT fake-green).
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');

  await hermes.close();
});

test('write() refuses when Hermes returns malformed body', async () => {
  clearDriveEnv();
  const hermes = await startHermesMock({ malformed: true });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await driveAdapter.write({
    op: 'update_file',
    file_id: 'abc',
    content: 'x',
    approval_token: 'sov',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hermes_lease_malformed');

  await hermes.close();
});

test('write() refuses when lease requires approval and no token supplied', async () => {
  clearDriveEnv();
  const hermes = await startHermesMock({ approve: false });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await driveAdapter.write({
    op: 'create_file',
    name: 'no-token.txt',
    content: 'x',
    // no approval_token
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'operator_approval_required');

  await hermes.close();
});

test('write() refuses on Hermes 4xx', async () => {
  clearDriveEnv();
  const hermes = await startHermesMock({ status: 403 });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await driveAdapter.write({
    op: 'create_file',
    name: 'denied.txt',
    content: 'x',
    approval_token: 'sov',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hermes_lease_denied');
  assert.equal(r.status, 403);

  await hermes.close();
});

// ─── live tier (off by default) ─────────────────────────────────────────────

test('live: Drive about.get round-trip', { skip: process.env.MIRAGE_DRIVE_LIVE !== '1' }, async () => {
  // Requires real creds + real googleapis install. Operator opts in by
  // exporting MIRAGE_DRIVE_LIVE=1 and the three GOOGLE_DRIVE_* vars.
  const h = await driveAdapter.healthz();
  assert.equal(h.ok, true, `healthz not ready: ${JSON.stringify(h)}`);
});
