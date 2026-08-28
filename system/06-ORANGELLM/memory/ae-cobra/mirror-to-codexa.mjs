import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { relative, join, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { canonicalFluxRoot } from "./paths.mjs";
import { writeChainedJsonReceipt } from "../../../10-RECEIPTS/tools/json-receipt-chain.mjs";

const SOURCE = canonicalFluxRoot();
const REMOTE_ROOT = process.env.AE_COBRA_CODEXA_BACKUP_ROOT ||
  "C:\\Users\\Atom\\OrangeBox-Data\\orange5\\ae-cobra-backup";
const RAIL = (process.env.ORANGE5_CODEXA_RAIL_URL || "http://10.0.0.4:8097").replace(/\/$/, "");
function railToken() {
  if (process.env.ORANGEBOX_RAIL_TOKEN) return process.env.ORANGEBOX_RAIL_TOKEN;
  if (process.platform !== "win32") return "";
  const probe = Bun.spawnSync([
    "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
    "[Environment]::GetEnvironmentVariable('ORANGEBOX_RAIL_TOKEN','User')",
  ]);
  return probe.exitCode === 0 ? probe.stdout.toString().trim() : "";
}
const TOKEN = railToken();
const RAIL_TIMEOUT_MS = Math.max(5_000, Number(process.env.AE_COBRA_MIRROR_RAIL_TIMEOUT_MS || 30_000));
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

async function put(path, bytes) {
  const hash = sha256(bytes);
  const response = await fetch(`${RAIL}/put-file`, {
    method: "POST",
    signal: AbortSignal.timeout(RAIL_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "x-orangebox-token": TOKEN,
    },
    body: JSON.stringify({
      path,
      base64: bytes.toString("base64"),
      sha256: hash,
      confirmFullAccess: true,
    }),
  });
  const result = await response.json();
  if (!response.ok || result.status !== "VERIFIED" || result.sha256 !== hash) {
    throw new Error(`Codexa put-file verification failed for ${path}: ${JSON.stringify(result)}`);
  }
  return { path, bytes: bytes.length, sha256: hash, railReceiptPath: result.receiptPath };
}

export async function runMirror({ force = false } = {}) {
  if (!TOKEN) throw new Error("ORANGEBOX_RAIL_TOKEN is required");

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
    if (force || priorState.files?.[rel]?.sha256 !== hash) changed.push(await put(remote, bytes));
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
    transferredBytes: changed.reduce((sum, item) => sum + item.bytes, 0),
    files,
    changed,
  };

  if (changed.length) {
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    manifest.remoteManifest = await put(`${REMOTE_ROOT}\\mirror-manifest.json`, manifestBytes);
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
