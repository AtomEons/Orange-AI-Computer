# Legacy Rust/WGPU Cockpit

This directory preserves the standalone Rust, `wgpu`, and `egui` Atomic Orange
cockpit that previously occupied the application root. It is retained for
reference and future porting work, but it is not the shipping application or a
root build entrypoint.

The canonical Atomic Orange application is the Atomic Chat-derived Tauri
workspace at the repository root. Build, test, and development commands must be
run from that root through `yarn`.

To inspect the archived cockpit independently:

```powershell
cargo check --manifest-path legacy/rust-wgpu-cockpit/Cargo.toml
```

See [ORIGINAL_README.md](ORIGINAL_README.md) for the cockpit's preserved status
and design notes.
