import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  SYSTEMS_LAW_SOURCE,
  SYSTEMS_LAW_STATUS,
  SystemsLawRegistryError,
  hashSystemsLawValue,
  loadSystemsDesignLawRegistry,
  parseGadMechanisms,
} from '../systems-law/index.mjs';

describe('systems design law registry', () => {
  test('loads exactly 60 records while preserving the accepted 35 mechanisms', () => {
    const registry = loadSystemsDesignLawRegistry();
    const gad = registry.records.filter((record) => record.family === 'gad-mechanism');
    const supplemental = registry.records.filter((record) => record.family === 'wave3-global-mechanism');
    const decisions = registry.records.filter((record) => record.family === 'alpha-adoption-decision');

    expect(registry.records).toHaveLength(60);
    expect(gad).toHaveLength(35);
    expect(supplemental).toHaveLength(13);
    expect(decisions).toHaveLength(12);
    expect(gad.map((record) => record.id)).toEqual(
      Array.from({ length: 35 }, (_, index) => `GAD-${String(index + 1).padStart(3, '0')}`),
    );
    expect(hashSystemsLawValue(gad)).toBe('b13097b1ed84d32c35fdcca3fe4f7c980f54fc82920d9a7ed45f59e26ef6ba7a');
    expect(supplemental.map((record) => record.id)).toEqual(
      Array.from({ length: 13 }, (_, index) => `GAD-${String(index + 36).padStart(3, '0')}`),
    );
    expect(decisions.map((record) => record.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `GSA-${String(index + 1).padStart(3, '0')}`),
    );
    expect(registry.sources).toEqual([
      { document: SYSTEMS_LAW_SOURCE.GAD.document, sha256: SYSTEMS_LAW_SOURCE.GAD.sha256 },
      { document: SYSTEMS_LAW_SOURCE.ADOPTION.document, sha256: SYSTEMS_LAW_SOURCE.ADOPTION.sha256 },
      {
        document: SYSTEMS_LAW_SOURCE.RESEARCH_GROUNDING.document,
        sha256: SYSTEMS_LAW_SOURCE.RESEARCH_GROUNDING.sha256,
      },
    ]);
    expect(registry.registryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.records)).toBe(true);
  });

  test('keeps all 13 supplemental mechanisms source-attributed and non-authoritative', () => {
    const registry = loadSystemsDesignLawRegistry();
    const supplemental = registry.records.filter((record) => record.family === 'wave3-global-mechanism');
    const interference = supplemental.find((record) => record.id === 'GAD-036');
    const activePerception = supplemental.find((record) => record.id === 'GAD-037');
    const promptCompression = supplemental.find((record) => record.id === 'GAD-047');

    expect(supplemental).toHaveLength(13);
    expect(supplemental.every((record) => record.status === SYSTEMS_LAW_STATUS.RESEARCH)).toBe(true);
    expect(supplemental.every((record) => record.runtimeAuthority === 'none')).toBe(true);
    expect(supplemental.every((record) => record.sourceDecision === 'RESEARCH_ONLY')).toBe(true);
    expect(supplemental.every((record) => record.failureThreshold === record.rejectThreshold)).toBe(true);
    expect(supplemental.every((record) => record.receiptRefs.length === 0)).toBe(true);
    expect(interference.provenance.attribution).toContain('Owicki-Gries');
    expect(interference.evidenceRefs).toContainEqual(expect.objectContaining({
      ref: 'https://doi.org/10.1007/BF00268134',
    }));
    expect(activePerception.provenance.attribution).toContain('Renata Bajcsy');
    expect(promptCompression.provenance.attribution).toContain('Lili Qiu');
    expect(promptCompression.evidenceRefs).toContainEqual(expect.objectContaining({
      ref: 'https://arxiv.org/abs/2310.05736',
    }));
  });

  test('keeps every GAD mechanism non-authoritative and preserves source attribution', () => {
    const registry = loadSystemsDesignLawRegistry();
    const gad = registry.records.filter((record) => record.family === 'gad-mechanism');
    const hoover = gad.find((record) => record.id === 'GAD-001');
    const sinh = gad.find((record) => record.id === 'GAD-014');
    const community = gad.find((record) => record.id === 'GAD-032');

    expect(gad.every((record) => record.status === SYSTEMS_LAW_STATUS.RESEARCH)).toBe(true);
    expect(gad.every((record) => record.runtimeAuthority === 'none')).toBe(true);
    expect(hoover.provenance.attribution).toContain("Hoover's work at Bell Labs");
    expect(hoover.provenance.attribution).toContain('larger No. 1 ESS team effort');
    expect(hoover.evidenceRefs).toContainEqual(expect.objectContaining({
      ref: 'https://www.invent.org/inductees/erna-schneider-hoover',
    }));
    expect(sinh.title).toContain('Ho\u00e0ng Xu\u00e2n S\u00ednh');
    expect(community.provenance.attribution).toContain('Te Hiku Media');
  });

  test('materializes all required law fields and explicit empty receipt sets', () => {
    const registry = loadSystemsDesignLawRegistry();
    const requiredStrings = [
      'id',
      'title',
      'invariant',
      'owner',
      'enforcementPoint',
      'falsifier',
      'rejectThreshold',
      'status',
    ];

    for (const record of registry.records) {
      for (const field of requiredStrings) expect(record[field].trim().length).toBeGreaterThan(0);
      expect(record.provenance.sourceDocument).toMatch(/^(?:00-CHARTER\/GUIDES|01-DOCTRINE)\//);
      expect(record.provenance.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(record.provenance.lineStart).toBeGreaterThan(0);
      expect(record.provenance.lineEnd).toBeGreaterThanOrEqual(record.provenance.lineStart);
      expect(record.evidenceRefs.length).toBeGreaterThan(0);
      expect(Array.isArray(record.receiptRefs)).toBe(true);
      expect((record.failureThreshold ?? record.rejectThreshold).trim().length).toBeGreaterThan(0);
    }

    const sourceView = registry.records.find((record) => record.id === 'GSA-007');
    expect(sourceView.receiptRefs).toEqual([
      '../../10-RECEIPTS/orange5-build/2026-08-27T16-42-16-141Z-memory-quality-benchmark.json',
    ]);
  });

  test('normalizes only reviewed invariant and shadow decisions into runtime authority', () => {
    const registry = loadSystemsDesignLawRegistry();
    const statusById = Object.fromEntries(registry.records.map((record) => [record.id, record.status]));

    expect(statusById['GSA-007']).toBe(SYSTEMS_LAW_STATUS.ACTIVE);
    expect(statusById['GSA-008']).toBe(SYSTEMS_LAW_STATUS.SHADOW);
    expect(statusById['GSA-010']).toBe(SYSTEMS_LAW_STATUS.SHADOW);
    expect(statusById['GSA-009']).toBe(SYSTEMS_LAW_STATUS.ARCHIVED);
    expect(statusById['GSA-012']).toBe(SYSTEMS_LAW_STATUS.ARCHIVED);
    expect(statusById['GSA-001']).toBe(SYSTEMS_LAW_STATUS.RESEARCH);
    expect(statusById['GSA-004']).toBe(SYSTEMS_LAW_STATUS.RESEARCH);
  });

  test('fails closed when a required GAD source field disappears', () => {
    const source = readFileSync(SYSTEMS_LAW_SOURCE.GAD.path, 'utf8');
    const malformed = source.replace('**Mechanism.** Closed-loop admission control', '**Candidate.** Closed-loop admission control');

    expect(() => parseGadMechanisms(malformed)).toThrow(SystemsLawRegistryError);
    try {
      parseGadMechanisms(malformed);
    } catch (error) {
      expect(error.code).toBe('SOURCE_FORMAT_MISMATCH');
      expect(error.message).toContain('GAD-001');
    }
  });

  test('produces the same registry hash on repeated loads', () => {
    const first = loadSystemsDesignLawRegistry();
    const second = loadSystemsDesignLawRegistry();
    expect(second.registryHash).toBe(first.registryHash);
    expect(second.records).toEqual(first.records);
  });
});
