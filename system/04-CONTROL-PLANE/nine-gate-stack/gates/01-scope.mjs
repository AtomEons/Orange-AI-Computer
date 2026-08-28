// 01-scope.mjs — Gate 1 Scope of the 9-Gate Stack.
//
// Purpose: validate that an action's declared scope matches the scope of the
// orange.order.v1 it claims to execute under. Refuse scope_expansion: any path
// or action that escapes the order's scope is blocked here, before Gate 2
// Department routes to a lane.
//
// Inputs : { action, order }
//   - action.scope             string  REQUIRED. The path/scope this action operates on.
//   - action.actionType        string  OPTIONAL. Will be checked against allowed/forbidden.
//   - action.paths             string[] OPTIONAL. Concrete file paths the action will touch.
//   - order.scope              string  REQUIRED. The order's authorized scope (path prefix).
//   - order.allowedActions     string[] REQUIRED. Whitelist of action types this order permits.
//   - order.forbiddenActions   string[] REQUIRED. Blacklist that overrides allowedActions on conflict.
//
// Output : { gate_id:'gate-1-scope', name:'Scope', pass:boolean, reason:string, evidence:object, took_ms:number }
//
// Doctrine:
//   - Gate 0 LBCE has already confirmed lattice integrity. Gate 1 narrows to the
//     specific order this action references.
//   - scope_expansion = action.scope or any action.paths[*] is NOT within order.scope.
//     Equality counts as "within". A trailing slash difference does not save a
//     path that walks above the order scope.
//   - actionType must be in order.allowedActions and must NOT be in order.forbiddenActions.
//     forbiddenActions wins on overlap (defense in depth — orders may declare both).
//   - No I/O. Pure function. Target <30ms.
//   - No fake-green: on any failure pass=false and reason is the specific rule.
//
// Mom's Law: every refusal cites the exact rule and the exact offending value.
// No "looks fine" passes. No silent normalization that hides a real escape.

const GATE_ID = 'gate-1-scope'
const GATE_NAME = 'Scope'

// Normalize a path/scope into a canonical form for prefix comparison.
//   - replace backslashes with forward slashes
//   - collapse repeated slashes
//   - strip trailing slash (except for the literal root "/")
//   - DO NOT resolve ".." — instead, detect and reject below
function normalizeScope(value) {
  if (typeof value !== 'string') return ''
  let s = value.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

// Detect path-traversal attempts and absolute-anchor swaps that would silently
// escape the order scope.
function hasTraversal(value) {
  if (typeof value !== 'string') return true
  const n = value.replace(/\\/g, '/')
  if (n.includes('/../') || n.startsWith('../') || n === '..' || n.endsWith('/..')) return true
  // null bytes and CR/LF are never legal in a scope string
  if (/[\x00\r\n]/.test(n)) return true
  return false
}

// True iff `child` is the same as `parent` or a descendant of it. Both must be
// pre-normalized. Comparison is case-sensitive (Orange5 paths are POSIX-shaped
// even on Windows; the workflow already writes forward-slash paths).
function isWithin(parent, child) {
  if (!parent || !child) return false
  if (child === parent) return true
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/')
}

export function gate1Scope(input) {
  const startedAt = process.hrtime.bigint()
  const evidence = { checks: [] }

  // --- Shape checks --------------------------------------------------------
  if (!input || typeof input !== 'object') {
    return finish(false, 'missing_input', { reason: 'input must be an object with {action, order}' }, startedAt)
  }
  const { action, order } = input
  if (!action || typeof action !== 'object') {
    return finish(false, 'missing_action', { reason: 'action is required' }, startedAt)
  }
  if (!order || typeof order !== 'object') {
    return finish(false, 'missing_order', { reason: 'order is required' }, startedAt)
  }

  if (typeof action.scope !== 'string' || action.scope.length === 0) {
    return finish(false, 'action_scope_missing', { reason: 'action.scope must be a non-empty string' }, startedAt)
  }
  if (typeof order.scope !== 'string' || order.scope.length === 0) {
    return finish(false, 'order_scope_missing', { reason: 'order.scope must be a non-empty string' }, startedAt)
  }
  if (!Array.isArray(order.allowedActions)) {
    return finish(false, 'order_allowedActions_missing', { reason: 'order.allowedActions must be an array' }, startedAt)
  }
  if (!Array.isArray(order.forbiddenActions)) {
    return finish(false, 'order_forbiddenActions_missing', { reason: 'order.forbiddenActions must be an array' }, startedAt)
  }

  // --- Traversal check -----------------------------------------------------
  if (hasTraversal(action.scope)) {
    evidence.checks.push({ name: 'traversal', target: 'action.scope', value: action.scope, pass: false })
    return finish(false, 'scope_traversal', { offending: action.scope, ...evidence }, startedAt)
  }
  if (hasTraversal(order.scope)) {
    evidence.checks.push({ name: 'traversal', target: 'order.scope', value: order.scope, pass: false })
    return finish(false, 'order_scope_traversal', { offending: order.scope, ...evidence }, startedAt)
  }
  evidence.checks.push({ name: 'traversal', target: 'action.scope', pass: true })

  // --- Scope containment ---------------------------------------------------
  const orderScope = normalizeScope(order.scope)
  const actionScope = normalizeScope(action.scope)

  if (!isWithin(orderScope, actionScope)) {
    evidence.checks.push({
      name: 'scope_containment',
      orderScope, actionScope, pass: false,
    })
    return finish(false, 'scope_expansion', {
      reason: 'action.scope is not within order.scope',
      orderScope, actionScope, ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'scope_containment', orderScope, actionScope, pass: true })

  // --- Path containment (each declared path must also be within order.scope)
  if (Array.isArray(action.paths)) {
    for (const raw of action.paths) {
      if (typeof raw !== 'string' || raw.length === 0) {
        return finish(false, 'action_path_invalid', {
          reason: 'action.paths entries must be non-empty strings',
          offending: raw,
          ...evidence,
        }, startedAt)
      }
      if (hasTraversal(raw)) {
        return finish(false, 'path_traversal', { offending: raw, ...evidence }, startedAt)
      }
      const p = normalizeScope(raw)
      if (!isWithin(orderScope, p)) {
        evidence.checks.push({ name: 'path_containment', path: p, pass: false })
        return finish(false, 'scope_expansion', {
          reason: 'action.paths entry is outside order.scope',
          orderScope, offending: p, ...evidence,
        }, startedAt)
      }
    }
    evidence.checks.push({ name: 'path_containment', count: action.paths.length, pass: true })
  }

  // --- Action-type allowlist / blocklist -----------------------------------
  if (action.actionType !== undefined) {
    if (typeof action.actionType !== 'string' || action.actionType.length === 0) {
      return finish(false, 'action_type_invalid', { reason: 'action.actionType must be a non-empty string when provided', ...evidence }, startedAt)
    }
    if (order.forbiddenActions.includes(action.actionType)) {
      evidence.checks.push({ name: 'action_type', value: action.actionType, pass: false, rule: 'forbiddenActions' })
      return finish(false, 'action_forbidden', {
        reason: 'action.actionType is in order.forbiddenActions',
        offending: action.actionType, ...evidence,
      }, startedAt)
    }
    // Empty allowedActions means "no actions are permitted under this order".
    if (!order.allowedActions.includes(action.actionType)) {
      evidence.checks.push({ name: 'action_type', value: action.actionType, pass: false, rule: 'allowedActions' })
      return finish(false, 'action_not_allowed', {
        reason: 'action.actionType is not in order.allowedActions',
        offending: action.actionType,
        allowed: order.allowedActions, ...evidence,
      }, startedAt)
    }
    evidence.checks.push({ name: 'action_type', value: action.actionType, pass: true })
  }

  return finish(true, 'ok', evidence, startedAt)
}

function finish(pass, reason, evidence, startedAt) {
  const took_ms = Number(process.hrtime.bigint() - startedAt) / 1e6
  return { gate_id: GATE_ID, name: GATE_NAME, pass, reason, evidence, took_ms }
}

export default gate1Scope
