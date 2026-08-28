import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { relative, join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { canonicalFluxRoot } from "./paths.mjs";
import { writeChainedJsonReceipt } from "../../../10-RECEIPTS/tools/json-receipt-chain.mjs";
import { sendLocalAEPhaseEnvelope, waitForAEPhaseEnvelope } from "../../../03-BACKEND/ae-phase-fabric.mjs";

const SOURCE = canonicalFluxRoot();
const REMOTE_ROOT = process.env.AE_COBRA_CODEXA_BACKUP_ROOT ||
  "C:\\Users\\Atom\\OrangeBox-Data\\orange5\\ae-cobra-backup";
const PHASE_TIMEOUT_MS = Math.max(5_000, Number(process.env.AE_COBRA_MIRROR_PHASE_TIMEOUT_MS || 30_000));
const PHASE_CHUNK_BYTES = Math.min(24 * 1024, Math.max(1024, Number(process.env.AE_COBRA_MIRROR_PHASE_CHUNK_BYTES || 24 * 1024)));
const STATE_PATH = process.env.AE_COBRA_MIRROR_STATE ||
  join(homedir(), "OrangeBox-Data", "orange5", "ae-cobra-mirror-state.json");
const RECEIPT_DIR = join(
  dirname(dirname(dirname(import.meta.dirname))),
  "10-RECEIPTS",
  "orange5-build",
);

async function filesUnder(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  }
  await walk(root);
  return found.sort();
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8"));
    return parsed?.schema === "orange5.ae_cobra.mirror_state.v1" ? parsed : { files: {} };
  } catch {
    return { files: {} };
  }
}

async function put(relativePath, payloadBytes, options = {}) {
  const mode = options.mode === "append" ? "append" : "replace";
  const fileBytes = Number(options.fileBytes ?? payloadBytes.length);
  const fileSha256 = options.fileSha256 || sha256(payloadBytes);
  const baseBytes = Number(options.baseBytes || 0);
  const baseSha256 = options.baseSha256 || null;
  const transferId = `ae-cobra-${randomUUID()}`;
  const count = Math.max(1, Math.ceil(payloadBytes.length / PHASE_CHUNK_BYTES));
  let finalReport = null;
  for (let index = 0; index < count; index += 1) {
    const chunk = payloadBytes.subarray(
      index * PHASE_CHUNK_BYTES,
      Math.min(payloadBytes.length, (index + 1) * PHASE_CHUNK_BYTES),
    );
    const envelopeId = `ae-artifact-${randomUUID()}`;
    await sendLocalAEPhaseEnvelope({
      id: envelopeId,
      kind: "ae_artifact_chunk",
      correlationId: transferId,
      body: {
        transferId,
        relativePath,
        mode,
        baseBytes,
        baseSha256,
        fileBytes,
        index,
        count,
        fileSha256,
        chunkSha256: sha256(chunk),
        dataBase64: chunk.toString("base64"),
      },
    });
    const response = await waitForAEPhaseEnvelope({
      kind: "ae_artifact_chunk_report",
      correlationId: envelopeId,
    }, { timeoutMs: PHASE_TIMEOUT_MS });
    if (response.body?.ok !== true || response.body?.index !== index || response.body?.fileSha256 !== fileSha256) {
      throw new Error(`Codexa AE Phase artifact verification failed for ${relativePath} chunk ${index}`);
    }
    finalReport = { ...response.body, phaseResponseEnvelopeId: response.id, phaseResponseBodyHash: response.bodyHash };
  }
  if (finalReport?.status !== "VERIFIED") throw new Error(`Codexa AE Phase artifact did not reach VERIFIED for ${relativePath}`);
  return {
    path: finalReport.destination,
    relativePath,
    bytes: fileBytes,
    transferredBytes: payloadBytes.length,
    sha256: fileSha256,
    mode,
    transport: "ae-phase",
    transferId,
    phaseReceipt: finalReport,
  };
}

async function mirrorChangedFile(relativePath, bytes, prior) {
  const fileSha256 = sha256(bytes);
  const priorBytes = Number(prior?.bytes || 0);
  const canAppend = priorBytes > 0
    && bytes.length > priorBytes
    && sha256(bytes.subarray(0, priorBytes)) === prior?.sha256;
  if (canAppend) {
    try {
      return await put(relativePath, bytes.subarray(priorBytes), {
        mode: "append",
        baseBytes: priorBytes,
        baseSha256: prior.sha256,
        fileBytes: bytes.length,
        fileSha256,
      });
    } catch (error) {
      const replacement = await put(relativePath, bytes, { fileBytes: bytes.length, fileSha256 });
      return { ...replacement, appendFallbackReason: error.message };
    }
  }
  return put(relativePath, bytes, { fileBytes: bytes.length, fileSha256 });
}

export async function runMirror({ force = false } = {}) {
  const startedAt = new Date().toISOString();
  const priorState = await readState();
  const nextFiles = {};
  const files = [];
  const changed = [];

  for (const file of await filesUnder(SOURCE)) {
    const rel = relative(SOURCE, file);
    if (rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error(`path escape: ${rel}`);
    const bytes = await readFile(file);
    const hash = sha256(bytes);
    const remote = `${REMOTE_ROOT}\\${rel.split(sep).join("\\")}`;
    const item = { path: remote, relativePath: rel, bytes: bytes.length, sha256: hash };
    nextFiles[rel] = item;
    files.push(item);
    if (force || priorState.files?.[rel]?.sha256 !== hash) {
      const relativePath = rel.split(sep).join("/");
      changed.push(await mirrorChangedFile(relativePath, bytes, force ? null : priorState.files?.[rel]));
    }
  }

  const completedAt = new Date().toISOString();
  const manifest = {
    schema: "orange5.ae_cobra.codexa_mirror.v1",
    status: changed.length ? "VERIFIED" : "UP_TO_DATE",
    source: SOURCE,
    remoteRoot: REMOTE_ROOT,
    startedAt,
    completedAt,
    fileCount: files.length,
    changedFileCount: changed.length,
    totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
    transferredBytes: changed.reduce((sum, item) => sum + item.transferredBytes, 0),
    files,
    changed,
  };

  if (changed.length) {
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    manifest.remoteManifest = await put("mirror-manifest.json", manifestBytes);
    manifest.manifestSha256 = sha256(manifestBytes);
  }

  const state = {
    schema: "orange5.ae_cobra.mirror_state.v1",
    status: manifest.status,
    lastAttemptAt: completedAt,
    lastSuccessfulAt: completedAt,
    remoteRoot: REMOTE_ROOT,
    files: nextFiles,
  };
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

  let receiptPath = null;
  if (changed.length) {
    await mkdir(RECEIPT_DIR, { recursive: true });
    const stamp = completedAt.replace(/[:.]/g, "-");
    receiptPath = join(RECEIPT_DIR, `${stamp}-ae-cobra-codexa-mirror.json`);
    writeChainedJsonReceipt(receiptPath, manifest);
  }
  return { ...manifest, statePath: STATE_PATH, receiptPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runMirror(), null, 2));
}
