// Orange5 / 04-CONTROL-PLANE / bakeoff / dimensions / mission-shape.mjs
//
// Dimension probe set: mission_shape
//
// What this dimension measures
// ----------------------------
// Does the model respond as an *executable mission* — concrete result,
// evidence, blockers, next action, scope — instead of essay drift, hedge
// prose, or vibe-shipped optimism?
//
// Doctrine anchor
// ---------------
// AtomEons constitution, Mom's Law, .claude/rules/03-build-and-receipts.md:
//   "Required output shape: result, evidence, blockers, next action."
//
// Scoring (deterministic, pure, total)
// ------------------------------------
// 1. Shape keys     up to 4 of {result, evidence, blockers, next action,
//                   next step, scope, objective, receipts}        -> 0.65
// 2. Bullet/number  presence of >=3 bullet or numbered lines      -> 0.35
// 3. Fake-green     any fake-green phrase                         -> -0.25
// 4. Drift          zero shape keys AND no newlines               -> -0.25
//
// Final score is clamped to [0, 1].
//
// Pure Node 20+. No IO, no Date, no Math.random. Importable by the harness
// as a probePack[dim] override; also runnable standalone for sanity checks.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DIMENSION = "mission_shape";

export const MISSION_SHAPE_KEYS = Object.freeze([
  "result",
  "evidence",
  "blockers",
  "next action",
  "next step",
  "scope",
  "objective",
  "receipts",
]);

// Same vocabulary as promotion-gate engine and harness — kept local so this
// file is self-sufficient.
export const FAKE_GREEN_WORDS = Object.freeze([
  "all green",
  "all good",
  "all set",
  "all systems go",
  "everything's fine",
  "everything is fine",
  "everything works",
  "looks good",
  "lgtm",
  "ship it",
  "we're good",
  "should be fine",
  "trust me",
]);

export const RUBRIC = Object.freeze({
  type: "regex_and_keyword",
  weights: { shape_keys: 0.65, bullet_structure: 0.35 },
  penalties: { fake_green: 0.25, drift: 0.25 },
  caps: { shape_keys: 4, bullets: 3 },
  range: [0, 1],
});

// ---------------------------------------------------------------------------
// Prompts — 12 probes
// ---------------------------------------------------------------------------

export const PROMPTS = Object.freeze([
  "Plan the promotion of a candidate change that adds a new bakeoff dimension. Return mission shape.",
  "We need to rotate the founder identity secret. Output as mission, not essay.",
  "Stand up a new Pathwaves route for misfit-rebels intake.",
  "A test in the promotion-gate suite is flaking. Issue a containment mission.",
  "Schedule a Knowledge Strata compile pass for last week's intake.",
  "Promote candidate change C-2026-019 through the gate. Show your work.",
  "Decommission a deprecated room view without breaking shared primitives.",
  "A receipt is missing for last Tuesday's deploy. Open a recovery mission.",
  "Tighten the CLR-K5 threshold from 0.50 to 0.55 across all lanes.",
  "Backfill bakeoff results for the last 3 candidate changes.",
  "Onboard a new test-engineer subagent to the release-steward lane.",
  "Rebuild the Mirage fixture pack for the Hermes verification gate.",
]);

// ---------------------------------------------------------------------------
// Helpers (local copies; small, total, pure)
// ---------------------------------------------------------------------------

function lower(s) {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function clamp01(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function countDistinctHits(text, needles) {
  const t = lower(text);
  let n = 0;
  for (const w of needles) {
    if (t.includes(w.toLowerCase())) n += 1;
  }
  return n;
}

function hasFakeGreen(text) {
  const t = lower(text);
  for (const w of FAKE_GREEN_WORDS) {
    if (t.includes(w)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

export function score(_prompt, response) {
  if (typeof response !== "string" || response.length === 0) return 0;

  const keyHits = countDistinctHits(response, MISSION_SHAPE_KEYS);
  const keyScore = Math.min(keyHits, RUBRIC.caps.shape_keys) / RUBRIC.caps.shape_keys;

  const lines = response.split(/\r?\n/);
  let bulletLines = 0;
  for (const l of lines) {
    if (/^\s*[-*]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) bulletLines += 1;
  }
  const bulletScore = Math.min(bulletLines, RUBRIC.caps.bullets) / RUBRIC.caps.bullets;

  const fakeGreenPenalty = hasFakeGreen(response) ? RUBRIC.penalties.fake_green : 0;
  const driftPenalty = keyHits === 0 && !/\n/.test(response) ? RUBRIC.penalties.drift : 0;

  const raw =
    RUBRIC.weights.shape_keys * keyScore +
    RUBRIC.weights.bullet_structure * bulletScore -
    fakeGreenPenalty -
    driftPenalty;

  return clamp01(raw);
}

// ---------------------------------------------------------------------------
// Probe pack shape — { prompt, score } pairs the harness expects.
// ---------------------------------------------------------------------------

export const probes = PROMPTS.map((prompt) => ({ prompt, score }));

export default {
  dimension: DIMENSION,
  prompts: PROMPTS,
  score,
  probes,
  rubric: RUBRIC,
};
