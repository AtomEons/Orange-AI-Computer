// topology-router.mjs — route the SHAPE OF THOUGHT, not just the model.
//
// router-least-action.mjs answers "which model is cheapest that can do this?"
// That was the right question when the executor was a text-completion endpoint.
// It is no longer the only question. An agentic executor can be arranged in
// different SHAPES, and the shape matters more than the model.
//
// Evidence, from this project: every substantive error in the AEyes-1 campaign
// was caught by an adversarial second opinion (GPT) relayed by the operator BY
// HAND, with days of latency. The adversarial pass was the single most valuable
// mechanism in the campaign — and it lived entirely outside the system.
//
// This router makes it a lane. Substantive claims get a refute-pass BEFORE the
// receipt is written, not days later by a human courier.
//
// Composes with pickLane() — that picks capability, this picks arrangement.

export const TOPOLOGY_SCHEMA_ID = 'orange5.topology.v1';

export const TOPOLOGIES = Object.freeze({
  SOLO:             'solo',              // one pass; mechanical, reversible
  ADVERSARIAL_PAIR: 'adversarial_pair',  // produce, then actively try to refute
  PANEL:            'panel',             // N independent attempts, then judge
  FANOUT_VERIFY:    'fanout_verify',     // decompose, cover in parallel, verify each
});

// Verbs that assert something about the world and therefore can be WRONG,
// as distinct from verbs that merely change it and can be undone.
const CLAIM_VERBS = /\b(prove|proof|verif|confirm|establish|demonstrat|conclud|diagnos|assess|evaluat|measur|audit|discriminat|recogni|classif|saturat|calibrat|benchmark|report|finding)/i;
const IRREVERSIBLE = /\b(deploy|publish|release|delete|drop|migrat|promot|ship|send|purge|overwrite)/i;
const EXPLORATORY = /\b(design|architect|explore|brainstorm|option|approach|strateg|plan)/i;
const BROAD = /\b(sweep|campaign|corpus|all |every |across|fan.?out|batch|bulk|survey|inventory)/i;
const MECHANICAL = /\b(read|list|status|health|echo|format|rename|move|copy|log|print|fetch)/i;

/**
 * pickTopology(order, ctx)
 * @returns { topology, reason, adversarialRequired, minAgents, gates }
 */
export function pickTopology(order = {}, ctx = {}) {
  const text = `${order.action || ''} ${order.intent || ''} ${JSON.stringify(order.payload || {})}`;
  const declaresClaim = !!(order.claim || order.payload?.claim || order.payload?.finding || order.payload?.verdict);
  const risk = ctx.risk ?? null;

  // Mechanical + no claim -> solo. Do not tax cheap reversible work.
  if (MECHANICAL.test(order.action || '') && !declaresClaim && !CLAIM_VERBS.test(text)) {
    return {
      schema: TOPOLOGY_SCHEMA_ID, topology: TOPOLOGIES.SOLO,
      reason: 'mechanical, reversible, asserts nothing about the world',
      adversarialRequired: false, minAgents: 1, gates: ['procedural'],
    };
  }

  // Irreversible -> adversarial + human stop. Cost of being wrong is unbounded.
  if (IRREVERSIBLE.test(text) || risk === 'high') {
    return {
      schema: TOPOLOGY_SCHEMA_ID, topology: TOPOLOGIES.ADVERSARIAL_PAIR,
      reason: 'irreversible or high-risk — a wrong call cannot be walked back',
      adversarialRequired: true, minAgents: 2, gates: ['procedural', 'epistemic', 'human_final_stop'],
    };
  }

  // Broad sweep -> fan out, then verify each finding independently.
  if (BROAD.test(text) && (declaresClaim || CLAIM_VERBS.test(text))) {
    return {
      schema: TOPOLOGY_SCHEMA_ID, topology: TOPOLOGIES.FANOUT_VERIFY,
      reason: 'broad claim surface — decompose, cover in parallel, verify each finding',
      adversarialRequired: true, minAgents: 3, gates: ['procedural', 'epistemic'],
    };
  }

  // Wide-open design space -> panel of independent attempts, then judge.
  if (EXPLORATORY.test(text) && !declaresClaim) {
    return {
      schema: TOPOLOGY_SCHEMA_ID, topology: TOPOLOGIES.PANEL,
      reason: 'open solution space — independent attempts beat one attempt iterated',
      adversarialRequired: false, minAgents: 3, gates: ['procedural'],
    };
  }

  // THE CORE RULE, learned the hard way:
  // anything asserting a fact about the world gets a refute-pass before it is
  // written into the chain. This is the mechanism that caught every real error
  // in the AEyes-1 campaign, previously running by hand with days of latency.
  if (declaresClaim || CLAIM_VERBS.test(text)) {
    return {
      schema: TOPOLOGY_SCHEMA_ID, topology: TOPOLOGIES.ADVERSARIAL_PAIR,
      reason: 'asserts a fact about the world — must survive a refute-pass before entering the chain',
      adversarialRequired: true, minAgents: 2, gates: ['procedural', 'epistemic'],
    };
  }

  return {
    schema: TOPOLOGY_SCHEMA_ID, topology: TOPOLOGIES.SOLO,
    reason: 'ordinary reversible work',
    adversarialRequired: false, minAgents: 1, gates: ['procedural'],
  };
}

/**
 * adversarialBrief(order, report) — the prompt for the refuting agent.
 * Deliberately asymmetric: the refuter's job is to KILL the claim, and the
 * default on genuine uncertainty is "refuted". Symmetric review finds less.
 */
export function adversarialBrief(order = {}, report = {}) {
  const text = `${order.action || ''} ${order.intent || ''} ${report.summary || ''}`;
  const outputFindings = Array.isArray(report?.output?.findings)
    ? report.output.findings.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const reviewedClaim = outputFindings.length
    ? outputFindings.join('; ')
    : (report?.output?.summary || report.summary || order.intent || order.action);
  const attackVectors = [
    'Does the supplied evidence directly support the exact claim?',
    'Does the language claim more than the evidence establishes?',
    'Is there a concrete counterexample or contradiction in the supplied material?',
  ];
  if (/\b(sample|dataset|accuracy|precision|recall|rate|benchmark|measure|experiment|calibrat|discriminat|classif)\b/i.test(text)
      || Number.isFinite(order.evidence?.n)) {
    attackVectors.push(
      'Is the sample large enough to resolve the precision being claimed?',
      'Was any data-dependent choice made on the same samples used to score?',
      'Could a nuisance axis (background, scene, scale, source, device) explain the result?',
      'Does high accuracy hide high abstention?',
      'Would this reproduce on independently collected data?',
    );
  }
  if (/\b(code|repo|runtime|service|health|build|test|deploy|receipt|system|api|endpoint)\b/i.test(text)) {
    attackVectors.push(
      'Does the proof exercise the exact live runtime path rather than a mock or fixture?',
      'Is the receipt fresh, attributable, and scoped to the claim?',
      'Does a narrow test result get generalized to a broader system claim?',
      'Could a transport-level success be hiding a semantic failure?',
    );
  }
  if (/\b(math|arithmetic|equation|theorem|logic|derive|identity|equals|proof)\b/i.test(text)) {
    attackVectors.push(
      'Is each logical or arithmetic step valid under the stated assumptions?',
      'Are any necessary assumptions missing or contradicted?',
    );
  }
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    role: 'refuter',
    instruction: 'Actively try to falsify the claim below. Return refuted=true only for a concrete contradiction, counterexample, invalid inference, or claim-relevant evidence gap. Do not invent hypothetical objections. If the supplied evidence directly entails the claim and no concrete defeater survives, return refuted=false.',
    claim: reviewedClaim,
    evidence: report.output ?? order.payload ?? null,
    attackVectors,
    verdictSchema: { refuted: 'boolean', reason: 'string', severity: 'BLOCK|WARN|NONE', strongestAttack: 'string' },
  };
}
