# Æ Orange AI Computer AtomSmasher Production

AtomSmasher turns large project history into a small, source-backed operational
workbench. It reduces repeated reading and model context without reducing the
authority of cold source or receipt truth.

## Production Boundary

AtomSmasher has three distinct contracts:

| Contract | Requirement |
|---|---|
| Cold ledger | byte-exact, hash-verifiable, replayable truth |
| Operational view | compact commitments, structures, and source pointers |
| Model boundary | bounded task context with an explicit expansion path |

The canonical implementation is `12-ATOMSMASHER/full-scope`. Older module
directories remain useful primitives and cross-checks; they are not competing
complete engines.

## Work Pipeline

```text
source, upload, code, data, or tool result
-> ingest and coverage receipt
-> order and commitment extraction
-> AIR structural frames, equations, and residuals
-> exact, semantic, and runtime cache lookup
-> sparse task workset
-> least-action route
-> expansion warrant when evidence is insufficient
-> answer, build, or action
-> saved-work certificate
-> compression-debt and learning receipts
```

Commitment atoms preserve decisions with continuing force. AIR frames preserve
structure. Equations and residuals represent regular numeric material without
hiding exceptions. Cartridges preserve reusable domain state. Sparse worksets
hold the current task neighborhood. Expansion warrants authorize more context
when the compact workbench cannot support a safe answer.

## Truth And Compression

Operational compression is not deletion. Exact source remains addressable, and
consequential claims must retain source pointers. When compact state causes a
miss, wrong recall, repeated hydration, or downstream rework, record compression
debt and add the case to evaluation.

Never quote one ratio without its contract. Byte compression of a receipt-shaped
corpus, operational workbench reduction, and live model-context reduction use
different denominators and answer different questions.

## Current Bounded Evidence

The accepted Context Crystal held-out suite used 794 sources totaling 7,056,795
bytes across five cases. All 5/5 cases preserved required answer material and
source-pointer checks. The measured operational context ratio ranged from
`1,422.901x` to `1,445.487x`.

That result is workload-specific. It is not a universal codec ratio, an arbitrary
prompt guarantee, or permission to discard the source corpus.

## Production Gates

1. Ingest coverage identifies every expected source.
2. Cold truth remains immutable and hash-checkable.
3. Workbench outputs retain exact source pointers.
4. Held-out answer parity and pointer verification pass together.
5. Ratios name their workload and denominator.
6. Concurrency and restart behavior preserve writes and replay.
7. Compression debt remains visible.
8. Rollback can restore the prior incumbent and workbench behavior.

## Operate And Verify

```powershell
Set-Location .\system
bun run test:atomsmasher
bun run bench:context-crystal-quality
bun run atomsmasher -- --help
```

Use a disposable database for exploratory CLI work. Review emitted case records,
source hashes, reconstruction checks, and receipt hashes before promoting a
result.

## Failure Rules

- Missing source pointer: hydrate exact source and keep the workbench unproven.
- Ratio regression: inspect denominator, source coverage, and task parity before
  tuning compression.
- Wrong commitment: preserve the contradiction, correct from higher evidence,
  and add a held-out case.
- Concurrent write loss: stop promotion; a fast partial ledger is not production.
- Stale cache hit: invalidate by source identity and record the mismatch.

## Related Guides

- [Memory and Learning](MEMORY_AND_LEARNING.md)
- [Receipts and Audit](RECEIPTS_AND_AUDIT.md)
- [Technical Architecture](TECHNICAL_ARCHITECTURE.md)
- [Proof and Benchmarks](PROOF_AND_BENCHMARKS.md)
