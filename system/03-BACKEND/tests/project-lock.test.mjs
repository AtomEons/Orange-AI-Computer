import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateProject, clearProjectLock, injectProjectLock, readProjectLock } from '../project-lock.mjs';
import { prepareChatTurn } from '../../06-ORANGELLM/server/turn-harness.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-project-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Law\nMust test every claim. Never fake green.\n', 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-alpha', packageManager: 'bun@1.3.14', scripts: { test: 'bun test', build: 'bun build' } }), 'utf8');
  return { root, statePath: path.join(root, '.orange-active-project.json') };
}

describe('Orange active project lock', () => {
  test('mounts project truth and creates a stable runtime capsule', () => {
    const target = fixture();
    const state = activateProject({ root: target.root, goal: 'Ship the verified feature.' }, { statePath: target.statePath });
    expect(state.active).toBe(true);
    expect(state.project.name).toBe('project-alpha');
    expect(state.project.governingDocs.some((doc) => doc.path === 'AGENTS.md')).toBe(true);
    expect(state.capsule).toContain('ORANGE ACTIVE PROJECT LOCK');
    expect(state.capsule).toContain('Never fake green');
    expect(state.capsule).toContain('Ship the verified feature');
  });

  test('injects project law ahead of user messages every turn', () => {
    const target = fixture();
    activateProject({ root: target.root, goal: 'Stay on project.' }, { statePath: target.statePath });
    const state = readProjectLock({ statePath: target.statePath });
    const result = injectProjectLock([{ role: 'user', content: 'continue' }], state);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toContain('project=project-alpha');
    expect(result.messages[1]).toEqual({ role: 'user', content: 'continue' });
  });

  test('refresh detects governing document changes and changes the lock hash', () => {
    const target = fixture();
    const before = activateProject({ root: target.root }, { statePath: target.statePath });
    fs.appendFileSync(path.join(target.root, 'AGENTS.md'), 'Only use receipts.\n');
    const after = readProjectLock({ statePath: target.statePath, refresh: true });
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.capsule).toContain('Only use receipts');
  });

  test('clear removes the lock from future turns', () => {
    const target = fixture();
    activateProject({ root: target.root }, { statePath: target.statePath });
    clearProjectLock({ statePath: target.statePath });
    const state = readProjectLock({ statePath: target.statePath });
    expect(state.active).toBe(false);
    expect(injectProjectLock([{ role: 'user', content: 'continue' }], state).messages).toHaveLength(1);
  });

  test('the Orange gateway injects the active project lock into every model turn', async () => {
    const target = fixture();
    activateProject({ root: target.root, goal: 'Keep the active project.' }, { statePath: target.statePath });
    const previous = process.env.ORANGE5_PROJECT_LOCK_PATH;
    process.env.ORANGE5_PROJECT_LOCK_PATH = target.statePath;
    try {
      const turn = await prepareChatTurn({ model: 'orange-auto', messages: [{ role: 'user', content: 'continue the work' }] }, 'order-project-lock');
      expect(turn.order.targetProject).toBe('project-alpha');
      expect(turn.order.payload.project_lock_active).toBe(true);
      expect(turn.body.messages[0].role).toBe('system');
      expect(turn.body.messages[0].content).toContain('ORANGE ACTIVE PROJECT LOCK');
    } finally {
      if (previous == null) delete process.env.ORANGE5_PROJECT_LOCK_PATH;
      else process.env.ORANGE5_PROJECT_LOCK_PATH = previous;
    }
  });
});
