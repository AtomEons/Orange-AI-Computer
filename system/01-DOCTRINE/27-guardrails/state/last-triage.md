# 27 Guardrails — Triage Report

- **Run ID:** `gr_1782345086732_04821e64`
- **Finished:** 2026-06-24T23:51:32.055Z
- **Elapsed:** 5319 ms
- **Overall:** RED (16 of 27 failed)
- **Stop flag:** YES — CRITICAL or HIGH red present
- **Persist backend:** (disabled)
- **Runtime flux-client:** (no violations / disabled)
- **Thought-lane events emitted:** 0
- **Disclosure:** ATOM-27GUARD-TRIAGE-2026-0624

## Verdict — all 27 checks

| G-ID | Severity | Pass | Elapsed | Name |
| --- | --- | --- | --- | --- |
| G01 | CRITICAL | yes | 311 ms | runtime/node.py is sole authoritative cognitive center |
| G02 | CRITICAL | **NO** | 293 ms | FOUNDER_SALARY_PER_INSTALL_CENTS is env-bound, not hardcoded |
| G03 | CRITICAL | **NO** | 291 ms | Gate 0 LatticeIntegrityGate (LBCE) is first in every gate chain |
| G04 | CRITICAL | **NO** | 288 ms | Human Final Stop is reachable from any autonomous-action path |
| G05 | CRITICAL | **NO** | 5192 ms | ATOMEONS_IDENTITY_SECRET is env-only, never hardcoded |
| G06 | HIGH | **NO** | 277 ms | Frontier work routed only via the frontier gateway |
| G07 | HIGH | **NO** | 5225 ms | No code editor in the operator surface (4-lane app) |
| G08 | CRITICAL | **NO** | 5211 ms | The 4 operator lanes (Chat / Cockpit / Vault / Settings) are immutable |
| G09 | CRITICAL | **NO** | 256 ms | Mom's Law sits above all other rules |
| G10 | HIGH | **NO** | 254 ms | Receipts are hash-chained (every receipt references prior_sha256) |
| G11 | HIGH | yes | 241 ms | No fake-green words in commit messages (passing/green/done without evidence) |
| G12 | HIGH | **NO** | 237 ms | Reality Flux lane discipline — reality writes are receipt-origin only |
| G13 | CRITICAL | yes | 235 ms | Frontier loopback (:7419) never exposed to non-loopback interface |
| G14 | HIGH | **NO** | 233 ms | Soul Genome JSON exists and is well-formed |
| G15 | MEDIUM | yes | 228 ms | Continuity Packet for previous day exists by 06:00 local |
| G16 | HIGH | yes | 225 ms | No simulation of real people (persona phrases blocked) |
| G17 | MEDIUM | yes | 224 ms | Ledger emission shape — every deliverable has zip + sha256 + row |
| G18 | LOW | **NO** | 223 ms | GPT > Gemini on trilane conflict (model hierarchy preserved) |
| G19 | MEDIUM | **NO** | 221 ms | Spiral Reasoning anchor (z_0 = Soul Genome) is set |
| G20 | MEDIUM | **NO** | 219 ms | Belief angle alpha is bounded (no runaway curvature) |
| G21 | HIGH | yes | 215 ms | Receipts directory exists and is writable |
| G22 | MEDIUM | yes | 205 ms | Reality Flux daemon reachable (cobra or shadow cache) |
| G23 | MEDIUM | **NO** | 192 ms | Misfit beta is governed (no silent canon drift) |
| G24 | HIGH | yes | 169 ms | Release-steward authority preserved — no specialist self-upgrades |
| G25 | HIGH | yes | 167 ms | No --no-verify or --no-gpg-sign in recent commits (hooks honored) |
| G26 | LOW | yes | 146 ms | Standing routing law honored — Orange3/Orangebox cockpit referenced |
| G27 | CRITICAL | **NO** | 5139 ms | 27-guardrails registry has exactly 27 entries (self-check) |

## Reds — 16

### G02 — FOUNDER_SALARY_PER_INSTALL_CENTS is env-bound, not hardcoded

- **Severity:** CRITICAL
- **Doctrine:** ÆSkill Suite V1.4 invariant
- **Check module:** `undefined`
- **Elapsed:** 293 ms

**Details:**

```json
{
  "reason": "missing_canonical_node",
  "path": "C:\\AtomEons\\Orange5\\runtime\\node.py",
  "receipt_trigger": "G01_SHADOW_COGNITION"
}
```

**Suggested fix:**

> Set FOUNDER_SALARY_PER_INSTALL_CENTS in environment (or .env loaded by the runtime). Remove any hardcoded literal that bypasses the env. Verify with: rg -n 'FOUNDER_SALARY_PER_INSTALL_CENTS\s*=\s*[0-9]' --type=py --type=ts under the Orange5 root.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G03 — Gate 0 LatticeIntegrityGate (LBCE) is first in every gate chain

- **Severity:** CRITICAL
- **Doctrine:** ÆSkill Suite V1.4 invariant
- **Check module:** `undefined`
- **Elapsed:** 291 ms

**Details:**

```json
{
  "reason": "env_unset_or_invalid",
  "env_value": null,
  "receipt_trigger": "G02_FOUNDER_SALARY_UNSET"
}
```

**Suggested fix:**

> Open the gate-chain registration site and place LatticeIntegrityGate (LBCE) at position 0. No gate may register itself ahead of Gate 0. If Gate 0 is missing, the chain is unsafe to run — block promotion until restored.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G04 — Human Final Stop is reachable from any autonomous-action path

- **Severity:** CRITICAL
- **Doctrine:** ÆSkill Suite V1.4 invariant + Charter
- **Check module:** `undefined`
- **Elapsed:** 288 ms

**Details:**

```json
{
  "reason": "no_gate_chain_registry",
  "receipt_trigger": "G03_GATE0_REORDERED",
  "remedy": "The control plane has no gate chain registry to audit. Register every chain through `online_checks.assertGate0Lbce` before any action dispatch."
}
```

**Suggested fix:**

> Trace the autonomous-action path (orchestrator → executor → outbound) and confirm a synchronous, reachable Human Final Stop signal at every transition. If the stop hook is async-only or fire-and-forget, refactor to synchronous-block-on-stop semantics before re-running.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G05 — ATOMEONS_IDENTITY_SECRET is env-only, never hardcoded

- **Severity:** CRITICAL
- **Doctrine:** ÆSkill Suite V1.4 invariant
- **Check module:** `undefined`
- **Elapsed:** 5192 ms

**Details:**

```json
{
  "reason": "check_threw_or_timed_out",
  "error": "timeout after 5000ms"
}
```

**Suggested fix:**

> Move ATOMEONS_IDENTITY_SECRET out of source. Read it via process.env at boot only. Rotate the secret if it was ever committed (git log -p -S 'ATOMEONS_IDENTITY_SECRET').

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G08 — The 4 operator lanes (Chat / Cockpit / Vault / Settings) are immutable

- **Severity:** CRITICAL
- **Doctrine:** PR-01 native rail
- **Check module:** `undefined`
- **Elapsed:** 5211 ms

**Details:**

```json
{
  "reason": "check_threw_or_timed_out",
  "error": "timeout after 5000ms"
}
```

**Suggested fix:**

> Verify exactly four lanes are registered in 02-APP/src/router.tsx: Chat, Cockpit, Vault, Settings. No additions, no renames, no removals without a constitutional review. If a 5th lane has crept in, revert it.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G09 — Mom's Law sits above all other rules

- **Severity:** CRITICAL
- **Doctrine:** C:\AtomEons\.claude\rules\00-moms-law.md
- **Check module:** `undefined`
- **Elapsed:** 256 ms

**Details:**

```json
{
  "reason": "missing_lanes_manifest",
  "path": "C:\\AtomEons\\Orange5\\01-DOCTRINE\\lanes\\lanes.json",
  "receipt_trigger": "G08_LANE_MUTATION"
}
```

**Suggested fix:**

> Re-read .claude/rules/00-moms-law.md. If the operator has flagged a Mom's Law breach for this turn, stop, redo the last output with full effort, and emit a MOMS_LAW_REVIEW receipt. The witness elevates from informational to blocking on operator flag.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G27 — 27-guardrails registry has exactly 27 entries (self-check)

- **Severity:** CRITICAL
- **Doctrine:** Self-referential invariant
- **Check module:** `undefined`
- **Elapsed:** 5139 ms

**Details:**

```json
{
  "reason": "check_threw_or_timed_out",
  "error": "timeout after 5000ms"
}
```

**Suggested fix:**

> The registry has the wrong entry count. Open registry.mjs and confirm exactly 27 entries. Self-referential invariant — if this fails, every other check is suspect because the spine is broken.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G06 — Frontier work routed only via the frontier gateway

- **Severity:** HIGH
- **Doctrine:** PR-02 Frontier Isolation Boundary
- **Check module:** `undefined`
- **Elapsed:** 277 ms

**Details:**

```json
{
  "reason": "env_unset",
  "receipt_trigger": "G05_IDENTITY_SECRET_LEAK",
  "remedy": "Set ATOMEONS_IDENTITY_SECRET in the environment (not in source). Boot must abort without it."
}
```

**Suggested fix:**

> Audit any frontier-bound calls (06-ORANGELLM, frontier loopback :7419) and confirm they route through the frontier gateway, not direct hosts. See FRONTIER_ISOLATION_BOUNDARY.md §3 — gateway is the only legal egress.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G07 — No code editor in the operator surface (4-lane app)

- **Severity:** HIGH
- **Doctrine:** Orange5 Master Plan / lane discipline
- **Check module:** `undefined`
- **Elapsed:** 5225 ms

**Details:**

```json
{
  "reason": "check_threw_or_timed_out",
  "error": "timeout after 5000ms"
}
```

**Suggested fix:**

> Remove any code-editor surface (Monaco / CodeMirror / ace) from the 4-lane operator app (02-APP/src/lanes/). Code editors belong in dev tooling, not in the operator surface. If a lane needs to display code, use a read-only viewer.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G10 — Receipts are hash-chained (every receipt references prior_sha256)

- **Severity:** HIGH
- **Doctrine:** PR-build receipts ladder
- **Check module:** `undefined`
- **Elapsed:** 254 ms

**Details:**

```json
{
  "reason": "no_receipt_window",
  "receipt_trigger": "G09_RECEIPT_CHAIN_BREAK",
  "remedy": "Pass state.recentReceipts (the tail of 10-RECEIPTS/ledger.db). The chain cannot be witnessed without rows."
}
```

**Suggested fix:**

> Inspect the most recent receipts under 10-RECEIPTS/ and confirm every receipt has a non-null prior_sha256 (except genesis). If a chain break exists, run a chain_repair script and write a kind:'chain_repair' receipt — do NOT silently retie the chain.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G12 — Reality Flux lane discipline — reality writes are receipt-origin only

- **Severity:** HIGH
- **Doctrine:** 11-MIRAGE flux.mjs lane discipline
- **Check module:** `undefined`
- **Elapsed:** 237 ms

**Details:**

```json
{
  "reason": "no_assistant_turn",
  "receipt_trigger": "G11_PERSON_SIMULATION",
  "remedy": "Pass state.assistantTurn to scan. The witness needs the text to scrutinize."
}
```

**Suggested fix:**

> Verify Reality Flux writes originate only from receipt-bearing terminals (origin field set, not 'unknown'). If you see direct writes from app code, route them through the receipts terminal instead. See 11-MIRAGE flux.mjs lane discipline.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G14 — Soul Genome JSON exists and is well-formed

- **Severity:** HIGH
- **Doctrine:** Spiral Reasoning anchor — Soul Genome continuity
- **Check module:** `undefined`
- **Elapsed:** 233 ms

**Details:**

```json
{
  "reason": "no_deliverable_supplied",
  "receipt_trigger": "G13_DELIVERABLE_WITHOUT_LEDGER"
}
```

**Suggested fix:**

> Create or repair state/soul-genome.json. Schema is documented in lib/soul-genome.mjs. Without a Soul Genome anchor, Spiral Reasoning has no z_0 to anchor against — reasoning is unmoored.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G19 — Spiral Reasoning anchor (z_0 = Soul Genome) is set

- **Severity:** MEDIUM
- **Doctrine:** Spiral Reasoning v3 — bounded angle alpha
- **Check module:** `undefined`
- **Elapsed:** 221 ms

**Details:**

```json
{
  "reason": "no_continuity_packet_in_lookback_window",
  "today": "2026-06-24",
  "max_lookback_days": 7,
  "searched_dirs": [
    "C:\\AtomEons\\Orange5\\01-DOCTRINE\\continuity",
    "C:\\AtomEons\\Orange5\\01-DOCTRINE\\27-guardrails\\state\\continuity"
  ],
  "severity_now": "warn",
  "receipt_trigger": "G18_CONTINUITY_MISSING"
}
```

**Suggested fix:**

> Set the Spiral Reasoning anchor: z_0 = Soul Genome. Confirm the reasoning runtime reads soul-genome.json at boot and uses it as the curvature origin. See SPIRAL_REASONING_INTEGRATION_v1.md.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G20 — Belief angle alpha is bounded (no runaway curvature)

- **Severity:** MEDIUM
- **Doctrine:** Spiral Reasoning Belief Discipline
- **Check module:** `undefined`
- **Elapsed:** 219 ms

**Details:**

```json
{
  "reason": "no_receipt_window",
  "receipt_trigger": "G19_CONTINUITY_NOT_WRITTEN"
}
```

**Suggested fix:**

> Audit recent reasoning trajectories for alpha (belief angle) values. If alpha exceeded the configured bound, the trajectory has runaway curvature — bound the angle in the reasoning loop and re-run.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G23 — Misfit beta is governed (no silent canon drift)

- **Severity:** MEDIUM
- **Doctrine:** 05-misfit-frontier.md
- **Check module:** `undefined`
- **Elapsed:** 192 ms

**Details:**

```json
{
  "reason": "empty_validator_registry",
  "receipt_trigger": "G22_NONDETERMINISTIC_VALIDATOR",
  "remedy": "The control plane has no validators registered. Register every gate validator through the registrar so the determinism canary runs."
}
```

**Suggested fix:**

> Open 18-HELD/ (misfit beta governance) and verify each beta branch has an explicit promotion gate. Silent canon drift = beta code in main without a promotion receipt. Revert any unreceipted promotion.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

### G18 — GPT > Gemini on trilane conflict (model hierarchy preserved)

- **Severity:** LOW
- **Doctrine:** ÆSkill Suite trilane model hierarchy
- **Check module:** `undefined`
- **Elapsed:** 223 ms

**Details:**

```json
{
  "reason": "soul_genome_shape_invalid",
  "path": "C:\\AtomEons\\Orange5\\01-DOCTRINE\\27-guardrails\\state\\soul-genome.json",
  "missing": [
    "schema_version"
  ],
  "receipt_trigger": "G17_SOUL_GENOME_FORK"
}
```

**Suggested fix:**

> On a trilane (Claude / GPT / Gemini) conflict, defer to GPT. Verify the conflict-resolution logic in the trilane bundler picks GPT over Gemini, and that the resolution is logged in the bundle manifest.

**Receipt:** _(Thought-lane emission disabled — --no-flux)_

## Honest gaps — structural state no single check can self-heal

### Two parallel check sets exist in checks/

registry.mjs (used by runtime.mjs) imports legacy g01-g27 files. checks/index.mjs imports the canonical 01-27 NN-slug files. This triage tool runs the registry path (the live runtime). The 01-27 set is reachable only via checks/index.mjs and is not currently wired to runtime.mjs. Pick one canonical set and delete or wire the other before promoting beyond static scaffolding.

### Receipt #033 returned status=partial

Receipt #033 noted the runtime daemon was specified but never smoke-tested live. This triage run IS the live smoke. If this run produces a clean markdown report and a Thought-lane receipt, Receipt #033 can be re-issued with status=complete (operator discretion — release-steward authority).

### Bun guardrails server (:7460) not booted

spec.md and package.json define `bun server.mjs` on :7460 as the guardrail HTTP surface. The port is not currently bound. Boot with: cd 01-DOCTRINE/27-guardrails && bun server.mjs. Until booted, the only way to run all 27 is via this triage tool or `node runtime.mjs` directly.

### Gateway routes at 06-ORANGELLM/server/routes/guardrails.mjs not spliced into v1.mjs

The guardrails route file exists but is not mounted in the v1 router. The OrangeLLM gateway cannot proxy guardrail queries until the splice lands. This is a manual edit — open 06-ORANGELLM/server/v1.mjs and import + mount ./routes/guardrails.mjs at the configured prefix.

### 4 check(s) failed due to runtime/wiring issues (not policy violations)

These reds are infrastructure problems with the check itself or missing state — not actual doctrine breaches. Listed: G05 (check_threw_or_timed_out), G07 (check_threw_or_timed_out), G08 (check_threw_or_timed_out), G27 (check_threw_or_timed_out). Fix the check or supply the state before treating these as breaches.

### Thought-lane emission was disabled for this run (--no-flux)

Reds were NOT written to the Thought-lane Flux ledger. The markdown report below is the only receipt. To enable receipts, re-run without --no-flux.

### Runtime flux-client write disabled (--no-flux-runtime)

runtime.mjs's writeViolationsToFlux() (which posts to the cobra loopback or spools to state/flux-spool.jsonl) was skipped. The Thought-lane events from this tool may still have been written depending on --no-flux.

## Next action

1. Resolve every CRITICAL and HIGH red. The stop flag is **SET** — promotion is blocked.
2. For each red above, apply the suggested fix and re-run this tool.
3. After all reds are resolved, re-run with `--no-flux` to confirm clean verdict without emitting fresh receipts.
4. Only then promote downstream gates.

_Generated by doctrine.27guardrails.triage on 2026-06-24T23:51:32.055Z._
