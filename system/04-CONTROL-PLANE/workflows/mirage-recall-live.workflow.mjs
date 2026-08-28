// mirage-recall-live.workflow.mjs
// Build the Mirage StateBrief gateway route + N150 shadow cache + auto-inject middleware
// so OrangeLLM has real memory recall through the gateway.

export const meta = {
  name: 'mirage-recall-live',
  description: 'Mirage StateBrief route + N150 shadow cache + auto-inject middleware',
  phases: [
    { title: 'Author', detail: '5 parallel — gateway route, mirage adapter registry, shadow cache sync, auto-inject middleware, cockpit indicator' },
    { title: 'Synth',  detail: 'end-to-end smoke test + receipt' },
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
Mirage doctrine:
- Mirage is the data + memory plane. Two families:
  - mirage/data/* — external mounts (postgres, drive, gmail, slack, github, redis, etc.) — 11 mounts total, write ops require per-call operator approval
  - mirage/memory/* — internal stores (Flux ledgers via Æ Cobra, Graph Weaver SQLite, receipts) — read-write per Sovereign
- StateBrief is the compressed memory slice OrangeLLM gets when asking 'what did we decide about X' or 'what happened on Tuesday'
- Reality always overrides Thought on conflict. Receipts override recollection.
- Auto-inject pattern (Option C hybrid): every chat completion through OrangeLLM gateway includes a 'recent context' StateBrief in the system role (last 5 reality events + last 3 thought + open conflicts)
- Plus <recall>{query}</recall> mid-turn tag triggers a deeper StateBrief, lands as [MEMORY:RECALLED] system message

Existing infra:
- Æ Cobra daemon at 127.0.0.1:7419 with /state-brief endpoint
- OrangeLLM gateway at 127.0.0.1:1337 with existing routes /v1/chat/completions, /v1/models, /healthz
- Codexa command rail at 10.0.99.1:8097 (token-gated)
- N150 cockpit shadow cache at 06-ORANGELLM/memory/cache/

Quality bar: Real code. Fallback to N150 shadow cache when Codexa rail unreachable.
`

phase('Author')

const components = [
  {
    id: 'gateway-memory-route',
    prompt: `Author the gateway /v1/memory/state-brief route.

Write to ${ROOT}/06-ORANGELLM/server/routes/memory.mjs.

Exports registerMemoryRoutes(server, opts). Routes:
- POST /v1/memory/state-brief — body {query, time_range_ms, lanes, max_records, include_conflicts}. Proxies to Æ Cobra at 127.0.0.1:7419/state-brief. On Æ Cobra unreachable, falls back to N150 shadow cache (next component). Returns the StateBrief JSON.
- POST /v1/memory/recall — body {query} — shortcut for state-brief with operator-defined defaults.
- GET /v1/memory/healthz — probes both Æ Cobra direct + shadow cache, reports which is serving.

Plus update gateway boundary allow-list at 06-ORANGELLM/server/routes/memory-boundary.mjs to include /v1/memory/* paths.

${CONTEXT}`,
  },
  {
    id: 'mirage-adapter-registry',
    prompt: `Author the Mirage adapter registry skeleton (Night-1 stubs for all 11 mounts).

Write to ${ROOT}/11-MIRAGE/adapters/index.mjs.

Exports:
- MIRAGE_MOUNTS — manifest of 11 adapters: postgres, drive, gmail, slack, github, redis, plus 5 memory adapters (flux, graph, receipts, atoms, cache).
- getAdapter(name) — returns adapter object {read, write, healthz} or throws.
- All 11 adapters as STUBS that return {ok: false, reason: 'stub_night_1', spec: '<link to spec section>'} for Night-1 EXCEPT:
  - flux (READY — proxies to Æ Cobra)
  - graph (READY — proxies to Graph Weaver routes)
  - receipts (READY — file glob over 10-RECEIPTS/orange5-build/)

Each adapter is its own file under 11-MIRAGE/adapters/<name>.mjs.

${CONTEXT}`,
  },
  {
    id: 'shadow-cache',
    prompt: `Author the N150 shadow cache sync script.

Write to ${ROOT}/06-ORANGELLM/memory/cache/sync.mjs (and supporting files).

Behavior:
1. sync.mjs — Bun/Node script. Connects to Codexa rail at 10.0.99.1:8097 with token (ORANGEBOX_RAIL_TOKEN env). GETs recent Flux events (last 24h) from each lane. Writes them to 06-ORANGELLM/memory/cache/<lane>-<date>.jsonl. Records last-sync timestamp at 06-ORANGELLM/memory/cache/.sync-state.json.
2. shadow-reader.mjs — Exports readShadowCache({lanes, startMs, endMs, maxRecords}) — same shape as Æ Cobra reader so the gateway's fallback path uses identical code.
3. shadow-state-brief.mjs — Reimplements computeStateBrief using the shadow cache instead of the live daemon. Returns the same StateBrief shape with one extra field: shadow=true, last_sync_at=<ts>.
4. cron-windows.ps1 — PowerShell scheduled-task installer for hourly sync on the N150 (Windows). Calls 'node sync.mjs'.
5. README.md — sync schedule, freshness SLA (1 hour), what happens when stale (>2h triggers a 'stale' indicator).

${CONTEXT}`,
  },
  {
    id: 'auto-inject',
    prompt: `Author the auto-inject memory middleware for chat completions.

Write to ${ROOT}/06-ORANGELLM/server/middleware/memory-inject.mjs.

Exports memoryInjectMiddleware(opts) — Express/Hono-style middleware that wraps incoming POST /v1/chat/completions requests. On each request:
1. Fetch a quick StateBrief from /v1/memory/state-brief with query='' (recent context), max_records=8.
2. Inject as the first system message: '[MEMORY:RECALLED] (this is verified history from Æ Cobra Flux. Reality cites > Thought cites. Receipts > recollection.) <STATE_BRIEF_JSON> [END:RECALLED]'.
3. Also scan the incoming user message text for <recall>{query}</recall> tags. For each found, do a deeper StateBrief query and prepend that to the system role with [MEMORY:RECALLED] wrapping.
4. Pass the modified messages to the downstream chat completion handler.
5. Add header X-Memory-Injected-Bytes: <int> to the response so the operator can see how much memory was injected.

${CONTEXT}`,
  },
  {
    id: 'cockpit-indicator',
    prompt: `Author the Cockpit memory-freshness indicator (Atomic Orange patch — operator applies manually).

Write to ${ROOT}/06-ORANGELLM/memory/cache/atomic-orange-patch/.

1. useMemoryFreshness.ts — React hook that polls GET /v1/memory/healthz every 10s. Returns {status: 'live' | 'shadow' | 'stale' | 'down', last_sync_at, source}.
2. MemoryFreshnessChip.tsx — small UI chip that renders: green dot + 'LIVE' when status=live, amber dot + 'SHADOW (Nm ago)' when source=shadow + freshness <1h, red dot + 'STALE (Nh ago)' when >1h, red X + 'DOWN' when down. Uses Atom Standard palette (--green, --amber, --red).
3. README.md — how to splice into ChromeBar.tsx (add MemoryFreshnessChip next to existing SYNC indicator slot).

${CONTEXT}`,
  },
]

log(`Fanning out ${components.length} Mirage Recall component authors in parallel.`)

const results = await parallel(
  components.map(c => () => agent(c.prompt, { phase: 'Author', label: `mirage:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' }))
)

phase('Synth')

const synth = await agent(
  `Synthesize Mirage Recall LIVE.

Author results:
${JSON.stringify(results.filter(Boolean), null, 2)}

Write the receipt to ${ROOT}/10-RECEIPTS/orange5-build/2026-06-24-mirage-recall-live.md.

Required:
- Receipt ID, generated_at, schema, actor, status (MIRAGE_RECALL_LIVE_GATEWAY_ROUTES_AND_SHADOW_CACHE_AUTHORED), confidence
- prior_receipt + hash_chain
- Components table
- Endpoint inventory: /v1/memory/state-brief, /v1/memory/recall, /v1/memory/healthz, GET on each Mirage adapter
- Honest gaps: postgres/drive/gmail/etc. adapters are STUBS Night-1, full activation gated on per-mount approval ceremony; auto-inject is conservative (8 records) and may need tuning
- Mom's Law
- Hash chain footer

Return via StructuredOutput.`,
  { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' }
)

return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
