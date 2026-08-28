// wave2-06-atomic-orange-three-lanes-aesee.workflow.mjs
// Apply the AESee visual upgrade pattern to Chat / Vault / Settings lanes.

export const meta = { name: 'wave2-06-atomic-orange-three-lanes-aesee', description: 'Atomic Orange Chat + Vault + Settings AESee visual upgrade', phases: [{title:'Author'},{title:'Integrate'}] }
const ROOT = 'C:/AtomEons/Orange5'
const APP = `${ROOT}/02-APP`
const SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const ISCHEMA = { type: 'object', properties: { build_smoke_ran: { type: 'boolean' }, build_smoke_passed: { type: 'boolean' }, build_smoke_output_tail: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } }, receipt_path: { type: 'string' } }, required: ['build_smoke_ran', 'build_smoke_passed', 'files_changed', 'receipt_path'], additionalProperties: false }

const CTX = `
READ ${APP}/STYLE_BRIEF.md FIRST. Apply same patterns as Cockpit upgrade (already shipped):
- OLED palette via :root vars, no Tailwind
- React 19 functional components
- prefers-reduced-motion respect
- Atom Standard taste anchors (Ive/Jobs/TE/Nintendo/Sachs)
- 60fps on N150 integrated graphics
- No code editor surface (Codeless Law)
- Each component <300 lines
Existing cockpit components for inspiration: ${APP}/src/components/cockpit/{OrgansGrid,OrganNode,OrbitLayer,BreathingCenter,LightStrand,CommandBar,IntentRail,RightRail}.tsx
`

phase('Author')
const components = [
  { id: 'chat-stream', prompt: `Author ${APP}/src/components/chat/StreamingMessage.tsx — renders an assistant message with token-streaming, citations to receipts inline (e.g. [receipt: 2026-06-25-xyz] becomes a clickable link), <recall>{query}</recall> tag rendering (shows the StateBrief result expandable). React 19, vanilla CSS. ${CTX}` },
  { id: 'chat-composer', prompt: `Author ${APP}/src/components/chat/Composer.tsx — bottom message input. Larger and warmer than Cockpit's CommandBar. Supports markdown preview, slash commands (/orange, /recall, /verify), file attach button (drops into Vault ingest pipe), Cmd/Ctrl+Enter submit. ${CTX}` },
  { id: 'chat-thread', prompt: `Author ${APP}/src/components/chat/Thread.tsx — scrollable message list. Each message gets a subtle organ-icon (which organ produced it: OrangeLLM-fatty / Smart Skinny / OrangeEye / Frontier). Auto-scroll on new. Click message → expand evidence/citations panel. ${CTX}` },
  { id: 'chat-lane-compose', prompt: `Replace ${APP}/src/lanes/Chat.tsx — wires Composer + Thread + StreamingMessage. Talks to gateway /v1/chat/completions with the memory-inject middleware doing its thing. ${CTX}` },
  { id: 'vault-dropzone', prompt: `Author ${APP}/src/components/vault/Dropzone.tsx — drag-drop ingest UI. POSTs to /v1/visual/ingest. Shows ingestion progress + per-page patch count. ${CTX}` },
  { id: 'vault-search', prompt: `Author ${APP}/src/components/vault/Search.tsx — MaxSim semantic search. Bottom bar: search input. Results below: page thumbnails (via /v1/visual/describe), score meters, click → full grounding overlay with bboxes. Integrates the OrangeEye-authored Vault.tsx patch at ${ROOT}/07-VISUAL/atomic-orange-patches/Vault.tsx. ${CTX}` },
  { id: 'vault-memory-panel', prompt: `Author ${APP}/src/components/vault/MemoryPanel.tsx — shows Mirage StateBrief for the current query. Reality-lane events as solid cards, Thought-lane as outlined, conflicts highlighted in amber with reality_wins note. ${CTX}` },
  { id: 'vault-lane-compose', prompt: `Replace ${APP}/src/lanes/Vault.tsx — wires Dropzone + Search + MemoryPanel. ${CTX}` },
  { id: 'settings-brain-tier', prompt: `Author ${APP}/src/components/settings/BrainTier.tsx — segmented selector for reflex|heavy|frontier. Active tier glows. Shows which model is bound to each tier (from /v1/models). ${CTX}` },
  { id: 'settings-frontier-key', prompt: `Author ${APP}/src/components/settings/FrontierKey.tsx — password input, localStorage-only, show/hide toggle, provider auto-detect (sk-* = Anthropic/OpenAI, AIza* = Google, gho_* = GitHub). Per Codeless Law, no key-rotation UI beyond paste + save. ${CTX}` },
  { id: 'settings-custom-rule', prompt: `Author ${APP}/src/components/settings/CustomRule.tsx — markdown text area for the operator's sticky rule that gets injected into every system message. Word count, preview. ${CTX}` },
  { id: 'settings-lane-compose', prompt: `Replace ${APP}/src/lanes/Settings.tsx — wires BrainTier + FrontierKey + CustomRule + force-orange-orders toggle + indicator-toggle + egress-mode + Save profile. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `lane:${c.id}`, schema: SCHEMA, effort: 'high' })))

phase('Integrate')
const integrate = await agent(`Integrate the 12 new components. Append ~150 lines of CSS to ${APP}/src/styles.css for the new component classes. Run \`cd ${APP} && npm run build\` for smoke. Capture last 30 lines of output. Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-atomic-orange-three-lanes-aesee.md with prior_receipt + hash_chain + build smoke result + honest gaps. DO NOT git commit/push. Components landed: ${JSON.stringify(results.filter(Boolean), null, 2)}. Return via StructuredOutput.`, { phase: 'Integrate', label: 'integrate', schema: ISCHEMA, effort: 'high' })
return { status: integrate?.build_smoke_passed ? 'green' : 'partial', components: results.filter(Boolean), integrate }
