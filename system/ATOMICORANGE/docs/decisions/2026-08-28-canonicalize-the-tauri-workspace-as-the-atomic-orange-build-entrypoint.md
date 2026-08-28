---
date: 2026-08-28
title: "Canonicalize the Tauri workspace as the Atomic Orange build entrypoint"
---

# Canonicalize the Tauri workspace as the Atomic Orange build entrypoint

- **Context:** `system/ATOMICORANGE` contained two applications at its root.
  The current Atomic Chat-derived Tauri workspace used `package.json`,
  `web-app/`, and `src-tauri/`, while an earlier standalone Rust/WGPU cockpit
  also exposed a root `Cargo.toml` and `src/`. A root `cargo build` therefore
  selected the legacy cockpit even though release, frontend, and desktop work
  targeted Tauri.
- **Decision:** The root Yarn package is the single active application
  entrypoint. `yarn dev`, `yarn build`, `yarn test`, and `yarn check` operate on
  the Tauri application; `src-tauri/Cargo.toml` is its active Rust manifest.
  Frontend builds first build the shared `core` workspace so they work from a
  clean checkout. Focused CI invokes these root package scripts instead of
  reconstructing app commands independently.
- **Legacy preservation:** The standalone Rust/WGPU cockpit is retained without
  source changes under `legacy/rust-wgpu-cockpit/`, including its manifest,
  shaders, Rust modules, graphics notes, helper tools, and historical status
  notes. It is intentionally outside the active workspace and build flow.
- **Consequences:** The application root no longer has an ambiguous Cargo
  default. Packaging still uses the existing platform-specific Tauri scripts,
  tests still use the existing Vitest projects, and dependency declarations and
  lockfiles are unchanged. Legacy cockpit work must pass its manifest path
  explicitly.
- **Owner:** AtomEons Systems Laboratory.
- **Links:** `README.md`, `package.json`,
  `legacy/rust-wgpu-cockpit/README.md`, `src-tauri/Cargo.toml`.
