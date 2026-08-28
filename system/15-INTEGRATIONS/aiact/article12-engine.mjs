// article12-engine.mjs — deterministic EU AI Act scope + Article 12 gap engine.
//
// ── WHY DETERMINISTIC AND NOT A MODEL ────────────────────────────────────
// An audit file needs a document that produces the SAME output when re-run in
// 2028 by someone else. A language model cannot offer that: it gives an opinion,
// varies between runs, cites nothing checkable, and sends the input to a vendor.
//
// This engine is a rule set. Same answers in, byte-identical report out, forever.
// Every finding carries the article it comes from so counsel can check the work.
// Nothing leaves the machine it runs on. Zero dependencies, zero API calls,
// zero cost per run.
//
// Not using AI here is the superior product, not a compromise.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
// This is NOT a conformity assessment, NOT certification, and NOT legal advice.
// Conformity assessment is regulated work performed by notified bodies. This
// produces a structured self-assessment against published article text, for
// internal records and to brief counsel. That boundary is printed on every
// report and is not removable by configuration.
//
// ── SOURCE DISCIPLINE ────────────────────────────────────────────────────
// Rules below were encoded from secondary summaries of Regulation (EU) 2024/1689
// on 2026-07-26. Every rule carries `source` and `verify`. Before any report is
// sold, each rule must be checked against the primary text. Rules the author was
// not confident encoding are marked confidence:'low' and surface as
// "verify with counsel" rather than as findings.

export const ENGINE_ID = 'aiact.article12.engine.v1';
export const ENGINE_ENCODED_ON = '2026-07-26';
export const ENFORCEMENT_DATE = '2026-08-02';

export const LEGAL_BOUNDARY = Object.freeze({
  is_not: [
    'a conformity assessment under Article 43',
    'certification by a notified body',
    'legal advice',
    'a guarantee of compliance or of non-compliance',
  ],
  is: 'a deterministic, reproducible self-assessment against published article text, for internal records and to brief qualified counsel',
  required_next_step: 'review by qualified counsel or a notified body before relying on any conclusion',
});

// ─────────────────────────────────────────────────────────────────────────
// ANNEX III high-risk categories.
// The three flagged thirdPartyRequired categories were consistently reported as
// requiring notified-body assessment; the rest were reported as self-assessable
// where harmonised standards are applied. Both facts carry verify flags.
// ─────────────────────────────────────────────────────────────────────────
export const ANNEX_III = Object.freeze([
  { id: 'biometric', label: 'Biometric identification / categorisation', thirdPartyRequired: true, confidence: 'medium' },
  { id: 'critical_infrastructure', label: 'Safety of critical infrastructure', thirdPartyRequired: true, confidence: 'medium' },
  { id: 'law_enforcement', label: 'Law enforcement', thirdPartyRequired: true, confidence: 'medium' },
  { id: 'education', label: 'Education / vocational training access + assessment', thirdPartyRequired: false, confidence: 'medium' },
  { id: 'employment', label: 'Employment, worker management, access to self-employment (incl. hiring, screening, promotion)', thirdPartyRequired: false, confidence: 'high' },
  { id: 'essential_services', label: 'Access to essential private/public services (incl. credit scoring)', thirdPartyRequired: false, confidence: 'high' },
  { id: 'migration', label: 'Migration, asylum, border control', thirdPartyRequired: false, confidence: 'medium' },
  { id: 'justice', label: 'Administration of justice and democratic processes', thirdPartyRequired: false, confidence: 'medium' },
]);

export const ROLES = Object.freeze(['provider', 'deployer', 'importer', 'distributor', 'unknown']);

// ─────────────────────────────────────────────────────────────────────────
// RULES. Each returns findings; each finding cites its article.
// ─────────────────────────────────────────────────────────────────────────
const RULES = [
  {
    id: 'SCOPE_ROLE_UNKNOWN', article: 'Art. 3 (definitions)', confidence: 'high',
    applies: a => !a.role || a.role === 'unknown',
    finding: () => ({
      severity: 'BLOCKER',
      title: 'Role not determined',
      detail: 'Obligations differ substantially between provider and deployer. Nothing else can be assessed until the role is fixed.',
      action: 'Determine whether you place the system on the market under your own name (provider) or use it under your authority (deployer). A system materially modified or re-branded by you may make you a provider even if you did not build it.',
      verify: 'Article 3 definitions; note the substantial-modification provisions which can convert a deployer into a provider.',
    }),
  },
  {
    id: 'SCOPE_NOT_HIGH_RISK', article: 'Annex III', confidence: 'high',
    applies: a => a.role && a.role !== 'unknown' && a.annexIII === 'none',
    finding: () => ({
      severity: 'INFO',
      title: 'No Annex III category selected — Article 12 likely not triggered on that basis',
      detail: 'Article 12 record-keeping attaches to high-risk systems. If no Annex III category applies and the system is not a safety component of a regulated product, the high-risk obligations are likely not engaged.',
      action: 'Confirm the system is also not a safety component under Annex I product legislation. Transparency obligations may still apply separately.',
      verify: 'Annex I and Annex III scope; Article 6 classification rules; Article 50 transparency obligations may still apply.',
    }),
  },
  {
    id: 'ART12_LOGGING_CAPABILITY', article: 'Art. 12', confidence: 'high',
    applies: a => a.isHighRisk && a.role === 'provider',
    finding: a => ({
      severity: a.hasAutomaticLogging ? 'PASS' : 'GAP',
      title: 'Automatic recording of events over the system lifetime',
      detail: a.hasAutomaticLogging
        ? 'Automatic event logging is reported as present.'
        : 'High-risk systems must technically allow automatic recording of events (logs) throughout their lifetime. Off-the-shelf AI systems and common vendor APIs generally do not provide this by default — application-level logging is usually required.',
      action: a.hasAutomaticLogging
        ? 'Retain evidence of what is logged, at what granularity, and demonstrate it is automatic rather than manual.'
        : 'Implement automatic event logging at the point of each AI decision. Record inputs, outputs, model/version, timestamp, and the human-oversight action if any.',
      verify: 'Article 12 paragraphs on logging capability and the level of traceability appropriate to the intended purpose.',
    }),
  },
  {
    // The commercially important rule, and the one most often missed.
    // Article 12 places the LOGGING-CAPABILITY duty on the provider. But Article
    // 26 places a RETENTION duty on the deployer — and a deployer cannot retain
    // logs that were never generated. Where the deployer's system is a vendor API
    // that does not log by default, the deployer inherits a real, practical gap
    // that is invisible if Article 12 is read as a provider-only obligation.
    //
    // Encoded as a deployer obligation flowing from Art. 26, NOT as the deployer
    // owing Article 12's design duty. The distinction matters to counsel.
    id: 'DEPLOYER_LOG_AVAILABILITY', article: 'Art. 26 (with Art. 12)', confidence: 'medium',
    applies: a => a.isHighRisk && a.role === 'deployer',
    finding: a => ({
      severity: a.hasAutomaticLogging ? 'PASS' : 'GAP',
      title: 'Logs must actually be generated and within your control before they can be retained',
      detail: a.hasAutomaticLogging
        ? 'Automatic logging is reported as available to the deployer.'
        : 'The retention duty presupposes that logs exist and that you hold them. Off-the-shelf AI systems and common vendor APIs frequently do not produce logs of this kind by default, and where the vendor holds them, they may not be within your control for the retention period.',
      action: a.hasAutomaticLogging
        ? 'Record where the logs live, who controls them, and confirm your access survives termination of the vendor contract.'
        : 'Establish application-level logging at your own boundary rather than relying on the vendor, or obtain a contractual guarantee of log generation, access, retention period and post-termination export.',
      verify: 'Article 26 deployer retention duty read together with Article 12 provider logging capability. Confirm with counsel where the duty falls when the system is supplied as a service.',
    }),
  },
  {
    id: 'ART12_TRACEABILITY', article: 'Art. 12', confidence: 'high',
    applies: a => a.isHighRisk,
    finding: a => ({
      severity: a.logsEnableTraceability ? 'PASS' : 'GAP',
      title: 'Logs must enable traceability of system operation',
      detail: a.logsEnableTraceability
        ? 'Logs are reported as sufficient to trace a decision back through the system.'
        : 'Volume of logs is not the test. The test is whether a specific past decision can be reconstructed from them.',
      action: 'Take one real past decision and reconstruct it end to end from logs alone. If you cannot, the logs do not yet meet the traceability purpose.',
      verify: 'Article 12 traceability purpose; Article 13 transparency and information to deployers.',
    }),
  },
  {
    id: 'ART12_TAMPER_EVIDENCE', article: 'Art. 12 (purpose)', confidence: 'low',
    applies: a => a.isHighRisk,
    finding: a => ({
      severity: a.logsTamperEvident ? 'PASS' : 'ADVISORY',
      title: 'Integrity of the log record',
      detail: a.logsTamperEvident
        ? 'Logs are reported as tamper-evident.'
        : 'The published text does not, on the reading used here, explicitly mandate cryptographic tamper-evidence. However a log that can be silently edited after the fact is weak evidence in an audit or dispute.',
      action: 'Consider append-only or hash-chained storage so the record can be shown to be unaltered since it was written.',
      verify: 'TREAT AS ADVISORY, NOT AS A STATED REQUIREMENT. Confirm with counsel whether integrity controls are required or merely prudent.',
    }),
  },
  {
    id: 'DEPLOYER_LOG_RETENTION', article: 'Art. 26', confidence: 'medium',
    applies: a => a.isHighRisk && a.role === 'deployer',
    finding: a => ({
      severity: a.retentionMonths >= 6 ? 'PASS' : 'GAP',
      title: 'Deployer retention of automatically generated logs',
      detail: `Deployers were reported as required to retain automatically generated logs for at least six months. Current stated retention: ${a.retentionMonths ?? 'not stated'} months.`,
      action: 'Set retention to at least six months, subject to any longer sector-specific requirement, and reconcile against GDPR storage-limitation obligations.',
      verify: 'Article 26 deployer obligations; check for a longer period under sector law; reconcile with GDPR Article 5(1)(e).',
    }),
  },
  {
    id: 'DEPLOYER_HUMAN_OVERSIGHT', article: 'Art. 14 / Art. 26', confidence: 'high',
    applies: a => a.isHighRisk && a.role === 'deployer',
    finding: a => ({
      severity: a.humanOversight ? 'PASS' : 'GAP',
      title: 'Human oversight assigned to competent persons',
      detail: a.humanOversight
        ? 'Human oversight is reported as assigned.'
        : 'Deployers must assign human oversight to natural persons with the necessary competence, training and authority.',
      action: 'Name the individuals, record their competence and training, and confirm they hold actual authority to override or halt the system.',
      verify: 'Article 14 oversight design; Article 26 deployer assignment duties.',
    }),
  },
  {
    id: 'DEPLOYER_FRIA', article: 'Art. 27', confidence: 'medium',
    applies: a => a.isHighRisk && a.role === 'deployer' && a.publicBodyOrEssentialService,
    finding: a => ({
      severity: a.friaCompleted ? 'PASS' : 'GAP',
      title: 'Fundamental Rights Impact Assessment',
      detail: 'A FRIA was reported as required for certain deployers, including public bodies and providers of essential services.',
      action: 'Complete a FRIA before putting the system into use and keep it with your records.',
      verify: 'Article 27 — confirm whether your specific body type and use case fall within its scope.',
    }),
  },
  {
    id: 'PROVIDER_CONFORMITY', article: 'Art. 43', confidence: 'medium',
    applies: a => a.isHighRisk && a.role === 'provider',
    finding: a => {
      const cat = ANNEX_III.find(c => c.id === a.annexIII);
      const third = cat?.thirdPartyRequired === true;
      return {
        severity: a.conformityAssessmentDone ? 'PASS' : 'BLOCKER',
        title: third ? 'Third-party conformity assessment (notified body)' : 'Conformity assessment',
        detail: third
          ? `Category "${cat.label}" was reported as requiring assessment by a notified body. This cannot be self-declared and lead times are material.`
          : 'Most Annex III categories were reported as self-assessable where harmonised standards are applied. Where such standards are unavailable or not applied, the route may differ.',
        action: third
          ? 'Engage a notified body immediately. Availability is a real constraint.'
          : 'Document the harmonised standards applied and complete the internal-control assessment.',
        verify: 'Article 43 and the Annex VI/VII procedures. Confirm the correct route for your exact category — this rule is encoded at medium confidence.',
      };
    },
  },
  {
    id: 'PROVIDER_REGISTRATION', article: 'Art. 49 / Art. 71', confidence: 'medium',
    applies: a => a.isHighRisk && a.role === 'provider',
    finding: a => ({
      severity: a.registeredInEuDatabase ? 'PASS' : 'GAP',
      title: 'Registration in the EU database',
      detail: 'High-risk systems were reported as requiring registration in the EU database before being placed on the market.',
      action: 'Register before placing on the market or putting into service.',
      verify: 'Articles 49 and 71 registration obligations and timing.',
    }),
  },
  {
    id: 'PROVIDER_QMS', article: 'Art. 17', confidence: 'high',
    applies: a => a.isHighRisk && a.role === 'provider',
    finding: a => ({
      severity: a.qualityManagementSystem ? 'PASS' : 'GAP',
      title: 'Quality management system',
      detail: 'Providers of high-risk systems must operate a documented QMS.',
      action: 'Document the QMS. ISO/IEC 42001 is commonly used as the backbone but is not itself a legal presumption of conformity.',
      verify: 'Article 17 QMS content requirements.',
    }),
  },
  {
    id: 'PROVIDER_POST_MARKET', article: 'Art. 72', confidence: 'medium',
    applies: a => a.isHighRisk && a.role === 'provider',
    finding: a => ({
      severity: a.postMarketMonitoring ? 'PASS' : 'GAP',
      title: 'Post-market monitoring',
      detail: 'A post-market monitoring system was reported as required to be active before market placement.',
      action: 'Define what is monitored, how often it is reviewed, and who acts on the findings.',
      verify: 'Article 72 post-market monitoring plan requirements.',
    }),
  },
  {
    id: 'DEADLINE', article: 'Art. 113 (application dates)', confidence: 'high',
    applies: a => a.isHighRisk,
    finding: () => ({
      severity: 'INFO',
      title: `High-risk obligations reported as applying from ${ENFORCEMENT_DATE}`,
      detail: 'Obligations for high-risk systems were reported as becoming enforceable on 2 August 2026. Transitional arrangements may apply to systems already on the market.',
      action: 'Confirm whether any transitional provision applies to your system.',
      verify: 'Article 113 and the transitional provisions in Article 111.',
    }),
  },
];

/** Normalise raw answers into the derived facts the rules read. */
function derive(answers = {}) {
  const a = { ...answers };
  a.role = ROLES.includes(a.role) ? a.role : 'unknown';
  a.annexIII = a.annexIII ?? 'none';
  const cat = ANNEX_III.find(c => c.id === a.annexIII);
  a.isHighRisk = Boolean(cat) || a.safetyComponentAnnexI === true;
  a.retentionMonths = Number.isFinite(a.retentionMonths) ? a.retentionMonths : null;
  return a;
}

const SEVERITY_ORDER = { BLOCKER: 0, GAP: 1, ADVISORY: 2, INFO: 3, PASS: 4 };

/**
 * assess(answers) — pure. Same answers in, same report out, always.
 */
export function assess(answers = {}) {
  const a = derive(answers);
  const findings = [];
  for (const rule of RULES) {
    let hit = false;
    try { hit = rule.applies(a); } catch { hit = false; }
    if (!hit) continue;
    const f = typeof rule.finding === 'function' ? rule.finding(a) : rule.finding;
    findings.push({ id: rule.id, article: rule.article, confidence: rule.confidence, ...f });
  }
  findings.sort((x, y) =>
    (SEVERITY_ORDER[x.severity] ?? 9) - (SEVERITY_ORDER[y.severity] ?? 9) || x.id.localeCompare(y.id));

  const counts = findings.reduce((c, f) => { c[f.severity] = (c[f.severity] || 0) + 1; return c; }, {});
  const lowConfidence = findings.filter(f => f.confidence === 'low').map(f => f.id);

  return {
    engine: ENGINE_ID,
    engineEncodedOn: ENGINE_ENCODED_ON,
    inputs: a,
    inScope: a.isHighRisk,
    findings,
    counts,
    blockers: findings.filter(f => f.severity === 'BLOCKER').length,
    gaps: findings.filter(f => f.severity === 'GAP').length,
    lowConfidenceRules: lowConfidence,
    legalBoundary: LEGAL_BOUNDARY,
    // Deliberately NO overall "compliant: true/false". That verdict is a
    // conformity assessment and is not ours to issue.
    verdictWithheld: 'This engine does not issue a compliance verdict. It lists applicable obligations and observed gaps.',
  };
}

/** The FREE tier: scope only. Enough to be genuinely useful, not the full report. */
export function scopeOnly(answers = {}) {
  const full = assess(answers);
  return {
    engine: ENGINE_ID,
    inScope: full.inScope,
    role: full.inputs.role,
    annexIII: full.inputs.annexIII,
    applicableObligationCount: full.findings.filter(f => f.severity !== 'PASS' && f.severity !== 'INFO').length,
    headline: full.inScope
      ? `In scope as ${full.inputs.role}. ${full.blockers} blocker(s) and ${full.gaps} gap(s) identified.`
      : 'No Annex III high-risk category selected — Article 12 record-keeping likely not triggered on that basis.',
    legalBoundary: LEGAL_BOUNDARY,
    teaser: full.findings.filter(f => f.severity === 'BLOCKER' || f.severity === 'GAP').slice(0, 1)
      .map(f => ({ article: f.article, title: f.title })),
    fullReportWithheld: true,
  };
}

export const __engineInternals = Object.freeze({ RULES, derive, SEVERITY_ORDER });
