import { describe, expect, test } from 'bun:test';
import { DEFAULT_ORANGEBRAIN_URL, resolveOrangeBrainUrl } from '../brain-endpoint.mjs';

describe('OrangeBrain endpoint authority', () => {
  test('uses the canonical loopback seam when the environment is absent', () => {
    expect(resolveOrangeBrainUrl({})).toBe(DEFAULT_ORANGEBRAIN_URL);
  });

  test('allows an explicit endpoint override and removes trailing slashes', () => {
    expect(resolveOrangeBrainUrl({ ORANGE5_ORANGEBRAIN_URL: 'http://127.0.0.1:91337///' }))
      .toBe('http://127.0.0.1:91337');
  });

  test('blank configuration cannot disable the canonical gateway', () => {
    expect(resolveOrangeBrainUrl({ ORANGE5_ORANGEBRAIN_URL: '   ' }))
      .toBe(DEFAULT_ORANGEBRAIN_URL);
  });
});
