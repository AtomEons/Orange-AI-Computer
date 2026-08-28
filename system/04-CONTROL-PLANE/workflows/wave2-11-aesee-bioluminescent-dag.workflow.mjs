// wave2-11-aesee-bioluminescent-dag.workflow.mjs — AESee Living Dashboard expansion: Bioluminescent DAG full.

export const meta = { name: 'wave2-11-aesee-bioluminescent-dag', description: 'AESee Bioluminescent DAG + Perspective Filters + Whisper Prompts + Semantic Time Scrubber', phases: [{title:'Author'},{title:'Integrate'}] }
const ROOT = 'C:/AtomEons/Orange5'
const APP = `${ROOT}/02-APP`
const SCHEMA = { type: 'object', properties: { component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } }, line_counts: { type: 'object', additionalProperties: { type: 'integer' } }, notes: { type: 'string' } }, required: ['component', 'files_written', 'line_counts', 'notes'], additionalProperties: false }
const ISCHEMA = { type: 'object', properties: { build_smoke_ran: { type: 'boolean' }, build_smoke_passed: { type: 'boolean' }, build_smoke_output_tail: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } }, receipt_path: { type: 'string' } }, required: ['build_smoke_ran', 'build_smoke_passed', 'files_changed', 'receipt_path'], additionalProperties: false }

const CTX = `
AESee Living Dashboard full expansion (the operator's HELD-project unlock):
- Bioluminescent DAG: luminous orb mission graph with state-colored nodes (orange=current, gold=approval-needed, green=closed, dim grey=pending, red pulse=blocked), gradient edges with flowing dots, department constellations.
- Trinity Layout: Vision Rail (left) + Command Center (center) + Artifact Library (right).
- Whisper Prompts: subtle hint overlays that appear contextually (hover near an organ → suggested actions, near a current → suggested next moves).
- Perspective Filters: Operator / CEO / CMO / IT / PM views that re-emphasize different parts of the dashboard.
- Semantic Time Scrubber: a horizontal slider that scrubs through history with semantic anchors (receipts, decisions, blockers) — UI is read-only (Codeless Law).
- 72-state mockup bank: the design spec the operator referenced earlier.
This BUILDS ON the AESee Cockpit (receipt #023) — adds the next layer.
Read ${APP}/STYLE_BRIEF.md FIRST. Real React 19 + vanilla CSS. 60fps on N150.
`

phase('Author')
const components = [
  { id: 'dag-graph-renderer', prompt: `Author ${APP}/src/components/aesee/DagGraph.tsx — SVG renderer for the mission DAG. Takes nodes[] + edges[]. Each node = an organ or mission with state-colored core + glow. Each edge = gradient line with flowing dots in direction. Auto-layout via D3-force-like spring (inline impl, no deps). ${CTX}` },
  { id: 'dag-node', prompt: `Author ${APP}/src/components/aesee/DagNode.tsx — single DAG node. Props: id, state, label, percent, kind. Builds on cockpit/OrganNode aesthetic. State colors per spec: orange=current, gold=approval-needed, green=closed, grey=pending, red-pulse=blocked. ${CTX}` },
  { id: 'dag-edge', prompt: `Author ${APP}/src/components/aesee/DagEdge.tsx — single DAG edge. Cubic bezier with gradient stroke (color from source-state → target-state). Particles flow along via CSS offset-path. Reuses LightStrand pattern. ${CTX}` },
  { id: 'trinity-layout', prompt: `Author ${APP}/src/components/aesee/TrinityLayout.tsx — Vision Rail (left) + Command Center (center) + Artifact Library (right). Three-column grid. Width ratios 2:5:2. Existing Cockpit components compose in. ${CTX}` },
  { id: 'whisper-prompts', prompt: `Author ${APP}/src/components/aesee/WhisperPrompt.tsx + WhisperContext.tsx — context provider + overlay. Hover near any DOM element with data-whisper="<hint>" surfaces a soft toolip. Hover near organ → shows suggested orange.order.v1 actions. Hover near receipt → shows summary. ${CTX}` },
  { id: 'perspective-filter', prompt: `Author ${APP}/src/components/aesee/PerspectiveFilter.tsx — top-right pill selector: Operator / CEO / CMO / IT / PM. Each view re-emphasizes different panels (CEO view dims cockpit, surfaces ROI + status). Persists in localStorage. ${CTX}` },
  { id: 'time-scrubber', prompt: `Author ${APP}/src/components/aesee/TimeScrubber.tsx — horizontal slider at bottom of dashboard. Reads recent receipts + AE Flow ticks. Semantic anchors are nodes on the scrubber timeline (orange dot per receipt, gold for high-risk). Drag → triggers Mirage StateBrief with the timestamp + renders that historical state into the dashboard. READ-ONLY scrubbing (Codeless Law). ${CTX}` },
  { id: 'artifact-library', prompt: `Author ${APP}/src/components/aesee/ArtifactLibrary.tsx — right rail. Vertical list of recent artifacts (receipts, atoms, missions, gauntlets). Click → opens artifact in a modal overlay (markdown render). Filter by type. ${CTX}` },
  { id: 'aesee-lane', prompt: `Author ${APP}/src/lanes/AESee.tsx — new lane that mounts TrinityLayout + DagGraph + WhisperPrompts + PerspectiveFilter + TimeScrubber + ArtifactLibrary. NOTE: This is a NEW lane — but the operator's 4-lanes-immutable law says no 5th lane. So: this AESee surface is mounted UNDER the existing Cockpit lane as an opt-in view toggle ("Standard view" vs "AESee view"). Cockpit.tsx gets a small selector to swap between the two views. ${CTX}` },
  { id: 'css-aesee', prompt: `Author ${APP}/src/components/aesee/aesee-anim.css — keyframes for DAG node pulse, edge flow, whisper fade-in, scrubber drag, perspective swap. ~200 lines. All respect prefers-reduced-motion. ${CTX}` },
]
const results = await parallel(components.map(c => () => agent(c.prompt, { phase: 'Author', label: `aesee:${c.id}`, schema: SCHEMA, effort: 'high' })))

phase('Integrate')
const integrate = await agent(`Integrate. Append CSS to ${APP}/src/styles.css. Wire AESee view into Cockpit lane as opt-in. \`cd ${APP} && npm run build\` for smoke. Write receipt at ${ROOT}/10-RECEIPTS/orange5-build/2026-06-25-aesee-bioluminescent-dag.md. Components: ${JSON.stringify(results.filter(Boolean), null, 2)}. NO git push. Return via StructuredOutput.`, { phase: 'Integrate', label: 'integrate', schema: ISCHEMA, effort: 'high' })
return { status: integrate?.build_smoke_passed ? 'green' : 'partial', components: results.filter(Boolean), integrate }
