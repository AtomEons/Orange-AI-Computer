# 09-SCHEMAS

JSON Schemas (Draft 2020-12) used across Orange5.

| File | `$id` | Purpose |
|---|---|---|
| `orange.order.v1.schema.json` | `orange.order.v1` | What OrangeLLM emits before action |
| `orange.report.v1.schema.json` | `orange.report.v1` | What OrangeLLM emits after action |
| `mission.schema.json` | `ae.mission.v0` | AECode mission packet |
| `receipt.schema.json` | `orange5.receipt.v0` | Hash-chained audit receipt |
| `gauntlet_result.schema.json` | `ae.gauntlet.v0` | Test gauntlet output |
| `aecode-final-format.schema.json` | `ae.aecode-final-format.v0` | AECode canonical source contract |

Validation runs in `tests/validate-schemas.mjs` — schemas are self-checked for valid JSON Schema syntax + each receipt + each report in `10-RECEIPTS/` is checked against its schema (when validator dep lands).

Codeless / zero-dep — full ajv validation pass deferred until first appropriate npm install.
