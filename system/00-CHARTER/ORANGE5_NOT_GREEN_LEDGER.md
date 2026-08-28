# OrangeFive Not-Green Ledger

**Schema:** `orange5.not-green-ledger.v3`
**Last refreshed:** 2026-08-28
**Status:** OPEN - all required live operations are green; perceptual
studio-media certification remains pending and is not promoted by technical proof.

Receipts and direct probes outrank this ledger. A broad green snapshot does not
promote a later failing, narrower path.

## Accepted Current Truth

| Capability | 2026-08-27 truth | Evidence |
|---|---|---|
| Live primary Navigator | `orange-navigator:ornith-1.5-9b-q4km` on Codexa `10.0.0.4` | Fresh `spine-cli.mjs --health`; promotion evidence below |
| Codexa rail | Reachable, authenticated, and executable on `10.0.0.4:8097` | Integrated proof and Brain MCP proof below |
| Retired Q8 Navigator | Historical receipt identity and optional benchmark inventory; it is not the live primary | Current runtime authority and live health |
| Brain MCP | Dual transport green: 10 tools over stdio and 12 over authenticated loopback Streamable HTTP | `2026-08-27T08-25-01-953Z-brain-mcp-dual-transport-proof.json` |
| Historical integrated operation | Accepted Q8-era full snapshot green; this receipt is not relabeled as Q4KM evidence | `2026-08-27T08-25-23-337Z-integrated-operational-proof.json` |
| Context Crystal held-out quality | 5/5 parity cases; minimum held-out ratio `1422.901x` | `2026-08-27T07-47-05-945Z-context-crystal-quality-parity.json` |
| Context Crystal live turn | `59.439x` operational context ratio; this is not a 1,000x live-turn claim | Integrated proof above |
| AE Memory quality | 23/23 cases; hybrid MRR `0.9348` | `2026-08-27T06-13-19-976Z-memory-quality-benchmark.json` |
| Media runtime | Image, video, speech, and music artifacts are technically valid and independently decoded | Integrated proof above |
| Media quality | Studio quality is not certified | Integrated proof above |
| Hermes Brain MCP delegation | Complete in `9395.53 ms`; parent execution mediated, one child completed, synthesis completed, all eight LOOM gates authorized, lease revoked | `2026-08-27T17-31-43-840Z-brain-mcp-delegation-live-proof.json` |
| AE Cobra live recall | 10/10 gateway queries served by AE Cobra; no fallback; p50 `155.1 ms`, p95 `274.65 ms`, max `809.92 ms` | `2026-08-27T17-36-41-438Z-memory-hot-path-proof.json` |
| Doctrine guardrails | 27/27 pass after frontier-egress, receipt-chain, project-source, and continuity repairs | Fresh guardrail run `2026-08-27` |
| Source-backed Navigator Kernel | Canonical Orange memory/topology questions compile locally in `805 ms`; model inference measured `0.01 ms`; open-ended work still leases the Navigator | `2026-08-28T14-38-05-420Z-memory-phase-conversation-proof.json` plus focused route-boundary tests |
| Memory + AE Phase conversation path | 17/17 live checks: AE Cobra source truth, disk fallback, Codexa mirror, Phase system/model probes, natural conversation, Party Line, and Atomic Orange build | `2026-08-28T14-38-05-420Z-memory-phase-conversation-proof.json` |
| Native startup authority | Hidden Bun worker returns `ORANGE5_STARTUP_CONTROL_COMPLETE`; gateway and Phase are healthy; popup surface is `none`; PowerShell is not the runtime | `10-RECEIPTS/orange5-build/runtime-logs/orange5-runtime-supervisor-latest.json` |

Do not publish a fixed full-verifier pass count in operator guidance. Test totals
change as coverage lands; cite the command and the fresh result from the run
being reported.

## Active Operational Gaps

| Gap | Current evidence | Exact exit condition | Owner |
|---|---|---|---|
| Studio media quality | Media lanes prove decodable, nonblank/non-silent, moving where applicable, and hash-stable artifacts. They do not prove human or model-reviewed studio quality. | Cross-prompt human and model quality bakeoff with explicit acceptance criteria and a promotion receipt. | Media quality evaluation |

The media-quality gap limits subjective quality claims; it does not erase the
technical runtime proof and does not block the OrangeFive operational spine.

## Historical Model Transition

The `2026-08-27T08-30-30-809Z-integrated-operational-proof.json` rerun returned
`NEEDS_WORK`: it consumed a one-case Q4 Context benchmark while the accepted
integrated snapshot still named Q8, and its live governed turn did not complete.
That receipt remains historical evidence and was never allowed to promote a
candidate merely by being newest. The later navigator bakeoff selected the
Q4_K_M candidate, and fresh semantic health now names the promoted
`orange-navigator:ornith-1.5-9b-q4km` tag as live primary.

## Current Evidence Set

- Live health: `bun 03-BACKEND/spine-cli.mjs --health`
- Accepted integrated proof:
  `10-RECEIPTS/orange5-build/2026-08-27T08-25-23-337Z-integrated-operational-proof.json`
- Concurrent non-accepted integrated rerun:
  `10-RECEIPTS/orange5-build/2026-08-27T08-30-30-809Z-integrated-operational-proof.json`
- Navigator promotion bakeoff:
  `10-RECEIPTS/orange5-build/2026-08-27T10-02-32-980Z-navigator-candidate-bakeoff.json`
- Brain MCP dual transport:
  `10-RECEIPTS/orange5-build/2026-08-27T08-25-01-953Z-brain-mcp-dual-transport-proof.json`
- Context Crystal held-out parity:
  `10-RECEIPTS/orange5-build/2026-08-27T07-47-05-945Z-context-crystal-quality-parity.json`
- AE Memory quality:
  `10-RECEIPTS/orange5-build/2026-08-27T06-13-19-976Z-memory-quality-benchmark.json`
- Earlier Hermes live execution:
  `10-RECEIPTS/orange5-build/2026-08-27T01-58-46-801Z-hermes-live-execution-proof.json`
- Current Hermes Brain MCP delegation:
  `10-RECEIPTS/orange5-build/2026-08-27T17-31-43-840Z-brain-mcp-delegation-live-proof.json`
- Current AE Cobra hot-path proof:
  `10-RECEIPTS/orange5-build/2026-08-27T17-36-41-438Z-memory-hot-path-proof.json`
- Current memory/Phase/conversation proof:
  `10-RECEIPTS/orange5-build/2026-08-28T14-38-05-420Z-memory-phase-conversation-proof.json`
- Current native startup proof:
  `10-RECEIPTS/orange5-build/runtime-logs/orange5-runtime-supervisor-latest.json`

## Claim Boundaries

- Live primary means the model named by fresh semantic health, not an installed
  historical weight or a separate candidate bakeoff.
- Integrated green means the exact accepted snapshot passed. It does not
  override a later path-specific timeout.
- The historical Q4 candidate receipt did not replace Q8-era primary evidence
  through newest-file selection. Current Q4KM authority comes from the later
  promotion evidence plus fresh semantic health.
- Eight LOOM gates authorize a crossing. They do not prove that the delegated
  worker completed its work.
- Held-out compression and live-turn compression are separate measurements.
- Technical media validity is not studio quality.

**Bottom line:** OrangeFive has a green operational spine: live Q4KM Ornith
primary routing, authenticated Codexa, current dual-transport MCP, completed
Hermes delegation, live low-latency AE Cobra memory, held-out Context Crystal
quality proof, source-backed sub-second canonical system answers, an AE Phase
startup authority with no popup shell, and technically valid media. The ledger
stays open only for the separate studio-media perceptual quality claim. No fake
green.
