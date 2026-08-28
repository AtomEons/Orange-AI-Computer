# 05-FLOW — AE Flow runtime

Pressure-field orchestration. OrangeLLM rides this.

## Concept

- **Currents** = open tasks. Each has pressure (0..1).
- **Agents** = workers. Ride currents.
- **Deltas** = what changed last tick.
- **Governors** = backpressure (concurrency cap, escalation, block).
- **Acceptance** = current closes on receipt + approval.

## Usage

```js
import { createFlow, pushCurrent, registerAgent, tick, closeCurrent } from "./src/index.mjs";

const flow = createFlow({ persist: true });
const c = pushCurrent(flow, { title: "design review", pressure: 0.8, owner_department: "AE3" });
registerAgent(flow, { role: "orangellm-light" });
tick(flow);
// ... work happens ...
closeCurrent(flow, c.id, { receipt_path: "10-RECEIPTS/orange5-build/design-review.md" });
```

## Storage

JSON snapshot at `state/flow.json`. SQLite migration in PR-10.

## Tests

```bash
node tests/flow.test.mjs
```
