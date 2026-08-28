// 11-MIRAGE/tests/slack.test.mjs
//
// Tests for the Slack adapter that DO NOT require real Slack creds or a real
// @slack/web-api install. Anything that hits Slack itself is gated behind a
// MIRAGE_SLACK_LIVE=1 env flag and skipped by default — Mom's Law: no fake
// green from a test that pretends to exercise an external API it can't reach.
//
// Strategy:
//   - Spin up a local loopback HTTP server that impersonates the Hermes lease
//     endpoint, so write() can prove its fail-closed + lease-acquisition path.
//   - Verify healthz() emits honest stubs when creds / @slack/web-api are absent.
//   - Verify read()/write() refuse cleanly (no throws) under stub conditions.
//   - Validate channel/ts helpers in isolation.
//
// Run:
//   node --test 11-MIRAGE/tests/slack.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { slackAdapter, __resetForTests, __internals } from '../adapters/slack.mjs';

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
          actor: 'mirage.slack',
          allowed: lastBody?.allowed || [],
          forbidden: ['destructive_write', 'production_deploy', 'scope_expansion', 'egress_unbounded'],
          targetProject: 'orange5',
          riskLevel: 'high',
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

function clearSlackEnv() {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_USER_TOKEN;
  __resetForTests();
}

// ─── healthz: honest stubs ──────────────────────────────────────────────────

test('healthz() reports degraded_no_creds when env vars are unset', async () => {
  clearSlackEnv();
  const h = await slackAdapter.healthz();
  assert.equal(h.ok, false);
  assert.equal(h.status, 'degraded_no_creds');
  assert.ok(typeof h.detail === 'string');
  assert.equal(h.spec, '11-MIRAGE/SPEC.md#slack');
  assert.equal(h.adapter, 'slack');
  assert.equal(h.writes_require_approval, true);
  assert.equal(h.family, 'data');
});

test('healthz() does not throw when called twice in a row', async () => {
  clearSlackEnv();
  await slackAdapter.healthz();
  const h = await slackAdapter.healthz();
  assert.equal(h.status, 'degraded_no_creds');
});

test('healthz() detail names the missing SLACK_BOT_TOKEN env var', async () => {
  clearSlackEnv();
  const h = await slackAdapter.healthz();
  assert.match(h.detail, /SLACK_BOT_TOKEN/);
});

// ─── read: refuses cleanly when creds missing ───────────────────────────────

test('read() returns ok:false with creds_missing when env unset', async () => {
  clearSlackEnv();
  const r = await slackAdapter.read({ op: 'list_channels' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
  assert.ok(Array.isArray(r.missing) && r.missing.length === 1);
  assert.equal(r.missing[0], 'SLACK_BOT_TOKEN');
});

test('read() defaults op to list_channels', async () => {
  clearSlackEnv();
  const r = await slackAdapter.read({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
});

test('read({op:history}) with creds missing refuses cleanly', async () => {
  clearSlackEnv();
  const r = await slackAdapter.read({ op: 'history', channel: 'C0123ABCD' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
});

test('read({op:history}) without channel still surfaces creds_missing first when creds absent', async () => {
  // creds_missing is the earliest honest gap; either ordering is acceptable
  // as long as we never throw and never fake-green.
  clearSlackEnv();
  const r = await slackAdapter.read({ op: 'history' });
  assert.equal(r.ok, false);
  assert.ok(['creds_missing', 'channel_required'].includes(r.reason));
});

test('read({op:search}) with no SLACK_USER_TOKEN refuses cleanly (search needs user token)', async () => {
  clearSlackEnv();
  const r = await slackAdapter.read({ op: 'search', query: 'foo' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'user_token_missing');
  assert.deepEqual(r.missing, ['SLACK_USER_TOKEN']);
});

test('read() with unknown op refuses cleanly (no throw)', async () => {
  clearSlackEnv();
  const r = await slackAdapter.read({ op: 'definitely_not_a_real_op' });
  assert.equal(r.ok, false);
  assert.ok(r.reason === 'creds_missing' || String(r.reason).startsWith('unknown_op'));
});

// ─── write: surface validation runs before Hermes ───────────────────────────

test('write() rejects unknown op without Hermes', async () => {
  const r = await slackAdapter.write({ op: 'delete_channel' });
  assert.equal(r.ok, false);
  assert.ok(String(r.reason).startsWith('unknown_op'));
});

test('write() requires channel and text-or-blocks', async () => {
  let r = await slackAdapter.write({ op: 'post_message' });
  assert.equal(r.reason, 'channel_required');

  r = await slackAdapter.write({ op: 'post_message', channel: 'C0123ABCD' });
  assert.equal(r.reason, 'text_or_blocks_required');
});

test('write() rejects malformed channel', async () => {
  const r = await slackAdapter.write({
    op: 'post_message', channel: 'definitely not a channel!!', text: 'hi',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'channel_malformed');
});

test('write() accepts blocks-only (no text)', async () => {
  // Without Hermes / creds this still fails — but it must get PAST the
  // surface validation, i.e. reason is NOT text_or_blocks_required.
  clearSlackEnv();
  process.env.HERMES_BASE = 'http://127.0.0.1:1';
  process.env.MIRAGE_HERMES_TIMEOUT_MS = '300';
  const r = await slackAdapter.write({
    op: 'post_message',
    channel: 'C0123ABCD',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }],
    approval_token: 'op',
  });
  assert.equal(r.ok, false);
  assert.notEqual(r.reason, 'text_or_blocks_required');
});

// ─── write: fail-closed without Hermes ──────────────────────────────────────

test('write() is fail-closed when Hermes is unreachable', async () => {
  clearSlackEnv();
  process.env.HERMES_BASE = 'http://127.0.0.1:1';
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';
  process.env.MIRAGE_HERMES_TIMEOUT_MS = '300';

  const r = await slackAdapter.write({
    op: 'post_message',
    channel: 'C0123ABCD',
    text: 'hello',
    approval_token: 'op-approves',
  });
  assert.equal(r.ok, false);
  assert.ok(['hermes_unreachable', 'hermes_lease_denied'].includes(r.reason),
    `unexpected reason: ${r.reason}`);
});

// ─── write: Hermes lease handshake (mocked) ─────────────────────────────────

test('write() acquires a Hermes lease and posts actor=mirage.slack with approval header', async () => {
  clearSlackEnv();
  const hermes = await startHermesMock({ approve: true });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';
  process.env.MIRAGE_HERMES_TIMEOUT_MS = '2000';

  const r = await slackAdapter.write({
    op: 'post_message',
    channel: 'C0123ABCD',
    text: 'hello from mirage',
    approval_token: 'sovereign-ok',
  });

  // Hermes side must have received a well-shaped lease request.
  assert.ok(hermes.lastBody, 'Hermes mock saw no request');
  assert.equal(hermes.lastBody.actor, 'mirage.slack');
  assert.equal(hermes.lastBody.targetProject, 'orange5');
  assert.equal(hermes.lastBody.riskLevel, 'high');
  assert.deepEqual(hermes.lastBody.allowed, ['slack.post_message']);
  assert.equal(hermes.lastBody.requires_approval, true);
  assert.equal(hermes.lastHeaders['x-operator-approval'], 'sovereign-ok');

  // After lease, the call falls through to @slack/web-api. Without real creds
  // the adapter must refuse with creds_missing (NOT throw, NOT fake-green).
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');

  await hermes.close();
});

test('write() refuses when Hermes returns malformed body', async () => {
  clearSlackEnv();
  const hermes = await startHermesMock({ malformed: true });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await slackAdapter.write({
    op: 'post_message',
    channel: 'C0123ABCD',
    text: 'hi',
    approval_token: 'sov',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hermes_lease_malformed');

  await hermes.close();
});

test('write() refuses when lease requires approval and no token supplied', async () => {
  clearSlackEnv();
  const hermes = await startHermesMock({ approve: false });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await slackAdapter.write({
    op: 'post_message',
    channel: 'C0123ABCD',
    text: 'hi',
    // no approval_token
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'operator_approval_required');

  await hermes.close();
});

test('write() refuses on Hermes 4xx', async () => {
  clearSlackEnv();
  const hermes = await startHermesMock({ status: 403 });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await slackAdapter.write({
    op: 'post_message',
    channel: 'C0123ABCD',
    text: 'hi',
    approval_token: 'sov',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hermes_lease_denied');
  assert.equal(r.status, 403);

  await hermes.close();
});

test('write() lease meta carries channel + text preview but not the full text payload', async () => {
  clearSlackEnv();
  const hermes = await startHermesMock({ approve: true });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const longText = 'x'.repeat(500);
  await slackAdapter.write({
    op: 'post_message',
    channel: 'C0123ABCD',
    text: longText,
    approval_token: 'sov',
  });

  assert.ok(hermes.lastBody?.meta);
  assert.equal(hermes.lastBody.meta.channel, 'C0123ABCD');
  assert.equal(hermes.lastBody.meta.text_preview.length, 120);

  await hermes.close();
});

// ─── helpers ────────────────────────────────────────────────────────────────

test('looksLikeChannel accepts Cxxxx ids, #handles, and bare names', () => {
  const { looksLikeChannel } = __internals;
  assert.equal(looksLikeChannel('C0123ABCD'), true);
  assert.equal(looksLikeChannel('G0123ABCD'), true);
  assert.equal(looksLikeChannel('D0123ABCD'), true);
  assert.equal(looksLikeChannel('#general'), true);
  assert.equal(looksLikeChannel('general'), true);
  assert.equal(looksLikeChannel('team-orange5'), true);
  assert.equal(looksLikeChannel(''), false);
  assert.equal(looksLikeChannel('Has Spaces'), false);
  assert.equal(looksLikeChannel('UPPERCASE'), false);
});

test('toSlackTs converts Date / ms / seconds / iso to slack ts string', () => {
  const { toSlackTs } = __internals;
  assert.equal(toSlackTs(undefined), undefined);
  // seconds
  assert.equal(toSlackTs(1700000000), '1700000000.000000');
  // ms
  assert.equal(toSlackTs(1700000000123), '1700000000.123000');
  // Date
  const d = new Date('2024-01-01T00:00:00Z');
  assert.equal(toSlackTs(d), (d.getTime() / 1000).toFixed(6));
  // ISO string
  assert.equal(toSlackTs('2024-01-01T00:00:00Z'), (Date.parse('2024-01-01T00:00:00Z') / 1000).toFixed(6));
  // already a slack ts
  assert.equal(toSlackTs('1700000000.123456'), '1700000000.123456');
});

test('normalizeSlackErr extracts .data.error / .code from WebAPI errors', () => {
  const { normalizeSlackErr } = __internals;
  const e = { data: { error: 'channel_not_found' }, code: 'slack_webapi_platform_error' };
  const out = normalizeSlackErr(e, 'post_message');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'slack_api_error');
  assert.equal(out.op, 'post_message');
  assert.equal(out.detail, 'channel_not_found');
  assert.equal(out.code, 'slack_webapi_platform_error');
});

// ─── live tier (off by default) ─────────────────────────────────────────────

test('live: Slack auth.test round-trip', { skip: process.env.MIRAGE_SLACK_LIVE !== '1' }, async () => {
  const h = await slackAdapter.healthz();
  assert.equal(h.ok, true, `healthz not ready: ${JSON.stringify(h)}`);
});
