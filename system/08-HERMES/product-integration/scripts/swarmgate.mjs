#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const policy = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'config', 'swarm-policy.json'), 'utf8'));
const unique = (values) => [...new Set(values.filter(Boolean))];
const intersects = (left, right) => left.some((item) => right.includes(item));

function inferredProfile(task) {
  const text = `${task.action || ''} ${task.intent || ''}`.toLowerCase();
  if (/review|verify|audit|test|falsif/.test(text)) return 'reviewer';
  if (/research|source|paper|current|benchmark/.test(text)) return 'researcher';
  if (/visual|screen|image|render|ui|ux/.test(text)) return 'visual';
  if (/dissent|misfit|assumption|attack/.test(text)) return 'misfit';
  if (/build|implement|patch|write|code|fix/.test(text)) return 'builder';
  return 'navigator';
}

function normalizeTask(task, index) {
  const model = task.model || {};
  return {
    id: String(task.id || `task-${index + 1}`),
    action: String(task.action || task.intent || 'inspect'),
    profile: task.profile || inferredProfile(task),
    dependsOn: unique(task.dependsOn || []),
    reads: unique(task.reads || []),
    writes: unique(task.writes || []),
    irreversible: Boolean(task.irreversible),
    model: {
      key: String(model.key || task.modelKey || 'orange-auto'),
      residentGb: Number(model.residentGb ?? task.modelResidentGb ?? 10),
      contextGb: Number(model.contextGb ?? task.contextGb ?? 1)
    }
  };
}

function waveMemoryGb(tasks) {
  const residents = new Map();
  let contexts = 0;
  for (const task of tasks) {
    residents.set(task.model.key, Math.max(residents.get(task.model.key) || 0, task.model.residentGb));
    contexts += task.model.contextGb;
  }
  return [...residents.values()].reduce((sum, value) => sum + value, 0) + contexts;
}

function conflict(a, b) {
  if (a.irreversible || b.irreversible) return 'irreversible-boundary';
  if (intersects(a.writes, b.writes)) return 'shared-write';
  if (intersects(a.writes, b.reads) || intersects(b.writes, a.reads)) return 'read-write-collision';
  return null;
}

export function planSwarm(input) {
  const tasks = (input.tasks || []).map(normalizeTask);
  if (!tasks.length) throw new Error('At least one task is required');
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error('Task ids must be unique');
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!ids.has(dep)) throw new Error(`Unknown dependency ${dep} for ${task.id}`);
  }

  const memoryCeiling = Math.min(Number(input.liveMemoryBudgetGb ?? policy.liveMemoryBudgetGb), policy.liveMemoryBudgetGb);
  const availableGb = memoryCeiling - Number(input.reservedSystemMemoryGb ?? policy.reservedSystemMemoryGb);
  const maxWorkers = Math.max(1, Math.min(Number(input.maxImmediateWorkers ?? policy.maxImmediateWorkers), policy.maxImmediateWorkers));
  if (availableGb <= 0) throw new Error('No live-memory budget remains after system reserve');

  const pending = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set();
  const waves = [];
  const rejectedParallelPairs = [];

  while (pending.size) {
    const ready = [...pending.values()].filter((task) => task.dependsOn.every((dep) => completed.has(dep)));
    if (!ready.length) throw new Error('Dependency cycle detected');
    const wave = [];
    for (const task of ready) {
      if (wave.length >= maxWorkers) break;
      const collision = wave.map((peer) => ({ peer, reason: conflict(task, peer) })).find((item) => item.reason);
      if (collision) {
        rejectedParallelPairs.push({ left: collision.peer.id, right: task.id, reason: collision.reason });
        continue;
      }
      if (waveMemoryGb([...wave, task]) <= availableGb) wave.push(task);
    }
    if (!wave.length) {
      const task = ready[0];
      if (waveMemoryGb([task]) > availableGb) throw new Error(`Task ${task.id} requires ${waveMemoryGb([task]).toFixed(2)} GiB; ${availableGb.toFixed(2)} GiB available`);
      wave.push(task);
    }
    waves.push({
      index: waves.length,
      workers: wave.map(({ model, ...task }) => ({ ...task, modelKey: model.key })),
      estimatedMemoryGb: Number(waveMemoryGb(wave).toFixed(2))
    });
    for (const task of wave) { pending.delete(task.id); completed.add(task.id); }
  }

  const maxWidth = Math.max(...waves.map((wave) => wave.workers.length));
  const nestedEligible = tasks.some((task) => policy.nestedOrchestratorProfiles.includes(task.profile)) && tasks.length > maxWorkers;
  const mode = maxWidth === 1 ? 'solo' : maxWidth <= 3 ? 'triad' : nestedEligible ? 'tree' : 'swarm';
  return {
    schema: 'orange5.swarmgate-plan.v1', status: 'PLANNED', mode,
    taskCount: tasks.length, waveCount: waves.length, maxParallelWorkers: maxWidth,
    peakEstimatedMemoryGb: Math.max(...waves.map((wave) => wave.estimatedMemoryGb)),
    executionWaves: waves, rejectedParallelPairs,
    invariants: { centralDispatcher: true, orangeMutationsSerialized: true, liveMemoryBudgetGb: availableGb, evidenceRequiredPerLeaf: true }
  };
}

async function main() {
  const index = process.argv.indexOf('--input');
  const raw = index >= 0 ? process.argv[index + 1] : await Bun.stdin.text();
  if (!raw) throw new Error('Provide task JSON with --input or stdin');
  console.log(JSON.stringify(planSwarm(JSON.parse(raw)), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(JSON.stringify({ schema: 'orange5.swarmgate-plan.v1', status: 'BLOCKED', error: error.message }));
  process.exit(1);
});
