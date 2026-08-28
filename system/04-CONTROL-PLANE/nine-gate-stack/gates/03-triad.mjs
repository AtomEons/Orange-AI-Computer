// 03-triad.mjs — Gate 3 Triad of the 9-Gate Stack.
//
// Position in the 9-Gate Stack: FOURTH (after LBCE, Scope, Department).
// Bypassable: false. Target: <40ms. Pure function, no I/O, no network.
//
// Purpose: three-way consistency between the operator's INTENT, the
// authorized SCOPE, and the concrete ACTION being submitted.
//
// Gate 0 has proven lattice integrity. Gate 1 has proven action.scope is a
// narrowing of order.scope. Gate 2 has routed the action to the correct
// AE0-AE14 department lane. Gate 3 now asks a different question:
//
//   "Do these three things tell the same story?"
//
//   intent  : order.intent          — the verb-shaped goal the operator wrote
//   scope   : order.scope + action.scope — where the work lives
//   action  : action.actionType + action.target + action.summary — what is being done
//
// A coherent triad has three pairwise agreements:
//
//   A. intent ↔ scope    The intent's domain language is compatible with the
//                        scope's lane. ("audit receipts" pointed at 02-APP is
//                        incoherent — receipts live in 10-RECEIPTS.)
//
//   B. scope  ↔ action   The action.actionType belongs to the family of actions
//                        the lane sustains. Writing code to 10-RECEIPTS, or
//                        promoting a build inside 18-HELD, is incoherent.
//
//   C. intent ↔ action   The action.actionType is in the verb family of the
//                        intent. Intent "audit" with action "delete_file" is
//                        incoherent; intent "ship" with action "draft_note" is
//                        incoherent.
//
// All three pairs must hold. A single broken pair → triad_mismatch.
//
// This gate does NOT re-do Gate 1 (path containment) or Gate 2 (department
// routing). If those gates passed and Gate 3 fails, the action is
// well-located and well-routed but internally contradictory — which is the
// exact class of bug Triad exists to catch: an action that "fits everywhere
// but means nothing."
//
// Mom's Law: every refusal cites the exact broken pair and the exact terms
// that disagreed. No "looks fine" passes. No silent normalization that hides
// a real contradiction. No fake-green words.

const GATE_ID = 'gate-3-triad'
const GATE_NAME = 'Triad — intent ↔ scope ↔ action consistency'
const BYPASSABLE = false
const POSITION_IN_STACK = 3
const TARGET_MS = 40

// -- Lane → action-family map (scope ↔ action affinity) ---------------------
//
// Each Orange5 lane sustains a finite family of action types. An action whose
// actionType is outside the lane's family is a scope↔action contradiction
// even when the path strings line up. This table is the lawful affinity.
//
// Keys are lane names (must match LATTICE_LANES in 00-lbce.mjs).
// Values are sets of allowed action-type roots. A root matches if the
// actionType equals it or starts with it followed by '.' or '_' or ':'.
//
// Action-type roots are deliberately coarse — we are checking SEMANTIC family,
// not exact syntax. Exact syntax was Gate 1's job.
const LANE_ACTION_FAMILIES = Object.freeze({
  '00-CHARTER':       ['read', 'audit', 'cite'],
  '01-DOCTRINE':      ['read', 'audit', 'cite', 'append_doctrine'],
  '02-APP':           ['build', 'write_code', 'refactor', 'test', 'lint', 'preview', 'read', 'audit'],
  '03-BACKEND':       ['build', 'write_code', 'refactor', 'test', 'lint', 'migrate', 'read', 'audit'],
  '04-CONTROL-PLANE': ['write_code', 'test', 'audit', 'read', 'gate_extend'],
  '05-FLOW':          ['write_code', 'test', 'audit', 'read'],
  '06-ORANGELLM':     ['write_code', 'test', 'audit', 'read', 'eval'],
  '07-VISUAL':        ['write_code', 'screenshot', 'audit', 'read'],
  '08-HERMES':        ['write_code', 'test', 'audit', 'read', 'dispatch'],
  '09-SCHEMAS':       ['write_schema', 'audit', 'read', 'validate'],
  '10-RECEIPTS':      ['emit_receipt', 'read', 'audit'],
  '11-MIRAGE':        ['write_code', 'audit', 'read', 'snapshot'],
  '12-ATOMSMASHER':   ['write_code', 'test', 'audit', 'read', 'simulate'],
  '13-TOOLMESH':      ['write_code', 'test', 'audit', 'read', 'register_tool'],
  '14-SUPERSTACK':    ['write_code', 'audit', 'read', 'compose'],
  '15-INTEGRATIONS':  ['write_code', 'test', 'audit', 'read', 'integrate'],
  '16-TRAINING':      ['train', 'eval', 'audit', 'read', 'snapshot'],
  '17-DAGS':          ['write_code', 'run_dag', 'audit', 'read'],
  '18-HELD':          ['hold', 'release_held', 'audit', 'read'],   // no write/build in HELD
  '19-ARCHIVE':       ['archive', 'read', 'audit'],                 // archive is terminal
})

// -- Intent verb → action-family map (intent ↔ action verb compatibility) ---
//
// Operator intent typically starts with one or two verbs. The verb selects
// a permitted action-type family. Anything outside the family is an
// intent↔action contradiction.
//
// Keys are canonical intent verbs. Values are sets of allowed actionType
// roots (same matching rule as LANE_ACTION_FAMILIES).
const INTENT_VERB_FAMILIES = Object.freeze({
  audit:    ['audit', 'read', 'cite'],
  review:   ['audit', 'read', 'cite'],
  read:     ['read', 'audit'],
  cite:     ['cite', 'read', 'audit'],
  build:    ['build', 'write_code', 'refactor', 'test', 'compose'],
  write:    ['write_code', 'write_schema', 'append_doctrine', 'refactor', 'build'],
  code:     ['write_code', 'refactor', 'build', 'test'],
  refactor: ['refactor', 'write_code'],
  fix:      ['write_code', 'refactor', 'test'],
  test:     ['test', 'eval', 'simulate'],
  validate: ['validate', 'audit', 'test', 'lint'],
  lint:     ['lint', 'audit'],
  evaluate: ['eval', 'test', 'audit'],
  train:    ['train', 'eval'],
  ship:     ['build', 'release_held', 'emit_receipt'],
  promote:  ['release_held', 'emit_receipt'],
  hold:     ['hold'],
  release:  ['release_held', 'emit_receipt'],
  archive:  ['archive', 'emit_receipt'],
  emit:     ['emit_receipt'],
  schema:   ['write_schema', 'validate', 'audit'],
  migrate:  ['migrate', 'write_code'],
  preview:  ['preview', 'screenshot', 'read'],
  screenshot:['screenshot', 'preview'],
  dispatch: ['dispatch'],
  simulate: ['simulate', 'eval', 'test'],
  snapshot: ['snapshot', 'read', 'audit'],
  integrate:['integrate', 'write_code', 'test'],
  register: ['register_tool', 'write_code'],
  extend:   ['gate_extend', 'write_code', 'test'],
  compose:  ['compose', 'write_code'],
  run:      ['run_dag', 'simulate', 'eval'],
})

// -- Intent topic → lane family map (intent ↔ scope domain compatibility) ---
//
// Operator intent often names a domain noun ("receipts", "gates", "schemas",
// "doctrine", "training", etc.). When a topic word is present in the intent,
// it must point at a lane in its lawful set, or the intent↔scope pair breaks.
//
// Topics not in this map do not constrain scope — Triad does not invent
// constraints; it only refuses ones we have explicit evidence for.
const INTENT_TOPIC_LANES = Object.freeze({
  receipt:      ['10-RECEIPTS'],
  receipts:     ['10-RECEIPTS'],
  gate:         ['04-CONTROL-PLANE'],
  gates:        ['04-CONTROL-PLANE'],
  'control-plane':['04-CONTROL-PLANE'],
  hermes:       ['08-HERMES'],
  schema:       ['09-SCHEMAS'],
  schemas:      ['09-SCHEMAS'],
  doctrine:     ['01-DOCTRINE'],
  charter:      ['00-CHARTER'],
  app:          ['02-APP'],
  ui:           ['02-APP', '07-VISUAL'],
  visual:       ['07-VISUAL'],
  backend:      ['03-BACKEND'],
  flow:         ['05-FLOW'],
  orangellm:    ['06-ORANGELLM'],
  llm:          ['06-ORANGELLM', '16-TRAINING'],
  mirage:       ['11-MIRAGE'],
  atomsmasher:  ['12-ATOMSMASHER'],
  toolmesh:     ['13-TOOLMESH'],
  tool:         ['13-TOOLMESH'],
  superstack:   ['14-SUPERSTACK'],
  integration:  ['15-INTEGRATIONS'],
  integrations: ['15-INTEGRATIONS'],
  training:     ['16-TRAINING'],
  dag:          ['17-DAGS'],
  dags:         ['17-DAGS'],
  held:         ['18-HELD'],
  archive:      ['19-ARCHIVE'],
})

// Word-boundary aware lowercased token check. We extract tokens from a string
// (a-z, 0-9, '-') so that "Audit-receipts" matches both "audit" and "receipts".
function tokenize(s) {
  if (typeof s !== 'string') return []
  return s.toLowerCase().match(/[a-z][a-z0-9-]*/g) || []
}

// True iff `actionType` is in the family rooted at `root`.
// Match rule: equal, or starts with `root` followed by a separator (. _ : -).
function matchesRoot(actionType, root) {
  if (typeof actionType !== 'string' || typeof root !== 'string') return false
  if (actionType === root) return true
  if (actionType.length <= root.length) return false
  if (!actionType.startsWith(root)) return false
  const sep = actionType.charAt(root.length)
  return sep === '.' || sep === '_' || sep === ':' || sep === '-'
}

function anyMatch(actionType, roots) {
  if (!Array.isArray(roots)) return false
  for (const r of roots) if (matchesRoot(actionType, r)) return true
  return false
}

// Extract the lane (top-level numbered segment) from a normalized scope.
// Accepts absolute Windows paths under the Orange5 root and lattice-relative
// paths. Returns the lane string ("04-CONTROL-PLANE") or null.
function laneOf(scope, root) {
  if (typeof scope !== 'string' || scope.length === 0) return null
  const n = scope.replace(/\\/g, '/')
  // absolute under root?
  if (/^[A-Za-z]:\//.test(n)) {
    const r = (root || ORANGE5_ROOT).replace(/\\/g, '/').toLowerCase()
    if (!n.toLowerCase().startsWith(r)) return null
    const tail = n.slice(r.length).replace(/^\/+/, '')
    const first = tail.split('/')[0]
    return first || null
  }
  if (n.startsWith('/')) return null
  const first = n.replace(/^\.\//, '').split('/')[0]
  return first || null
}

// Pull the intent verbs out of order.intent. Returns the canonical verbs we
// recognise (subset of INTENT_VERB_FAMILIES keys), in declaration order.
function intentVerbs(intent) {
  const tokens = tokenize(intent)
  const seen = []
  for (const t of tokens) {
    if (INTENT_VERB_FAMILIES[t] && !seen.includes(t)) seen.push(t)
  }
  return seen
}

// Pull the intent topic nouns (the ones we have a lane mapping for).
function intentTopics(intent) {
  const tokens = tokenize(intent)
  const seen = []
  for (const t of tokens) {
    if (INTENT_TOPIC_LANES[t] && !seen.includes(t)) seen.push(t)
  }
  return seen
}

export function gate3Triad(input, ctx = {}) {
  const startedAt = nowNs()
  const evidence = { checks: [] }

  // --- Shape checks --------------------------------------------------------
  if (!input || typeof input !== 'object') {
    return finish(false, 'missing_input',
      { reason: 'input must be an object with {action, order}' }, startedAt)
  }
  const { action, order } = input
  if (!action || typeof action !== 'object') {
    return finish(false, 'missing_action', { reason: 'action is required' }, startedAt)
  }
  if (!order || typeof order !== 'object') {
    return finish(false, 'missing_order', { reason: 'order is required' }, startedAt)
  }
  if (typeof order.intent !== 'string' || order.intent.trim().length === 0) {
    return finish(false, 'order_intent_missing',
      { reason: 'order.intent must be a non-empty string for Triad consistency' }, startedAt)
  }
  if (typeof order.scope !== 'string' || order.scope.length === 0) {
    return finish(false, 'order_scope_missing',
      { reason: 'order.scope must be a non-empty string' }, startedAt)
  }
  if (typeof action.scope !== 'string' || action.scope.length === 0) {
    return finish(false, 'action_scope_missing',
      { reason: 'action.scope must be a non-empty string' }, startedAt)
  }
  if (typeof action.actionType !== 'string' || action.actionType.length === 0) {
    return finish(false, 'action_type_missing',
      { reason: 'action.actionType must be a non-empty string for Triad consistency' }, startedAt)
  }

  const root = (ctx && typeof ctx.root === 'string') ? ctx.root : ORANGE5_ROOT
  const intent = order.intent
  const actionType = action.actionType
  const verbs = intentVerbs(intent)
  const topics = intentTopics(intent)
  const orderLane = laneOf(order.scope, root)
  const actionLane = laneOf(action.scope, root)

  evidence.intent = intent
  evidence.intent_verbs = verbs
  evidence.intent_topics = topics
  evidence.action_type = actionType
  evidence.order_lane = orderLane
  evidence.action_lane = actionLane

  // --- A. intent ↔ scope ---------------------------------------------------
  //
  // If the intent names a topic with a lawful lane set, the order scope's lane
  // must be in that set. If no recognised topic is present, this pair is
  // vacuously OK — we do not invent constraints.
  if (topics.length > 0) {
    if (!orderLane) {
      evidence.checks.push({ name: 'intent_scope', pass: false,
        reason: 'order.scope has no resolvable lane to compare against intent topic',
        topics })
      return finish(false, 'triad_mismatch_intent_scope', {
        reason: 'intent references a topic but order.scope lane is unresolvable',
        topics, order_scope: order.scope, ...evidence,
      }, startedAt)
    }
    const lawfulLanes = new Set()
    for (const t of topics) for (const l of INTENT_TOPIC_LANES[t]) lawfulLanes.add(l)
    if (!lawfulLanes.has(orderLane)) {
      evidence.checks.push({ name: 'intent_scope', pass: false,
        topics, order_lane: orderLane, lawful_lanes: [...lawfulLanes] })
      return finish(false, 'triad_mismatch_intent_scope', {
        reason: 'order.scope lane does not match any lane lawful for the intent topic',
        topics, order_lane: orderLane, lawful_lanes: [...lawfulLanes],
        order_scope: order.scope, ...evidence,
      }, startedAt)
    }
    evidence.checks.push({ name: 'intent_scope', pass: true,
      topics, order_lane: orderLane })
  } else {
    evidence.checks.push({ name: 'intent_scope', pass: true, vacuous: true,
      reason: 'no recognised topic noun in intent' })
  }

  // --- B. scope ↔ action ---------------------------------------------------
  //
  // The action.scope lane must sustain the action's actionType. Action lane
  // (not order lane) is the right comparand here because Gate 1 has already
  // certified action.scope is within order.scope; Gate 3 asks whether the
  // action type fits the *destination* lane.
  if (!actionLane) {
    evidence.checks.push({ name: 'scope_action', pass: false,
      reason: 'action.scope has no resolvable lane' })
    return finish(false, 'triad_mismatch_scope_action', {
      reason: 'action.scope lane is unresolvable',
      action_scope: action.scope, ...evidence,
    }, startedAt)
  }
  const laneFamily = LANE_ACTION_FAMILIES[actionLane]
  if (!laneFamily) {
    evidence.checks.push({ name: 'scope_action', pass: false,
      reason: 'no action family registered for this lane', action_lane: actionLane })
    return finish(false, 'triad_mismatch_scope_action', {
      reason: 'lane has no registered action family',
      action_lane: actionLane, ...evidence,
    }, startedAt)
  }
  if (!anyMatch(actionType, laneFamily)) {
    evidence.checks.push({ name: 'scope_action', pass: false,
      action_lane: actionLane, action_type: actionType, lane_family: laneFamily })
    return finish(false, 'triad_mismatch_scope_action', {
      reason: 'action.actionType is not in the lane\'s action family',
      action_lane: actionLane, action_type: actionType, lane_family: laneFamily,
      ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'scope_action', pass: true,
    action_lane: actionLane, action_type: actionType })

  // --- C. intent ↔ action --------------------------------------------------
  //
  // At least one intent verb's family must contain the actionType. If the
  // intent contains no recognised verb at all, that itself is a triad break —
  // the operator did not state what they want done. (Gate 1 lets the action
  // pass on path math alone; Gate 3 will not.)
  if (verbs.length === 0) {
    evidence.checks.push({ name: 'intent_action', pass: false,
      reason: 'no recognised verb in intent' })
    return finish(false, 'triad_mismatch_intent_action', {
      reason: 'order.intent has no recognised verb; cannot validate intent↔action coherence',
      intent, recognised_verbs: Object.keys(INTENT_VERB_FAMILIES),
      ...evidence,
    }, startedAt)
  }
  let intentActionOk = false
  let matchedVerb = null
  for (const v of verbs) {
    if (anyMatch(actionType, INTENT_VERB_FAMILIES[v])) {
      intentActionOk = true
      matchedVerb = v
      break
    }
  }
  if (!intentActionOk) {
    const verbFamilies = {}
    for (const v of verbs) verbFamilies[v] = INTENT_VERB_FAMILIES[v]
    evidence.checks.push({ name: 'intent_action', pass: false,
      action_type: actionType, intent_verbs: verbs, verb_families: verbFamilies })
    return finish(false, 'triad_mismatch_intent_action', {
      reason: 'action.actionType is not in any intent verb family',
      action_type: actionType, intent_verbs: verbs, verb_families: verbFamilies,
      ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'intent_action', pass: true,
    action_type: actionType, matched_verb: matchedVerb })

  return finish(true, 'ok', evidence, startedAt)
}

// ---- output shape ---------------------------------------------------------

function finish(pass, reason, evidence, startedNs) {
  const took_ms = Number(nowNs() - startedNs) / 1e6
  return {
    gate: GATE_ID,
    gate_id: GATE_ID,
    name: GATE_NAME,
    position: POSITION_IN_STACK,
    bypassable: BYPASSABLE,
    pass,
    reason,
    reasons: pass ? [] : [reason],
    evidence,
    took_ms: Math.round(took_ms * 1000) / 1000,
  }
}

function nowNs() {
  if (typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint) {
    return process.hrtime.bigint()
  }
  // Fallback: synthesise nanoseconds from Date.now().
  return BigInt(Date.now()) * 1000000n
}

// Default export: the evaluator + metadata, matching the runner's expected shape.
export const GATE_ID_EXPORT = GATE_ID
export const GATE_NAME_EXPORT = GATE_NAME

// Compatibility: 00-lbce.mjs uses `evaluate`; 01-scope.mjs uses `gate1Scope`.
// We export both names so the runner can load us either way.
export const evaluate = gate3Triad

export default {
  id: GATE_ID,
  name: GATE_NAME,
  position: POSITION_IN_STACK,
  bypassable: BYPASSABLE,
  target_ms: TARGET_MS,
  evaluate: gate3Triad,
  // Exposed for tests / introspection — not part of the runtime contract.
  _internals: {
    LANE_ACTION_FAMILIES,
    INTENT_VERB_FAMILIES,
    INTENT_TOPIC_LANES,
    tokenize,
    matchesRoot,
    laneOf,
    intentVerbs,
    intentTopics,
  },
}
import { ORANGE5_ROOT } from '../root.mjs'
