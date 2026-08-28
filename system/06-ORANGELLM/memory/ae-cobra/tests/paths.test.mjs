#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test';
import { canonicalFluxRoot } from '../paths.mjs';

describe('Cobra canonical Flux root', () => {
  test('prefers the Cobra-specific environment override', () => {
    expect(canonicalFluxRoot({ AE_COBRA_FLUX_ROOT: 'C:\\memory\\cobra', AE_FLUX_ROOT: 'C:\\other' }, 'win32', 'C:\\Users\\a')).toBe('C:\\memory\\cobra');
  });

  test('falls back to the shared Flux override', () => {
    expect(canonicalFluxRoot({ AE_FLUX_ROOT: 'C:\\memory\\shared' }, 'win32', 'C:\\Users\\a')).toBe('C:\\memory\\shared');
  });

  test('uses persistent OrangeBox-Data on Windows', () => {
    expect(canonicalFluxRoot({}, 'win32', 'C:\\Users\\a')).toBe('C:\\Users\\a\\OrangeBox-Data\\orange5\\ae-cobra-flux');
  });

  test('uses the mounted Flux volume on non-Windows hosts', () => {
    expect(canonicalFluxRoot({}, 'linux', '/home/atom')).toBe('/mnt/ae_flux');
  });
});

