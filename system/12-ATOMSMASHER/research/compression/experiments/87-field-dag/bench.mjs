// Experiment 87 — Field-dependency DAG mining (analysis-only).
// Build a directed graph: field A → field B if knowing A predicts B with >99% accuracy.
// Output: edges, roots (IRREDUCIBLE fields), theoretical lower bound = brotli(roots_only).
// No codec needed — the "ratio" we report is the THEORETICAL CEILING.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const rawTotal = corpusBytes.length;

function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

const t0 = performance.now();

// === FIELD EXTRACTION ===
// Flatten each receipt into a feature vector across top-level + payload fields.
const flatRecords = receipts.map((r, i) => {
  const o = {
    id: r.id,
    action: r.action,
    status: r.status,
    summary: r.summary,
    created_at: r.created_at,
    payload_json_raw: r.payload_json,
  };
  // Parse payload fields if JSON-like
  try {
    const p = JSON.parse(r.payload_json);
    if (p && typeof p === 'object') {
      for (const [k, v] of Object.entries(p)) {
        const tag = `payload.${k}`;
        // Only consider scalars; skip arrays/objects (would need deeper analysis)
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
          o[tag] = v;
        } else {
          o[tag] = JSON.stringify(v); // serialize for nested
        }
      }
    }
  } catch {}
  return o;
});

// Collect unique fields
const allFieldsSet = new Set();
for (const r of flatRecords) for (const k of Object.keys(r)) allFieldsSet.add(k);
const FIELDS = [...allFieldsSet];

// === DEPENDENCY DETECTION ===
// For each pair (A, B), is B a deterministic function of A?
// Definition: groupBy(A) → for each value of A, all rows must have one same value of B.
// If accuracy >= 99%, declare edge A → B.

function buildEdges() {
  const edges = []; // {from, to, accuracy, classes}
  for (const a of FIELDS) {
    for (const b of FIELDS) {
      if (a === b) continue;
      const groups = new Map();
      let totalRows = 0;
      for (const r of flatRecords) {
        if (!(a in r) || !(b in r)) continue;
        totalRows++;
        const aVal = JSON.stringify(r[a]);
        const bVal = JSON.stringify(r[b]);
        if (!groups.has(aVal)) groups.set(aVal, { domBVal: bVal, counts: new Map() });
        const g = groups.get(aVal);
        g.counts.set(bVal, (g.counts.get(bVal) || 0) + 1);
      }
      if (groups.size === 0 || totalRows < 5) continue;
      // For each group, the dominant B-value, and how many rows agree.
      let correctRows = 0;
      for (const g of groups.values()) {
        let maxCount = 0;
        for (const c of g.counts.values()) if (c > maxCount) maxCount = c;
        correctRows += maxCount;
      }
      const accuracy = correctRows / totalRows;
      if (accuracy >= 0.99) {
        edges.push({ from: a, to: b, accuracy: Number(accuracy.toFixed(4)), classes: groups.size, support: totalRows });
      }
    }
  }
  return edges;
}

const edges = buildEdges();

// Identify roots = fields that have NO incoming edge from another field with strict >0.99 accuracy
const incoming = new Set();
for (const e of edges) incoming.add(e.to);
const roots = FIELDS.filter(f => !incoming.has(f)).sort();

// === THEORETICAL LOWER BOUND ===
// Brotli compress only the IRREDUCIBLE fields. Build a corpus that contains
// only the root fields per receipt, in JSON form.
const rootSet = new Set(roots);
// Don't include the payload_json_raw root (it's the un-parsed form). If `action` is a root
// and payload.* are downstream of action, the irreducible corpus excludes payload values.
// However: payload_json_raw is itself a root unless predictable from action; check.
// Output an irreducible JSONL.
const irreducible = flatRecords.map(r => {
  const o = {};
  for (const k of roots) if (k in r) o[k] = r[k];
  return o;
});
const irreducibleJsonl = irreducible.map(o => JSON.stringify(o)).join('\n') + '\n';
const irreducibleBytes = Buffer.from(irreducibleJsonl, 'utf8');
const compIrreducible = brotli11(irreducibleBytes);
const theoreticalRatio = rawTotal / compIrreducible.length;

const encode_ms = performance.now() - t0;

// Edge summary (top by support)
const topEdges = edges.sort((a, b) => b.support - a.support).slice(0, 20);

const summary = {
  experiment: '87-field-dag',
  ratio: Number(theoreticalRatio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: 0,
  lossless: 'n/a',
  notes: `Total fields=${FIELDS.length}. Edges (>=99% determinism)=${edges.length}. Irreducible roots=${roots.length}: ${roots.join(', ')}. Theoretical ceiling brotli(roots-only)=${compIrreducible.length}B → ${theoreticalRatio.toFixed(2)}× raw. Top edges by support: ${topEdges.slice(0,5).map(e => `${e.from}->${e.to}(n=${e.support})`).join(', ')}`,
  baseline_m19_ratio: 47.071,
  vs_m19_delta: Number((theoreticalRatio - 47.071).toFixed(3)),
  raw_bytes: rawTotal,
  irreducible_bytes_brotli: compIrreducible.length,
  total_fields: FIELDS.length,
  irreducible_count: roots.length,
  roots: roots,
  total_edges: edges.length,
  top_edges_by_support: topEdges,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
