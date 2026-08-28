#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import {
  readAEPhaseEnvelopes,
  sendLocalAEPhaseEnvelope,
} from './ae-phase-fabric.mjs';

export const AE_PHASE_MODEL_REQUEST_SCHEMA = 'orange.ae-phase.model-request.v1';
export const AE_PHASE_MODEL_REPORT_SCHEMA = 'orange.ae-phase.model-report.v1';
export const AE_PHASE_MODEL_QUERY_SCHEMA = 'orange.ae-phase.model-query.v1';

const MODEL_TIERS = new Set(['navigator', 'code', 'heavy', 'visual', 'embedding', 'reranker']);

function clean(value, max = 128) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeTier(value) {
  const tier = clean(value || 'navigator', 32).toLowerCase();
  if (!MODEL_TIERS.has(tier)) throw new Error(`Unsupported AE Phase model tier: ${tier}`);
  return tier;
}

function normalizeRequestBody(body, model, stream) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('AE Phase model request body must be an object');
  }
  if (!Array.isArray(body.messages)) throw new Error('AE Phase model request requires messages');
  return {
    ...body,
    model,
    stream,
    think: false,
    reasoning_effort: 'none',
    reasoning: { effort: 'none' },
  };
}

function matchingRows(requestId, sinceAt, seen) {
  return readAEPhaseEnvelopes({ correlationId: requestId, sinceAt, limit: 10_000 })
    .filter((row) => !seen.has(row.id))
    .sort((a, b) => String(a.receivedAt || a.createdAt).localeCompare(String(b.receivedAt || b.createdAt)));
}

function phaseFailure(message, detail = null, status = 502) {
  return {
    status,
    body: {
      error: {
        message,
        type: 'upstream_error',
        code: 'ae_phase_model_failure',
        ...(detail ? { detail } : {}),
      },
    },
    streamed: false,
  };
}

export async function requestAEPhaseModel({
  tier = 'navigator',
  model,
  body,
  onChunk = null,
  timeoutMs = 240_000,
} = {}) {
  const normalizedTier = normalizeTier(tier);
  const normalizedModel = clean(model || body?.model, 160);
  if (!normalizedModel) throw new Error('AE Phase model request requires a model');
  const requestId = `ae-model-request-${randomUUID()}`;
  const sinceAt = new Date(Date.now() - 1_000).toISOString();
  const stream = body?.stream === true && typeof onChunk === 'function';
  const requestBody = normalizeRequestBody(body, normalizedModel, stream);
  const sent = await sendLocalAEPhaseEnvelope({
    id: requestId,
    kind: 'ae_model_request',
    correlationId: requestId,
    body: {
      schema: AE_PHASE_MODEL_REQUEST_SCHEMA,
      requestId,
      tier: normalizedTier,
      model: normalizedModel,
      stream,
      request: requestBody,
      timeoutMs: Math.max(1_000, Math.min(900_000, Number(timeoutMs || 240_000))),
      requestedAt: new Date().toISOString(),
    },
  });

  const seen = new Set();
  const pendingDeltas = new Map();
  let expectedDelta = 0;
  let terminal = null;
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs || 240_000));

  const emitReady = async () => {
    while (pendingDeltas.has(expectedDelta)) {
      const delta = pendingDeltas.get(expectedDelta);
      pendingDeltas.delete(expectedDelta);
      for (const chunk of delta.body?.chunks || []) await onChunk?.(chunk);
      expectedDelta += 1;
    }
  };

  while (Date.now() < deadline) {
    for (const row of matchingRows(requestId, sinceAt, seen)) {
      seen.add(row.id);
      if (row.kind === 'ae_model_delta') {
        const index = Number(row.body?.index);
        if (Number.isInteger(index) && index >= 0) pendingDeltas.set(index, row);
      } else if (row.kind === 'ae_model_report') {
        terminal = row;
      }
    }
    await emitReady();
    const expectedCount = Number(terminal?.body?.deltaCount || 0);
    if (terminal && expectedDelta >= expectedCount) {
      const report = terminal.body || {};
      if (!report.ok) {
        return phaseFailure(report.error || 'Codexa model lease failed', {
          requestEnvelopeId: sent.id,
          reportEnvelopeId: terminal.id,
          transport: 'ae-phase',
        }, Number(report.httpStatus || 502));
      }
      return {
        status: 200,
        body: report.response,
        streamed: stream && expectedDelta > 0,
        phase: {
          schema: AE_PHASE_MODEL_REPORT_SCHEMA,
          transport: 'ae-phase',
          requestEnvelopeId: sent.id,
          requestBodyHash: sent.bodyHash,
          reportEnvelopeId: terminal.id,
          reportBodyHash: terminal.bodyHash,
          deltaCount: expectedDelta,
          durationMs: Number(report.durationMs || 0),
          node: terminal.nodeId || 'CODEXA',
        },
      };
    }
    await Bun.sleep(15);
  }

  return phaseFailure(`AE Phase model request timed out after ${timeoutMs}ms`, {
    requestEnvelopeId: sent.id,
    receivedDeltaCount: expectedDelta,
    transport: 'ae-phase',
  }, 504);
}

export async function probeAEPhaseModel({ tier = 'navigator', model, timeoutMs = 3_000 } = {}) {
  const normalizedTier = normalizeTier(tier);
  const requestId = `ae-model-query-${randomUUID()}`;
  const sinceAt = new Date(Date.now() - 1_000).toISOString();
  const sent = await sendLocalAEPhaseEnvelope({
    id: requestId,
    kind: 'ae_model_query',
    correlationId: requestId,
    body: {
      schema: AE_PHASE_MODEL_QUERY_SCHEMA,
      operation: 'health',
      tier: normalizedTier,
      model: clean(model, 160) || null,
    },
  });
  const deadline = Date.now() + Math.max(250, Number(timeoutMs || 3_000));
  while (Date.now() < deadline) {
    const report = readAEPhaseEnvelopes({
      kind: 'ae_model_query_report',
      correlationId: requestId,
      sinceAt,
      limit: 1,
    })[0];
    if (report) {
      return {
        ...report.body,
        transport: 'ae-phase',
        requestEnvelopeId: sent.id,
        reportEnvelopeId: report.id,
      };
    }
    await Bun.sleep(15);
  }
  return {
    ok: false,
    live: false,
    status: 'phase_timeout',
    tier: normalizedTier,
    model: clean(model, 160) || null,
    transport: 'ae-phase',
    requestEnvelopeId: sent.id,
  };
}

