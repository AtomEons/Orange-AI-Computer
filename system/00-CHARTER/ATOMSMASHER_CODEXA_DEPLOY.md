# AtomSmasher 2 — Codexa Deploy Spec

**Locked:** 2026-06-25 (canon-refresh receipt #060)
**Pillar:** 5 (Compression engine + tool registry)
**Runtime:** Bun (operator law: "i run bun now. if its node or prior i dont need or want it.")
**Host:** Codexa (Intel Core Ultra 9 285H, 96 GB RAM) — **never the dev mini PC (N150)**
**Sovereign:** Atom McCree

This doc tells the operator (or future Claude/Codex sessions) exactly how to bring AtomSmasher 2 up on Codexa as the always-on compression sieve driven by AE Cobra (AE Memory Pillar 3).

---

## What runs where

| Component | Host | Why |
|---|---|---|
| AtomSmasher 2 modules (12) | **Codexa** | Pillar 5 compression engine; needs 96 GB RAM for cartridges + EquationStore + Pathwave cache |
| AE Cobra Docker daemon | **Codexa** | Drives AtomSmasher 2 as the active sieve on the data river |
| ToolMesh registry (48 cards) | **Codexa** | Co-located with AtomSmasher 2 (planner consults registry before lease mint) |
| Atomic Orange UI | N150 (dev mini PC) | The UI only — relays reports |
| Small LLM (`qwen3:0.6b` + `nomic-embed-text`) | N150 | Reflex tier only |
| OrangeBrain heavy (OrangeLLM-fatty-v0) | **Codexa** | Ollama hosts the trained 32B adapter |

**Rule:** AtomSmasher 2 never runs on N150. Compression must happen co-located with OrangeBrain + AE Cobra to avoid network hops on the hot path.

---

## Current state (2026-06-25)

### Battle-readiness scorecard

CI gate: `bun bin/atomsmasher-smoke-all.mjs` — runs all 11 module smokes in ~2.7s

| Module | Status (Bun 1.3.14) | Smoke assertions |
|---|---|---|
| air-codec | ✅ PASS | ~80 |
| canon-pressure | ❌ FAIL — 45 checks | Blocked on async cascade |
| cartridges | ✅ PASS | 56 |
| commitment-atoms | ❌ FAIL — 21 checks | Blocked on async cascade |
| compression-debt | ❌ FAIL — 40 checks | Blocked on async cascade |
| equation-store | ✅ PASS | 76 |
| expansion-warrants | ✅ PASS | 60 |
| least-action | ✅ PASS | 45 |
| pathwave | ✅ PASS | 70 |
| saved-work | ✅ PASS | 56 |
| sparse-worksets | ✅ PASS | 47 |

**Result: 8/11 modules battle-ready on Bun. 3 modules blocked.**

### The 3 blocked modules — exact cause

All three (`commitment-atoms`, `compression-debt`, `canon-pressure`) call the canonical Flux writer at `06-ORANGELLM/memory/ae-cobra/flux/writer.mjs` with an **old signature** (`{kind, body}`) but the writer's current signature is `{event}` and the function is `async`. The old Node tests passed because the writer used to be sync + accept the old shape; operator/linter replaced it mid-Wave-3 with the canonical doctrine impl (flat per-lane file, atomic-append-with-lockfile, hash-chain verify on read).

This is a **substrate-level async cascade refactor** required to fix:

1. Update `writer.mjs` to accept backward-compat `{kind, body}` input shape (3-line patch).
2. Make `createAtom`, `recordDebt`, `payDebt`, `forgiveDebt`, `pressureSummary`, `ingestReceiptReference` (and any other public functions touching the writer) `async`.
3. Add `await` to every internal call to `writeFluxRecord`.
4. Update each module's smoke test to `await` the now-async public functions.
5. Audit gateway routes that call these functions (`06-ORANGELLM/server/routes/*.mjs`) for `await`.

Scope: ~6 source files + 3 smoke tests + ~3 gateway routes. Out of scope for canon-refresh #060; tracked as **next-turn priority** post-operator-greenlight.

### The "600+ tools" claim — corrected

Operator stated AtomSmasher 2 should drive 600+ tools live and compressing. Actual disk reality (2026-06-25):

- **12 AtomSmasher 2 modules** (per-module READMEs at `12-ATOMSMASHER/<module>/README.md`)
- **48 ToolMesh capability tool-cards** across 11 labs (`13-TOOLMESH/labs/<lab>/*.json`)

**Total: 60 distinct tools/modules** on disk today. Not 600+. The 600+ figure is aspirational — to get there would require:

- Per-lab tool-card expansion (currently 4-5 cards per lab; target ~50 per lab for 11-lab × 50 = 550 cards)
- New labs beyond the 11 (operator's call)
- Or expanding what counts as a "tool" (MCP-server-side tools, gateway routes, etc.)

Honest scope: **60 today; documented; not faking 600+.**

---

## Codexa deployment — required operator-side env work

These remain parked per operator standing instruction ("operator aint doing any of that till project is seconds from done") but listed here so when env work happens, it lands clean:

### Prerequisites

```bash
# On Codexa:
curl -fsSL https://bun.sh/install | bash
bun --version  # confirm 1.3.x+
```

### Layout

```
/opt/atomeons/orange5/
├── 12-ATOMSMASHER/          # synced from C:\AtomEons\Orange5\12-ATOMSMASHER\
├── 13-TOOLMESH/             # synced from C:\AtomEons\Orange5\13-TOOLMESH\
├── 06-ORANGELLM/            # gateway + AE Cobra
├── 09-SCHEMAS/              # schema validators
├── bin/
│   ├── sqlite-shim.mjs      # Bun-only SQLite shim (uses bun:sqlite, no better-sqlite3)
│   └── atomsmasher-smoke-all.mjs  # CI gate
└── /var/atomeons/
    ├── flux/                # Reality + Thought lane jsonl files (mounted from /mnt/ae_flux)
    ├── atomsmasher.db       # SQLite (Bun-native via bun:sqlite)
    └── receipts/            # markdown receipt mirror
```

### Bun-only runtime contract

- `better-sqlite3` (Node native) is **retired**. All AtomSmasher 2 modules import `Database` from `bin/sqlite-shim.mjs` which uses `bun:sqlite` (built-in to Bun, no node-gyp build).
- `node:fs`, `node:path`, `node:crypto`, `node:url` are unchanged (Bun is Node-API compatible at the stdlib level).
- No `npm install` step needed for AtomSmasher 2 — the modules are zero-dep beyond Bun's built-ins.
- ToolMesh registry uses `fs.watch` for hot-reload (Bun-compatible).

### Smoke gate before promotion

```bash
cd /opt/atomeons/orange5
bun bin/atomsmasher-smoke-all.mjs --strict
```

Exit 0 → all 11 modules green → safe to promote.
Exit 1 → fix before promotion.

### AE Cobra Docker integration (PENDING)

AE Cobra (in AE Memory Pillar 3) drives AtomSmasher 2 as the always-on sieve. When AE Cobra Docker daemon is up (operator env work), it imports the AtomSmasher 2 modules and runs them on every passage of data through Orange5:

```yaml
# Conceptual — docker-compose snippet for when operator brings AE Cobra up
services:
  ae-cobra:
    image: orange5/ae-cobra:latest
    runtime: bun
    volumes:
      - /opt/atomeons/orange5:/opt/atomeons/orange5:ro
      - /var/atomeons:/var/atomeons:rw
      - /mnt/ae_flux:/mnt/ae_flux:rw
    environment:
      - AE_FLUX_ROOT=/mnt/ae_flux
      - ATOMSMASHER_ROOT=/opt/atomeons/orange5/12-ATOMSMASHER
      - TOOLMESH_ROOT=/opt/atomeons/orange5/13-TOOLMESH/labs
    command: bun /opt/atomeons/orange5/06-ORANGELLM/memory/ae-cobra/daemon.mjs
    restart: unless-stopped
```

This is **aspirational** — daemon.mjs needs authorship + the 3-module async cascade needs to land first.

---

## What's tested today (Bun, dev mini PC, smoke surface)

The 8 green AtomSmasher 2 modules run smoke tests entirely on dev box Bun (in-process, no Codexa needed). These exercise:

- **air-codec**: verbose-LLM → AIR frame round-trip, citation extraction, code-span preservation, date-before-number ordering
- **cartridges**: 3 seed cartridges load + hot-swap with version compare-and-set
- **equation-store**: 4 canonical seeds (FOUNDER_SALARY_PER_INSTALL_CENTS, GATE_0_LBCE, GUARDRAILS_COUNT=27, MOMS_LAW)
- **expansion-warrants**: nonce-bounded operator grants with expiry + max-uses ceiling
- **least-action**: 3-tier router with deterministic decision_id
- **pathwave**: step compression + diff localization
- **saved-work**: cert chain rewrite resistance
- **sparse-worksets**: relevance-ranked workset compression with budget enforcement

The 3 blocked modules carry compression-debt-ledger, commitment-atoms (the persisting kind), and canon-pressure-detector functionality. These are critical for the always-on sieve role — async cascade is **next-priority work**.

---

## Mom's Law alignment

- 8/11 green is real-tested-and-receipted (this turn's smoke run captured in receipt #060)
- 3/11 fail is named openly with the exact root cause (async signature drift in canonical Flux writer)
- 60-tool actual count vs 600+ claim is named openly; no inflated metric
- Codexa deployment runtime contract is named (Bun-only, no Node fallback)
- AE Cobra daemon scaffolding is aspirational and tagged as such (PENDING)
- Operator-side env work is parked openly per standing law ("seconds from done")

---

**Receipt:** [`2026-06-25-canon-refresh-plus-atomsmasher-bun.md`](../10-RECEIPTS/orange5-build/2026-06-25-canon-refresh-plus-atomsmasher-bun.md) (#060, prior #059)

**Next action:** Operator greenlight to land the **3-module async cascade** in next turn → AtomSmasher 2 hits 11/11 green on Bun.
