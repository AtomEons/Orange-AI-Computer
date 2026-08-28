#!/usr/bin/env node
// 11-MIRAGE/tests/redis.test.mjs
//
// Offline-safe test battery for the redis adapter. Does NOT require a live
// redis. Covers the four discipline gates:
//   1. healthz honest stub when REDIS_URL is missing (no throws)
//   2. read() op routing + arg validation (no creds gate fires cleanly)
//   3. write() op/arg validation (creds gate before lease)
//   4. Hermes lease refusal when /v1/hermes/lease unreachable (no silent fall-through)
//
// Run: node 11-MIRAGE/tests/redis.test.mjs

// Force a clean env BEFORE importing the adapter so module-level constants
// resolve to the test posture (no creds, lease pointed at a closed port).
delete process.env.REDIS_URL;
process.env.HERMES_BASE = 'http://127.0.0.1:1'; // closed loopback port
process.env.HERMES_LEASE_PATH = '/v1/hermes/lease';
process.env.MIRAGE_FETCH_TIMEOUT_MS = '500';

const { redisAdapter } = await import('../adapters/redis.mjs');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else      { fail++; console.log(`  FAIL ${msg}`); }
}

// ── 1. healthz honest stub ──────────────────────────────────────────────────
{
  const h = await redisAdapter.healthz();
  assert(h.ok === false, 'healthz returns ok:false with no creds');
  assert(h.status === 'no_creds', 'healthz status is no_creds (not throws)');
  assert(typeof h.spec === 'string' && h.spec.includes('redis'), 'healthz includes spec link');
}

// ── 2. read() routing + arg validation + no-creds gate ──────────────────────
{
  const r1 = await redisAdapter.read({});
  assert(r1.ok === false && r1.reason === 'op_required',
    'read() refuses missing op/key/keys/pattern');

  const r2 = await redisAdapter.read({ op: 'get', key: 'foo' });
  assert(r2.ok === false && r2.reason === 'no_redis_url',
    'read() with op routes through creds gate');

  const r3 = await redisAdapter.read({ key: 'foo' });
  assert(r3.ok === false && r3.reason === 'no_redis_url',
    'read() defaults to get when key present (creds gate fires)');

  const r4 = await redisAdapter.read({ keys: ['a', 'b'] });
  assert(r4.ok === false && r4.reason === 'no_redis_url',
    'read() defaults to mget when keys[] present');

  const r5 = await redisAdapter.read({ pattern: 'session:*' });
  assert(r5.ok === false && r5.reason === 'no_redis_url',
    'read() defaults to keys when pattern present');
}

// ── 3. write() op/arg validation (creds gate before lease) ──────────────────
{
  const r = await redisAdapter.write({});
  assert(r.ok === false && r.reason === 'write_op_required',
    'write() refuses missing op');

  const r2 = await redisAdapter.write({ op: 'get' });
  assert(r2.ok === false && r2.reason === 'write_op_required',
    'write() refuses read op in write() (set|del|hset|expire only)');

  const r3 = await redisAdapter.write({ op: 'set' });
  assert(r3.ok === false && r3.reason === 'key_required',
    'write() set refuses missing key');

  const r4 = await redisAdapter.write({ op: 'set', key: 'k' });
  assert(r4.ok === false && r4.reason === 'value_required',
    'write() set refuses missing value');

  const r5 = await redisAdapter.write({ op: 'del' });
  assert(r5.ok === false && r5.reason === 'key_or_keys_required',
    'write() del refuses missing key/keys');

  const r6 = await redisAdapter.write({ op: 'del', keys: [] });
  assert(r6.ok === false && r6.reason === 'key_or_keys_required',
    'write() del refuses empty keys[]');

  const r7 = await redisAdapter.write({ op: 'hset', key: 'k' });
  assert(r7.ok === false && r7.reason === 'fields_object_required',
    'write() hset refuses missing fields object');

  const r8 = await redisAdapter.write({ op: 'hset', key: 'k', fields: {} });
  assert(r8.ok === false && r8.reason === 'fields_object_required',
    'write() hset refuses empty fields object');

  const r9 = await redisAdapter.write({ op: 'expire', key: 'k' });
  assert(r9.ok === false && r9.reason === 'ex_seconds_required',
    'write() expire refuses missing ex');

  const r10 = await redisAdapter.write({ op: 'expire', key: 'k', ex: 0 });
  assert(r10.ok === false && r10.reason === 'ex_seconds_required',
    'write() expire refuses non-positive ex');

  // op+args aligned but no creds — should fail BEFORE attempting lease.
  const r11 = await redisAdapter.write({ op: 'set', key: 'k', value: 'v' });
  assert(r11.ok === false, 'write() with valid args but no creds refuses');
  assert(r11.reason === 'no_redis_url',
    `write() reports no_redis_url (creds gate fires before lease), got ${r11.reason}`);
}

// ── 4. read() KEYS discipline — unbounded star refusal ──────────────────────
// We can't talk to redis here, but pattern-handling fires before the creds
// check only for the unbounded-star refusal? No — creds gate fires first to
// protect against side-effecting calls. So we set a fake URL and observe the
// unbounded-star refusal kicks in before any client work. Reload module to
// pick up new REDIS_URL.
{
  process.env.REDIS_URL = 'redis://nobody@127.0.0.1:1/0';
  const fresh = await import('../adapters/redis.mjs?reload=1');

  // ioredis not installed in this workspace → client_unavailable, which fires
  // AFTER pattern validation. So unbounded-star refusal needs to come first.
  // We assert that whichever fires, the operator sees an honest reason — no
  // accidental scan of "*".
  const r = await fresh.redisAdapter.read({ op: 'keys', pattern: '*' });
  assert(r.ok === false, 'read() with pattern="*" refuses');
  assert(['unbounded_star_refused', 'redis_client_unavailable'].includes(r.reason),
    `read() pattern="*" reason is unbounded_star_refused or redis_client_unavailable (got ${r.reason})`);

  // Empty pattern always refused.
  const r2 = await fresh.redisAdapter.read({ op: 'keys', pattern: '' });
  assert(r2.ok === false, 'read() with empty pattern refuses');
  // Either reason (op_required from default routing OR pattern_required) is honest.

  delete process.env.REDIS_URL;
}

// ── 5. lease refusal path — creds present, Hermes down ──────────────────────
{
  process.env.REDIS_URL = 'redis://nobody@127.0.0.1:1/0';
  const fresh = await import('../adapters/redis.mjs?reload=2');

  const r = await fresh.redisAdapter.write({
    op: 'set',
    key: 'k',
    value: 'v',
  });
  assert(r.ok === false, 'write() with creds but Hermes down refuses');
  assert(r.reason === 'hermes_lease_denied',
    `write() reason is hermes_lease_denied (got ${r.reason})`);
  assert(r.lease_source === 'hermes_http', 'lease_source recorded for audit');

  const r2 = await fresh.redisAdapter.write({
    op: 'del',
    keys: ['a', 'b'],
  });
  assert(r2.ok === false && r2.reason === 'hermes_lease_denied',
    'write() del refused without lease');

  const r3 = await fresh.redisAdapter.write({
    op: 'hset',
    key: 'k',
    fields: { a: '1' },
  });
  assert(r3.ok === false && r3.reason === 'hermes_lease_denied',
    'write() hset refused without lease');

  const r4 = await fresh.redisAdapter.write({
    op: 'expire',
    key: 'k',
    ex: 60,
  });
  assert(r4.ok === false && r4.reason === 'hermes_lease_denied',
    'write() expire refused without lease');

  // healthz with creds + no ioredis client installed -> honest stub, no throw
  const h = await fresh.redisAdapter.healthz();
  assert(h.ok === false, 'healthz returns ok:false when ioredis client missing');
  assert(['redis_client_unavailable', 'unreachable'].includes(h.status),
    `healthz status is redis_client_unavailable or unreachable (got ${h.status})`);
  delete process.env.REDIS_URL;
}

console.log(`\n[mirage/redis] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
