import { describe, expect, test } from 'bun:test';
import { adversarialBrief } from '../topology-router.mjs';
import { compileGovernedChatEvidence } from './governed-chat-evidence.mjs';

const PROJECT_SOURCE = {
  id: '00-CHARTER/ORANGE5_RUNTIME_AUTHORITY.md',
  pointer: 'file://C:/AtomEons/Orange5/00-CHARTER/ORANGE5_RUNTIME_AUTHORITY.md',
  content: '# OrangeFive Runtime Authority\nProduct: Orange\nRelease: OrangeFive\n',
};
const PROJECT_SELECTION = {
  source_id: PROJECT_SOURCE.id,
  pointer: `${PROJECT_SOURCE.pointer}#chars=0-72`,
  source_sha256: 'a'.repeat(64),
  chunk_sha256: 'b'.repeat(64),
  start: 0,
  end: PROJECT_SOURCE.content.length,
};

describe('governed factual chat evidence', () => {
  test('cites a relevant selected project excerpt without inventing evidence', () => {
    const result = compileGovernedChatEvidence({
      userText: 'What is the current Orange release?',
      projectSources: [PROJECT_SOURCE],
      projectSelected: [PROJECT_SELECTION],
    });

    expect(result.items).toEqual([
      'Release: OrangeFive | src=ORANGE5_RUNTIME_AUTHORITY.md@aaaaaaaaaaaa',
    ]);
    expect(result.citations[0]).toMatchObject({
      sourceKind: 'project',
      pointer: PROJECT_SELECTION.pointer,
      sourceSha256: 'a'.repeat(64),
    });
  });

  test('leaves unsupported claims evidence-free', () => {
    const result = compileGovernedChatEvidence({
      userText: 'Who is the current president of Neptune?',
      projectSources: [PROJECT_SOURCE],
      projectSelected: [PROJECT_SELECTION],
    });

    expect(result.items).toEqual([]);
    expect(result.citations).toEqual([]);
  });

  test('accepts only source-addressed records from injected AE Memory frames', () => {
    const result = compileGovernedChatEvidence({
      userText: 'Which Orange release is active?',
      memoryMessages: [{
        role: 'system',
        content: `[MEMORY:RECALLED kind=auto-recent]\nAIR:MEMORY.v1 src=ae_cobra\nR:state | Orange release is OrangeFive | src=${'c'.repeat(64)}\n[END:RECALLED]`,
      }],
    });

    expect(result.items).toEqual([
      'R:state | Orange release is OrangeFive | src=AE-Memory@cccccccccccc',
    ]);
    expect(result.citations[0].pointer).toBe(`ae-memory:${'c'.repeat(64)}`);
  });

  test('adversarial review targets the factual finding in the compiled report', () => {
    const brief = adversarialBrief(
      { action: 'query.chat', intent: 'What is the current Orange release?' },
      {
        summary: 'OrangeBrain produced a cognitive report for query.chat',
        output: { findings: ['OrangeFive is the current Orange release.'] },
      },
    );

    expect(brief.claim).toBe('OrangeFive is the current Orange release.');
  });
});
