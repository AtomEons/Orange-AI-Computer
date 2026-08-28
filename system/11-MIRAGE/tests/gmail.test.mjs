// 11-MIRAGE/tests/gmail.test.mjs
//
// Tests for the Gmail adapter that DO NOT require real Google creds or a real
// googleapis install. Anything that hits Gmail itself is gated behind a
// MIRAGE_GMAIL_LIVE=1 env flag and skipped by default — Mom's Law: no fake
// green from a test that pretends to exercise an external API it can't reach.
//
// Strategy:
//   - Spin up a local loopback HTTP server that impersonates the Hermes lease
//     endpoint, so write() can prove its fail-closed + lease-acquisition path.
//   - Verify healthz() emits honest stubs when creds / googleapis are absent.
//   - Verify read()/write() refuse cleanly (no throws) under stub conditions.
//   - Validate the RFC-5322 + base64url composition helpers in isolation.
//
// Run:
//   node --test 11-MIRAGE/tests/gmail.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { gmailAdapter, __resetForTests, __internals } from '../adapters/gmail.mjs';

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
          actor: 'mirage.gmail',
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

function clearGmailEnv() {
  delete process.env.GMAIL_REFRESH_TOKEN;
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
  __resetForTests();
}

// ─── healthz: honest stubs ──────────────────────────────────────────────────

test('healthz() reports degraded_no_creds when env vars are unset', async () => {
  clearGmailEnv();
  const h = await gmailAdapter.healthz();
  assert.equal(h.ok, false);
  assert.equal(h.status, 'degraded_no_creds');
  assert.ok(typeof h.detail === 'string');
  assert.equal(h.spec, '11-MIRAGE/SPEC.md#gmail');
  assert.equal(h.adapter, 'gmail');
  assert.equal(h.writes_require_approval, true);
  assert.equal(h.family, 'data');
});

test('healthz() does not throw when called twice in a row', async () => {
  clearGmailEnv();
  await gmailAdapter.healthz();
  const h = await gmailAdapter.healthz();
  assert.equal(h.status, 'degraded_no_creds');
});

test('healthz() detail names all three missing env vars', async () => {
  clearGmailEnv();
  const h = await gmailAdapter.healthz();
  assert.match(h.detail, /GMAIL_REFRESH_TOKEN/);
  assert.match(h.detail, /GMAIL_CLIENT_ID/);
  assert.match(h.detail, /GMAIL_CLIENT_SECRET/);
});

// ─── read: refuses cleanly when creds missing ───────────────────────────────

test('read() returns ok:false with creds_missing when env unset', async () => {
  clearGmailEnv();
  const r = await gmailAdapter.read({ op: 'list_threads', query: 'from:me' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
  assert.ok(Array.isArray(r.missing) && r.missing.length === 3);
});

test('read() defaults op to list_threads', async () => {
  clearGmailEnv();
  const r = await gmailAdapter.read({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
});

test('read({op:search}) with creds missing still refuses cleanly', async () => {
  clearGmailEnv();
  const r = await gmailAdapter.read({ op: 'search', q: 'subject:hello' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');
});

test('read() with unknown op refuses cleanly (no throw)', async () => {
  clearGmailEnv();
  const r = await gmailAdapter.read({ op: 'definitely_not_a_real_op' });
  assert.equal(r.ok, false);
  assert.ok(r.reason === 'creds_missing' || String(r.reason).startsWith('unknown_op'));
});

// ─── write: surface validation runs before Hermes ───────────────────────────

test('write() rejects unknown op without Hermes', async () => {
  const r = await gmailAdapter.write({ op: 'delete_inbox' });
  assert.equal(r.ok, false);
  assert.ok(String(r.reason).startsWith('unknown_op'));
});

test('write() requires to/subject/body', async () => {
  let r = await gmailAdapter.write({ op: 'send' });
  assert.equal(r.reason, 'to_required');

  r = await gmailAdapter.write({ op: 'send', to: 'a@b.com' });
  assert.equal(r.reason, 'subject_required');

  r = await gmailAdapter.write({ op: 'send', to: 'a@b.com', subject: 'hi' });
  assert.equal(r.reason, 'body_required');
});

test('write() rejects malformed addresses', async () => {
  const r = await gmailAdapter.write({
    op: 'send', to: 'not-an-email', subject: 'x', body: 'y',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'to_malformed');
});

test('write() rejects malformed cc/bcc', async () => {
  let r = await gmailAdapter.write({
    op: 'send', to: 'ok@ex.com', cc: 'bogus', subject: 'x', body: 'y',
  });
  assert.equal(r.reason, 'cc_malformed');

  r = await gmailAdapter.write({
    op: 'send', to: 'ok@ex.com', bcc: 'bogus', subject: 'x', body: 'y',
  });
  assert.equal(r.reason, 'bcc_malformed');
});

// ─── write: fail-closed without Hermes ──────────────────────────────────────

test('write() is fail-closed when Hermes is unreachable', async () => {
  clearGmailEnv();
  process.env.HERMES_BASE = 'http://127.0.0.1:1';
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';
  process.env.MIRAGE_HERMES_TIMEOUT_MS = '300';

  const r = await gmailAdapter.write({
    op: 'send',
    to: 'someone@example.com',
    subject: 'hi',
    body: 'hello',
    approval_token: 'op-approves',
  });
  assert.equal(r.ok, false);
  assert.ok(['hermes_unreachable', 'hermes_lease_denied'].includes(r.reason),
    `unexpected reason: ${r.reason}`);
});

// ─── write: Hermes lease handshake (mocked) ─────────────────────────────────

test('write() acquires a Hermes lease and posts actor=mirage.gmail with approval header', async () => {
  clearGmailEnv();
  const hermes = await startHermesMock({ approve: true });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';
  process.env.MIRAGE_HERMES_TIMEOUT_MS = '2000';

  const r = await gmailAdapter.write({
    op: 'send',
    to: 'someone@example.com',
    subject: 'subj',
    body: 'body',
    approval_token: 'sovereign-ok',
  });

  // Hermes side must have received a well-shaped lease request.
  assert.ok(hermes.lastBody, 'Hermes mock saw no request');
  assert.equal(hermes.lastBody.actor, 'mirage.gmail');
  assert.equal(hermes.lastBody.targetProject, 'orange5');
  assert.equal(hermes.lastBody.riskLevel, 'high');
  assert.deepEqual(hermes.lastBody.allowed, ['gmail.send']);
  assert.equal(hermes.lastBody.requires_approval, true);
  assert.equal(hermes.lastHeaders['x-operator-approval'], 'sovereign-ok');

  // After lease, the call falls through to googleapis. Without real creds the
  // adapter must refuse with creds_missing (NOT throw, NOT fake-green).
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creds_missing');

  await hermes.close();
});

test('write() refuses when Hermes returns malformed body', async () => {
  clearGmailEnv();
  const hermes = await startHermesMock({ malformed: true });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await gmailAdapter.write({
    op: 'send',
    to: 'someone@example.com',
    subject: 's',
    body: 'b',
    approval_token: 'sov',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hermes_lease_malformed');

  await hermes.close();
});

test('write() refuses when lease requires approval and no token supplied', async () => {
  clearGmailEnv();
  const hermes = await startHermesMock({ approve: false });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await gmailAdapter.write({
    op: 'send',
    to: 'someone@example.com',
    subject: 's',
    body: 'b',
    // no approval_token
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'operator_approval_required');

  await hermes.close();
});

test('write() refuses on Hermes 4xx', async () => {
  clearGmailEnv();
  const hermes = await startHermesMock({ status: 403 });
  process.env.HERMES_BASE = hermes.url;
  process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';

  const r = await gmailAdapter.write({
    op: 'send',
    to: 'someone@example.com',
    subject: 's',
    body: 'b',
    approval_token: 'sov',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hermes_lease_denied');
  assert.equal(r.status, 403);

  await hermes.close();
});

// ─── RFC-5322 + base64url composition ───────────────────────────────────────

test('buildRfc822 emits required headers and CRLF terminators', () => {
  const { buildRfc822 } = __internals;
  const raw = buildRfc822({
    to: 'a@b.com',
    subject: 'hi',
    body: 'hello world',
  });
  assert.match(raw, /^To: a@b\.com\r\n/);
  assert.match(raw, /Subject: hi\r\n/);
  assert.match(raw, /MIME-Version: 1\.0\r\n/);
  assert.match(raw, /Content-Type: text\/plain; charset="UTF-8"\r\n/);
  assert.ok(raw.endsWith('hello world'));
});

test('buildRfc822 includes cc, bcc, from when provided', () => {
  const { buildRfc822 } = __internals;
  const raw = buildRfc822({
    to: 'a@b.com',
    cc: 'c@d.com',
    bcc: 'e@f.com',
    from: 'me@here.com',
    subject: 'x',
    body: 'y',
  });
  assert.match(raw, /^From: me@here\.com\r\n/);
  assert.match(raw, /Cc: c@d\.com\r\n/);
  assert.match(raw, /Bcc: e@f\.com\r\n/);
});

test('buildRfc822 emits text/html when mime=html', () => {
  const { buildRfc822 } = __internals;
  const raw = buildRfc822({
    to: 'a@b.com', subject: 's', body: '<p>hi</p>', mime: 'html',
  });
  assert.match(raw, /Content-Type: text\/html; charset="UTF-8"\r\n/);
});

test('rfc2047encodeIfNeeded passes ASCII through, encodes non-ASCII', () => {
  const { rfc2047encodeIfNeeded } = __internals;
  assert.equal(rfc2047encodeIfNeeded('plain ascii'), 'plain ascii');
  const enc = rfc2047encodeIfNeeded('café résumé');
  assert.match(enc, /^=\?UTF-8\?B\?.+\?=$/);
  // Round-trips through base64.
  const b64 = enc.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'café résumé');
});

test('toBase64Url produces url-safe base64 with no padding', () => {
  const { toBase64Url } = __internals;
  const s = toBase64Url('hello?>/');
  assert.ok(!/[+/=]/.test(s), `must not contain + / = (got ${s})`);
  // Round-trip via standard base64 (re-pad and swap chars).
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + '==';
  assert.equal(Buffer.from(std, 'base64').toString('utf8'), 'hello?>/');
});

test('looksLikeEmailList accepts bare and angle-bracket forms and comma lists', () => {
  const { looksLikeEmailList } = __internals;
  assert.equal(looksLikeEmailList('a@b.com'), true);
  assert.equal(looksLikeEmailList('Atom <a@b.com>'), true);
  assert.equal(looksLikeEmailList('a@b.com, c@d.com'), true);
  assert.equal(looksLikeEmailList('Atom <a@b.com>, c@d.com'), true);
  assert.equal(looksLikeEmailList(''), false);
  assert.equal(looksLikeEmailList('nope'), false);
  assert.equal(looksLikeEmailList('a@b.com, nope'), false);
});

// ─── live tier (off by default) ─────────────────────────────────────────────

test('live: Gmail getProfile round-trip', { skip: process.env.MIRAGE_GMAIL_LIVE !== '1' }, async () => {
  const h = await gmailAdapter.healthz();
  assert.equal(h.ok, true, `healthz not ready: ${JSON.stringify(h)}`);
});
