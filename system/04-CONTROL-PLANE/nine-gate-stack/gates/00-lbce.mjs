// Gate 0 — LBCE (Lattice Boundary Consistency Engine).
//
// Position in the 9-Gate Stack: FIRST. IMPASSABLE. Cannot be bypassed.
// Every action submitted to Hermes traverses this gate before any other.
// If LBCE fails, the action is refused and the rest of the stack is not run.
//
// What "lattice integrity" means in Orange5:
//   1. action targets live INSIDE the Orange5 path lattice
//      (the configured OrangeFive root + numbered lanes 00-CHARTER..19-ARCHIVE).
//   2. action.scope is a NARROWING of orange.order.v1.scope
//      (Gate 1 does exact-string match later; here we check topology only:
//       the action does not reach outside the lane(s) the order opened).
//   3. No path traversal (`..`), no absolute paths that escape ROOT,
//      no Windows drive-hop, no symlink-shaped refs.
//   4. Every receipt reference (prior_receipt, receipt_path, evidence[].receipt_path)
//      points to an extant file under 10-RECEIPTS/. No orphan refs.
//   5. The hash_chain integer is monotonically defined when prior_receipt exists
//      (we do not recompute the hash here — Gate 7 owns content validation —
//        but we require the topological link to resolve to a real file).
//
// Target ~ <30ms. Pure function over fs + the action object. No network.
// Real Node 20+, ESM, no dependencies outside node:fs / node:path.

import { existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, normalize, isAbsolute, sep, relative } from 'node:path';

export const GATE_ID = 'gate-0-lbce';
export const GATE_NAME = 'LBCE — Lattice Boundary Consistency Engine';
export const BYPASSABLE = false;            // hard constant; do not change
export const POSITION_IN_STACK = 0;          // first gate
export const TARGET_MS = 30;

// Orange5 root + the lawful top-level lanes. Anything outside this set is out-of-lattice.
export { ORANGE5_ROOT } from '../root.mjs';
import { ORANGE5_ROOT } from '../root.mjs';
export const LATTICE_LANES = Object.freeze([
  '00-CHARTER', '01-DOCTRINE', '02-APP', '03-BACKEND', '04-CONTROL-PLANE',
  '05-FLOW', '06-ORANGELLM', '07-VISUAL', '08-HERMES', '09-SCHEMAS',
  '10-RECEIPTS', '11-MIRAGE', '12-ATOMSMASHER', '13-TOOLMESH', '14-SUPERSTACK',
  '15-INTEGRATIONS', '16-TRAINING', '17-DAGS', '18-HELD', '19-ARCHIVE',
]);
const LATTICE_SET = new Set(LATTICE_LANES);

// Sentinel raised when a caller tries to bypass Gate 0.
export class LbceBypassAttempt extends Error {
  constructor(message) {
    super(message);
    this.name = 'LbceBypassAttempt';
  }
}

// The single doorway. Returns a structured result; never throws on a normal fail.
// Throws ONLY on a bypass attempt (e.g. ctx.bypass === true).
export function evaluate(action, order, ctx = {}) {
  const started = nowMs();

  if (ctx && ctx.bypass === true) {
    // Gate 0 cannot be bypassed. Period.
    throw new LbceBypassAttempt('Gate 0 LBCE is impassable: bypass=true was supplied.');
  }

  const reasons = [];
  const evidence = [];
  const root = normalize(ctx.root || ORANGE5_ROOT).replace(/\\/g, '/');

  if (!action || typeof action !== 'object') {
    return fail(['action is missing or not an object'], evidence, started);
  }
  if (!order || typeof order !== 'object') {
    return fail(['order is missing or not an object'], evidence, started);
  }

  // ---- 1. Scope narrowing (topology only; Gate 1 does the exact match) -----
  const orderScope = String(order.scope || '').trim();
  const actScope   = String(action.scope || '').trim();
  if (!orderScope) reasons.push('order.scope is empty');
  if (!actScope)   reasons.push('action.scope is empty');
  if (orderScope && actScope) {
    // Treat scopes as path-like strings. Action scope must START WITH the order
    // scope (i.e. narrower or equal). Anything else is a topology break.
    const a = normSlash(actScope);
    const o = normSlash(orderScope);
    if (!a.startsWith(o)) {
      reasons.push(`action.scope "${actScope}" is outside order.scope "${orderScope}" (lattice narrowing required)`);
    } else {
      evidence.push({ check: 'scope_narrowing', ok: true, order_scope: orderScope, action_scope: actScope });
    }
  }

  // ---- 2. Collect every path-like reference on the action ------------------
  const refs = collectPathRefs(action);
  evidence.push({ check: 'path_refs_collected', count: refs.length, refs });

  // ---- 3. In-lattice check for each ref ------------------------------------
  for (const r of refs) {
    const verdict = classifyPath(r.value, root);
    if (verdict.ok) {
      evidence.push({ check: 'in_lattice', field: r.field, value: r.value, lane: verdict.lane });
    } else {
      reasons.push(`out-of-lattice ${r.field}="${r.value}": ${verdict.why}`);
    }
  }

  // ---- 4. Receipt refs resolve to an extant 10-RECEIPTS/*.md ---------------
  const receiptRefs = refs.filter(r => isReceiptField(r.field));
  for (const rr of receiptRefs) {
    const abs = absolveUnderRoot(rr.value, root);
    if (!abs) {
      reasons.push(`receipt ref ${rr.field}="${rr.value}" cannot be resolved under ROOT`);
      continue;
    }
    if (!abs.replace(/\\/g, '/').includes('/10-RECEIPTS/')) {
      reasons.push(`receipt ref ${rr.field}="${rr.value}" is not under 10-RECEIPTS/`);
      continue;
    }
    if (!existsSync(abs)) {
      reasons.push(`orphan receipt ref ${rr.field}="${rr.value}" (file does not exist)`);
      continue;
    }
    try {
      const st = statSync(abs);
      if (!st.isFile()) {
        reasons.push(`receipt ref ${rr.field}="${rr.value}" exists but is not a regular file`);
        continue;
      }
      // Refuse symlink-shaped references — receipts are immutable real files.
      const real = realpathSync(abs);
      if (normSlash(real) !== normSlash(abs)) {
        reasons.push(`receipt ref ${rr.field}="${rr.value}" resolves through a symlink (forbidden in lattice)`);
        continue;
      }
      evidence.push({ check: 'receipt_resolves', field: rr.field, value: rr.value, real });
    } catch (e) {
      reasons.push(`receipt ref ${rr.field}="${rr.value}" stat failed: ${String(e && e.message || e)}`);
    }
  }

  // ---- 5. hash_chain monotonicity (topological — content is Gate 7) --------
  if ('hash_chain' in action || 'prior_receipt' in action) {
    const hc = action.hash_chain;
    const prior = action.prior_receipt;
    if (prior && typeof prior === 'string' && prior.length > 0) {
      // prior_receipt must already have been verified as a real file above.
      // hash_chain must be a positive integer when a prior receipt exists.
      if (!(Number.isInteger(hc) && hc >= 2)) {
        reasons.push(`hash_chain must be an integer >= 2 when prior_receipt is set (got ${JSON.stringify(hc)})`);
      } else {
        evidence.push({ check: 'hash_chain_topology', ok: true, hash_chain: hc, prior_receipt: prior });
      }
    } else if (hc !== undefined && hc !== null) {
      // No prior: chain must start at 1.
      if (hc !== 1) {
        reasons.push(`hash_chain must be 1 when prior_receipt is empty (got ${JSON.stringify(hc)})`);
      } else {
        evidence.push({ check: 'hash_chain_topology', ok: true, hash_chain: 1, prior_receipt: null });
      }
    }
  }

  // ---- verdict ------------------------------------------------------------
  if (reasons.length === 0) return pass(evidence, started);
  return fail(reasons, evidence, started);
}

// ---------- helpers ---------------------------------------------------------

function nowMs() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}

function pass(evidence, started) {
  return {
    gate: GATE_ID,
    name: GATE_NAME,
    pass: true,
    bypassable: BYPASSABLE,
    evidence,
    reasons: [],
    took_ms: Math.max(0, Math.round((nowMs() - started) * 1000) / 1000),
  };
}

function fail(reasons, evidence, started) {
  return {
    gate: GATE_ID,
    name: GATE_NAME,
    pass: false,
    bypassable: BYPASSABLE,
    evidence,
    reasons,
    took_ms: Math.max(0, Math.round((nowMs() - started) * 1000) / 1000),
  };
}

function normSlash(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Walk the action object and collect every value that looks like a path.
// Specific known fields are always collected; arbitrary other string values
// containing a path separator and a known lane segment are also collected.
function collectPathRefs(action) {
  const refs = [];
  const known = [
    'receipt_path', 'prior_receipt', 'rollback_path',
    'target_path', 'file', 'path', 'cwd',
  ];

  for (const k of known) {
    const v = action[k];
    if (typeof v === 'string' && v.length > 0) refs.push({ field: k, value: v });
  }

  // files_written: array of strings
  if (Array.isArray(action.files_written)) {
    for (let i = 0; i < action.files_written.length; i++) {
      const v = action.files_written[i];
      if (typeof v === 'string' && v.length > 0) {
        refs.push({ field: `files_written[${i}]`, value: v });
      }
    }
  }

  // evidence: array of { check, receipt_path?, file?, path? }
  if (Array.isArray(action.evidence)) {
    for (let i = 0; i < action.evidence.length; i++) {
      const e = action.evidence[i];
      if (e && typeof e === 'object') {
        for (const sub of ['receipt_path', 'file', 'path']) {
          if (typeof e[sub] === 'string' && e[sub].length > 0) {
            refs.push({ field: `evidence[${i}].${sub}`, value: e[sub] });
          }
        }
      }
    }
  }

  // actions: array of nested action stubs (depth-1 only; Gate 0 is shallow by design).
  if (Array.isArray(action.actions)) {
    for (let i = 0; i < action.actions.length; i++) {
      const a = action.actions[i];
      if (a && typeof a === 'object') {
        for (const sub of ['receipt_path', 'target_path', 'file', 'path']) {
          if (typeof a[sub] === 'string' && a[sub].length > 0) {
            refs.push({ field: `actions[${i}].${sub}`, value: a[sub] });
          }
        }
      }
    }
  }

  return refs;
}

function isReceiptField(field) {
  return field === 'receipt_path'
      || field === 'prior_receipt'
      || /(^|\.)receipt_path$/.test(field)
      || /\bevidence\[\d+\]\.receipt_path$/.test(field);
}

// Decide whether a path-like string sits inside the Orange5 lattice.
// Returns { ok: true, lane } or { ok: false, why }.
function classifyPath(value, root) {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, why: 'empty path' };
  }
  // Refuse obvious traversal and Windows drive-hop attempts.
  if (value.includes('..')) {
    return { ok: false, why: 'contains parent traversal ("..")' };
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    // Absolute Windows path: must start with ROOT.
    const norm = normalize(value).replace(/\\/g, '/');
    if (!norm.toLowerCase().startsWith(root.toLowerCase())) {
      return { ok: false, why: `absolute path escapes ROOT (${root})` };
    }
    const tail = norm.slice(root.length).replace(/^\/+/, '');
    const lane = tail.split('/')[0];
    if (!lane) return { ok: true, lane: '<root>' };
    if (!LATTICE_SET.has(lane)) {
      return { ok: false, why: `lane "${lane}" is not in the lattice (${LATTICE_LANES.length} lawful lanes)` };
    }
    return { ok: true, lane };
  }
  // Unix-style absolute is not allowed in Orange5 (Windows project).
  if (value.startsWith('/')) {
    return { ok: false, why: 'POSIX-absolute path not permitted in Orange5 lattice' };
  }
  // Relative path: first segment must be a lawful lane.
  const norm = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const lane = norm.split('/')[0];
  if (!LATTICE_SET.has(lane)) {
    return { ok: false, why: `lane "${lane}" is not in the lattice` };
  }
  return { ok: true, lane };
}

// Resolve a lattice-relative or absolute ref to an absolute path under ROOT.
// Returns null if the ref cannot be safely resolved inside ROOT.
function absolveUnderRoot(value, root) {
  try {
    let abs;
    if (/^[A-Za-z]:[\\/]/.test(value)) {
      abs = normalize(value);
    } else if (value.startsWith('/')) {
      return null;
    } else {
      abs = normalize(resolve(root, value));
    }
    const a = abs.replace(/\\/g, '/').toLowerCase();
    if (!a.startsWith(root.toLowerCase())) return null;
    return abs;
  } catch {
    return null;
  }
}

// Default export = the evaluator. Gates are loaded dynamically by the runner.
export default {
  id: GATE_ID,
  name: GATE_NAME,
  position: POSITION_IN_STACK,
  bypassable: BYPASSABLE,
  target_ms: TARGET_MS,
  evaluate,
};
