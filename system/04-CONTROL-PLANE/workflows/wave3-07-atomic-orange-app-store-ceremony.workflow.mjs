// wave3-07-atomic-orange-app-store-ceremony.workflow.mjs
// Atomic Orange App Store ceremony — GitHub Releases packaging + auto-update channel + version metadata.
// Builds on Wave 3-01 (signed installer) — this is the DISTRIBUTION layer above signing.

export const meta = {
  name: 'wave3-07-atomic-orange-app-store-ceremony',
  description: 'GitHub Releases pipeline, auto-update channel, version metadata, changelog automation',
  phases: [
    { title: 'Author', detail: '8 parallel authors' },
    { title: 'Synth', detail: 'integration receipt' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'

const AUTHOR_SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const SYNTH_SCHEMA = { type: 'object', properties: { status: { enum: ['green', 'partial', 'red'] }, files_landed: { type: 'integer' }, receipt_path: { type: 'string' }, open_issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_landed', 'receipt_path', 'open_issues'], additionalProperties: false }

const CTX = `
Atomic Orange distribution ceremony doctrine:
- The Atomic Orange GitHub repo (Atom-Eons/atomic-orange, PRIVATE) is the canonical source. Distribution channel: GitHub Releases (private, operator-only initially).
- This workflow assumes Wave 3-01 signed-installer artifacts exist or will exist. Builds the release packaging + publishing flow ON TOP.
- Release naming: vMAJOR.MINOR.PATCH-PHASE (e.g. v0.1.0-night1, v0.2.0-recall-surface). Phase aligns to the 4-week month plan.
- Auto-update channel: tauri-plugin-updater feed at .well-known/updater.json hosted as a GitHub Pages site for the repo (OR served by the gateway if private).
- Changelog automation: derived from receipts in 10-RECEIPTS/orange5-build/ since last release tag. Hash-chain proof attached.
- Atomic Orange is NOT going to public app stores (Apple/MS Store) until much later. This ceremony covers private operator-distribution + family beta.
Quality: real gh CLI integration. Real changelog assembly from receipts. NO fake-green about pushing to public stores.
`

phase('Author')
const components = [
  { id: 'release-orchestrator', prompt: `Author ${ROOT}/02-APP/scripts/release.ps1 — Powershell release orchestrator. Flags: -Version, -Phase, -Channel (private|beta|stable). Steps: (1) verify git clean, (2) bump package.json + Cargo.toml + tauri.conf.json version, (3) generate changelog via changelog-from-receipts.mjs, (4) call build-all-installers.ps1 (Wave 3-01), (5) gh release create with assets + signed manifest, (6) publish updater.json to gh-pages. Refuses without TAURI_PRIVATE_KEY env. ${CTX}` },
  { id: 'changelog-from-receipts', prompt: `Author ${ROOT}/02-APP/scripts/changelog-from-receipts.mjs — Node script that reads 10-RECEIPTS/orange5-build/*.md since last git tag, parses receipt frontmatter, groups by category (feature|fix|doctrine|infra), writes CHANGELOG.md fragment. Each entry includes receipt_id + hash. Output also as JSON for the release body. ${CTX}` },
  { id: 'version-metadata', prompt: `Author ${ROOT}/02-APP/scripts/sync-version.mjs — single-source-of-truth version sync. Reads package.json version, asserts Cargo.toml package.version matches, asserts tauri.conf.json package.version matches. If mismatch, refuses (do not silently fix). CLI: node sync-version.mjs --check OR --bump=patch|minor|major --phase=night1. ${CTX}` },
  { id: 'updater-feed-publisher', prompt: `Author ${ROOT}/02-APP/scripts/publish-updater-feed.mjs — pushes the updater.json manifest to the gh-pages branch of Atom-Eons/atomic-orange. Uses gh CLI + a temp checkout. Verifies the manifest signature before pushing. Outputs the public URL. ${CTX}` },
  { id: 'github-release-template', prompt: `Author ${ROOT}/02-APP/scripts/release-body.template.md — markdown template used as the GitHub Release body. Placeholders: {{version}}, {{phase}}, {{changelog}}, {{receipt_chain_proof}}, {{sha256_table}}. Includes a "Mom's Law audit" section that lists honest gaps. ${CTX}` },
  { id: 'private-distribution-readme', prompt: `Author ${ROOT}/02-APP/scripts/PRIVATE_DISTRIBUTION.md — operator-facing README for the private family-beta distribution flow. Lists who gets access (Atom + 3 invited operators), how invites are added (gh repo collaborator), how to revoke. Honest: this is NOT a public app store; do not put Apple/MS Store badges anywhere. ${CTX}` },
  { id: 'updater-client-config', prompt: `Read ${ROOT}/02-APP/src-tauri/tauri.conf.json and produce the updater endpoint config update. Endpoint: https://atom-eons.github.io/atomic-orange/updater.json. pubkey from env TAURI_UPDATER_PUBKEY. Author this as an additive patch ${ROOT}/02-APP/src-tauri/tauri.conf.updater.json that merges into the main conf at build time. ${CTX}` },
  { id: 'release-smoke', prompt: `Author ${ROOT}/02-APP/scripts/release-smoke.ps1 — smoke test that (a) runs sync-version.mjs --check, (b) runs changelog-from-receipts.mjs with a dry-run flag, (c) verifies updater-feed-builder.mjs produces a valid signed manifest, (d) does NOT actually fire gh release create. Output: smoke-report.json. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `appstore:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' })))

phase('Synth')
const synth = await agent(`Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-26-wave3-07-atomic-orange-app-store-ceremony.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. prior_receipt + hash_chain. Honest gaps: actual gh release publishing requires operator presence (signing key + gh auth). No public app store integration. Mom's Law. Return via StructuredOutput.`, { phase: 'Synth', label: 'synth', schema: SYNTH_SCHEMA, effort: 'high' })
return { status: synth?.status || 'unknown', components: results.filter(Boolean), synth }
