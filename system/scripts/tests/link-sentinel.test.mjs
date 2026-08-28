#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { classifyLinkState, nextReconnectDelay } from '../orange5-link-sentinel.mjs';

describe('OrangeFive Link Sentinel', () => {
  test('uses bounded exponential reconnect backoff', () => {
    expect(nextReconnectDelay(0)).toBe(2_000);
    expect(nextReconnectDelay(3)).toBe(16_000);
    expect(nextReconnectDelay(99)).toBe(120_000);
  });

  test('reports healthy only when every governed bridge is healthy', () => {
    expect(classifyLinkState({ eyes: { healthy: true }, qdrant: { healthy: true } })).toBe('healthy');
    expect(classifyLinkState({ eyes: { healthy: false, status: 'reconnecting' }, qdrant: { healthy: true } })).toBe('reconnecting');
    expect(classifyLinkState({ eyes: { healthy: false, status: 'degraded' }, qdrant: { healthy: true } })).toBe('degraded');
  });
});
