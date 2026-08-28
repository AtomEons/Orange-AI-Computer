// 11-MIRAGE/adapters/graph.mjs — READY (Night-1).
//
// Graph Weaver mount. Reads the 10-node / 6-edge LOCKED ontology directly from
// SQLite at 06-ORANGELLM/memory/graph.db (better-sqlite3, synchronous, WAL).
//
// Writes are deliberately gated: Graph Weaver is rebuilt from Flux observations
// by the dedicated `04-CONTROL-PLANE/workflows/graph-weaver-build.workflow.mjs`
// loop — Mirage will not mutate nodes/edges out-of-band. Direct write attempts
// return ok:false with reason='use_graph_weaver_build_workflow'.
//
// Spec: 11-MIRAGE/SPEC.md#graph
// Schema: 06-ORANGELLM/memory/graph-weaver/schema.sql

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.ORANGE5_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));

const SPEC = '11-MIRAGE/SPEC.md#graph';

const GRAPH_DB = process.env.GRAPH_WEAVER_DB
  || resolve(ROOT, '06-ORANGELLM', 'memory', 'graph.db');

const NODE_TYPES = new Set([
  'Sovereign', 'Project', 'Mission', 'Lane', 'Model',
  'Tool', 'Service', 'Host', 'Receipt', 'Doctrine',
]);
const EDGE_PREDS = new Set([
  'PROVES', 'REQUIRES', 'BLOCKED_BY', 'SUPERSEDES', 'APPROVED_BY', 'OBSERVED_BY',
]);

let _Database = null;
let _db = null;
let _openErr = null;

async function getDB() {
  if (_db) return _db;
  if (_openErr) return null;
  if (!existsSync(GRAPH_DB)) {
    _openErr = `graph.db not present at ${GRAPH_DB}`;
    return null;
  }
  if (!_Database) {
    try {
      const mod = await import('#sqlite');
      _Database = mod.default || mod;
    } catch (err) {
      _openErr = `better-sqlite3 not installed: ${String(err?.message || err)}`;
      return null;
    }
  }
  try {
    _db = new _Database(GRAPH_DB, { readonly: false, fileMustExist: true });
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    return _db;
  } catch (err) {
    _openErr = `open failed: ${String(err?.message || err)}`;
    return null;
  }
}

/**
 * read(params) — query the graph.
 *
 * params.op:
 *   'node_by_id'        { id }
 *   'nodes_by_type'     { type, limit?, since? }
 *   'nodes_by_name'     { name, type?, limit? }       (LIKE match, case-insensitive)
 *   'edges_from'        { source, predicate?, limit? }
 *   'edges_to'          { target, predicate?, limit? }
 *   'neighborhood'      { node_id, depth?=1, limit?=50 }
 *   'counts'            {}                            (node/edge totals by type/pred)
 */
async function read(params = {}) {
  const db = await getDB();
  if (!db) return { ok: false, reason: 'graph_db_unavailable', detail: _openErr, spec: SPEC };

  const op = params.op || 'counts';
  try {
    switch (op) {
      case 'node_by_id': {
        if (!params.id) return { ok: false, reason: 'id_required', spec: SPEC };
        const row = db.prepare('SELECT id,type,name,attrs_json,created_at,last_seen_at,observed_count,receipt_count FROM nodes WHERE id = ?').get(params.id);
        return { ok: true, data: row || null };
      }
      case 'nodes_by_type': {
        if (!NODE_TYPES.has(params.type)) return { ok: false, reason: 'invalid_node_type', detail: [...NODE_TYPES], spec: SPEC };
        const limit = Math.min(params.limit || 100, 1000);
        const since = params.since || '0000';
        const rows = db.prepare(
          'SELECT id,type,name,attrs_json,last_seen_at,observed_count,receipt_count FROM nodes WHERE type = ? AND last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT ?'
        ).all(params.type, since, limit);
        return { ok: true, data: rows };
      }
      case 'nodes_by_name': {
        if (!params.name) return { ok: false, reason: 'name_required', spec: SPEC };
        const limit = Math.min(params.limit || 50, 500);
        const pattern = `%${params.name}%`;
        const rows = params.type
          ? db.prepare('SELECT id,type,name,last_seen_at,observed_count,receipt_count FROM nodes WHERE name LIKE ? COLLATE NOCASE AND type = ? ORDER BY last_seen_at DESC LIMIT ?').all(pattern, params.type, limit)
          : db.prepare('SELECT id,type,name,last_seen_at,observed_count,receipt_count FROM nodes WHERE name LIKE ? COLLATE NOCASE ORDER BY last_seen_at DESC LIMIT ?').all(pattern, limit);
        return { ok: true, data: rows };
      }
      case 'edges_from': {
        if (!params.source) return { ok: false, reason: 'source_required', spec: SPEC };
        const limit = Math.min(params.limit || 100, 1000);
        const rows = params.predicate
          ? db.prepare('SELECT id,source,predicate,target,weight FROM edges WHERE source = ? AND predicate = ? ORDER BY weight DESC LIMIT ?').all(params.source, params.predicate, limit)
          : db.prepare('SELECT id,source,predicate,target,weight FROM edges WHERE source = ? ORDER BY weight DESC LIMIT ?').all(params.source, limit);
        return { ok: true, data: rows };
      }
      case 'edges_to': {
        if (!params.target) return { ok: false, reason: 'target_required', spec: SPEC };
        const limit = Math.min(params.limit || 100, 1000);
        const rows = params.predicate
          ? db.prepare('SELECT id,source,predicate,target,weight FROM edges WHERE target = ? AND predicate = ? ORDER BY weight DESC LIMIT ?').all(params.target, params.predicate, limit)
          : db.prepare('SELECT id,source,predicate,target,weight FROM edges WHERE target = ? ORDER BY weight DESC LIMIT ?').all(params.target, limit);
        return { ok: true, data: rows };
      }
      case 'neighborhood': {
        if (!params.node_id) return { ok: false, reason: 'node_id_required', spec: SPEC };
        const depth = Math.min(params.depth || 1, 3);
        const limit = Math.min(params.limit || 50, 500);
        const nodes = new Map();
        const edges = [];
        const frontier = new Set([params.node_id]);
        const seen = new Set();
        const center = db.prepare('SELECT id,type,name FROM nodes WHERE id = ?').get(params.node_id);
        if (center) nodes.set(center.id, center);
        for (let d = 0; d < depth; d++) {
          const next = new Set();
          for (const nid of frontier) {
            if (seen.has(nid)) continue;
            seen.add(nid);
            const out = db.prepare('SELECT id,source,predicate,target,weight FROM edges WHERE source = ? OR target = ? LIMIT ?').all(nid, nid, limit);
            for (const e of out) {
              edges.push(e);
              for (const peer of [e.source, e.target]) {
                if (!nodes.has(peer)) {
                  const n = db.prepare('SELECT id,type,name FROM nodes WHERE id = ?').get(peer);
                  if (n) nodes.set(n.id, n);
                  next.add(peer);
                }
              }
            }
          }
          frontier.clear();
          for (const n of next) frontier.add(n);
        }
        return { ok: true, data: { nodes: [...nodes.values()], edges } };
      }
      case 'counts': {
        const nodeCounts = db.prepare('SELECT type, COUNT(*) AS n FROM nodes GROUP BY type').all();
        const edgeCounts = db.prepare('SELECT predicate, COUNT(*) AS n FROM edges GROUP BY predicate').all();
        return { ok: true, data: { nodes: nodeCounts, edges: edgeCounts } };
      }
      default:
        return { ok: false, reason: 'unknown_op', detail: op, spec: SPEC };
    }
  } catch (err) {
    return { ok: false, reason: 'query_failed', detail: String(err?.message || err), spec: SPEC };
  }
}

/**
 * write(params) — gated. The Graph Weaver build workflow owns ontology mutation.
 * Mirage will not write nodes/edges out-of-band; doing so would break the
 * Flux-observation→graph-rebuild loop and corrupt receipt_count math.
 */
async function write(_params) {
  return {
    ok: false,
    reason: 'use_graph_weaver_build_workflow',
    detail: 'graph is rebuilt from Flux observations by 04-CONTROL-PLANE/workflows/graph-weaver-build.workflow.mjs',
    spec: SPEC,
  };
}

async function healthz() {
  const db = await getDB();
  if (!db) return { ok: false, status: 'unavailable', detail: _openErr, spec: SPEC };
  try {
    const nodes = db.prepare('SELECT COUNT(*) AS n FROM nodes').get();
    const edges = db.prepare('SELECT COUNT(*) AS n FROM edges').get();
    return {
      ok: true,
      status: 'ready',
      db_path: GRAPH_DB,
      node_count: nodes?.n ?? 0,
      edge_count: edges?.n ?? 0,
      ontology: { node_types: [...NODE_TYPES], edge_predicates: [...EDGE_PREDS] },
      spec: SPEC,
    };
  } catch (err) {
    return { ok: false, status: 'query_failed', detail: String(err?.message || err), spec: SPEC };
  }
}

export const graphAdapter = Object.freeze({ read, write, healthz });
export default graphAdapter;
