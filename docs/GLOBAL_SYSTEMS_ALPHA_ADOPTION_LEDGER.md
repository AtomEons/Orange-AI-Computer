# Global Systems Alpha Adoption Ledger

**Ledger state:** `RESEARCH_ARCHIVE`  
**Review date:** 2026-08-28  
**Operational adoptions authorized here:** none

This ledger reduces the completed systems research to bounded alpha decisions
for Æ Orange AI Computer. `ADOPT_*` admits only the named experiment or invariant to a proof
queue. It does not mean `OPERATIONAL`, permit production wiring, or satisfy the
[operational law](../system/00-CHARTER/ORANGE5_OPERATIONAL_LAW.md). `ARCHIVE_*` means do
not implement until its stated reopening condition is met.

## Claim Discipline

- **FACT** is directly supported by a cited source, current code, a receipt, or
  a named probe. Its scope is no broader than that evidence.
- **INFERENCE** is the Orange-specific conclusion drawn from facts. It remains
  defeasible.
- **CANDIDATE** is a proposed mechanism. It has no runtime authority until its
  smallest proof passes and a separate promotion record is accepted.
- A passing unit test, process start, health response, or hash chain is bounded
  evidence, not universal green. No exact-path alpha adoption receipt was found
  for any candidate below.
- Citations identify prior work; they do not assign sole invention credit or
  transfer ownership, endorsement, names, data, protocols, cultural knowledge,
  or community authority to Æ Orange AI Computer. No cultural analogy authorizes use.

## Decisions

### 1. AE Link Work Custody

- **FACT:** [AE Link](../system/03-BACKEND/ae-link/README.md) is an isolated,
  non-production TCP proof with authenticated frames, channel cursors, replay
  suppression, resume, and a disk journal. Its focused
  [test](../system/03-BACKEND/tests/ae-link.test.mjs) passed 8/8 on 2026-08-28.
- **INFERENCE:** Frame delivery and acknowledgement do not establish who owns
  accepted work, whether cancellation won a race, or whether an external effect
  happened exactly once.
- **CANDIDATE / mechanism:** Add a work-custody state machine keyed by work ID
  and owner epoch: `OFFERED -> PERSISTED -> STARTED -> TERMINAL`, with explicit
  cancel-before-start, cancel-during-run, retry, handoff, and orphan recovery
  semantics. Bind every transition to the journal and terminal outcome receipt.
- **Orange gap:** No reviewed exact-path receipt proves durable, idempotent work
  custody across an intermittent N150/Codexa link, process restart, and cancel
  race. Governed identity, key rotation, authorization, quotas, and production
  ownership are also outside the isolated proof.
- **Smallest falsifiable proof:** Run one write-once effector through two isolated
  processes; cut the link and crash each side at every custody transition, then
  issue cancellation both before and after `STARTED`.
- **Reject threshold:** Reject on one lost accepted item, duplicate external
  effect, execution after confirmed pre-start cancellation, multiple terminal
  states, ambiguous owner epoch, or transition without verifiable journal and
  receipt linkage.
- **Decision:** `ADOPT_FOR_ALPHA_PROOF` (queue rank 1).

### 2. Owicki-Gries Interference Freedom

- **FACT:** The Owicki-Gries method requires proving that one concurrent
  component's atomic actions do not invalidate assertions used by another
  component ([Owicki and Gries, 1976](https://doi.org/10.1007/BF00268134)).
  Orange has focused component tests, but no reviewed receipt proving this
  property across custody, leases, cancellation, retries, and receipt writers.
- **INFERENCE:** Individually valid state machines can still violate safety when
  their writes interleave.
- **CANDIDATE / mechanism:** Declare preconditions, postconditions, rely/guarantee
  conditions, and shared invariants for each custody transition; exhaustively
  explore bounded interleavings at every durable or externally visible write.
- **Orange gap:** No machine-checked noninterference proof covers two orders
  sharing a lease, idempotency key, journal, cancellation token, or receipt head.
- **Smallest falsifiable proof:** Enumerate all bounded interleavings of two
  orders and two writers around `PERSISTED`, `STARTED`, `CANCELLED`, effect commit,
  and receipt append; independently check custody and chain invariants.
- **Reject threshold:** Reject on one invariant violation, unreachable required
  terminal state, unbounded unexplored transition, nondeterministic replay, or a
  proof checker that shares the transition implementation it is checking.
- **Decision:** `ADOPT_FOR_ALPHA_PROOF` (queue rank 2).

### 3. Calibrated Cost Routing

- **FACT:** The current [least-action router](../system/06-ORANGELLM/router-least-action.mjs)
  uses static relative `est_cost` and nameplate latency values. Its
  [test](../system/06-ORANGELLM/tests/router-least-action.test.mjs) explicitly treats
  cost as a lookup outside the decision hash. Prior model-calibration research is
  documented by [Gladys West's Space Force biography](https://www.spaceforce.mil/Portals/2/Documents/Space_Pioneers/Space_Pioneers_Bios/SF_Space_Pioneers_Bio_West.pdf)
  and time-indexed prediction work by [Melba Roy Mouton's NASA teams](https://www.nasa.gov/wp-content/uploads/2015/10/goddardviewv13i1print.pdf).
- **INFERENCE:** Static nameplates can choose the wrong lane as host load, model
  quality, failure probability, and warm-state costs drift.
- **CANDIDATE / mechanism:** Predict a constrained outcome vector per eligible
  lane: wall time, compute time, failure probability, quality deficit, and
  reversible monetary cost. Retain residuals and uncertainty by host, model,
  workload class, and time epoch; never let cost override capability or safety.
- **Orange gap:** No reviewed receipt links route estimates to observed outcomes,
  calibration residuals, interval coverage, or a held-out incumbent bakeoff.
- **Smallest falsifiable proof:** Freeze 100 representative authorized tasks;
  train only on earlier outcomes, predict all lane outcomes, and compare chosen
  routes with the current static router on a later held-out block.
- **Reject threshold:** Reject on any new scope, capability, or refusal error;
  less than 10% lower held-out cost/latency MAE than the stronger baseline;
  nominal 90% interval coverage below 85%; worse verified quality-adjusted cost;
  or deletion of missing and failed outcomes from scoring.
- **Decision:** `ADOPT_FOR_ALPHA_PROOF_AFTER_OUTCOME_RECEIPTS` (queue rank 6).

### 4. Active Sensing

- **FACT:** The [AE Eyes photon doctrine](../system/00-CHARTER/AEYES1_PHOTON_INFERENCE_DOCTRINE_2026-07-08.md)
  lists active sensing as missing. Active perception treats sensing as a choice
  of the next measurement, not passive intake ([Bajcsy, 1988](https://doi.org/10.1109/5.5968)).
- **INFERENCE:** A bounded extra view can reduce ambiguity, but can also add
  latency, privacy exposure, actuator risk, and confirmation bias.
- **CANDIDATE / mechanism:** Select the authorized next measurement by expected
  uncertainty reduction per unit of cost and risk, with a hard action budget and
  an allowed-sensor manifest.
- **Orange gap:** No reviewed exact-path receipt proves that AE Eyes requests a
  measurement, records why, respects authority, and improves a held-out result.
- **Smallest falsifiable proof:** Use a deterministic rendered scene set with
  occlusions and two available views; compare one fixed view with one bounded
  candidate-selected view while recording uncertainty, action, and result.
- **Reject threshold:** Reject on one unauthorized measurement, hidden action,
  privacy-boundary crossing, less than 5 percentage-point error reduction, worse
  calibration, or more than 20% cost increase at equal verified quality.
- **Decision:** `ADOPT_FOR_AE_EYES_SANDBOX` (queue rank 10).

### 5. Scoped Evidence Lattice

- **FACT:** [Receipts and Audit](RECEIPTS_AND_AUDIT.md) defines evidence
  precedence and warns that hash integrity does not prove observation accuracy.
  Orange graph code represents `PROVES`, `REQUIRES`, `BLOCKED_BY`, `SUPERSEDES`,
  `APPROVED_BY`, and `OBSERVED_BY`; no reviewed receipt establishes algebraic
  merge semantics. Source-linked organizational memory has prior art in
  [Dieng-Kuntz and Corby](https://www-sop.inria.fr/acacia/pub/2005/iccs2005-dieng.pdf).
- **INFERENCE:** A total score can erase incomparability between evidence from
  different scopes, times, authorities, and runtime paths.
- **CANDIDATE / mechanism:** Represent evidence as typed, scoped nodes with an
  explicit partial order, contradiction edges, and deterministic joins. Call it
  a lattice only if every admitted pair has the required least upper bound and
  the implementation satisfies the lattice laws; otherwise retain an evidence
  poset.
- **Orange gap:** No reviewed proof shows deterministic, source-preserving joins
  for narrow success, broad failure, stale receipts, live probes, and unresolved
  contradictions.
- **Smallest falsifiable proof:** Property-test 50 frozen evidence fixtures under
  input permutation and repeated merge; independently check scope, freshness,
  authority, contradiction preservation, and the claimed algebraic laws.
- **Reject threshold:** Reject on one silent contradiction, source-edge loss,
  broad promotion from narrow evidence, non-idempotent result, unlawful
  order-dependent join, or claimed lattice pair without a unique valid join.
- **Decision:** `ADOPT_FOR_ALPHA_PROOF`; archive the word `lattice` if only the
  weaker poset is proven (queue rank 4).

### 6. Route Hysteresis

- **FACT:** The N150 fallback server has a local 60-second activation hysteresis,
  but no reviewed receipt proves route-cost hysteresis across ordinary model or
  host failover. Resilient topology and bounded convergence are documented in
  [Radia Perlman's prior work](https://www.invent.org/inductees/radia-perlman).
- **INFERENCE:** A router that reacts to noisy point estimates can oscillate,
  duplicate warm-up cost, and create split-brain custody.
- **CANDIDATE / mechanism:** Use separate enter/exit thresholds, minimum dwell,
  cooldown, monotonic route epochs, and emergency overrides whose cause appears
  in the decision receipt.
- **Orange gap:** No reviewed exact-path receipt proves bounded, loop-free
  failover and restoration using calibrated costs and live health samples.
- **Smallest falsifiable proof:** Replay one fixed noisy health/cost trace, remove
  and restore the preferred path, and compare no-hysteresis with candidate
  decisions under the same custody state.
- **Reject threshold:** Reject on one authority split, route loop, duplicate
  effect, more than one unnecessary switch, missed emergency failover, recovery
  beyond the declared bound, or a decision not reproducible from its samples.
- **Decision:** `ADOPT_AFTER_CALIBRATED_ROUTING` (queue rank 7).

### 7. Source / Representation Separation

- **FACT:** [Memory and Learning](MEMORY_AND_LEARNING.md) says indexes and
  compressed views are projections, never replacements for exact source. The
  selected [integrated receipt](../proof/2026-08-28T03-42-45-242Z-integrated-operational-proof.json)
  records 23/23 cases, MRR 0.9058, p50 281 ms, and p95 445 ms; it does not prove
  all corpora or projection rebuilds. Machine-independent exchange separation
  has provenance in the [Library of Congress MARC collection](https://findingaids.loc.gov/repositories/29/resources/6461).
- **INFERENCE:** Separation prevents an index, summary, embedding, or schema
  migration from silently becoming canonical only when exact rebuild and source
  hydration are tested.
- **CANDIDATE / mechanism:** Make immutable source identity, bytes/hash,
  authority, and retention independent of versioned representations. Preserve
  unknown fields and bind each projection to source and transform versions.
- **Orange gap:** No reviewed cross-plane proof round-trips source through two
  representation versions, deletes the derived index, rebuilds it, and verifies
  the same authorized evidence pointers and accepted answers.
- **Smallest falsifiable proof:** Round-trip 100 mixed-version records through
  `N -> N+1 -> N`, destroy only the derived index, rebuild from source, and replay
  frozen exact-identifier and semantic queries.
- **Reject threshold:** Reject on source mutation, unknown-field or character
  loss, hash/pointer mismatch, unrebuildable view, authority widening, or any
  accepted answer that cannot hydrate its exact source.
- **Decision:** `ADOPT_AS_ALPHA_INVARIANT` (queue rank 5).

### 8. Relevance Feedback

- **FACT:** Orange's bounded memory result evaluates lexical, dense, and hybrid
  retrieval, but the reviewed receipt does not evaluate explicit operator
  relevance feedback. Relevance-feedback evaluation is established in
  information retrieval ([Salton and Buckley, 1990](https://doi.org/10.1002/%28SICI%291097-4571%28199006%2941%3A4%3C288%3A%3AAID-ASI8%3E3.0.CO%3B2-H)).
- **INFERENCE:** Scoped judgments may improve retrieval, but implicit clicks or
  model self-labels can amplify position bias, poisoning, and stale preferences.
- **CANDIDATE / mechanism:** Accept explicit, attributable, project-scoped
  relevant/not-relevant judgments; update weights in shadow mode; retain the
  original query/result slate and provide exact rollback.
- **Orange gap:** No reviewed receipt proves a poisoning-resistant feedback loop,
  temporal holdout, per-project isolation, or reversible ranker update.
- **Smallest falsifiable proof:** Use 50 frozen queries with adjudicated labels;
  train feedback only on the earlier block and compare against the current hybrid
  ranker on the later block.
- **Reject threshold:** Reject on cross-project influence, exact-identifier recall
  loss, less than 2% nDCG@10 gain, hidden model-generated labels, non-replayable
  ranking, or rollback failing exact pre-update parity.
- **Decision:** `ADOPT_SHADOW_ONLY` (queue rank 8).

### 9. Recurrence Certificates

- **FACT:** Orange has Receipt-to-Reflex recurrence and counterexample gates, but
  no reviewed receipt proves generated recurrences with an independent checker.
  Algorithmic recurrence certification is documented in
  [Fasenmyer's line of work and A=B](https://www2.math.upenn.edu/~wilf/AeqB.pdf).
- **INFERENCE:** Certificates can replace costly repeated case checks only for a
  stable, formally bounded sequence family; otherwise they add a second proof
  system without reducing risk or cost.
- **CANDIDATE / mechanism:** Generate a recurrence, domain declaration, and base
  cases; verify them with a smaller independently implemented checker before
  accepting the compressed test result.
- **Orange gap:** No measured Orange test family has been shown to justify this
  machinery, and no independent checker receipt was found.
- **Smallest falsifiable proof:** Once triggered, select three deterministic
  sequence-style families, generate certificates, and compare independent checks
  with exhaustive bounded cases.
- **Reject threshold:** Reject on one false certificate, unsupported domain,
  shared generator/checker logic, nondeterministic check, or less than 30% net
  verification-time reduction after certificate checking.
- **Decision:** `ARCHIVE_PENDING_VALUE`; reopen only when one stable family
  consumes at least 30% of deterministic verification time in three measured
  runs.

### 10. Adaptive Baselines

- **FACT:** Current reviewed memory evidence is a fixed benchmark snapshot, and
  route cost inputs are static. Adaptive-window methods provide explicit drift
  detection rather than an arbitrary permanent window ([Bifet and Gavalda,
  2006](https://www.cs.upc.edu/~Gavalda/papers/adwin06.pdf)).
- **INFERENCE:** Updating a baseline can detect genuine drift, but can also
  normalize regressions or leak future data into evaluation.
- **CANDIDATE / mechanism:** Keep append-only observations and baseline epochs;
  run a bounded drift detector in shadow mode; open a new baseline only after an
  explicit change point, minimum sample count, and retained old-baseline score.
- **Orange gap:** No reviewed receipt proves controlled baseline adaptation,
  false-alarm bounds, no-lookahead evaluation, or immutable historical scoring.
- **Smallest falsifiable proof:** Compare fixed, rolling, and adaptive baselines
  on seeded stationary, abrupt-drift, gradual-drift, and recurring-regime streams,
  then replay one frozen Orange telemetry series.
- **Reject threshold:** Reject if stationary false alarms exceed 5%, seeded drift
  is missed or detected more than 20 samples late, future data affects a prior
  score, history is rewritten, or it fails to beat the stronger fixed/rolling
  baseline on predeclared loss.
- **Decision:** `ADOPT_SHADOW_ONLY` (queue rank 9).

### 11. Outcome Receipts

- **FACT:** [Receipts and Audit](RECEIPTS_AND_AUDIT.md) requires evidence that a
  named action reached a named result and explicitly says chain integrity does
  not prove the original observation correct.
- **INFERENCE:** An execution receipt is insufficient when the claimed outcome is
  an external state change, durable artifact, visual result, or remote effect.
- **CANDIDATE / mechanism:** Bind request, authorization, executor attestation,
  observed effect, independent verifier identity, artifact/state hashes,
  limitations, and one terminal outcome in a two-phase action/effect receipt.
- **Orange gap:** No reviewed cross-subsystem proof shows that false executor
  success, stale observations, partial writes, and verifier disagreement always
  prevent `PROVEN`.
- **Smallest falsifiable proof:** Inject those four failure modes into 30 isolated
  actions spanning file, process, HTTP, and artifact outcomes; compare reported
  state with an independent oracle.
- **Reject threshold:** Reject on one false `PROVEN`, unlinked effect, stale
  observation accepted as current, multiple terminal outcomes, verifier identity
  omission, or limitation not carried into the public claim.
- **Decision:** `ADOPT_FOR_ALPHA_PROOF` (queue rank 3).

### 12. Federated Registry

- **FACT:** Orange has a local model registry and a separate
  [read-mostly federation protocol](../system/04-CONTROL-PLANE/federation/README.md)
  that explicitly does not merge state, identity, authority, or receipt chains.
  Interface-governed multi-party operations have prior documented practice in a
  [NASA Mission Operations Working Group](https://ntrs.nasa.gov/api/citations/20150010989/downloads/20150010989.pdf?attachment=true).
- **INFERENCE:** A federated registry is safe only as verified claims about local
  artifacts and capabilities; it must not become remote execution authority,
  consensus, or a merged source of truth.
- **CANDIDATE / mechanism:** Exchange signed, content-addressed manifests with
  node identity, capability contract, artifact hash, evidence pointer, epoch,
  expiry, and revocation. Selection remains local; cross-receipts cite rather
  than import peer authority.
- **Orange gap:** No reviewed proof covers registry convergence, stale and
  revoked entries, conflicting manifests, artifact verification, or local policy
  dominance across a partition.
- **Smallest falsifiable proof:** After custody, evidence-order, and source/view
  proofs pass, run two loopback registries; partition them, rotate one artifact,
  revoke one capability, reconnect, and replay every selection decision.
- **Reject threshold:** Reject on selection of stale, revoked, or unverifiable
  capability; receipt-chain merge; remote authority gain; identity ambiguity;
  divergent post-convergence selection; or recovery beyond the declared bound.
- **Decision:** `ARCHIVE_DEPENDENT`; reopen only after queue ranks 1, 4, and 5
  pass with receipts.

## Ranked First-Proof Queue

| Rank | Proof | Dependency / exit evidence |
|---:|---|---|
| 1 | AE Link work custody | One terminal result and exactly-once effect across every injected cut, crash, and cancel race. |
| 2 | Owicki-Gries interference | Independent bounded-interleaving checker preserves custody and receipt invariants. |
| 3 | Outcome receipts | All seeded false-success paths refuse `PROVEN`. |
| 4 | Scoped evidence lattice/poset | Deterministic source-preserving joins pass property and contradiction fixtures. |
| 5 | Source / representation separation | Mixed-version round-trip and clean index rebuild preserve exact source authority. |
| 6 | Calibrated cost routing | Held-out calibrated predictions beat the stronger static baseline without safety loss. |
| 7 | Route hysteresis | No loop, split authority, duplicate effect, or excess flap on replayed failover traces. |
| 8 | Relevance feedback | Shadow update improves held-out nDCG without exact-ID or project-isolation regression. |
| 9 | Adaptive baselines | Shadow detector meets predeclared drift and false-alarm bounds without rewriting history. |
| 10 | Active sensing | Authorized second-view policy improves held-out error and calibration inside its cost budget. |

Not queued: recurrence certificates remain archived until measured repeat cost
triggers them; federated registry remains archived until custody, evidence
ordering, and source/representation separation are proven.
