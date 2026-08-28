// AE OrangeLLM — Receipts gateway routes (/v1/receipts/*)
// Path: 06-ORANGELLM/server/routes/receipts.mjs
//
// Doctrine:
//   - Markdown receipts at 10-RECEIPTS/orange5-build/ are the operator audit lane.
//   - SQLite mirror at 06-CONTROL-PLANE/receipts/orange5.db is the machine query
//     lane (this module's read source).
//   - Every read verifies the hash-chain. A break refuses to serve.
//   - READ-ONLY. No writes through the gateway, ever.
//
// Routes:
//   GET /v1/receipts?since=&status=&actor=&has_blockers=&fake_green=&limit=
//   GET /v1/receipts/:id
//   GET /v1/receipts/chain-verify
//
// Integration (in server/index.mjs):
//   import { dispatchReceipts, isReceiptsPath } from './routes/receipts.mjs';
//   if (isReceiptsPath(url.pathname)) {
//     const result = await dispatchReceipts(req, url, ctx);
//     if (result) {
//       const status = result._ae_http_status || 200;
//       delete result._ae_http_status;
//       return jsonResponse(res, result, status);
//     }
//   }

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  reindex,
  queryReceipts,
  getReceiptById,
  chainVerifyReport,
  DEFAULT_DB_PATH,
  DEFAULT_RECEIPTS_DIR,
} from '../../../06-CONTROL-PLANE/receipts/query.mjs';

import {
  isReceiptsPath,
  isReceiptsRouteAllowed,
  RECEIPTS_ALLOWED,
} from './receipts-boundary.mjs';

export { isReceiptsPath, isReceiptsRouteAllowed, RECEIPTS_ALLOWED };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// HTTP shape helpers
// ---------------------------------------------------------------------------

function ok(body) { return body; }

function err(status, code, message, extra = {}) {
  return {
    error: { code, message, ...extra },
    _ae_http_status: status,
  };
}

function parseBool(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'y') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'n') return false;
  return null;
}

function parseFakeGreen(v) {
  // Accept: undefined (use defaults), "off"/"none"/"false" (disable),
  //         "default" (use defaults), or a comma-separated list.
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  const lower = s.toLowerCase();
  if (lower === 'off' || lower === 'none' || lower === 'false' || lower === '0') return [];
  if (lower === 'default' || lower === 'on' || lower === 'true' || lower === '1') return undefined;
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function parseStatus(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  // Allow comma-separated list as an OR filter.
  if (s.includes(',') && !s.startsWith('/')) {
    return s.split(',').map(x => x.trim()).filter(Boolean);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Shared DB context — open once, hold across requests.
// ---------------------------------------------------------------------------

let _ctx = null;

export function getReceiptsContext({ dbPath, receiptsDir } = {}) {
  if (_ctx && !dbPath && !receiptsDir) return _ctx;
  const finalDbPath = dbPath || DEFAULT_DB_PATH;
  const finalReceiptsDir = receiptsDir || DEFAULT_RECEIPTS_DIR;

  // First-touch: ensure index exists.
  let db;
  try {
    db = openDb({ dbPath: finalDbPath });
    const count = db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
    if (count === 0) {
      db.close();
      const r = reindex({ dbPath: finalDbPath, receiptsDir: finalReceiptsDir });
      db = r.db;
    }
  } catch (e) {
    if (db) try { db.close(); } catch {}
    throw e;
  }

  _ctx = { db, dbPath: finalDbPath, receiptsDir: finalReceiptsDir };
  return _ctx;
}

// Lifecycle hook for the server to call on shutdown.
export function closeReceiptsContext() {
  if (_ctx && _ctx.db) {
    try { _ctx.db.close(); } catch {}
  }
  _ctx = null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleList(ctx, query) {
  const since        = query.get('since') || null;
  const status       = parseStatus(query.get('status'));
  const actor        = query.get('actor') || null;
  const has_blockers = parseBool(query.get('has_blockers'));
  const fake_green   = parseFakeGreen(query.get('fake_green'));
  const limitRaw     = query.get('limit');
  const limit        = limitRaw ? Number(limitRaw) : 100;

  if (since) {
    const t = new Date(since);
    if (Number.isNaN(t.getTime())) {
      return err(400, 'invalid_since', `'since' is not a valid ISO timestamp: ${since}`);
    }
  }
  if (limitRaw && (!Number.isFinite(limit) || limit <= 0)) {
    return err(400, 'invalid_limit', `'limit' must be a positive integer`);
  }

  try {
    const result = queryReceipts({
      since,
      status,
      actor,
      has_blockers,
      fake_green_words: fake_green,
      limit,
      db: ctx.db,
    });
    return ok({
      object: 'receipts.list',
      ...result,
    });
  } catch (e) {
    if (e.code === 'RECEIPTS_CHAIN_BREAK') {
      return err(503, 'chain_break',
        'receipts hash-chain integrity broken; refusing to serve',
        { integrity: e.integrity });
    }
    throw e;
  }
}

export function handleById(ctx, id) {
  // Re-verify before serving a single row.
  const integrity = chainVerifyReport({ db: ctx.db });
  if (!integrity.ok) {
    return err(503, 'chain_break',
      'receipts hash-chain integrity broken; refusing to serve',
      { integrity });
  }
  const row = getReceiptById({ db: ctx.db, receipt_id: id });
  if (!row) return err(404, 'not_found', `receipt not found: ${id}`);
  return ok({
    object: 'receipt',
    receipt: row,
    chain_verified: true,
    integrity: {
      row_count: integrity.row_count,
      head_link: integrity.head_link,
      verified_at: integrity.verified_at,
    },
  });
}

export function handleChainVerify(ctx) {
  const report = chainVerifyReport({ db: ctx.db });
  return ok({
    object: 'receipts.chain_verify',
    ...report,
  });
}

// ---------------------------------------------------------------------------
// dispatchReceipts — router entry point
// ---------------------------------------------------------------------------

export async function dispatchReceipts(req, urlOrPath, ctxOverride = null) {
  const method = (req.method || 'GET').toUpperCase();
  const pathname = typeof urlOrPath === 'string' ? urlOrPath : urlOrPath.pathname;
  const search   = typeof urlOrPath === 'string' ? '' : (urlOrPath.search || '');
  const query    = new URLSearchParams(search);

  if (!isReceiptsRouteAllowed(method, pathname)) {
    return err(404, 'not_found', `receipts endpoint not exposed: ${method} ${pathname}`);
  }

  const ctx = ctxOverride || getReceiptsContext();

  if (method === 'GET' && pathname === '/v1/receipts') {
    return handleList(ctx, query);
  }
  if (method === 'GET' && pathname === '/v1/receipts/chain-verify') {
    return handleChainVerify(ctx);
  }
  const m = pathname.match(/^\/v1\/receipts\/([^/]+)$/);
  if (method === 'GET' && m && m[1] !== 'chain-verify') {
    return handleById(ctx, m[1]);
  }

  return err(404, 'not_found', `receipts endpoint not exposed: ${method} ${pathname}`);
}

// ---------------------------------------------------------------------------
// registerReceiptsRoutes — primary export, mirrors graph.mjs shape
// ---------------------------------------------------------------------------

export function registerReceiptsRoutes(server, opts = {}) {
  const ctx = getReceiptsContext(opts);

  // If the server has a `.route(method, path, handler)` API (test harness or
  // framework shim), register the static endpoints directly. The :id route is
  // installed as a prefix dispatcher because `.route` typically can't handle
  // dynamic segments.
  if (typeof server?.route === 'function') {
    for (const r of RECEIPTS_ALLOWED) {
      server.route(r.method, r.path, async (req, url) => {
        return await dispatchReceipts(req, url, ctx);
      });
    }
    if (typeof server.routePrefix === 'function') {
      server.routePrefix('GET', '/v1/receipts/', async (req, url) => {
        return await dispatchReceipts(req, url, ctx);
      });
    }
  }

  // For the existing 06-ORANGELLM index.mjs (node:http), expose the
  // dispatcher so index.mjs can call it conditionally.
  if (server && typeof server === 'object') {
    server._receiptsDispatch = (req, url) => dispatchReceipts(req, url, ctx);
    server._receiptsContext = ctx;
  }

  return ctx;
}

export default registerReceiptsRoutes;
