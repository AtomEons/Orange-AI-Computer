// graph.mjs — Graph Weaver gateway routes (/v1/graph/*)
//
// Frontier-Isolation law:
//   These routes are the ONLY legal public surface for the Graph Weaver
//   knowledge graph at 06-ORANGELLM/memory/graph.db. Direct DB access from
//   anywhere outside this process is forbidden.
//
// Ontology (LOCKED):
//   Nodes:  Sovereign, Project, Mission, Lane, Model, Tool, Service, Host,
//           Receipt, Doctrine
//   Edges:  PROVES, REQUIRES, BLOCKED_BY, SUPERSEDES, APPROVED_BY, OBSERVED_BY
//
// Routes:
//   GET  /v1/graph/node/:id
//   GET  /v1/graph/nodes?type=&name=&fuzzy=&limit=
//   POST /v1/graph/search                    body {text, top_k, type}
//   GET  /v1/graph/neighbors/:id?predicate=&direction=&depth=
//   GET  /v1/graph/path?src=&dst=
//   GET  /v1/graph/ontology-candidates
//   POST /v1/graph/promote-ontology          body {type_name}, operator-only
//
// Integration:
//   Call registerGraphRoutes(server, { db, operatorToken }) once during boot.
//   `server` is expected to expose a `.route(method, path, handler)` API or
//   accept being driven by `dispatch(req, res, url)` directly. For the
//   existing 06-ORANGELLM node:http server we additionally export
//   `dispatchGraph(req, res, url, ctx)` so the index.mjs router can mount us
//   with a path-prefix match.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  nodeId,
  NODE_TYPES,
  EDGE_PREDICATES,
} from '../../memory/graph-weaver/daemon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.resolve(__dirname, '..', '..', 'memory', 'graph.db');

const ID_RE = /^[0-9a-f]{64}$/i;
const NODE_TYPE_SET = new Set(NODE_TYPES);
const EDGE_PRED_SET = new Set(EDGE_PREDICATES);
const DIRECTIONS = new Set(['out', 'in', 'both']);

const MAX_LIMIT     = 500;
const DEFAULT_LIMIT = 50;
const MAX_DEPTH     = 4;
const MAX_TOPK      = 100;
const DEFAULT_TOPK  = 10;
const MAX_PATH_NODES = 5000;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function err(status, code, message, extra) {
  return { _ae_http_status: status, error: { code, message, ...(extra || {}) } };
}

function ok(body, status = 200) {
  return { _ae_http_status: status, ...body };
}

function clampInt(v, lo, hi, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function unpackEmbedding(blob) {
  if (!blob) return null;
  if (!Buffer.isBuffer(blob) && !ArrayBuffer.isView(blob)) return null;
  if (blob.byteLength !== 3072) return null;
  // Bun SQLite returns Uint8Array while Node adapters commonly return Buffer.
  // Copy the exact byte window so unaligned pool offsets cannot break Float32.
  const bytes = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  return new Float32Array(bytes.slice().buffer);
}

function serializeNode(row, { withEmbedding = false } = {}) {
  if (!row) return null;
  let attrs = {};
  try { attrs = JSON.parse(row.attrs_json || '{}'); } catch { /* keep {} */ }
  const out = {
    id: row.id,
    type: row.type,
    name: row.name,
    attrs,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    observed_count: row.observed_count,
    receipt_count: row.receipt_count,
    has_embedding: !!row.embedding,
  };
  if (withEmbedding) {
    const vec = unpackEmbedding(row.embedding);
    out.embedding = vec ? Array.from(vec) : null;
  }
  return out;
}

function serializeEdge(row) {
  if (!row) return null;
  let evidence = [];
  try { evidence = JSON.parse(row.evidence_json || '[]'); } catch { /* keep [] */ }
  return {
    id: row.id,
    source: row.source,
    predicate: row.predicate,
    target: row.target,
    weight: row.weight,
    created_at: row.created_at,
    last_observed_at: row.last_observed_at,
    evidence,
  };
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return -Infinity;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na  += x * x;
    nb  += y * y;
  }
  if (na === 0 || nb === 0) return -Infinity;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// resolveNodeId — accept either a 64-hex id OR a "Type:name" pair.
function resolveNodeId(db, raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (ID_RE.test(raw)) {
    const row = db.prepare(`SELECT id FROM nodes WHERE id = ?`).get(raw);
    return row ? row.id : null;
  }
  // Allow "Type:name" lookup for path/search ergonomics.
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const type = raw.slice(0, idx);
  const name = raw.slice(idx + 1);
  if (!NODE_TYPE_SET.has(type) || !name.trim()) return null;
  const candidateId = nodeId(type, name);
  const row = db.prepare(`SELECT id FROM nodes WHERE id = ?`).get(candidateId);
  return row ? row.id : null;
}

// Operator-token gate.
function requireOperator(req, ctx) {
  const expected = ctx.operatorToken || process.env.ORANGE5_OPERATOR_TOKEN || '';
  if (!expected) {
    return err(503, 'operator_token_not_configured',
      'X-Operator-Token gate active but no token configured on the server.');
  }
  const got = (req.headers['x-operator-token'] || req.headers['X-Operator-Token'] || '').toString();
  if (!got) return err(401, 'operator_token_required', 'Missing X-Operator-Token header.');
  // Constant-time-ish compare (lengths first; SQLite-driver process, not crypto-graded).
  if (got.length !== expected.length) return err(403, 'operator_token_invalid', 'X-Operator-Token rejected.');
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return err(403, 'operator_token_invalid', 'X-Operator-Token rejected.');
  return null;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

export function handleGetNode(db, id) {
  if (!ID_RE.test(id)) return err(400, 'bad_id', 'node id must be 64 hex chars (sha256).');
  const row = db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id);
  if (!row) return err(404, 'not_found', `node ${id} not found`);
  return ok({ node: serializeNode(row) });
}

export function handleListNodes(db, query) {
  const type  = query.get('type')  || null;
  const name  = query.get('name')  || null;
  const fuzzy = query.get('fuzzy') === '1' || query.get('fuzzy') === 'true';
  const limit = clampInt(query.get('limit'), 1, MAX_LIMIT, DEFAULT_LIMIT);

  if (type && !NODE_TYPE_SET.has(type)) {
    return err(400, 'bad_type', `unknown type '${type}'`,
      { allowed: NODE_TYPES });
  }

  const where = [];
  const args  = [];
  if (type) { where.push('type = ?'); args.push(type); }
  if (name) {
    if (fuzzy) { where.push('name LIKE ?'); args.push(`%${name.toLowerCase()}%`); }
    else       { where.push('name = ?');    args.push(name.toLowerCase()); }
  }
  const sql = `
    SELECT * FROM nodes
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY last_seen_at DESC
    LIMIT ?
  `;
  args.push(limit);
  const rows = db.prepare(sql).all(...args);
  return ok({ count: rows.length, limit, nodes: rows.map((r) => serializeNode(r)) });
}

export async function handleSearch(db, body, ctx) {
  if (!body || typeof body !== 'object') return err(400, 'bad_body', 'JSON body required');
  const text  = typeof body.text === 'string' ? body.text.trim() : '';
  const type  = typeof body.type === 'string' ? body.type : null;
  const topK  = clampInt(body.top_k, 1, MAX_TOPK, DEFAULT_TOPK);

  if (!text) return err(400, 'bad_text', 'body.text required');
  if (type && !NODE_TYPE_SET.has(type)) {
    return err(400, 'bad_type', `unknown type '${type}'`, { allowed: NODE_TYPES });
  }

  // Embed query via injected embedder; fall back to lexical LIKE on the name
  // column when no embedder is configured (tests, or Ollama down — we never
  // silently invent vectors).
  let queryVec = null;
  if (typeof ctx.embedder === 'function') {
    try {
      const v = await ctx.embedder(text);
      if (v && v.length === 768) queryVec = v instanceof Float32Array ? v : Float32Array.from(v);
    } catch (e) {
      // Embedder failed — surface in the response so callers don't trust a
      // silent lexical fallback as if it were semantic.
      ctx.lastEmbedderError = e.message;
    }
  }

  if (!queryVec) {
    const args = [];
    let where = `embedding IS NULL OR 1=1`; // dummy
    where = `1=1`;
    if (type) { where += ' AND type = ?'; args.push(type); }
    where += ' AND name LIKE ?'; args.push(`%${text.toLowerCase()}%`);
    const rows = db.prepare(`
      SELECT * FROM nodes WHERE ${where}
      ORDER BY last_seen_at DESC LIMIT ?
    `).all(...args, topK);
    return ok({
      mode: 'lexical_fallback',
      reason: ctx.lastEmbedderError ? `embedder_error: ${ctx.lastEmbedderError}` : 'no embedder configured',
      count: rows.length,
      top_k: topK,
      results: rows.map((r) => ({ ...serializeNode(r), score: null })),
    });
  }

  // Brute-force cosine over the nodes table. Acceptable at Night-1 scale
  // (tens of thousands of nodes); a vector index is a Phase-3 concern.
  const args = [];
  let where = `embedding IS NOT NULL`;
  if (type) { where += ' AND type = ?'; args.push(type); }
  const rows = db.prepare(`SELECT * FROM nodes WHERE ${where}`).all(...args);
  const scored = [];
  for (const row of rows) {
    const vec = unpackEmbedding(row.embedding);
    if (!vec) continue;
    const score = cosineSim(queryVec, vec);
    if (!Number.isFinite(score)) continue;
    scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = scored.slice(0, topK).map(({ row, score }) => ({
    ...serializeNode(row),
    score,
  }));
  return ok({
    mode: 'semantic',
    count: out.length,
    top_k: topK,
    results: out,
  });
}

export function handleNeighbors(db, id, query) {
  if (!ID_RE.test(id)) return err(400, 'bad_id', 'node id must be 64 hex chars (sha256).');
  const root = db.prepare(`SELECT id FROM nodes WHERE id = ?`).get(id);
  if (!root) return err(404, 'not_found', `node ${id} not found`);

  const predicate = query.get('predicate') || null;
  const direction = query.get('direction') || 'both';
  const depth     = clampInt(query.get('depth'), 1, MAX_DEPTH, 1);

  if (predicate && !EDGE_PRED_SET.has(predicate)) {
    return err(400, 'bad_predicate', `unknown predicate '${predicate}'`,
      { allowed: EDGE_PREDICATES });
  }
  if (!DIRECTIONS.has(direction)) {
    return err(400, 'bad_direction', `direction must be one of out|in|both`);
  }

  const predClause = predicate ? ' AND predicate = ?' : '';
  const outStmt = db.prepare(`SELECT * FROM edges WHERE source = ?${predClause}`);
  const inStmt  = db.prepare(`SELECT * FROM edges WHERE target = ?${predClause}`);
  const nodeStmt = db.prepare(`SELECT * FROM nodes WHERE id = ?`);

  const visited = new Set([id]);
  const nodesOut = new Map();
  const edgesOut = [];
  let frontier = [id];

  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const fid of frontier) {
      const edges = [];
      if (direction === 'out' || direction === 'both') {
        const rows = predicate ? outStmt.all(fid, predicate) : outStmt.all(fid);
        edges.push(...rows.map((r) => ({ row: r, side: 'out' })));
      }
      if (direction === 'in' || direction === 'both') {
        const rows = predicate ? inStmt.all(fid, predicate) : inStmt.all(fid);
        edges.push(...rows.map((r) => ({ row: r, side: 'in' })));
      }
      for (const { row, side } of edges) {
        edgesOut.push(serializeEdge(row));
        const otherId = side === 'out' ? row.target : row.source;
        if (!visited.has(otherId)) {
          visited.add(otherId);
          next.push(otherId);
          const n = nodeStmt.get(otherId);
          if (n) nodesOut.set(otherId, serializeNode(n));
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  return ok({
    root: serializeNode(nodeStmt.get(id)),
    depth,
    direction,
    predicate,
    nodes: Array.from(nodesOut.values()),
    edges: edgesOut,
  });
}

export function handlePath(db, query) {
  const srcRaw = query.get('src');
  const dstRaw = query.get('dst');
  if (!srcRaw || !dstRaw) return err(400, 'bad_args', 'src and dst required');
  const src = resolveNodeId(db, srcRaw);
  const dst = resolveNodeId(db, dstRaw);
  if (!src) return err(404, 'src_not_found', `src '${srcRaw}' not found`);
  if (!dst) return err(404, 'dst_not_found', `dst '${dstRaw}' not found`);

  if (src === dst) {
    const n = db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(src);
    return ok({ found: true, length: 0, path: [serializeNode(n)], edges: [] });
  }

  // BFS over undirected edge view (the graph is directed but a path query is
  // about reachability, which respects either direction).
  const edgesAdj = db.prepare(`SELECT source, target, predicate, id FROM edges`).all();
  const adj = new Map();
  for (const e of edgesAdj) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push({ to: e.target, edgeId: e.id, predicate: e.predicate, dir: 'out' });
    adj.get(e.target).push({ to: e.source, edgeId: e.id, predicate: e.predicate, dir: 'in' });
  }

  const prev = new Map(); // node -> {from, edgeId, predicate, dir}
  const q = [src];
  prev.set(src, null);
  let found = false;
  let visited = 0;
  while (q.length) {
    visited += 1;
    if (visited > MAX_PATH_NODES) break;
    const cur = q.shift();
    if (cur === dst) { found = true; break; }
    const nbrs = adj.get(cur) || [];
    for (const n of nbrs) {
      if (prev.has(n.to)) continue;
      prev.set(n.to, { from: cur, edgeId: n.edgeId, predicate: n.predicate, dir: n.dir });
      q.push(n.to);
    }
  }
  if (!found) return ok({ found: false, length: 0, path: [], edges: [] });

  // Reconstruct.
  const idChain = [];
  let cur = dst;
  while (cur !== null && cur !== undefined) {
    idChain.unshift(cur);
    const step = prev.get(cur);
    if (!step) break;
    cur = step.from;
  }
  const nodeStmt = db.prepare(`SELECT * FROM nodes WHERE id = ?`);
  const edgeStmt = db.prepare(`SELECT * FROM edges WHERE id = ?`);
  const pathNodes = idChain.map((nid) => serializeNode(nodeStmt.get(nid)));
  const pathEdges = [];
  for (let i = 1; i < idChain.length; i++) {
    const step = prev.get(idChain[i]);
    if (!step) continue;
    pathEdges.push({
      ...serializeEdge(edgeStmt.get(step.edgeId)),
      traversed_direction: step.dir,
    });
  }
  return ok({
    found: true,
    length: pathNodes.length - 1,
    path: pathNodes,
    edges: pathEdges,
  });
}

export function handleOntologyCandidates(db, query) {
  const promotedQ = query.get('promoted');
  const limit = clampInt(query.get('limit'), 1, MAX_LIMIT, DEFAULT_LIMIT);
  let where = '';
  const args = [];
  if (promotedQ === '1' || promotedQ === 'true') { where = 'WHERE promoted = 1'; }
  else if (promotedQ === '0' || promotedQ === 'false') { where = 'WHERE promoted = 0'; }
  const rows = db.prepare(`
    SELECT proposed_type, occurrence_count, first_seen_at, last_seen_at,
           referencing_receipts_json, promoted, promoted_at, promoted_by
      FROM ontology_candidates
    ${where}
    ORDER BY occurrence_count DESC, last_seen_at DESC
    LIMIT ?
  `).all(...args, limit);
  const candidates = rows.map((r) => {
    let refs = [];
    try { refs = JSON.parse(r.referencing_receipts_json || '[]'); } catch { /* keep [] */ }
    return {
      proposed_type:      r.proposed_type,
      occurrence_count:   r.occurrence_count,
      first_seen_at:      r.first_seen_at,
      last_seen_at:       r.last_seen_at,
      referencing_receipts: refs,
      receipt_count:      refs.length,
      promoted:           r.promoted === 1,
      promoted_at:        r.promoted_at,
      promoted_by:        r.promoted_by,
    };
  });
  return ok({
    locked_ontology: { nodes: NODE_TYPES, edges: EDGE_PREDICATES },
    promotion_rule:  'occurrence_count >= 5 AND receipt_count >= 5, OR operator promote-ontology',
    count: candidates.length,
    limit,
    candidates,
  });
}

export function handlePromoteOntology(db, body, req, ctx) {
  const gate = requireOperator(req, ctx);
  if (gate) return gate;
  if (!body || typeof body !== 'object') return err(400, 'bad_body', 'JSON body required');
  const typeName = typeof body.type_name === 'string' ? body.type_name.trim() : '';
  if (!typeName) return err(400, 'bad_type_name', 'body.type_name required');

  const row = db.prepare(`
    SELECT proposed_type, occurrence_count, referencing_receipts_json, promoted
      FROM ontology_candidates WHERE proposed_type = ?
  `).get(typeName);
  if (!row) return err(404, 'candidate_not_found', `no ontology candidate named '${typeName}'`);
  if (row.promoted === 1) {
    return ok({
      promoted: true,
      already_promoted: true,
      proposed_type: typeName,
      note: 'Already journaled as promoted. Live ontology extension still requires a code change.',
    });
  }
  const promotedBy = (req.headers['x-operator-id'] || 'operator').toString();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE ontology_candidates
       SET promoted = 1, promoted_at = ?, promoted_by = ?
     WHERE proposed_type = ?
  `).run(now, promotedBy, typeName);

  return ok({
    promoted: true,
    proposed_type: typeName,
    promoted_at: now,
    promoted_by: promotedBy,
    note: [
      'Journal entry created. The 10-node ontology in code is still LOCKED.',
      'Extending the live ontology requires editing NODE_TYPES / EDGE_PREDICATES',
      'in 06-ORANGELLM/memory/graph-weaver/daemon.mjs and re-deploying.',
    ].join(' '),
  });
}

// ---------------------------------------------------------------------------
// dispatcher — used by the existing node:http server, and by tests
// ---------------------------------------------------------------------------

export async function dispatchGraph(req, urlOrPath, query, body, ctx) {
  const method = req.method.toUpperCase();
  // Accept either a URL object or a raw pathname string.
  const pathname = typeof urlOrPath === 'string' ? urlOrPath : urlOrPath.pathname;
  const q = query || new URLSearchParams();

  // GET /v1/graph/node/:id
  let m;
  if (method === 'GET' && (m = pathname.match(/^\/v1\/graph\/node\/([^/]+)$/))) {
    return handleGetNode(ctx.db, m[1]);
  }
  // GET /v1/graph/nodes
  if (method === 'GET' && pathname === '/v1/graph/nodes') {
    return handleListNodes(ctx.db, q);
  }
  // POST /v1/graph/search
  if (method === 'POST' && pathname === '/v1/graph/search') {
    return await handleSearch(ctx.db, body, ctx);
  }
  // GET /v1/graph/neighbors/:id
  if (method === 'GET' && (m = pathname.match(/^\/v1\/graph\/neighbors\/([^/]+)$/))) {
    return handleNeighbors(ctx.db, m[1], q);
  }
  // GET /v1/graph/path
  if (method === 'GET' && pathname === '/v1/graph/path') {
    return handlePath(ctx.db, q);
  }
  // GET /v1/graph/ontology-candidates
  if (method === 'GET' && pathname === '/v1/graph/ontology-candidates') {
    return handleOntologyCandidates(ctx.db, q);
  }
  // POST /v1/graph/promote-ontology
  if (method === 'POST' && pathname === '/v1/graph/promote-ontology') {
    return handlePromoteOntology(ctx.db, body, req, ctx);
  }
  return null; // not a graph route — caller should 404
}

export function isGraphPath(pathname) {
  return typeof pathname === 'string' && pathname.startsWith('/v1/graph/');
}

// ---------------------------------------------------------------------------
// registerGraphRoutes — primary export per task spec
// ---------------------------------------------------------------------------
//
// Two integration modes:
//
//   1. If `server` exposes a `.route(method, path, handler)` API (a framework
//      shim or test harness), we register each route explicitly.
//   2. Otherwise we attach a single dispatcher to `server._graphDispatch` and
//      it's the caller's responsibility to invoke `dispatchGraph` from their
//      node:http request handler. For the existing 06-ORANGELLM index.mjs
//      that mounts via `if (isGraphPath(url.pathname)) { ... }`.
//
// Options:
//   db            — already-open better-sqlite3 Database; otherwise we open
//                   06-ORANGELLM/memory/graph.db via openDb().
//   operatorToken — required for POST /v1/graph/promote-ontology. Falls back
//                   to env ORANGE5_OPERATOR_TOKEN.
//   embedder      — async function(text) -> Float32Array(768) | null.
//                   Used by /v1/graph/search. Optional; lexical fallback runs
//                   when omitted.

export function registerGraphRoutes(server, opts = {}) {
  const db = opts.db || openDb({ dbPath: opts.dbPath || DEFAULT_DB_PATH });
  const ctx = {
    db,
    operatorToken: opts.operatorToken || process.env.ORANGE5_OPERATOR_TOKEN || '',
    embedder: typeof opts.embedder === 'function' ? opts.embedder : null,
    lastEmbedderError: null,
  };

  // Framework mode.
  if (server && typeof server.route === 'function') {
    server.route('GET',  '/v1/graph/node/:id',              (req, res, params) =>
      respond(res, handleGetNode(ctx.db, params.id)));
    server.route('GET',  '/v1/graph/nodes',                 (req, res, _p, url) =>
      respond(res, handleListNodes(ctx.db, url.searchParams)));
    server.route('POST', '/v1/graph/search',                async (req, res, _p, _u, body) =>
      respond(res, await handleSearch(ctx.db, body, ctx)));
    server.route('GET',  '/v1/graph/neighbors/:id',         (req, res, params, url) =>
      respond(res, handleNeighbors(ctx.db, params.id, url.searchParams)));
    server.route('GET',  '/v1/graph/path',                  (req, res, _p, url) =>
      respond(res, handlePath(ctx.db, url.searchParams)));
    server.route('GET',  '/v1/graph/ontology-candidates',   (req, res, _p, url) =>
      respond(res, handleOntologyCandidates(ctx.db, url.searchParams)));
    server.route('POST', '/v1/graph/promote-ontology',      (req, res, _p, _u, body) =>
      respond(res, handlePromoteOntology(ctx.db, body, req, ctx)));
    return { db, ctx, mode: 'framework' };
  }

  // Plain node:http mode — attach dispatcher hook.
  if (server) {
    server._graphCtx = ctx;
    server._graphDispatch = (req, url, query, body) => dispatchGraph(req, url, query, body, ctx);
    server._graphIsPath = isGraphPath;
  }
  return { db, ctx, mode: 'dispatch' };
}

function respond(res, result) {
  if (!result) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'route not handled' } }));
    return;
  }
  const status = result._ae_http_status || 200;
  const body = { ...result };
  delete body._ae_http_status;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export default registerGraphRoutes;
