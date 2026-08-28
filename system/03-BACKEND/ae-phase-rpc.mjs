#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import {
  sendLocalAEPhaseEnvelope,
  waitForAEPhaseEnvelope,
} from './ae-phase-fabric.mjs';

function safeKind(value) {
  const kind = String(value || '').trim();
  if (!/^[a-z][a-z0-9_]{1,47}$/.test(kind)) throw new Error(`Invalid AE Phase RPC kind: ${kind}`);
  return kind;
}

export async function callAEPhase({
  requestKind,
  responseKind,
  body = null,
  timeoutMs = 30_000,
  destinationSender = null,
} = {}) {
  const request = safeKind(requestKind);
  const response = safeKind(responseKind);
  const requestId = `${request.replace(/_/g, '-')}-${randomUUID()}`;
  const sinceAt = new Date(Date.now() - 1_000).toISOString();
  const sent = await sendLocalAEPhaseEnvelope({
    id: requestId,
    kind: request,
    correlationId: requestId,
    body,
  }, { destinationSender });
  const report = await waitForAEPhaseEnvelope({
    kind: response,
    correlationId: requestId,
    sinceAt,
  }, { timeoutMs });
  return {
    body: report.body,
    phase: {
      schema: 'orange.ae-phase.rpc-evidence.v1',
      transport: 'ae-phase',
      requestEnvelopeId: sent.id,
      requestBodyHash: sent.bodyHash,
      responseEnvelopeId: report.id,
      responseBodyHash: report.bodyHash,
      node: report.nodeId || null,
      sender: report.sender || null,
    },
  };
}

