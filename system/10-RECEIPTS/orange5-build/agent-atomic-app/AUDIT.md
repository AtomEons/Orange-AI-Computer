# Atomic Orange V1 focused audit

Date: 2026-08-27
Scope: `C:\AtomEons\Orange5\02-ATOMIC-ORANGE-V1`
Receipt root: `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\agent-atomic-app`

## Outcome

- Source/config files changed by this audit: none.
- Dependency installs or additions: none.
- OrangeFive health: passed.
- OrangeFive configuration/live handshake: passed.
- OrangeFive governed roundtrip transport/receipt contract: passed.
- Web TypeScript release typecheck: passed.
- Focused Vitest result: blocked; Vitest reached startup but emitted no test result in both the seven-file and one-file attempts.
- Vite production build result: incomplete; transform began but did not finish in the closure window and was terminated.
- Existing Windows executable launch probe: passed; a new process survived 10 seconds and was stopped by PID.
- Existing Windows NSIS package: present and SHA-256 recorded.
- Authenticode: executable and installer are unsigned.

## Commands

1. `bun C:/AtomEons/Orange5/03-BACKEND/spine-cli.mjs --health`
2. `corepack.cmd yarn verify:orangefive`
3. `corepack.cmd yarn workspace @janhq/web-app vitest --run <seven Orange-focused test files>`
4. `node_modules/.bin/vitest.cmd --run src/lib/__tests__/orange-crossing.test.ts --maxWorkers=1`
5. `bun scripts/verify-orangefive-handshake.mjs --roundtrip` with `ATOMIC_ORANGE_ROUNDTRIP_TIMEOUT_MS=60000`
6. `node_modules/.bin/tsc.cmd -b` from `web-app`
7. `node_modules/.bin/vite.cmd build` from `web-app`
8. PowerShell `Start-Process` launch probe for `src-tauri/target/release/Atomic-Chat.exe`
9. PowerShell SHA-256 and Authenticode inspection for the executable and NSIS package.

## Windows artifacts

- `src-tauri/target/release/Atomic-Chat.exe`
  - Bytes: 47,648,256
  - SHA-256: `a45f4cfbd7c22cd736d44779e484eeb74f282e9e9eec9b6644597a38541a967c`
- `src-tauri/target/release/bundle/nsis/Atomic Orange_1.0.0_x64-setup.exe`
  - Bytes: 74,841,833
  - SHA-256: `c802be17008b7610e3504dfff68a5cbbe5a57585d8515c48d29aaebd51d56ccf`

See numbered logs and JSON receipts in this folder for raw evidence.
