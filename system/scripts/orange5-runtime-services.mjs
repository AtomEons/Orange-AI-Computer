#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const STATE = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), "OrangeBox-Data", "orange5");
const SERVICES = [
  { name: "memory", entry: "06-ORANGELLM/memory/ae-cobra/flow-direct/server.mjs", cwd: "06-ORANGELLM/memory/ae-cobra", health: "http://127.0.0.1:7419/healthz" },
  { name: "hermes", entry: "08-HERMES/src/server.mjs", cwd: "08-HERMES", health: "http://127.0.0.1:7430/healthz" },
  { name: "link-sentinel", entry: "scripts/orange5-link-sentinel.mjs", health: "http://127.0.0.1:7432/health" },
  { name: "ae-phase", entry: "03-BACKEND/ae-phase-fabric.mjs", args: ["client"], health: "http://127.0.0.1:8907/health" },
  { name: "orangellm", entry: "06-ORANGELLM/server/index.mjs", health: "http://127.0.0.1:1337/healthz" },
  { name: "brain-mcp", entry: "03-BACKEND/orange5-brain-mcp-http.mjs", health: "http://127.0.0.1:7431/health" },
];

if (import.meta.main) {
  await main();
}

async function main() {
  const action = process.argv[2] || "status";
  const targetName = process.argv[3] || null;
  if (!["start", "restart", "status", "stop"].includes(action)) fail("usage: start|restart|status|stop [service-name]");
  if (targetName && !SERVICES.some((service) => service.name === targetName)) fail(`unknown service: ${targetName}`);

  fs.mkdirSync(STATE, { recursive: true });
  const selected = SERVICES.filter((item) => !targetName || item.name === targetName);
  const run = (service) => operate(service, { action });
  let reports;
  if (targetName || action === "status" || action === "stop") {
    reports = await Promise.all(selected.map(run));
  } else {
    // Memory and policy are foundations. Start/restart them together, then
    // bring up the two client-facing surfaces together against warm deps.
    const foundationNames = new Set(["memory", "hermes", "link-sentinel"]);
    const foundations = selected.filter((service) => foundationNames.has(service.name));
    const surfaces = selected.filter((service) => !foundationNames.has(service.name));
    reports = [
      ...await Promise.all(foundations.map(run)),
      ...await Promise.all(surfaces.map(run)),
    ];
  }
  const ok = reports.every((item) => item.ok);
  process.stdout.write(`${JSON.stringify({ schema: "orange5.runtime-services.v1", action, ok, services: reports })}\n`);
  if (!ok) process.exit(1);
}

export async function operate(service, options = {}) {
  const {
    action,
    state = STATE,
    root = ROOT,
    bunExecutable = process.execPath,
    inspectProcesses = listRuntimeProcesses,
    terminateProcess = taskkill,
    healthProbe = probe,
    waitUntil = waitFor,
  } = options;
  const pidFile = path.join(state, `${service.name}.pid`);
  const current = await healthProbe(service.health);
  let startedByThisRun = false;

  if (action === "restart" || action === "stop") {
    const pidFilePid = readPid(pidFile);
    let ownership;
    try {
      const processes = await inspectProcesses(pidFilePid, service);
      ownership = resolveServiceOwnership({ service, pidFilePid, processes, root, bunExecutable, endpointHealthy: current.ok });
    } catch (error) {
      return { ...service, ok: false, blocker: `process-inventory-failed:${error.message}` };
    }
    if (!ownership.ok && !current.ok && ownership.matchingPids.length === 0) {
      // Already stopped: discard only the stale ownership marker. No process
      // was matched, so there is nothing safe to terminate.
      fs.rmSync(pidFile, { force: true });
    } else if (!ownership.ok) {
      return {
        ...service,
        ok: false,
        pid: pidFilePid,
        blocker: ownership.blocker,
        matchingPids: ownership.matchingPids,
      };
    }
    if (ownership.ok) {
      if (ownership.source === "adopted") fs.writeFileSync(pidFile, `${ownership.pid}\n`, { mode: 0o600 });
      const killed = terminateProcess(ownership.pid);
      if (!killed.ok) return { ...service, ok: false, pid: ownership.pid, blocker: killed.error };
      fs.rmSync(pidFile, { force: true });
      const stopped = await waitUntil(async () => !(await healthProbe(service.health)).ok, 8_000);
      if (!stopped) return { ...service, ok: false, pid: null, blocker: `health-still-live-after-owned-process-stop:${service.health}` };
    }
  }
  if (action === "stop") return { ...service, ok: !(await healthProbe(service.health)).ok, pid: null };
  if (!current.ok && action === "start") {
    const pidFilePid = readPid(pidFile);
    let ownership;
    try {
      const processes = await inspectProcesses(pidFilePid, service);
      ownership = resolveServiceOwnership({ service, pidFilePid, processes, root, bunExecutable });
      const pidFileProcess = pidFilePid ? processes.find((candidate) => candidate.pid === pidFilePid) : null;
      if (!ownership.ok && pidFileProcess && isExpectedBunImage(pidFileProcess, bunExecutable)) {
        const ready = await waitUntil(async () => (await healthProbe(service.health)).ok, 20_000);
        if (ready) ownership = resolveServiceOwnership({ service, pidFilePid, processes: await inspectProcesses(pidFilePid, service), root, bunExecutable, endpointHealthy: true });
        else return { ...service, ok: false, pid: pidFilePid, blocker: "pid-file-bun-process-health-timeout" };
      }
    } catch (error) {
      return { ...service, ok: false, pid: pidFilePid, blocker: `process-inventory-failed:${error.message}` };
    }
    if (ownership.ok) {
      if (ownership.source === "adopted") fs.writeFileSync(pidFile, `${ownership.pid}\n`, { mode: 0o600 });
      const ready = await waitUntil(async () => (await healthProbe(service.health)).ok, 20_000);
      if (!ready) {
        return {
          ...service,
          ok: false,
          pid: ownership.pid,
          blocker: "owned-process-health-timeout",
          matchingPids: ownership.matchingPids,
        };
      }
    } else if (ownership.matchingPids.length > 0) {
      return {
        ...service,
        ok: false,
        pid: pidFilePid,
        blocker: ownership.blocker,
        matchingPids: ownership.matchingPids,
      };
    } else {
      fs.rmSync(pidFile, { force: true });
    }
  }
  if (!(await healthProbe(service.health)).ok && (action === "start" || action === "restart")) {
    let child;
    try {
      child = Bun.spawn([bunExecutable, path.join(root, service.entry), ...(service.args || [])], {
        cwd: service.cwd ? path.join(root, service.cwd) : root,
        env: runtimeEnv(service), stdin: "ignore", stdout: "ignore", stderr: "ignore",
        windowsHide: true, detached: true,
      });
      if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error("spawn-returned-invalid-pid");
      fs.writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
      startedByThisRun = true;
    } catch (error) {
      if (Number.isInteger(child?.pid) && child.pid > 0) terminateProcess(child.pid);
      return { ...service, ok: false, pid: child?.pid || null, blocker: `spawn-or-pid-write-failed:${error.message}` };
    }
    child.unref();
    const ready = await waitUntil(async () => (await healthProbe(service.health)).ok, 20_000);
    if (!ready) return { ...service, ok: false, pid: child.pid, blocker: "health-timeout" };
  }
  const health = await healthProbe(service.health);
  if (!health.ok) return { ...service, ok: false, pid: readPid(pidFile), observed: health.body };

  const pidFilePid = readPid(pidFile);
  let ownership;
  try {
    const processes = await inspectProcesses(pidFilePid, service);
    ownership = resolveServiceOwnership({ service, pidFilePid, processes, root, bunExecutable, endpointHealthy: true });
  } catch (error) {
    return { ...service, ok: false, pid: pidFilePid, observed: health.body, blocker: `process-inventory-failed:${error.message}` };
  }
  if (!ownership.ok) {
    return {
      ...service,
      ok: false,
      pid: pidFilePid,
      observed: health.body,
      blocker: ownership.blocker,
      matchingPids: ownership.matchingPids,
    };
  }
  if (ownership.source === "adopted") fs.writeFileSync(pidFile, `${ownership.pid}\n`, { mode: 0o600 });
  return { ...service, ok: true, reused: !startedByThisRun, pid: ownership.pid, observed: health.body };
}

export function resolveServiceOwnership({ service, pidFilePid, processes, root = ROOT, bunExecutable = process.execPath, endpointHealthy = false }) {
  const matches = processes.filter((candidate) => isExactServiceProcess(candidate, service, { root, bunExecutable, endpointHealthy }));
  const pidFileProcess = pidFilePid ? processes.find((candidate) => candidate.pid === pidFilePid) : null;
  if (pidFileProcess && isExactServiceProcess(pidFileProcess, service, { root, bunExecutable, endpointHealthy })) {
    return { ok: true, pid: pidFilePid, source: "pid-file", matchingPids: matches.map((item) => item.pid) };
  }
  if (matches.length === 1) {
    return { ok: true, pid: matches[0].pid, source: "adopted", matchingPids: [matches[0].pid] };
  }
  const pidState = pidFilePid ? (pidFileProcess ? "unrelated" : "stale") : "missing";
  return {
    ok: false,
    blocker: `pid-ownership-${pidState}:expected-exactly-one-service-process:found-${matches.length}`,
    matchingPids: matches.map((item) => item.pid),
  };
}

export function isExactServiceProcess(candidate, service, { root = ROOT, bunExecutable = process.execPath, endpointHealthy = false } = {}) {
  if (!candidate || candidate.pid <= 0) return false;
  const expectedBun = normalizeWindowsPath(bunExecutable);
  if (!expectedBun) return false;
  if (normalizeWindowsPath(candidate.executablePath) === expectedBun) {
    const argv = parseWindowsCommandLine(candidate.commandLine);
    if (argv.length >= 2 && normalizeWindowsPath(argv[0]) === expectedBun) {
      return normalizeWindowsPath(argv[1]) === normalizeWindowsPath(path.join(root, service.entry));
    }
  }
  if (!endpointHealthy || String(candidate.imageName || "").toLowerCase() !== path.win32.basename(expectedBun)) return false;
  const expectedPort = Number(new URL(service.health).port);
  return Number.isInteger(expectedPort) && candidate.listeningPorts?.includes(expectedPort);
}

function isExpectedBunImage(candidate, bunExecutable) {
  const expectedBun = normalizeWindowsPath(bunExecutable);
  return Boolean(expectedBun) && String(candidate?.imageName || "").toLowerCase() === path.win32.basename(expectedBun);
}

export function parseWindowsCommandLine(commandLine) {
  if (typeof commandLine !== "string") return [];
  const args = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/.test(commandLine[index] || "")) index += 1;
    if (index >= commandLine.length) break;
    let value = "";
    let quoted = false;
    while (index < commandLine.length) {
      let slashes = 0;
      while (commandLine[index] === "\\") { slashes += 1; index += 1; }
      if (commandLine[index] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          value += '"';
        } else {
          quoted = !quoted;
        }
        index += 1;
        continue;
      }
      value += "\\".repeat(slashes);
      if (index >= commandLine.length || (!quoted && /\s/.test(commandLine[index]))) break;
      value += commandLine[index];
      index += 1;
    }
    args.push(value);
    while (/\s/.test(commandLine[index] || "")) index += 1;
  }
  return args;
}

async function listRuntimeProcesses(pidFilePid, service) {
  if (process.platform !== "win32") throw new Error(`unsupported-platform:${process.platform}`);
  const expectedPort = Number(new URL(service.health).port);
  if (!Number.isInteger(expectedPort) || expectedPort <= 0) throw new Error(`invalid-service-port:${service.health}`);
  const netstat = Bun.spawnSync(["netstat.exe", "-ano", "-p", "tcp"], {
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  if (netstat.exitCode !== 0) throw new Error(netstat.stderr.toString().trim() || `netstat-exit-${netstat.exitCode}`);
  const portsByPid = new Map();
  for (const line of netstat.stdout.toString().split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) continue;
    const portMatch = match[1].match(/:(\d+)$/);
    const port = Number(portMatch?.[1]);
    const pid = Number(match[2]);
    if (port !== expectedPort || !Number.isInteger(pid) || pid <= 0) continue;
    const ports = portsByPid.get(pid) || [];
    ports.push(port);
    portsByPid.set(pid, ports);
  }
  const pids = new Set(portsByPid.keys());
  if (Number.isInteger(pidFilePid) && pidFilePid > 0) pids.add(pidFilePid);
  const records = [];
  for (const pid of pids) {
    const tasklist = Bun.spawnSync(["tasklist.exe", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    if (tasklist.exitCode !== 0) throw new Error(tasklist.stderr.toString().trim() || `tasklist-exit-${tasklist.exitCode}`);
    const row = tasklist.stdout.toString().split(/\r?\n/).find((line) => line.trim().startsWith('"'));
    const imageName = row?.match(/^"([^"]+)"/)?.[1] || null;
    records.push({ pid, imageName, listeningPorts: portsByPid.get(pid) || [], executablePath: null, commandLine: null });
  }
  return records;
}

function normalizeWindowsPath(value) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value)) return null;
  return path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
}

function taskkill(pid) {
  const killed = Bun.spawnSync(["taskkill.exe", "/PID", String(pid), "/T", "/F"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  return killed.exitCode === 0
    ? { ok: true }
    : { ok: false, error: killed.stderr.toString().trim() || `taskkill-exit-${killed.exitCode}` };
}

function runtimeEnv(service) {
  const env = { ...process.env };
  if (service.name === "orangellm" && /^http:\/\/(?:127\.0\.0\.1|localhost):11437\/?$/i.test(env.ORANGE5_CODEXA_OLLAMA_URL || "")) {
    delete env.ORANGE5_CODEXA_OLLAMA_URL;
  }
  if (service.name === "ae-phase" && !env.ORANGE5_AE_PHASE_KEY_FILE) {
    try {
      const phaseKey = path.join(STATE, "secrets", "ae-phase-key.txt");
      if (fs.readFileSync(phaseKey, "utf8").trim()) env.ORANGE5_AE_PHASE_KEY_FILE = phaseKey;
    } catch {}
  }
  return env;
}

async function probe(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(2_500) }); return { ok: response.ok, body: await response.json() }; }
  catch (error) { return { ok: false, body: { error: error.message } }; }
}
async function waitFor(predicate, timeout) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return true; await Bun.sleep(200); } return false; }
function readPid(file) { try { const n = Number(fs.readFileSync(file, "utf8").trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; } }
function fail(error) { process.stderr.write(`${JSON.stringify({ schema: "orange5.runtime-services.v1", ok: false, error })}\n`); process.exit(1); }
