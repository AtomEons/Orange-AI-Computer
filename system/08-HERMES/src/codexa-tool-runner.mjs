#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEXA_SEMANTIC_TOOLS } from "./codexa-tool-catalog.mjs";

export const CODEXA_TOOL_RUNNER_SCHEMA = "orange.codexa-tool-report.v1";

const DEFAULT_ENDPOINTS = Object.freeze({
  phase: "http://127.0.0.1:8907/health",
  staff: "http://127.0.0.1:8643/health",
  hermes: "http://127.0.0.1:8642/health",
  rail: "http://127.0.0.1:8097/health",
  ollamaTags: "http://127.0.0.1:11434/api/tags",
  ollamaPs: "http://127.0.0.1:11434/api/ps",
  vulkanHealth: "http://127.0.0.1:11436/health",
  vulkanModels: "http://127.0.0.1:11436/v1/models",
});

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return { raw: String(text || "").slice(0, 2_000) }; }
}

async function probe(url, { fetchImpl, headers = {}, timeoutMs = 3_000 } = {}) {
  const started = performance.now();
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    return {
      ok: response.ok,
      httpStatus: response.status,
      durationMs: Math.round(performance.now() - started),
      body: safeJson(text),
    };
  } catch (error) {
    return { ok: false, durationMs: Math.round(performance.now() - started), error: error?.message || String(error) };
  }
}

function protectedRailHeaders(env) {
  const tokenPath = env.ORANGEBOX_RAIL_TOKEN_FILE
    || path.join(env.USERPROFILE || "C:/Users/Atom", "OrangeBox-Data", "orange5", "secrets", "rail-token.txt");
  try {
    const token = readFileSync(tokenPath, "utf8").trim();
    return token ? { "X-Orangebox-Token": token } : {};
  } catch { return {}; }
}

function summarizeOllama(tags, loaded) {
  const available = (tags?.body?.models || []).map((row) => ({
    name: row.name || row.model,
    size: Number(row.size || 0),
    parameterSize: row.details?.parameter_size || null,
    quantization: row.details?.quantization_level || null,
  })).filter((row) => row.name);
  const resident = (loaded?.body?.models || []).map((row) => ({
    name: row.name || row.model,
    size: Number(row.size || 0),
    sizeVram: Number(row.size_vram || 0),
    expiresAt: row.expires_at || null,
  })).filter((row) => row.name);
  return { live: tags?.ok === true, available, loaded: resident };
}

function summarizeVulkan(health, models) {
  const rows = models?.body?.data || models?.body?.models || [];
  return {
    live: health?.ok === true && health?.body?.status === "ok",
    backend: "llama.cpp-vulkan",
    endpoint: "127.0.0.1:11436",
    models: rows.map((row) => ({
      id: row.id || row.name || row.model,
      parameters: Number(row.meta?.n_params || 0),
      context: Number(row.meta?.n_ctx || 0),
      quantizationType: row.meta?.ftype || null,
    })),
  };
}

async function modelInventory(context) {
  const [tags, loaded, vulkanHealth, vulkanModels] = await Promise.all([
    probe(context.endpoints.ollamaTags, context),
    probe(context.endpoints.ollamaPs, context),
    probe(context.endpoints.vulkanHealth, context),
    probe(context.endpoints.vulkanModels, context),
  ]);
  const ollama = summarizeOllama(tags, loaded);
  const vulkan = summarizeVulkan(vulkanHealth, vulkanModels);
  return { ok: ollama.live || vulkan.live, ollama, vulkan };
}

function gitReport(root, spawn = spawnSync) {
  if (!existsSync(root)) return { root, exists: false, git: false };
  const head = spawn("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 5_000 });
  const status = spawn("git", ["status", "--short"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 5_000 });
  return {
    root,
    exists: true,
    git: head.status === 0,
    head: head.status === 0 ? String(head.stdout || "").trim() : null,
    dirtyEntries: status.status === 0 ? String(status.stdout || "").split(/\r?\n/).filter(Boolean).length : null,
    gitError: head.status === 0 ? null : String(head.stderr || "").trim().slice(0, 500),
  };
}

function memoryFiles(root) {
  if (!existsSync(root)) return { root, exists: false, fileCount: 0 };
  let count = 0;
  const stack = [root];
  while (stack.length && count < 50_000) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else count += 1;
    }
  }
  return { root, exists: true, fileCount: count, bounded: count >= 50_000 };
}

export function verifyCobraMirror(root, { maxAgeMs = 15 * 60_000 } = {}) {
  const manifestPath = path.join(root, "mirror-manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const completedAtMs = Date.parse(manifest.completedAt || "");
    const ageMs = Number.isFinite(completedAtMs) ? Math.max(0, Date.now() - completedAtMs) : null;
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const mismatches = [];
    const rootPrefix = `${path.resolve(root)}${path.sep}`.toLowerCase();
    for (const row of files) {
      const target = path.resolve(root, String(row.relativePath || ""));
      if (!target.toLowerCase().startsWith(rootPrefix) || !existsSync(target)) {
        mismatches.push({ relativePath: row.relativePath, reason: "missing_or_outside_root" });
        continue;
      }
      const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
      if (digest !== row.sha256) mismatches.push({ relativePath: row.relativePath, reason: "sha256_mismatch" });
    }
    const fresh = ageMs != null && ageMs <= maxAgeMs;
    const ok = manifest.schema === "orange5.ae_cobra.codexa_mirror.v1"
      && manifest.status === "VERIFIED"
      && files.length > 0
      && mismatches.length === 0
      && fresh;
    return {
      ok,
      status: ok ? "VERIFIED" : "NEEDS_ATTENTION",
      manifestPath,
      completedAt: manifest.completedAt || null,
      ageMs,
      fresh,
      fileCount: files.length,
      totalBytes: Number(manifest.totalBytes || 0),
      transport: manifest.changed?.[0]?.transport || "ae-phase",
      mismatches,
    };
  } catch (error) {
    return { ok: false, status: "NEEDS_ATTENTION", manifestPath, error: error?.message || String(error) };
  }
}

async function coreProbes(context) {
  const railHeaders = protectedRailHeaders(context.env);
  const entries = await Promise.all(Object.entries({
    phase: [context.endpoints.phase, {}],
    staff: [context.endpoints.staff, {}],
    hermes: [context.endpoints.hermes, {}],
    rail: [context.endpoints.rail, { headers: railHeaders }],
  }).map(async ([name, [url, options]]) => [name, await probe(url, { ...context, ...options })]));
  return Object.fromEntries(entries);
}

function servicePass(name, value) {
  if (!value?.ok) return false;
  if (name === "phase") return value.body?.status === "AE_PHASE_FABRIC_ACTIVE" && value.body?.authenticated === true;
  if (name === "staff") return value.body?.status === "LIVE" && Number(value.body?.roleCount) === 50;
  return true;
}

export async function runCodexaTool(tool, options = {}) {
  const command = String(tool || "").trim();
  if (!CODEXA_SEMANTIC_TOOLS.includes(command)) throw new Error(`Unknown Codexa semantic tool: ${command || "(empty)"}`);
  const context = {
    fetchImpl: options.fetchImpl || fetch,
    env: options.env || process.env,
    endpoints: { ...DEFAULT_ENDPOINTS, ...(options.endpoints || {}) },
    projectRoot: options.projectRoot || "C:/AtomEons/Orange5",
    cobraRoot: options.cobraRoot || "C:/Users/Atom/OrangeBox-Data/orange5/ae-cobra-backup",
    spawn: options.spawn || spawnSync,
    verifyMirror: options.verifyMirror || verifyCobraMirror,
  };
  const base = {
    schema: CODEXA_TOOL_RUNNER_SCHEMA,
    tool: command,
    node: os.hostname(),
    generatedAt: new Date().toISOString(),
  };

  if (command === "hostname") return { ...base, ok: true, status: "VERIFIED", hostname: os.hostname() };
  if (command === "model-inventory") {
    const models = await modelInventory(context);
    return { ...base, ok: models.ok, status: models.ok ? "VERIFIED" : "NEEDS_ATTENTION", ...models };
  }
  if (command === "project-report") {
    const project = gitReport(context.projectRoot, context.spawn);
    return { ...base, ok: project.exists, status: project.exists ? "VERIFIED" : "NEEDS_ATTENTION", project };
  }
  if (command === "reality-watch" || command === "memory-doctor") {
    const mirror = context.verifyMirror(context.cobraRoot);
    const storage = memoryFiles(context.cobraRoot);
    const ok = mirror.ok && storage.exists;
    return { ...base, ok, status: ok ? "VERIFIED" : "NEEDS_ATTENTION", authority: "verified AE Cobra disk mirror", mirror, storage };
  }
  if (command === "mcp-doctor") {
    const [phase, staff, hermes] = await Promise.all([
      probe(context.endpoints.phase, context),
      probe(context.endpoints.staff, context),
      probe(context.endpoints.hermes, context),
    ]);
    const ok = servicePass("phase", phase) && servicePass("staff", staff) && hermes.ok;
    return {
      ...base,
      ok,
      status: ok ? "VERIFIED" : "NEEDS_ATTENTION",
      scope: "CODEXA",
      boundary: "Brain MCP remains on the N150 control node; AE Phase carries governed work to Hermes Agent and AE Staff on CODEXA",
      phase,
      staff,
      hermes,
    };
  }
  if (command === "trilane-doctor" || command === "ipi-doctor") {
    const models = await modelInventory(context);
    const installed = new Set(models.ollama.available.map((row) => row.name));
    const roles = {
      navigator: { model: "orange-navigator:7b-vulkan", live: models.vulkan.live },
      code: { model: context.env.ORANGE5_CODEXA_CODE_MODEL || "qwen3-coder:30b", available: installed.has(context.env.ORANGE5_CODEXA_CODE_MODEL || "qwen3-coder:30b") },
      heavy: { model: context.env.ORANGE5_CODEXA_HEAVY_MODEL || "qwen3.8:27b-current", available: installed.has(context.env.ORANGE5_CODEXA_HEAVY_MODEL || "qwen3.8:27b-current") },
    };
    const ok = roles.navigator.live && (roles.code.available || roles.heavy.available);
    return {
      ...base,
      ok,
      status: ok ? "VERIFIED" : "NEEDS_ATTENTION",
      compatibilityAlias: command,
      activeSystem: "Orange least-action role router",
      roles,
    };
  }

  const [services, models] = await Promise.all([coreProbes(context), modelInventory(context)]);
  const mirror = context.verifyMirror(context.cobraRoot);
  const required = ["phase", "staff", "hermes", "rail"];
  const serviceChecks = Object.fromEntries(required.map((name) => [name, servicePass(name, services[name])]));
  serviceChecks.memoryMirror = mirror.ok;
  const ok = Object.values(serviceChecks).every(Boolean) && models.ok;
  return {
    ...base,
    ok,
    status: ok ? "VERIFIED" : "NEEDS_ATTENTION",
    profile: command,
    serviceChecks,
    services,
    memoryMirror: mirror,
    models,
    machine: {
      cpus: os.cpus().length,
      totalMemoryGb: Number((os.totalmem() / 2 ** 30).toFixed(1)),
      freeMemoryGb: Number((os.freemem() / 2 ** 30).toFixed(1)),
      uptimeSeconds: Math.round(os.uptime()),
    },
  };
}

function cliTool(argv) {
  const index = argv.indexOf("--tool");
  return index >= 0 ? argv[index + 1] : null;
}

if (import.meta.main) {
  try {
    const report = await runCodexaTool(cliTool(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) process.exitCode = 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: CODEXA_TOOL_RUNNER_SCHEMA, ok: false, status: "TERMINAL_REJECTED", error: error?.message || String(error) })}\n`);
    process.exitCode = 1;
  }
}
