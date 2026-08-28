import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function safeId(value) {
  return String(value || "orange5").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "orange5";
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map(String))];
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export class StaffContinuum {
  constructor({ root }) {
    if (!root) throw new Error("StaffContinuum requires a state root");
    this.root = resolve(root);
    this.projectsRoot = join(this.root, "projects");
    this.cursorsRoot = join(this.root, "profile-cursors");
    mkdirSync(this.projectsRoot, { recursive: true });
    mkdirSync(this.cursorsRoot, { recursive: true });
  }

  observe(input = {}) {
    const projectId = String(input.projectId || input.order?.targetProject || "orange5");
    const projectKey = safeId(projectId);
    const snapshotPath = join(this.projectsRoot, projectKey, "snapshot.json");
    const journalPath = join(this.projectsRoot, projectKey, "deltas.jsonl");
    const previous = readJson(snapshotPath);
    const delta = {
      schema: "orange.ae-staff-project-delta.v1",
      sequence: Number(previous?.version || 0) + 1,
      eventId: input.id || null,
      type: input.type || "project.event",
      topic: input.topic || "general",
      summary: String(input.summary || input.body || "Orange staff event"),
      order: input.order || null,
      authority: input.authority || input.order?.authority || "operator",
      custody: input.custody || input.order?.custody || null,
      cancellation: input.cancellation || input.order?.cancellation || null,
      handoffCapsule: input.handoffCapsule || null,
      commitments: unique(input.commitments),
      sourceRefs: unique(input.sourceRefs),
      createdAt: new Date().toISOString(),
      previousHash: previous?.headHash || null,
    };
    delta.deltaHash = digest(delta);
    const snapshot = {
      schema: "orange.ae-staff-project-crystal.v1",
      projectId,
      projectKey,
      version: delta.sequence,
      headHash: delta.deltaHash,
      previousHash: delta.previousHash,
      updatedAt: delta.createdAt,
      objective: input.order?.intent || previous?.objective || delta.summary,
      activeOrderId: input.order?.orderId || previous?.activeOrderId || null,
      commitments: unique([...(previous?.commitments || []), ...delta.commitments]).slice(-64),
      sourceRefs: unique([...(previous?.sourceRefs || []), ...delta.sourceRefs]).slice(-128),
      handoffCapsule: delta.handoffCapsule || previous?.handoffCapsule || null,
      latestDelta: delta,
      snapshotPath,
      journalPath,
    };
    mkdirSync(dirname(journalPath), { recursive: true });
    appendFileSync(journalPath, `${JSON.stringify(delta)}\n`, "utf8");
    atomicJson(snapshotPath, snapshot);
    return snapshot;
  }

  viewForProfile(projectCrystal, profile) {
    if (!projectCrystal?.projectKey || !projectCrystal?.headHash) throw new Error("Profile hydration requires a valid Project Crystal");
    const cursorPath = join(this.cursorsRoot, projectCrystal.projectKey, `${safeId(profile)}.json`);
    const previous = readJson(cursorPath);
    const contiguous = previous?.headHash === projectCrystal.previousHash && Number(previous?.version) + 1 === Number(projectCrystal.version);
    const current = previous?.headHash === projectCrystal.headHash;
    const mode = current ? "reference" : (contiguous ? "delta" : "hydrate");
    const view = {
      schema: "orange.ae-staff-profile-context.v1",
      projectId: projectCrystal.projectId,
      profile,
      mode,
      version: projectCrystal.version,
      headHash: projectCrystal.headHash,
      snapshotPath: projectCrystal.snapshotPath,
      context: mode === "hydrate"
        ? {
            objective: projectCrystal.objective,
            activeOrderId: projectCrystal.activeOrderId,
            commitments: projectCrystal.commitments,
            sourceRefs: projectCrystal.sourceRefs,
            handoffCapsule: projectCrystal.handoffCapsule,
            latestDelta: projectCrystal.latestDelta,
          }
        : (mode === "delta" ? projectCrystal.latestDelta : { source: projectCrystal.snapshotPath }),
    };
    atomicJson(cursorPath, {
      schema: "orange.ae-staff-profile-cursor.v1",
      projectId: projectCrystal.projectId,
      profile,
      version: projectCrystal.version,
      headHash: projectCrystal.headHash,
      updatedAt: new Date().toISOString(),
    });
    return view;
  }

  status() {
    const projects = existsSync(this.projectsRoot)
      ? readdirSync(this.projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
      : 0;
    return { schema: "orange.ae-staff-continuum-status.v1", root: this.root, projects };
  }
}

export const staffContinuumInternals = { stable, digest, safeId };
