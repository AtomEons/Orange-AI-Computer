// clr/verifier-k1.mjs — Night-1 Claim-Level Reliability verifier (K=1).
// Single-candidate scoring: anti-fluff + grounding sanity. Threshold 0.50.
// Phase-5 will upgrade to K=5 with full claim verification against Reality lane.

const FAKE_GREEN = /\b(green_assumed|looks_ok|probably|should_work|fake_green)\b/i;
const FLUFF = /\b(in summary|to summarize|it is important to note|I hope this helps|might|maybe|perhaps|seems to|appears to|kind of)\b/i;

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

export function verifyAgentTurnK1(turn) {
  // turn: parsed AgentTurn JSON (already passed JSON Schema validation)
  const reasons = [];
  let score = 1.0;

  // 1. Anti-fluff in summary + next_action
  const proseFields = [turn.summary, turn.next_action].join(' ');
  if (FAKE_GREEN.test(proseFields)) {
    score -= 0.6;
    reasons.push('fake-green word detected — auto-reject');
  }
  const fluffHits = (proseFields.match(new RegExp(FLUFF.source, 'gi')) || []).length;
  if (fluffHits >= 3) {
    score -= 0.3;
    reasons.push(`fluff: ${fluffHits} hits`);
  } else if (fluffHits >= 1) {
    score -= 0.1;
    reasons.push(`fluff: ${fluffHits} hits (warn)`);
  }

  // 2. Grounding: high-risk turns must cite at least one file OR command
  if (turn.risk === 'high' && turn.files.length === 0 && turn.commands.length === 0) {
    score -= 0.4;
    reasons.push('high-risk turn cites no files and no commands');
  }

  // 3. Risk-vs-content sanity: error/risk event_types should not be confidence > 0.9
  if (['error', 'risk'].includes(turn.event_type) && turn.confidence > 0.9) {
    score -= 0.15;
    reasons.push('error/risk event with implausibly high confidence');
  }

  // 4. Empty summary → reject
  if (!turn.summary || turn.summary.trim().length < 3) {
    score -= 0.8;
    reasons.push('summary missing or too short');
  }

  // 5. Confidence too low → flag
  if (turn.confidence < 0.2) {
    score -= 0.2;
    reasons.push(`confidence ${turn.confidence} below daemon threshold`);
  }

  score = clamp01(score);
  return {
    score,
    accepted: score >= 0.5,
    reasons,
  };
}
