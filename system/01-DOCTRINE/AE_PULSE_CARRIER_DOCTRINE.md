# Æ Pulse Carrier Doctrine

Æ Pulse is not periodic health polling. It is a persistent, full-duplex carrier between Orange nodes. The carrier exists continuously while nodes are connected. Unchanged state transmits the smallest pulse frame. Changed state transmits only the variation: service path, work custody, pressure, capability, current Solar Wave state, or recovery condition.

```text
constant carrier cadence
-> tiny pulse while state is unchanged
-> authenticated variation frame when state changes
-> acknowledgement advances shared phase
-> missing phase proves link degradation
-> Cup selects another path
-> carrier resumes without losing work custody
```

The physical Ethernet signal remains the responsibility of network hardware. Orange does not pretend user-space code replaced the Ethernet PHY. Its invention is the operational carrier above it: service identity, persistent connection semantics, delta-only state, authenticated frames, path independence, and proof-preserving reconnection.

Every frame has fixed `AEP5` magic, protocol version, type, send sequence, acknowledged sequence, carrier time, bounded payload length, and optional HMAC. Payload exists only for a variation or handshake.

The carrier can announce node role, selected transport, Solar Wave identity and state, FLOW pressure, custody, capability-registry hash, blockers, and recovery. It never carries full transcripts, source documents, model context, or secrets. Those remain on disk and travel by typed reference.

Cup is the path layer. Æ Pulse is the current through the selected path. Cup evaluates direct Ethernet, loopback, hostname, Wi-Fi, and one-computer substitutes. Hysteresis prevents thrashing. Æ Pulse makes path failure visible and resumes state exchange after Cup selects a replacement.

Every pulse is not written to disk. Disk receives topology variations and bounded checkpoints. The current state file is atomic; the event stream is append-only.

Cortex is held. AE Eyes may contribute a visual-state variation only when active sensing is explicitly enabled and useful.
