// AE OrangeLLM — AtomSmasher Compression Debt Ledger gateway routes
// Path: 06-ORANGELLM/server/routes/atomsmasher-compression-debt.mjs
//
// Doctrine:
//   - The Compression Debt Ledger is the receipt for verbose-over-compressed
//     choices the system made (Mom's Law: name the gap, don't hide it).
//   - The ledger module at 12-ATOMSMASHER/compression-debt/ledger.mjs is the
//     single writer of record. These routes are thin HTTP adapters over it.
//   - Reads (GET) return immutable projections; writes (POST) emit Flux
//     Reality lane events plus SQLite mirrors. Receipts (debt_id,
//     flux_record_hash, savings_chars) flow back to the caller so the chain
//     is externally verifiable.
//
// Routes registered (all under /v1/atomsmasher/compression-debt):
//   GET  /v1/atomsmasher/compression-debt
//        Query: ?status=&surface=&since=&limit=&include_summary=true
//        -> 200 { debts: [...], count, filters, summary?, generated_at }
//
//   GET  /v1/atomsmasher/compression-debt/:debt_id
//        -> 200 { debt }
//        -> 404 if not found
//
//   POST /v1/atomsmasher/compression-debt/record
//        body: { verbose_text, context: { surface, actor, ref?, reason? },
//                recorded_at? }
//        -> 201 { debt_id, flux_record_hash, debt }
//        -> 200 { debt_id, duplicate: true, ... } on idempotent re-record
//
//   POST /v1/atomsmasher/compression-debt/pay
//        body: { debt_id, compressed_text, payment_evidence, paid_at? }
//        -> 200 { debt_id, savings_chars, regression, flux_record_hash }
//
//   POST /v1/atomsmasher/compression-debt/forgive
//        body: { debt_id, payment_evidence, paid_at? }
//        -> 200 { debt_id, status: 'forgiven', flux_record_hash }
//
// Boundary note: these paths must be added to the AtomSmasher boundary
// allow-list before they are reachable from outside loopback.

import { URL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  recordDebt,
  payDebt,
  forgiveDebt,
  getDebt,
  listDebts,
  debtSummary,
} from '../../../12-ATOMSMASHER/compression-debt/ledger.mjs';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB; verbose prose can be large
const MAX_VERBOSE_BYTES = 2 * 1024 * 1024;
const DEBT_ID_RE = /^[a-f0-9]{64}$/;
const PATH_PREFIX = '/v1/atomsmasher/compression-debt';

function resolveDefaultFluxRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'memory', 'ae-cobra', 'flux');
}

function resolveDefaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'memory', 'compression-debt.db');
}

// ---------------------------------------------------------------------------
// HTTP helpers (mirror atomsmasher.mjs / atomsmasher-air.mjs conventions)
// ---------------------------------------------------------------------------

function jsonResponse(res, body, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errorResponse(res, message, status = 400, code = 'invalid_request_error', extra = {}) {
  jsonResponse(
    res,
    {
      error: {
        message,
        type: code,
        code: status,
        ...extra,
      },
    },
    status,
  );
}

async function readJsonBody(req, capBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > capBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      try {
        resolve(JSON.parse(buf.toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

function matchRoute(method, pathName) {
  if (!pathName.startsWith(PATH_PREFIX)) return null;
  const rest = pathName.slice(PATH_PREFIX.length);

  // /v1/atomsmasher/compression-debt        (list + optional summary)
  if (rest === '' || rest === '/') {
    if (method === 'GET') return { name: 'list' };
    return { name: 'method_not_allowed', allowed: ['GET'] };
  }
  // /v1/atomsmasher/compression-debt/record
  if (rest === '/record') {
    if (method === 'POST') return { name: 'record' };
    return { name: 'method_not_allowed', allowed: ['POST'] };
  }
  // /v1/atomsmasher/compression-debt/pay
  if (rest === '/pay') {
    if (method === 'POST') return { name: 'pay' };
    return { name: 'method_not_allowed', allowed: ['POST'] };
  }
  // /v1/atomsmasher/compression-debt/forgive
  if (rest === '/forgive') {
    if (method === 'POST') return { name: 'forgive' };
    return { name: 'method_not_allowed', allowed: ['POST'] };
  }
  // /v1/atomsmasher/compression-debt/summary
  if (rest === '/summary') {
    if (method === 'GET') return { name: 'summary' };
    return { name: 'method_not_allowed', allowed: ['GET'] };
  }
  // /v1/atomsmasher/compression-debt/:debt_id
  const idMatch = rest.match(/^\/([a-f0-9]{64})$/);
  if (idMatch) {
    if (method === 'GET') return { name: 'get_one', debt_id: idMatch[1] };
    return { name: 'method_not_allowed', allowed: ['GET'] };
  }
  return { name: 'not_found' };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleList(url, cfg) {
  const q = url.searchParams;
  const status = q.get('status') || undefined;
  const surface = q.get('surface') || undefined;
  const since = q.get('since') || undefined;
  const includeSummary = q.get('include_summary') === 'true';
  let limit = 1000;
  if (q.has('limit')) {
    const parsed = Number.parseInt(q.get('limit'), 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100000) {
      return {
        status: 400,
        body: {
          error: {
            message: 'limit must be a positive integer <= 100000',
            type: 'invalid_request_error',
            code: 400,
          },
        },
      };
    }
    limit = parsed;
  }

  let debts;
  try {
    debts = listDebts({
      status, surface, since, limit,
      dbPath: cfg.dbPath,
    });
  } catch (e) {
    return {
      status: 400,
      body: {
        error: { message: e.message, type: 'invalid_request_error', code: 400 },
      },
    };
  }

  const body = {
    debts,
    count: debts.length,
    filters: { status: status || null, surface: surface || null, since: since || null, limit },
    generated_at: nowIso(),
  };
  if (includeSummary) {
    try {
      body.summary = debtSummary({ dbPath: cfg.dbPath, surface, since });
    } catch (e) {
      // Don't blow up the list because the summary failed; surface honestly.
      body.summary_error = e.message;
    }
  }
  return { status: 200, body };
}

function handleSummary(url, cfg) {
  const q = url.searchParams;
  const surface = q.get('surface') || undefined;
  const since = q.get('since') || undefined;
  let summary;
  try {
    summary = debtSummary({ dbPath: cfg.dbPath, surface, since });
  } catch (e) {
    return {
      status: 400,
      body: { error: { message: e.message, type: 'invalid_request_error', code: 400 } },
    };
  }
  return { status: 200, body: summary };
}

function handleGetOne(debtId, cfg) {
  let entry;
  try {
    entry = getDebt(debtId, { dbPath: cfg.dbPath });
  } catch (e) {
    return {
      status: 400,
      body: { error: { message: e.message, type: 'invalid_request_error', code: 400 } },
    };
  }
  if (!entry) {
    return {
      status: 404,
      body: {
        error: {
          message: `compression debt not found: ${debtId}`,
          type: 'not_found',
          code: 404,
        },
      },
    };
  }
  return { status: 200, body: { debt: entry, generated_at: nowIso() } };
}

function handleRecord(raw, cfg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      status: 400,
      body: {
        error: {
          message: 'body must be a JSON object',
          type: 'invalid_request_error', code: 400,
        },
      },
    };
  }
  const { verbose_text, context, recorded_at } = raw;
  if (typeof verbose_text !== 'string' || verbose_text.length === 0) {
    return {
      status: 400,
      body: {
        error: {
          message: 'verbose_text required (non-empty string)',
          type: 'invalid_request_error', code: 400,
        },
      },
    };
  }
  if (Buffer.byteLength(verbose_text, 'utf8') > MAX_VERBOSE_BYTES) {
    return {
      status: 413,
      body: {
        error: {
          message: `verbose_text exceeds ${MAX_VERBOSE_BYTES} bytes; chunk before recording`,
          type: 'input_too_large', code: 413,
        },
      },
    };
  }

  const res = recordDebt({
    verboseText: verbose_text,
    context,
    recordedAt: recorded_at,
    fluxRoot: cfg.fluxRoot,
    dbPath: cfg.dbPath,
  });
  if (!res.ok) {
    return {
      status: 400,
      body: { error: { message: res.error, type: 'invalid_request_error', code: 400 } },
    };
  }
  if (res.duplicate) {
    // Idempotent re-record: 200, not 201. Caller can detect via duplicate flag.
    return {
      status: 200,
      body: {
        debt_id: res.debt_id,
        duplicate: true,
        status: res.status,
        debt: getDebt(res.debt_id, { dbPath: cfg.dbPath }),
      },
    };
  }
  return {
    status: 201,
    body: {
      debt_id: res.debt_id,
      flux_record_hash: res.flux_record_hash,
      debt: getDebt(res.debt_id, { dbPath: cfg.dbPath }),
    },
  };
}

function handlePay(raw, cfg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      status: 400,
      body: {
        error: { message: 'body must be a JSON object', type: 'invalid_request_error', code: 400 },
      },
    };
  }
  const { debt_id, compressed_text, payment_evidence, paid_at } = raw;
  if (typeof debt_id !== 'string' || !DEBT_ID_RE.test(debt_id)) {
    return {
      status: 400,
      body: {
        error: {
          message: 'debt_id required (sha256 hex)',
          type: 'invalid_request_error', code: 400,
        },
      },
    };
  }
  const res = payDebt({
    debtId: debt_id,
    compressedText: compressed_text,
    paymentEvidence: payment_evidence,
    paidAt: paid_at,
    fluxRoot: cfg.fluxRoot,
    dbPath: cfg.dbPath,
  });
  if (!res.ok) {
    // Distinguish 404 (no such debt) from 409 (state conflict) from 400 (bad input).
    if (res.error && res.error.startsWith('debt not found')) {
      return {
        status: 404,
        body: { error: { message: res.error, type: 'not_found', code: 404 } },
      };
    }
    if (res.error && (res.error.includes('already paid') || res.error.includes('forgiven'))) {
      return {
        status: 409,
        body: {
          error: {
            message: res.error,
            type: 'state_conflict', code: 409,
            ...(res.existing_compressed_hash
              ? { existing_compressed_hash: res.existing_compressed_hash }
              : {}),
          },
        },
      };
    }
    return {
      status: 400,
      body: { error: { message: res.error, type: 'invalid_request_error', code: 400 } },
    };
  }
  return {
    status: 200,
    body: {
      debt_id: res.debt_id,
      savings_chars: res.savings_chars,
      regression: res.regression,
      already: res.already || false,
      flux_record_hash: res.flux_record_hash || null,
      debt: getDebt(res.debt_id, { dbPath: cfg.dbPath }),
    },
  };
}

function handleForgive(raw, cfg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      status: 400,
      body: {
        error: { message: 'body must be a JSON object', type: 'invalid_request_error', code: 400 },
      },
    };
  }
  const { debt_id, payment_evidence, paid_at } = raw;
  if (typeof debt_id !== 'string' || !DEBT_ID_RE.test(debt_id)) {
    return {
      status: 400,
      body: {
        error: {
          message: 'debt_id required (sha256 hex)',
          type: 'invalid_request_error', code: 400,
        },
      },
    };
  }
  const res = forgiveDebt({
    debtId: debt_id,
    paymentEvidence: payment_evidence,
    paidAt: paid_at,
    fluxRoot: cfg.fluxRoot,
    dbPath: cfg.dbPath,
  });
  if (!res.ok) {
    if (res.error && res.error.startsWith('debt not found')) {
      return {
        status: 404,
        body: { error: { message: res.error, type: 'not_found', code: 404 } },
      };
    }
    if (res.error && res.error.includes('already paid')) {
      return {
        status: 409,
        body: { error: { message: res.error, type: 'state_conflict', code: 409 } },
      };
    }
    return {
      status: 400,
      body: { error: { message: res.error, type: 'invalid_request_error', code: 400 } },
    };
  }
  return {
    status: 200,
    body: {
      debt_id: res.debt_id,
      status: 'forgiven',
      already: res.already || false,
      flux_record_hash: res.flux_record_hash || null,
      debt: getDebt(res.debt_id, { dbPath: cfg.dbPath }),
    },
  };
}

// ---------------------------------------------------------------------------
// Public: registerCompressionDebtRoutes(server, opts)
// ---------------------------------------------------------------------------

export function registerCompressionDebtRoutes(server, opts = {}) {
  if (!server || typeof server.on !== 'function') {
    throw new TypeError('registerCompressionDebtRoutes: server must be a node:http Server');
  }

  const cfg = {
    fluxRoot: opts.fluxRoot || resolveDefaultFluxRoot(),
    dbPath: opts.dbPath || resolveDefaultDbPath(),
    log:
      typeof opts.log === 'function'
        ? opts.log
        : (line) => {
            // eslint-disable-next-line no-console
            console.log(line);
          },
  };

  server.prependListener('request', async (req, res) => {
    if (res.writableEnded) return;

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return;
    }
    const method = (req.method || 'GET').toUpperCase();
    const pathName = url.pathname;

    if (!pathName.startsWith(PATH_PREFIX)) return;

    const route = matchRoute(method, pathName);
    if (!route) return;

    if (route.name === 'not_found') {
      return errorResponse(
        res,
        `compression-debt route not found: ${method} ${pathName}`,
        404,
        'route_not_found',
      );
    }
    if (route.name === 'method_not_allowed') {
      res.setHeader('Allow', route.allowed.join(', '));
      return errorResponse(
        res,
        `method ${method} not allowed on ${pathName}`,
        405,
        'method_not_allowed',
        { allowed: route.allowed },
      );
    }

    try {
      if (route.name === 'list') {
        const { status, body } = handleList(url, cfg);
        return jsonResponse(res, body, status);
      }
      if (route.name === 'summary') {
        const { status, body } = handleSummary(url, cfg);
        return jsonResponse(res, body, status);
      }
      if (route.name === 'get_one') {
        const { status, body } = handleGetOne(route.debt_id, cfg);
        return jsonResponse(res, body, status);
      }

      // POST handlers need the body
      let raw;
      try {
        raw = await readJsonBody(req);
      } catch (err) {
        return errorResponse(res, err.message || 'bad request body', 400, 'invalid_request_body');
      }

      if (route.name === 'record') {
        const { status, body } = handleRecord(raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (route.name === 'pay') {
        const { status, body } = handlePay(raw, cfg);
        return jsonResponse(res, body, status);
      }
      if (route.name === 'forgive') {
        const { status, body } = handleForgive(raw, cfg);
        return jsonResponse(res, body, status);
      }

      return errorResponse(res, 'unreachable router state', 500, 'compression_debt_internal_error');
    } catch (err) {
      cfg.log(`[compression-debt] handler error on ${method} ${pathName}: ${err.message}`);
      return errorResponse(
        res,
        err.message || 'compression-debt internal error',
        500,
        'compression_debt_internal_error',
      );
    }
  });

  return {
    cfg,
    prefix: PATH_PREFIX,
    routes: [
      { method: 'GET', path: PATH_PREFIX },
      { method: 'GET', path: `${PATH_PREFIX}/summary` },
      { method: 'GET', path: `${PATH_PREFIX}/:debt_id` },
      { method: 'POST', path: `${PATH_PREFIX}/record` },
      { method: 'POST', path: `${PATH_PREFIX}/pay` },
      { method: 'POST', path: `${PATH_PREFIX}/forgive` },
    ],
  };
}

// Re-export handlers for direct wiring + unit tests
export const __compressionDebtHandlers = {
  handleList,
  handleSummary,
  handleGetOne,
  handleRecord,
  handlePay,
  handleForgive,
  matchRoute,
};
