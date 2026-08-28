// wave3-09-receipts-sqlite-vault-viewer.workflow.mjs
// Receipts SQLite gateway exposure + Atomic Orange Vault receipts viewer.
// Wave 2 #031 shipped the SQLite + 663-line query.mjs; this wave EXPOSES it through gateway + Vault UI.

export const meta = {
  name: 'wave3-09-receipts-sqlite-vault-viewer',
  description: 'Receipts SQLite exposed via /v1/receipts/* + Atomic Orange Vault receipt viewer panel',
  phases: [
    { title: 'Author', detail: '9 parallel authors' },
    { title: 'Synth', detail: 'integration receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
Receipts SQLite + Vault viewer doctrine (read 06-CONTROL-PLANE/receipts/ existing + 06-ORANGELLM/server/routes/receipts.mjs first):
- Wave 2 #031 shipped: receipts SQLite db + ingest pipeline + 663-line query.mjs with rich filter/search.
- Gateway routes/receipts.mjs exists but only exposes /recent. This workflow exposes the full query surface.
- Atomic Orange Vault.tsx exists but doesn't show receipts. This wave adds the ReceiptViewer panel.
- Endpoints to expose:
  - GET /v1/receipts/recent (already live)
  - GET /v1/receipts/:id (single receipt by hash or partial hash)
  - GET /v1/receipts/search?q=<text>&from=<ts>&to=<ts>&status=<green|partial|red>
  - GET /v1/receipts/chain/:id (full prior-chain walk from a receipt)
  - GET /v1/receipts/stats (total, by_status, by_workflow, growth_30d)
  - POST /v1/receipts/verify-chain (full integrity check, gated)
- Vault UI: ReceiptViewer with three sub-views — list (search/filter), detail (markdown render + hash chain proof), graph (chain visualization).
- Mom's Law: every claim of "chain unbroken" must be backed by an actual verify call result, not a fake-green.
Quality: real SQL, real chain verification, real markdown rendering, honest error states.
`

phase('Author')
const components = [
  { id: 'route-receipt-by-id', prompt: `Read ${ROOT}/06-ORANGELLM/server/routes/receipts.mjs and add GET /v1/receipts/:id handler. Calls query.mjs.fetchById(idOrPrefix). Returns {receipt_id, status, body_md, frontmatter, prior_receipt_id, chain_depth, sha256}. 404 if not found. Output the unified file. ${CTX}` },
  { id: 'route-receipt-search', prompt: `Add to ${ROOT}/06-ORANGELLM/server/routes/receipts.mjs the GET /v1/receipts/search?q&from&to&status handler. Calls query.mjs.search(opts). Returns paginated {items:[{id, status, when, label}], total, page, limit}. Validates filters server-side. ${CTX}` },
  { id: 'route-chain-walk', prompt: `Add to ${ROOT}/06-ORANGELLM/server/routes/receipts.mjs the GET /v1/receipts/chain/:id handler. Walks prior_receipt links backward, returns ordered chain. Detects breaks and surfaces them as {chain_breaks:[{at_id, reason}]}. ${CTX}` },
  { id: 'route-stats', prompt: `Add to ${ROOT}/06-ORANGELLM/server/routes/receipts.mjs the GET /v1/receipts/stats handler. Aggregates: total count, by_status, by_workflow, growth_last_30d (per-day counts). Cached 60s. ${CTX}` },
  { id: 'route-verify-chain', prompt: `Add to ${ROOT}/06-ORANGELLM/server/routes/receipts.mjs the POST /v1/receipts/verify-chain handler. Runs full integrity sweep: each receipt's prior_receipt resolves AND its sha256 matches body+frontmatter hash. Returns {ok, total_checked, breaks:[{at_id, reason}], elapsed_ms}. Gated: requires X-Atom-Rail-Token header. ${CTX}` },
  { id: 'vault-receipt-viewer', prompt: `Author ${ROOT}/02-APP/src/components/vault/ReceiptViewer.tsx — three-view component: list (table with status pills + click-to-detail), detail (markdown rendering via react-markdown with syntax highlight for code fences), chain-graph (vertical chain visualization). Uses useOrangeApi (from Wave 3-06). Tabs to switch views. Persisted active-tab in localStorage. ${CTX}` },
  { id: 'vault-receipt-search-bar', prompt: `Author ${ROOT}/02-APP/src/components/vault/ReceiptSearchBar.tsx — search input with debounce 300ms, fires /v1/receipts/search, shows result count + dropdown of hits. Click hit → opens that receipt in ReceiptViewer detail tab. Empty state: "search by receipt id, label, content, or hash". ${CTX}` },
  { id: 'vault-integration', prompt: `Read ${ROOT}/02-APP/src/lanes/Vault.tsx and produce the splice that adds the ReceiptViewer + ReceiptSearchBar to the Vault lane as a new tab/section. DO NOT remove existing Vault drag-drop or memory panel. ${CTX}` },
  { id: 'sqlite-cli-tool', prompt: `Author ${ROOT}/06-CONTROL-PLANE/receipts/bin/receipts.mjs — CLI tool. Commands: recent [N], by-id <id>, search <q>, chain <id>, verify-chain, stats. Calls the gateway endpoints (or direct SQLite if --offline). Pretty-prints to terminal. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `rcpt:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-26-wave3-09-receipts-sqlite-vault-viewer.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps: full chain verify can take >5s on large db — UI must show progress indicator. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
