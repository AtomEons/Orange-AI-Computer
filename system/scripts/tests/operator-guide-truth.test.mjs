#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..', '..');
const charterRoot = join(repositoryRoot, '00-CHARTER');
const guidesRoot = join(charterRoot, 'GUIDES');
const receiptRoot = join(repositoryRoot, '10-RECEIPTS', 'orange5-build');

const documentationPaths = [
  ...readdirSync(guidesRoot)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(guidesRoot, name)),
  join(charterRoot, 'ORANGEFIVE_HOW_TO_USE.md'),
  join(charterRoot, 'ORANGE5_NOT_GREEN_LEDGER.md'),
];

function read(path) {
  return readFileSync(path, 'utf8');
}

function receipt(name) {
  return JSON.parse(read(join(receiptRoot, name)));
}

describe('OrangeFive operator documentation truth', () => {
  test('retired names, frozen verifier totals, and false no-gap claims stay out', () => {
    const combined = documentationPaths.map(read).join('\n');
    expect(combined).not.toMatch(/smart[- ]skinny/i);
    expect(combined).not.toMatch(/hot-v1/i);
    expect(combined).not.toContain('138/138');
    expect(combined).not.toMatch(/no active gaps/i);
    expect(combined).not.toMatch(/none proven by the current verifier/i);
  });

  test('the current ledger preserves exact claim boundaries', () => {
    const ledger = read(join(charterRoot, 'ORANGE5_NOT_GREEN_LEDGER.md'));
    expect(ledger).toContain('orange5.not-green-ledger.v3');
    expect(ledger).toContain('**Status:** OPEN');
    expect(ledger).toContain('orange-navigator:ornith-1.5-9b-q4km');
    expect(ledger).toContain('Retired Q8 Navigator');
    expect(ledger).toContain('10 tools over stdio');
    expect(ledger).toContain('12 over authenticated loopback Streamable HTTP');
    expect(ledger).toContain('minimum held-out ratio `1422.901x`');
    expect(ledger).toContain('`59.439x` operational context ratio');
    expect(ledger).toContain('23/23 cases; hybrid MRR `0.9348`');
    expect(ledger).toMatch(/technically valid[\s\S]*studio quality is not certified/i);
    expect(ledger).toMatch(/Hermes Brain MCP delegation[\s\S]*9395\.53 ms/i);
    expect(ledger).toContain('2026-08-27T17-31-43-840Z-brain-mcp-delegation-live-proof.json');
    expect(ledger).toContain('Current Q4KM authority');
  });

  test('the accepted receipts support the documented current snapshot', () => {
    const mcp = receipt('2026-08-27T08-25-01-953Z-brain-mcp-dual-transport-proof.json');
    expect(mcp.status).toBe('ORANGE5_BRAIN_MCP_DUAL_TRANSPORT_GREEN');
    expect(mcp.transports.stdio.toolCount).toBe(10);
    expect(mcp.transports.streamableHttp.toolCount).toBe(12);
    expect(mcp.observedHealth.codexa).toMatchObject({
      host: '10.0.0.4',
      authorized: true,
      executable: true,
    });

    const integrated = receipt('2026-08-27T08-25-23-337Z-integrated-operational-proof.json');
    expect(integrated.status).toBe('ORANGEFIVE_INTEGRATED_OPERATIONAL_GREEN');
    expect(integrated.operational_green).toBe(true);
    expect(integrated.groups.runtime.health.activeBrain).toMatchObject({
      model: 'orange-navigator:ornith-1.5-9b-q8',
      host: '10.0.0.4',
      live: true,
    });
    expect(integrated.groups.context_crystal.cases).toBe('5/5');
    expect(integrated.groups.context_crystal.ratios.minimum).toBeCloseTo(1422.901, 3);
    expect(integrated.groups.runtime.live_turn.context_crystal.operational_context_ratio).toBeCloseTo(59.439, 3);
    expect(integrated.groups.memory.cases).toBe('23/23');
    expect(integrated.groups.memory.mrr).toBeCloseTo(0.9348, 4);
    expect(integrated.groups.captain_planet.runtime_functional).toBe(true);
    expect(integrated.groups.captain_planet.studio_quality_proven).toBe(false);

    const concurrent = receipt('2026-08-27T08-30-30-809Z-integrated-operational-proof.json');
    expect(concurrent.status).toBe('ORANGEFIVE_INTEGRATED_OPERATIONAL_NEEDS_WORK');
    expect(concurrent.operational_green).toBe(false);
    expect(concurrent.blockers).toContain('runtime integrated proof failed');
    expect(concurrent.blockers).toContain('context_crystal integrated proof failed');

    const q4 = receipt('2026-08-27T08-28-38-785Z-context-crystal-quality-parity.json');
    expect(q4.requested_model).toBe('orange-navigator:ornith-1.5-9b-q4km-candidate');
    expect(q4.canonical_default_model).toBe('orange-navigator:ornith-1.5-9b-q8');
    expect(q4.cases_executed).toBe(1);
    expect(q4.cases_total).toBe(1);

    const hermes = receipt('2026-08-27T17-31-43-840Z-brain-mcp-delegation-live-proof.json');
    expect(hermes.status).toBe('ORANGE5_BRAIN_MCP_DELEGATION_GREEN');
    expect(Object.values(hermes.checks).every(Boolean)).toBe(true);
  });
});
