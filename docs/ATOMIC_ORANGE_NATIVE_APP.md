# Æ Orange AI Computer Atomic Orange App

Atomic Orange is the optional native operator surface for Æ Orange AI Computer.
The current app source is checked in under `system/ATOMICORANGE`. The app does
not own project truth, memory, policy, execution authority, or receipts.

## Current Public Status

Source presence is established. A current-source public installer is not.

Tracked engineering records describe an earlier machine-local Windows build
from a different source path. They record an unsigned executable and NSIS
installer, a process that survived a ten-second launch probe, a passed
TypeScript typecheck, incomplete focused frontend test/build attempts, and a
governed backend handshake. Those observations do not prove that the app now
checked into `system/ATOMICORANGE` builds reproducibly or completes a native
operator workflow.

No signed Atomic Orange installer is published with the current source in this
repository's public release assets.

## Ownership Boundary

The intended crossing is:

```text
operator request
-> native bridge
-> governed gateway or Brain MCP
-> route and model identity
-> streamed visible work
-> durable run state
-> report and receipt identity
-> visible completion or blocker
```

The interface may explain and present. It may not manufacture a receipt, hide a
failed gate, turn configuration into proof, or relabel a route after execution.

## Expected Operator Surface

- incremental conversation with real cancellation propagation;
- active route, model, host, and semantic health;
- durable active, completed, blocked, cancelled, and failed runs;
- receipt and evidence access linked by one run identity;
- bounded tool and agent approvals;
- visual and creative artifacts linked to provenance;
- recovery information naming the first failed gate.

These are acceptance requirements. Their presence in this manual is not a claim
that every item is implemented or publicly proven.

## Required App Proof

A browser preview and a successful process start are insufficient. Current app
closure requires:

- a reproducible build from `system/ATOMICORANGE`;
- a source-to-artifact manifest and hashes;
- an explicit signing posture;
- clean-machine install, launch, upgrade, uninstall, and rollback;
- native process and executable identity;
- gateway request and route identity;
- time to first visible assistant content and final completion;
- cancellation reaching the native request and upstream work;
- restart restoration of durable run state;
- receipt identity visible in the app;
- screenshots tied to the same runtime evidence and run identity;
- visible disconnected, denied, blocked, and failed states.

## Failure Boundaries

| Symptom | First evidence to inspect |
|---|---|
| App opens but chat stalls | semantic gateway health, route, and first upstream content |
| Text arrives only at the end | native bridge buffering and stream forwarding |
| Stop changes only the UI | cancellation propagation through native and upstream layers |
| A run disappears | durable run store and projection, never ledger deletion |
| A receipt is shown without a result | shared run identity and receipt-chain validation |
| Visual output cannot be audited | source hash, route, report, and receipt linkage |

Do not repair a native issue by exposing loopback services publicly, killing
unrelated processes, deleting ledgers, or moving authority into UI state.

## Related Guides

- [Current Source and Gaps](CURRENT_SOURCE_AND_GAPS.md)
- [Operator Manual](OPERATOR_MANUAL.md)
- [Receipts and Audit](RECEIPTS_AND_AUDIT.md)
- [Troubleshooting and Recovery](TROUBLESHOOTING_AND_RECOVERY.md)
