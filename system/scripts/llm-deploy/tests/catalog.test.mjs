#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildDiscovery, expectedModelIntegrityFiles, mergeCatalogAcquisition, readJson, sha256 } from '../deploy-core.mjs';
import { __probeInternals } from '../deploy-probes.mjs';

const sourceRoot = path.resolve(import.meta.dir, '..', '..', '..');
const manifest = readJson(path.join(sourceRoot, '00-CHARTER', 'LLM-DEPLOY', 'orangefive.deploy.json'));
const catalogPath = path.resolve(sourceRoot, manifest.models.catalog);
const acquisitionPath = path.resolve(sourceRoot, manifest.models.acquisitionCatalog);
const baseCatalog = readJson(catalogPath);
const acquisitionCatalog = readJson(acquisitionPath);
const sourceCatalogSha256 = sha256(readFileSync(catalogPath));

describe('OrangeFive evidence-backed model acquisition catalog', () => {
  test('is bound to the exact source registry and covers every role', () => {
    expect(acquisitionCatalog.sourceCatalogSha256).toBe(sourceCatalogSha256);
    expect(acquisitionCatalog.roles.map((role) => role.role).sort()).toEqual(baseCatalog.roles.map((role) => role.role).sort());
    expect(() => mergeCatalogAcquisition(baseCatalog, acquisitionCatalog, { sourceCatalogSha256: '0'.repeat(64) })).toThrow('stale');
  });

  test('promotes only locally evidenced acquisition records with pinned upstream files', () => {
    const catalog = mergeCatalogAcquisition(baseCatalog, acquisitionCatalog, { sourceCatalogSha256 });
    const qwen = catalog.roles.find((role) => role.role === 'speech_qwen3_tts');
    const ace = catalog.roles.find((role) => role.role === 'music_ace_step15');
    const flux = catalog.roles.find((role) => role.role === 'image_draft_flux2_klein');
    const ltx = catalog.roles.find((role) => role.role === 'video_fallback_ltxv098');
    for (const role of [qwen, ace, flux, ltx]) {
      expect(role.provenanceStatus).toBe('verified-local-artifact');
      expect(role.redistribution).toBe('upstream-download-only');
      expect(role.runtimeProvisioning).toBe('adopt-only');
      expect(role.provenanceBlockers).toEqual([]);
      expect(role.acquisition.files.length).toBeGreaterThan(0);
      const integrity = expectedModelIntegrityFiles(role);
      expect(integrity.issues).toEqual([]);
      expect(integrity.files.length).toBeGreaterThan(0);
      for (const file of role.acquisition.files) {
        const revision = file.sourceRevision || role.acquisition.revision;
        expect(revision).toMatch(/^[a-f0-9]{40,64}$/);
        expect(file.url).toContain(`/resolve/${revision}/`);
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.bytes).toBeGreaterThan(0);
      }
      for (const file of integrity.files) {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.bytes).toBeGreaterThan(0);
      }
    }
    expect(qwen.license).toBe('Apache-2.0');
    expect(ace.license).toBe('MIT');
    expect(flux.license).toBe('Apache-2.0');
    expect(ltx.license).toBe('LTXV Open Weights License 0.X');
    expect(flux.observedArtifacts.length).toBe(3);
    expect(ltx.observedArtifacts.length).toBe(4);
  });

  test('keeps the Codexa checksum probe below the Windows command-line ceiling', () => {
    const catalog = mergeCatalogAcquisition(baseCatalog, acquisitionCatalog, { sourceCatalogSha256 });
    const script = __probeInternals.remoteProbeScript(catalog, '0.20.5');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    expect(encoded.length).toBeLessThan(24_000);
  });

  test('accepts independently pinned repositories per model file', () => {
    const catalog = mergeCatalogAcquisition(baseCatalog, acquisitionCatalog, { sourceCatalogSha256 });
    const discovery = buildDiscovery({
      sourceRoot,
      dataRoot: path.join(sourceRoot, '..', 'llm-deploy-catalog-test-state'),
      manifest,
      catalog,
      observed: {
        control: { ramBytes: 16 * (1024 ** 3), logicalCores: 4, disk: { availableBytes: 100 * (1024 ** 3) } },
        componentInventory: {
          control: {
            bun: { found: true, compatible: true, version: '1.3.14', node: 'control' },
            ollama: { found: false, compatible: false, node: 'control' },
            'hermes-agent': { found: false, compatible: false, node: 'control' },
          },
        },
        modelInventory: { control: {} },
      },
    });
    const verified = discovery.optionalModels.filter((role) => role.provenanceStatus === 'verified-local-artifact');
    expect(verified.every((role) => role.acquisitionPinned)).toBe(true);
    expect(verified.find((role) => role.role === 'image_draft_flux2_klein').acquisition.files.map((file) => file.repository)).toContain('Comfy-Org/flux2-dev');
    expect(verified.find((role) => role.role === 'video_fallback_ltxv098').acquisition.files.map((file) => file.repository)).toContain('PixArt-alpha/PixArt-XL-2-1024-MS');
  });

  test('budgets remote checksum proof beyond SSH startup', () => {
    expect(__probeInternals.remoteProbeTimeoutMs(900)).toBe(120_000);
    expect(__probeInternals.remoteProbeTimeoutMs(20_000)).toBe(160_000);
  });
});
