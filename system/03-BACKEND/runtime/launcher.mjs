import path from "node:path";

function validatePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Bun spawn returned an invalid pid");
  return pid;
}

export class BunRuntimeLauncher {
  constructor({ spawn = Bun.spawn, platform = process.platform } = {}) {
    if (typeof spawn !== "function") throw new Error("spawn function is required");
    this.spawn = spawn;
    this.platform = platform;
    this.owned = new Map();
  }

  launch(organ) {
    const env = {
      ...process.env,
      ...organ.env,
      ORANGE_RUNTIME_ORGAN: organ.name,
      ORANGE_RUNTIME_MEMORY_MB: String(organ.resources.memoryMb),
      ORANGE_RUNTIME_CPU_UNITS: String(organ.resources.cpuUnits),
      ORANGE_RUNTIME_WORKER_CONCURRENCY: String(organ.resources.workerConcurrency),
    };
    const options = {
      cwd: organ.cwd ? path.resolve(organ.cwd) : process.cwd(),
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
      detached: organ.detached,
    };
    const child = this.spawn([...organ.command], options);
    const pid = validatePid(child?.pid);
    this.owned.set(organ.name, { child, pid });
    if (organ.detached && typeof child.unref === "function") child.unref();
    const exited = Promise.resolve(child.exited).then((exitCode) => {
      const current = this.owned.get(organ.name);
      if (current?.pid === pid) this.owned.delete(organ.name);
      return Number.isInteger(exitCode) ? exitCode : null;
    });
    return { pid, exited, options };
  }

  stop(organ, pid) {
    const owned = this.owned.get(organ.name);
    if (!owned || owned.pid !== pid) {
      return { ok: false, reason: "refused-to-stop-unowned-process" };
    }
    try {
      owned.child.kill();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    }
  }
}
