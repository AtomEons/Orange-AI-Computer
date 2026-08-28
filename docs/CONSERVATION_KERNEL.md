# Conservation Kernel

The Conservation Kernel is the deterministic state-transition authority for AE Orange AI Computer. Models, agents, routers, tools, and user interfaces may propose transitions. They do not decide whether an invalid transition commits.

## Conserved Quantities

1. **Authority:** downstream components cannot manufacture authority.
2. **Custody:** every nonterminal order has one accountable owner and monotonic owner epochs.
3. **Evidence:** confidence cannot increase without new attributable evidence.
4. **Semantics:** objectives, commitments, constraints, forbidden actions, and acceptance criteria cannot drift during compression or delegation.
5. **Uncertainty:** uncertainty cannot decrease merely because a model produced an answer.

Transactions are either `COMMITTED` or `ROLLED_BACK`. A terminal outcome commits exactly once. Every decision and state is hash-chained on disk.

## Solar Wave Boundary

```text
INTAKE -> COMPILED -> ROUTED -> OFFERED -> PERSISTED
-> STARTED -> OBSERVED -> VERIFIED -> TERMINAL
```

Each Solar Wave transition carries its Conservation Kernel decision, semantic checksum, evidence, prediction, observation, residual, custody, and terminal status.

## Focused Proof

The active engineering root contains a focused invariant suite covering authority escalation, confidence inflation, uncertainty erasure, semantic drift, custody theft, exactly one terminal outcome, ledger hashes, and the complete Solar Wave lifecycle.

```text
bun test 03-BACKEND/tests/conservation-kernel.test.mjs
6 pass / 0 fail / 26 expectations
```

This focused proof does not claim whole-system release closure. It proves the exact kernel behavior named above.

## Source Paths

The public preview package does not yet include this Wave 3 development organ. Current engineering source:

- `C:\AtomEons\Orange5\03-BACKEND\conservation-kernel.mjs`
- `C:\AtomEons\Orange5\03-BACKEND\solar-wave.mjs`
- `C:\AtomEons\Orange5\03-BACKEND\spine-cli.mjs`
- `C:\AtomEons\Orange5\03-BACKEND\tests\conservation-kernel.test.mjs`

Promotion into the downloadable package requires the later exact-package lifecycle proof.
