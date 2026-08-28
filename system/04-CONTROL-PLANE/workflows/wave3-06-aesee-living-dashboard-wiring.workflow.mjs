// wave3-06-aesee-living-dashboard-wiring.workflow.mjs
// AESee Living Dashboard data wiring — replaces RightRail stubs with real /v1/* fetches.
// All 14 cockpit components + DAG view get LIVE data from gateway endpoints.

export const meta = {
  name: 'wave3-06-aesee-living-dashboard-wiring',
  description: 'AESee data wiring: real /v1/* fetches replace all stubbed RightRail and DAG components',
  phases: [
    { title: 'Author', detail: '10 parallel authors' },
    { title: 'Synth', detail: 'integration receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
AESee data wiring doctrine (read 02-APP/src/components/cockpit/RightRail.tsx + 02-APP/src/components/aesee/*.tsx first):
- Wave 2 #023 shipped the Cockpit AESee constellation + Wave 2 #036 shipped Bioluminescent DAG.
- ALL components are currently rendering STUBS or props-only. Per the RightRail.tsx comments: "real data wiring is a follow-up task".
- This workflow wires every component to its real /v1/* endpoint with: SWR-style hooks, exponential backoff retry, honest empty/error states.
- Endpoints (all live as of #032+#034):
  - /v1/flow/events (Reality Flux tail)
  - /v1/atomsmasher/state (currents, depth, atoms count)
  - /v1/memory/state-brief (Mirage StateBrief)
  - /v1/graph/query (Graph Weaver search)
  - /v1/receipts/recent (latest hash-chain receipts)
  - /v1/guardrails/status (27 rails health)
  - /v1/hermes/leases (active leases)
  - /v1/promotion/queue (modules awaiting promotion)
  - /v1/visual/qdrant/health (OrangeEye)
  - /v1/v1.mjs healthz aggregate
Quality: REAL fetches. NO fake data. Loading shimmers. Empty states. Error states that show the endpoint name and HTTP code. Polling rates that respect the data lifecycle (1s for live feed, 10s for receipts, 5s for guardrails).
`

phase('Author')
const components = [
  { id: 'use-orange-api-hook', prompt: `Author ${ROOT}/02-APP/src/hooks/useOrangeApi.ts — generic React hook: const {data, error, isLoading, refresh} = useOrangeApi<T>('/v1/path', {pollMs?, dedupeKey?}). Uses fetch + AbortController. Handles 4xx/5xx + network errors distinctly. Exposes a cancel function. Tests at hooks/__tests__/useOrangeApi.test.ts. ${CTX}` },
  { id: 'live-feed-wire', prompt: `Read ${ROOT}/02-APP/src/components/cockpit/RightRail.tsx and rewrite the LivingFeed card to use useOrangeApi('/v1/flow/events?lane=reality&tail=10', {pollMs:1000}). Map FluxEvent → LivingFeedEntry. Real timestamps. Error state shows "/v1/flow/events HTTP 503" not "no events". DO NOT remove the empty-state copy. ${CTX}` },
  { id: 'model-routing-wire', prompt: `Read ${ROOT}/02-APP/src/components/cockpit/RightRail.tsx and rewrite the ModelRouting card to use useOrangeApi('/v1/healthz', {pollMs:10000}). Maps the healthz response (orangellm/light/heavy/visual/cobra) → ModelRoutingRow[]. Shows model tag, last_response_ms, status (live/watch/blocked). ${CTX}` },
  { id: 'receipt-trail-wire', prompt: `Read ${ROOT}/02-APP/src/components/cockpit/RightRail.tsx and rewrite the ReceiptTrail card to use useOrangeApi('/v1/receipts/recent?limit=8', {pollMs:10000}). Each row: receipt_id (first 8 of hash) + label + when (relative time). Click → opens AESee detail drawer. ${CTX}` },
  { id: 'dag-graph-wire', prompt: `Read ${ROOT}/02-APP/src/components/aesee/DagGraph.tsx and wire it to useOrangeApi('/v1/atomsmasher/currents', {pollMs:2000}). Each current → a DagNode with bioluminescent intensity proportional to depth. Edges from current.upstream_ids. Honest empty: "No currents — AtomSmasher quiet". ${CTX}` },
  { id: 'whisper-context-wire', prompt: `Read ${ROOT}/02-APP/src/components/aesee/WhisperContext.tsx and wire it to useOrangeApi('/v1/memory/state-brief?lookback=15m', {pollMs:5000}). Renders StateBrief summary as ambient whisper text in the cockpit. Truncate to 240 chars. ${CTX}` },
  { id: 'time-scrubber-wire', prompt: `Read ${ROOT}/02-APP/src/components/aesee/TimeScrubber.tsx and wire it to useOrangeApi('/v1/flow/events?lane=reality&from=<scrub_start>&to=<scrub_end>'). Range query that updates as the user scrubs. Shows event density histogram. ${CTX}` },
  { id: 'artifact-library-wire', prompt: `Read ${ROOT}/02-APP/src/components/aesee/ArtifactLibrary.tsx and wire it to useOrangeApi('/v1/graph/query?type=artifact&limit=40'). Lists graph-indexed artifacts (receipts, briefs, training adapters). Click → opens artifact detail (path + sha + when). ${CTX}` },
  { id: 'perspective-filter-wire', prompt: `Read ${ROOT}/02-APP/src/components/aesee/PerspectiveFilter.tsx and wire it to control the lane filter applied to LivingFeed + DagGraph. Three lanes: reality, thought, hermes. Click toggles. State persisted in localStorage. ${CTX}` },
  { id: 'aesee-error-boundary', prompt: `Author ${ROOT}/02-APP/src/components/aesee/AESeeErrorBoundary.tsx — React error boundary that wraps the AESee view. On any child throw, shows "AESee data layer hiccup — endpoint: <last failed path>" + a Retry button that triggers a global refresh event. Logs to console with full stack. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `aesee:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-26-wave3-06-aesee-living-dashboard-wiring.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps: components are now wired but operator must (a) run npm install to ensure SWR/equivalent if added, (b) run npm run build to verify TypeScript still clean, (c) operator-side gateway needs to be running at 127.0.0.1:1337 for fetches to succeed at runtime. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
