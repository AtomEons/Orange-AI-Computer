import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REFLEX_REGISTRY_SCHEMA = 'orange5.reflex-registry.v1';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function canonicalReflexRegistryPath() {
  return process.env.ORANGE5_REFLEX_REGISTRY_PATH
    || path.join(os.homedir(), 'OrangeBox-Data', 'orange5', 'control', 'reflex-registry.json');
}

function emptyRegistry() {
  return { schema: REFLEX_REGISTRY_SCHEMA, version: 1, rules: [], transitions: [] };
}

export function loadReflexRegistry(registryPath = canonicalReflexRegistryPath()) {
  if (!fs.existsSync(registryPath)) return emptyRegistry();
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (registry.schema !== REFLEX_REGISTRY_SCHEMA || !Array.isArray(registry.rules) || !Array.isArray(registry.transitions)) {
    throw new Error('reflex registry schema mismatch');
  }
  for (const rule of registry.rules) {
    const { rule_hash: ruleHash, promoted_at: _promotedAt, ...hashable } = rule;
    if (!ruleHash || sha256(stableJson(hashable)) !== ruleHash) throw new Error(`reflex registry rule hash mismatch: ${rule.id || 'unknown'}`);
  }
  return registry;
}

function writeRegistry(registryPath, registry) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const temp = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, registryPath);
}

function validateRule(rule) {
  if (!rule || typeof rule !== 'object') throw new TypeError('reflex rule required');
  if (!/^[a-z][a-z0-9-]{2,80}$/.test(String(rule.id || ''))) throw new TypeError('invalid reflex rule id');
  for (const field of ['all', 'any', 'none']) {
    if (!Array.isArray(rule.match?.[field])) throw new TypeError(`reflex rule match.${field} must be an array`);
  }
  if (!rule.decision || typeof rule.decision.nextAction !== 'string') throw new TypeError('reflex rule decision required');
  if (!Array.isArray(rule.positive_holdouts) || rule.positive_holdouts.length < 3) throw new TypeError('at least three positive holdouts required');
  if (!Array.isArray(rule.negative_holdouts) || rule.negative_holdouts.length < 3) throw new TypeError('at least three negative holdouts required');
}

export function matchReflexRule(rule, text) {
  const hay = String(text || '').toLowerCase();
  const includes = (needle) => hay.includes(String(needle).toLowerCase());
  return rule.active !== false
    && rule.match.all.every(includes)
    && (rule.match.any.length === 0 || rule.match.any.some(includes))
    && !rule.match.none.some(includes);
}

function proveHoldouts(rule) {
  const positives = rule.positive_holdouts.map((prompt) => ({ prompt, pass: matchReflexRule({ ...rule, active: true }, prompt) }));
  const negatives = rule.negative_holdouts.map((prompt) => ({ prompt, pass: !matchReflexRule({ ...rule, active: true }, prompt) }));
  return { passed: positives.every((row) => row.pass) && negatives.every((row) => row.pass), positives, negatives };
}

function isExactEvidenceCitation(value) {
  const text = String(value || '');
  return /(?:receipt|source|sha256)/i.test(text) && /\b[a-f0-9]{64}\b/i.test(text);
}

export function promoteReflexRule(rule, {
  registryPath = canonicalReflexRegistryPath(), operatorApproval = false, evidence = [], actor = 'operator',
} = {}) {
  validateRule(rule);
  if (!operatorApproval) throw new Error('operator approval required for reflex promotion');
  if (!Array.isArray(evidence) || evidence.length === 0) throw new Error('promotion evidence required');
  if (!evidence.every(isExactEvidenceCitation)) throw new Error('promotion evidence must cite immutable receipt or source hashes');
  const holdouts = proveHoldouts(rule);
  if (!holdouts.passed) throw new Error('reflex promotion rejected by held-out falsifier');
  const registry = loadReflexRegistry(registryPath);
  const before = registry.rules.find((entry) => entry.id === rule.id) || null;
  const promoted = {
    ...rule,
    active: true,
    authority: 'operator',
    evidence: evidence.map(String),
    promoted_at: new Date().toISOString(),
    rule_hash: sha256(stableJson({ ...rule, active: true, authority: 'operator', evidence: evidence.map(String) })),
  };
  registry.rules = [...registry.rules.filter((entry) => entry.id !== rule.id), promoted].sort((a, b) => a.id.localeCompare(b.id));
  const rollbackToken = sha256(`${promoted.rule_hash}|${stableJson(before)}`);
  registry.transitions.push({ type: 'promote', rule_id: rule.id, actor, at: promoted.promoted_at, before, after_hash: promoted.rule_hash, rollback_token: rollbackToken });
  writeRegistry(registryPath, registry);
  return { rule: promoted, holdouts, rollback_token: rollbackToken, registry_path: registryPath };
}

export function rollbackReflexRule(ruleId, rollbackToken, { registryPath = canonicalReflexRegistryPath(), actor = 'operator' } = {}) {
  const registry = loadReflexRegistry(registryPath);
  const transition = [...registry.transitions].reverse().find((entry) => entry.type === 'promote' && entry.rule_id === ruleId && entry.rollback_token === rollbackToken);
  if (!transition) throw new Error('valid rollback token not found');
  if (registry.transitions.some((entry) => entry.type === 'rollback' && entry.rollback_token === rollbackToken)) {
    throw new Error('rollback token already used');
  }
  const current = registry.rules.find((entry) => entry.id === ruleId) || null;
  if (!current || current.rule_hash !== transition.after_hash) throw new Error('rollback token does not match current rule state');
  registry.rules = registry.rules.filter((entry) => entry.id !== ruleId);
  if (transition.before) registry.rules.push(transition.before);
  registry.rules.sort((a, b) => a.id.localeCompare(b.id));
  registry.transitions.push({
    type: 'rollback', rule_id: ruleId, actor, at: new Date().toISOString(),
    from_hash: transition.after_hash, restored_hash: transition.before?.rule_hash || null, rollback_token: rollbackToken,
  });
  writeRegistry(registryPath, registry);
  return { rolled_back: true, restored: transition.before, registry_path: registryPath };
}

export function classifyPromotedReflex(text, registryPath = canonicalReflexRegistryPath()) {
  const registry = loadReflexRegistry(registryPath);
  const rule = registry.rules.find((entry) => matchReflexRule(entry, text));
  return rule ? { id: rule.id, ...rule.decision, authority: rule.authority, rule_hash: rule.rule_hash } : null;
}

export const __reflexRegistryInternals = Object.freeze({ sha256, stableJson, isExactEvidenceCitation });
