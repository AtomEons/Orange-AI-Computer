import { adversarialBrief } from '../06-ORANGELLM/topology-router.mjs';

const BLOCKING_STATUSES = new Set(['blocked', 'rejected', 'halted', 'needs_action', 'error']);

function planningOnlyEvidence(order, primaryResult) {
  const output = primaryResult?.output;
  const evidence = primaryResult?.evidence;
  return /^plan\./i.test(String(order?.action || ''))
    && /(?:^|[.-])plan(?:[.-]|$)/i.test(String(output?.schema || ''))
    && String(output?.status || '').toUpperCase() === 'PLANNED'
    && evidence?.execution === 'read_only'
    && evidence?.mutationPerformed === false;
}

function hasEvidence(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return String(value).trim().length > 0;
}

function claimEvidence(order, primaryResult) {
  const candidates = [
    primaryResult?.output?.evidence,
    primaryResult?.evidence,
    order?.evidence,
    order?.payload?.evidence,
    primaryResult?.output,
    order?.payload,
  ];
  return candidates.find(hasEvidence) ?? null;
}

export function buildAdversarialPacket(order, primaryResult) {
  const brief = adversarialBrief(order, primaryResult);
  const planningOnly = planningOnlyEvidence(order, primaryResult);
  const action = String(order?.action || 'unknown');
  const schema = String(primaryResult?.output?.schema || 'planning artifact');
  return {
    role: 'falsifier',
    claim: planningOnly
      ? `${action} produced a ${schema} artifact with status PLANNED; no planned task execution is claimed.`
      : brief.claim,
    order: planningOnly ? { action, intent: order?.intent ?? null } : undefined,
    primaryResult: planningOnly ? {
      status: primaryResult?.status ?? null,
      summary: primaryResult?.summary ?? null,
      output: primaryResult?.output ?? null,
      evidence: primaryResult?.evidence ?? null,
    } : undefined,
    evidence: planningOnly
      ? primaryResult?.output ?? null
      : claimEvidence(order, primaryResult),
    claimSemantics: planningOnly
      ? { kind: 'planning_artifact', planningOnly: true, executionClaimed: false }
      : { kind: 'ordinary_claim', planningOnly: false },
    checks: planningOnly
      ? [
          'Does the supplied evidence contain the claimed canonical plan artifact with status PLANNED?',
          'Does the claim remain limited to plan production without implying that planned work executed?',
          ...brief.attackVectors,
        ]
      : brief.attackVectors,
  };
}

export function normalizeAdversarialReport(raw, meta = {}) {
  const report = raw && typeof raw === 'object' ? raw : null;
  if (!report || report.schema !== 'orange.report.v1') {
    return {
      completed: false, preExecution: true, refuted: true,
      status: 'error', reason: 'refuter returned an invalid orange.report.v1',
      ...meta,
    };
  }

  const status = String(report.status || '').toLowerCase();
  const evidence = Array.isArray(report.evidence) ? report.evidence.map(String) : [];
  const verdictMarkers = evidence
    .map((item) => item.trim().match(/^REFUTED=(true|false)$/i))
    .filter(Boolean);
  if (verdictMarkers.length > 1) {
    return {
      completed: false, preExecution: true, refuted: true,
      status: 'error', reason: 'refuter returned conflicting REFUTED=true|false evidence markers',
      ...meta,
    };
  }
  const markerRefuted = verdictMarkers.length === 1
    ? verdictMarkers[0][1].toLowerCase() === 'true'
    : null;
  const rawBlockers = Array.isArray(report.blockers) ? report.blockers.filter(Boolean).map(String) : [];
  // Some small refuters duplicate the machine verdict into every array field.
  // REFUTED=false is a verdict token, never a substantive blocker. Remove only
  // that exact wire-format duplication; every real blocker remains fail-closed.
  const blockers = rawBlockers.filter((item) => !/^REFUTED=false$/i.test(item.trim()));
  const explicitRefuted = report.refuted === true || report.output?.refuted === true;
  const actionText = Array.isArray(report.actionsTaken) ? report.actionsTaken.join(' ') : '';
  const contradictoryRefutation = /\b(refuted claim|claim (?:is |was )?refuted|we refute)\b/i.test(`${report.summary || ''} ${actionText}`);
  const misplacedFalseMarkerOnly = markerRefuted === false
    && rawBlockers.length > 0
    && blockers.length === 0
    && rawBlockers.every((item) => /^REFUTED=false$/i.test(item.trim()));
  const blockedByStandardContract = blockers.length > 0
    || (BLOCKING_STATUSES.has(status) && !misplacedFalseMarkerOnly);
  const positiveVerification = /\b(verified|validated|confirmed|checked|tested|no (?:surviving )?(?:objection|contradiction|counterexample)|survives falsification)\b/i.test(`${report.summary || ''} ${actionText}`);
  if (markerRefuted == null && !blockedByStandardContract && !contradictoryRefutation && !positiveVerification) {
    return {
      completed: false, preExecution: true, refuted: true,
      status: 'error', reason: 'markerless refuter report lacks an explicit verification action',
      ...meta,
    };
  }
  const refuted = markerRefuted === true || explicitRefuted || contradictoryRefutation || blockedByStandardContract;
  return {
    completed: true, preExecution: true, refuted,
    status: misplacedFalseMarkerOnly ? 'completed' : (status || 'completed'),
    reason: report.reason || report.output?.reason || report.summary || (refuted ? 'refuter blocked the claim' : 'no surviving objection'),
    strongestAttack: report.strongestAttack || report.output?.strongestAttack || null,
    blockers,
    protocolNormalized: misplacedFalseMarkerOnly,
    ...meta,
  };
}

export async function runGatewayAdversarialPass({ url, order, primaryResult, timeoutMs = 180_000 } = {}) {
  const endpoint = `${String(url || '').replace(/\/$/, '')}/v1/chat/completions`;
  // The warm Navigator is the measured refuter. Using orange-auto here lets
  // complexity classification silently escalate the second pass to a cold
  // heavy model, turning a bounded proof into a 120-second gateway timeout.
  const model = process.env.ORANGE5_REFUTER_MODEL || 'orange-navigator';
  const orderId = `${order?.orderId ?? order?.id ?? 'orange-order'}:refuter`;
  const packet = buildAdversarialPacket(order, primaryResult);
  const basePrompt = 'You are the independent Orange refuter. Use only the supplied order, primary result, and evidence, and use ordinary semantics unless the claim explicitly names another domain. Return orange.report.v1 JSON. Put exactly one machine verdict marker in evidence: REFUTED=true or REFUTED=false. A REFUTED=true blocker MUST identify a concrete contradiction, counterexample, invalid inference, or claim-relevant missing evidence in the supplied material. Hypothetical alternate domains, merely possible edge cases, and irrelevant attack vectors are not blockers. When claimSemantics.planningOnly=true, PLANNED truthfully means that the claimed plan artifact was produced; it does not claim that planned work executed, so missing execution evidence is not a blocker. This exception never applies to execution or mutation claims, which still require actual execution evidence. If supplied evidence directly entails the claim and no concrete contradiction exists, use REFUTED=false, status=completed, blockers=[]. If uncertain because claim-relevant evidence is genuinely missing, use REFUTED=true. Never write Refuted claim when using REFUTED=false.';
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const repairInstruction = attempt === 2
        ? ' PROTOCOL REPAIR: Output exactly one compact JSON object with keys schema, orderId, status, confidence, actionsTaken, evidence, findings, blockers, nextAction, receiptPath. No markdown and no extra keys.'
        : '';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          ae_response_contract: 'orange.report.v1',
          ae_order_id: orderId,
          ae_evidence_policy: 'derive',
          messages: [
            { role: 'system', content: `${basePrompt}${repairInstruction}` },
            { role: 'user', content: JSON.stringify(packet) },
          ],
          response_format: { type: 'json_object' },
          reasoning_effort: 'none',
          max_tokens: attempt === 1 ? 384 : 512,
          temperature: 0,
        }),
      });
      if (!response.ok) {
        return { completed: false, preExecution: true, refuted: true, status: 'error', reason: `refuter gateway ${response.status}`, model, endpoint, protocolAttempts: attempt };
      }
      const body = await response.json();
      const content = body.choices?.[0]?.message?.content ?? body;
      let report = content;
      if (typeof content === 'string') {
        try { report = JSON.parse(content); }
        catch {
          if (attempt === 1) continue;
          return { completed: false, preExecution: true, refuted: true, status: 'error', reason: 'refuter returned non-JSON output after protocol repair', model, endpoint, protocolAttempts: attempt };
        }
      }
      const protocolRepairRequired = Array.isArray(report?.blockers)
        && report.blockers.includes('model draft required deterministic orange.report.v1 schema repair');
      if (protocolRepairRequired && attempt === 1) continue;
      if (protocolRepairRequired) {
        return { completed: false, preExecution: true, refuted: true, status: 'error', reason: 'refuter failed orange.report.v1 after bounded protocol repair', model, endpoint, report, protocolAttempts: attempt };
      }
      const normalized = normalizeAdversarialReport(report, {
        model: body.model ?? model,
        lane: body.ae_lane ?? 'refuter',
        host: body.ae_host ?? null,
        endpoint,
      });
      return { ...normalized, report, protocolAttempts: attempt };
    }
  } catch (error) {
    return { completed: false, preExecution: true, refuted: true, status: 'error', reason: `refuter unavailable: ${error?.message || error}`, model, endpoint };
  }
}
