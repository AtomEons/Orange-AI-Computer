# AE Link Isolated Proof

`ae-link.v1` is a dependency-free Bun TCP backplane proof. It is intentionally
not imported, registered, or started by any OrangeFive production path.

The proof provides:

- four-byte big-endian length-prefixed, HMAC-SHA256 authenticated JSON frames;
- independent sequence and cumulative acknowledgement cursors for the
  `control`, `memory`, `model`, `telemetry`, and `artifact` channels;
- fixed channel priority with FIFO ordering inside each channel;
- resume handshakes, duplicate suppression, bounded exponential reconnect, and
  signed heartbeats;
- an atomically replaced, disk-backed authenticated journal for unacknowledged
  data frames; and
- a hash-chained work-custody journal that persists accepted work before
  acknowledgement, binds idempotency keys to one work item, fences owners by
  epoch, grants idempotent effects, serializes competing writers, and preserves
  exactly one cancellation/terminal result across restart;
- orphan recovery that requires durable external evidence, advances the owner
  epoch, resumes started work from `PERSISTED`, and preserves
  `CANCEL_REQUESTED` until existing effects drain; and
- `getStateRoot` and `onStateRootMismatch` reconciliation hooks without
  prescribing a production state store.

The proof detects corruption or modification but does not solve key
distribution. A production integration would need governed identity, key
rotation, authorization, resource limits, receipt policy, and deployment
ownership before this transport could be trusted outside loopback evaluation.

Run only its focused tests:

```powershell
bun test 03-BACKEND/tests/ae-link.test.mjs
bun test 03-BACKEND/tests/ae-link-custody.test.mjs
bun test 03-BACKEND/tests/ae-link-custody-model.test.mjs
```
