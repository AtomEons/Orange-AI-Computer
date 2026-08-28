const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export const RUNTIME_PROFILE_SCHEMA = "orange.runtime-profile.v1";
export const DESIRED_STATES = Object.freeze(["running", "stopped"]);

function finiteNumber(value, name, { min = 0, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || (integer && !Number.isInteger(number))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} >= ${min}`);
  }
  return number;
}

function normalizeCommand(command) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("organ command must be a non-empty argv array");
  }
  const argv = command.map((part) => String(part));
  if (argv.some((part) => part.length === 0)) throw new Error("organ command contains an empty argv item");
  return argv;
}

export function defineRuntimeOrgan(input) {
  if (!input || typeof input !== "object") throw new Error("organ declaration is required");
  const name = String(input.name || "");
  if (!NAME_PATTERN.test(name)) throw new Error(`invalid organ name: ${name || "<empty>"}`);

  const resources = input.resources || {};
  const workerConcurrency = finiteNumber(resources.workerConcurrency, `${name}.resources.workerConcurrency`, {
    min: 1,
    integer: true,
  });

  return Object.freeze({
    name,
    command: Object.freeze(normalizeCommand(input.command)),
    cwd: input.cwd ? String(input.cwd) : null,
    env: Object.freeze(Object.fromEntries(
      Object.entries(input.env || {}).map(([key, value]) => [String(key), String(value)]),
    )),
    desired: input.desired === "stopped" ? "stopped" : "running",
    priority: finiteNumber(input.priority ?? 50, `${name}.priority`, { min: 0 }),
    detached: input.detached !== false,
    resources: Object.freeze({
      memoryMb: finiteNumber(resources.memoryMb, `${name}.resources.memoryMb`, { min: 1, integer: true }),
      cpuUnits: finiteNumber(resources.cpuUnits, `${name}.resources.cpuUnits`, { min: 0.01 }),
      workerConcurrency,
    }),
  });
}

export function createRuntimeProfile(input) {
  if (!input || typeof input !== "object") throw new Error("runtime profile is required");
  const id = String(input.id || "");
  if (!NAME_PATTERN.test(id)) throw new Error(`invalid runtime profile id: ${id || "<empty>"}`);

  const organs = (input.organs || []).map(defineRuntimeOrgan);
  if (organs.length === 0) throw new Error("runtime profile requires at least one organ");
  if (new Set(organs.map((organ) => organ.name)).size !== organs.length) {
    throw new Error("runtime profile organ names must be unique");
  }

  const limits = input.limits || {};
  const profile = {
    schema: RUNTIME_PROFILE_SCHEMA,
    id,
    limits: Object.freeze({
      maxConcurrentStarts: finiteNumber(limits.maxConcurrentStarts ?? 2, "limits.maxConcurrentStarts", {
        min: 1,
        integer: true,
      }),
      maxWorkerConcurrency: finiteNumber(limits.maxWorkerConcurrency, "limits.maxWorkerConcurrency", {
        min: 1,
        integer: true,
      }),
      maxMemoryMb: finiteNumber(limits.maxMemoryMb, "limits.maxMemoryMb", { min: 1, integer: true }),
      maxCpuUnits: finiteNumber(limits.maxCpuUnits, "limits.maxCpuUnits", { min: 0.01 }),
    }),
    backoff: Object.freeze({
      baseMs: finiteNumber(input.backoff?.baseMs ?? 1_000, "backoff.baseMs", { min: 1, integer: true }),
      maxMs: finiteNumber(input.backoff?.maxMs ?? 300_000, "backoff.maxMs", { min: 1, integer: true }),
    }),
    organs: Object.freeze(organs),
  };
  if (profile.backoff.maxMs < profile.backoff.baseMs) {
    throw new Error("backoff.maxMs must be >= backoff.baseMs");
  }
  return Object.freeze(profile);
}

export function organByName(profile, name) {
  const organ = profile.organs.find((candidate) => candidate.name === name);
  if (!organ) throw new Error(`unknown runtime organ: ${name}`);
  return organ;
}
