#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import {
  sendLocalAEPhaseEnvelope,
  waitForAEPhaseEnvelope,
} from "../03-BACKEND/ae-phase-fabric.mjs";

async function readInput() {
  const inline = process.argv.slice(2).join(" ").trim();
  const raw = inline || await Bun.stdin.text();
  if (!raw.trim()) throw new Error("AE Phase order requires orange.order.v1 JSON on stdin or argv");
  return JSON.parse(raw);
}

const order = await readInput();
if (order.schema && order.schema !== "orange.order.v1") throw new Error("AE Phase order schema must be orange.order.v1");
if (!order.action || !order.intent) throw new Error("AE Phase order requires action and intent");

const orderId = order.orderId || `phase-order-${randomUUID()}`;
const targetRoles = Array.isArray(order.targetRoles) && order.targetRoles.length
  ? order.targetRoles
  : ["orange-hermes-navigator"];
const deterministicAction = /(?:^|\.)(?:health|status|report|route|list|inspect|snapshot|ping)$/i.test(order.action);
const requiresModel = typeof order.requiresModel === "boolean" ? order.requiresModel : !deterministicAction;
const envelopeId = `ae-staff-order-${randomUUID()}`;
const event = {
  id: `ae-staff-event-${randomUUID()}`,
  type: "staff.order",
  topic: order.action,
  summary: order.intent,
  body: order.intent,
  projectId: order.targetProject || "Orange5",
  correlationId: orderId,
  order: { ...order, schema: "orange.order.v1", orderId },
  roleOrders: {},
  authority: order.authority || "operator",
  custody: order.custody || { state: "STARTED", owner: "orange-hermes-navigator", leaseId: orderId },
  cancellation: order.cancellation || { supported: true, requested: false },
  commitments: Array.isArray(order.commitments) ? order.commitments : [order.intent],
  sourceRefs: Array.isArray(order.evidence) ? order.evidence : [],
  targetRoles,
  requiresModel,
};

const sent = await sendLocalAEPhaseEnvelope({
  id: envelopeId,
  kind: "ae_staff_order",
  correlationId: orderId,
  body: { event },
});
const response = await waitForAEPhaseEnvelope({
  kind: "ae_staff_report",
  correlationId: envelopeId,
}, { timeoutMs: Number(process.env.ORANGE5_AE_PHASE_ORDER_TIMEOUT_MS || 240_000) });

const result = {
  schema: "orange.ae-phase.order-result.v1",
  ok: response.body?.ok === true,
  transport: "ae-phase",
  orderId,
  request: sent,
  response: {
    id: response.id,
    bodyHash: response.bodyHash,
    receivedAt: response.receivedAt,
    sender: response.sender,
  },
  report: response.body,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
