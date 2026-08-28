import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_ROSTER = resolve(import.meta.dir, "../product-integration/config/staff-roster.json");
const TOKEN = /[a-z0-9][a-z0-9-]{1,}/g;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function words(value) {
  return unique(String(value || "").toLowerCase().match(TOKEN) || []);
}

function roleCorpus(role) {
  return words([
    role.id,
    role.title,
    role.studio,
    role.purpose,
    ...(role.concreteOutputs || []),
    ...(role.entryConditions || []),
  ].join(" "));
}

export function loadStaffRoster(path = DEFAULT_ROSTER) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed.roles) || parsed.roles.length !== 50) {
    throw new Error(`Staff roster must contain exactly 50 roles; got ${parsed.roles?.length ?? 0}`);
  }
  const ids = parsed.roles.map((role) => role.id);
  if (new Set(ids).size !== 50) throw new Error("Staff roster role ids must be unique");
  if (parsed.roles.filter((role) => role.archetype === "navigator").length !== 1) {
    throw new Error("Staff roster must contain exactly one Navigator");
  }
  for (const role of parsed.roles) {
    if (!role.id || !role.title || !role.purpose) throw new Error(`Incomplete staff role: ${role.id || "unknown"}`);
    if (!Array.isArray(role.concreteOutputs) || !role.concreteOutputs.length) {
      throw new Error(`Staff role ${role.id} has no concrete outputs`);
    }
    if (!role.completionContract) throw new Error(`Staff role ${role.id} has no completion contract`);
  }
  return parsed;
}

export function scoreRoleForEvent(role, event) {
  if (event?.targetRoles?.includes(role.id)) return 1;
  if (event?.broadcast === true) return 0.75;
  const query = words(`${event?.type || ""} ${event?.topic || ""} ${event?.summary || ""} ${event?.body || ""}`);
  if (!query.length) return role.archetype === "navigator" ? 0.5 : 0;
  const corpus = new Set(roleCorpus(role));
  const overlap = query.filter((token) => corpus.has(token)).length;
  const specialty = overlap / Math.max(3, Math.min(query.length, 12));
  const navigatorFloor = role.archetype === "navigator" ? 0.35 : 0;
  return Math.min(1, Math.max(navigatorFloor, specialty));
}

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.waiters = [];
  }

  async use(fn) {
    if (this.active >= this.limit) await new Promise((resolveWaiter) => this.waiters.push(resolveWaiter));
    this.active += 1;
    try { return await fn(); }
    finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class StaffReactor {
  constructor({
    roster = loadStaffRoster(),
    inferenceLimit = 8,
    toolLimit = 32,
    relevanceThreshold = 0.18,
    eventLogPath = null,
    dispatch = async () => { throw new Error("No governed Hermes dispatch adapter configured"); },
  } = {}) {
    this.roster = roster;
    this.roles = new Map(roster.roles.map((role) => [role.id, {
      ...role,
      corpus: roleCorpus(role),
      state: "offline",
      mailbox: [],
      handled: 0,
      ignored: 0,
      lastEventAt: null,
      lastResult: null,
    }]));
    this.inference = new Semaphore(inferenceLimit);
    this.tools = new Semaphore(toolLimit);
    this.relevanceThreshold = relevanceThreshold;
    this.eventLogPath = eventLogPath;
    this.dispatch = dispatch;
    this.startedAt = null;
    this.sequence = 0;
  }

  start() {
    if (this.startedAt) return this.snapshot();
    this.startedAt = new Date().toISOString();
    for (const role of this.roles.values()) role.state = "ready";
    this.#record({ type: "staff.started", roleCount: this.roles.size, startedAt: this.startedAt });
    return this.snapshot();
  }

  async publish(input = {}) {
    if (!this.startedAt) this.start();
    const targetRoles = unique(input.targetRoles || []);
    const unknownTargets = targetRoles.filter((roleId) => !this.roles.has(roleId));
    if (unknownTargets.length) throw new Error(`Unknown AE Staff target roles: ${unknownTargets.join(", ")}`);
    const event = {
      id: input.id || `staff-event-${Date.now()}-${++this.sequence}`,
      type: input.type || "project.event",
      topic: input.topic || "general",
      summary: input.summary || input.body || "Orange staff event",
      body: input.body || "",
      projectId: input.projectId || "orange5",
      correlationId: input.correlationId || null,
      order: input.order && typeof input.order === "object" ? input.order : null,
      roleOrders: input.roleOrders && typeof input.roleOrders === "object" ? input.roleOrders : {},
      authority: input.authority || input.order?.authority || "operator",
      custody: input.custody || input.order?.custody || null,
      cancellation: input.cancellation || input.order?.cancellation || null,
      projectCrystal: input.projectCrystal || null,
      handoffCapsule: input.handoffCapsule || null,
      commitments: Array.isArray(input.commitments) ? input.commitments : [],
      sourceRefs: Array.isArray(input.sourceRefs) ? input.sourceRefs : [],
      transportEvidence: input.transportEvidence && typeof input.transportEvidence === "object" ? input.transportEvidence : null,
      broadcast: Boolean(input.broadcast),
      targetRoles,
      requiresModel: input.requiresModel !== false,
      createdAt: new Date().toISOString(),
    };
    const observed = [];
    for (const role of this.roles.values()) {
      const relevance = scoreRoleForEvent(role, event);
      role.lastEventAt = event.createdAt;
      observed.push({ roleId: role.id, relevance });
    }
    const explicit = event.targetRoles.length > 0;
    const addressed = observed.filter(({ roleId, relevance }) => {
      const role = this.roles.get(roleId);
      if (explicit) return event.targetRoles.includes(roleId);
      if (event.broadcast) return true;
      return role.archetype === "navigator";
    });
    for (const role of this.roles.values()) {
      const match = addressed.find((item) => item.roleId === role.id);
      if (match) {
        const relevance = Math.max(match.relevance, explicit ? 1 : 0.35);
        role.mailbox.push({ event, relevance });
      } else role.ignored += 1;
    }
    const candidates = observed
      .filter(({ roleId }) => this.roles.get(roleId).archetype !== "navigator")
      .sort((left, right) => right.relevance - left.relevance || left.roleId.localeCompare(right.roleId))
      .slice(0, 8);
    this.#record({ type: "staff.event.accepted", event, observedCount: observed.length, addressed, candidates });
    const results = await Promise.all(addressed.map(({ roleId }) => this.#drainRole(roleId)));
    return { event, observedCount: observed.length, addressed, candidates, results, snapshot: this.snapshot() };
  }

  async #drainRole(roleId) {
    const role = this.roles.get(roleId);
    if (!role || role.state === "running") return null;
    const packet = role.mailbox.shift();
    if (!packet) return null;
    role.state = "running";
    const semaphore = packet.event.requiresModel ? this.inference : this.tools;
    try {
      const result = await semaphore.use(() => this.dispatch({
        role,
        event: packet.event,
        relevance: packet.relevance,
        projectNow: {
          projectId: packet.event.projectId,
          correlationId: packet.event.correlationId,
          order: packet.event.order,
          roleOrders: packet.event.roleOrders,
          authority: packet.event.authority,
          custody: packet.event.custody,
          cancellation: packet.event.cancellation,
          projectCrystal: packet.event.projectCrystal,
          handoffCapsule: packet.event.handoffCapsule,
          commitments: packet.event.commitments,
          sourceRefs: packet.event.sourceRefs,
        },
      }));
      role.handled += 1;
      role.lastResult = result;
      this.#record({ type: "staff.role.completed", roleId, eventId: packet.event.id, result });
      return { roleId, ok: true, result };
    } catch (error) {
      const failure = { status: "blocked", error: error?.message || String(error) };
      role.lastResult = failure;
      this.#record({ type: "staff.role.blocked", roleId, eventId: packet.event.id, failure });
      return { roleId, ok: false, result: failure };
    } finally {
      role.state = "ready";
      if (role.mailbox.length) queueMicrotask(() => this.#drainRole(roleId));
    }
  }

  snapshot() {
    const roles = [...this.roles.values()].map(({ corpus, ...role }) => ({ ...role, queued: role.mailbox.length, mailbox: undefined }));
    return {
      schema: "orange.hermes-staff-reactor.v1",
      status: this.startedAt && roles.every((role) => role.state !== "offline") ? "LIVE" : "OFFLINE",
      startedAt: this.startedAt,
      roleCount: roles.length,
      readyCount: roles.filter((role) => role.state === "ready").length,
      runningCount: roles.filter((role) => role.state === "running").length,
      queuedCount: roles.reduce((sum, role) => sum + role.queued, 0),
      inferenceLimit: this.inference.limit,
      inferenceActive: this.inference.active,
      toolLimit: this.tools.limit,
      toolActive: this.tools.active,
      roles,
    };
  }

  #record(event) {
    if (!this.eventLogPath) return;
    mkdirSync(dirname(this.eventLogPath), { recursive: true });
    appendFileSync(this.eventLogPath, `${JSON.stringify({ ...event, recordedAt: new Date().toISOString() })}\n`, "utf8");
  }
}
