// 02-department.mjs — Gate 2 Department of the 9-Gate Stack.
//
// Position in the 9-Gate Stack: THIRD. After Gate 0 LBCE (lattice integrity)
// and Gate 1 Scope (exact scope match), Gate 2 routes the action to the
// correct AtomEons department lane (AE0-AE14) and refuses cross-lane action.
//
// Departments (the AE0 Factory topology):
//   AE0  Factory      — orchestrator / meta. May coordinate any lane but must
//                       not itself perform another lane's lane-bound work.
//   AE1  Product      — specs, PRDs, roadmaps, product briefs.
//   AE2  Research     — current-docs lookups, market research, wiki lessons.
//   AE3  Design       — UX, UI implementation, design systems, visual QA.
//   AE4  Marketing    — campaigns, brand copy, content, public posts.
//   AE5  Sales        — outreach, account plans, pipeline, call prep.
//   AE6  Code         — source edits, refactors, library work.
//   AE7  Review       — adversarial review, LakeStrike, PR review, gates.
//   AE8  Launch       — release stewardship, deploy, promotion.
//   AE9  Legal        — contracts, NDAs, compliance, IP.
//   AE10 Ops          — process, runbooks, capacity, vendor ops.
//   AE11 Security     — sec review, audit, secrets hygiene.
//   AE12 Data         — analytics, SQL, dashboards, viz.
//   AE13 Automation   — workflows, scheduled tasks, integration glue.
//   AE14 Bench        — benchmarks, perf measurement, regression harness.
//
// What Gate 2 does:
//   1. Resolves the action's claimed department (action.department) into the
//      canonical AE0-AE14 lane id.
//   2. Refuses if the department is unknown or the action's actionType is not
//      in the department's allowed action-type set
//      (e.g. AE6 Code may not "publish_post"; AE4 Marketing may not "merge_pr").
//   3. Cross-checks the action's scope against the department's lane prefixes.
//      A Code action claiming scope under 04-CONTROL-PLANE/ is allowed; a Code
//      action claiming scope only under 04-MARKETING/ is refused as cross-lane.
//   4. Refuses cross-lane action: an action declared under AE6 Code that tries
//      to publish to AE4 Marketing surface (publish_post, send_email, etc.).
//
// Inputs : { action, order }
//   - action.department        string  REQUIRED. e.g. "AE6", "AE6-CODE", "ae6_code".
//   - action.actionType        string  REQUIRED. e.g. "edit_source", "publish_post".
//   - action.scope             string  REQUIRED. Already gate-1-validated path/scope.
//   - action.paths             string[] OPTIONAL. Concrete paths the action touches.
//   - action.target_department string  OPTIONAL. If set, the lane the action's
//                                                effect lands on (e.g. an AE0
//                                                Factory orchestration step that
//                                                fans out to AE6). When present,
//                                                target_department must agree
//                                                with actionType's lane class.
//   - order.department         string  OPTIONAL. If the order pre-declares the
//                                                lane, action.department must match.
//
// Output : { gate_id:'gate-2-department', name:'Department',
//            pass:boolean, reason:string, evidence:object, took_ms:number }
//
// Doctrine:
//   - Pure function. No I/O. Target <30ms.
//   - No fake-green: every refusal cites the exact rule and the offending value.
//   - forbiddenActionTypes wins over allowed (defense in depth).
//   - AE0 Factory is special: it may orchestrate any lane but cannot itself
//     perform a lane-bound action without a target_department that matches.
//   - Receipts: this gate emits structured evidence; Gate 7 owns receipt writing.

const GATE_ID = 'gate-2-department'
const GATE_NAME = 'Department'

// ---------------------------------------------------------------------------
// Department registry — single source of truth for AE0-AE14 lane routing.
//
// Each department declares:
//   id              canonical short id ("AE6")
//   key             canonical lowercase key ("ae6_code")
//   name            human label ("Code")
//   aliases         strings that resolve to this lane (case-insensitive)
//   lanePrefixes    Orange5 path prefixes this lane legitimately writes to
//   allowedActions  action-types this lane is permitted to perform
//   forbiddenActions action-types this lane may never perform, even if listed
//                    in allowedActions of some other config (defense in depth)
//   actionLane      map from action-type -> lane id; used for cross-lane refusal
//                    when an action's type clearly belongs to another lane
// ---------------------------------------------------------------------------

export const DEPARTMENTS = Object.freeze([
  {
    id: 'AE0', key: 'ae0_factory', name: 'Factory',
    aliases: ['ae0', 'ae0-factory', 'factory', 'orchestrator'],
    lanePrefixes: [
      '00-CHARTER', '01-DOCTRINE', '04-CONTROL-PLANE', '08-HERMES',
      '09-SCHEMAS', '17-DAGS',
    ],
    allowedActions: [
      'orchestrate', 'plan', 'route', 'dispatch', 'compile_manifest',
      'spawn_subaction', 'verify_chain', 'note',
    ],
    forbiddenActions: [],
  },
  {
    id: 'AE1', key: 'ae1_product', name: 'Product',
    aliases: ['ae1', 'ae1-product', 'product', 'pm'],
    lanePrefixes: ['00-CHARTER', '01-DOCTRINE', '02-APP', '09-SCHEMAS'],
    allowedActions: [
      'write_spec', 'update_roadmap', 'write_prd', 'product_brief',
      'sprint_plan', 'stakeholder_update', 'metrics_review', 'note',
    ],
    forbiddenActions: ['edit_source', 'deploy', 'publish_post', 'send_email', 'sign_contract'],
  },
  {
    id: 'AE2', key: 'ae2_research', name: 'Research',
    aliases: ['ae2', 'ae2-research', 'research'],
    lanePrefixes: ['11-MIRAGE', '16-TRAINING', '01-DOCTRINE'],
    allowedActions: [
      'web_search', 'fetch_docs', 'context_lookup', 'literature_scan',
      'wiki_lesson', 'synthesize_research', 'note',
    ],
    forbiddenActions: ['edit_source', 'deploy', 'publish_post', 'sign_contract'],
  },
  {
    id: 'AE3', key: 'ae3_design', name: 'Design',
    aliases: ['ae3', 'ae3-design', 'design', 'ux', 'ui'],
    lanePrefixes: ['07-VISUAL', '02-APP'],
    allowedActions: [
      'design_critique', 'design_system_update', 'design_handoff',
      'ux_copy', 'accessibility_review', 'visual_qa', 'note',
    ],
    forbiddenActions: ['deploy', 'publish_post', 'sign_contract', 'merge_pr'],
  },
  {
    id: 'AE4', key: 'ae4_marketing', name: 'Marketing',
    aliases: ['ae4', 'ae4-marketing', 'marketing'],
    lanePrefixes: ['15-INTEGRATIONS', '02-APP'],
    allowedActions: [
      'publish_post', 'draft_content', 'email_sequence', 'campaign_plan',
      'brand_review', 'seo_audit', 'performance_report', 'note',
    ],
    forbiddenActions: ['edit_source', 'deploy', 'merge_pr', 'sign_contract'],
  },
  {
    id: 'AE5', key: 'ae5_sales', name: 'Sales',
    aliases: ['ae5', 'ae5-sales', 'sales'],
    lanePrefixes: ['15-INTEGRATIONS'],
    allowedActions: [
      'account_research', 'call_prep', 'draft_outreach', 'pipeline_review',
      'forecast', 'send_email', 'note',
    ],
    forbiddenActions: ['edit_source', 'deploy', 'merge_pr', 'sign_contract', 'publish_post'],
  },
  {
    id: 'AE6', key: 'ae6_code', name: 'Code',
    aliases: ['ae6', 'ae6-code', 'code', 'engineering', 'builder'],
    lanePrefixes: [
      '02-APP', '03-BACKEND', '04-CONTROL-PLANE', '05-FLOW', '06-ORANGELLM',
      '08-HERMES', '09-SCHEMAS', '13-TOOLMESH', '14-SUPERSTACK', '17-DAGS',
    ],
    allowedActions: [
      'edit_source', 'add_file', 'remove_file', 'rename_file', 'refactor',
      'add_test', 'fix_bug', 'compile_check', 'note',
    ],
    forbiddenActions: ['publish_post', 'send_email', 'sign_contract', 'deploy'],
  },
  {
    id: 'AE7', key: 'ae7_review', name: 'Review',
    aliases: ['ae7', 'ae7-review', 'review', 'lakestrike', 'pr-review'],
    lanePrefixes: ['10-RECEIPTS', '04-CONTROL-PLANE', '17-DAGS'],
    allowedActions: [
      'review', 'lakestrike', 'pr_review', 'code_review', 'security_review',
      'completeness_check', 'regression_check', 'note',
    ],
    forbiddenActions: ['edit_source', 'publish_post', 'sign_contract', 'deploy'],
  },
  {
    id: 'AE8', key: 'ae8_launch', name: 'Launch',
    aliases: ['ae8', 'ae8-launch', 'launch', 'release', 'release-steward'],
    lanePrefixes: ['10-RECEIPTS', '17-DAGS', '02-APP', '03-BACKEND'],
    allowedActions: [
      'merge_pr', 'deploy', 'promote', 'rollback', 'tag_release', 'note',
    ],
    forbiddenActions: ['publish_post', 'send_email', 'sign_contract', 'edit_source'],
  },
  {
    id: 'AE9', key: 'ae9_legal', name: 'Legal',
    aliases: ['ae9', 'ae9-legal', 'legal', 'counsel'],
    lanePrefixes: ['00-CHARTER', '18-HELD'],
    allowedActions: [
      'review_contract', 'triage_nda', 'compliance_check',
      'legal_risk_assessment', 'signature_request', 'sign_contract', 'note',
    ],
    forbiddenActions: ['edit_source', 'deploy', 'publish_post', 'merge_pr'],
  },
  {
    id: 'AE10', key: 'ae10_ops', name: 'Ops',
    aliases: ['ae10', 'ae10-ops', 'ops', 'operations'],
    lanePrefixes: ['10-RECEIPTS', '15-INTEGRATIONS', '17-DAGS'],
    allowedActions: [
      'runbook', 'process_doc', 'capacity_plan', 'vendor_review',
      'status_report', 'change_request', 'risk_assessment', 'note',
    ],
    forbiddenActions: ['edit_source', 'publish_post', 'sign_contract', 'merge_pr'],
  },
  {
    id: 'AE11', key: 'ae11_security', name: 'Security',
    aliases: ['ae11', 'ae11-security', 'security', 'sec'],
    lanePrefixes: ['10-RECEIPTS', '04-CONTROL-PLANE', '08-HERMES'],
    allowedActions: [
      'security_audit', 'security_review', 'secret_scan', 'egress_check',
      'threat_model', 'note',
    ],
    forbiddenActions: ['edit_source', 'publish_post', 'sign_contract', 'deploy'],
  },
  {
    id: 'AE12', key: 'ae12_data', name: 'Data',
    aliases: ['ae12', 'ae12-data', 'data', 'analytics'],
    lanePrefixes: ['11-MIRAGE', '12-ATOMSMASHER', '16-TRAINING'],
    allowedActions: [
      'sql_query', 'build_dashboard', 'create_viz', 'statistical_analysis',
      'validate_data', 'explore_data', 'note',
    ],
    forbiddenActions: ['edit_source', 'publish_post', 'sign_contract', 'deploy'],
  },
  {
    id: 'AE13', key: 'ae13_automation', name: 'Automation',
    aliases: ['ae13', 'ae13-automation', 'automation', 'openclaw'],
    lanePrefixes: ['13-TOOLMESH', '15-INTEGRATIONS', '17-DAGS'],
    allowedActions: [
      'schedule_task', 'workflow_dispatch', 'integration_glue',
      'webhook_register', 'cron_create', 'note',
    ],
    forbiddenActions: ['edit_source', 'publish_post', 'sign_contract', 'deploy'],
  },
  {
    id: 'AE14', key: 'ae14_bench', name: 'Bench',
    aliases: ['ae14', 'ae14-bench', 'bench', 'benchmark', 'perf'],
    lanePrefixes: ['12-ATOMSMASHER', '16-TRAINING', '10-RECEIPTS'],
    allowedActions: [
      'bench_run', 'perf_measure', 'regression_compare', 'corpus_eval',
      'p_value_report', 'note',
    ],
    forbiddenActions: ['edit_source', 'publish_post', 'sign_contract', 'deploy'],
  },
])

// Build lookup indexes once at module load.
const DEPT_BY_ALIAS = (() => {
  const m = new Map()
  for (const d of DEPARTMENTS) {
    m.set(d.id.toLowerCase(), d)
    m.set(d.key.toLowerCase(), d)
    for (const a of d.aliases) m.set(String(a).toLowerCase(), d)
  }
  return m
})()

// Reverse index: action-type -> set of department ids that legitimately own it.
// Used for cross-lane refusal — if AE6 declares actionType "publish_post" and
// "publish_post" is owned by AE4, we refuse with cross_lane_action.
const ACTION_LANE = (() => {
  const m = new Map()
  for (const d of DEPARTMENTS) {
    for (const a of d.allowedActions) {
      // Skip the universal "note" type — every lane may emit notes.
      if (a === 'note') continue
      if (!m.has(a)) m.set(a, new Set())
      m.get(a).add(d.id)
    }
  }
  return m
})()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeDept(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

function resolveDepartment(raw) {
  const key = normalizeDept(raw)
  if (!key) return null
  return DEPT_BY_ALIAS.get(key) || null
}

// Normalize a scope/path for prefix comparison. Mirrors Gate 1's normalizer.
function normalizeScope(value) {
  if (typeof value !== 'string') return ''
  let s = value.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

// Extract the lane segment from a scope string. Handles both lattice-relative
// scopes ("04-CONTROL-PLANE/...") and absolute scopes under ROOT.
function laneOf(scopeStr) {
  if (typeof scopeStr !== 'string') return ''
  let s = scopeStr.replace(/\\/g, '/').replace(/^\.\//, '')
  // Strip an absolute Orange5 root prefix if present.
  const m = s.match(/^[A-Za-z]:\/AtomEons\/Orange5\/(.+)$/i)
  if (m) s = m[1]
  if (s.startsWith('/')) s = s.replace(/^\/+/, '')
  return s.split('/')[0] || ''
}

function withinLane(scopeStr, lanePrefix) {
  const lane = laneOf(scopeStr)
  if (!lane) return false
  return lane === lanePrefix
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

export function gate2Department(input) {
  const startedAt = process.hrtime.bigint()
  const evidence = { checks: [] }

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

  // --- 1. Resolve declared department --------------------------------------
  if (typeof action.department !== 'string' || action.department.length === 0) {
    return finish(false, 'department_missing', {
      reason: 'action.department must be a non-empty string (e.g. "AE6" or "ae6_code")',
      ...evidence,
    }, startedAt)
  }
  const dept = resolveDepartment(action.department)
  if (!dept) {
    return finish(false, 'department_unknown', {
      reason: `action.department "${action.department}" does not resolve to a known AE0-AE14 lane`,
      offending: action.department,
      known: DEPARTMENTS.map(d => d.id),
      ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'department_resolved', value: dept.id, key: dept.key, pass: true })

  // --- 2. Order-declared department must match -----------------------------
  if (typeof order.department === 'string' && order.department.length > 0) {
    const orderDept = resolveDepartment(order.department)
    if (!orderDept) {
      return finish(false, 'order_department_unknown', {
        reason: `order.department "${order.department}" does not resolve to a known AE0-AE14 lane`,
        offending: order.department,
        ...evidence,
      }, startedAt)
    }
    if (orderDept.id !== dept.id) {
      evidence.checks.push({
        name: 'order_department_match',
        order_department: orderDept.id, action_department: dept.id, pass: false,
      })
      return finish(false, 'department_mismatch', {
        reason: 'action.department does not match order.department',
        order_department: orderDept.id,
        action_department: dept.id,
        ...evidence,
      }, startedAt)
    }
    evidence.checks.push({ name: 'order_department_match', value: orderDept.id, pass: true })
  }

  // --- 3. actionType is required and must be a non-empty string ------------
  if (typeof action.actionType !== 'string' || action.actionType.length === 0) {
    return finish(false, 'action_type_missing', {
      reason: 'action.actionType must be a non-empty string',
      ...evidence,
    }, startedAt)
  }
  const at = action.actionType

  // --- 4. forbiddenActions wins (defense in depth) -------------------------
  if (dept.forbiddenActions.includes(at)) {
    evidence.checks.push({ name: 'forbidden_action', value: at, department: dept.id, pass: false })
    return finish(false, 'action_forbidden_for_department', {
      reason: `actionType "${at}" is forbidden for department ${dept.id} ${dept.name}`,
      offending: at,
      department: dept.id,
      ...evidence,
    }, startedAt)
  }

  // --- 5. Cross-lane refusal -----------------------------------------------
  // If the action-type is recognized as belonging to a specific lane (or set
  // of lanes) AND the declared department is not in that set, refuse.
  // "note" is universal and skipped by ACTION_LANE construction above.
  const lanesForType = ACTION_LANE.get(at)
  if (lanesForType && lanesForType.size > 0 && !lanesForType.has(dept.id)) {
    // AE0 Factory may orchestrate any lane, but only via the "orchestrate" /
    // "dispatch" / "spawn_subaction" action-types. If AE0 directly performs a
    // lane-bound action without target_department, refuse.
    const owners = Array.from(lanesForType).sort()
    if (dept.id === 'AE0') {
      // AE0 can dispatch into a lane only if target_department names a real
      // owner of this action-type.
      const target = resolveDepartment(action.target_department)
      if (!target || !lanesForType.has(target.id)) {
        evidence.checks.push({
          name: 'cross_lane_action', actionType: at,
          declared: dept.id, owners, target_department: action.target_department || null,
          pass: false,
        })
        return finish(false, 'cross_lane_action', {
          reason: `AE0 Factory may not perform "${at}" directly; provide action.target_department naming one of ${owners.join(',')}`,
          offending: at,
          declared_department: dept.id,
          legitimate_owners: owners,
          ...evidence,
        }, startedAt)
      }
      evidence.checks.push({
        name: 'ae0_dispatch', actionType: at,
        target_department: target.id, pass: true,
      })
    } else {
      evidence.checks.push({
        name: 'cross_lane_action', actionType: at,
        declared: dept.id, owners, pass: false,
      })
      return finish(false, 'cross_lane_action', {
        reason: `actionType "${at}" belongs to ${owners.join(',')}, not declared department ${dept.id}`,
        offending: at,
        declared_department: dept.id,
        legitimate_owners: owners,
        ...evidence,
      }, startedAt)
    }
  } else if (!lanesForType && at !== 'note') {
    // Action-type is unknown to the registry. We allow it ONLY if the
    // department-local allowedActions list includes it explicitly. Otherwise
    // refuse — unknown action-types must be added to the registry first.
    if (!dept.allowedActions.includes(at)) {
      evidence.checks.push({ name: 'unknown_action_type', value: at, pass: false })
      return finish(false, 'action_type_unknown', {
        reason: `actionType "${at}" is not declared in any department's allowedActions`,
        offending: at,
        department: dept.id,
        ...evidence,
      }, startedAt)
    }
  }

  // --- 6. Department-local allowedActions check ----------------------------
  // Final guard: the declared department must list this action-type.
  // Special case: when AE0 Factory dispatches to a target_department (verified
  // in step 5), the allowedActions check is performed against the TARGET lane,
  // not AE0 itself. AE0's role in dispatch is routing, not lane-bound work.
  const dispatchingFromAE0 = (dept.id === 'AE0'
    && typeof action.target_department === 'string'
    && action.target_department.length > 0)
  const checkDept = dispatchingFromAE0
    ? (resolveDepartment(action.target_department) || dept)
    : dept

  if (!checkDept.allowedActions.includes(at)) {
    evidence.checks.push({
      name: 'department_allowed_action', actionType: at, department: checkDept.id, pass: false,
    })
    return finish(false, 'action_not_in_department_allowed', {
      reason: `actionType "${at}" is not in allowedActions for department ${checkDept.id}`,
      offending: at,
      department: checkDept.id,
      allowed: checkDept.allowedActions,
      ...evidence,
    }, startedAt)
  }
  evidence.checks.push({
    name: 'department_allowed_action', value: at,
    department: checkDept.id, dispatched_from: dispatchingFromAE0 ? 'AE0' : null, pass: true,
  })

  // --- 7. Scope/lane topology check ----------------------------------------
  // The action.scope's lane must be one of the department's lanePrefixes.
  // AE0 with a target_department uses the target's lanePrefixes instead.
  const scopeStr = action.scope
  if (typeof scopeStr !== 'string' || scopeStr.length === 0) {
    return finish(false, 'action_scope_missing', {
      reason: 'action.scope must be a non-empty string',
      ...evidence,
    }, startedAt)
  }
  const effectiveDept = (dept.id === 'AE0' && action.target_department)
    ? (resolveDepartment(action.target_department) || dept)
    : dept

  const lane = laneOf(normalizeScope(scopeStr))
  if (!lane) {
    return finish(false, 'scope_no_lane', {
      reason: `action.scope "${scopeStr}" does not name a lane segment`,
      offending: scopeStr,
      ...evidence,
    }, startedAt)
  }
  if (!effectiveDept.lanePrefixes.includes(lane)) {
    evidence.checks.push({
      name: 'lane_topology', lane,
      department: effectiveDept.id, allowed: effectiveDept.lanePrefixes, pass: false,
    })
    return finish(false, 'scope_outside_department_lanes', {
      reason: `action.scope lane "${lane}" is not a lawful lane for department ${effectiveDept.id} ${effectiveDept.name}`,
      offending: lane,
      department: effectiveDept.id,
      allowed_lanes: effectiveDept.lanePrefixes,
      ...evidence,
    }, startedAt)
  }
  evidence.checks.push({ name: 'lane_topology', lane, department: effectiveDept.id, pass: true })

  // Every entry in action.paths must also fall under a lawful lane for the
  // effective department. This is the cross-lane refusal applied to concrete
  // file paths — a Code action cannot touch the Marketing lane on disk.
  if (Array.isArray(action.paths)) {
    for (const raw of action.paths) {
      if (typeof raw !== 'string' || raw.length === 0) {
        return finish(false, 'action_path_invalid', {
          reason: 'action.paths entries must be non-empty strings',
          offending: raw,
          ...evidence,
        }, startedAt)
      }
      const pLane = laneOf(normalizeScope(raw))
      if (!pLane) {
        return finish(false, 'path_no_lane', {
          reason: `action.paths entry "${raw}" does not name a lane segment`,
          offending: raw,
          ...evidence,
        }, startedAt)
      }
      if (!effectiveDept.lanePrefixes.includes(pLane)) {
        evidence.checks.push({
          name: 'path_lane_topology', path: raw, lane: pLane,
          department: effectiveDept.id, pass: false,
        })
        return finish(false, 'path_outside_department_lanes', {
          reason: `action.paths entry lane "${pLane}" is not lawful for department ${effectiveDept.id}`,
          offending: raw,
          department: effectiveDept.id,
          allowed_lanes: effectiveDept.lanePrefixes,
          ...evidence,
        }, startedAt)
      }
    }
    evidence.checks.push({
      name: 'path_lane_topology', count: action.paths.length,
      department: effectiveDept.id, pass: true,
    })
  }

  return finish(true, 'ok', { ...evidence, department: dept.id, effective_department: effectiveDept.id }, startedAt)
}

function finish(pass, reason, evidence, startedAt) {
  const took_ms = Number(process.hrtime.bigint() - startedAt) / 1e6
  return { gate_id: GATE_ID, name: GATE_NAME, pass, reason, evidence, took_ms }
}

// Constants used by the runner and by upstream/downstream gates.
export const GATE_ID_CONST = GATE_ID
export const GATE_NAME_CONST = GATE_NAME
export const POSITION_IN_STACK = 2
export const BYPASSABLE = true
export const TARGET_MS = 30

// Re-export the resolver and the registry for unit tests and for Hermes'
// router to introspect lane ownership without re-implementing the table.
export { resolveDepartment, ACTION_LANE }

export default gate2Department
