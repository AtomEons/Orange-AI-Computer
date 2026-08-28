#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..', '..');
const atomicRoot = join(repositoryRoot, '02-ATOMIC-ORANGE-V1');
const manifestPath = join(atomicRoot, 'LICENSES', 'source-license-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function read(relativePath) {
  return readFileSync(join(atomicRoot, relativePath), 'utf8');
}

function sha256(relativePath) {
  return createHash('sha256').update(readFileSync(join(atomicRoot, relativePath))).digest('hex');
}

function packageMetadata(component) {
  const source = read(component.manifest.path);
  if (component.manifest.format === 'package-json') {
    const parsed = JSON.parse(source);
    return {
      name: parsed.name,
      version: parsed.version,
      license: parsed.license,
      author: typeof parsed.author === 'string' ? parsed.author : parsed.author?.name,
    };
  }
  if (component.manifest.format === 'cargo-toml') {
    const parsed = Bun.TOML.parse(source).package;
    return {
      name: parsed.name,
      version: parsed.version,
      license: parsed.license,
      authors: parsed.authors,
    };
  }
  throw new Error(`Unsupported manifest format: ${component.manifest.format}`);
}

describe('Atomic Orange source license manifest', () => {
  test('keeps the audit private, source-only, and explicitly not cleared for redistribution', () => {
    expect(manifest.repository.visibility).toBe('private');
    expect(manifest.repository.parentTrackingAtAudit).toBe('untracked');
    expect(manifest.scope.kind).toBe('source-only');
    expect(manifest.scope.redistributionStatus).toBe('not-cleared');
    expect(manifest.repositoryFallback.license).toBe('Apache-2.0');
    expect(manifest.repositoryFallback.note).toContain('not a claim that every file');
  });

  test('matches every package-backed license claim to its current JSON or TOML manifest', () => {
    for (const component of manifest.components) {
      const actual = packageMetadata(component);
      expect(actual.name).toBe(component.manifest.packageName);
      expect(actual.version).toBe(component.manifest.version);
      expect(actual.license).toBe(component.manifest.declaredLicense);
      expect(component.license).toBe(component.manifest.declaredLicense);
      if (component.manifest.author) expect(actual.author).toBe(component.manifest.author);
      if (component.manifest.authors) expect(actual.authors).toEqual(component.manifest.authors);
    }
  });

  test('contains the exact Jan AGPL set and only manifest-established MIT entries', () => {
    const agplNames = manifest.components
      .filter((component) => component.license === 'AGPL-3.0')
      .map((component) => component.manifest.packageName)
      .sort();
    expect(agplNames).toEqual([
      '@janhq/assistant-extension',
      '@janhq/core',
      '@janhq/download-extension',
      '@janhq/foundation-models-extension',
      '@janhq/llamacpp-extension',
      '@janhq/llamacpp-upstream-extension',
      '@janhq/mlx-extension',
      '@janhq/rag-extension',
      '@janhq/vector-db-extension',
    ]);

    const mitNames = manifest.components
      .filter((component) => component.license === 'MIT')
      .map((component) => component.manifest.packageName)
      .sort();
    expect(mitNames).toEqual([
      '@janhq/conversational-extension',
      'Atomic-Chat',
      'tauri-plugin-foundation-models',
      'tauri-plugin-hardware',
      'tauri-plugin-llamacpp',
      'tauri-plugin-llamacpp-upstream',
      'tauri-plugin-mlx',
      'tauri-plugin-rag',
      'tauri-plugin-vector-db',
    ]);
  });

  test('pins each canonical license text by hash and records its source', () => {
    for (const license of manifest.licenses) {
      expect(sha256(license.textPath)).toBe(license.textSha256);
      expect(license.textProvenance.retrievedAt).toBe('2026-08-27');
      expect(license.textProvenance.sourcePath ?? license.textProvenance.url).toBeTruthy();
    }
    expect(read('LICENSES/Apache-2.0.txt')).toContain('Apache License');
    expect(read('LICENSES/AGPL-3.0.txt')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(read('LICENSES/MIT.txt')).toContain('Permission is hereby granted');
  });

  test('keeps unresolved payload classes and the unlicensed Cargo package excluded', () => {
    const pending = new Map(manifest.excludedAndPending.map((entry) => [entry.id, entry]));
    for (const id of [
      'unresolved-binaries-and-archives',
      'unresolved-fonts',
      'unresolved-media-and-brand-assets',
      'unlicensed-nested-source-package',
      'third-party-static-bundle',
      'dependencies-and-generated-output',
    ]) {
      expect(pending.has(id)).toBe(true);
    }
    expect(pending.get('unresolved-binaries-and-archives').pathPatterns).toContain('src-tauri/resources/bin/**');
    expect(pending.get('unresolved-fonts').pathPatterns).toContain('web-app/public/fonts/**');
    expect(pending.get('unresolved-media-and-brand-assets').pathPatterns).toContain('src-tauri/icons/**');
    expect(pending.get('unlicensed-nested-source-package').pathPatterns).toEqual(['src-tauri/utils/**']);

    const utils = Bun.TOML.parse(read('src-tauri/utils/Cargo.toml')).package;
    expect(utils.name).toBe('jan-utils');
    expect(utils.license).toBeUndefined();
  });

  test('NOTICE preserves the same limits and provenance entry points', () => {
    const notice = read('NOTICE');
    expect(notice).toContain('Not cleared for redistribution');
    expect(notice).toContain('they are not a release');
    expect(notice).toContain('src-tauri/utils Cargo package has');
    expect(notice).toContain('https://www.gnu.org/licenses/agpl-3.0.txt');
    expect(notice).toContain('https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt');
  });
});
