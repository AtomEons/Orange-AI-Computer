// Orange5 / 04-CONTROL-PLANE / bakeoff / dimensions / topology-recall.mjs
//
// Dimension probe set: topology_recall
//
// What this dimension measures
// ----------------------------
// Does the model name Orange5 lanes, rooms, and on-disk paths correctly?
// Numbered directories (04-CONTROL-PLANE, 08-HERMES, 10-RECEIPTS, etc.),
// promotion-gate, bakeoff, Mirage, ATOMSMASHER; and the AtomEons rooms
// (LifePath, Growth, Create, Learn, Relax, Social, Misfit).
//
// Doctrine anchor
// ---------------
// Orange5 tree layout (00-CHARTER .. 19-ARCHIVE);
// .claude/rules/02-product-and-room-doctrine.md (room names);
// promotion-gate/engine.mjs path conventions.
//
// Scoring (deterministic)
// -----------------------
// Reward: up to 3 distinct topology token hits -> [0, 1].
// No fake-green penalty here — topology is purely about *recall*, not
// epistemic posture; the other dimensions catch hand-wave.
// Final clamped to [0, 1].

export const DIMENSION = "topology_recall";

export const TOPOLOGY_KEYS = Object.freeze([
  "04-control-plane",
  "08-hermes",
  "10-receipts",
  "09-schemas",
  "11-mirage",
  "12-atomsmasher",
  "13-toolmesh",
  "14-superstack",
  "17-dags",
  "promotion-gate",
  "bakeoff",
  "lifepath",
  "growth",
  "create",
  "learn",
  "relax",
  "social",
  "misfit",
]);

export const RUBRIC = Object.freeze({
  type: "regex_and_keyword",
  reward_cap: 3,
  penalties: {},
  range: [0, 1],
});

export const PROMPTS = Object.freeze([
  "Where do promotion gate engine modules live in the Orange5 tree?",
  "Where are Hermes receipts stored on disk?",
  "Which lane owns bakeoff harnesses?",
  "Which lanes are perspective layers vs writing authorities?",
  "Name the rooms that are views over shared primitives.",
  "Where do schemas live in the Orange5 layout?",
  "Which numbered directory holds Mirage fixtures?",
  "Where does the AECode plane sit in the control-plane tree?",
  "What is the canonical receipt path shape for a candidate change?",
  "Which lane runs the nine-gate stack?",
  "Where does ATOMSMASHER live in the topology?",
  "Where do DAG specs live in the Orange5 tree?",
]);

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

export function score(_prompt, response) {
  if (typeof response !== "string" || response.length === 0) return 0;
  const hits = countDistinctHits(response, TOPOLOGY_KEYS);
  return clamp01(Math.min(hits, RUBRIC.reward_cap) / RUBRIC.reward_cap);
}

export const probes = PROMPTS.map((prompt) => ({ prompt, score }));

export default {
  dimension: DIMENSION,
  prompts: PROMPTS,
  score,
  probes,
  rubric: RUBRIC,
};
