# Commitment Atoms — encoder

AtomSmasher module #1 (of 12). **Status: encoder LIVE, persistence + index +
gateway routes still PENDING in sibling files.**

## What this file is

`encoder.mjs` is the pure, dependency-free encoder + validator for a single
**Commitment Atom** — the smallest unit of operator-or-system promise inside
Orange5. An atom compresses a decision / commitment / invariant / deadline /
threshold into a deterministic, content-addressed, hash-chained record.

This module **does not** write to Æ Cobra Flux, **does not** touch SQLite, and
**does not** expose a gateway route. Those land in sibling files so the
encoder stays unit-testable in isolation.

## Doctrine (binding)

1. **Atoms are append-only.** An atom is never edited. To change a commitment,
   issue a new atom whose `supersedes` array contains the prior atom's
   `atom_id`. The old atom's `status` then transitions to `superseded` via the
   indexer, not via mutation.
2. **`atom_id` is content-derived.** `sha256(canonical({kind, body,
   preconditions, supersedes}))`. Two callers committing the same content
   arrive at the same id. This is intentional — duplicate commitments collide,
   which is correct.
3. **`signature.hash` is the per-atom seal.** `sha256(canonical_atom)` with
   `signature.hash` blanked out during the hash. This mirrors Æ Cobra Flux's
   self-hashing convention so the verifier code shape is identical.
4. **`signature.prev_hash` is the per-atom causal chain.** Pass the previous
   atom's `signature.hash` (or `'GENESIS'` for the first atom). The Flux lane
   the atom is written into carries its OWN audit chain; that is separate.
5. **Anti-fluff is a HARD reject, not a warning.** Bodies containing
   `green_assumed`, `looks_ok`, `probably`, or `should_work` cannot become
   atoms. Atoms of kind `invariant` or `promise` MUST carry at least one
   evidence pointer.

## API

```js
import {
  encodeCommitmentAtom,
  validateCommitmentAtom,
  COMMITMENT_ATOM_SCHEMA,
  VALID_KINDS,
  VALID_STATUSES,
} from './encoder.mjs';
```

### `encodeCommitmentAtom({...})`

| arg            | type                                                    | required | default        |
| -------------- | ------------------------------------------------------- | -------- | -------------- |
| `kind`         | `'decision'\|'promise'\|'invariant'\|'deadline'\|'threshold'` | yes      | —              |
| `body`         | plain object                                            | yes      | —              |
| `preconditions`| `string[]` (atom_ids)                                   | no       | `[]`           |
| `supersedes`   | `string[]` (atom_ids)                                   | no       | `[]`           |
| `evidence`     | `string[]` (receipt paths or ids)                       | no       | `[]`           |
| `actor`        | non-empty string (e.g. `operator:atom`, `system:orangellm`) | yes  | —              |
| `expires_at`   | ISO 8601 string or `null`                               | no       | `null`         |
| `prevHash`     | string — prior atom's `signature.hash` or `'GENESIS'`   | yes      | —              |
| `ts`           | unix ms (test override)                                 | no       | `Date.now()`   |

Returns the atom object. Throws on invalid input or anti-fluff hit.

### `validateCommitmentAtom(atom)`

Returns `{ valid: boolean, errors: string[] }`. Re-derives `atom_id` and
`signature.hash` and fails on mismatch, so tampering is caught.

### `COMMITMENT_ATOM_SCHEMA`

The JSON Schema (draft 2020-12) for the atom shape. Exported so downstream
consumers can plug it into Ajv themselves if they want. The inline validator
in this file enforces the same rules without an Ajv dependency.

## Example

```js
const atom = encodeCommitmentAtom({
  kind: 'decision',
  body: {
    statement:
      'OrangeLLM-fatty is the only trained brain. Smart Skinny LoRA retired.',
    rationale: 'Smart Skinny failed three consecutive evals; consolidation reduces drift.',
  },
  evidence: ['receipts/2026-06-24/orangellm-eval-001.json'],
  actor: 'operator:atom',
  prevHash: 'GENESIS',
});

console.log(atom.atom_id);            // 64-char sha256
console.log(atom.signature.hash);     // 64-char sha256
console.log(atom.status);             // 'active'

const { valid, errors } = validateCommitmentAtom(atom);
// valid === true, errors === []
```

To supersede that decision later:

```js
const next = encodeCommitmentAtom({
  kind: 'decision',
  body: { statement: 'OrangeLLM-fatty retired in favor of OrangeLLM-fatty-v2.' },
  supersedes: [atom.atom_id],
  evidence: ['receipts/2026-09-01/orangellm-fatty-v2-eval-001.json'],
  actor: 'operator:atom',
  prevHash: atom.signature.hash,
});
```

## What's NOT in this file (yet)

- Persistence — sibling `persist.mjs` (PENDING) will call `writeFluxRecord({
  lane: 'reality', origin: 'atomsmasher', kind: 'commitment', body: atom })`.
- SQLite index — sibling `index.mjs` (PENDING) for fast queries by kind,
  status, actor, expires_at, supersedes-graph.
- Gateway route — `06-ORANGELLM/server/routes/commitment-atoms.mjs` (PENDING).
- Supersede status transitions — when a new atom names old atoms in
  `supersedes`, the indexer flips their `status` to `superseded`. The encoder
  never mutates anything.

## Why no Ajv

The Anti-fluff Gate sibling is zero-dep. This module matches that discipline.
The schema object is exported so any caller that already has Ajv loaded (e.g.
the control plane) can use it; the inline validator covers the rest.

## Test surface (minimum)

The encoder is built to support these test cases:

1. Round-trip: `encode(...)` → `validate(...)` returns `{valid: true}`.
2. Determinism: identical inputs produce identical `atom_id`.
3. Order independence: `{a:1, b:2}` and `{b:2, a:1}` bodies hash equal.
4. Tamper detection: mutating any field after encode fails validation.
5. Anti-fluff: `body: { note: 'should_work' }` throws on encode.
6. Evidence required: `kind: 'invariant'` with `evidence: []` throws.
7. Supersede chain: second atom's `signature.prev_hash` equals first atom's
   `signature.hash`.
