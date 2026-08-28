// 11-MIRAGE/adapters/redis.mjs — READY (Wave-2).
//
// Redis mount (fast scratch / cross-room ephemeral state — NOT durable Flux).
//   read   : get(key) | mget(keys) | keys(pattern) | hgetall(key) | exists(key) | ttl(key)
//   write  : set(key,value,ex?) | del(keys) | hset(key,fields) | expire(key,ex)
//            — every mutation gated by Hermes /v1/hermes/lease per call
//   healthz: PING (or honest stub when creds / ioredis missing — never throws)
//
// Auth: REDIS_URL env (redis:// or rediss:// for TLS in prod). External by design.
// Client: ioredis (lazy dynamic import; absence does NOT crash the registry).
// Spec: 11-MIRAGE/SPEC.md#redis
//
// Reality always overrides Thought on conflict. Receipts override recollection.
// Writes never bypass approval. If the lease HTTP route is down and the caller
// is not operator-approved, write() refuses — silent fall-through is the breach.
//
// KEYS discipline:
//   read({op:'keys', pattern}) is supported but DANGEROUS on large keyspaces —
//   adapter caps the match scan via SCAN with COUNT, and enforces a hard
//   max_keys ceiling. Operator can override the ceiling via REDIS_KEYS_MAX env.

const SPEC = '11-MIRAGE/SPEC.md#redis';

const REDIS_URL        = process.env.REDIS_URL || '';
const HERMES_BASE      = process.env.HERMES_BASE || 'http://127.0.0.1:7430';
const HERMES_PATH      = process.env.HERMES_LEASE_PATH || '/v1/hermes/lease';
const HERMES_TOKEN     = process.env.HERMES_TOKEN || '';
const FETCH_TIMEOUT_MS = parseInt(process.env.MIRAGE_FETCH_TIMEOUT_MS || '2500', 10);
const KEYS_MAX_DEFAULT = parseInt(process.env.REDIS_KEYS_MAX || '1000', 10);
const SCAN_COUNT       = parseInt(process.env.REDIS_SCAN_COUNT || '100', 10);

// ──────────────────────────────────────────────────────────────────────────────
// ioredis client — lazy singleton. Returns null when ioredis or creds missing.
// ──────────────────────────────────────────────────────────────────────────────
let _client = null;
let _loadError = null;

async function getClient() {
  if (_client) return _client;
  if (!REDIS_URL) return null;
  try {
    const mod = await import('ioredis');
    const Redis = mod.default || mod.Redis || mod;
    if (!Redis) throw new Error('ioredis default export not found');
    _client = new Redis(REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      connectTimeout: FETCH_TIMEOUT_MS,
      enableReadyCheck: true,
      // Don't blow up the process on connection errors — adapter reports honestly.
    });
    // Swallow background error events so unhandled errors don't crash the host.
    _client.on?.('error', (err) => { _loadError = String(err?.message || err); });
    return _client;
  } catch (err) {
    _loadError = String(err?.message || err);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Hermes lease — write path gate. Tries HTTP route first; honest refusal if down.
// ──────────────────────────────────────────────────────────────────────────────
async function requestLease({ action, key, args, operator_approved }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${HERMES_BASE}${HERMES_PATH}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        ...(HERMES_TOKEN ? { authorization: `Bearer ${HERMES_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        actor: 'mirage.redis',
        target_project: 'orange5',
        risk_level: 'medium', // redis is scratch, not durable Flux — medium not high
        action,
        resource: { mount: 'redis', key: Array.isArray(key) ? key : (key || null) },
        args,
        operator_approved: !!operator_approved,
      }),
    });
    const txt = await res.text();
    let body;
    try { body = JSON.parse(txt); } catch { body = txt; }
    if (res.ok && body && (body.allowed === true || body.ok === true)) {
      return { ok: true, source: 'hermes_http', lease: body };
    }
    return { ok: false, source: 'hermes_http', status: res.status, detail: body };
  } catch (err) {
    return { ok: false, source: 'hermes_http', err: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// KEYS scan — bounded by SCAN with COUNT and a hard ceiling. Never blocks.
// ──────────────────────────────────────────────────────────────────────────────
async function scanKeys(client, pattern, maxKeys) {
  const out = [];
  let cursor = '0';
  let safetyIterations = 0;
  // Safety: at SCAN_COUNT hint per pass, cap at maxKeys * 10 passes worst case.
  const maxIterations = Math.max(50, Math.ceil((maxKeys * 10) / SCAN_COUNT));
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
    cursor = next;
    for (const k of batch) {
      if (out.length >= maxKeys) return { keys: out, truncated: true };
      out.push(k);
    }
    safetyIterations++;
    if (safetyIterations > maxIterations) {
      return { keys: out, truncated: true, reason: 'scan_iteration_cap' };
    }
  } while (cursor !== '0');
  return { keys: out, truncated: false };
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * read(params)
 *   { op: 'get', key }                 -> { ok, value }
 *   { op: 'mget', keys: [...] }        -> { ok, values: [...] }
 *   { op: 'keys', pattern, max_keys? } -> { ok, keys, truncated } (SCAN under the hood)
 *   { op: 'hgetall', key }             -> { ok, fields: {...} }
 *   { op: 'exists', key }              -> { ok, exists: bool }
 *   { op: 'ttl', key }                 -> { ok, ttl } (-1 no expiry, -2 missing)
 * Default op is 'get' when key is present.
 */
async function read(params = {}) {
  const op = params.op || (params.key ? 'get' : params.keys ? 'mget' : params.pattern ? 'keys' : null);
  if (!op) {
    return { ok: false, reason: 'op_required', detail: 'pass op or key/keys/pattern', spec: SPEC };
  }

  if (!REDIS_URL) {
    return { ok: false, reason: 'no_redis_url', detail: 'REDIS_URL env not set', spec: SPEC };
  }
  const client = await getClient();
  if (!client) {
    return { ok: false, reason: 'redis_client_unavailable', detail: _loadError || 'ioredis npm module not installed', spec: SPEC };
  }

  try {
    if (op === 'get') {
      const key = String(params.key || '');
      if (!key) return { ok: false, reason: 'key_required', spec: SPEC };
      const value = await client.get(key);
      return { ok: true, op, key, value };
    }

    if (op === 'mget') {
      const keys = Array.isArray(params.keys) ? params.keys.map(String) : [];
      if (keys.length === 0) return { ok: false, reason: 'keys_required', spec: SPEC };
      const values = await client.mget(...keys);
      return { ok: true, op, keys, values };
    }

    if (op === 'keys') {
      const pattern = String(params.pattern || '');
      if (!pattern) return { ok: false, reason: 'pattern_required', spec: SPEC };
      const maxKeys = Math.max(1, Math.min(
        parseInt(params.max_keys ?? KEYS_MAX_DEFAULT, 10) || KEYS_MAX_DEFAULT,
        KEYS_MAX_DEFAULT,
      ));
      // Defensive: refuse the unbounded star unless operator explicitly opts in.
      if (pattern === '*' && params.allow_unbounded_star !== true) {
        return {
          ok: false,
          reason: 'unbounded_star_refused',
          detail: 'pattern="*" refused; pass allow_unbounded_star:true to override (still bounded by max_keys)',
          spec: SPEC,
        };
      }
      const r = await scanKeys(client, pattern, maxKeys);
      return { ok: true, op, pattern, max_keys: maxKeys, keys: r.keys, truncated: r.truncated, ...(r.reason ? { truncated_reason: r.reason } : {}) };
    }

    if (op === 'hgetall') {
      const key = String(params.key || '');
      if (!key) return { ok: false, reason: 'key_required', spec: SPEC };
      const fields = await client.hgetall(key);
      return { ok: true, op, key, fields };
    }

    if (op === 'exists') {
      const key = String(params.key || '');
      if (!key) return { ok: false, reason: 'key_required', spec: SPEC };
      const n = await client.exists(key);
      return { ok: true, op, key, exists: n === 1 };
    }

    if (op === 'ttl') {
      const key = String(params.key || '');
      if (!key) return { ok: false, reason: 'key_required', spec: SPEC };
      const ttl = await client.ttl(key);
      return { ok: true, op, key, ttl };
    }

    return { ok: false, reason: 'unknown_read_op', op, spec: SPEC };
  } catch (err) {
    return { ok: false, reason: 'redis_read_failed', detail: String(err?.message || err), spec: SPEC };
  }
}

/**
 * write(params)
 *   { op: 'set', key, value, ex?, nx?, xx?, operator_approved? }
 *   { op: 'del', key | keys: [...], operator_approved? }
 *   { op: 'hset', key, fields: {...}, operator_approved? }
 *   { op: 'expire', key, ex, operator_approved? }
 * Required: a Hermes lease grant for the action. No lease == no mutation.
 */
async function write(params = {}) {
  const op = String(params.op || '').toLowerCase();
  if (!['set', 'del', 'hset', 'expire'].includes(op)) {
    return { ok: false, reason: 'write_op_required', detail: 'op must be set|del|hset|expire', spec: SPEC };
  }

  // Op-specific arg validation BEFORE creds/lease so callers get fast feedback.
  let key = null;
  let keys = null;
  let leaseArgs = {};
  if (op === 'set') {
    key = String(params.key || '');
    if (!key) return { ok: false, reason: 'key_required', spec: SPEC };
    if (params.value === undefined || params.value === null) {
      return { ok: false, reason: 'value_required', spec: SPEC };
    }
    leaseArgs = { ex: params.ex ?? null, nx: !!params.nx, xx: !!params.xx };
  } else if (op === 'del') {
    if (Array.isArray(params.keys)) {
      keys = params.keys.map(String).filter(Boolean);
    } else if (params.key) {
      keys = [String(params.key)];
    } else {
      return { ok: false, reason: 'key_or_keys_required', spec: SPEC };
    }
    if (keys.length === 0) return { ok: false, reason: 'key_or_keys_required', spec: SPEC };
    leaseArgs = { count: keys.length };
  } else if (op === 'hset') {
    key = String(params.key || '');
    if (!key) return { ok: false, reason: 'key_required', spec: SPEC };
    if (!params.fields || typeof params.fields !== 'object' || Array.isArray(params.fields)) {
      return { ok: false, reason: 'fields_object_required', spec: SPEC };
    }
    if (Object.keys(params.fields).length === 0) {
      return { ok: false, reason: 'fields_object_required', spec: SPEC };
    }
    leaseArgs = { field_count: Object.keys(params.fields).length };
  } else if (op === 'expire') {
    key = String(params.key || '');
    if (!key) return { ok: false, reason: 'key_required', spec: SPEC };
    const ex = parseInt(params.ex, 10);
    if (!Number.isFinite(ex) || ex <= 0) {
      return { ok: false, reason: 'ex_seconds_required', spec: SPEC };
    }
    leaseArgs = { ex };
  }

  if (!REDIS_URL) {
    return { ok: false, reason: 'no_redis_url', detail: 'REDIS_URL env not set', spec: SPEC };
  }

  // Hermes lease — required. Honest refusal if route is down and not approved.
  const lease = await requestLease({
    action: `redis.${op}`,
    key: keys || key,
    args: leaseArgs,
    operator_approved: !!params.operator_approved,
  });
  if (!lease.ok) {
    return {
      ok: false,
      reason: 'hermes_lease_denied',
      detail: lease.detail || lease.err || `lease unreachable (${HERMES_BASE}${HERMES_PATH})`,
      lease_source: lease.source,
      spec: SPEC,
    };
  }

  const client = await getClient();
  if (!client) {
    return { ok: false, reason: 'redis_client_unavailable', detail: _loadError || 'ioredis npm module not installed', spec: SPEC };
  }

  try {
    let result;
    if (op === 'set') {
      const v = typeof params.value === 'string' ? params.value : JSON.stringify(params.value);
      const args = [key, v];
      if (params.ex && Number.isFinite(parseInt(params.ex, 10))) args.push('EX', parseInt(params.ex, 10));
      if (params.nx) args.push('NX');
      else if (params.xx) args.push('XX');
      result = await client.set(...args);
    } else if (op === 'del') {
      result = await client.del(...keys);
    } else if (op === 'hset') {
      // ioredis hset accepts a flat object — but defensively flatten ourselves to
      // avoid version drift (some ioredis versions only accept k,v,k,v...).
      const flat = [];
      for (const [k, v] of Object.entries(params.fields)) {
        flat.push(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
      result = await client.hset(key, ...flat);
    } else if (op === 'expire') {
      result = await client.expire(key, parseInt(params.ex, 10));
    }

    return {
      ok: true,
      op,
      result,
      receipt: {
        mount: 'redis',
        action: `redis.${op}`,
        lease_id: lease.lease?.id || lease.lease?.lease_id || null,
        lease_source: lease.source,
        key: keys || key,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (err) {
    return { ok: false, reason: 'redis_write_failed', detail: String(err?.message || err), spec: SPEC };
  }
}

/**
 * healthz()
 *   PING against the configured client. Honest stub when creds / ioredis missing — never throws.
 */
async function healthz() {
  if (!REDIS_URL) {
    return { ok: false, status: 'no_creds', detail: 'REDIS_URL env not set', spec: SPEC };
  }
  const client = await getClient();
  if (!client) {
    return { ok: false, status: 'redis_client_unavailable', detail: _loadError || 'ioredis npm module not installed', spec: SPEC };
  }
  try {
    const pong = await client.ping();
    const ok = pong === 'PONG';
    return { ok, status: ok ? 'ready' : 'unexpected_response', detail: ok ? null : String(pong), spec: SPEC };
  } catch (err) {
    return { ok: false, status: 'unreachable', detail: String(err?.message || err), spec: SPEC };
  }
}

// Exposed for tests — not part of the adapter contract.
export const __internals = Object.freeze({ scanKeys });

export const redisAdapter = Object.freeze({ read, write, healthz });
export default redisAdapter;
