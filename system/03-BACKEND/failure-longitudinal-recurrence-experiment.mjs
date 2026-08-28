#!/usr/bin/env bun

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ingestReceipt, lessonFor } from './learning-loop.mjs';
import { verifyChainStream } from '../06-ORANGELLM/memory/ae-cobra/flux/reader.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(import.meta.dir, '..');
const DEFAULT_RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const DEFAULT_COHORTS = 2;
const DEFAULT_SESSIONS_PER_ARM = 5;
const DEFAULT_CHILD_TIMEOUT_MS = 10_000;
const MAX_CHILD_PROCESSES = 60;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function boundedInteger(value, { name, min, max }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return number;
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodePayload(value) {
  return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
}

function projectLesson(lesson) {
  return {
    active_failures: lesson.count,
    resolved_failures: lesson.resolved_count,
    suppressed_candidates: lesson.suppressed_count,
    candidates_considered: lesson.candidates_considered,
    failure_classes: lesson.patterns.map((item) => item.failureClass),
    recommended_action: lesson.recommendedAction,
    last_resolution_at: lesson.last_resolution_at,
    last_resolution_disposition: lesson.last_resolution_disposition,
  };
}

function chooseDecision({ arm, before }) {
  if (arm === 'control') return 'repeat_unverified_route';
  if (before.count > 0) return 'repair_then_verify';
  if (before.resolved_count > 0) return 'reuse_proven_resolution';
  return 'repeat_unverified_route';
}

function outcomeFor(decision) {
  if (decision === 'repeat_unverified_route') {
    return {
      status: 'error',
      summary: 'connection timeout after repeating the unverified direct route',
      nextAction: 'Probe reachability and credentials before selecting the governed route.',
      mistake: true,
    };
  }
  if (decision === 'repair_then_verify') {
    return {
      status: 'completed',
      summary: 'reachability and credentials verified before the governed route completed',
      nextAction: 'Reuse the verified reachability-first route while its proof remains current.',
      mistake: false,
    };
  }
  return {
    status: 'completed',
    summary: 'reused the proven reachability-first route and bounded verification passed',
    nextAction: 'Continue the proven route while its dependencies and proof remain current.',
    mistake: false,
  };
}

async function runSessionWorker(payload) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const query = {
    fluxRoot: payload.fluxRoot,
    nowMs: payload.ts,
    limit: 20,
    scanLimit: 200,
    intent: payload.intent,
    targetProject: payload.targetProject,
  };
  const before = lessonFor(payload.action, query);
  const decision = chooseDecision({ arm: payload.arm, before });
  const outcome = outcomeFor(decision);
  const receiptId = `${payload.experimentId}:${payload.cohortId}:${payload.arm}:${payload.session}`;
  const written = await ingestReceipt({
    action: payload.action,
    status: outcome.status,
    summary: outcome.summary,
    nextAction: outcome.nextAction,
    receipt_id: receiptId,
    targetProject: payload.targetProject,
    decision_reason: decision,
    decision_basis: [
      `arm:${payload.arm}`,
      `active_failures:${before.count}`,
      `resolved_failures:${before.resolved_count}`,
    ],
  }, { fluxRoot: payload.fluxRoot, ts: payload.ts });
  const after = lessonFor(payload.action, { ...query, nowMs: payload.ts + 1 });
  return {
    schema: 'orange5.failure-recurrence-session.v1',
    experiment_id: payload.experimentId,
    cohort_id: payload.cohortId,
    arm: payload.arm,
    session: payload.session,
    session_id: payload.sessionId,
    process: {
      pid: process.pid,
      parent_pid: process.ppid,
      boot_id: crypto.randomUUID(),
      started_at: startedAt,
      duration_ms: Number((performance.now() - started).toFixed(2)),
    },
    memory_policy_enabled: payload.arm === 'memory',
    memory_before: projectLesson(before),
    decision,
    outcome: {
      status: outcome.status,
      mistake: outcome.mistake,
      summary: outcome.summary,
    },
    memory_after: projectLesson(after),
    flux_record: {
      lane: written.lane,
      kind: written.kind,
      hash: written.hash,
      prev_hash: written.prev_hash,
      receipt_id: receiptId,
    },
  };
}

function spawnSession(payload, timeoutMs) {
  const result = spawnSync(process.execPath, [MODULE_PATH, '--session', encodePayload(payload)], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ORANGE5_FAILURE_RECURRENCE_CHILD: '1' },
  });
  if (result.error) {
    throw new Error(`fresh session ${payload.sessionId} failed to launch: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`fresh session ${payload.sessionId} exited ${result.status}: ${String(result.stderr || '').trim()}`);
  }
  try {
    return JSON.parse(String(result.stdout || '').trim());
  } catch (error) {
    throw new Error(`fresh session ${payload.sessionId} emitted invalid JSON: ${error.message}`);
  }
}

function runArm({ experimentId, cohortId, arm, fluxRoot, sessionsPerArm, childTimeoutMs, baseTs }) {
  const action = 'build.failure-recurrence-route';
  const targetProject = `lane7-longitudinal-${cohortId}`;
  const intent = 'select a verified route after a connection timeout';
  const sessions = [];
  for (let session = 1; session <= sessionsPerArm; session += 1) {
    sessions.push(spawnSession({
      experimentId,
      cohortId,
      arm,
      session,
      sessionId: `${cohortId}-${arm}-${session}`,
      fluxRoot,
      action,
      targetProject,
      intent,
      ts: baseTs + session * 1_000,
    }, childTimeoutMs));
  }
  const chain = verifyChainStream({ fluxRoot, lane: 'thought' });
  const repeatMistakes = sessions.slice(1).filter((item) => item.outcome.mistake).length;
  const resolutionSession = sessions.find((item) => item.memory_after.active_failures === 0
    && item.memory_after.resolved_failures > 0)?.session || null;
  return {
    arm,
    memory_policy_enabled: arm === 'memory',
    sessions,
    measures: {
      total_mistakes: sessions.filter((item) => item.outcome.mistake).length,
      repeat_mistakes: repeatMistakes,
      repeat_opportunities: Math.max(0, sessions.length - 1),
      resolution_session: resolutionSession,
      post_resolution_mistakes: resolutionSession
        ? sessions.slice(resolutionSession).filter((item) => item.outcome.mistake).length
        : null,
    },
    flux_chain: chain,
  };
}

function cohortChecks(cohort) {
  const control = cohort.control;
  const memory = cohort.memory;
  return {
    equivalent_initial_failure: control.sessions[0].outcome.mistake === true
      && memory.sessions[0].outcome.mistake === true,
    control_repeats_without_policy: control.measures.repeat_mistakes === control.measures.repeat_opportunities,
    recall_changes_next_decision: memory.sessions[1].memory_before.active_failures > 0
      && memory.sessions[1].decision === 'repair_then_verify',
    repair_resolves_episode: memory.sessions[1].outcome.status === 'completed'
      && memory.sessions[1].memory_after.active_failures === 0
      && memory.sessions[1].memory_after.resolved_failures > 0,
    resolved_history_suppresses_repeats: memory.sessions.slice(2).every((session) => (
      session.memory_before.active_failures === 0
      && session.memory_before.resolved_failures > 0
      && session.decision === 'reuse_proven_resolution'
      && session.outcome.mistake === false
    )),
    memory_arm_has_zero_repeat_mistakes: memory.measures.repeat_mistakes === 0,
    flux_chains_valid: control.flux_chain.ok === true && memory.flux_chain.ok === true,
  };
}

function compactSession(session) {
  return {
    session: session.session,
    session_id: session.session_id,
    process: session.process,
    memory_policy_enabled: session.memory_policy_enabled,
    memory_before: session.memory_before,
    decision: session.decision,
    outcome: session.outcome,
    memory_after: session.memory_after,
    flux_record: session.flux_record,
  };
}

export function runFailureLongitudinalRecurrenceExperiment({
  cohorts = DEFAULT_COHORTS,
  sessionsPerArm = DEFAULT_SESSIONS_PER_ARM,
  childTimeoutMs = DEFAULT_CHILD_TIMEOUT_MS,
  writeReceipt = true,
  receiptDir = DEFAULT_RECEIPT_DIR,
} = {}) {
  const cohortCount = boundedInteger(cohorts, { name: 'cohorts', min: 1, max: 5 });
  const sessionCount = boundedInteger(sessionsPerArm, { name: 'sessionsPerArm', min: 3, max: 8 });
  const timeoutMs = boundedInteger(childTimeoutMs, { name: 'childTimeoutMs', min: 1_000, max: 30_000 });
  const totalChildren = cohortCount * sessionCount * 2;
  if (totalChildren > MAX_CHILD_PROCESSES) throw new Error(`experiment exceeds ${MAX_CHILD_PROCESSES} child processes`);

  const experimentId = `lane7-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-lane7-recurrence-'));
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const cohortRows = [];
    for (let index = 0; index < cohortCount; index += 1) {
      const cohortId = `cohort-${index + 1}`;
      const cohortRoot = path.join(scratchRoot, cohortId);
      const baseTs = Date.parse('2026-08-27T12:00:00Z') + index * 100_000;
      const control = runArm({
        experimentId,
        cohortId,
        arm: 'control',
        fluxRoot: path.join(cohortRoot, 'control'),
        sessionsPerArm: sessionCount,
        childTimeoutMs: timeoutMs,
        baseTs,
      });
      const memory = runArm({
        experimentId,
        cohortId,
        arm: 'memory',
        fluxRoot: path.join(cohortRoot, 'memory'),
        sessionsPerArm: sessionCount,
        childTimeoutMs: timeoutMs,
        baseTs,
      });
      const checks = cohortChecks({ control, memory });
      cohortRows.push({ cohort_id: cohortId, control, memory, checks });
    }

    const allSessions = cohortRows.flatMap((cohort) => [
      ...cohort.control.sessions,
      ...cohort.memory.sessions,
    ]);
    const controlRepeats = cohortRows.reduce((total, cohort) => total + cohort.control.measures.repeat_mistakes, 0);
    const memoryRepeats = cohortRows.reduce((total, cohort) => total + cohort.memory.measures.repeat_mistakes, 0);
    const repeatOpportunities = cohortRows.reduce((total, cohort) => total + cohort.memory.measures.repeat_opportunities, 0);
    const bootIds = new Set(allSessions.map((session) => session.process.boot_id));
    const workerPids = new Set(allSessions.map((session) => session.process.pid));
    const checks = {
      bounded_protocol: totalChildren <= MAX_CHILD_PROCESSES && allSessions.length === totalChildren,
      every_session_is_fresh_process: allSessions.every((session) => session.process.pid !== process.pid)
        && workerPids.size === totalChildren
        && bootIds.size === totalChildren,
      all_cohorts_pass: cohortRows.every((cohort) => Object.values(cohort.checks).every(Boolean)),
      control_establishes_recurrence: controlRepeats === repeatOpportunities && controlRepeats > 0,
      treatment_eliminates_repeat_mistakes: memoryRepeats === 0,
      resolved_state_persists_across_sessions: cohortRows.every((cohort) => (
        cohort.memory.sessions.slice(2).every((session) => session.memory_before.resolved_failures > 0)
      )),
      all_flux_chains_valid: cohortRows.every((cohort) => (
        cohort.control.flux_chain.ok && cohort.memory.flux_chain.ok
      )),
    };
    const suppressionRate = controlRepeats > 0 ? (controlRepeats - memoryRepeats) / controlRepeats : 0;
    const passed = Object.values(checks).every(Boolean) && suppressionRate === 1;
    const generatedAt = new Date().toISOString();
    const receipt = {
      schema: 'orange5.failure-longitudinal-recurrence.v1',
      experiment_id: experimentId,
      generated_at: generatedAt,
      status: passed
        ? 'LONGITUDINAL_RECURRENCE_SUPPRESSION_PROVEN'
        : 'LONGITUDINAL_RECURRENCE_SUPPRESSION_NEEDS_WORK',
      design: {
        method: 'paired deterministic control/treatment cohorts',
        hypothesis: 'Receipt-backed failure memory changes the next fresh-process decision, closes the failure on proven repair, and reuses that resolved path without repeating the mistake.',
        counterfactual: 'The control decision policy records the same receipts but ignores memory and repeats the failed route.',
        falsifiers: [
          'Any treatment session after the initial failure repeats the unverified route.',
          'Any post-resolution treatment session loses resolved history or records a mistake.',
          'Any paired control arm fails to repeat the mistake at each eligible session.',
          'Any session executes in the parent process or any Flux chain is broken.',
        ],
        cohorts: cohortCount,
        arms_per_cohort: 2,
        sessions_per_arm: sessionCount,
        child_processes: totalChildren,
        child_timeout_ms: timeoutMs,
        maximum_child_processes: MAX_CHILD_PROCESSES,
        production_memory_mutated: false,
      },
      process_isolation: {
        parent_pid: process.pid,
        observed_worker_pids: [...workerPids],
        unique_worker_pids: workerPids.size,
        unique_boot_ids: bootIds.size,
        fresh_processes_proven: checks.every_session_is_fresh_process,
      },
      measures: {
        control_repeat_mistakes: controlRepeats,
        memory_repeat_mistakes: memoryRepeats,
        repeat_opportunities: repeatOpportunities,
        prevented_repeat_mistakes: controlRepeats - memoryRepeats,
        recurrence_suppression_rate: suppressionRate,
        duration_ms: Number((performance.now() - started).toFixed(2)),
      },
      checks,
      cohorts: cohortRows.map((cohort) => ({
        cohort_id: cohort.cohort_id,
        checks: cohort.checks,
        control: {
          measures: cohort.control.measures,
          flux_chain: cohort.control.flux_chain,
          sessions: cohort.control.sessions.map(compactSession),
        },
        memory: {
          measures: cohort.memory.measures,
          flux_chain: cohort.memory.flux_chain,
          sessions: cohort.memory.sessions.map(compactSession),
        },
      })),
      provenance: {
        started_at: startedAt,
        finished_at: generatedAt,
        runtime: `Bun ${process.versions.bun}`,
        platform: `${process.platform}/${process.arch}`,
        source_files: {
          experiment: { path: MODULE_PATH, sha256: sha256(fs.readFileSync(MODULE_PATH)) },
          learning_loop: {
            path: path.join(import.meta.dir, 'learning-loop.mjs'),
            sha256: sha256(fs.readFileSync(path.join(import.meta.dir, 'learning-loop.mjs'))),
          },
        },
        worker_command: `${process.execPath} ${MODULE_PATH} --session <base64url-payload>`,
      },
      claim_boundary: {
        proven: passed,
        claim: 'The deterministic OrangeFive failure-memory mechanism suppressed repeat mistakes across bounded fresh processes and sessions in the paired experiment.',
        excludes: 'This does not by itself establish an unbounded real-world recurrence rate or model-behavior improvement outside the tested policy and failure class.',
      },
    };

    if (!writeReceipt) return { ...receipt, receipt_path: null };
    const receiptPath = path.join(receiptDir, `${generatedAt.replace(/[:.]/g, '-')}-failure-longitudinal-recurrence.json`);
    const chained = writeChainedJsonReceipt(receiptPath, receipt);
    return { ...chained, receipt_path: receiptPath };
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv[2] === '--session') {
    try {
      const result = await runSessionWorker(decodePayload(process.argv[3]));
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    }
  } else {
    const result = runFailureLongitudinalRecurrenceExperiment();
    console.log(JSON.stringify({
      status: result.status,
      experiment_id: result.experiment_id,
      checks: result.checks,
      measures: result.measures,
      process_isolation: result.process_isolation,
      receipt_path: result.receipt_path,
      receipt_sha256: result.receipt_sha256,
      claim_boundary: result.claim_boundary,
    }, null, 2));
    if (result.status !== 'LONGITUDINAL_RECURRENCE_SUPPRESSION_PROVEN') process.exitCode = 1;
  }
}

export const __failureLongitudinalInternals = Object.freeze({
  chooseDecision,
  outcomeFor,
  projectLesson,
  MAX_CHILD_PROCESSES,
});
