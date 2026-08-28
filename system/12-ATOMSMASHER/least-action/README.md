# Least-action Router

AtomSmasher module #6. Picks the minimum-energy path through the model
superstack per request. **LIVE** — `node 12-ATOMSMASHER/least-action/smoke-test.mjs`
passes 45/45.

## What it does

Given a request described by `(intent_complexity, risk_level, latency_budget_ms)`
the router scores every tier in the model superstack and returns the tier
that minimizes a single dimensionless action `S`, subject to hard
constraints. The router does **not** execute the chosen model — it returns
a content-addressed decision envelope. The gateway / dispatcher routes the
actual call.

## Tiers (v0)

| id        | class    | nameplate              | ceiling | lat_p50 | cost/call |
|-----------|----------|------------------------|---------|---------|-----------|
| reflex    | reflex   | Smart Skinny (local)   | 4       | 80ms    | $0.00005  |
| heavy     | heavy    | OrangeLLM-fatty        | 7       | 1200ms  | $0.004    |
| frontier  | frontier | BYO frontier (Opus, …) | 10      | 3500ms  | $0.05     |

`ceiling` is a 0-10 capability scale. The request's `risk_level` sets a
**minimum required ceiling** — a high-risk decision cannot route through
Smart Skinny even if its action score would be lowest.

## Action function

```
S = w_lat  * (lat_p50_ms / latency_budget_ms)
  + w_cap  * max(0, 1 - max(0, capability_headroom))
  + w_cost * cost_per_call_usd / max_cost_in_table
  - w_fit  * fit_score[bucket(complexity), bucket(risk)]
```

Published weights (part of the contract):

| weight  | value | meaning                                         |
|---------|-------|-------------------------------------------------|
| w_lat   | 1.0   | penalty for using more of the latency budget    |
| w_cap   | 0.6   | penalty for capability undershoot               |
| w_cost  | 0.4   | penalty for spending more dollars               |
| w_fit   | 1.5   | reward for matching the (complexity, risk) bucket |

Lower `S` wins. Tie-break: cheaper tier (earlier in `TIERS`) wins. When in
doubt, spend less.

## Hard constraints (precede optimization)

A tier is **hard-ineligible** (not scored, not selectable) if any of:

1. `tier.ceiling < ceil(risk_level)` — risk demands a higher tier.
2. `tier.ceiling < intent_complexity` — request demands a higher tier.
3. `tier.lat_p50_ms > latency_budget_ms * 0.8` — tier cannot meet the
   latency budget with safety headroom.

Each ineligibility is recorded with a human-readable reason so the
downstream consumer can prove why a tier was excluded.

## Inputs

```js
route({
  intent_complexity: 0..10,    // required
  risk_level:        0..10,    // required
  latency_budget_ms: >= 0,     // required
  capabilities:      string[], // optional; surfaced in the frame, not yet used for scoring
});
```

Missing or out-of-range inputs return a structured error frame (`error:
'invalid_request'`). There is no "guess reasonable defaults" mode. If the
caller cannot state the dimensions, the router selects nothing.

## Outputs

```js
{
  schema: 'orange5.atomsmasher.least-action-route.v0',
  decision_id: '<sha256-hex>',
  request: { intent_complexity, risk_level, latency_budget_ms, capabilities },
  derived: { demand, min_ceiling, bucket_key, lat_safety, max_cost_in_table },
  weights: { lat, cap, cost, fit },
  scorecard: [
    {
      tier_id, label, class, nameplate,
      eligible: boolean,
      reasons: string[],              // populated when ineligible
      action:  number | null,         // null when ineligible
      components: {                   // null when ineligible
        lat_term, cap_term, cost_term, fit_term,
        fit_score, headroom, bucket_key,
      },
    },
    ...
  ],
  chosen_tier: 'reflex' | 'heavy' | 'frontier' | null,
  route_reason: 'least_action' | 'no_eligible_tier',
  created_at: ISO-8601,
}
```

`decision_id = sha256(canonical({request, derived, weights, scorecard,
chosen_tier, route_reason}))`. `created_at` is NOT part of the id — the
router is deterministic. Two callers passing identical requests get
identical `decision_id`. `validate()` recomputes the hash and flags any
tamper.

## Doctrine

- Same inputs in → byte-identical decision out. No randomness. No model
  call inside the router.
- Hard constraints **precede** optimization. We do not "soft-penalize" a
  risk floor violation; we refuse to select.
- Every ineligibility carries a human-readable reason. No silent drops.
- Weights are part of the public contract. Changing them changes the
  router; treat as a versioned change.
- Tie-break direction is **cheaper-wins**. Mom's Law: when in doubt,
  spend less.
- The router does not maintain a learned model. The TIER table and
  `fit_priors` are hand-curated and versioned. If a learned router lands
  later, it goes in a sibling module and feeds this one as a fit input.

## Files

- `router.mjs` — pure scorer + validator (zero deps beyond `node:crypto`)
- `smoke-test.mjs` — 45 assertions across input validation, tier
  selection, hard constraints, determinism, tamper detection, edge cases
- `README.md` — this file

## Test

```
node 12-ATOMSMASHER/least-action/smoke-test.mjs
```

Exits non-zero on any assertion failure. Current state: **45/45 PASS**.

## Honest gaps

The following are real and named, not papered over:

- **`capabilities` is surfaced but unused** in scoring. The decision
  frame carries it (sorted, canonical) so a future revision can require
  that the chosen tier's cartridge declare the requested capabilities,
  but v0 does not enforce capability eligibility. Today's gate is
  complexity + risk + latency.
- **Nameplate latencies are static.** v0 reads `lat_p50_ms` from the
  hand-curated `TIERS` table; it does not observe real call latency.
  When the Saved Work Certificates module starts persisting per-tier
  call telemetry, a sibling can derive measured `lat_p50_ms` and feed
  it here.
- **`fit_priors` are hand-tuned.** They reflect operator judgment, not
  measurement. They are stable across releases (changing them is a
  contract change) but they are not learned.
- **No streaming / partial-result accounting.** The action treats every
  call as a single round-trip. Streaming responses where time-to-first-
  token matters more than full p50 need a future `lat_ttft_ms` field.
- **No gateway route yet.** Per the workflow scope, this PR ships
  `router.mjs`, `smoke-test.mjs`, and `README.md`. The schema file in
  `09-SCHEMAS/least-action-route.v0.schema.json` and the gateway route
  `06-ORANGELLM/server/routes/atomsmasher-least-action.mjs` are
  follow-on work consistent with the Anti-fluff Gate's LIVE pattern.

## Integration points

The router is the eligibility gate for tier dispatch. Typical wiring:

```
  request --> Sparse Worksets (compress context)
          --> Least-action Router (pick tier)
          --> Cartridges (mount the chosen tier's capability bundle)
          --> dispatch to the chosen tier
          --> AIR Codec (compress the response)
          --> Persist (Commitment Atoms + Saved Work Certificates + Pathwave)
          --> Compression Debt Ledger (audit drops)
```

The router emits exactly the information the dispatcher needs (`chosen_tier`,
`scorecard`, `decision_id`) and exactly what an auditor needs to prove the
decision was correct given the published weights and TIER table.
