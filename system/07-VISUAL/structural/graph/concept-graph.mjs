// 07-VISUAL/structural/graph/concept-graph.mjs
//
// The concept graph — Æyes' associative memory substrate.
//
// Kurzweil's PRTM: hierarchy is not spatial, it lives in the CONNECTIONS
// between recognizers. So we don't stack layers, we bind nodes via typed
// edges. Every recognition event lands nodes + edges. The graph grows.
//
// Node types (extensible):
//   CONCEPT    — "orange", "apple", "dog", abstract labels
//   SIGNATURE  — a raw measured photon-property descriptor
//   EPISODE    — a specific observed instance (frame, timestamp, source)
//   SCENE      — a co-observed context ("kitchen", "orchard")
//   EMOTION    — affective tag (future — placeholder for narrative memory)
//   NARRATIVE  — story-level binding (future)
//
// Edge types (typed, weighted):
//   IS_A         — taxonomic (golden_retriever IS_A dog)
//   MEASURED_AS  — grounding (concept MEASURED_AS signature)
//   CO_OCCURRED  — contextual binding (concept + concept in same scene)
//   PRECEDED     — temporal (concept T-1 PRECEDED concept T)
//   PRIMES       — top-down priming (concept PRIMES concept)
//   SIMILAR_TO   — descriptor-space nearness
//   REMINDED_OF  — episode-to-episode association
//   CAUSED       — causal (future)
//
// Storage: JSONL append-only for durability + a compact JSON snapshot for
// fast load. Deterministic given input order.

import fs from "node:fs";
import path from "node:path";

export const NODE_TYPES = ["CONCEPT", "SIGNATURE", "EPISODE", "SCENE", "EMOTION", "NARRATIVE"];
export const EDGE_TYPES = ["IS_A", "MEASURED_AS", "CO_OCCURRED", "PRECEDED", "PRIMES", "SIMILAR_TO", "REMINDED_OF", "CAUSED"];

export function emptyGraph() {
  return { nodes: new Map(), edges: [], next_id: 1 };
}

export function loadGraph(pathOrDir) {
  const snapPath = pathOrDir.endsWith(".json") ? pathOrDir : path.join(pathOrDir, "concept-graph.json");
  if (!fs.existsSync(snapPath)) return emptyGraph();
  try {
    const raw = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    return {
      nodes: new Map(raw.nodes.map((n) => [n.id, n])),
      edges: raw.edges,
      next_id: raw.next_id ?? 1,
    };
  } catch { return emptyGraph(); }
}

export function saveGraph(pathOrDir, g) {
  const snapPath = pathOrDir.endsWith(".json") ? pathOrDir : path.join(pathOrDir, "concept-graph.json");
  fs.mkdirSync(path.dirname(snapPath), { recursive: true });
  const raw = { nodes: [...g.nodes.values()], edges: g.edges, next_id: g.next_id };
  fs.writeFileSync(snapPath, JSON.stringify(raw, null, 2));
}

function nextId(g, prefix) {
  const id = `${prefix}_${g.next_id}`;
  g.next_id++;
  return id;
}

export function addNode(g, type, props = {}) {
  if (!NODE_TYPES.includes(type)) throw new Error(`unknown node type ${type}`);
  const id = props.id ?? nextId(g, type.toLowerCase().slice(0, 3));
  const node = { id, type, activation: 0, created_at: props.created_at ?? Date.now(), ...props };
  g.nodes.set(id, node);
  return node;
}

export function addEdge(g, from, type, to, weight = 1.0, meta = {}) {
  if (!EDGE_TYPES.includes(type)) throw new Error(`unknown edge type ${type}`);
  if (!g.nodes.has(from) || !g.nodes.has(to)) throw new Error(`edge endpoint missing: ${from} or ${to}`);
  const edge = { from, type, to, weight, ...meta };
  g.edges.push(edge);
  return edge;
}

export function findOrCreateConcept(g, label, meta = {}) {
  for (const n of g.nodes.values()) {
    if (n.type === "CONCEPT" && n.label === label) return n;
  }
  return addNode(g, "CONCEPT", { label, ...meta });
}

export function attachSignature(g, conceptId, descriptor, source) {
  const sig = addNode(g, "SIGNATURE", { descriptor, source });
  addEdge(g, conceptId, "MEASURED_AS", sig.id, 1.0);
  return sig;
}

export function neighborsByType(g, id, edgeType, direction = "out") {
  const out = [];
  for (const e of g.edges) {
    if (edgeType && e.type !== edgeType) continue;
    if (direction === "out" && e.from === id) out.push({ node: g.nodes.get(e.to), edge: e });
    if (direction === "in" && e.to === id) out.push({ node: g.nodes.get(e.from), edge: e });
  }
  return out;
}

export function conceptSignatures(g, conceptId) {
  return neighborsByType(g, conceptId, "MEASURED_AS", "out")
    .filter((x) => x.node?.type === "SIGNATURE")
    .map((x) => ({ descriptor: x.node.descriptor, source: x.node.source, signatureId: x.node.id }));
}

// Spreading activation: given a set of seed nodes with activations, propagate
// one hop along all edge types with edge weights. Bounded and pure.
export function spreadActivation(g, seed, opts = {}) {
  const decay = opts.decay ?? 0.5;
  const activations = new Map(seed);
  for (const e of g.edges) {
    const src = activations.get(e.from);
    if (!src) continue;
    const cur = activations.get(e.to) ?? 0;
    activations.set(e.to, cur + src * e.weight * decay);
  }
  return activations;
}

export function graphStats(g) {
  const byNode = {};
  const byEdge = {};
  for (const n of g.nodes.values()) byNode[n.type] = (byNode[n.type] ?? 0) + 1;
  for (const e of g.edges) byEdge[e.type] = (byEdge[e.type] ?? 0) + 1;
  return { total_nodes: g.nodes.size, total_edges: g.edges.length, by_node_type: byNode, by_edge_type: byEdge };
}
