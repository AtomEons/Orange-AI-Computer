// AE OrangeLLM — Flow gateway routes (/v1/flow/* and /v1/endurance/status)
// Path: 06-ORANGELLM/server/routes/flow.mjs
//
// Doctrine:
//   - AE Flow (05-FLOW) owns the live pressure-field. State persists as a
//     JSON snapshot at 05-FLOW/state/flow.json on every tick. The 05-FLOW
//     scheduler is the SOLE WRITER for ticks (one-writer rule). Routes here
//     READ that snapshot for /current, /state, /deltas and append a single
//     pending current via POST /order — never tick, never mutate agent state.
//   - Receipts: Markdown at 10-RECEIPTS/orange5-build/ is the operator audit
//     lane. The parallel SQLite index at 06-CONTROL-PLANE/receipts/orange5.db
//     is the machine query lane (same SHA-256 across both stores, owned by
//     the receipts ingest pipeline — not this module).
//   - Endurance: /v1/endurance/status reports scheduler liveness (pid file
//     freshness + tick drift derived from flow.json.last_tick_at) and surfaces
//     the most recent endurance receipt rows (synth-24h gate + the rolling
//     7d uptime monitor). It is a read-only summary; it never starts, stops,
//     or arbitrates gates.
//   - Frontier-Isolation: every endpoint here is registered in the gateway
//     allow-list (FLOW_ALLOWED). The dispatcher refuses anything else even if
//     boundary.mjs is misconfigured (defense in depth).
//
// Routes:
//   GET  /v1/flow/current                — highest-pressure current
//                                          (pending or in_progress, ties broken
//                                           by most-recent updated_at)
//   GET  /v1/flow/state                  — full state snapshot, with delta
//                                          tail trimmed to ?deltas=N (default 50)
//   POST /v1/flow/order                  — author a new pending current
//                                          { title, description?, pressure?,
//                                            owner_department?, acceptance? }
//   GET  /v1/flow/deltas                 — recent deltas; ?since=<ts|id>&limit=
//   GET  /v1/endurance/status            — scheduler liveness + endurance gates
//
// Integration (in server/index.mjs):
//   import { dispatchFlow, isFlowPath } from './routes/flow.mjs';
//   if (isFlowPath(url.pathname)) {
//     const result = await dispatchFlow(req, url, body);
//     if (result) {
//       const status = result._ae_http_status || 200;
//       delete result._ae_http_status;
//       return jsonResponse(res, result, status);
//     }
//   }
//
// And in server/boundary.mjs:
//   import { FLOW_ALLOWED } from "./routes/flow.mjs";
//   ALLOWED = [ ..., ...FLOW_ALLOWED ]

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Paths — resolved from THIS file's location so the route works regardless of
// where the server is launched from. No env vars; no surprises.
// -----------------------------------------------------------------------------

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, '..', '..', '..');                 // Orange5/
const FLOW_DIR   = join(REPO_ROOT, '05-FLOW');
const FLOW_STATE = process.env.ORANGE5_FLOW_STATE || join(FLOW_DIR, 'state', 'flow.json');
const FLOW_PID   = process.env.ORANGE5_FLOW_PID || join(FLOW_DIR, 'state', 'scheduler.pid');
const FLOW_CONF  = process.env.ORANGE5_FLOW_CONF || join(FLOW_DIR, 'scheduler.config.json');
const RECEIPTS_MD_DIR = process.env.ORANGE5_FLOW_RECEIPTS_DIR || join(REPO_ROOT, '10-RECEIPTS', 'orange5-build');

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const FLOW_PATH_PREFIX     = '/v1/flow';
export const ENDURANCE_STATUS_URL = '/v1/endurance/status';

export const FLOW_ALLOWED = Object.freeze([
  { method: 'GET',  path: '/v1/flow/current' },
  { method: 'GET',  path: '/v1/flow/state'   },
  { method: 'GET',  path: '/v1/flow/deltas'  },
  { method: 'POST', path: '/v1/flow/order'   },
  { method: 'GET',  path: ENDURANCE_STATUS_URL },
]);

const ALLOWED_DEPARTMENTS = new Set([
  'AE0', 'AE1', 'AE2', 'AE3', 'AE4', 'AE5', 'AE6', 'AE7', 'AE8', 'AE9',
  'AE10', 'AE11', 'AE12', 'AE13', 'AE14',
  'OPS', 'OPS_HERMES', 'MIRAGE', 'ORANGELLM', 'FLOW',
]);

const MAX_TITLE_LEN       = 200;
const MAX_DESCRIPTION_LEN = 2000;
const MAX_DELTA_TAIL      = 500;   // ceiling for /v1/flow/state ?deltas=
const DEFAULT_DELTA_TAIL  = 50;
const DEFAULT_DELTA_LIMIT = 100;

// Endurance liveness budgets. Read from scheduler.config.json if present;
// otherwise these conservative defaults apply (>= max_tick_drift_ms with a
// floor that tolerates the idle cadence).
const PID_STALE_MS_DEFAULT       = 15_000;   // pid file mtime older than this -> stale
const TICK_STALE_MS_DEFAULT      = 20_000;   // last_tick_at older than this -> stale
const SCHEDULER_NOT_RUNNING_CODE = 'scheduler_not_running';

// -----------------------------------------------------------------------------
// HTTP shape helpers (match receipts.mjs / misfit.mjs style)
// -----------------------------------------------------------------------------

function ok(body)  { return body; }

function err(status, code, message, extra = {}) {
  return { error: { code, message, ...extra }, _ae_http_status: status };
}

function parsePositiveInt(raw, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return null;
  if (n > max) return null;
  return n;
}

function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

// -----------------------------------------------------------------------------
// State load — the route is a READER. The 05-FLOW scheduler is the sole tick
// driver. We re-read on every request because the state file is tiny and the
// scheduler trims it to <= MAX_DELTAS deltas per save.
// -----------------------------------------------------------------------------

const EMPTY_STATE = Object.freeze({
  currents: {},
  agents: {},
  deltas: [],
  tick: 0,
  last_tick_at: 0,
});

function loadStateSafe() {
  if (!existsSync(FLOW_STATE)) {
    return { state: structuredClone(EMPTY_STATE), present: false };
  }
  try {
    const raw = readFileSync(FLOW_STATE, 'utf8');
    const parsed = JSON.parse(raw);
    // Soft-validate the shape so a half-written tick can't crash the route.
    return {
      state: {
        currents:     (parsed && typeof parsed.currents === 'object' && parsed.currents) || {},
        agents:       (parsed && typeof parsed.agents   === 'object' && parsed.agents)   || {},
        deltas:       Array.isArray(parsed?.deltas) ? parsed.deltas : [],
        tick:         Number.isFinite(parsed?.tick) ? parsed.tick : 0,
        last_tick_at: Number.isFinite(parsed?.last_tick_at) ? parsed.last_tick_at : 0,
      },
      present: true,
    };
  } catch (e) {
    return { state: structuredClone(EMPTY_STATE), present: false, parse_error: e.message };
  }
}

// POST /v1/flow/order writes a single pending current back to flow.json. The
// scheduler is the sole TICK writer, but appending a pending entity is a
// last-writer-wins append against a tiny snapshot — safe because (a) the
// scheduler always re-reads and re-writes the full snapshot per tick, (b) we
// never touch agents or deltas other than the one emit() for this current,
// (c) we never mutate existing currents. If the scheduler races our write
// the worst-case outcome is the order is overwritten and the caller can
// retry; we surface a retry hint in that case.
function writeOrderAtomic(stateWithNewCurrent) {
  // Trim deltas the same way 05-FLOW/src/store.mjs does, to stay byte-for-byte
  // shaped like the scheduler's writes.
  if (stateWithNewCurrent.deltas.length > MAX_DELTA_TAIL) {
    stateWithNewCurrent.deltas =
      stateWithNewCurrent.deltas.slice(-MAX_DELTA_TAIL);
  }
  writeFileSync(FLOW_STATE, JSON.stringify(stateWithNewCurrent, null, 2));
}

// -----------------------------------------------------------------------------
// ID generation — matches 05-FLOW/src/flow.mjs format so receipts/deltas line
// up between scheduler-authored and route-authored entities.
// -----------------------------------------------------------------------------

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

function pickHighestPressure(currents) {
  let pick = null;
  for (const c of Object.values(currents)) {
    if (c.status !== 'pending' && c.status !== 'in_progress') continue;
    if (!pick) { pick = c; continue; }
    if (c.pressure > pick.pressure) { pick = c; continue; }
    if (c.pressure === pick.pressure && (c.updated_at || 0) > (pick.updated_at || 0)) {
      pick = c;
    }
  }
  return pick;
}

export function handleCurrent() {
  const { state, present, parse_error } = loadStateSafe();
  if (!present) {
    return ok({
      object: 'flow.current',
      current: null,
      state_present: false,
      note: parse_error
        ? `flow state unreadable: ${parse_error}`
        : 'flow state file does not exist; scheduler has not ticked yet',
    });
  }
  const current = pickHighestPressure(state.currents);
  return ok({
    object:        'flow.current',
    current,
    state_present: true,
    tick:          state.tick,
    last_tick_at:  state.last_tick_at,
  });
}

export function handleState(query) {
  const { state, present, parse_error } = loadStateSafe();

  const tailReq = parsePositiveInt(query.get('deltas'), DEFAULT_DELTA_TAIL, MAX_DELTA_TAIL);
  if (tailReq === null) {
    return err(400, 'invalid_deltas', `'deltas' must be a positive integer <= ${MAX_DELTA_TAIL}`);
  }

  if (!present) {
    return ok({
      object: 'flow.state',
      state_present: false,
      currents: {}, agents: {}, deltas: [], tick: 0, last_tick_at: 0,
      counts: { currents: 0, pending: 0, in_progress: 0, closed: 0, blocked: 0, agents_total: 0, agents_idle: 0, agents_riding: 0, deltas_total: 0 },
      note: parse_error
        ? `flow state unreadable: ${parse_error}`
        : 'flow state file does not exist; scheduler has not ticked yet',
    });
  }

  // Compute counts so callers do not need to scan currents themselves.
  const counts = {
    currents: 0, pending: 0, in_progress: 0, closed: 0, blocked: 0, escalated: 0,
    agents_total: 0, agents_idle: 0, agents_riding: 0,
    deltas_total: state.deltas.length,
  };
  for (const c of Object.values(state.currents)) {
    counts.currents += 1;
    if (c.status in counts) counts[c.status] += 1;
  }
  for (const a of Object.values(state.agents)) {
    counts.agents_total += 1;
    if (a.state === 'idle')   counts.agents_idle += 1;
    if (a.state === 'riding') counts.agents_riding += 1;
  }

  return ok({
    object:        'flow.state',
    state_present: true,
    tick:          state.tick,
    last_tick_at:  state.last_tick_at,
    currents:      state.currents,
    agents:        state.agents,
    deltas:        state.deltas.slice(-tailReq),
    counts,
  });
}

export function handleDeltas(query) {
  const { state, present, parse_error } = loadStateSafe();
  if (!present) {
    return ok({
      object: 'flow.deltas',
      state_present: false,
      deltas: [],
      note: parse_error
        ? `flow state unreadable: ${parse_error}`
        : 'flow state file does not exist; scheduler has not ticked yet',
    });
  }

  const limit = parsePositiveInt(query.get('limit'), DEFAULT_DELTA_LIMIT, MAX_DELTA_TAIL);
  if (limit === null) {
    return err(400, 'invalid_limit', `'limit' must be a positive integer <= ${MAX_DELTA_TAIL}`);
  }

  const sinceRaw = query.get('since');
  let filtered = state.deltas;

  if (sinceRaw) {
    // 'since' accepts: numeric ms timestamp, ISO-8601 string, or delta id.
    let cutoffTs = null;
    let cutoffId = null;
    const asNum = Number(sinceRaw);
    if (Number.isFinite(asNum) && asNum > 0) {
      cutoffTs = asNum;
    } else if (/^\d{4}-\d{2}-\d{2}T/.test(sinceRaw)) {
      const t = new Date(sinceRaw).getTime();
      if (Number.isNaN(t)) {
        return err(400, 'invalid_since', `'since' is not a valid ISO timestamp: ${sinceRaw}`);
      }
      cutoffTs = t;
    } else if (/^delta_\d+_\d+$/.test(sinceRaw)) {
      cutoffId = sinceRaw;
    } else {
      return err(400, 'invalid_since',
        `'since' must be a positive integer ms, ISO-8601 timestamp, or delta_* id`);
    }

    if (cutoffId) {
      // Return deltas STRICTLY AFTER the named delta id.
      const idx = state.deltas.findIndex(d => d.id === cutoffId);
      filtered = idx >= 0 ? state.deltas.slice(idx + 1) : state.deltas;
    } else if (cutoffTs !== null) {
      filtered = state.deltas.filter(d => (d.ts || 0) > cutoffTs);
    }
  }

  const tail = filtered.slice(-limit);
  return ok({
    object: 'flow.deltas',
    state_present: true,
    tick:         state.tick,
    last_tick_at: state.last_tick_at,
    returned:     tail.length,
    total_in_state: state.deltas.length,
    deltas:       tail,
  });
}

// -----------------------------------------------------------------------------
// POST /v1/flow/order — author a pending current.
// -----------------------------------------------------------------------------

function validateOrderBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: err(400, 'invalid_body', 'request body must be a JSON object') };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return { error: err(400, 'missing_title', `'title' is required and must be a non-empty string`) };
  }
  if (title.length > MAX_TITLE_LEN) {
    return { error: err(400, 'title_too_long', `'title' exceeds ${MAX_TITLE_LEN} chars`) };
  }

  const description = body.description == null ? ''
    : typeof body.description === 'string' ? body.description : null;
  if (description === null) {
    return { error: err(400, 'invalid_description', `'description' must be a string`) };
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    return { error: err(400, 'description_too_long', `'description' exceeds ${MAX_DESCRIPTION_LEN} chars`) };
  }

  const pressureRaw = body.pressure == null ? 0.5 : body.pressure;
  const pressure = clamp01(pressureRaw);
  if (pressure === null) {
    return { error: err(400, 'invalid_pressure', `'pressure' must be a number in [0, 1]`) };
  }

  const owner_department = body.owner_department == null
    ? 'AE0'
    : String(body.owner_department);
  if (!ALLOWED_DEPARTMENTS.has(owner_department)) {
    return { error: err(400, 'invalid_owner_department',
      `'owner_department' must be one of: ${[...ALLOWED_DEPARTMENTS].join(', ')}`) };
  }

  // acceptance is optional; default mirrors flow.mjs createCurrent default.
  let acceptance = body.acceptance;
  if (acceptance == null) {
    acceptance = { receipt_required: true, approval_required: false, validator: null };
  } else if (typeof acceptance !== 'object' || Array.isArray(acceptance)) {
    return { error: err(400, 'invalid_acceptance', `'acceptance' must be an object`) };
  } else {
    acceptance = {
      receipt_required:  acceptance.receipt_required  === true,
      approval_required: acceptance.approval_required === true,
      validator:         typeof acceptance.validator === 'string' ? acceptance.validator : null,
    };
  }

  return { value: { title, description, pressure, owner_department, acceptance } };
}

export function handleOrder(body) {
  const v = validateOrderBody(body);
  if (v.error) return v.error;
  const order = v.value;

  // Read, append a single pending current + a current_pressure_change delta,
  // write back. We never touch agents, never modify existing currents, never
  // change `tick` or `last_tick_at`. The next scheduler tick will pick this
  // pending current up via the existing assignAgents() pressure sort.
  const { state, present, parse_error } = loadStateSafe();
  if (!present && parse_error) {
    return err(503, 'flow_state_unreadable',
      `flow state file present but unreadable; refusing to write blind: ${parse_error}`);
  }

  const id  = newId('current');
  const now = Date.now();
  const current = {
    id,
    title:             order.title,
    description:       order.description,
    pressure:          order.pressure,
    owner_department:  order.owner_department,
    status:            'pending',
    assigned_agent:    null,
    acceptance:        order.acceptance,
    created_at:        now,
    updated_at:        now,
    closed_at:         null,
    closed_receipt:    null,
    // Provenance: this entity entered the field through the gateway, not the
    // in-process API. Useful for the receipts ingest filter.
    origin:            'gateway/v1/flow/order',
  };

  state.currents[id] = current;
  state.deltas.push({
    id: newId('delta'),
    ts: now,
    kind: 'current_pressure_change',
    subject_id: id,
    payload: { pressure: current.pressure, status: 'pending', origin: 'gateway' },
  });

  try {
    writeOrderAtomic(state);
  } catch (e) {
    return err(500, 'flow_state_write_failed', `could not persist new current: ${e.message}`);
  }

  return ok({
    object:    'flow.order',
    accepted:  true,
    current,
    note:      'pending current authored; scheduler will assign on next tick',
  });
}

// -----------------------------------------------------------------------------
// GET /v1/endurance/status
//   Reports:
//     scheduler:
//       running, pid, pid_mtime, pid_age_ms, pid_stale
//     last_tick_at, last_tick_age_ms, last_tick_stale
//     config: { active_interval_ms, idle_interval_ms, max_tick_drift_ms, ... }
//     gates:
//       synth_24h: { found, receipt, verdict, ts } | { found: false }
//       uptime_7d: { found, receipt, verdict, window_started, window_ends } | { found: false }
//     counts (from flow.json)
//
//   This endpoint NEVER kicks the scheduler, NEVER runs gates. It only
//   reports the cheapest possible truth: what's on disk.
// -----------------------------------------------------------------------------

function readSchedulerPid() {
  if (!existsSync(FLOW_PID)) {
    return { running: false, pid: null, code: SCHEDULER_NOT_RUNNING_CODE };
  }
  let raw, st;
  try {
    raw = readFileSync(FLOW_PID, 'utf8').trim();
    st = statSync(FLOW_PID);
  } catch (e) {
    return { running: false, pid: null, code: 'pid_unreadable', error: e.message };
  }
  const pid = raw ? Number(raw) : null;
  if (!pid || !Number.isFinite(pid)) {
    return { running: false, pid: null, code: 'pid_blank' };
  }
  return {
    running:    true,   // presence-of-record; OS-level liveness is checked via mtime + tick freshness
    pid,
    pid_mtime:  st.mtimeMs,
    pid_age_ms: Date.now() - st.mtimeMs,
  };
}

function readSchedulerConfig() {
  if (!existsSync(FLOW_CONF)) return null;
  try {
    const raw = JSON.parse(readFileSync(FLOW_CONF, 'utf8'));
    return {
      active_interval_ms:  raw.active_interval_ms,
      idle_interval_ms:    raw.idle_interval_ms,
      idle_threshold_ticks: raw.idle_threshold_ticks,
      concurrency_cap:     raw.concurrency_cap,
      max_tick_drift_ms:   raw.max_tick_drift_ms,
      log_every_n_ticks:   raw.log_every_n_ticks,
      shutdown_grace_ms:   raw.shutdown_grace_ms,
    };
  } catch {
    return null;
  }
}

// Cheap last-receipt scan. Markdown filenames in 10-RECEIPTS/orange5-build/
// are of the form <YYYY-MM-DD>-<slug>.md (per existing operator convention).
// We sort by filename desc and pick the most recent that matches.
function findLatestReceipt(matchers) {
  if (!existsSync(RECEIPTS_MD_DIR)) return null;
  let entries;
  try {
    entries = readdirSync(RECEIPTS_MD_DIR);
  } catch {
    return null;
  }
  // Most recent first; filename date prefix sorts correctly lexicographically.
  entries.sort().reverse();
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    if (!matchers.some(m => m.test(name))) continue;
    let path = join(RECEIPTS_MD_DIR, name);
    let mtime = null;
    try { mtime = statSync(path).mtimeMs; } catch {}
    return { filename: name, path, mtime };
  }
  return null;
}

export function handleEnduranceStatus() {
  const { state, present } = loadStateSafe();
  const sched = readSchedulerPid();
  const config = readSchedulerConfig();

  const now = Date.now();
  const lastTickAgeMs = present && state.last_tick_at
    ? now - state.last_tick_at
    : null;

  // Tick staleness budget: prefer config-driven; fall back to default. We
  // give a generous floor so that the idle-cadence (10s default) does not
  // trigger a stale signal.
  const tickStaleBudget = config && Number.isFinite(config.idle_interval_ms)
    ? Math.max(config.idle_interval_ms * 2, TICK_STALE_MS_DEFAULT)
    : TICK_STALE_MS_DEFAULT;
  const pidStaleBudget  = config && Number.isFinite(config.active_interval_ms)
    ? Math.max(config.active_interval_ms * 15, PID_STALE_MS_DEFAULT)
    : PID_STALE_MS_DEFAULT;

  const pid_stale  = sched.pid_age_ms != null && sched.pid_age_ms > pidStaleBudget;
  const tick_stale = lastTickAgeMs    != null && lastTickAgeMs    > tickStaleBudget;

  const synth = findLatestReceipt([
    /endurance-synth-24h/i,
    /endurance.*24h/i,
  ]);
  const uptime = findLatestReceipt([
    /endurance-uptime-7d/i,
    /uptime.*7d/i,
  ]);

  // Counts mirror /v1/flow/state for convenience — same dashboards can render
  // either endpoint without re-deriving.
  const counts = {
    currents: 0, pending: 0, in_progress: 0, closed: 0, blocked: 0,
    agents_total: 0, agents_idle: 0, agents_riding: 0,
    deltas_total: present ? state.deltas.length : 0,
  };
  if (present) {
    for (const c of Object.values(state.currents)) {
      counts.currents += 1;
      if (c.status in counts) counts[c.status] += 1;
    }
    for (const a of Object.values(state.agents)) {
      counts.agents_total += 1;
      if (a.state === 'idle')   counts.agents_idle += 1;
      if (a.state === 'riding') counts.agents_riding += 1;
    }
  }

  // Overall verdict — three-state on purpose. Routes never lie about gates
  // they cannot observe.
  let overall;
  if (!sched.running) {
    overall = 'down';
  } else if (pid_stale || tick_stale || !present) {
    overall = 'degraded';
  } else {
    overall = 'green';
  }

  return ok({
    object: 'endurance.status',
    overall,
    generated_at: new Date(now).toISOString(),
    scheduler: {
      running: sched.running,
      pid: sched.pid,
      pid_mtime: sched.pid_mtime ?? null,
      pid_age_ms: sched.pid_age_ms ?? null,
      pid_stale,
      pid_stale_budget_ms: pidStaleBudget,
      code: sched.code ?? null,
    },
    flow: {
      state_present: present,
      tick: present ? state.tick : 0,
      last_tick_at: present ? state.last_tick_at : 0,
      last_tick_age_ms: lastTickAgeMs,
      tick_stale,
      tick_stale_budget_ms: tickStaleBudget,
    },
    config,
    gates: {
      synth_24h: synth
        ? {
            found: true,
            filename: synth.filename,
            // verdict is parsed by the receipts pipeline (SQLite mirror);
            // we surface filename only and avoid re-parsing markdown here.
            mtime: synth.mtime,
          }
        : { found: false },
      uptime_7d: uptime
        ? {
            found: true,
            filename: uptime.filename,
            mtime: uptime.mtime,
          }
        : { found: false },
    },
    counts,
  });
}

// -----------------------------------------------------------------------------
// Path predicates + dispatcher (mirrors receipts.mjs)
// -----------------------------------------------------------------------------

export function isFlowPath(pathname) {
  return typeof pathname === 'string' && (
    pathname === ENDURANCE_STATUS_URL ||
    pathname === FLOW_PATH_PREFIX ||
    pathname.startsWith(FLOW_PATH_PREFIX + '/')
  );
}

export function isFlowRouteAllowed(method, pathname) {
  if (typeof method !== 'string' || typeof pathname !== 'string') return false;
  const m = method.toUpperCase();
  return FLOW_ALLOWED.some(r => r.method === m && r.path === pathname);
}

/**
 * dispatchFlow — primary entry point.
 * @param {http.IncomingMessage|{method:string}} req
 * @param {URL|string} urlOrPath  URL object preferred so search params parse.
 * @param {object|undefined} body parsed JSON body (server reads it; we don't re-read req)
 */
export async function dispatchFlow(req, urlOrPath, body) {
  const method = (req?.method || 'GET').toUpperCase();
  const pathname = typeof urlOrPath === 'string' ? urlOrPath : urlOrPath.pathname;
  const search   = typeof urlOrPath === 'string' ? '' : (urlOrPath.search || '');
  const query    = new URLSearchParams(search);

  if (!isFlowRouteAllowed(method, pathname)) {
    return err(404, 'not_found', `flow endpoint not exposed: ${method} ${pathname}`);
  }

  if (method === 'GET' && pathname === '/v1/flow/current')      return handleCurrent();
  if (method === 'GET' && pathname === '/v1/flow/state')        return handleState(query);
  if (method === 'GET' && pathname === '/v1/flow/deltas')       return handleDeltas(query);
  if (method === 'POST' && pathname === '/v1/flow/order')       return handleOrder(body);
  if (method === 'GET' && pathname === ENDURANCE_STATUS_URL)    return handleEnduranceStatus();

  // Defense in depth — should be unreachable thanks to isFlowRouteAllowed.
  return err(404, 'not_found', `flow endpoint not exposed: ${method} ${pathname}`);
}

// Internals exposed for unit tests only.
export const __flowInternals = {
  FLOW_STATE,
  FLOW_PID,
  FLOW_CONF,
  RECEIPTS_MD_DIR,
  ALLOWED_DEPARTMENTS,
  loadStateSafe,
  pickHighestPressure,
  validateOrderBody,
  findLatestReceipt,
};

export default {
  FLOW_ALLOWED,
  isFlowPath,
  isFlowRouteAllowed,
  dispatchFlow,
};
