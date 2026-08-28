# EquationStore — AtomSmasher module #2

Store of formal equations and invariants that the AtomEons system
**enforces**. Each equation is a small, named, mathematical or logical
statement that an audit, a gate, a payout, or a release check is
supposed to honor. The EquationStore is what makes _"we enforce X"_
auditable instead of folkloric.

If a release check thinks it enforces `FOUNDER_SALARY`, the equation
it claims to enforce must exist **here**, with a sha256 id, with a
timestamp, with a known sovereign. The check can prove which equation
it just verified by quoting the id back to the auditor.

## Status

LIVE (per PR-15-SPEC pattern). 13 smoke-test groups, ~70 assertions,
green from a clean checkout via:

```
node 12-ATOMSMASHER/equation-store/smoke-test.mjs
```

The smoke test is hermetic — it builds and tears down a temp store
under the OS tmp dir; the seed file at `equations.json` is the only
source-controlled state.

## Canonical seeds

The seed list at `equations.json` registers the four equations the
operator has named as in-force at module birth:

| Name                                | Kind        | What it pins                                                                                       |
| ----------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `FOUNDER_SALARY_PER_INSTALL_CENTS`  | numeric     | Founder salary per install, USD cents. RHS is the env var `ATOMEONS_FOUNDER_SALARY_PER_INSTALL_CENTS`; the exact value is **operator-set**, never hardcoded. |
| `GATE_0_LBCE`                       | structural  | Gate 0 of every gate chain MUST be the `LatticeIntegrityGate` (LBCE). Gate-chain construction code in violation must fail release. |
| `GUARDRAILS_COUNT`                  | count       | Exactly 27 constitutional guardrails preserved. Drift audit fails on miscount or unauthorized swap.|
| `MOMS_LAW`                          | meta        | Give full effort every time. Sits **above** every other rule; on conflict, Mom's Law wins.         |

The numeric `FOUNDER_SALARY_PER_INSTALL_CENTS` equation registers the
**contract** that such a value exists, is operator-set, and is enforced
by the payout subsystem. It deliberately does **not** include a literal
amount; the literal is read at runtime from the env. This matches the
project-constitution rule "operator value via env, never hardcoded."

## Files

- `store.mjs` — encoder, validator, JSONL-backed file store with
  in-memory index, append-only with supersedes cascade, chain
  verification, operator-gated `addEquation`.
- `equations.json` — canonical seed list of four equation drafts.
- `smoke-test.mjs` — hermetic end-to-end smoke (see "Status" above).
- `README.md` — this file.

## Pattern alignment

This module follows the LIVE Anti-fluff Gate + Commitment Atoms pattern:

| Concern          | Anti-fluff Gate                              | Commitment Atoms                                                 | EquationStore                                                          |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Content address  | (no — judgments are derived)                 | `atom_id` = sha256(canonical slots + prev_hash)                  | `equation_id` = sha256(canonical slots + prev_hash)                    |
| Append-only      | (n/a)                                        | Yes; revoke flips status only                                    | Yes; retire flips status only                                          |
| Hash chain       | (n/a)                                        | `signature.prev_hash` → previous atom                            | `signature.prev_hash` → previous equation                              |
| Persistence      | (pure)                                       | Flux JSONL + SQLite index                                        | JSONL + in-memory index + head sidecar                                 |
| Tamper detection | (pure)                                       | `validateCommitmentAtom` recomputes id                            | `validateEquation` recomputes id + signature                           |
| Smoke test       | bundled                                      | bundled                                                          | bundled (13 groups)                                                    |

The choice to use a JSONL file rather than SQLite (which Commitment
Atoms uses) is deliberate: the EquationStore has **dozens** of entries
on any given day, not thousands. The append-only file + in-memory
index is honest about scale, has zero external runtime deps beyond
`node:fs/node:crypto`, and survives a process restart by reading the
JSONL back. SQLite is overkill for ten-to-low-hundreds of rows that
get queried by name.

## Gateway

The gateway file at
`06-ORANGELLM/server/routes/atomsmasher-equations.mjs` is **OUT OF
SCOPE for this PR** — explicitly, per the workflow brief that asked
only for the four files under `12-ATOMSMASHER/equation-store/`. The
shape the gateway must register, with operator-gated writes, is:

```
GET   /v1/atomsmasher/equations
GET   /v1/atomsmasher/equations?kind=&status=&enforces=&since=
GET   /v1/atomsmasher/equations/:equation_id
GET   /v1/atomsmasher/equations/by-name/:name
GET   /v1/atomsmasher/equations/chain          → { head, length, verify_ok }
POST  /v1/atomsmasher/equations                → mint new equation
                                                  (operator-gated; rejects
                                                   any sovereign != configured
                                                   operator identity)
POST  /v1/atomsmasher/equations/:equation_id/retire
                                               → flip active -> retired
```

The store's `addEquation({ operator })` parameter is the floor of the
operator gate; the gateway layer adds the auth wall above it.

Schema registration in `09-SCHEMAS/equation.v0.schema.json` is also out
of scope for this PR; the in-code validator in `store.mjs` is the
runtime gate, the JSON-Schema file would be a publishable
contract-document for downstream consumers.

## Equation kinds

| Kind         | When to use                                                                                          | Body fields beyond the universal set                  |
| ------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `numeric`    | A formula or numeric equality/inequality the system enforces (`FOUNDER_SALARY = X`).                  | `lhs`, `op` (`=`/`==`/`>=`/`<=`/`>`/`<`/`!=`), `rhs`, optional `value_expr` |
| `structural` | An always-true statement about system shape (`Gate 0 is LatticeIntegrityGate`).                       | `params` carry the structural assertion               |
| `count`      | Exactly-N invariants (`27 constitutional guardrails`).                                                | `count` (non-negative int), `subject` (non-empty string)|
| `relational` | A relationship between two named things (`runtime/node.py is the sole authoritative cognitive center`). | `params` describe the relation                        |
| `meta`       | A rule that governs other rules, with override authority on conflict (`Mom's Law`).                   | `params` describe scope and override behavior         |

## Doctrinal binds (the part that matters)

1. **Append-only.** An equation cannot be edited in place. To change
   one, mint a new equation that names the old one in `supersedes`.
   The store cascades `status='superseded'` on the prior; the body of
   the prior remains untouched as a historical artifact.
2. **Hash-chained.** Each equation's `signature.prev_hash` MUST point
   to the previous equation's `signature.hash`. The store refuses any
   write whose `prev_hash` does not match the current head — that
   prevents accidental forks from stale callers.
3. **Content-addressed.** `equation_id` is sha256 over the canonical
   JSON of the body slots **plus** `prev_hash`. Tampering with any
   slot — including `statement`, `enforces`, or `params` — breaks
   integrity and `validateEquation` reports it.
4. **Operator-gated.** New equations require `sovereign` to match the
   configured operator identity (`atom-mccree` for the seed). The
   gateway layer adds an auth wall above this floor.
5. **Mom's Law applies.** No silent successes, no theatrical 200s.
   The store returns structured `{ ok: false, error, errors? }` on
   every failure path. Honest gaps are named in this README (gateway
   file out of scope; schema-file out of scope).

## Honest gaps in this PR

- Gateway route file at `06-ORANGELLM/server/routes/atomsmasher-equations.mjs`
  is **not** in this PR. Shape is documented above; wiring belongs in
  the gateway PR that also extends the boundary allow-list.
- JSON-Schema file at `09-SCHEMAS/equation.v0.schema.json` is **not**
  in this PR. The in-code validator in `store.mjs` is the runtime gate.
- The decoder module pattern Commitment Atoms uses (markdown rendering
  of an atom) is not needed yet for equations — `getEquation` returns
  the structured object and the gateway's `GET` route is the human
  surface. Add a `decoder.mjs` if/when an audit-readable markdown view
  is required.
- The store does not currently emit Flux records on add/retire. If the
  EquationStore should ride the Reality lane the same way Commitment
  Atoms does, that adapter belongs in a follow-up — the JSONL on disk
  is already the audit chain.

## How to read the chain

```js
import { verifyChain, listEquations, getHead } from './store.mjs';

const head = getHead({ storeDir });
const { ok, length } = verifyChain({ storeDir });
const all = listEquations({ storeDir });
```

`verifyChain` walks the chain from genesis, recomputing every
`equation_id` and `signature.hash` and confirming every `prev_hash`
links to the previous record. It returns the index of the first
break, or ok:true with the chain length.
