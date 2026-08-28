// wave3-01-atomic-orange-tauri-signed-installer.workflow.mjs
// Atomic Orange Tauri signed installer pipeline (W4 endurance gate prerequisite).
// Builds the cross-platform signing/notarization ceremony + NSIS/.dmg/.AppImage + updater metadata.

export const meta = {
  name: 'wave3-01-atomic-orange-tauri-signed-installer',
  description: 'Signed installer pipeline: Authenticode Windows, notarized macOS, AppImage Linux, updater feed',
  phases: [
    { title: 'Author', detail: '9 parallel authors' },
    { title: 'Synth', detail: 'integration receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
Atomic Orange installer doctrine (read 02-APP/src-tauri/tauri.conf.json + 02-APP/package.json first):
- Existing stack: Tauri 2 + React 19 + Vite 6 (already builds). Currently UNSIGNED. We need code-signed + notarized + updater-feed-equipped for the W4 endurance gate.
- Windows: Authenticode cert via signtool, NSIS installer target, optional code-signing service for CI.
- macOS: Developer ID Application cert via codesign + xcrun notarytool submission + stapling, .dmg target.
- Linux: GPG-signed AppImage with embedded zsync metadata.
- Updater: tauri-plugin-updater wired to GitHub Releases (Atom-Eons/atomic-orange). Signed update manifest at .well-known/updater.json. Public key checked into repo; private key in operator-only env.
- Silent install: NSIS /S flag, .pkg --target=CurrentUserHomeDirectory, AppImage chmod+x.
- Quality bar: every secret is operator-supplied at sign time, never checked in. README documents the ceremony explicitly. Powershell scripts run on the operator's N150.
`

phase('Author')
const components = [
  { id: 'tauri-conf-prod', prompt: `Author production-mode ${ROOT}/02-APP/src-tauri/tauri.conf.json updates (additive — DO NOT remove existing dev config). Add bundle.windows.certificateThumbprint (env ATOM_AUTH_THUMBPRINT), bundle.windows.timestampUrl (DigiCert RFC 3161). Add bundle.macOS.entitlements path + bundle.macOS.signingIdentity (env ATOM_MAC_IDENTITY). Add bundle.linux.appimage with sign=true + signKey (env ATOM_GPG_KEY_ID). Add updater config: pubkey + endpoints. Output a unified replacement file. ${CTX}` },
  { id: 'sign-windows-ps1', prompt: `Author ${ROOT}/02-APP/scripts/sign-windows.ps1 — Powershell signing ceremony script. Inputs (env): ATOM_AUTH_PFX_PATH, ATOM_AUTH_PFX_PASSWORD, ATOM_AUTH_TIMESTAMP_URL. Steps: locate signtool, sign atomic-orange.exe + nsis installer .exe, verify chain, output sha256 of signed artifacts. Refuse on missing env vars (no fake-green). ${CTX}` },
  { id: 'sign-macos-sh', prompt: `Author ${ROOT}/02-APP/scripts/sign-macos.sh — bash signing + notarization ceremony for macOS. Env: ATOM_MAC_IDENTITY, ATOM_MAC_APPLE_ID, ATOM_MAC_TEAM_ID, ATOM_MAC_APP_PASSWORD (app-specific). Steps: codesign --options=runtime, build .dmg, submit to notarytool, wait, staple. Verify with spctl. ${CTX}` },
  { id: 'sign-linux-sh', prompt: `Author ${ROOT}/02-APP/scripts/sign-linux.sh — bash GPG signing + zsync generation for AppImage. Env: ATOM_GPG_KEY_ID, ATOM_GPG_PASSPHRASE_FILE. Steps: gpg --detach-sign atomic-orange.AppImage, zsyncmake for delta updates, output signed bundle. ${CTX}` },
  { id: 'entitlements-plist', prompt: `Author ${ROOT}/02-APP/src-tauri/entitlements.plist — Apple Developer entitlements XML. Includes com.apple.security.cs.allow-jit (false), com.apple.security.network.client (true), com.apple.security.files.user-selected.read-write (true). Hardened runtime mandatory. ${CTX}` },
  { id: 'updater-feed-builder', prompt: `Author ${ROOT}/02-APP/scripts/build-updater-feed.mjs — Node script that reads dist/bundle/* artifacts, computes sha256s, generates the .well-known/updater.json manifest with version, pub_date, platforms.{windows-x86_64, darwin-aarch64, darwin-x86_64, linux-x86_64}.{signature, url}. Signs the manifest with the operator's Tauri updater private key (env TAURI_PRIVATE_KEY + TAURI_KEY_PASSWORD). Validates against tauri-plugin-updater schema. ${CTX}` },
  { id: 'build-all-installers', prompt: `Author ${ROOT}/02-APP/scripts/build-all-installers.ps1 — orchestrator PS1 that runs: npm ci, npm run build, tauri build (cross-platform via env), then dispatches to sign-windows / sign-macos / sign-linux based on $env:OS or explicit -Target flag. Computes final sha256 manifest, writes to 10-RECEIPTS/orange5-build/atomic-orange-installer-build.json. Refuses to proceed on uncommitted git changes. ${CTX}` },
  { id: 'installer-smoke-test', prompt: `Author ${ROOT}/02-APP/scripts/installer-smoke-test.ps1 — silent install + launch + version probe + uninstall ceremony, run after a signed build. Asserts version matches package.json, signature chain validates, uninstaller clean. Output a JSON receipt fragment for the Synth phase to roll up. ${CTX}` },
  { id: 'installer-readme', prompt: `Author ${ROOT}/02-APP/scripts/SIGNED_INSTALLER_CEREMONY.md — operator-facing README documenting the full sign+notarize+release ceremony. Lists every env var, every secret, every prerequisite (Apple Dev account, EV cert, GPG keypair, Tauri updater keypair). Honest gaps: "GitHub Releases upload step still manual until operator wires gh release create" — DO NOT claim CI integration that doesn't exist. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `installer:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-26-wave3-01-tauri-signed-installer.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt from latest receipt file. Hash chain forward. Honest gaps: no actual signed bundle yet (waits on operator providing certs + running build-all-installers.ps1 with secrets in env). Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
