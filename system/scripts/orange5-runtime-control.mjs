#!/usr/bin/env bun

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

function resolveOrangeRoot() {
  if (process.env.ORANGE5_ROOT) return resolve(process.env.ORANGE5_ROOT);
  const executable = basename(process.execPath).toLowerCase();
  if (executable !== "bun.exe" && executable !== "bun") {
    return resolve(dirname(process.execPath), "..");
  }
  return resolve(import.meta.dir, "..");
}

const ROOT = resolveOrangeRoot();
const USER_DATA = join(homedir(), "OrangeBox-Data", "orange5");
const RUNTIME_LOG_DIR = join(ROOT, "10-RECEIPTS", "orange5-build", "runtime-logs");
const START_LOG = join(RUNTIME_LOG_DIR, "orange5-runtime-start.log");
const START_RECEIPT = join(RUNTIME_LOG_DIR, "orange5-runtime-start-latest.json");
const RUNTIME_SERVICES = join(ROOT, "scripts", "orange5-runtime-services.mjs");
const BUN_EXE = process.env.ORANGE5_BUN_EXE || join(homedir(), ".bun", "bin", "bun.exe");
const SSH_EXE = process.env.ORANGE5_SSH_EXE || join(process.env.WINDIR || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
const CODEXA_HOST = process.env.ORANGE5_CODEXA_HOST || "10.0.0.4";
const CODEXA_USER = process.env.ORANGE5_CODEXA_USER || "Atom";
const CODEXA_KEY = process.env.ORANGE5_CODEXA_KEY || join(homedir(), ".ssh", "orange_codexa_automation_ed25519");
const KNOWN_HOSTS = join(USER_DATA, "codexa-vulkan-known-hosts");

function now() { return new Date().toISOString(); }
function log(message) { appendFileSync(START_LOG, `[${now()}] ${message}\n`, "utf8"); }
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

async function fetchJson(url, timeoutMs = 4_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function tcpOpen(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((done) => {
    const socket = net.createConnection({ port, host });
    const finish = (open) => { socket.destroy(); done(open); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitFor(check, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return true;
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  return false;
}

function startDetached(name, command, args, cwd, env = process.env) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const stdoutPath = join(RUNTIME_LOG_DIR, `${safeName}.stdout.log`);
  const stderrPath = join(RUNTIME_LOG_DIR, `${safeName}.stderr.log`);
  const stdout = openSync(stdoutPath, "a");
  const stderr = openSync(stderrPath, "a");
  try {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    });
    child.unref();
    log(`Started ${name} pid=${child.pid || "unknown"}`);
    return { ok: true, pid: child.pid || null, stdoutPath, stderrPath };
  } catch (error) {
    log(`Failed to start ${name}: ${error?.message || String(error)}`);
    return { ok: false, error: error?.message || String(error), stdoutPath, stderrPath };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

async function ensureProcessEndpoint({ name, healthUrl, validate = (result) => result.ok, command, args, cwd = ROOT, waitMs = 10_000, env = process.env }) {
  const first = await fetchJson(healthUrl);
  if (validate(first)) {
    log(`${name} adopted healthy endpoint ${healthUrl}`);
    return { ok: true, reused: true, health: first };
  }
  const port = Number(new URL(healthUrl).port);
  if (await tcpOpen(port)) {
    log(`${name} owns port ${port} but failed health; duplicate start refused`);
    return { ok: false, reused: true, reason: "listener_health_failed", health: first };
  }
  const started = startDetached(name, command, args, cwd, env);
  if (!started.ok) return started;
  const ready = await waitFor(async () => validate(await fetchJson(healthUrl, 5_000)), waitMs);
  const health = await fetchJson(healthUrl, 5_000);
  log(`${name} health after start=${ready}`);
  return { ok: ready, reused: false, ...started, health };
}

function sshBaseArgs() {
  return [
    "-i", CODEXA_KEY,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS}`,
  ];
}

function proveRemoteHttp(remotePort, pathName) {
  const command = `curl.exe --silent --fail --max-time 5 http://127.0.0.1:${remotePort}${pathName}`;
  const result = spawnSync(SSH_EXE, [...sshBaseArgs(), `${CODEXA_USER}@${CODEXA_HOST}`, command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  return { ok: result.status === 0, status: result.status, stderr: String(result.stderr || "").trim().slice(-500) };
}

async function ensureTunnel({ name, localPort, remotePort = localPort, pathName, validate }) {
  const healthUrl = `http://127.0.0.1:${localPort}${pathName}`;
  const first = await fetchJson(healthUrl);
  if (validate(first)) {
    log(`${name} adopted healthy loopback tunnel ${localPort}->${remotePort}`);
    return { ok: true, reused: true, endpoint: healthUrl };
  }
  if (await tcpOpen(localPort)) {
    log(`${name} found nonhealthy listener on ${localPort}; replacement refused`);
    return { ok: false, reused: true, reason: "local_port_owned" };
  }
  const remote = proveRemoteHttp(remotePort, pathName);
  if (!remote.ok) {
    log(`${name} remote proof failed: ${remote.stderr || `exit ${remote.status}`}`);
    return { ok: false, reused: false, reason: "remote_health_failed", remote };
  }
  const args = [
    "-N", ...sshBaseArgs(),
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    `${CODEXA_USER}@${CODEXA_HOST}`,
  ];
  const started = startDetached(name, SSH_EXE, args, ROOT);
  if (!started.ok) return started;
  const ready = await waitFor(async () => validate(await fetchJson(healthUrl)), 20_000);
  log(`${name} tunnel health after start=${ready}`);
  return { ok: ready, reused: false, endpoint: healthUrl, ...started };
}

function runBunJson(args, timeoutMs = 20_000) {
  const result = spawnSync(BUN_EXE, args, { cwd: ROOT, env: process.env, encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  let json = null;
  try { json = JSON.parse(String(result.stdout || "").trim()); } catch {}
  return { ok: result.status === 0, code: result.status, json, stdout: String(result.stdout || "").trim(), stderr: String(result.stderr || "").trim().slice(-1_000) };
}

async function ensureOwnedRuntimeServices(definitions) {
  const before = await Promise.all(definitions.map(async (definition) => ({
    serviceName: definition.serviceName,
    ready: definition.validate(await fetchJson(definition.healthUrl)),
  })));
  const readyBefore = new Map(before.map((item) => [item.serviceName, item.ready]));
  const control = runBunJson([RUNTIME_SERVICES, "start"], 180_000);
  const reports = new Map((control.json?.services || []).map((item) => [item.name, item]));
  const results = {};
  for (const definition of definitions) {
    const service = reports.get(definition.serviceName) || null;
    const health = await fetchJson(definition.healthUrl, 8_000);
    const healthValid = definition.validate(health);
    const ok = control.ok && service?.ok === true && healthValid;
    const reason = service?.blocker
      || (!control.ok ? control.stderr || `runtime-services-exit-${control.code ?? "unknown"}` : null)
      || (!healthValid ? "health-validation-failed" : null);
    results[definition.serviceName] = {
      ok,
      reused: readyBefore.get(definition.serviceName) === true,
      pid: service?.pid || null,
      reason,
      matchingPids: service?.matchingPids || null,
      health,
    };
    log(`${definition.name} owned-service batch ok=${ok} pid=${service?.pid || "unknown"} reused=${readyBefore.get(definition.serviceName) === true}`);
  }
  return results;
}

async function ensureMirror() {
  const statusPath = join(USER_DATA, "ae-cobra-mirror-daemon-status.json");
  let status = null;
  try { status = JSON.parse(readFileSync(statusPath, "utf8").replace(/^\uFEFF/, "")); } catch {}
  const pid = Number(status?.pid || 0);
  let alive = false;
  if (pid > 0) {
    try { process.kill(pid, 0); alive = true; } catch {}
  }
  if (alive && status?.state !== "degraded" && status?.state !== "blocked") {
    log(`AE Cobra mirror adopted pid=${pid} state=${status?.state || "unknown"}`);
    return { ok: true, reused: true, state: status?.state || "running", pid };
  }
  const entry = join(ROOT, "06-ORANGELLM", "memory", "ae-cobra", "mirror-daemon.mjs");
  const started = startDetached("AE Cobra mirror", BUN_EXE, [entry], dirname(entry));
  if (!started.ok) return started;
  const ready = await waitFor(() => {
    try {
      const next = JSON.parse(readFileSync(statusPath, "utf8").replace(/^\uFEFF/, ""));
      return next.state === "healthy" && Number(next.pid) === Number(started.pid);
    } catch { return false; }
  }, 20_000);
  return { ok: ready, reused: false, state: ready ? "healthy" : "starting", pid: started.pid };
}

function applyRuntimeEnvironment() {
  const railTokenPath = process.env.ORANGEBOX_RAIL_TOKEN_FILE
    || join(USER_DATA, "secrets", "rail-token.txt");
  try {
    const canonicalRailToken = readFileSync(railTokenPath, "utf8").trim();
    if (canonicalRailToken) process.env.ORANGEBOX_RAIL_TOKEN = canonicalRailToken;
  } catch {}
  process.env.ORANGE5_VISUAL_ENABLED = "1";
  // Runtime authority owns the release model. The older generic environment
  // variable may be stale from OrangeFive's 4B development phase.
  process.env.ORANGE5_NAVIGATOR_MODEL = process.env.ORANGE5_RUNTIME_NAVIGATOR_MODEL
    || "orange-navigator:ornith-1.5-9b-q4km";
  process.env.ORANGE5_CROSS_NODE_TRANSPORT ||= "ae-phase";
  process.env.ORANGE5_AE_PHASE_URL ||= "http://127.0.0.1:8907";
  process.env.ORANGE5_NAVIGATOR_TRANSPORT = "ollama";
  process.env.ORANGE5_NAVIGATOR_KEEP_ALIVE ||= "15m";
  process.env.ORANGE5_CORTEX_MODEL ||= "gemma4:e2b";
  process.env.ORANGE5_CORTEX_FALLBACK_MODEL ||= "llava:7b";
  process.env.ORANGE5_CORTEX_FALLBACK_URL ||= "http://127.0.0.1:11434";
  process.env.QDRANT_URL ||= "http://127.0.0.1:6333";
  process.env.OLLAMA_URL ||= "http://127.0.0.1:11434";
  process.env.AE_FLUX_ROOT ||= join(USER_DATA, "ae-cobra-flux");
  process.env.ORANGE5_PRELOAD_NAVIGATOR = "0";
  delete process.env.ORANGE5_NAVIGATOR_URL;
}

function serviceSummary(service) {
  return {
    ok: service?.ok === true,
    reused: service?.reused === true,
    pid: service?.pid || null,
    state: service?.state || null,
    reason: service?.reason || null,
    http_status: service?.health?.status || null,
    error: service?.error || null,
  };
}

function sameModel(name, model) {
  const clean = (value) => String(value || "").replace(/:latest$/, "");
  return clean(name) === clean(model);
}

function modelAvailable(payload, model) {
  return Array.isArray(payload?.models)
    && payload.models.some((row) => sameModel(row?.name || row?.model, model));
}

export async function ensureRuntime() {
  mkdirSync(RUNTIME_LOG_DIR, { recursive: true });
  mkdirSync(dirname(KNOWN_HOSTS), { recursive: true });
  applyRuntimeEnvironment();
  log("OrangeFive Bun-native runtime ensure started; PowerShell runtime path disabled.");

  const ollamaPath = join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe");
  const localOllama = existsSync(ollamaPath)
    ? await ensureProcessEndpoint({ name: "Local Ollama", healthUrl: "http://127.0.0.1:11434/api/tags", command: ollamaPath, args: ["serve"], cwd: dirname(ollamaPath) })
    : { ok: false, reused: false, reason: "not_installed" };

  const codexaOllama = await ensureTunnel({
    name: "Codexa Ollama", localPort: 11437, remotePort: 11434, pathName: "/api/tags",
    validate: (result) => result.ok && Array.isArray(result.body?.models),
  });
  const codexaDirectUrl = `http://${CODEXA_HOST}:11434`;
  if (codexaOllama.ok) {
    process.env.ORANGE5_CODEXA_OLLAMA_URL = "http://127.0.0.1:11437";
    process.env.ORANGE5_CORTEX_OLLAMA_URL ||= process.env.ORANGE5_CODEXA_OLLAMA_URL;
  }
  let navigatorInventoryEndpoint = codexaOllama.ok ? "http://127.0.0.1:11437" : codexaDirectUrl;
  let navigatorInventory = await fetchJson(`${navigatorInventoryEndpoint}/api/tags`, 8_000);
  if (!navigatorInventory.ok && navigatorInventoryEndpoint !== codexaDirectUrl) {
    navigatorInventoryEndpoint = codexaDirectUrl;
    navigatorInventory = await fetchJson(`${navigatorInventoryEndpoint}/api/tags`, 8_000);
  }
  const navigatorAvailable = navigatorInventory.ok
    && modelAvailable(navigatorInventory.body, process.env.ORANGE5_NAVIGATOR_MODEL);
  log(`Navigator lease target available=${navigatorAvailable} model=${process.env.ORANGE5_NAVIGATOR_MODEL} inventory=${navigatorInventoryEndpoint}`);

  const qdrantTunnel = await ensureTunnel({
    name: "Codexa Qdrant", localPort: 6333, pathName: "/",
    validate: (result) => result.ok && Boolean(result.body?.title || result.body?.version),
  });
  let qdrantVision = false;
  if (qdrantTunnel.ok) {
    const init = runBunJson([join(ROOT, "07-VISUAL", "qdrant", "init-collection.mjs")]);
    qdrantVision = init.ok && (await fetchJson("http://127.0.0.1:6333/collections/orange5-vision", 8_000)).ok;
    log(`Qdrant orange5-vision collection ready=${qdrantVision}`);
  }

  const eyesTunnel = await ensureTunnel({
    name: "AE Eyes", localPort: 7440, pathName: "/health",
    validate: (result) => result.ok && result.body?.ok === true && result.body?.service === "colpali-ingest",
  });

  const services = {};
  const ownedServices = await ensureOwnedRuntimeServices([
    { name: "AE Cobra memory", serviceName: "memory", healthUrl: "http://127.0.0.1:7419/healthz", validate: (result) => result.ok },
    { name: "Hermes governed agents", serviceName: "hermes", healthUrl: "http://127.0.0.1:7430/healthz", validate: (result) => result.ok },
    { name: "Codexa link sentinel", serviceName: "link-sentinel", healthUrl: "http://127.0.0.1:7432/health", validate: (result) => result.ok && result.body?.ok === true },
    { name: "AE Phase Fabric", serviceName: "ae-phase", healthUrl: "http://127.0.0.1:8907/health", validate: (result) => result.ok && result.body?.status === "AE_PHASE_FABRIC_ACTIVE" },
    {
      name: "OrangeBrain gateway", serviceName: "orangellm", healthUrl: "http://127.0.0.1:1337/healthz",
      validate: (result) => result.ok
        && result.body?.service === "orangellm-gateway"
        && result.body?.status === "ok"
        && result.body?.upstream?.navigator?.live === true
        && sameModel(result.body?.upstream?.navigator?.model, process.env.ORANGE5_NAVIGATOR_MODEL)
        && result.body?.upstream?.navigator?.preferred_route === "ae-phase"
        && result.body?.fabric?.crossNodeTransport === "ae-phase",
    },
    { name: "Brain MCP HTTP", serviceName: "brain-mcp", healthUrl: "http://127.0.0.1:7431/health", validate: (result) => result.ok },
  ]);
  services.cobra = ownedServices.memory;
  services.hermes = ownedServices.hermes;
  services.linkSentinel = ownedServices["link-sentinel"];
  services.aePhase = ownedServices["ae-phase"];
  services.gateway = ownedServices.orangellm;
  services.mcpHttp = ownedServices["brain-mcp"];
  const atomSmasherRoot = join(homedir(), "OrangeBox-Data", "atomsmasher2-final-local");
  services.atomsmasher = await ensureProcessEndpoint({
    name: "AtomSmasher 2", healthUrl: "http://127.0.0.1:8901/health", command: BUN_EXE,
    args: [join(atomSmasherRoot, "start-daemon.mjs")], cwd: atomSmasherRoot, waitMs: 12_000,
  });
  services.mirror = await ensureMirror();

  const fabric = runBunJson([join(ROOT, "03-BACKEND", "compute-fabric-cli.mjs"), "discover", "--no-neighbors", "--timeout-ms", "2500"], 15_000);
  const fabricState = fabric.json || {};
  const navigatorKernel = existsSync(join(ROOT, "03-BACKEND", "navigator-kernel.mjs"));
  const inferenceReady = localOllama.ok || codexaOllama.ok;
  const checks = {
    inference_ready: inferenceReady,
    qdrant_vision_ready: qdrantVision,
    navigator_kernel_ready: navigatorKernel,
    navigator_model_available: navigatorAvailable,
    orangebrain_gateway_ready: services.gateway.ok,
    ae_cobra_ready: services.cobra.ok,
    hermes_ready: services.hermes.ok,
    link_sentinel_ready: services.linkSentinel.ok,
    ae_phase_fabric_ready: services.aePhase.ok,
    atomsmasher_ready: services.atomsmasher.ok,
    brain_mcp_http_ready: services.mcpHttp.ok,
    ae_eyes_ready: eyesTunnel.ok,
    cobra_mirror_ready: services.mirror.ok,
    codexa_fabric_ready: fabricState.operational === true,
  };
  const status = Object.values(checks).every(Boolean) ? "ORANGE5_RUNTIME_GREEN" : "ORANGE5_RUNTIME_NEEDS_ATTENTION";
  const receipt = {
    schema: "orange.receipt.runtime_start.v4",
    status,
    timestamp_utc: now(),
    host: process.env.COMPUTERNAME || null,
    runtime_engine: "bun-native-control",
    popup_surface: "none",
    powershell_runtime: false,
    navigator_residency_policy: "leased_on_demand",
    navigator: {
      model: process.env.ORANGE5_NAVIGATOR_MODEL,
      transport: process.env.ORANGE5_NAVIGATOR_TRANSPORT,
      keep_alive: process.env.ORANGE5_NAVIGATOR_KEEP_ALIVE,
      preload: false,
      available: navigatorAvailable,
      inventory_endpoint: navigatorInventoryEndpoint,
      inventory_status: navigatorInventory.status || null,
      inventory_error: navigatorInventory.error || null,
    },
    checks,
    local_ollama: serviceSummary(localOllama),
    codexa_ollama_tunnel: codexaOllama,
    qdrant_tunnel: qdrantTunnel,
    ae_eyes_tunnel: eyesTunnel,
    services: Object.fromEntries(Object.entries(services).map(([name, service]) => [name, serviceSummary(service)])),
    compute_fabric: {
      status: fabricState.status || null,
      mode: fabricState.mode || null,
      operational: fabricState.operational === true,
      sha256: fabricState.sha256 || null,
    },
    endpoints: {
      local_ollama: "http://127.0.0.1:11434/api/tags",
      codexa_ollama: "http://127.0.0.1:11437/api/tags",
      qdrant_vision: "http://127.0.0.1:6333/collections/orange5-vision",
      orangebrain_gateway: "http://127.0.0.1:1337/healthz",
      ae_cobra: "http://127.0.0.1:7419/healthz",
      hermes: "http://127.0.0.1:7430/healthz",
      link_sentinel: "http://127.0.0.1:7432/health",
      ae_phase_fabric: "http://127.0.0.1:8907/health",
      atomsmasher: "http://127.0.0.1:8901/health",
      brain_mcp_http: "http://127.0.0.1:7431/health",
      ae_eyes: "http://127.0.0.1:7440/health",
    },
    log: START_LOG,
  };
  writeFileSync(START_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  log(`Bun-native runtime receipt written status=${status}`);
  return receipt;
}

if (import.meta.main) {
  const receipt = await ensureRuntime();
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exitCode = receipt.status === "ORANGE5_RUNTIME_GREEN" ? 0 : 1;
}
