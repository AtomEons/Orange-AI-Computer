# Compression Research Phase — PLAN

**Operator:** Atom McCree
**Status:** active research phase (project pivot 2026-06-26)
**Goal:** find the maximum lossless compression ratio for AtomSmasher 2 receipt-corpus data, then write a research paper with the methods and findings.
**Constraint:** lossless only (Mom's Law — receipts must be byte-exact reconstructable). Lossy is rejected.

## Starting point (verified at session pivot)

| Measurement | Ratio | Source |
|---|---|---|
| 4-weave compound (AIR → Crystal → Mesh → Brotli) | **278.51×** | receipt #073 |
| SQLite db brotli q11 | 11.02× | receipt #072 |
| Crystal CLC on receipt corpus alone | 8.93× | receipt #072 |
| Regeneration (derive-not-store) | 54.57× | receipt #074 |

The 278× was proven at the byte-level Shannon entropy floor by three convergent tests:
- Brotli at layer 4 = 1.00×
- Recursive pipeline pass = 1.00×
- Dictionary handoff +2% only

**To go higher requires changing the representation, not optimizing the algorithm.**

## Research grounding (added 2026-06-26 turn 2)

Operator supplied two heavy reference materials:

1. **Rieser, A. (2025).** "Grothendieck Topologies and Sheaf Theory for Data and Graphs: An Approach Through Čech Closure Spaces." arXiv:2109.13867v2. Cached at [data/rieser-sheaf-theory-2025.txt](data/rieser-sheaf-theory-2025.txt). Provides the formal framework for sheaves on graphs/digraphs/metric-scale spaces — exactly the algebraic structure of a receipt-DAG. Grounds Experiment 08.

2. **Fisher, A. & Brody, M.** "Celtic Knot Mathematics" — VisMath. https://www.mi.sanu.ac.rs/vismath/fisher/index.html. **Central theorem:** for a p×q plaitwork panel, the number of independent strand components = **gcd(p, q)**. Compression interpretation: the entire knot can be regenerated from 2-3 integers. Grounds Experiment 05 (wallpaper/plait).

## Research hypotheses (each becomes one experiment)

### Topological / structural patterns (from Celtic ornamental tradition)

1. **Knotwork / over-under braid encoding**
   - Multi-strand event flow (one strand per engine, crossings = handoffs)
   - Inspired by Celtic knotwork and braid groups B_n
   - Compress by recording strand positions + crossing sequence

2. **Annular key pattern (concentric frequency rings)**
   - High-frequency events → inner ring (short codes)
   - Low-frequency events → outer ring (verbatim)
   - Celtic annular key grids made explicit as entropy code

3. **Triskele recursive self-similarity (3-fold IFS)**
   - Detect self-similar substructures at 2/3/4-fold scales
   - Store the fixed-point + variance, regenerate the rest
   - Iterated Function Systems applied to event streams

4. **Wallpaper / frieze group symmetry detection**
   - Map action × time as a 2D grid
   - Detect which of 17 wallpaper groups best fits the periodicity
   - Encode only the fundamental domain + symmetry generators

5. **Knot polynomial / Reidemeister equivalence collapse**
   - Hash receipt segments by their topological signature
   - Two segments with identical Jones-polynomial-style invariant are equivalent
   - Dedupe equivalence classes (stronger than byte-identical dedup)

### Algorithmic / information-theoretic patterns

6. **Spike encoding (sparse binary event vectors)**
   - Inspired by spiking neural networks: most receipts are low-signal
   - Encode each as (action_bit, status_bit, payload_hash, ts_delta)
   - Arithmetic-code the resulting bitstream

7. **Cellular sheaf cohomology approximation**
   - Build sparse sheaf on receipt-DAG
   - Compute approximate harmonic kernel via Lanczos
   - Encode kernel + restriction maps (theoretical optimum)

8. **Determinism upgrade for regeneration mode**
   - Replace `crypto.randomUUID()` in nonce generation with seed-derived hashes
   - Re-measure regeneration ratio (currently 54.57× bounded by random nonces)
   - Expected: 500–2,200× regeneration ceiling

### Compound

9. **Celtic Weave compound pipeline**
   - Chain the winners from above with the existing 4-weave
   - Measure the full compound ratio
   - Targets: ≥ 1,000× practical, ≥ 10,000× theoretical

## Output deliverables

1. **Per-experiment artifact** at `experiments/<NN>-<name>/` containing:
   - `HYPOTHESIS.md` — what we predict, why
   - `METHOD.md` — exactly how to measure
   - `bench.mjs` — the benchmark script (runnable on a single command)
   - `RESULT.md` — measured ratio + honest analysis
   - `RECEIPT.json` — machine-readable result hash-chained to prior receipts

2. **Research log** at `RESEARCH_LOG.md` — chronological lab notebook, one entry per session

3. **Paper draft** at `paper/` — sections built up as findings stabilize

4. **Test corpus** at `data/` — single snapshot of organism receipts used across experiments for apples-to-apples comparison

## Discipline rules (Mom's Law applied to research)

- **Lossless only.** Receipts must be byte-exact reconstructable. Any lossy result is rejected.
- **Real measurements.** Every claimed ratio is a Bun script's actual output on the test corpus, with sha256 over both input and output.
- **Failed hypotheses get receipts too.** If a method only achieves 1.2×, that's the result — surface it honestly.
- **Reproduction commands written for every experiment.** A reader of the paper must be able to rerun.
- **No `Workflow` tool use.** Research is in-process, scriptable, reproducible.

## Phase plan

| Turn | Work |
|---|---|
| 1 (this turn) | Setup: directory tree, PLAN, RESEARCH_LOG, paper skeleton, generate canonical test corpus, Experiment 01 (spike encoding) |
| 2 | Experiments 02 (period detection), 03 (knot signature), 06 (annular key) — the three tractable algorithmic patterns |
| 3 | Experiments 04 (triskele IFS), 05 (wallpaper group), 07 (plait braid) — the Celtic geometric patterns |
| 4 | Experiment 08 (sheaf cohomology approximation) — the math-heavy one |
| 5 | Experiment 09 (determinism upgrade) + retest regeneration |
| 6 | Experiment 10 (Celtic Weave compound) + paper assembly |
| 7+ | Paper polish, peer-review pass, final receipt |

## Exit criteria

- Every hypothesis has a real measurement (positive or negative)
- The highest verified ratio is published with byte-exact reconstruction proof
- The paper draft is complete with all sections + reproducibility appendix
- A consolidated receipt closes the research phase

## Anti-scope

The research phase does NOT:
- Pivot AtomSmasher 2 to be a sheaf network
- Rewrite the canonical organism (`runAsOrganism()` stays at max-mode-v2)
- Add new engines to the production pipeline
- Train any neural models (out of scope without OrangeBrain)
- Touch OrangeLLM HTTP routes
- Touch Atomic Orange, AE Eyes, or any other pillar

The 278× lossless and 54.57× regeneration are the floor. The phase asks: can we beat them with honest, lossless, reproducible methods?
