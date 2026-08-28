// registry.mjs — single source of truth for the 27 Constitutional Guardrails.
//
// Each entry is an invariant the Orange5 system MUST preserve at runtime.
// IDs are stable (G01..G27). Severities: CRITICAL stops promotion; HIGH halts
// new writes; MEDIUM emits a warning; LOW is informational.
//
// Doctrine sources cited:
//   - C:\Users\a\.claude\CLAUDE.md (Standing Law, Spiral Reasoning)
//   - C:\AtomEons\.claude\rules\*.md (Mom's Law, teams, receipts, misfit)
//   - 00-CHARTER/NAMING_CANON.md
//   - 06-ORANGELLM/FRONTIER_ISOLATION_BOUNDARY.md
//   - 02-APP/src/router.tsx (four lanes)
//
// Each check module under ./checks/ exports an async run() returning
// { pass: boolean, details: string|object }. The runtime resolves the
// guardrail's id, name, and severity from this registry — checks themselves
// do not need to re-declare them.

export const GUARDRAILS = Object.freeze([
  {
    id: "G01",
    name: "runtime/node.py is sole authoritative cognitive center",
    severity: "CRITICAL",
    doctrine: "ÆSkill Suite V1.4 invariant",
    check_module: "g01-runtime-node-sole-authority.mjs",
  },
  {
    id: "G02",
    name: "FOUNDER_SALARY_PER_INSTALL_CENTS is env-bound, not hardcoded",
    severity: "CRITICAL",
    doctrine: "ÆSkill Suite V1.4 invariant",
    check_module: "g02-founder-salary-env-bound.mjs",
  },
  {
    id: "G03",
    name: "Gate 0 LatticeIntegrityGate (LBCE) is first in every gate chain",
    severity: "CRITICAL",
    doctrine: "ÆSkill Suite V1.4 invariant",
    check_module: "g03-gate-0-lbce-first.mjs",
  },
  {
    id: "G04",
    name: "Human Final Stop is reachable from any autonomous-action path",
    severity: "CRITICAL",
    doctrine: "ÆSkill Suite V1.4 invariant + Charter",
    check_module: "g04-human-final-stop.mjs",
  },
  {
    id: "G05",
    name: "ATOMEONS_IDENTITY_SECRET is env-only, never hardcoded",
    severity: "CRITICAL",
    doctrine: "ÆSkill Suite V1.4 invariant",
    check_module: "g05-identity-secret-env-only.mjs",
  },
  {
    id: "G06",
    name: "Frontier work routed only via the frontier gateway",
    severity: "HIGH",
    doctrine: "PR-02 Frontier Isolation Boundary",
    check_module: "g06-frontier-via-gateway-only.mjs",
  },
  {
    id: "G07",
    name: "No code editor in the operator surface (4-lane app)",
    severity: "HIGH",
    doctrine: "Orange5 Master Plan / lane discipline",
    check_module: "g07-no-code-editor-in-operator-surface.mjs",
  },
  {
    id: "G08",
    name: "The 4 operator lanes (Chat / Cockpit / Vault / Settings) are immutable",
    severity: "CRITICAL",
    doctrine: "PR-01 native rail",
    check_module: "g08-four-lanes-immutable.mjs",
  },
  {
    id: "G09",
    name: "Mom's Law sits above all other rules",
    severity: "CRITICAL",
    doctrine: "C:\\AtomEons\\.claude\\rules\\00-moms-law.md",
    check_module: "g09-moms-law-above-all.mjs",
  },
  {
    id: "G10",
    name: "Receipts are hash-chained (every receipt references prior_sha256)",
    severity: "HIGH",
    doctrine: "PR-build receipts ladder",
    check_module: "g10-receipts-hash-chained.mjs",
  },
  {
    id: "G11",
    name: "No fake-green words in commit messages (passing/green/done without evidence)",
    severity: "HIGH",
    doctrine: "Mom's Law + 03-build-and-receipts.md",
    check_module: "g11-no-fake-green-commits.mjs",
  },
  {
    id: "G12",
    name: "Reality Flux lane discipline — reality writes are receipt-origin only",
    severity: "HIGH",
    doctrine: "11-MIRAGE flux.mjs lane discipline",
    check_module: "g12-reality-lane-discipline.mjs",
  },
  {
    id: "G13",
    name: "Frontier loopback (:7419) never exposed to non-loopback interface",
    severity: "CRITICAL",
    doctrine: "06-ORANGELLM/FRONTIER_ISOLATION_BOUNDARY.md",
    check_module: "g13-frontier-loopback-only.mjs",
  },
  {
    id: "G14",
    name: "Soul Genome JSON exists and is well-formed",
    severity: "HIGH",
    doctrine: "Spiral Reasoning anchor — Soul Genome continuity",
    check_module: "g14-soul-genome-present.mjs",
  },
  {
    id: "G15",
    name: "Continuity Packet for previous day exists by 06:00 local",
    severity: "MEDIUM",
    doctrine: "Continuity Packet daily auto-write",
    check_module: "g15-continuity-packet-present.mjs",
  },
  {
    id: "G16",
    name: "No simulation of real people (persona phrases blocked)",
    severity: "HIGH",
    doctrine: "ÆSkill Suite HRE — anti-simulation",
    check_module: "g16-no-simulation-of-real-people.mjs",
  },
  {
    id: "G17",
    name: "Ledger emission shape — every deliverable has zip + sha256 + row",
    severity: "MEDIUM",
    doctrine: "ÆSkill Suite atomeons-ledger",
    check_module: "g17-ledger-emission-shape.mjs",
  },
  {
    id: "G18",
    name: "GPT > Gemini on trilane conflict (model hierarchy preserved)",
    severity: "LOW",
    doctrine: "ÆSkill Suite trilane model hierarchy",
    check_module: "g18-trilane-hierarchy.mjs",
  },
  {
    id: "G19",
    name: "Spiral Reasoning anchor (z_0 = Soul Genome) is set",
    severity: "MEDIUM",
    doctrine: "Spiral Reasoning v3 — bounded angle alpha",
    check_module: "g19-spiral-anchor-set.mjs",
  },
  {
    id: "G20",
    name: "Belief angle alpha is bounded (no runaway curvature)",
    severity: "MEDIUM",
    doctrine: "Spiral Reasoning Belief Discipline",
    check_module: "g20-belief-angle-bounded.mjs",
  },
  {
    id: "G21",
    name: "Receipts directory exists and is writable",
    severity: "HIGH",
    doctrine: "10-RECEIPTS doctrine",
    check_module: "g21-receipts-dir-writable.mjs",
  },
  {
    id: "G22",
    name: "Reality Flux daemon reachable (cobra or shadow cache)",
    severity: "MEDIUM",
    doctrine: "11-MIRAGE adapter — healthz",
    check_module: "g22-reality-flux-reachable.mjs",
  },
  {
    id: "G23",
    name: "Misfit beta is governed (no silent canon drift)",
    severity: "MEDIUM",
    doctrine: "05-misfit-frontier.md",
    check_module: "g23-misfit-governed.mjs",
  },
  {
    id: "G24",
    name: "Release-steward authority preserved — no specialist self-upgrades",
    severity: "HIGH",
    doctrine: "01-teams-and-authority.md",
    check_module: "g24-release-steward-authority.mjs",
  },
  {
    id: "G25",
    name: "No --no-verify or --no-gpg-sign in recent commits (hooks honored)",
    severity: "HIGH",
    doctrine: "Mom's Law — receipts not skipped",
    check_module: "g25-no-hook-skip.mjs",
  },
  {
    id: "G26",
    name: "Standing routing law honored - OrangeFive governed spine referenced",
    severity: "LOW",
    doctrine: "Standing Law 2026-06-18",
    check_module: "g26-routing-law-honored.mjs",
  },
  {
    id: "G27",
    name: "27-guardrails registry has exactly 27 entries (self-check)",
    severity: "CRITICAL",
    doctrine: "Self-referential invariant",
    check_module: "g27-self-count.mjs",
  },
]);

export const GUARDRAILS_BY_ID = Object.freeze(
  Object.fromEntries(GUARDRAILS.map((g) => [g.id, g]))
);

export const SEVERITIES = Object.freeze(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
