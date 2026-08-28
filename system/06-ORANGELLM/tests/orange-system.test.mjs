import { describe, expect, test } from 'bun:test';
import {
  compactNoEvidenceNavigatorMessages,
  injectOrangeSystem,
  ORANGE_NAVIGATOR_COMPACT_SYSTEM,
  ORANGE_RUNTIME_CAPABILITY_MARKER,
  ORANGE_SYSTEM_MARKER,
} from '../server/orange-system.mjs';

describe('Orange gateway doctrine injection', () => {
  test('injects doctrine before ordinary chat', () => {
    const result = injectOrangeSystem([{ role: 'user', content: 'hello' }]);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toContain(ORANGE_SYSTEM_MARKER);
    expect(result[0].content).toContain(ORANGE_RUNTIME_CAPABILITY_MARKER);
    expect(result[0].content).toContain('memory.recall=POST /v1/memory/recall');
    expect(result[1].content).toBe('hello');
  });

  test('preserves and subordinates client system instructions', () => {
    const result = injectOrangeSystem([{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: 'go' }]);
    expect(result).toHaveLength(3);
    expect(result[0].content).toContain(ORANGE_SYSTEM_MARKER);
    expect(result[1].content).toBe('Return JSON.');
  });

  test('does not duplicate doctrine on repeated middleware passes', () => {
    const once = injectOrangeSystem([{ role: 'user', content: 'hello' }]);
    const twice = injectOrangeSystem(once);
    expect(twice).toEqual(once);
  });

  test('conversation mode distinguishes harmless cooperation from operational proof', () => {
    const result = injectOrangeSystem(
      [{ role: 'user', content: 'Acknowledge this literal token.' }],
      { responseMode: 'conversation' },
    );
    const rendered = result.map((message) => String(message.content)).join('\n');
    expect(rendered).toContain('runtime context, not user-authored attempts');
    expect(rendered).toContain('Evidence gates operational claims, not ordinary cooperation');
    expect(rendered).toContain('Answer harmless transformations');
  });

  test('repairs a legacy doctrine-only frame without duplicating doctrine', () => {
    const legacy = [{ role: 'system', content: `${ORANGE_SYSTEM_MARKER}\nlegacy` }, { role: 'user', content: 'go' }];
    const result = injectOrangeSystem(legacy);
    expect(result.filter((message) => String(message.content).includes(ORANGE_SYSTEM_MARKER))).toHaveLength(1);
    expect(result[0].content).toContain(ORANGE_RUNTIME_CAPABILITY_MARKER);
  });

  test('builds a tiny canonical Navigator workbench without replaying history', () => {
    const result = compactNoEvidenceNavigatorMessages([
      { role: 'system', content: 'large recalled history that must be dropped' },
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'Where does repository coding run?' },
    ]);
    const rendered = result.map((message) => String(message.content)).join('\n');
    expect(result).toHaveLength(2);
    expect(result.at(-1).content).toBe('Where does repository coding run?');
    expect(rendered).toContain('qwen3-coder:30b through Hermes');
    expect(rendered).toContain('AE Eyes on 7440');
    expect(rendered).toContain('headless MCP and CLI remain first-class');
    expect(rendered).not.toContain('large recalled history');
    expect(ORANGE_NAVIGATOR_COMPACT_SYSTEM.length).toBeLessThan(700);
  });
});
