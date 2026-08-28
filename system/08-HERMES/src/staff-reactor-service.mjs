#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StaffContinuum } from "./staff-continuum.mjs";
import { StaffReactor, loadStaffRoster } from "./staff-reactor.mjs";
import {
  readAEPhaseEnvelopes,
  sendLocalAEPhaseEnvelope,
} from "../../03-BACKEND/ae-phase-fabric.mjs";
import {
  CODEXA_SEMANTIC_TOOLS,
  assessCodexaToolReceipt,
  renderCodexaToolCommand,
  resolveCodexaToolInvocation,
} from "./codexa-tool-catalog.mjs";
import { CODEXA_TOOL_RUNNER_SCHEMA, verifyCobraMirror } from "./codexa-tool-runner.mjs";

const HOST = process.env.AE_STAFF_HOST || process.env.AE_STARTUP_HOST || "127.0.0.1";
const PORT = Number(process.env.AE_STAFF_PORT || process.env.AE_STARTUP_PORT || 8643);
const HERMES_HOME = resolve(process.env.HERMES_HOME || "C:/AtomEons/ai-box/hermes-product/data/.hermes");
const HERMES_API = process.env.HERMES_API_URL || "http://127.0.0.1:8642";
const ROSTER_PATH = resolve(process.env.AE_STAFF_ROSTER || process.env.AE_STARTUP_ROSTER || fileURLToPath(new URL("../product-integration/config/staff-roster.json", import.meta.url)));
const STAFF_STATE = resolve(process.env.AE_STAFF_STATE || `${HERMES_HOME}/ae-staff`);
const EVENT_LOG = resolve(process.env.AE_STAFF_EVENT_LOG || process.env.AE_STARTUP_EVENT_LOG || `${STAFF_STATE}/events.jsonl`);
const RECEIPT_DIR = resolve(process.env.AE_STAFF_RECEIPT_DIR || `${STAFF_STATE}/receipts`);
const INFERENCE_LIMIT = Number(process.env.AE_STAFF_INFERENCE_LIMIT || process.env.AE_STARTUP_INFERENCE_LIMIT || 8);
const TOOL_LIMIT = Number(process.env.AE_STAFF_TOOL_LIMIT || process.env.AE_STARTUP_TOOL_LIMIT || 32);
const PHASE_PROCESSED = resolve(process.env.AE_STAFF_PHASE_PROCESSED || `${STAFF_STATE}/ae-phase-processed.jsonl`);
const PHASE_POLL_MS = Math.max(10, Number(process.env.AE_STAFF_PHASE_POLL_MS || 25));
const PHASE_ARTIFACT_ROOT = resolve(process.env.AE_PHASE_ARTIFACT_ROOT || "C:/Users/Atom/OrangeBox-Data/orange5/ae-cobra-backup");
const PHASE_ARTIFACT_CHUNK_MAX = Math.max(1024, Number(process.env.AE_PHASE_ARTIFACT_CHUNK_MAX || 24 * 1024));
const PHASE_MODEL_URL = String(process.env.AE_PHASE_MODEL_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const PHASE_NAVIGATOR_URL = String(process.env.AE_PHASE_NAVIGATOR_URL || "http://127.0.0.1:11436").replace(/\/$/, "");
const PHASE_NAVIGATOR_ALIAS = String(process.env.AE_PHASE_NAVIGATOR_MODEL || "orange-navigator:7b-vulkan").trim();
const PHASE_MODEL_BATCH_CHUNKS = Math.max(1, Math.min(32, Number(process.env.AE_PHASE_MODEL_BATCH_CHUNKS || 6)));
const PHASE_MODEL_BATCH_BYTES = Math.max(4096, Math.min(48 * 1024, Number(process.env.AE_PHASE_MODEL_BATCH_BYTES || 16 * 1024)));
const PHASE_MODEL_TIMEOUT_MAX_MS = Math.max(30_000, Number(process.env.AE_PHASE_MODEL_TIMEOUT_MAX_MS || 900_000));
const PHASE_COBRA_URL = String(process.env.AE_PHASE_COBRA_URL || "http://127.0.0.1:9100").replace(/\/$/, "");
const PHASE_COBRA_TIMEOUT_MS = Math.max(1_000, Number(process.env.AE_PHASE_COBRA_TIMEOUT_MS || 30_000));
const PHASE_RAIL_URL = String(process.env.AE_PHASE_RAIL_URL || 'http://127.0.0.1:8097').replace(/\/$/, '');
const PHASE_RAIL_TOKEN_PATH = resolve(process.env.ORANGEBOX_RAIL_TOKEN_FILE || `${process.env.USERPROFILE || 'C:/Users/Atom'}/OrangeBox-Data/orange5/secrets/rail-token.txt`);
const PHASE_TOOL_TIMEOUT_MAX_MS = Math.max(30_000, Number(process.env.AE_PHASE_TOOL_TIMEOUT_MAX_MS || 300_000));
const PHASE_TOOL_ALLOWLIST = new Set(CODEXA_SEMANTIC_TOOLS);
const PHASE_TOOL_RUNNER = fileURLToPath(new URL('./codexa-tool-runner.mjs', import.meta.url));

function phaseRailToken() {
  try {
    const protectedToken = readFileSync(PHASE_RAIL_TOKEN_PATH, 'utf8').trim();
    if (protectedToken) return protectedToken;
  } catch {}
  return String(
    process.env.ORANGEBOX_AI_BOX_COMMAND_TOKEN
    || process.env.ORANGEBOX_CODEXA_COMMAND_TOKEN
    || process.env.ORANGEBOX_RAIL_TOKEN
    || '',
  ).trim();
}

function readEnv(path) {
  const values = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  } catch { /* surfaced as missing key by the caller */ }
  return values;
}

const ownerKey = process.env.AE_STAFF_API_KEY || process.env.AE_STARTUP_API_KEY || readEnv(resolve(STAFF_STATE, ".env")).AE_STAFF_API_KEY || "";

function profileKey(profile) {
  return readEnv(resolve(HERMES_HOME, "profiles", profile, ".env")).API_SERVER_KEY || "";
}

const pendingProfileBatches = new Map();
const profileBatchMetrics = { hermesCalls: 0, roleAssignments: 0, fusedCalls: 0 };
const continuum = new StaffContinuum({ root: resolve(STAFF_STATE, "continuum") });

async function dispatch(input) {
  const { role, event, relevance } = input;
  if (!event.requiresModel) {
    return {
      schema: "orange.report.v1",
      orderId: event.id,
      status: "completed",
      confidence: 1,
      actionsTaken: ["accepted and reconciled structured order through AE Phase"],
      roleId: role.id,
      evidence: [
        `ae-phase-envelope:${event.transportEvidence?.requestEnvelopeId || "received"}`,
        `ae-phase-body-sha256:${event.transportEvidence?.requestBodyHash || "recorded"}`,
        `ae-staff-role:${role.id}`,
        `project:${event.projectId || "Orange5"}`,
      ],
      blockers: [],
      nextAction: "return governed report to Navigator",
      receiptPath: EVENT_LOG,
      relevance,
    };
  }
  return await new Promise((resolveItem, rejectItem) => {
    const batchId = `${event.id}:${role.archetype}`;
    const batch = pendingProfileBatches.get(batchId) || { items: [], scheduled: false };
    batch.items.push({ ...input, resolveItem, rejectItem });
    pendingProfileBatches.set(batchId, batch);
    if (!batch.scheduled) {
      batch.scheduled = true;
      queueMicrotask(() => flushProfileBatch(batchId));
    }
  });
}

async function flushProfileBatch(batchId) {
  const batch = pendingProfileBatches.get(batchId);
  pendingProfileBatches.delete(batchId);
  if (!batch?.items?.length) return;
  try {
    const reports = await invokeProfileBatch(batch.items);
    for (const item of batch.items) item.resolveItem(reports.get(item.role.id));
  } catch (error) {
    for (const item of batch.items) item.rejectItem(error);
  }
}

async function invokeProfileBatch(items) {
  const executionProfile = items[0].role.archetype;
  if (!items.every((item) => item.role.archetype === executionProfile)) throw new Error("AE Staff profile fusion crossed an execution-profile boundary");
  const key = profileKey(executionProfile);
  if (!key) throw new Error(`Hermes execution profile key unavailable for ${executionProfile}`);
  profileBatchMetrics.hermesCalls += 1;
  profileBatchMetrics.roleAssignments += items.length;
  if (items.length > 1) profileBatchMetrics.fusedCalls += 1;
  const projectContext = continuum.viewForProfile(items[0].projectNow.projectCrystal, executionProfile);
  const response = await fetch(`${HERMES_API}/p/${encodeURIComponent(executionProfile)}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "orange5-governor",
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            `You are the ${executionProfile} execution body for AE Staff - Powered by Hermes.`,
            `Complete ${items.length} distinct staff assignments without merging their identities or evidence.`,
            "Do assigned work. Do not manage people, invent completion, or return generic advice.",
            "Return only JSON shaped as {\"reports\":[{\"roleId\":string,\"orderId\":string,\"status\":\"completed|blocked|needs_attention\",\"confidence\":number,\"actionsTaken\":[],\"evidence\":[],\"blockers\":[],\"nextAction\":string,\"receiptPath\":string}]}",
          ].join("\n"),
        },
        { role: "user", content: JSON.stringify({
          projectNow: {
            projectId: items[0].projectNow.projectId,
            correlationId: items[0].projectNow.correlationId,
            context: projectContext,
          },
          event: items[0].event,
          assignments: items.map(({ role, relevance }) => ({
            roleId: role.id,
            orderId: items[0].event.roleOrders?.[role.id]?.orderId || `${items[0].event.id}:${role.id}`,
            title: role.title,
            purpose: role.purpose,
            concreteOutputs: role.concreteOutputs,
            completionContract: role.completionContract,
            forbiddenActions: role.forbiddenActions,
            relevance,
          })),
        }) },
      ],
    }),
    signal: AbortSignal.timeout(Number(process.env.AE_STAFF_INFERENCE_TIMEOUT_MS || process.env.AE_STARTUP_INFERENCE_TIMEOUT_MS || 180_000)),
  });
  if (!response.ok) throw new Error(`Hermes execution profile ${executionProfile} returned HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const decoded = decodeJson(content);
  const rawReports = Array.isArray(decoded?.reports) ? decoded.reports : (items.length === 1 ? [decoded] : []);
  if (rawReports.length !== items.length) throw new Error(`Hermes profile fusion returned ${rawReports.length} reports for ${items.length} assignments`);
  const results = new Map();
  for (const item of items) {
    const raw = rawReports.find((report) => report?.roleId === item.role.id);
    if (!raw) throw new Error(`Hermes profile fusion omitted AE Staff role ${item.role.id}`);
    const report = parseReport(raw, item.event.roleOrders?.[item.role.id]?.orderId || `${item.event.id}:${item.role.id}`);
    const receipt = writeStaffReceipt({ role: item.role, executionProfile, event: item.event, report, relevance: item.relevance, content: JSON.stringify(raw) });
    results.set(item.role.id, { ...report, roleId: item.role.id, executionProfile, relevance: item.relevance, receiptPath: receipt.path, receiptSha256: receipt.sha256 });
  }
  return results;
}

function parseReport(content, orderId) {
  const candidate = decodeJson(content);
  if (!candidate || typeof candidate !== "object") throw new Error("Hermes worker returned no report object");
  const status = String(candidate.status || "").toLowerCase();
  if (!['completed', 'blocked', 'needs_attention'].includes(status)) throw new Error(`Invalid orange.report.v1 status: ${status || "missing"}`);
  const confidence = Number(candidate.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Invalid orange.report.v1 confidence");
  for (const field of ["actionsTaken", "evidence", "blockers"]) {
    if (!Array.isArray(candidate[field])) throw new Error(`orange.report.v1 ${field} must be an array`);
  }
  if (status === "completed" && candidate.evidence.length === 0) throw new Error("Completed AE Staff report has no evidence");
  return {
    schema: "orange.report.v1",
    orderId: candidate.orderId || orderId,
    status,
    confidence,
    actionsTaken: candidate.actionsTaken.map(String),
    evidence: candidate.evidence,
    blockers: candidate.blockers.map(String),
    nextAction: String(candidate.nextAction || "return to Navigator"),
    receiptPath: String(candidate.receiptPath || "pending:ae-staff-runtime-receipt"),
  };
}

function decodeJson(content) {
  if (typeof content !== "string") return content;
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(trimmed); }
  catch { throw new Error("Hermes worker returned non-JSON output"); }
}

function writeStaffReceipt({ role, executionProfile, event, report, relevance, content }) {
  mkdirSync(RECEIPT_DIR, { recursive: true });
  const receipt = {
    schema: "orange.ae-staff-receipt.v1",
    receiptId: `ae-staff-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    roleId: role.id,
    roleTitle: role.title,
    executionProfile,
    eventId: event.id,
    projectId: event.projectId,
    correlationId: event.correlationId,
    relevance,
    report,
    outputSha256: createHash("sha256").update(String(content || "")).digest("hex"),
  };
  const sha256 = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  const path = resolve(RECEIPT_DIR, `${receipt.createdAt.replace(/[:.]/g, "-")}-${role.id}.json`);
  writeFileSync(path, `${JSON.stringify({ ...receipt, sha256 }, null, 2)}\n`, "utf8");
  return { path, sha256 };
}

const reactor = new StaffReactor({
  roster: loadStaffRoster(ROSTER_PATH),
  inferenceLimit: INFERENCE_LIMIT,
  toolLimit: TOOL_LIMIT,
  eventLogPath: EVENT_LOG,
  dispatch,
});
reactor.start();

const processedPhaseEnvelopes = new Set();
try {
  for (const line of readFileSync(PHASE_PROCESSED, "utf8").split(/\r?\n/).filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.requestEnvelopeId) processedPhaseEnvelopes.add(row.requestEnvelopeId);
  }
} catch {}
let phaseBusy = false;
let phaseOrdersHandled = 0;
let phaseQueriesHandled = 0;
let phaseArtifactChunksHandled = 0;
let phaseModelRequestsHandled = 0;
let phaseModelQueriesHandled = 0;
let phaseCobraRequestsHandled = 0;
let phaseToolRequestsHandled = 0;
let phaseRejectedEnvelopes = 0;
let lastPhaseOrderAt = null;
let lastPhaseError = null;
const artifactTransfers = new Map();
const inFlightPhaseEnvelopes = new Set();
const phaseModelQueue = [];
let phaseModelActive = false;

function recordPhaseCustody({ envelope, response, status }) {
  mkdirSync(dirname(PHASE_PROCESSED), { recursive: true });
  appendFileSync(PHASE_PROCESSED, `${JSON.stringify({
    schema: "orange.ae-staff-phase-custody.v1",
    requestEnvelopeId: envelope.id,
    requestBodyHash: envelope.bodyHash,
    responseEnvelopeId: response.id,
    responseBodyHash: response.bodyHash,
    status,
    at: new Date().toISOString(),
  })}\n`, "utf8");
  processedPhaseEnvelopes.add(envelope.id);
}

async function handlePhaseOrder(envelope) {
  const input = envelope.body?.event || envelope.body;
  if (!input || typeof input !== "object") throw new Error("AE Staff Phase order has no event body");
  input.transportEvidence = {
    schema: "orange.ae-phase.transport-evidence.v1",
    requestEnvelopeId: envelope.id,
    requestBodyHash: envelope.bodyHash,
    sender: envelope.sender,
    receivedAt: envelope.receivedAt,
  };
  input.projectCrystal = continuum.observe(input);
  let outcome;
  try {
    const published = await reactor.publish(input);
    outcome = {
      ok: published.results.every((item) => item?.ok === true),
      event: published.event,
      observedCount: published.observedCount,
      addressed: published.addressed,
      candidates: published.candidates,
      results: published.results,
      snapshot: {
        status: published.snapshot.status,
        roleCount: published.snapshot.roleCount,
        readyCount: published.snapshot.readyCount,
        runningCount: published.snapshot.runningCount,
        queuedCount: published.snapshot.queuedCount,
      },
    };
  } catch (error) {
    outcome = { ok: false, error: error?.message || String(error), observedCount: 50, addressed: [], results: [] };
  }
  const response = await sendLocalAEPhaseEnvelope({
    id: `ae-staff-report-${randomUUID()}`,
    kind: "ae_staff_report",
    correlationId: envelope.id,
    body: outcome,
  }, { destinationSender: envelope.sender });
  recordPhaseCustody({ envelope, response, status: outcome.ok ? "TERMINAL_COMPLETED" : "TERMINAL_ATTENTION" });
  phaseOrdersHandled += 1;
  lastPhaseOrderAt = new Date().toISOString();
  lastPhaseError = outcome.ok ? null : outcome.error || "one or more staff reports need attention";
}

async function handlePhaseQuery(envelope) {
  const operation = String(envelope.body?.operation || "health").toLowerCase();
  if (!['health', 'list'].includes(operation)) throw new Error(`Unsupported AE Staff Phase query: ${operation}`);
  const snapshot = reactor.snapshot();
  const compactRoles = snapshot.roles.map((role) => ({
    id: role.id,
    title: role.title,
    studio: role.studio,
    archetype: role.archetype,
    purpose: role.purpose,
    state: role.state,
    queued: role.queued,
    canLead: role.canLead,
    modelTier: role.modelTier,
    lastEventId: role.lastEventId || null,
  }));
  const body = operation === "list"
    ? { ok: snapshot.status === "LIVE" && snapshot.roleCount === 50, operation, ...snapshot, roles: compactRoles }
    : {
        ok: snapshot.status === "LIVE" && snapshot.roleCount === 50,
        operation,
        transport: { primary: "ae-phase", recovery: "loopback-http", phaseOrdersHandled, phaseQueriesHandled: phaseQueriesHandled + 1 },
        profileFusion: { enabled: true, ...profileBatchMetrics },
        continuum: continuum.status(),
        ...snapshot,
        roles: undefined,
      };
  const response = await sendLocalAEPhaseEnvelope({
    id: `ae-staff-query-report-${randomUUID()}`,
    kind: "ae_staff_query_report",
    correlationId: envelope.id,
    body,
  }, { destinationSender: envelope.sender });
  recordPhaseCustody({ envelope, response, status: "TERMINAL_COMPLETED" });
  phaseQueriesHandled += 1;
}

function phaseArtifactTarget(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("AE Phase artifact relativePath is invalid");
  }
  const target = resolve(PHASE_ARTIFACT_ROOT, ...normalized.split("/"));
  const rootPrefix = PHASE_ARTIFACT_ROOT.endsWith(sep) ? PHASE_ARTIFACT_ROOT : `${PHASE_ARTIFACT_ROOT}${sep}`;
  if (target !== PHASE_ARTIFACT_ROOT && !target.startsWith(rootPrefix)) throw new Error("AE Phase artifact path escaped its governed root");
  return target;
}

async function handlePhaseArtifactChunk(envelope) {
  const body = envelope.body || {};
  const transferId = String(body.transferId || "");
  const mode = body.mode === "append" ? "append" : "replace";
  const index = Number(body.index);
  const count = Number(body.count);
  const fileBytes = Number(body.fileBytes);
  const baseBytes = Number(body.baseBytes || 0);
  const baseSha256 = String(body.baseSha256 || "").toLowerCase();
  const expectedFileHash = String(body.fileSha256 || "").toLowerCase();
  if (!transferId || !Number.isInteger(index) || !Number.isInteger(count) || index < 0 || count < 1 || index >= count) {
    throw new Error("AE Phase artifact chunk metadata is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedFileHash)) throw new Error("AE Phase artifact file hash is invalid");
  const bytes = Buffer.from(String(body.dataBase64 || ""), "base64");
  if (bytes.length > PHASE_ARTIFACT_CHUNK_MAX) throw new Error(`AE Phase artifact chunk exceeds ${PHASE_ARTIFACT_CHUNK_MAX} bytes`);
  const chunkHash = createHash("sha256").update(bytes).digest("hex");
  if (chunkHash !== String(body.chunkSha256 || "").toLowerCase()) throw new Error("AE Phase artifact chunk hash mismatch");

  const target = phaseArtifactTarget(body.relativePath);
  const temp = `${target}.${transferId}.phase-part`;
  let state = artifactTransfers.get(transferId);
  if (index === 0) {
    mkdirSync(dirname(target), { recursive: true });
    rmSync(temp, { force: true });
    let initialBytes = Buffer.alloc(0);
    if (mode === "append") {
      if (!Number.isInteger(baseBytes) || baseBytes < 0 || !/^[a-f0-9]{64}$/.test(baseSha256)) {
        throw new Error("AE Phase append base metadata is invalid");
      }
      try { initialBytes = readFileSync(target); }
      catch { throw new Error(`AE Phase append target is missing for ${body.relativePath}`); }
      if (initialBytes.length !== baseBytes || createHash("sha256").update(initialBytes).digest("hex") !== baseSha256) {
        throw new Error(`AE Phase append base mismatch for ${body.relativePath}`);
      }
      writeFileSync(temp, initialBytes);
    }
    state = {
      target,
      temp,
      mode,
      relativePath: body.relativePath,
      count,
      expectedIndex: 0,
      bytes: initialBytes.length,
      transferredBytes: 0,
      hash: createHash("sha256").update(initialBytes),
    };
    artifactTransfers.set(transferId, state);
  }
  if (!state || state.target !== target || state.mode !== mode || state.count !== count || state.expectedIndex !== index) {
    throw new Error(`AE Phase artifact chunk order mismatch for ${transferId}`);
  }
  appendFileSync(temp, bytes);
  state.hash.update(bytes);
  state.bytes += bytes.length;
  state.transferredBytes += bytes.length;
  state.expectedIndex += 1;

  let status = "ACCEPTED";
  if (index === count - 1) {
    const actualFileHash = state.hash.digest("hex");
    if (actualFileHash !== expectedFileHash) {
      rmSync(temp, { force: true });
      artifactTransfers.delete(transferId);
      throw new Error("AE Phase artifact final hash mismatch");
    }
    if (Number.isInteger(fileBytes) && fileBytes >= 0 && state.bytes !== fileBytes) {
      rmSync(temp, { force: true });
      artifactTransfers.delete(transferId);
      throw new Error("AE Phase artifact final byte count mismatch");
    }
    rmSync(target, { force: true });
    renameSync(temp, target);
    artifactTransfers.delete(transferId);
    status = "VERIFIED";
  }
  const response = await sendLocalAEPhaseEnvelope({
    id: `ae-artifact-report-${randomUUID()}`,
    kind: "ae_artifact_chunk_report",
    correlationId: envelope.id,
    body: {
      ok: true,
      status,
      transferId,
      relativePath: body.relativePath,
      mode,
      destination: target,
      index,
      count,
      acceptedBytes: bytes.length,
      transferredBytes: state?.transferredBytes ?? bytes.length,
      totalBytes: state?.bytes ?? bytes.length,
      fileSha256: expectedFileHash,
    },
  }, { destinationSender: envelope.sender });
  recordPhaseCustody({ envelope, response, status: status === "VERIFIED" ? "TERMINAL_COMPLETED" : "CHUNK_ACCEPTED" });
  phaseArtifactChunksHandled += 1;
}

function validPhaseModel(value) {
  const model = String(value || "").trim();
  if (!/^[A-Za-z0-9._/:+\-]{1,160}$/.test(model)) throw new Error("AE Phase model name is invalid");
  return model;
}

function phaseModelForTier(tier, requested) {
  if (requested) return validPhaseModel(requested);
  const defaults = {
    navigator: process.env.ORANGE5_NAVIGATOR_MODEL || "orange-navigator:ornith-1.5-9b-q4km",
    code: process.env.ORANGE5_CODEXA_CODE_MODEL || "qwen3-coder:30b",
    heavy: process.env.ORANGE5_CODEXA_HEAVY_MODEL || "qwen3.8:27b-current",
    visual: process.env.ORANGE5_CODEXA_VISUAL_MODEL || "glm-4.6v",
    embedding: process.env.ORANGE5_CODEXA_EMBEDDING_MODEL || "qwen3-embedding:4b",
    reranker: process.env.ORANGE5_CODEXA_RERANKER_MODEL || "qwen3-reranker:0.6b",
  };
  return validPhaseModel(defaults[String(tier || "navigator").toLowerCase()] || defaults.navigator);
}

function phaseModelRoute(tier, model) {
  const normalizedTier = String(tier || "navigator").toLowerCase();
  if (normalizedTier === "navigator" && sameModel(model, PHASE_NAVIGATOR_ALIAS)) {
    return { url: PHASE_NAVIGATOR_URL, backend: "llama.cpp-vulkan", publicModel: PHASE_NAVIGATOR_ALIAS };
  }
  return { url: PHASE_MODEL_URL, backend: "ollama", publicModel: model };
}

async function resolvePhaseUpstreamModel(route) {
  if (route.backend !== "llama.cpp-vulkan") return route.publicModel;
  const response = await fetch(`${route.url}/v1/models`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Vulkan Navigator model inventory returned HTTP ${response.status}`);
  const payload = await response.json();
  const row = (payload.data || payload.models || [])[0];
  const modelId = row?.id || row?.name || row?.model;
  if (!modelId) throw new Error("Vulkan Navigator exposed no loaded model identity");
  return String(modelId);
}

function sameModel(left, right) {
  return String(left || "").replace(/:latest$/, "") === String(right || "").replace(/:latest$/, "");
}

function sanitizeModelPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const copy = structuredClone(payload);
  for (const choice of copy.choices || []) {
    if (choice?.message) {
      delete choice.message.reasoning;
      delete choice.message.reasoning_content;
      delete choice.message.thinking;
    }
    if (choice?.delta) {
      delete choice.delta.reasoning;
      delete choice.delta.reasoning_content;
      delete choice.delta.thinking;
    }
  }
  return copy;
}

function createStreamAssembly(model) {
  return {
    id: null,
    created: null,
    model,
    role: "assistant",
    content: "",
    finishReason: null,
    usage: null,
    toolCalls: new Map(),
  };
}

function applyStreamChunk(assembly, chunk) {
  assembly.id ||= chunk.id || null;
  assembly.created ||= chunk.created || null;
  assembly.model = chunk.model || assembly.model;
  assembly.usage = chunk.usage || assembly.usage;
  const choice = chunk.choices?.[0];
  if (!choice) return;
  const delta = choice.delta || {};
  if (typeof delta.role === "string") assembly.role = delta.role;
  if (typeof delta.content === "string") assembly.content += delta.content;
  if (choice.finish_reason) assembly.finishReason = choice.finish_reason;
  for (const call of delta.tool_calls || []) {
    const index = Number.isInteger(call.index) ? call.index : assembly.toolCalls.size;
    const prior = assembly.toolCalls.get(index) || { index, id: "", type: "function", function: { name: "", arguments: "" } };
    if (call.id) prior.id += call.id;
    if (call.type) prior.type = call.type;
    if (call.function?.name) prior.function.name += call.function.name;
    if (call.function?.arguments) prior.function.arguments += call.function.arguments;
    assembly.toolCalls.set(index, prior);
  }
}

function finishStreamAssembly(assembly) {
  const message = { role: assembly.role, content: assembly.content };
  if (assembly.toolCalls.size) message.tool_calls = [...assembly.toolCalls.values()].sort((a, b) => a.index - b.index);
  return {
    id: assembly.id || `chatcmpl-ae-phase-${Date.now()}`,
    object: "chat.completion",
    created: assembly.created || Math.floor(Date.now() / 1000),
    model: assembly.model,
    choices: [{ index: 0, message, finish_reason: assembly.finishReason || "stop" }],
    ...(assembly.usage ? { usage: assembly.usage } : {}),
  };
}

async function streamModelResponse(response, envelope, model) {
  if (!response.body) throw new Error("Codexa model stream returned no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const assembly = createStreamAssembly(model);
  let buffer = "";
  let batch = [];
  let batchBytes = 0;
  let deltaCount = 0;

  const flush = async () => {
    if (!batch.length) return;
    await sendLocalAEPhaseEnvelope({
      id: `ae-model-delta-${randomUUID()}`,
      kind: "ae_model_delta",
      correlationId: envelope.id,
      body: {
        schema: "orange.ae-phase.model-delta.v1",
        requestId: envelope.id,
        index: deltaCount,
        chunks: batch,
      },
    }, { destinationSender: envelope.sender });
    deltaCount += 1;
    batch = [];
    batchBytes = 0;
  };

  const consumeFrame = async (frame) => {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const chunk = sanitizeModelPayload(JSON.parse(data));
    if (chunk.error) throw new Error(chunk.error.message || "Codexa model stream failed");
    applyStreamChunk(assembly, chunk);
    batch.push(chunk);
    batchBytes += Buffer.byteLength(JSON.stringify(chunk));
    if (batch.length >= PHASE_MODEL_BATCH_CHUNKS || batchBytes >= PHASE_MODEL_BATCH_BYTES) await flush();
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";
    for (const frame of frames) await consumeFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) await consumeFrame(buffer);
  await flush();
  return { response: finishStreamAssembly(assembly), deltaCount };
}

async function sendPhaseModelTerminal(envelope, body) {
  const response = await sendLocalAEPhaseEnvelope({
    id: `ae-model-report-${randomUUID()}`,
    kind: "ae_model_report",
    correlationId: envelope.id,
    body,
  }, { destinationSender: envelope.sender });
  recordPhaseCustody({
    envelope,
    response,
    status: body.ok ? "TERMINAL_COMPLETED" : "TERMINAL_ATTENTION",
  });
  return response;
}

async function handlePhaseModelRequest(envelope) {
  const started = performance.now();
  let deltaCount = 0;
  try {
    const body = envelope.body || {};
    if (body.schema !== "orange.ae-phase.model-request.v1") throw new Error("AE Phase model request schema is invalid");
    if (!body.request || typeof body.request !== "object" || !Array.isArray(body.request.messages)) {
      throw new Error("AE Phase model request requires OpenAI-compatible messages");
    }
    const model = phaseModelForTier(body.tier, body.model || body.request.model);
    const route = phaseModelRoute(body.tier, model);
    const upstreamModel = await resolvePhaseUpstreamModel(route);
    const stream = body.stream === true;
    const timeoutMs = Math.max(1_000, Math.min(PHASE_MODEL_TIMEOUT_MAX_MS, Number(body.timeoutMs || 240_000)));
    const request = {
      ...body.request,
      model: upstreamModel,
      stream,
      think: false,
      reasoning_effort: "none",
      reasoning: { effort: "none" },
    };
    const upstream = await fetch(`${route.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 1_000);
      const error = new Error(`Codexa model ${model} via ${route.backend} returned HTTP ${upstream.status}: ${detail}`);
      error.httpStatus = upstream.status;
      throw error;
    }
    let response;
    if (stream) {
      const streamed = await streamModelResponse(upstream, envelope, model);
      response = streamed.response;
      deltaCount = streamed.deltaCount;
    } else {
      response = sanitizeModelPayload(await upstream.json());
    }
    response.model = model;
    response.ae_transport = "ae-phase";
    response.ae_effective_host = "codexa";
    response.ae_effective_node = "CODEXA";
    response.ae_effective_model = model;
    response.ae_effective_backend = route.backend;
    response.ae_upstream_model_id = upstreamModel;
    await sendPhaseModelTerminal(envelope, {
      schema: "orange.ae-phase.model-report.v1",
      ok: true,
      requestId: envelope.id,
      tier: body.tier,
      model,
      backend: route.backend,
      upstreamModelId: upstreamModel,
      deltaCount,
      durationMs: Math.round(performance.now() - started),
      response,
    });
    phaseModelRequestsHandled += 1;
    lastPhaseOrderAt = new Date().toISOString();
    lastPhaseError = null;
  } catch (error) {
    await sendPhaseModelTerminal(envelope, {
      schema: "orange.ae-phase.model-report.v1",
      ok: false,
      requestId: envelope.id,
      deltaCount,
      durationMs: Math.round(performance.now() - started),
      httpStatus: Number(error.httpStatus || (error.name === "TimeoutError" ? 504 : 502)),
      error: error?.message || String(error),
    });
    phaseModelRequestsHandled += 1;
    lastPhaseError = error?.message || String(error);
  }
}

async function handlePhaseModelQuery(envelope) {
  const body = envelope.body || {};
  const tier = String(body.tier || "navigator").toLowerCase();
  const model = phaseModelForTier(tier, body.model);
  const route = phaseModelRoute(tier, model);
  let result;
  try {
    if (route.backend === "llama.cpp-vulkan") {
      const [healthResponse, modelsResponse] = await Promise.all([
        fetch(`${route.url}/health`, { signal: AbortSignal.timeout(2_500) }),
        fetch(`${route.url}/v1/models`, { signal: AbortSignal.timeout(2_500) }),
      ]);
      const health = healthResponse.ok ? await healthResponse.json() : {};
      const inventory = modelsResponse.ok ? await modelsResponse.json() : {};
      const rows = inventory.data || inventory.models || [];
      const upstreamModelId = rows[0]?.id || rows[0]?.name || rows[0]?.model || null;
      const live = healthResponse.ok && modelsResponse.ok && health.status === "ok" && Boolean(upstreamModelId);
      result = {
        ok: live,
        live,
        status: live ? "live" : "model_missing",
        tier,
        model,
        modelAvailable: Boolean(upstreamModelId),
        modelLoaded: Boolean(upstreamModelId),
        modelCount: rows.length,
        loadedModels: upstreamModelId ? [model] : [],
        upstreamModelId,
        backend: route.backend,
        endpoint: "codexa-loopback-llama.cpp-vulkan",
        node: "CODEXA",
      };
    } else {
      const [tagsResponse, psResponse] = await Promise.all([
        fetch(`${route.url}/api/tags`, { signal: AbortSignal.timeout(2_500) }),
        fetch(`${route.url}/api/ps`, { signal: AbortSignal.timeout(2_500) }),
      ]);
      const tags = tagsResponse.ok ? await tagsResponse.json() : {};
      const ps = psResponse.ok ? await psResponse.json() : {};
      const availableModels = (tags.models || []).map((row) => row.name || row.model).filter(Boolean);
      const loadedModels = (ps.models || []).map((row) => row.name || row.model).filter(Boolean);
      const available = availableModels.some((name) => sameModel(name, model));
      const loaded = loadedModels.some((name) => sameModel(name, model));
      result = {
        ok: tagsResponse.ok,
        live: tagsResponse.ok,
        status: tagsResponse.ok ? (available ? "live" : "model_missing") : `http_${tagsResponse.status}`,
        tier,
        model,
        modelAvailable: available,
        modelLoaded: loaded,
        modelCount: availableModels.length,
        loadedModels: loadedModels.slice(0, 16),
        backend: route.backend,
        endpoint: "codexa-loopback-ollama",
        node: "CODEXA",
      };
    }
  } catch (error) {
    result = { ok: false, live: false, status: "unreachable", tier, model, modelAvailable: false, modelLoaded: false, error: error?.message || String(error), node: "CODEXA" };
  }
  const response = await sendLocalAEPhaseEnvelope({
    id: `ae-model-query-report-${randomUUID()}`,
    kind: "ae_model_query_report",
    correlationId: envelope.id,
    body: result,
  }, { destinationSender: envelope.sender });
  recordPhaseCustody({ envelope, response, status: result.ok ? "TERMINAL_COMPLETED" : "TERMINAL_ATTENTION" });
  phaseModelQueriesHandled += 1;
}

function pumpPhaseModelQueue() {
  if (phaseModelActive) return;
  const envelope = phaseModelQueue.shift();
  if (!envelope) return;
  phaseModelActive = true;
  handlePhaseModelRequest(envelope)
    .catch((error) => { lastPhaseError = error?.message || String(error); })
    .finally(() => {
      inFlightPhaseEnvelopes.delete(envelope.id);
      phaseModelActive = false;
      pumpPhaseModelQueue();
    });
}

function enqueuePhaseModel(envelope) {
  if (inFlightPhaseEnvelopes.has(envelope.id) || processedPhaseEnvelopes.has(envelope.id)) return;
  inFlightPhaseEnvelopes.add(envelope.id);
  phaseModelQueue.push(envelope);
  pumpPhaseModelQueue();
}

async function handlePhaseCobraRequest(envelope) {
  const started = performance.now();
  const body = envelope.body || {};
  const operation = String(body.operation || "health").toLowerCase();
  if (!['turn', 'health'].includes(operation)) throw new Error(`Unsupported AE Cobra Phase operation: ${operation}`);
  let outcome;
  try {
    const url = operation === 'turn' ? `${PHASE_COBRA_URL}/completion` : `${PHASE_COBRA_URL}/health`;
    const response = await fetch(url, {
      method: operation === 'turn' ? 'POST' : 'GET',
      ...(operation === 'turn' ? {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body.payload || {}),
      } : {}),
      signal: AbortSignal.timeout(Math.min(PHASE_COBRA_TIMEOUT_MS, Number(body.timeoutMs || PHASE_COBRA_TIMEOUT_MS))),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 1_000) }; }
    outcome = {
      schema: 'orange.ae-phase.cobra-report.v1',
      ok: response.ok,
      operation,
      httpStatus: response.status,
      payload,
      durationMs: Math.round(performance.now() - started),
      node: 'CODEXA',
    };
  } catch (error) {
    outcome = {
      schema: 'orange.ae-phase.cobra-report.v1',
      ok: false,
      operation,
      httpStatus: error.name === 'TimeoutError' ? 504 : 502,
      error: error?.message || String(error),
      durationMs: Math.round(performance.now() - started),
      node: 'CODEXA',
    };
  }
  if (operation === 'health' && !outcome.ok) {
    const mirror = verifyCobraMirror(PHASE_ARTIFACT_ROOT);
    if (mirror.ok) {
      outcome = {
        schema: 'orange.ae-phase.cobra-report.v1',
        ok: true,
        operation,
        authority: 'verified AE Cobra disk mirror',
        payload: mirror,
        daemon: { live: false, endpoint: PHASE_COBRA_URL },
        durationMs: Math.round(performance.now() - started),
        node: 'CODEXA',
      };
    }
  }
  const response = await sendLocalAEPhaseEnvelope({
    id: `ae-cobra-report-${randomUUID()}`,
    kind: 'ae_cobra_report',
    correlationId: envelope.id,
    body: outcome,
  }, { destinationSender: envelope.sender });
  recordPhaseCustody({ envelope, response, status: outcome.ok ? 'TERMINAL_COMPLETED' : 'TERMINAL_ATTENTION' });
  phaseCobraRequestsHandled += 1;
}

async function handlePhaseToolRequest(envelope) {
  const started = performance.now();
  const body = envelope.body || {};
  if (body.schema !== 'orange.ae-phase.tool-request.v1') throw new Error('AE Phase tool request schema is invalid');
  if (body.operation !== 'command' || body.tool !== 'codexa-command-rail') throw new Error('Unsupported AE Phase tool operation');
  const command = String(body.command || '').trim();
  if (!PHASE_TOOL_ALLOWLIST.has(command)) throw new Error(`AE Phase tool command is not allowlisted: ${command || '(empty)'}`);
  const args = Array.isArray(body.args) ? body.args.map((value) => String(value)).slice(0, 32) : [];
  if (args.some((value) => value.length > 512)) throw new Error('AE Phase tool arg exceeds 512 characters');
  const token = phaseRailToken();
  if (!token) throw new Error('Codexa command rail token is unavailable to the local Phase effector');
  const timeoutMs = Math.max(1_000, Math.min(PHASE_TOOL_TIMEOUT_MAX_MS, Number(body.timeoutMs || 60_000)));
  let outcome;
  try {
    const invocation = resolveCodexaToolInvocation({
      command,
      args,
      bunExecutable: process.execPath,
      runnerPath: PHASE_TOOL_RUNNER,
    });
    const railCommand = renderCodexaToolCommand(invocation);
    const response = await fetch(`${PHASE_RAIL_URL}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Orangebox-Token': token },
      body: JSON.stringify({ command: railCommand, confirmFullAccess: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 4_000) }; }
    const assessed = assessCodexaToolReceipt(payload, command);
    const verified = response.ok && assessed.ok;
    outcome = {
      schema: 'orange.ae-phase.tool-report.v1',
      ok: verified,
      status: verified ? 'TERMINAL_COMPLETED' : 'TERMINAL_ATTENTION',
      operation: 'command',
      tool: 'codexa-command-rail',
      command,
      executor: 'bun-semantic-tool-runner',
      executorSchema: CODEXA_TOOL_RUNNER_SCHEMA,
      httpStatus: response.status,
      payload,
      semantic: assessed.semantic,
      durationMs: Math.round(performance.now() - started),
      node: 'CODEXA',
      receiptPath: payload?.receiptPath || null,
    };
  } catch (error) {
    outcome = {
      schema: 'orange.ae-phase.tool-report.v1',
      ok: false,
      status: 'TERMINAL_ATTENTION',
      operation: 'command',
      tool: 'codexa-command-rail',
      command,
      httpStatus: error.name === 'TimeoutError' ? 504 : 502,
      error: error?.message || String(error),
      durationMs: Math.round(performance.now() - started),
      node: 'CODEXA',
    };
  }
  const response = await sendLocalAEPhaseEnvelope({
    id: `ae-tool-report-${randomUUID()}`,
    kind: 'ae_tool_report',
    correlationId: envelope.id,
    body: outcome,
  }, { destinationSender: envelope.sender });
  recordPhaseCustody({ envelope, response, status: outcome.status });
  phaseToolRequestsHandled += 1;
}

const PHASE_FAILURE_REPORTS = Object.freeze({
  ae_staff_order: 'ae_staff_report',
  ae_staff_query: 'ae_staff_query_report',
  ae_artifact_chunk: 'ae_artifact_chunk_report',
  ae_model_query: 'ae_model_query_report',
  ae_model_request: 'ae_model_report',
  ae_cobra_request: 'ae_cobra_report',
  ae_tool_request: 'ae_tool_report',
});

async function rejectPhaseEnvelope(envelope, error) {
  const message = error?.message || String(error);
  const responseKind = PHASE_FAILURE_REPORTS[envelope.kind];
  if (!responseKind) throw error;
  const response = await sendLocalAEPhaseEnvelope({
    id: `ae-phase-rejection-${randomUUID()}`,
    kind: responseKind,
    correlationId: envelope.id,
    body: {
      schema: 'orange.ae-phase.failure-report.v1',
      ok: false,
      requestId: envelope.id,
      requestKind: envelope.kind,
      status: 'TERMINAL_REJECTED',
      error: message,
      node: 'CODEXA',
      rejectedAt: new Date().toISOString(),
    },
  }, { destinationSender: envelope.sender });
  recordPhaseCustody({ envelope, response, status: 'TERMINAL_REJECTED' });
  phaseRejectedEnvelopes += 1;
  lastPhaseError = message;
}

async function drainPhaseInbox() {
  if (phaseBusy) return;
  phaseBusy = true;
  try {
    const priority = Object.freeze({
      ae_model_request: 0,
      ae_model_query: 1,
      ae_staff_order: 2,
      ae_staff_query: 3,
      ae_cobra_request: 4,
      ae_tool_request: 5,
      ae_artifact_chunk: 10,
    });
    const pending = [
      ...readAEPhaseEnvelopes({ kind: "ae_staff_order", limit: 10_000 }).map((envelope) => ({ envelope, handler: handlePhaseOrder })),
      ...readAEPhaseEnvelopes({ kind: "ae_staff_query", limit: 10_000 }).map((envelope) => ({ envelope, handler: handlePhaseQuery })),
      ...readAEPhaseEnvelopes({ kind: "ae_artifact_chunk", limit: 10_000 }).map((envelope) => ({ envelope, handler: handlePhaseArtifactChunk })),
      ...readAEPhaseEnvelopes({ kind: "ae_model_query", limit: 10_000 }).map((envelope) => ({ envelope, handler: handlePhaseModelQuery })),
      ...readAEPhaseEnvelopes({ kind: "ae_model_request", limit: 10_000 }).map((envelope) => ({ envelope, handler: enqueuePhaseModel })),
      ...readAEPhaseEnvelopes({ kind: "ae_cobra_request", limit: 10_000 }).map((envelope) => ({ envelope, handler: handlePhaseCobraRequest })),
      ...readAEPhaseEnvelopes({ kind: "ae_tool_request", limit: 10_000 }).map((envelope) => ({ envelope, handler: handlePhaseToolRequest })),
    ]
      .filter(({ envelope }) => !processedPhaseEnvelopes.has(envelope.id) && !inFlightPhaseEnvelopes.has(envelope.id))
      .sort((a, b) => {
        const priorityDelta = (priority[a.envelope.kind] ?? 50) - (priority[b.envelope.kind] ?? 50);
        if (priorityDelta !== 0) return priorityDelta;
        return String(a.envelope.receivedAt || a.envelope.createdAt)
          .localeCompare(String(b.envelope.receivedAt || b.envelope.createdAt));
      });
    for (const item of pending) {
      try {
        await item.handler(item.envelope);
      } catch (error) {
        await rejectPhaseEnvelope(item.envelope, error);
      }
    }
  } catch (error) {
    lastPhaseError = error?.message || String(error);
  } finally {
    phaseBusy = false;
  }
}

const phaseTimer = setInterval(drainPhaseInbox, PHASE_POLL_MS);
drainPhaseInbox();

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function authorized(request) {
  if (!ownerKey) return false;
  return request.headers.get("authorization") === `Bearer ${ownerKey}`;
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const state = reactor.snapshot();
      return json({ ok: state.status === "LIVE" && state.roleCount === 50, name: "AE Staff - Powered by Hermes", wave: "Wave 4: A 50-Person Company on Your Desktop", hermesApi: HERMES_API, authenticatedRecoveryHttp: Boolean(ownerKey), transport: { primary: "ae-phase", recovery: "loopback-http", phaseOrdersHandled, phaseQueriesHandled, phaseArtifactChunksHandled, phaseModelRequestsHandled, phaseModelQueriesHandled, phaseCobraRequestsHandled, phaseToolRequestsHandled, phaseRejectedEnvelopes, phaseModelQueueDepth: phaseModelQueue.length, phaseModelActive, lastPhaseOrderAt, lastPhaseError }, profileFusion: { enabled: true, ...profileBatchMetrics }, continuum: continuum.status(), ...state, roles: undefined });
    }
    if (!authorized(request)) return json({ ok: false, error: "unauthorized" }, 401);
    if (request.method === "GET" && url.pathname === "/staff") return json(reactor.snapshot());
    if (request.method === "POST" && url.pathname === "/events") {
      if (process.env.AE_STAFF_ALLOW_HTTP_RECOVERY !== "1") {
        return json({ ok: false, error: "AE Phase is the required AE Staff transport; HTTP events are recovery-only" }, 409);
      }
      try {
        const input = await request.json();
        input.projectCrystal = continuum.observe(input);
        return json(await reactor.publish(input), 202);
      }
      catch (error) { return json({ ok: false, error: error?.message || String(error) }, 400); }
    }
    return json({ ok: false, error: "not_found" }, 404);
  },
});

process.stdout.write(`${JSON.stringify({ schema: "orange.ae-staff-service.v1", status: "LIVE", host: HOST, port: server.port, roles: 50, inferenceLimit: INFERENCE_LIMIT, eventLog: EVENT_LOG })}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  clearInterval(phaseTimer);
  server.stop(true);
  process.exit(0);
});
