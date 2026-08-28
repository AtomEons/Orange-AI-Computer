// wave2-03-atomsmasher-eleven-modules.workflow.mjs
// Promote all 11 remaining AtomSmasher modules from STUB to LIVE.
// Commitment Atoms already LIVE in #019. Anti-fluff Gate was already LIVE pre-wave.

export const meta = {
  name: 'wave2-03-atomsmasher-eleven-modules',
  description: 'Promote 11 remaining AtomSmasher modules STUB → LIVE',
  phases: [
    { title: 'Author', detail: '11 parallel module authors' },
    { title: 'Synth', detail: 'receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'
const SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, modules_promoted: { type: 'integer' }, receipt_path: { type: 'string' } }, required: ['status', 'modules_promoted', 'receipt_path'], additionalProperties: false }

const CTX = `
AtomSmasher 12 modules (Anti-fluff Gate + Commitment Atoms already LIVE; these 11 are this workflow's scope):
1. AIR Codec — Anti-Inflation Recursive codec: compresses verbose output to dense info per byte
2. EquationStore — store of formal equations/invariants the system enforces (e.g. FOUNDER_SALARY math)
3. Cartridges — pre-compiled domain capability units swappable per task
4. Sparse Worksets — compresses working sets to minimum needed context per turn
5. Least-action Router — picks minimum-energy path through the model superstack per request
6. Expansion Warrants — explicit authorization tokens for scope expansion (rare, operator-gated)
7. Compression Debt Ledger — tracks every time the system chose verbose over compressed (debt to pay back)
8. Saved Work Certificates — proves a piece of work was done + can be reused (hash-chained)
9. Canon Pressure Detector — detects when an ontology candidate has accumulated enough receipts to promote
10. Pathwave Compressor — compresses execution trajectories into Pathwaves for replay/comparison
11. Persist (sibling to Commitment Atoms encoder — actually writes atoms to Flux + SQLite + emits receipts)
Each module follows the Anti-fluff Gate's LIVE pattern: schema in 09-SCHEMAS, encoder/decoder/store under 12-ATOMSMASHER/<module>/, gateway routes under 06-ORANGELLM/server/routes/atomsmasher-<module>.mjs, smoke test.
Mom's Law: real code, honest gaps, no theater.
`

phase('Author')
const modules = [
  { id: 'persist', prompt: `Author the Commitment Atoms persist layer (sibling to encoder.mjs). Path: ${ROOT}/12-ATOMSMASHER/commitment-atoms/persist.mjs. Wraps encoder.encodeCommitmentAtom + store.createAtom + writes audit receipt to 10-RECEIPTS/. Exposes single persist({kind, body, ...}) that does the full chain. ${CTX}` },
  { id: 'air-codec', prompt: `Author AIR Codec at ${ROOT}/12-ATOMSMASHER/air-codec/{codec.mjs, smoke-test.mjs, README.md}. Compresses verbose model output to dense info per byte by extracting structure (facts, claims, citations) and dropping filler. Schema at ${ROOT}/09-SCHEMAS/air-frame.v0.schema.json. Gateway route at ${ROOT}/06-ORANGELLM/server/routes/atomsmasher-air.mjs (POST /v1/atomsmasher/air/compress + decompress). ${CTX}` },
  { id: 'equation-store', prompt: `Author EquationStore at ${ROOT}/12-ATOMSMASHER/equation-store/{store.mjs, equations.json, smoke-test.mjs, README.md}. Stores formal equations/invariants the system enforces. Seed with: FOUNDER_SALARY_PER_INSTALL_CENTS = X (operator value via env), Gate-0 LBCE invariant, 27 guardrails count, Mom's Law meta-invariant. Gateway: GET /v1/atomsmasher/equations + POST to add (operator-gated). ${CTX}` },
  { id: 'cartridges', prompt: `Author Cartridges at ${ROOT}/12-ATOMSMASHER/cartridges/{loader.mjs, registry.json, smoke-test.mjs, README.md}. Pre-compiled domain capability units; each cartridge = {name, version, capabilities[], system_prompt, tool_cards[]}. Examples seed: orange5-doctrine, ae-cobra-memory, orangeeye-visual. Hot-swappable. Gateway POST /v1/atomsmasher/cartridges/load. ${CTX}` },
  { id: 'sparse-worksets', prompt: `Author Sparse Worksets at ${ROOT}/12-ATOMSMASHER/sparse-worksets/{compressor.mjs, smoke-test.mjs, README.md}. Given a task + full context, compresses to the minimum needed working set. Returns {working_set, dropped, compression_ratio}. ${CTX}` },
  { id: 'least-action-router', prompt: `Author Least-action Router at ${ROOT}/12-ATOMSMASHER/least-action/{router.mjs, smoke-test.mjs, README.md}. Picks minimum-energy path through model superstack per request: reflex (Smart Skinny) vs heavy (OrangeLLM-fatty) vs frontier (BYO). Uses (intent_complexity, risk_level, latency_budget) as inputs. ${CTX}` },
  { id: 'expansion-warrants', prompt: `Author Expansion Warrants at ${ROOT}/12-ATOMSMASHER/expansion-warrants/{warrants.mjs, smoke-test.mjs, README.md}. Operator-gated scope-expansion authorization tokens. Each warrant = {id, scope_from, scope_to, operator_signature, expires_at, used_count, max_uses}. Gateway POST /v1/atomsmasher/warrants/{create,consume}. ${CTX}` },
  { id: 'compression-debt-ledger', prompt: `Author Compression Debt Ledger at ${ROOT}/12-ATOMSMASHER/compression-debt/{ledger.mjs, smoke-test.mjs, README.md}. Tracks every time the system chose verbose over compressed; SQLite-backed. Pays debt when re-execution finds the compression. Gateway GET /v1/atomsmasher/compression-debt. ${CTX}` },
  { id: 'saved-work-certs', prompt: `Author Saved Work Certificates at ${ROOT}/12-ATOMSMASHER/saved-work/{certs.mjs, smoke-test.mjs, README.md}. Proves a piece of work was done + reusable. Cert = {id, work_hash, output_hash, signature_chain, references_receipt[]}. Gateway POST /v1/atomsmasher/certs/{mint,verify,redeem}. ${CTX}` },
  { id: 'canon-pressure-detector', prompt: `Author Canon Pressure Detector at ${ROOT}/12-ATOMSMASHER/canon-pressure/{detector.mjs, smoke-test.mjs, README.md}. Detects when an ontology candidate has ≥5 receipts referencing it across ≥2 missions OR explicit operator promotion. Surfaces promotion candidates for AE7 review. ${CTX}` },
  { id: 'pathwave-compressor', prompt: `Author Pathwave Compressor at ${ROOT}/12-ATOMSMASHER/pathwave/{compressor.mjs, smoke-test.mjs, README.md}. Compresses execution trajectories (sequence of orange.order.v1 → action → orange.report.v1 → receipt) into a Pathwave for replay/comparison. Schema at 09-SCHEMAS/pathwave.v0.schema.json. ${CTX}` },
]
const results = await parallel(modules.map(m => () => agent(m.prompt, { phase: 'Author', label: `atm:${m.id}`, schema: SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-atomsmasher-eleven-modules-live.md. Modules: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH, effort: 'high' })
return { status: synth?.status || 'unknown', modules: results.filter(Boolean), synth }
