import { createHash } from 'node:crypto';
import { compileWave3Kernel } from './wave3-intelligent-kernel.mjs';
import { hydrateWave3LeastActionWorkbench } from './wave3-workbench-hydrator.mjs';

export const WORK_OBJECT_SCHEMA = 'orange.work-object.v1';

const sha256 = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');
const clean = (value, max = 8_000) => String(value ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);
const unique = (items, limit = 24) => [...new Set(items.map((item) => clean(item, 1_000)).filter(Boolean))].slice(0, limit);

const CONSTRAINT = /\b(?:must|must not|never|only|without|do not|don't|cannot|can't|required?|forbid|avoid|keep|preserve|under|within|no\s+)\b/i;
const ACCEPTANCE = /\b(?:done when|complete when|acceptance|success(?:ful)?(?:ly)?|verify|prove|green|passes?|working|functional|ready)\b/i;
const DELIVERABLE = /\b(?:build|create|implement|produce|write|add|fix|repair|deploy|install|configure|update|export|generate|document|return|report)\b/i;
const EVIDENCE = /\b(?:receipt|evidence|proof|test|probe|benchmark|source|citation|screenshot|hash|log)\b/i;
const NEGATION = /\b(?:not|never|no|without|avoid|forbid|exclude|skip|hold)\b/i;

function clauses(text) {
  return clean(text, 64_000)
    .split(/(?:\n+|(?<=[.!?;])\s+)/)
    .map((item) => item.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((item) => item.length > 1)
    .slice(0, 256);
}

function inferObjective(items, fallback) {
  return clean(items.find((item) => DELIVERABLE.test(item) && !NEGATION.test(item)) || items[0] || fallback, 2_000);
}

function inferStopConditions(items) {
  const explicit = items.filter((item) => /\b(?:stop|until|unless|done when|complete when)\b/i.test(item));
  return unique(explicit.length ? explicit : ['Declared acceptance criteria are satisfied or an evidenced blocker prevents further progress.'], 12);
}

function inferRisk(text, declared) {
  if (declared) return clean(declared, 32).toLowerCase();
  if (/\b(?:delete|wipe|remove|uninstall|publish|release|production|credential|security|payment|legal|medical)\b/i.test(text)) return 'high';
  if (/\b(?:edit|write|install|deploy|restart|execute|train|network)\b/i.test(text)) return 'medium';
  return 'low';
}

export function compileProblem(input = {}, context = {}) {
  const sourceText = typeof input === 'string'
    ? input
    : clean(input.intent || input.request || input.text || input.payload?.request || input.payload?.text || '', 64_000);
  if (!sourceText) throw new Error('problem compiler requires source intent');
  const parts = clauses(sourceText);
  const constraints = unique(parts.filter((item) => CONSTRAINT.test(item)), 32);
  const deliverables = unique(parts.filter((item) => DELIVERABLE.test(item) && !NEGATION.test(item)), 32);
  const acceptance = unique(parts.filter((item) => ACCEPTANCE.test(item)), 24);
  const evidence = unique(parts.filter((item) => EVIDENCE.test(item)), 24);
  const forbidden = unique(parts.filter((item) => NEGATION.test(item)), 24);
  const unknowns = unique(parts.filter((item) => /\b(?:unknown|unclear|unsure|maybe|might|whether|if practical|if possible)\b/i.test(item)), 16);
  const objective = inferObjective(parts, sourceText);
  const project = clean(context.project || input.targetProject || input.projectId || 'orange5', 256);
  const compiled = {
    schema: WORK_OBJECT_SCHEMA,
    workId: `work-${sha256(`${project}\n${sourceText}`).slice(0, 24)}`,
    project,
    objective,
    deliverables: deliverables.length ? deliverables : [objective],
    constraints,
    forbidden,
    acceptance: acceptance.length ? acceptance : [`Produce evidence that the objective was completed: ${objective}`],
    evidenceRequired: evidence.length ? evidence : ['Terminal outcome receipt with inspectable evidence pointers.'],
    unknowns,
    stopConditions: inferStopConditions(parts),
    authority: clean(context.authority || input.authority || 'operator', 128),
    custody: {
      owner: clean(context.owner || input.owner || 'orangebrain', 128),
      cancellation: clean(input.cancellation || 'operator may cancel before terminal outcome', 512),
      terminalRequired: true,
    },
    riskLevel: inferRisk(sourceText, input.riskLevel),
    source: {
      sha256: sha256(sourceText),
      byteLength: Buffer.byteLength(sourceText, 'utf8'),
      preview: clean(sourceText, 1_500),
    },
  };
  const inheritedKernel = input?.wave3Kernel || context?.wave3Kernel || null;
  const inheritedWorkbench = input?.wave3Workbench || context?.wave3Workbench || null;
  compiled.wave3Kernel = compileWave3Kernel(compiled, { inheritedKernel });
  compiled.wave3Workbench = hydrateWave3LeastActionWorkbench(compiled.wave3Kernel, {
    inheritedKernel,
    inheritedWorkbench,
    ledgerPath: input?.wave3KernelStateLedger || context?.wave3KernelStateLedger,
  });
  compiled.compilationHash = sha256(JSON.stringify(compiled));
  return compiled;
}

export function validateWorkObject(work) {
  const errors = [];
  if (work?.schema !== WORK_OBJECT_SCHEMA) errors.push(`schema must be ${WORK_OBJECT_SCHEMA}`);
  if (!work?.workId) errors.push('workId is required');
  if (!work?.objective) errors.push('objective is required');
  for (const field of ['deliverables', 'constraints', 'forbidden', 'acceptance', 'evidenceRequired', 'unknowns', 'stopConditions']) {
    if (!Array.isArray(work?.[field])) errors.push(`${field} must be an array`);
  }
  if (!work?.source?.sha256) errors.push('source.sha256 is required');
  if (!work?.custody?.owner || work?.custody?.terminalRequired !== true) errors.push('custody must declare owner and terminal outcome');
  if (!work?.wave3Kernel?.manifestHash || !work?.wave3Kernel?.worksetHash) errors.push('wave3Kernel hashes are required');
  if (!/^[0-9a-f]{25}$/.test(String(work?.wave3Kernel?.activationBitset || ''))) errors.push('wave3Kernel activationBitset must be 100 bits encoded as 25 hex characters');
  if (!Array.isArray(work?.wave3Kernel?.activeMechanismIds)) errors.push('wave3Kernel.activeMechanismIds must be an array');
  if (!work?.wave3Workbench?.manifestHash || !work?.wave3Workbench?.workbenchHash) errors.push('wave3Workbench hashes are required');
  if (!Array.isArray(work?.wave3Workbench?.activeMechanismIds)) errors.push('wave3Workbench.activeMechanismIds must be an array');
  if (!Array.isArray(work?.wave3Workbench?.descriptors)) errors.push('wave3Workbench.descriptors must be an array');
  if (!Array.isArray(work?.wave3Workbench?.evidencePointers)) errors.push('wave3Workbench.evidencePointers must be an array');
  if (work?.wave3Workbench?.descriptors?.some((descriptor) => descriptor?.status !== 'active')) {
    errors.push('wave3Workbench may hydrate only active mechanism descriptors');
  }
  return { ok: errors.length === 0, errors };
}

export function renderWorkObjectAir(work, maxBytes = 2_400) {
  const line = (prefix, values) => values?.length ? `${prefix}:${values.join(' | ')}` : null;
  return [
    `G:${work.objective}`,
    line('T', work.deliverables),
    line('L', work.constraints),
    line('V', work.forbidden),
    line('P', work.acceptance),
    line('S', work.evidenceRequired),
    line('U', work.unknowns),
    `R:risk=${work.riskLevel};owner=${work.custody.owner};source=${work.source.sha256.slice(0, 16)}`,
    work.wave3Kernel
      ? `K:manifest=${work.wave3Kernel.manifestHash.slice(0, 16)};workset=${work.wave3Kernel.worksetHash.slice(0, 16)};bits=${work.wave3Kernel.activationBitset}`
      : null,
  ].filter(Boolean).join('\n').slice(0, Math.max(256, maxBytes));
}
