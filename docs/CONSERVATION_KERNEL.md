# Æ Orange AI Computer Conservation Kernel

The Conservation Kernel source implements deterministic checks for state
transitions. Models, agents, routers, tools, and interfaces may propose a
transition; they do not decide whether an invalid transition commits.

## Conserved Quantities

1. **Authority:** downstream components cannot manufacture authority.
2. **Custody:** every nonterminal order has one accountable owner and monotonic
   owner epochs.
3. **Evidence:** confidence cannot increase without new attributable evidence.
4. **Semantics:** objectives, commitments, constraints, forbidden actions, and
   acceptance criteria cannot drift during compression or delegation.
5. **Uncertainty:** uncertainty cannot decrease merely because a model returned
   an answer.

Transactions are designed to finish as `COMMITTED` or `ROLLED_BACK`, with one
terminal result and hash-chained decisions.

## Source And Proof Boundary

Current source is present at:

- `system/03-BACKEND/conservation-kernel.mjs`
- `system/03-BACKEND/solar-wave.mjs`
- `system/03-BACKEND/spine-cli.mjs`
- `system/03-BACKEND/tests/conservation-kernel.test.mjs`

The internal `solar-wave.mjs` filename is retained because it is an exact source
identifier, not a public release label.

The focused source test command is:

```powershell
Set-Location .\system
bun test 03-BACKEND/tests/conservation-kernel.test.mjs
```

An earlier recorded run reported 6 passing tests and 26 expectations for the
focused invariant suite. No selected receipt for that run is published under
the root `proof/` directory. Treat the kernel as current source with focused
test history, not as a separately promoted runtime organ or package claim.

The historical deploy ZIP predates this current source. A future package must
earn a new content lock and lifecycle proof before it can claim to include the
kernel.
