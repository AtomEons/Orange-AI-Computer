import { describe, expect, test } from 'bun:test';
import { compileModelResponse, exactRequestedText, removeVisibleReasoning } from './response-compiler.mjs';

describe('Orange final-output compiler', () => {
  test('recognizes an explicit exact-output contract', () => {
    expect(exactRequestedText([{ role: 'user', content: 'Return exactly: ORANGE_OK' }])).toBe('ORANGE_OK');
  });

  test('removes tagged private reasoning', () => {
    expect(removeVisibleReasoning('<think>private</think>\nFinal answer')).toBe('Final answer');
  });

  test('repairs narrated exact output deterministically', () => {
    const payload = { choices: [{ finish_reason: 'length', message: { content: 'We should return ORANGE_OK' } }] };
    const result = compileModelResponse(payload, [{ role: 'user', content: 'Return exactly: ORANGE_OK' }]);
    expect(result).toEqual({ repaired: true, reason: 'explicit_exact_output_contract' });
    expect(payload.choices[0].message.content).toBe('ORANGE_OK');
    expect(payload.choices[0].finish_reason).toBe('stop');
  });

  test('leaves a compliant exact output untouched', () => {
    const payload = { choices: [{ finish_reason: 'stop', message: { content: 'ORANGE_OK' } }] };
    expect(compileModelResponse(payload, [{ role: 'user', content: 'Return exactly: ORANGE_OK' }])).toEqual({ repaired: false, reason: 'explicit_exact_output_contract' });
    expect(payload.ae_output_compiler).toBeUndefined();
  });
});
