# Orange Operations Law

- All N150 to Codexa Orange orders, reports, acknowledgements, cancellation, and custody travel through AE Phase.
- Submit operational work with `bun C:/AtomEons/Orange5/scripts/ae-phase-order.mjs` using `orange.order.v1` JSON on stdin.
- Accept only the correlated `orange.ae-phase.order-result.v1` response and its `orange.report.v1` staff reports as completion evidence.
- Codex, Claude, Atomic Orange, OrangeBrain, Navigator, Hermes, and every other model or client use this same path. There is no privileged model bypass.
- Local processes may use loopback IPC. Cross-node HTTP and SSH are recovery, installation, and operator-diagnostic surfaces only; they are not the Orange work data plane.
- Large artifacts remain on disk and cross AE Phase as content-addressed, hash-attested references.
- Never call work complete because a process started or a packet was accepted. A terminal correlated report with evidence is required.
