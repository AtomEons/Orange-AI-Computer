const ARCHITECTURE_PATTERN = /\b(?:architect(?:ure|ural)?|system design|root cause|trade[ -]?offs?|cross[- ]disciplin|deep review|judge)\b/i;
const COMPLEX_SYNTHESIS_PATTERN = /\bsynthesi[sz]e\b[\s\S]{0,160}\b(?:architecture|system|trade[ -]?offs?|cross[- ]disciplin|strategy|multiple|many|complex|deep)\b|\b(?:architecture|system|trade[ -]?offs?|cross[- ]disciplin|strategy|multiple|many|complex|deep)\b[\s\S]{0,160}\bsynthesi[sz]e\b/i;
const VISUAL_PATTERN = /\b(?:image|screenshot|visual|document|pixel|render)\b/i;

const CONCEPTS = Object.freeze({
  runtime: /\b(?:runtime|service|daemon|process|endpoint|gateway)\b/i,
  routing: /\b(?:route|router|lane|lease|orchestrat|conductor)\b/i,
  proof: /\b(?:receipt|proof|evidence|verify|audit|green)\b/i,
  memory: /\b(?:memory|recall|knowledge|context|crystal|atomsmasher|compress)\b/i,
  compute: /\b(?:model|inference|codexa|n150|gpu|cpu|ollama|llama)\b/i,
  agents: /\b(?:agent|hermes|council|flow|tool|mcp)\b/i,
  resilience: /\b(?:failure|fallback|offline|heal|recover|risk|security)\b/i,
});

function textPart(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : String(part?.text || '')).join('\n');
}

export function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return textPart(messages[index].content).trim();
  }
  return '';
}

export function classifyCapabilityCovenant({ messages = [], tier = 'navigator', autoRoute = null } = {}) {
  const request = latestUserText(messages);
  // A bounded receipt summary is Navigator work. Bare "synthesize" used to
  // force every delegation closeout onto the heavy lane, including one-child
  // source reads. Reserve the heavy covenant for synthesis that actually names
  // architectural breadth or judgment complexity.
  const judge = autoRoute?.order?.allowedActions?.includes('judge')
    || ARCHITECTURE_PATTERN.test(request)
    || COMPLEX_SYNTHESIS_PATTERN.test(request);
  const visual = autoRoute?.order?.inputModalities?.includes('image') || VISUAL_PATTERN.test(request);
  const capabilityClass = tier === 'visual'
    ? 'operational_vision'
    : tier === 'code'
    ? 'code_specialist'
    : (judge ? 'architecture_judge' : (visual && tier === 'heavy' ? 'visual_judge' : 'general'));
  const minimumTier = capabilityClass === 'operational_vision'
    ? 'visual'
    : capabilityClass === 'code_specialist'
    ? 'code'
    : (capabilityClass === 'architecture_judge' || capabilityClass === 'visual_judge' ? 'heavy' : 'navigator');
  return {
    schema: 'orange.capability-covenant.v1',
    class: capabilityClass,
    minimumTier,
    fallbackAllowed: capabilityClass === 'general',
    request,
  };
}

export function specialistPolicyFor(covenant, tier) {
  if (tier === 'heavy' || tier === 'code') return 'wait_for_specialist';
  return 'prewarm_fallback';
}

function reportFromEnvelope(envelope) {
  try {
    const content = envelope?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    return null;
  }
}

function conceptCoverage(text) {
  return Object.entries(CONCEPTS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

export function validateCapabilityOutput(envelope, covenant, {
  requestedTier = covenant?.minimumTier || 'navigator',
  executionTier = requestedTier,
  routeMode = 'specialist',
} = {}) {
  const reasons = [];
  const report = reportFromEnvelope(envelope);
  if (!report) reasons.push('response is not a parseable Orange report');
  if (!covenant?.fallbackAllowed && executionTier !== covenant?.minimumTier) {
    reasons.push(`required ${covenant?.minimumTier} capability executed on ${executionTier}`);
  }
  if (!covenant?.fallbackAllowed && routeMode === 'shared_hot_fallback') {
    reasons.push('specialist capability silently used the shared hot fallback');
  }

  let coverage = [];
  if (report && covenant?.class === 'architecture_judge') {
    const generatedFinding = /^(?:unverified_model_observation|deterministic route|existing_project_lineage|Capability covenant rejected)\b/i;
    const findings = Array.isArray(report.findings)
      ? report.findings.filter((item) => String(item).trim().length >= 24 && !generatedFinding.test(String(item).trim()))
      : [];
    const answer = [
      ...findings,
      ...(Array.isArray(report.blockers) ? report.blockers : []),
      report.nextAction || '',
    ].join(' ');
    coverage = conceptCoverage(answer);
    if (findings.length < 2) reasons.push('architecture report has fewer than two substantive findings');
    if (coverage.length < 2) reasons.push('architecture report covers fewer than two system domains');
    if (!VISUAL_PATTERN.test(covenant.request) && /\bAE Eyes\b/i.test(answer) && coverage.length < 3) {
      reasons.push('architecture report drifted into an unrelated visual-only route');
    }
  }

  return {
    schema: 'orange.capability-verdict.v1',
    valid: reasons.length === 0,
    class: covenant?.class || 'general',
    requestedTier,
    minimumTier: covenant?.minimumTier || 'navigator',
    executionTier,
    routeMode,
    coverage,
    reasons,
  };
}

export function capabilityRepairInstruction(verdict) {
  const required = verdict.class === 'architecture_judge'
    ? 'Return a findings JSON array with 2 or 3 concrete findings, each at least 24 characters. Prefix each finding with a different domain chosen from runtime, routing, proof, memory, compute, agents, and resilience. Then give one exact next proof.'
    : 'Return a concrete Orange report that directly answers the operator request.';
  return [
    'CAPABILITY COVENANT REPAIR.',
    required,
    `Prior draft failed: ${verdict.reasons.join('; ')}.`,
    'Do not substitute an unrelated subsystem. Do not claim execution or evidence that was not supplied.',
  ].join(' ');
}

export function enforceCapabilityFailure(envelope, verdict) {
  const report = reportFromEnvelope(envelope) || {};
  const replacement = {
    schema: 'orange.report.v1',
    orderId: report.orderId || envelope?.ae_order_id || 'capability-gate',
    status: 'blocked',
    confidence: 0,
    actionsTaken: [],
    evidence: [],
    findings: [`Capability covenant rejected a ${verdict.class} answer before operator delivery.`],
    blockers: verdict.reasons,
    nextAction: `restore the ${verdict.minimumTier} specialist or run a governed capable council`,
    receiptPath: null,
  };
  if (!envelope.choices) envelope.choices = [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }];
  envelope.choices[0].message.content = JSON.stringify(replacement);
  envelope.ae_capability_covenant = { ...verdict, enforced: true };
  envelope.ae_execution_performed = false;
  return replacement;
}
