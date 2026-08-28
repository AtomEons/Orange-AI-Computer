// article12.test.mjs
//
// The product claim is REPRODUCIBILITY. If the same answers do not produce the
// same stamp, there is no product — an auditor cannot rely on it and there is
// nothing here a language model could not already do worse.
//
// The second claim is RESTRAINT: the engine must never issue a compliance
// verdict, because that is regulated work. Tests enforce that it cannot.
//
// Run: bun 15-INTEGRATIONS/aiact/tests/article12.test.mjs

import { assess, scopeOnly, ANNEX_III, LEGAL_BOUNDARY } from '../article12-engine.mjs';
import { buildReport, stampOf, toMarkdown, toHTML, toJSON } from '../report-render.mjs';

let pass = 0, fail = 0;
function t(n, f) { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m); }

console.log('\nEU AI Act Article 12 engine — determinism, restraint, usefulness\n');

const HIRING_DEPLOYER = {
  role: 'deployer', annexIII: 'employment',
  hasAutomaticLogging: false, logsEnableTraceability: false, logsTamperEvident: false,
  retentionMonths: 1, humanOversight: false, publicBodyOrEssentialService: false,
};
const BIOMETRIC_PROVIDER = {
  role: 'provider', annexIII: 'biometric',
  hasAutomaticLogging: true, logsEnableTraceability: true, logsTamperEvident: true,
  conformityAssessmentDone: false, registeredInEuDatabase: false,
  qualityManagementSystem: false, postMarketMonitoring: false,
};

// ══ THE CORE CLAIM: REPRODUCIBILITY ═══════════════════════════════════════
t('CORE: identical answers produce an identical stamp', () => {
  const a = buildReport(HIRING_DEPLOYER, { organisation: 'X', generatedAt: '2026-07-26T10:00:00Z' });
  const b = buildReport(HIRING_DEPLOYER, { organisation: 'X', generatedAt: '2026-07-26T10:00:00Z' });
  assert(a.stamp === b.stamp, `stamps differ: ${a.stamp} vs ${b.stamp}`);
});

t('CORE: the stamp survives a different generation time — re-runnable in 2028', () => {
  const now = buildReport(HIRING_DEPLOYER, { generatedAt: '2026-07-26T10:00:00Z' });
  const later = buildReport(HIRING_DEPLOYER, { generatedAt: '2028-11-04T23:59:00Z' });
  assert(now.stamp === later.stamp, 'timestamp must not enter the stamp — an audit re-run must match');
});

t('CORE: changing one answer changes the stamp', () => {
  const before = buildReport(HIRING_DEPLOYER);
  const after = buildReport({ ...HIRING_DEPLOYER, retentionMonths: 12 });
  assert(before.stamp !== after.stamp, 'a changed answer must be visible in the stamp');
});

t('CORE: findings are stably ordered — no run-to-run drift', () => {
  const ids = () => assess(BIOMETRIC_PROVIDER).findings.map(f => f.id).join(',');
  assert(ids() === ids(), 'ordering must be deterministic');
});

t('CORE: full JSON export is byte-identical across runs', () => {
  const a = toJSON(buildReport(BIOMETRIC_PROVIDER, { generatedAt: null }));
  const b = toJSON(buildReport(BIOMETRIC_PROVIDER, { generatedAt: null }));
  assert(a === b, 'export must be byte-identical');
});

// ══ RESTRAINT: NEVER ISSUE A VERDICT ══════════════════════════════════════
t('RESTRAINT: no compliance verdict is ever emitted', () => {
  const r = assess(BIOMETRIC_PROVIDER);
  assert(r.compliant === undefined, 'must not emit `compliant`');
  assert(r.certified === undefined, 'must not emit `certified`');
  assert(typeof r.verdictWithheld === 'string', 'must state that the verdict is withheld');
});

t('RESTRAINT: the legal boundary is present and disclaims certification', () => {
  assert(LEGAL_BOUNDARY.is_not.some(s => /conformity assessment/i.test(s)), 'must disclaim conformity assessment');
  assert(LEGAL_BOUNDARY.is_not.some(s => /legal advice/i.test(s)), 'must disclaim legal advice');
  assert(/counsel|notified body/i.test(LEGAL_BOUNDARY.required_next_step), 'must direct to counsel');
});

t('RESTRAINT: the boundary appears in every export format', () => {
  const rep = buildReport(HIRING_DEPLOYER);
  assert(/not.*conformity assessment/is.test(toMarkdown(rep)), 'markdown must disclaim');
  assert(/conformity assessment/i.test(toHTML(rep)), 'html must disclaim');
  assert(/conformity assessment/i.test(toJSON(rep)), 'json must disclaim');
});

t('RESTRAINT: low-confidence rules are surfaced, not buried', () => {
  const r = assess(HIRING_DEPLOYER);
  assert(r.lowConfidenceRules.includes('ART12_TAMPER_EVIDENCE'), 'tamper-evidence is our weakest encoding and must be flagged');
  const f = r.findings.find(x => x.id === 'ART12_TAMPER_EVIDENCE');
  assert(f.severity === 'ADVISORY', `must be ADVISORY not GAP, got ${f.severity}`);
  assert(/NOT AS A STATED REQUIREMENT/i.test(f.verify), 'must say plainly it is not established as mandatory');
});

t('RESTRAINT: we do not invent a requirement we cannot cite', () => {
  const r = assess(BIOMETRIC_PROVIDER);
  assert(r.findings.every(f => typeof f.article === 'string' && f.article.length > 3), 'every finding cites an article');
  assert(r.findings.every(f => typeof f.verify === 'string' && f.verify.length > 10), 'every finding says how to verify it');
});

// ══ USEFULNESS: IT MUST ACTUALLY FIND THINGS ══════════════════════════════
t('finds the real gaps for an unprepared hiring deployer', () => {
  const r = assess(HIRING_DEPLOYER);
  const ids = r.findings.map(f => f.id);
  assert(ids.includes('DEPLOYER_LOG_AVAILABILITY'), 'must flag that no logs are being generated to retain');
  assert(ids.includes('DEPLOYER_LOG_RETENTION'), 'must flag 1-month retention against the 6-month figure');
  assert(ids.includes('DEPLOYER_HUMAN_OVERSIGHT'), 'must flag missing oversight');
  assert(r.gaps >= 3, `expected several gaps, got ${r.gaps}`);
});

t('a deployer does NOT inherit the provider-only Article 12 design duty', () => {
  // legal accuracy: the deployer must have logs to retain (Art 26), but the
  // duty to BUILD logging capability sits with the provider (Art 12).
  const r = assess(HIRING_DEPLOYER);
  assert(!r.findings.some(f => f.id === 'ART12_LOGGING_CAPABILITY'),
    'deployer must not be told they owe the provider design obligation');
  const avail = r.findings.find(f => f.id === 'DEPLOYER_LOG_AVAILABILITY');
  assert(/Art\. 26/.test(avail.article), 'the deployer finding must cite Art. 26 as its source');
});

t('the vendor-API trap produces actionable contract language, not just a complaint', () => {
  const r = assess(HIRING_DEPLOYER);
  const f = r.findings.find(x => x.id === 'DEPLOYER_LOG_AVAILABILITY');
  assert(/contractual guarantee/i.test(f.action), 'must tell them what to put in the vendor contract');
  assert(/post-termination|export/i.test(f.action), 'must cover losing access when the contract ends');
});

t('flags notified-body assessment as a BLOCKER for biometric', () => {
  const r = assess(BIOMETRIC_PROVIDER);
  const f = r.findings.find(x => x.id === 'PROVIDER_CONFORMITY');
  assert(f.severity === 'BLOCKER', `expected BLOCKER, got ${f.severity}`);
  assert(/notified body/i.test(f.detail), 'must name the notified-body route');
  assert(/lead times|immediately/i.test(f.action), 'must convey urgency — this is the long pole');
});

t('does not raise Article 12 gaps when nothing puts the system in scope', () => {
  const r = assess({ role: 'deployer', annexIII: 'none' });
  assert(r.inScope === false, 'must be out of scope');
  assert(r.findings.some(f => f.id === 'SCOPE_NOT_HIGH_RISK'), 'must explain why');
  assert(!r.findings.some(f => f.id.startsWith('ART12_')), 'must not invent Article 12 gaps');
});

t('an undetermined role blocks everything else — the right first question', () => {
  const r = assess({});
  assert(r.findings[0].id === 'SCOPE_ROLE_UNKNOWN', 'role must be the first blocker');
  assert(r.findings[0].severity === 'BLOCKER', 'must be a blocker');
});

t('a prepared deployer sees PASS with a retain-the-evidence instruction', () => {
  const r = assess({
    role: 'deployer', annexIII: 'employment',
    hasAutomaticLogging: true, logsEnableTraceability: true, logsTamperEvident: true,
    retentionMonths: 12, humanOversight: true, publicBodyOrEssentialService: false,
  });
  assert(r.gaps === 0, `expected no gaps, got ${r.gaps}`);
  assert(r.findings.some(f => f.severity === 'PASS'), 'should show passes');
});

// ══ FREE TIER: USEFUL, BUT WITHHOLDS THE PAID ARTIFACT ════════════════════
t('free scope check answers the panic question', () => {
  const s = scopeOnly(HIRING_DEPLOYER);
  assert(s.inScope === true, 'must answer in/out of scope');
  assert(/In scope as deployer/.test(s.headline), `headline: ${s.headline}`);
  assert(s.applicableObligationCount > 0, 'must count obligations');
});

t('free tier withholds the full report but is honest that it does', () => {
  const s = scopeOnly(HIRING_DEPLOYER);
  assert(s.fullReportWithheld === true, 'must declare the withholding');
  assert(s.teaser.length <= 1, 'teaser is one item');
  assert(s.findings === undefined, 'must not leak the full findings');
  assert(s.legalBoundary != null, 'the boundary is never paywalled');
});

t('the out-of-scope answer is given away free — never upsell someone who owes nothing', () => {
  const s = scopeOnly({ role: 'deployer', annexIII: 'none' });
  assert(s.inScope === false, 'must say out of scope');
  assert(/likely not triggered/.test(s.headline), 'must say so plainly and for free');
});

// ══ EXPORT ════════════════════════════════════════════════════════════════
t('markdown export carries stamp, findings and checklist', () => {
  const md = toMarkdown(buildReport(HIRING_DEPLOYER, { organisation: 'Acme', systemName: 'Screener' }));
  assert(/Reproducibility stamp/.test(md), 'stamp');
  assert(/Acme/.test(md) && /Screener/.test(md), 'identity');
  assert(/Evidence checklist/.test(md), 'checklist');
  assert(/Art\. 12/.test(md), 'article citations');
});

t('HTML export is self-contained — opens offline in 2028', () => {
  const html = toHTML(buildReport(BIOMETRIC_PROVIDER));
  assert(!/https?:\/\//.test(html), 'must contain no external URL — no CDN, no font, no tracker');
  assert(/<style>/.test(html), 'styles inlined');
});

t('HTML escapes user input', () => {
  const html = toHTML(buildReport(HIRING_DEPLOYER, { organisation: '<script>alert(1)</script>' }));
  assert(!/<script>alert/.test(html), 'must escape injected markup');
  assert(/&lt;script&gt;/.test(html), 'must render escaped');
});

t('every Annex III category is assessable without throwing', () => {
  for (const c of ANNEX_III) {
    const r = assess({ role: 'provider', annexIII: c.id });
    assert(r.inScope === true, `${c.id} should be in scope`);
    assert(r.findings.length > 0, `${c.id} produced no findings`);
  }
});

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${pass + fail}\n`);
if (fail > 0) process.exit(1);
