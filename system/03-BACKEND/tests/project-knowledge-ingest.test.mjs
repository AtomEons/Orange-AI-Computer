import { describe, expect, test } from 'bun:test';
import {
  jsonSections,
  markdownSections,
  __projectKnowledgeInternals,
} from '../project-knowledge-ingest.mjs';

describe('OrangeFive project knowledge ingestion', () => {
  test('keeps markdown headings attached to bounded source chunks', () => {
    const sections = markdownSections(`# Runtime\n\nNavigator runs on Codexa.\n\n## Evidence\n\nReceipt abc proves it.`, 80);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ section: 'Runtime' });
    expect(sections[0].text).toContain('Navigator runs on Codexa');
    expect(sections[1]).toMatchObject({ section: 'Runtime > Evidence' });
    expect(sections[1].text).toContain('Receipt abc proves it');
  });

  test('turns JSON proof leaves into searchable bounded evidence', () => {
    const sections = jsonSections(JSON.stringify({ status: 'GREEN', nested: { model: 'orange-navigator:7b' } }), 100);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.map((item) => item.text).join('\n')).toContain('$.nested.model: orange-navigator:7b');
  });

  test('resolves wildcard patterns without treating regex punctuation as syntax', () => {
    const regex = __projectKnowledgeInternals.wildcardRegex('proof-*.json');
    expect(regex.test('proof-2026.json')).toBe(true);
    expect(regex.test('proof-2026Xjson')).toBe(false);
  });

  test('never emits an oversized source chunk', () => {
    const chunks = __projectKnowledgeInternals.packChunks([`Header\n${'fact '.repeat(900)}`], 240);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(240);
  });
});
