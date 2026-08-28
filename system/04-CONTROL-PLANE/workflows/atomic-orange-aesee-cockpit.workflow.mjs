// atomic-orange-aesee-cockpit.workflow.mjs
// Build the AESee Living Dashboard Cockpit visual layer per STYLE_BRIEF.md.
// Writes files into 02-APP/src/ but DOES NOT commit/push — operator approves what ships.

export const meta = {
  name: 'atomic-orange-aesee-cockpit',
  description: 'AESee Living Dashboard Cockpit components — organ-orbit constellation + light strands + bottom command bar + rails',
  phases: [
    { title: 'Author', detail: '7 parallel — constellation grid, organ node, orbit layer, breathing center, light strand, command bar, intent rail' },
    { title: 'Integrate', detail: 'wire components into Cockpit.tsx, append CSS to styles.css, smoke build' },
  ],
}

const ROOT = 'C:/AtomEons/Orange5'
const APP = `${ROOT}/02-APP`

const AUTHOR_SCHEMA = {
  type: 'object',
  properties: {
    component: { type: 'string' },
    files_written: { type: 'array', items: { type: 'string' } },
    line_counts: { type: 'object', additionalProperties: { type: 'integer' } },
    notes: { type: 'string' },
  },
  required: ['component', 'files_written', 'line_counts', 'notes'],
  additionalProperties: false,
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  properties: {
    cockpit_updated: { type: 'boolean' },
    styles_appended_lines: { type: 'integer' },
    build_smoke_ran: { type: 'boolean' },
    build_smoke_passed: { type: 'boolean' },
    build_smoke_output_tail: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    receipt_path: { type: 'string' },
    open_issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['cockpit_updated', 'styles_appended_lines', 'build_smoke_ran', 'build_smoke_passed', 'files_changed', 'receipt_path', 'open_issues'],
  additionalProperties: false,
}

const CONTEXT = `
You are building components per the operator's STYLE_BRIEF.md at ${APP}/STYLE_BRIEF.md.
READ THAT FILE FIRST before writing any code.

Stack reality:
- React 19, TypeScript 5.7, Vite 6, Tauri 2
- Vanilla CSS only — variables already in :root of ${APP}/src/styles.css
- NO Tailwind, NO styled-components, NO icon library
- Inline SVG for icons
- prefers-reduced-motion: reduce disables rotation/particles/breathing

Quality bar:
- Functional React 19 components (no class components)
- Proper TypeScript types
- 60fps on N150 (4 cores, integrated graphics, 1920x1080) — use CSS animations not requestAnimationFrame where possible
- ARIA labels on interactive elements
- Each file <300 lines; if you'd need more, split into sub-components
- The brand is Orange5 (Orangebox is retired)
`

phase('Author')

const components = [
  {
    id: 'organ-node',
    prompt: `Author the OrganNode component — single orbit point with state pill + percent meter.

Write to ${APP}/src/components/cockpit/OrganNode.tsx.

Props: { name, role (short subtitle), color (CSS var or hex), x, y, state ('idle'|'building'|'verifying'|'planning'|'testing'|'live'|'blocked'), percent (0-100|null), hot (bool — adds --stroke-hot glow), icon (ReactNode), onClick }.

Visual: a circle node (~52px) with the icon centered. Below the node, a horizontal pill showing the role subtitle. To the right of the pill, a tiny percent meter (gradient fill, 60px wide, 4px tall). When hot: outer ring glow via box-shadow + the --stroke-hot color. When state='live': solid color fill. When state='blocked': red dim.

Animations:
- Hot pulse: 3s breathing on the outer glow
- State transition: 200ms color/opacity
- Click: subtle scale 0.97 on press

Position controlled by absolute x,y from parent OrgansGrid.

${CONTEXT}`,
  },
  {
    id: 'orbit-layer',
    prompt: `Author the OrbitLayer component — the concentric ring renderer with slow rotation.

Write to ${APP}/src/components/cockpit/OrbitLayer.tsx.

Props: { rings (array of {radius, dotCount, direction: 'cw'|'ccw', speedSec}), centerX, centerY }.

Renders an absolutely positioned <svg> overlay covering its parent. For each ring:
- One <circle> with stroke-dasharray to give it a delicate dotted appearance (use --stroke color, opacity 0.3)
- N small <circle> dots distributed evenly around the ring, all rotating together via CSS @keyframes (transform: rotate)
- Counter-rotating: alternate direction per ring

CSS animations defined inline via style + a small <style> block scoped to this component (use unique class names like orbit-r-<idx> to avoid collisions). Add the keyframes to the supplementary CSS file at ${APP}/src/components/cockpit/cockpit-anim.css instead of inline if cleaner.

Honors prefers-reduced-motion: when set to reduce, kill all rotation.

${CONTEXT}`,
  },
  {
    id: 'breathing-center',
    prompt: `Author the BreathingCenter component — the glowing lattice/fruit at dead center.

Write to ${APP}/src/components/cockpit/BreathingCenter.tsx.

Props: { size (default 280), intensity (number 0-1 — pulse speed multiplier), color (default --orange) }.

Visual: a layered SVG composition:
- Outer halo: 3 concentric rings with decreasing opacity, each ~10% wider, animated breathing
- Mid layer: hexagonal lattice (use a simple SVG <path> for an inscribed hexagon star)
- Inner: bright orange core with radial gradient
- 40-60 small dots scattered in a circle around the lattice — particles

Pulse: 4s default, scaled by intensity (intensity=2 means 2s pulse). When intensity > 1.5, particles flow outward continuously.

Animation via CSS @keyframes (defined in cockpit-anim.css). Use transform-origin: center and ease-in-out timing.

prefers-reduced-motion: static brightness, no pulse, no particles.

${CONTEXT}`,
  },
  {
    id: 'light-strand',
    prompt: `Author the LightStrand component — the connective arc between two organs with flowing dots.

Write to ${APP}/src/components/cockpit/LightStrand.tsx.

Props: { x1, y1, x2, y2, intensity (0-1 — controls particle density and speed), color (default --orange), strength ('thin'|'normal'|'thick') }.

Visual: A cubic bezier <path> arcing between the two points. The path itself uses stroke with low opacity. Then 3-5 small <circle> particles travel along the path using CSS offset-path: path('...'). New particle every 1.5s when intensity > 0.5, every 4s when lower.

Particles fade in over the first 10% of the path, fade out over the last 10%. Path length detected via getTotalLength() so distribution is even.

Sub-component flow controllable: passable as <LightStrand from="organ-id-1" to="organ-id-2" />. Parent (OrgansGrid) resolves coordinates from organ IDs.

prefers-reduced-motion: keep the static path stroke, kill the moving particles.

${CONTEXT}`,
  },
  {
    id: 'command-bar',
    prompt: `Author the CommandBar component — the bottom input + four action chips.

Write to ${APP}/src/components/cockpit/CommandBar.tsx.

Props: { onOrder (callback receiving {action: 'build'|'decide'|'verify'|'ship', text}), inputValue, onChange, disabled }.

Visual: A wide horizontally-centered input field. Placeholder: 'Order Orange5...'. Outer glowing orange-stroked container with --stroke-hot at full opacity. Submit icon on the right (inline SVG arrow inside a circle button).

Below the input: 4 chip buttons aligned center: BUILD (hammer/build SVG), DECIDE (compass SVG), VERIFY (check-circle SVG), SHIP (paper-plane or rocket SVG). Active chip has orange-hot background; inactive chips are dim transparent.

When user types + presses Enter OR clicks the submit arrow: emits onOrder with currently-selected action (default: build).

When user clicks a chip: it becomes active; the chip-active state is the action that ships with the next Enter.

Keyboard: Cmd/Ctrl+Enter submits regardless of focus position.

Use JetBrains Mono font for the input value itself (it's a command), Inter for chip labels.

${CONTEXT}`,
  },
  {
    id: 'organs-grid',
    prompt: `Author the OrgansGrid container component — the master layout for the center constellation.

Write to ${APP}/src/components/cockpit/OrgansGrid.tsx.

This is the parent that composes: OrbitLayer (background rings), BreathingCenter (middle), 8 OrganNode instances (positioned on the orbit rings), and active LightStrand instances connecting organs that have data flow between them.

Props: { width=900, height=900, organs (array of {id, name, role, color, state, percent, icon, ring: 0|1|2}), flows (array of {from_organ_id, to_organ_id, intensity}) }.

Compute organ positions: ring 0 = innermost (4 organs at compass positions), ring 1 = outer (4 organs at intercardinal positions). Use trig: const angle = (idx / count) * Math.PI * 2 - Math.PI/2; const x = cx + r*Math.cos(angle); const y = cy + r*Math.sin(angle).

For Orange5 the 8 organs are (assign 4 inner + 4 outer):
- INNER (ring 0): OrangeLLM (top, color=orange), AE Flow (right, color=orange-2), Æ Cobra (bottom, color=green), Hermes (left, color=amber)
- OUTER (ring 1): OrangeEye (top-right, color=blue), Mirage (bottom-right, color=orange), AtomSmasher (bottom-left, color=violet), ToolMesh (top-left, color=green)

Renders OrbitLayer for the ring decoration, then BreathingCenter, then each LightStrand, then each OrganNode. Render order matters — strands underneath nodes.

${CONTEXT}`,
  },
  {
    id: 'intent-rail',
    prompt: `Author the IntentRail component — the left-side current-intent panel.

Write to ${APP}/src/components/cockpit/IntentRail.tsx.

Props: { currentIntent: { title, states: string[], percent }, nextAction: { text, onClick }, context: string[] (max 5), constraints: string[] (max 6), onClickIntent? }.

Visual: vertical stack of 4 cards. Each card has --panel-2 background, --stroke border, --shadow lift.

Card 1: 'CURRENT INTENT' header (small caps, --muted). Big title. Row of state pills (BUILD / VERIFY / SHIP variants with appropriate colors). Progress bar (--orange fill).
Card 2: 'NEXT ACTION' header. Single sentence + arrow icon button.
Card 3: 'CONTEXT' header. Vertical list of context items each with an icon + label.
Card 4: 'CONSTRAINTS' header. Vertical list of bullets with small filled-circle markers (color-coded for met/at-risk/breached).

This component reads from AE Flow's currents API (placeholder: hardcode demo data for first build, wire to /v1/flow/current later).

${CONTEXT}`,
  },
]

log(`Fanning out ${components.length} AESee Cockpit component authors in parallel.`)

const results = await parallel(
  components.map(c => () => agent(c.prompt, { phase: 'Author', label: `aesee:${c.id}`, schema: AUTHOR_SCHEMA, effort: 'high' }))
)

phase('Integrate')

const integrate = await agent(
  `You are the integration agent for the AESee Cockpit upgrade.

The 7 author agents have landed components under ${APP}/src/components/cockpit/.
Files written so far:
${JSON.stringify(results.filter(Boolean), null, 2)}

NOW DO:

1. Read ${APP}/src/Cockpit.tsx and REPLACE its body with a version that:
   - imports the 7 new components from ./components/cockpit/
   - composes them per the AESee render: top status row + left IntentRail + center OrgansGrid + right rail (placeholder cards for LivingFeed / ModelRouting / ReceiptTrail — author tiny stub components inline at ${APP}/src/components/cockpit/RightRail.tsx) + bottom CommandBar + bottom-left pipeline pulse placeholder
   - uses the existing useOrangeSnapshot hook for /healthz + /v1/models live state
   - hardcodes the 8 organs and ~6 light strands for the first build (real data wiring is a follow-up task)

2. Read ${APP}/src/styles.css. APPEND (do not replace) ~80-150 lines of new CSS at the END for: .cockpit-aesee-wrap, .organs-grid, .organ-node, .organ-pill, .breathing-center, .light-strand, .command-bar, .intent-rail, .right-rail, .pipeline-pulse — plus the keyframes for breathing, orbit rotation, particle flow.

3. Run a build smoke: cd ${APP}; npm run build (give it 60s; the tsc step catches missing imports / type errors). Capture last 30 lines of output.

4. Write the receipt to ${ROOT}/10-RECEIPTS/orange5-build/2026-06-24-atomic-orange-aesee-cockpit-authored.md.
   - prior_receipt + hash_chain
   - Component list
   - Build smoke result
   - Honest gaps: data wiring still placeholder, RightRail components are stubs, no real flow-state integration yet
   - Mom's Law
   - Hash chain footer

5. DO NOT git commit. DO NOT git push. The atomic-orange repo is now shared with ChatGPT; operator decides what gets pushed.

Return via StructuredOutput.`,
  { phase: 'Integrate', label: 'integrate', schema: INTEGRATE_SCHEMA, effort: 'high' }
)

return { status: integrate?.build_smoke_passed ? 'green' : 'partial', components: results.filter(Boolean), integrate }
