// reality-source.mjs — the Reality-lane producer (AE Cobra Pillar 2, Schism Engine).
//
// WHY THIS EXISTS
// The Schism Engine's whole power comes from one line in the spec:
//
//     "Lane is set by the CALLER at write time, based on which subsystem
//      produced the event. The model never decides its own lane."
//      — AE_COBRA_FOUNDATION_SPEC.md, Pillar 2
//
// That single rule makes the ledger an UN-GAMEABLE signal. In ordinary RLHF a
// model can learn to please the annotator. Here a model is structurally barred
// from authoring its own ground truth. Nothing else in the system needs to
// enforce it, provided the Reality writer cannot be talked into lying.
//
// On disk today the ledger holds 87 records and ALL of them are Thought
// (learning-loop.mjs:58 — `opts.lane || 'thought'`, and nothing passes reality).
// That is CORRECT while execution is a stub: a stubbed result is a hypothesis,
// not an observation. But it leaves the Reality lane with no producer, so
// nothing can ever contradict a belief, and Phase 5 has nothing to learn from.
//
// This module is that producer, built from the sources the spec's origin table
// already classifies as Reality and that exist on the dev box TODAY — no
// Codexa, no Phase 2:
//
//     terminal stdout/stderr  -> reality   (what the machine actually said)
//     compiler / build output -> reality   (ground truth)
//     Mirage data-plane read  -> reality   (observed state: file bytes, git)
//     operator decision       -> reality   (the operator said this verbatim)
//
// THE DESIGN POINT
//   `lane` is NOT a parameter of any exported function. You cannot ask for
//   Reality. It is derived from which observer you called, and every machine
//   observer RUNS THE THING ITSELF and captures the real result. A caller
//   passes a command, never an outcome. That is the whole guarantee:
//
//       observeTestRun({ command })   ->  module spawns it, reads exit code
//       NOT observeTestRun({ passed: true })
//
//   An LLM holding this module can cause an observation. It cannot author one.
//
// HONEST GAP (Mom's Law — stated, not buried)
//   observeOperatorDecision() is the one Reality source this module cannot
//   self-verify: it has no way to prove the operator really said the words a
//   caller hands it. The spec still classifies operator statements as Reality,
//   so it writes to Reality — but it is stamped `self_verified: false`, and
//   the calibration engine must be able to exclude that class. Machine
//   observations are stamped `self_verified: true`. Do not erase that line.
//
// Bun only. No deps. Offline-safe. Never throws on a missing ledger.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { __loopInternals } from './learning-loop.mjs';

// Single writer, single layout. Reusing the loop's appendFlux rather than
// duplicating the chain logic — two writers would eventually drift apart and
// the hash chain is the one thing that must never fork.
const { appendFlux } = __loopInternals;

export const REALITY_SCHEMA = 'orange5.reality.observation.v1';

/** Origins this module is allowed to stamp Reality with. Closed set by design. */
export const REALITY_ORIGINS = Object.freeze({
  TEST: 'terminal:test-run',
  BUILD: 'terminal:build',
  GIT: 'mirage:git-state',
  FILE: 'mirage:file-state',
  OPERATOR: 'operator:decision',
});

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const clip = (s, n = 4000) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more bytes]` : (s ?? ''));

// ---------------------------------------------------------------------------
// The single internal write path. Not exported. Every observer funnels here,
// so there is exactly one place in the codebase that can produce a Reality
// record, and it is only reachable through an observer that gathered evidence.
// ---------------------------------------------------------------------------
function writeReality({ fluxRoot, origin, kind, body, ts }) {
  if (!Object.values(REALITY_ORIGINS).includes(origin)) {
    // Defence in depth: even internally, an unrecognised origin cannot mint
    // Reality. If a future observer is added, it must register its origin above.
    throw new Error(`reality-source: refusing to write Reality for unregistered origin "${origin}"`);
  }
  return appendFlux({
    fluxRoot, lane: 'reality', origin, kind, ts,
    body: { schema: REALITY_SCHEMA, ...body },
  });
}

// ---------------------------------------------------------------------------
// OBSERVER 1 — test / verifier runs. The strongest ground truth available on
// the dev box: an exit code the caller did not get to choose.
// ---------------------------------------------------------------------------
/**
 * Run a command and record what actually happened.
 * The caller supplies the COMMAND. The module supplies the OUTCOME.
 *
 * @param {object}   a
 * @param {string}   a.fluxRoot        ledger root (required)
 * @param {string[]} a.command         argv, e.g. ['bun','run','verify']
 * @param {string}  [a.cwd]            working dir
 * @param {number}  [a.timeoutMs]      default 10 min (the verify suite is slow)
 * @param {string}  [a.label]          human tag for the observation
 * @returns {{record:object, exitCode:number, passed:boolean, durationMs:number}}
 */
export function observeTestRun({ fluxRoot, command, cwd, timeoutMs = 600_000, label } = {}) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error('reality-source: command argv array is required');
  }
  const started = Date.now();
  const r = spawnSync(command[0], command.slice(1), {
    cwd, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;

  // A timeout or spawn failure is itself an observation, not an exception.
  const exitCode = typeof r.status === 'number' ? r.status : (r.error ? -1 : -2);
  const passed = exitCode === 0;
  const stdout = clip(r.stdout);
  const stderr = clip(r.stderr);

  const record = writeReality({
    fluxRoot,
    origin: REALITY_ORIGINS.TEST,
    kind: passed ? 'observation:test-pass' : 'observation:test-fail',
    ts: started,
    body: {
      self_verified: true,
      summary: `${label ?? command.join(' ')} exited ${exitCode} in ${durationMs}ms`,
      commands: [command.join(' ')],
      exit_code: exitCode,
      passed,
      duration_ms: durationMs,
      timed_out: Boolean(r.error && /ETIMEDOUT|timed? ?out/i.test(String(r.error.message))),
      stdout_sha256: sha256(String(r.stdout ?? '')),
      stdout_tail: clip(String(r.stdout ?? '').split('\n').slice(-40).join('\n'), 2000),
      stderr_tail: stderr ? clip(stderr.split('\n').slice(-20).join('\n'), 1000) : '',
      // failure signals recall-engine's isMistakeRecord() keys on
      ...(passed ? {} : { overall_ok: false, severity: 'error', is_mistake: true }),
    },
  });
  return { record, exitCode, passed, durationMs, stdout, stderr };
}

// ---------------------------------------------------------------------------
// OBSERVER 2 — git state. Observed, never asserted.
// ---------------------------------------------------------------------------
/**
 * Record the repository's actual HEAD and working-tree cleanliness.
 * @returns {{record:object|null, head:string|null, dirty:boolean, files:string[]}}
 */
export function observeGitState({ fluxRoot, repo, label } = {}) {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
    return r.status === 0 ? String(r.stdout ?? '').trim() : null;
  };
  const head = git(['rev-parse', 'HEAD']);
  if (head === null) {
    // Not a repo / git unavailable. An honest non-observation, not a fake one.
    return { record: null, head: null, dirty: false, files: [], note: 'git unavailable or not a repository' };
  }
  const porcelain = git(['status', '--porcelain']) ?? '';
  const files = porcelain ? porcelain.split('\n').filter(Boolean).map((l) => l.slice(3)) : [];
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? '';
  const subject = git(['log', '-1', '--pretty=%s']) ?? '';

  const record = writeReality({
    fluxRoot,
    origin: REALITY_ORIGINS.GIT,
    kind: 'observation:git-state',
    body: {
      self_verified: true,
      summary: `${label ? label + ' — ' : ''}HEAD ${head.slice(0, 12)} on ${branch}${files.length ? ` (${files.length} uncommitted)` : ' (clean)'}: ${subject}`,
      head, branch, subject,
      dirty: files.length > 0,
      files: files.slice(0, 200),
      uncommitted_count: files.length,
    },
  });
  return { record, head, branch, dirty: files.length > 0, files };
}

// ---------------------------------------------------------------------------
// OBSERVER 3 — file state. "Did the thing that was promised actually land?"
// This is what turns a plan into a checkable claim.
// ---------------------------------------------------------------------------
/**
 * Record whether specific paths exist and what their bytes hash to.
 * @param {string[]} a.paths  absolute or repo-relative paths
 */
export function observeFileState({ fluxRoot, paths, cwd = '.', label } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('reality-source: paths array is required');
  }
  const observed = paths.map((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) return { path: p, exists: true, kind: 'dir', bytes: null, sha256: null };
      const buf = fs.readFileSync(abs);
      return { path: p, exists: true, kind: 'file', bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    } catch {
      return { path: p, exists: false, kind: null, bytes: null, sha256: null };
    }
  });
  const missing = observed.filter((o) => !o.exists);

  const record = writeReality({
    fluxRoot,
    origin: REALITY_ORIGINS.FILE,
    kind: missing.length ? 'observation:file-missing' : 'observation:file-present',
    body: {
      self_verified: true,
      summary: `${label ? label + ' — ' : ''}${observed.length - missing.length}/${observed.length} path(s) present${missing.length ? `; missing: ${missing.map((m) => m.path).join(', ')}` : ''}`,
      files: observed.map((o) => o.path),
      observed,
      missing_count: missing.length,
      ...(missing.length ? { overall_ok: false, severity: 'error', is_mistake: true } : {}),
    },
  });
  return { record, observed, missing };
}

// ---------------------------------------------------------------------------
// OBSERVER 4 — operator decision. The one source this module CANNOT verify.
// The spec classifies it as Reality (the operator said it), so it lands in
// Reality — but stamped self_verified:false so calibration can exclude it.
// Removing that stamp would silently reopen the hole this module exists to close.
// ---------------------------------------------------------------------------
export function observeOperatorDecision({ fluxRoot, verbatim, decision, context } = {}) {
  if (typeof verbatim !== 'string' || !verbatim.trim()) {
    throw new Error('reality-source: verbatim operator text is required');
  }
  return writeReality({
    fluxRoot,
    origin: REALITY_ORIGINS.OPERATOR,
    kind: 'observation:operator-decision',
    body: {
      self_verified: false,   // <- the honest line. Do not delete.
      summary: decision ? `operator decision: ${decision}` : `operator said: ${clip(verbatim, 300)}`,
      verbatim: clip(verbatim, 8000),
      decision: decision ?? null,
      context: context ?? null,
      verbatim_sha256: sha256(verbatim),
    },
  });
}

// ---------------------------------------------------------------------------
// Ledger shape report — how much Reality vs Thought exists, and therefore
// whether the belief/outcome channel has anything to learn from yet.
// ---------------------------------------------------------------------------
export function ledgerShape({ fluxRoot } = {}) {
  const out = { reality: 0, thought: 0, merge: 0, selfVerifiedReality: 0, days: {} };
  for (const lane of ['reality', 'thought', 'merge']) {
    const dir = path.join(fluxRoot ?? '', 'events', lane);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      let lines = [];
      try { lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean); } catch { continue; }
      out[lane] += lines.length;
      out.days[f.replace('.jsonl', '')] ??= { reality: 0, thought: 0, merge: 0 };
      out.days[f.replace('.jsonl', '')][lane] += lines.length;
      if (lane === 'reality') {
        for (const l of lines) {
          try { if (JSON.parse(l)?.body?.self_verified === true) out.selfVerifiedReality++; } catch { /* torn line */ }
        }
      }
    }
  }
  out.total = out.reality + out.thought + out.merge;
  out.canCalibrate = out.selfVerifiedReality > 0 && out.thought > 0;
  out.note = out.canCalibrate
    ? 'both lanes populated — belief/outcome pairing is possible'
    : out.reality === 0
      ? 'Reality lane empty: nothing can contradict a belief yet. Run an observer.'
      : 'insufficient self-verified Reality to calibrate';
  return out;
}
