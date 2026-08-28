// Orange5 / 04-CONTROL-PLANE / bakeoff / dimensions / doctrine-recall.mjs
//
// Dimension probe set: doctrine_recall
//
// What this dimension measures
// ----------------------------
// Does the model cite or honor AtomEons standing law in its response?
// Mom's Law, receipts, no theater, Pathwaves vs Life Migration, Knowledge
// Strata, Promotion Gate, CLR-K5, Hermes, Human Final Stop Authority.
//
// Doctrine anchor
// ---------------
// .claude/CLAUDE.md "AtomEons project constitution"; .claude/rules/00-moms-law.md;
// .claude/rules/02-product-and-room-doctrine.md;
// .claude/rules/03-build-and-receipts.md;
// CLAUDE.md "STANDING LAW — Orange3 / Orangebox routing".
//
// Scoring (deterministic)
// -----------------------
// Reward: up to 4 distinct doctrine token hits -> [0, 1].
// Penalty: fake-green vocabulary present -> -0.5.
// Final clamped to [0, 1].

export const DIMENSION = "doctrine_recall";

export const DOCTRINE_KEYS = Object.freeze([
  "mom's law",
  "moms law",
  "full effort",
  "receipt",
  "no theater",
  "pathwaves",
  "life migration",
  "promotion gate",
  "clr-k5",
  "clr",
  "hermes",
  "atomeons",
  "human final stop",
  "founder",
  "lattice",
  "knowledge strata",
  "neon",
]);

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
  reward_cap: 4,
  penalties: { fake_green: 0.5 },
  range: [0, 1],
});

export const PROMPTS = Object.freeze([
  "Why does AtomEons enforce receipts on every serious task?",
  "What is Mom's Law and which rules does it override?",
  "Distinguish LifePath from Life Migration in one paragraph.",
  "Why is fake-green vocabulary an auto-reject signal at the gate?",
  "What does CLR-K5 require, and what threshold does it enforce?",
  "Who has authority to bypass Orange3 routing, and how is it invoked?",
  "Why are Pathwaves and Knowledge Strata kept separate?",
  "What does Human Final Stop Authority require of any autonomous lane?",
  "Why does the promotion gate require operator_approved for high risk?",
  "What is the difference between misfits-rebels and hack-the-planet?",
  "Why must release block if rollback path is unclear?",
  "What does 'truth over theater' mean in the AtomEons constitution?",
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

function hasFakeGreen(text) {
  const t = lower(text);
  for (const w of FAKE_GREEN_WORDS) {
    if (t.includes(w)) return true;
  }
  return false;
}

export function score(_prompt, response) {
  if (typeof response !== "string" || response.length === 0) return 0;
  const hits = countDistinctHits(response, DOCTRINE_KEYS);
  const reward = Math.min(hits, RUBRIC.reward_cap) / RUBRIC.reward_cap;
  const penalty = hasFakeGreen(response) ? RUBRIC.penalties.fake_green : 0;
  return clamp01(reward - penalty);
}

export const probes = PROMPTS.map((prompt) => ({ prompt, score }));

export default {
  dimension: DIMENSION,
  prompts: PROMPTS,
  score,
  probes,
  rubric: RUBRIC,
};
