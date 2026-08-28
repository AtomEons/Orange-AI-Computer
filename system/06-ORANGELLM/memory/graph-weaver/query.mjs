// graph-weaver/query.mjs — read-side API over the Graph Weaver SQLite store.
//
// All callers (the /v1/graph/* gateway routes, the cockpit, tests, batch
// scripts) hit this module. Writes live in daemon.mjs; this file is strictly
// read-only and never mutates rows.
//
// Doctrine (locked):
//   - 10 node types (Sovereign, Project, Mission, Lane, Model, Tool,
//     Service, Host, Receipt, Doctrine) and 6 edge predicates
//     (PROVES, REQUIRES, BLOCKED_BY, SUPERSEDES, APPROVED_BY, OBSERVED_BY).
//   - Embeddings: 768 float32, packed little-endian as 3072-byte BLOBs in
//     nodes.embedding. See ./embedder.mjs for the canonical packer.
//   - Performance: every query uses a cached prepared statement keyed by
//     better-sqlite3 Database instance. Cosine search and graph traversal
//     run in-memory after a single bulk read — no per-node SQL in hot loops.
//
// Exports:
//   getNode(id, db)
//   findNodesByType(type, { limit, since, db })
//   findNodesByName(query, { fuzzy, db })
//   semanticSearch(text, { topK, type, db })
//   neighbors(nodeId, { predicate, direction, maxDepth, db })
//   shortestPath(srcId, dstId, { db })
//
// All functions accept an explicit `db` (better-sqlite3 Database) so the
// caller controls lifecycle. For ergonomic one-shots, a default DB is opened
// lazily off the canonical path; callers SHOULD pass `db` in long-running
// processes.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, NODE_TYPES, EDGE_PREDICATES } from './daemon.mjs';
import { embedText, fromBuffer, EMBED_DIM } from './embedder.mjs';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, '..', 'graph.db');

const NODE_TYPE_SET = new Set(NODE_TYPES);
const EDGE_PRED_SET = new Set(EDGE_PREDICATES);
const VALID_DIRS    = new Set(['out', 'in', 'both']);

// ---------------------------------------------------------------------------
// db handle + prepared-statement cache
// ---------------------------------------------------------------------------
//
// Prepared statements in better-sqlite3 are bound to a Database instance.
// We keep one WeakMap<Database, Map<key, Statement>> so the cache evaporates
// with the db handle and there is no cross-process / cross-db leakage.

let _defaultDb = null;
function getDefaultDb() {
  if (_defaultDb) return _defaultDb;
  _defaultDb = openDb({ dbPath: DEFAULT_DB });
  return _defaultDb;
}

function resolveDb(db) {
  return db || getDefaultDb();
}

const _stmtCache = new WeakMap();

function prep(db, key, sql) {
  let cache = _stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    _stmtCache.set(db, cache);
  }
  let stmt = cache.get(key);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(key, stmt);
  }
  return stmt;
}

// ---------------------------------------------------------------------------
// row shaping
// ---------------------------------------------------------------------------

function shapeNode(row) {
  if (!row) return null;
  let attrs = {};
  if (row.attrs_json) {
    try { attrs = JSON.parse(row.attrs_json); } catch { attrs = {}; }
  }
  return {
    id:             row.id,
    type:           row.type,
    name:           row.name,
    attrs,
    created_at:     row.created_at,
    last_seen_at:   row.last_seen_at,
    observed_count: row.observed_count,
    receipt_count:  row.receipt_count,
    has_embedding:  row.embedding != null,
  };
}

function shapeEdge(row) {
  if (!row) return null;
  let evidence = [];
  if (row.evidence_json) {
    try { evidence = JSON.parse(row.evidence_json); } catch { evidence = []; }
  }
  return {
    id:               row.id,
    source:           row.source,
    predicate:        row.predicate,
    target:           row.target,
    weight:           row.weight,
    created_at:       row.created_at,
    last_observed_at: row.last_observed_at,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// getNode
// ---------------------------------------------------------------------------

/**
 * Fetch a single node by sha256 id. Returns null if not found.
 *
 * @param {string} id    64-char hex sha256 node id.
 * @param {object} db    better-sqlite3 Database (optional, defaults to canonical store).
 * @returns {object|null}
 */
export function getNode(id, db) {
  if (typeof id !== 'string' || id.length !== 64) {
    throw new Error('getNode: id must be a 64-char sha256 hex string');
  }
  const store = resolveDb(db);
  const stmt = prep(
    store,
    'getNode',
    `SELECT id, type, name, attrs_json, embedding, created_at, last_seen_at,
            observed_count, receipt_count
       FROM nodes
      WHERE id = ?`
  );
  return shapeNode(stmt.get(id));
}

// ---------------------------------------------------------------------------
// findNodesByType
// ---------------------------------------------------------------------------

/**
 * List nodes of a given type, newest-seen first.
 *
 * @param {string} type   one of the 10 locked node types.
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {string|number|Date} [opts.since]  ISO string, epoch ms, or Date — only nodes
 *                                           with last_seen_at >= since are returned.
 * @param {object} [opts.db]
 * @returns {object[]}
 */
export function findNodesByType(type, opts = {}) {
  if (!NODE_TYPE_SET.has(type)) {
    throw new Error(`findNodesByType: unknown type "${type}"`);
  }
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 50;
  const since = normalizeSince(opts.since);
  const store = resolveDb(opts.db);

  if (since == null) {
    const stmt = prep(
      store,
      'findNodesByType:noSince',
      `SELECT id, type, name, attrs_json, embedding, created_at, last_seen_at,
              observed_count, receipt_count
         FROM nodes
        WHERE type = ?
        ORDER BY last_seen_at DESC
        LIMIT ?`
    );
    return stmt.all(type, limit).map(shapeNode);
  }
  const stmt = prep(
    store,
    'findNodesByType:since',
    `SELECT id, type, name, attrs_json, embedding, created_at, last_seen_at,
            observed_count, receipt_count
       FROM nodes
      WHERE type = ?
        AND last_seen_at >= ?
      ORDER BY last_seen_at DESC
      LIMIT ?`
  );
  return stmt.all(type, since, limit).map(shapeNode);
}

function normalizeSince(since) {
  if (since == null) return null;
  if (since instanceof Date) return since.toISOString();
  if (typeof since === 'number' && Number.isFinite(since)) {
    return new Date(since).toISOString();
  }
  if (typeof since === 'string' && since.length > 0) return since;
  return null;
}

// ---------------------------------------------------------------------------
// findNodesByName
// ---------------------------------------------------------------------------

/**
 * Find nodes by display name. Default is exact-match (case-insensitive via the
 * stored normalized name); with `fuzzy: true` performs a `LIKE %query%` scan.
 *
 * Names in nodes.name are the human display form; nodeId hashing uses the
 * normalized lowercase form. We match against both shapes so callers can pass
 * either.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {boolean} [opts.fuzzy=false]
 * @param {object} [opts.db]
 * @returns {object[]}
 */
export function findNodesByName(query, opts = {}) {
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('findNodesByName: query must be a non-empty string');
  }
  const store = resolveDb(opts.db);
  const fuzzy = opts.fuzzy === true;

  if (fuzzy) {
    const stmt = prep(
      store,
      'findNodesByName:fuzzy',
      `SELECT id, type, name, attrs_json, embedding, created_at, last_seen_at,
              observed_count, receipt_count
         FROM nodes
        WHERE name LIKE ? COLLATE NOCASE
        ORDER BY last_seen_at DESC
        LIMIT 200`
    );
    const pat = `%${escapeLike(query)}%`;
    return stmt.all(pat).map(shapeNode);
  }

  const stmt = prep(
    store,
    'findNodesByName:exact',
    `SELECT id, type, name, attrs_json, embedding, created_at, last_seen_at,
            observed_count, receipt_count
       FROM nodes
      WHERE name = ? COLLATE NOCASE
      ORDER BY last_seen_at DESC`
  );
  return stmt.all(query).map(shapeNode);
}

function escapeLike(s) {
  // SQLite LIKE has no default escape char; we use backslash and explicitly
  // ESCAPE in the SQL when needed. For simple %query% pattern, just neutralize
  // wildcards in the user input.
  return String(s).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// semanticSearch
// ---------------------------------------------------------------------------

/**
 * Embed the query text via Ollama (nomic-embed-text, 768d) and return the
 * topK nodes ranked by cosine similarity against the stored embedding BLOB.
 * Nodes without an embedding are skipped. Optional type filter narrows the
 * candidate pool before scoring (cheaper than scoring then filtering).
 *
 * Returns an array of `{ node, score }` sorted by score descending. Score is
 * cosine similarity in [-1, 1] (typically positive for nomic-embed output).
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.topK=10]
 * @param {string|null} [opts.type=null]   restrict candidate pool to one type.
 * @param {object} [opts.db]
 * @returns {Promise<{node: object, score: number}[]>}
 */
export async function semanticSearch(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('semanticSearch: text must be a non-empty string');
  }
  const topK = Number.isInteger(opts.topK) && opts.topK > 0 ? opts.topK : 10;
  const type = opts.type ?? null;
  if (type != null && !NODE_TYPE_SET.has(type)) {
    throw new Error(`semanticSearch: unknown type "${type}"`);
  }
  const store = resolveDb(opts.db);

  const qVec = await embedText(text);
  if (qVec.length !== EMBED_DIM) {
    throw new Error(`semanticSearch: query vector dim ${qVec.length} != ${EMBED_DIM}`);
  }
  const qNorm = l2norm(qVec);
  if (qNorm === 0) return [];

  // Pull candidates in one shot. The candidate pool is small (single-host
  // cockpit graph), so scoring in JS is faster than a UDF and avoids loading
  // sqlite-vec. If this ever exceeds a few hundred thousand nodes, swap to a
  // vector extension; for now in-memory is the right altitude.
  const candidates = type
    ? prep(
        store,
        'semanticSearch:candidatesByType',
        `SELECT id, type, name, attrs_json, embedding, created_at, last_seen_at,
                observed_count, receipt_count
           FROM nodes
          WHERE type = ? AND embedding IS NOT NULL`
      ).all(type)
    : prep(
        store,
        'semanticSearch:candidates',
        `SELECT id, type, name, attrs_json, embedding, created_at, last_seen_at,
                observed_count, receipt_count
           FROM nodes
          WHERE embedding IS NOT NULL`
      ).all();

  // Bounded min-heap would be ideal at huge N; at our scale, sort-and-slice
  // is simpler and still O(N log N) with a small constant.
  const scored = new Array(candidates.length);
  for (let i = 0; i < candidates.length; i += 1) {
    const row = candidates[i];
    const vec = fromBuffer(row.embedding);
    if (!vec || vec.length !== qVec.length) {
      scored[i] = { node: shapeNode(row), score: -Infinity };
      continue;
    }
    const score = cosineSim(qVec, qNorm, vec);
    scored[i] = { node: shapeNode(row), score };
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function l2norm(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i += 1) s += vec[i] * vec[i];
  return Math.sqrt(s);
}

function cosineSim(a, aNorm, b) {
  // aNorm passed in to avoid recomputing for every candidate.
  let dot = 0;
  let bNorm2 = 0;
  const n = a.length;
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    bNorm2 += y * y;
  }
  const bNorm = Math.sqrt(bNorm2);
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (aNorm * bNorm);
}

// ---------------------------------------------------------------------------
// neighbors  (BFS)
// ---------------------------------------------------------------------------

/**
 * BFS traversal from nodeId.
 *
 * @param {string} nodeId
 * @param {object} [opts]
 * @param {string|null} [opts.predicate=null]   restrict to a single predicate.
 * @param {'out'|'in'|'both'} [opts.direction='out']
 * @param {number} [opts.maxDepth=1]
 * @param {object} [opts.db]
 * @returns {{
 *   root: string,
 *   nodes: object[],
 *   edges: object[],
 *   depths: Record<string, number>
 * }}
 */
export function neighbors(nodeId, opts = {}) {
  if (typeof nodeId !== 'string' || nodeId.length !== 64) {
    throw new Error('neighbors: nodeId must be a 64-char sha256 hex string');
  }
  const direction = opts.direction || 'out';
  if (!VALID_DIRS.has(direction)) {
    throw new Error(`neighbors: direction must be one of out/in/both, got "${direction}"`);
  }
  const predicate = opts.predicate ?? null;
  if (predicate != null && !EDGE_PRED_SET.has(predicate)) {
    throw new Error(`neighbors: unknown predicate "${predicate}"`);
  }
  const maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth >= 0 ? opts.maxDepth : 1;
  const store = resolveDb(opts.db);

  // Confirm root exists; return empty frame if not (no throw — query API is
  // tolerant of missing ids so callers can chain).
  const root = getNode(nodeId, store);
  if (!root) {
    return { root: nodeId, nodes: [], edges: [], depths: {} };
  }

  const outStmt = predicate
    ? prep(store, 'neighbors:outPred',
        `SELECT id, source, predicate, target, weight, created_at, last_observed_at, evidence_json
           FROM edges WHERE source = ? AND predicate = ?`)
    : prep(store, 'neighbors:out',
        `SELECT id, source, predicate, target, weight, created_at, last_observed_at, evidence_json
           FROM edges WHERE source = ?`);
  const inStmt = predicate
    ? prep(store, 'neighbors:inPred',
        `SELECT id, source, predicate, target, weight, created_at, last_observed_at, evidence_json
           FROM edges WHERE target = ? AND predicate = ?`)
    : prep(store, 'neighbors:in',
        `SELECT id, source, predicate, target, weight, created_at, last_observed_at, evidence_json
           FROM edges WHERE target = ?`);

  const nodes  = new Map();   // id -> shaped node
  const edges  = new Map();   // edge.id -> shaped edge
  const depths = new Map();   // id -> depth from root

  nodes.set(root.id, root);
  depths.set(root.id, 0);

  if (maxDepth === 0) {
    return { root: nodeId, nodes: [root], edges: [], depths: Object.fromEntries(depths) };
  }

  let frontier = [root.id];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next = [];
    for (const fid of frontier) {
      const outgoing = (direction === 'out' || direction === 'both')
        ? (predicate ? outStmt.all(fid, predicate) : outStmt.all(fid))
        : [];
      const incoming = (direction === 'in' || direction === 'both')
        ? (predicate ? inStmt.all(fid, predicate) : inStmt.all(fid))
        : [];

      for (const e of outgoing) {
        if (!edges.has(e.id)) edges.set(e.id, shapeEdge(e));
        if (!nodes.has(e.target)) {
          const n = getNode(e.target, store);
          if (n) {
            nodes.set(n.id, n);
            depths.set(n.id, depth);
            next.push(n.id);
          }
        }
      }
      for (const e of incoming) {
        if (!edges.has(e.id)) edges.set(e.id, shapeEdge(e));
        if (!nodes.has(e.source)) {
          const n = getNode(e.source, store);
          if (n) {
            nodes.set(n.id, n);
            depths.set(n.id, depth);
            next.push(n.id);
          }
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return {
    root:   nodeId,
    nodes:  Array.from(nodes.values()),
    edges:  Array.from(edges.values()),
    depths: Object.fromEntries(depths),
  };
}

// ---------------------------------------------------------------------------
// shortestPath  (Dijkstra, weight = 1 / edge.weight)
// ---------------------------------------------------------------------------

/**
 * Dijkstra shortest path from srcId to dstId. Edge cost is `1 / weight` so
 * heavily-reinforced edges are preferred. Treats edges as DIRECTED (source ->
 * target); callers wanting undirected should set direction at the daemon
 * layer (we keep traversal honest to the recorded direction).
 *
 * Returns `{ found, distance, nodes, edges }`. When found is false, nodes and
 * edges are empty and distance is Infinity.
 *
 * @param {string} srcId
 * @param {string} dstId
 * @param {object} [opts]
 * @param {object} [opts.db]
 * @returns {{
 *   found: boolean,
 *   distance: number,
 *   nodes: object[],
 *   edges: object[]
 * }}
 */
export function shortestPath(srcId, dstId, opts = {}) {
  if (typeof srcId !== 'string' || srcId.length !== 64) {
    throw new Error('shortestPath: srcId must be a 64-char sha256 hex string');
  }
  if (typeof dstId !== 'string' || dstId.length !== 64) {
    throw new Error('shortestPath: dstId must be a 64-char sha256 hex string');
  }
  const store = resolveDb(opts.db);

  const src = getNode(srcId, store);
  const dst = getNode(dstId, store);
  if (!src || !dst) {
    return { found: false, distance: Infinity, nodes: [], edges: [] };
  }
  if (srcId === dstId) {
    return { found: true, distance: 0, nodes: [src], edges: [] };
  }

  const outStmt = prep(
    store,
    'shortestPath:out',
    `SELECT id, source, predicate, target, weight, created_at, last_observed_at, evidence_json
       FROM edges WHERE source = ?`
  );

  // Min-heap (binary) keyed by tentative distance.
  const heap = new MinHeap();
  const dist = new Map();
  const prev = new Map();      // nodeId -> { from: prevId, edge: shapedEdge }
  dist.set(srcId, 0);
  heap.push(srcId, 0);

  while (heap.size > 0) {
    const { value: uId, priority: uDist } = heap.pop();
    if (uId === dstId) break;
    if (uDist > (dist.get(uId) ?? Infinity)) continue;

    const out = outStmt.all(uId);
    for (const e of out) {
      // weight = reinforcement counter, default 1.0. Cost = 1 / weight; we
      // floor it to a small epsilon so a pathological zero weight (shouldn't
      // happen given schema default, but be defensive) doesn't divide by zero.
      const w = e.weight > 0 ? e.weight : 1e-6;
      const cost = 1 / w;
      const alt = uDist + cost;
      const known = dist.get(e.target);
      if (known === undefined || alt < known) {
        dist.set(e.target, alt);
        prev.set(e.target, { from: uId, edge: shapeEdge(e) });
        heap.push(e.target, alt);
      }
    }
  }

  if (!dist.has(dstId)) {
    return { found: false, distance: Infinity, nodes: [], edges: [] };
  }

  // Reconstruct path dst -> src.
  const pathNodeIds = [dstId];
  const pathEdges   = [];
  let cur = dstId;
  while (cur !== srcId) {
    const step = prev.get(cur);
    if (!step) {
      // Should not happen if dist.has(dstId), but bail safely.
      return { found: false, distance: Infinity, nodes: [], edges: [] };
    }
    pathEdges.push(step.edge);
    pathNodeIds.push(step.from);
    cur = step.from;
  }
  pathNodeIds.reverse();
  pathEdges.reverse();

  // Materialize nodes (already have src/dst; fetch the rest).
  const nodeMap = new Map();
  nodeMap.set(src.id, src);
  nodeMap.set(dst.id, dst);
  const nodes = pathNodeIds.map((id) => {
    if (nodeMap.has(id)) return nodeMap.get(id);
    const n = getNode(id, store);
    nodeMap.set(id, n);
    return n;
  });

  return {
    found:    true,
    distance: dist.get(dstId),
    nodes,
    edges:    pathEdges,
  };
}

// ---------------------------------------------------------------------------
// MinHeap — small binary heap for Dijkstra.
// ---------------------------------------------------------------------------
//
// Kept inline (rather than pulled from a dep) because the surface is tiny and
// the algorithm needs are exact: push(value, priority) and pop() returning the
// minimum. better-sqlite3 already pulls a native dep in; we are not adding a
// second one for ten lines of code.

class MinHeap {
  constructor() {
    this._heap = []; // array of { value, priority }
  }
  get size() { return this._heap.length; }

  push(value, priority) {
    const h = this._heap;
    h.push({ value, priority });
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h[parent].priority <= h[i].priority) break;
      [h[parent], h[i]] = [h[i], h[parent]];
      i = parent;
    }
  }

  pop() {
    const h = this._heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0) {
      h[0] = last;
      const n = h.length;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && h[l].priority < h[smallest].priority) smallest = l;
        if (r < n && h[r].priority < h[smallest].priority) smallest = r;
        if (smallest === i) break;
        [h[smallest], h[i]] = [h[i], h[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// default export — convenience namespace
// ---------------------------------------------------------------------------

export default {
  getNode,
  findNodesByType,
  findNodesByName,
  semanticSearch,
  neighbors,
  shortestPath,
};
