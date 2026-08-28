import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntimeState } from "./state-machine.mjs";

export const DESIRED_FILE_SCHEMA = "orange.runtime-desired.v1";
export const OBSERVED_FILE_SCHEMA = "orange.runtime-observed.v1";
export const RECEIPT_CHAIN_SCHEMA = "orange.runtime-receipt-chain.v1";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${stableJson(value)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function canonicalRuntimeProfileRoot() {
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, "OrangeBox-Data", "orange5", "runtime-profile");
}

export class RuntimeProfileStore {
  constructor(root = canonicalRuntimeProfileRoot()) {
    this.root = path.resolve(root);
    this.desiredPath = path.join(this.root, "desired.json");
    this.observedPath = path.join(this.root, "observed.json");
    this.receiptsPath = path.join(this.root, "lifecycle-receipts.jsonl");
    fs.mkdirSync(this.root, { recursive: true });
  }

  load(profile, at = 0) {
    const state = createRuntimeState(profile, at);
    const desired = readJson(this.desiredPath);
    const observed = readJson(this.observedPath);
    if (!desired && !observed) return state;
    if (desired?.profileId && desired.profileId !== profile.id) throw new Error("desired state belongs to another profile");
    if (observed?.profileId && observed.profileId !== profile.id) throw new Error("observed state belongs to another profile");

    for (const organ of profile.organs) {
      if (desired?.organs?.[organ.name]) state.desired[organ.name] = desired.organs[organ.name];
      if (observed?.organs?.[organ.name]) state.observed[organ.name] = observed.organs[organ.name];
    }
    state.revision = Math.max(Number(desired?.revision) || 0, Number(observed?.revision) || 0);
    state.updatedAt = observed?.updatedAt || desired?.updatedAt || state.updatedAt;
    return state;
  }

  persist(state, receipts = []) {
    atomicWriteJson(this.desiredPath, {
      schema: DESIRED_FILE_SCHEMA,
      profileId: state.profile.id,
      revision: state.revision,
      updatedAt: state.updatedAt,
      organs: state.desired,
    });
    atomicWriteJson(this.observedPath, {
      schema: OBSERVED_FILE_SCHEMA,
      profileId: state.profile.id,
      revision: state.revision,
      updatedAt: state.updatedAt,
      limits: state.profile.limits,
      organs: state.observed,
    });
    return receipts.map((receipt) => this.appendReceipt(receipt));
  }

  appendReceipt(receipt) {
    const previousReceiptHash = this.#lastReceiptHash();
    const base = {
      schema: RECEIPT_CHAIN_SCHEMA,
      ...receipt,
      previousReceiptHash,
    };
    const chained = { ...base, receiptHash: sha256(stableJson(base)) };
    fs.appendFileSync(this.receiptsPath, `${stableJson(chained)}\n`, { encoding: "utf8", mode: 0o600 });
    return chained;
  }

  readReceipts() {
    try {
      return fs.readFileSync(this.receiptsPath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  verifyReceiptChain() {
    const receipts = this.readReceipts();
    const broken = [];
    let previous = null;
    for (const [index, receipt] of receipts.entries()) {
      const { receiptHash, ...base } = receipt;
      if (base.previousReceiptHash !== previous) broken.push({ index, reason: "previous-hash" });
      if (sha256(stableJson(base)) !== receiptHash) broken.push({ index, reason: "receipt-hash" });
      previous = receiptHash;
    }
    return { ok: broken.length === 0, count: receipts.length, head: previous, broken };
  }

  #lastReceiptHash() {
    const receipts = this.readReceipts();
    return receipts.at(-1)?.receiptHash || null;
  }
}

export const __runtimeStoreInternals = Object.freeze({ stableJson, sha256, atomicWriteJson });
