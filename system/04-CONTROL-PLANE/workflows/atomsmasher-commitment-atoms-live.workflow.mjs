// atomsmasher-commitment-atoms-live.workflow.mjs
// Promote the first AtomSmasher module — Commitment Atoms — from STUB to LIVE.
// Anti-fluff Gate (the only currently-LIVE module) stays untouched.

export const meta = {
  name: 'atomsmasher-commitment-atoms-live',
  description: 'Promote AtomSmasher Commitment Atoms module from STUB to LIVE',
  phases: [
    { title: 'Author', detail: '5 parallel — schema, encoder, decoder, store, gateway routes' },
    { title: 'Synth',  detail: 'promotion receipt + smoke test' },
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
    promotion_status: { enum: ['STUB_TO_LIVE_PROMOTED', 'PARTIAL', 'BLOCKED'] },
    receipt_path: { type: 'string' },
    files_landed: { type: 'integer' },
    open_issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['promotion_status', 'receipt_path', 'files_landed', 'open_issues'],
  additionalProperties: false,
}

const CONTEXT = `
AtomSmasher doctrine (12 modules total; only Anti-fluff Gate is LIVE today):
- Commitment Atoms: smallest unit of operator-or-system-promise. Compresses a decision / commitment / lock-in into a deterministic, hash-chained, verifiable atom.
- Each atom has: id, kind (decision|promise|invariant|deadline|threshold), body (typed payload), preconditions (atom_ids[]), supersedes (atom_ids[]), evidence (receipt_path[]), signature_chain (sha256 chain), expires_at (ISO|null), status (active|fulfilled|revoked|superseded).
- Atoms persist as JSONL records in Reality lane via Æ Cobra Flux writer (origin='atomsmasher', kind='commitment') AND in a SQLite index for fast queries.
- Mom's Law application: an atom that says "OrangeLLM-fatty is the only trained brain — Smart Skinny LoRA retired" cannot be "edited" — only superseded by a new atom whose 'supersedes' includes the old atom's id.

Existing infrastructure:
- Æ Cobra Flux writer at 06-ORANGELLM/memory/ae-cobra/flux/writer.mjs
- Schema dir at 09-SCHEMAS/
- Gateway routes dir at 06-ORANGELLM/server/routes/
- Anti-fluff Gate (the only LIVE AtomSmasher) at 12-ATOMSMASHER/anti-fluff-gate/ (read it for the LIVE module pattern)

Quality bar:
- Real executable Node 20+ code
- Honest README per file
- Error handling
- The Anti-fluff Gate is the reference for "what LIVE looks like" — match its discipline
`

phase('Author')

const components = [
  {
    id: 'schema',
    prompt: `Author the Commitment Atom JSON Schema.

Write to ${ROOT}/09-SCHEMAS/commitment-atom.v0.schema.json.
Spec: orange5.commitment-atom.v0. Required fields: schema, atom_id (sha256 hex), kind (enum), body (object), preconditions (string[]), supersedes (string[]), evidence (string[] paths), signature (object {prev_hash, hash}), status (enum), created_at, sovereign (Atom McCree), actor (string).

Strict JSON Schema (draft 2020-12). additionalProperties: false. Enums explicit. minLengths/patterns where they matter.

${CONTEXT}`,
  },
  {
    id: 'encoder',
    prompt: `Author the encoder that turns an Orange5 decision/promise into a Commitment Atom.

Write to ${ROOT}/12-ATOMSMASHER/commitment-atoms/encoder.mjs.

Exports encodeCommitmentAtom({kind, body, preconditions=[], supersedes=[], evidence=[], actor, expires_at=null, prevHash}). Computes atom_id = sha256(canonical body+kind+preconditions+supersedes), composes signature = {prev_hash: prevHash, hash: sha256(canonical_atom)}. Returns the atom object.

Add validator validateCommitmentAtom(atom) that checks against the JSON Schema (use Ajv from the existing 04-CONTROL-PLANE deps or inline a fast validator). Returns {valid, errors}.

Anti-fluff: reject atoms whose body contains forbidden words (green_assumed, looks_ok, probably, should_work). Reject atoms whose evidence array is empty for kind='invariant' OR 'promise'.

${CONTEXT}`,
  },
  {
    id: 'decoder',
    prompt: `Author the decoder that re-expands a Commitment Atom for human audit + chain traversal.

Write to ${ROOT}/12-ATOMSMASHER/commitment-atoms/decoder.mjs.

Exports:
- decodeCommitmentAtom(atom) — returns human-readable Markdown of the atom: title from kind+body, preconditions resolved (look up each id in the atom store), evidence links, signature chain, status, supersedes-graph.
- traverseChain(atomId, atomStore) — BFS over preconditions and supersedes to surface the full provenance chain for an atom. Returns {atom, preconditions_resolved: [{id, kind, summary}], supersedes_chain: [...]}.

${CONTEXT}`,
  },
  {
    id: 'store',
    prompt: `Author the storage backend that persists Commitment Atoms to Reality-lane Flux + SQLite index.

Write to ${ROOT}/12-ATOMSMASHER/commitment-atoms/store.mjs.

Exports:
- createAtom(atom, {fluxRoot, dbPath}) — Validates via encoder.validateCommitmentAtom. If valid: writes via Æ Cobra writeFluxRecord(lane='reality', origin='atomsmasher', kind='commitment', body=atom). Inserts row into SQLite at dbPath (06-ORANGELLM/memory/commitment-atoms.db). Returns {ok, atom_id, flux_record_hash}.
- getAtom(atomId, {dbPath}) — SELECT by atom_id. Returns the atom.
- listAtoms({kind, status, since, dbPath}) — Filter query.
- revokeAtom(atomId, supersededByAtomId, {fluxRoot, dbPath}) — Marks status='superseded', creates a revocation event in Flux, updates SQLite.

SQLite schema: CREATE TABLE atoms (atom_id TEXT PRIMARY KEY, kind TEXT, status TEXT, body_json TEXT, prev_hash TEXT, hash TEXT, created_at TEXT, actor TEXT, evidence_json TEXT, supersedes_json TEXT, preconditions_json TEXT). Index on (kind, status, created_at).

${CONTEXT}`,
  },
  {
    id: 'gateway-routes',
    prompt: `Author the gateway /v1/atomsmasher/atoms/* routes.

Write to ${ROOT}/06-ORANGELLM/server/routes/atomsmasher.mjs.

Exports registerAtomSmasherRoutes(server). Routes:
- POST /v1/atomsmasher/atoms — body {kind, body, preconditions, supersedes, evidence, actor, expires_at}. Calls encoder.encodeCommitmentAtom + store.createAtom. Returns {atom_id, hash}.
- GET /v1/atomsmasher/atoms/:atom_id — returns atom + decoded chain summary.
- GET /v1/atomsmasher/atoms?kind=&status=&since= — list query.
- POST /v1/atomsmasher/atoms/:atom_id/revoke — body {superseded_by, reason}. Calls store.revokeAtom.
- GET /v1/atomsmasher/atoms/:atom_id/chain — returns full provenance chain via traverseChain.

Plus update the gateway boundary middleware allow-list to include /v1/atomsmasher/atoms/*. Write the splice file at 06-ORANGELLM/server/routes/atomsmasher-boundary.mjs that exports the additional paths.

Also write the smoke test at ${ROOT}/12-ATOMSMASHER/commitment-atoms/smoke-test.mjs that creates 3 atoms (a decision, an invariant, a promise), revokes one, lists, queries the chain, and asserts hash chain integrity.

${CONTEXT}`,
  },
]

log(`Fanning out ${components.length} AtomSmasher component authors in parallel.`)

const results = await parallel(
  components.map(c => () => agent(c.prompt, { phase: 'Author', label: `atom:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' }))
)

phase('Synth')

const synth = await agent(
  `Synthesize the AtomSmasher Commitment Atoms promotion from STUB to LIVE.

Author results:
${JSON.stringify(results.filter(Boolean), null, 2)}

Write the promotion receipt to ${ROOT}/10-RECEIPTS/orange5-build/2026-06-24-atomsmasher-commitment-atoms-live.md.

Required:
- Receipt ID, generated_at, schema (orange5.receipt.v0), actor, status (ATOMSMASHER_COMMITMENT_ATOMS_PROMOTED_STUB_TO_LIVE), confidence
- prior_receipt: read most recent receipt from ${ROOT}/10-RECEIPTS/orange5-build/, hash_chain = prior + 1
- Component table with files + line counts
- Endpoint inventory: POST /v1/atomsmasher/atoms, GET .../:id, GET ?filters, POST .../revoke, GET .../chain
- Honest "what this does NOT do yet": no cross-machine atom sync, no atom signing with hardware keys, no automatic supersession detection, no GUI for viewing atoms
- Mom's Law alignment
- Hash chain footer

Return via StructuredOutput.`,
  { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' }
)

return { status: synth?.promotion_status || 'unknown', components: results.filter(Boolean), synth }
