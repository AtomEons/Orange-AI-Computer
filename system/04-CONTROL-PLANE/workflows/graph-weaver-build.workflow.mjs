// graph-weaver-build.workflow.mjs
// Build the Graph Weaver — typed-ontology semantic indexer that tails Flux records,
// extracts entities, writes typed nodes + edges to SQLite, exposes query API.

export const meta = {
  name: 'graph-weaver-build',
  description: 'Build Graph Weaver typed-ontology indexer over Flux records',
  phases: [
    { title: 'Author', detail: '6 parallel — schema, daemon, embedder, query API, gateway routes, ontology-candidates' },
    { title: 'Synth',  detail: 'integration receipt + systemd unit + smoke test' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = {
  type: 'object',
  properties: {
    component: { type: 'string' },
    files_written: { type: 'array', items: { type: 'string' } },
    line_counts: { type: 'object', additionalProperties: { type: 'integer' } },
    notes: { type: 'string' },
  },
  required: ['component', 'files_written', 'line_counts', 'notes'],
  additionalProperties: false,
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['green', 'partial', 'red'] },
    files_landed: { type: 'integer' },
    receipt_path: { type: 'string' },
    open_issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'files_landed', 'receipt_path', 'open_issues'],
  additionalProperties: false,
}

const CONTEXT = `
Graph Weaver doctrine:
- 10-node 6-edge LOCKED ontology:
  Nodes: Sovereign, Project, Mission, Lane, Model, Tool, Service, Host, Receipt, Doctrine
  Edges: PROVES, REQUIRES, BLOCKED_BY, SUPERSEDES, APPROVED_BY, OBSERVED_BY
- Tail watches /mnt/ae_flux/events/reality/<date>.jsonl + thought/ + merge/
- Per record: extract entities (qwen3:0.6b on N150 via Ollama /api/chat — operator's machine has this), embed with nomic-embed-text, write nodes + edges to SQLite at 06-ORANGELLM/memory/graph.db
- Receipt-gated ontology extension: candidate types tagged with proposed_type, promoted when >=5 receipts reference OR operator types 'promote-ontology <name>'
- Queryable via /v1/graph/* gateway routes

Existing infra: Æ Cobra Flux reader at 06-ORANGELLM/memory/ae-cobra/flux/reader.mjs; Ollama at 127.0.0.1:11434

Quality bar: Real Node 20+ code. SQLite via better-sqlite3 (synchronous, fast). Idempotent on restart (tracks last processed offset per lane).
`

phase('Author')

const components = [
  {
    id: 'schema',
    prompt: `Author the SQLite schema for the Graph Weaver.

Write to ${ROOT}/06-ORANGELLM/memory/graph-weaver/schema.sql.

Tables:
- nodes: id TEXT PRIMARY KEY (sha256 of normalized name + type), type TEXT, name TEXT, attrs_json TEXT, embedding BLOB (768 float32 dim from nomic-embed-text), created_at TEXT, last_seen_at TEXT, observed_count INTEGER, receipt_count INTEGER
- edges: id TEXT PRIMARY KEY (sha256 of source+predicate+target), source TEXT FK, predicate TEXT, target TEXT FK, weight REAL, created_at TEXT, last_observed_at TEXT, evidence_json TEXT (array of flux record hashes)
- watermarks: lane TEXT PRIMARY KEY, last_processed_ts INTEGER, last_processed_hash TEXT — tracks tailing progress so daemon resumes idempotently
- ontology_candidates: proposed_type TEXT PRIMARY KEY, occurrence_count INTEGER, first_seen_at TEXT, last_seen_at TEXT, referencing_receipts_json TEXT, promoted INTEGER DEFAULT 0

Plus indexes on nodes(type), nodes(name), edges(source), edges(target), edges(predicate).

Include migrations.sql with version comments so future schema bumps are tracked.

${CONTEXT}`,
  },
  {
    id: 'daemon',
    prompt: `Author the Graph Weaver tail daemon.

Write to ${ROOT}/06-ORANGELLM/memory/graph-weaver/daemon.mjs.

Behavior:
1. On start: open SQLite at 06-ORANGELLM/memory/graph.db (init from schema.sql if not exists). Read watermarks for each lane.
2. Main loop (every 30s):
   a. For each lane (reality, thought, merge): read flux records > last_processed_ts via Æ Cobra reader.
   b. For each record: call entity extractor (next component) to get {entities: [{type, name, attrs}], edges: [{source_name, predicate, target_name}]}.
   c. For each entity not yet in nodes: embed via nomic-embed-text; insert. For existing: bump observed_count, refresh last_seen_at.
   d. For each edge: insert (or bump weight if exists).
   e. Update watermarks.
3. Refuses to write nodes whose type is outside the 10-node ontology — instead inserts a proposed_type entry into ontology_candidates.
4. Graceful shutdown on SIGTERM (flush + close db).

Exports run(opts) for systemd entrypoint AND tickOnce(opts) for tests.

${CONTEXT}`,
  },
  {
    id: 'entity-extractor',
    prompt: `Author the entity extractor that the Graph Weaver daemon calls per Flux record.

Write to ${ROOT}/06-ORANGELLM/memory/graph-weaver/extractor.mjs.

Exports extractEntities(fluxRecord) — async. Calls Ollama qwen3:0.6b at 127.0.0.1:11434/api/chat with a system prompt instructing the model to emit ONLY JSON {entities: [{type, name, attrs}], edges: [{source, predicate, target}]} where type ∈ {Sovereign, Project, Mission, Lane, Model, Tool, Service, Host, Receipt, Doctrine} and predicate ∈ {PROVES, REQUIRES, BLOCKED_BY, SUPERSEDES, APPROVED_BY, OBSERVED_BY}. Validates output against schema; on parse failure, returns empty + logs the rejection to a sidecar JSONL at /mnt/ae_flux/logs/graph-weaver-extract-failures.jsonl.

For types the model wants but aren't in the 10-node set: emit them with proposed_type marker, daemon will route to ontology_candidates table.

${CONTEXT}`,
  },
  {
    id: 'embedder',
    prompt: `Author the embedder wrapper used by daemon.

Write to ${ROOT}/06-ORANGELLM/memory/graph-weaver/embedder.mjs.

Exports embedText(text) — async. Calls Ollama at 127.0.0.1:11434/api/embeddings with model='nomic-embed-text:latest'. Returns Float32Array of 768 dims, serialized to Buffer for SQLite BLOB storage.

Adds embedBatch(texts) — same but takes array, returns array.

Handles 429 / 503 with exponential backoff (3 retries, 200ms / 1s / 5s).

${CONTEXT}`,
  },
  {
    id: 'query',
    prompt: `Author the Graph Weaver query API.

Write to ${ROOT}/06-ORANGELLM/memory/graph-weaver/query.mjs.

Exports:
- getNode(id, db)
- findNodesByType(type, {limit=50, since, db})
- findNodesByName(query, {fuzzy=false, db}) — exact OR LIKE for fuzzy
- semanticSearch(text, {topK=10, type=null, db}) — embed text, cosine-similarity against nodes.embedding column
- neighbors(nodeId, {predicate=null, direction='out'|'in'|'both', maxDepth=1, db}) — BFS traversal
- shortestPath(srcId, dstId, {db}) — Dijkstra over edges weighted by 1/weight

Performance: keep all in-memory query plans where possible. SQLite calls should use prepared statements.

${CONTEXT}`,
  },
  {
    id: 'gateway-routes',
    prompt: `Author the gateway /v1/graph/* routes + systemd unit + smoke test.

Write under ${ROOT}/06-ORANGELLM/server/routes/:
- graph.mjs — exports registerGraphRoutes(server). Routes:
  - GET /v1/graph/node/:id
  - GET /v1/graph/nodes?type=&name=&fuzzy=&limit=
  - POST /v1/graph/search — body {text, top_k, type}
  - GET /v1/graph/neighbors/:id?predicate=&direction=&depth=
  - GET /v1/graph/path?src=&dst=
  - GET /v1/graph/ontology-candidates — list pending types
  - POST /v1/graph/promote-ontology — body {type_name}, operator-only (require X-Operator-Token header)

Plus write:
- ${ROOT}/06-ORANGELLM/memory/graph-weaver/systemd/graph-weaver.service — daemon systemd unit
- ${ROOT}/06-ORANGELLM/memory/graph-weaver/smoke-test.mjs — Bun script: init schema, write 3 sample flux records via Æ Cobra writer, run daemon.tickOnce, query for nodes, assert >= 3 nodes inserted, verify ontology-candidates queue handles an out-of-ontology type correctly.

${CONTEXT}`,
  },
]

log(`Fanning out ${components.length} Graph Weaver component authors in parallel.`)

const results = await parallel(
  components.map(c => () => agent(c.prompt, { phase: 'Author', label: `gw:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' }))
)

phase('Synth')

const synth = await agent(
  `Synthesize the Graph Weaver build.

Author results:
${JSON.stringify(results.filter(Boolean), null, 2)}

Write the receipt to ${ROOT}/10-RECEIPTS/orange5-build/2026-06-24-graph-weaver-built.md.

Required:
- Receipt ID, generated_at, schema, actor, status (GRAPH_WEAVER_BUILT_AWAITING_AE_COBRA_LIVE), confidence
- prior_receipt + hash_chain
- Components table, files, line counts
- Endpoint inventory (every new /v1/graph/* route)
- Honest gaps: no GraphQL surface, no graph viz, no automatic schema migration (manual via migrations.sql), depends on Æ Cobra Night-1 being live for Flux tail
- Mom's Law
- Hash chain footer

Return via StructuredOutput.`,
  { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' }
)

return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
