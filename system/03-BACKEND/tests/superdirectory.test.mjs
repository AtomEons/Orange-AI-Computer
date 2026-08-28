import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ingestTranscript,
  redactReadable,
  searchSuperdirectory,
  snapshotProjectMarkdown,
  superdirectoryStatus,
} from '../superdirectory.mjs';

let scratch;
afterEach(async () => {
  if (scratch) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { fs.rmSync(scratch, { recursive: true, force: true }); break; }
      catch (error) {
        if (error?.code !== 'EBUSY' || attempt === 19) throw error;
        await Bun.sleep(50);
      }
    }
  }
  scratch = null;
});

function setup() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-superdirectory-'));
  const root = path.join(scratch, 'super');
  const source = path.join(scratch, 'codex.jsonl');
  return { root, source };
}

function codexLine(payload, timestamp = '2026-08-26T00:00:00.000Z') {
  return JSON.stringify({ type: 'response_item', timestamp, payload });
}

describe('Orange AI Computer OS Superdirectory', () => {
  test('copies exact raw bytes while producing a secret-redacted searchable transcript', async () => {
    const { root, source } = setup();
    const lines = [
      codexLine({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Remember Project Aurora. api_key=sk-example-secret-value' }] }),
      codexLine({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Aurora routes high-risk work through Codexa.' }] }),
      codexLine({ type: 'custom_tool_call', name: 'shell', input: '{"command":"hostname"}' }),
      codexLine({ type: 'custom_tool_call_output', call_id: 'call-1', output: 'CODEXA' }),
    ];
    const raw = `${lines.join('\n')}\n`;
    fs.writeFileSync(source, raw);
    const receipt = await ingestTranscript({ provider: 'codex', sourcePath: source }, { root });
    expect(receipt.status).toBe('GREEN');
    expect(fs.readFileSync(receipt.raw_path, 'utf8')).toBe(raw);
    const markdown = fs.readFileSync(receipt.markdown_path, 'utf8');
    expect(markdown).toContain('Project Aurora');
    expect(markdown).toContain('[REDACTED_SECRET]');
    expect(markdown).not.toContain('sk-example-secret-value');
    expect(searchSuperdirectory('Aurora Codexa', { root })[0].session_id).toBe(receipt.session_id);
  });

  test('incrementally appends without duplicating indexed records', async () => {
    const { root, source } = setup();
    fs.writeFileSync(source, `${codexLine({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first turn' }] })}\n`);
    const first = await ingestTranscript({ provider: 'codex', sourcePath: source }, { root });
    fs.appendFileSync(source, `${codexLine({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second turn' }] })}\n`);
    const second = await ingestTranscript({ provider: 'codex', sourcePath: source }, { root });
    const third = await ingestTranscript({ provider: 'codex', sourcePath: source }, { root });
    expect(first.indexed_records).toBe(1);
    expect(second.indexed_records).toBe(2);
    expect(second.new_records).toBe(1);
    expect(third.new_records).toBe(0);
    expect(superdirectoryStatus({ root }).records).toBe(2);
  });

  test('parses Claude Code messages and tool events', async () => {
    const { root, source } = setup();
    const raw = [
      JSON.stringify({ type: 'user', timestamp: '2026-08-26T00:00:00Z', message: { role: 'user', content: 'Build the governed rail.' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-26T00:00:01Z', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'text', text: 'Rail built.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
      ] } }),
    ].join('\n') + '\n';
    fs.writeFileSync(source, raw);
    const receipt = await ingestTranscript({ provider: 'claude-code', sourcePath: source }, { root });
    const markdown = fs.readFileSync(receipt.markdown_path, 'utf8');
    expect(markdown).toContain('Build the governed rail');
    expect(markdown).toContain('Rail built');
    expect(markdown).toContain('TOOL_CALL Bash');
    expect(markdown).not.toContain('private reasoning');
  });

  test('content-addresses every project Markdown revision', async () => {
    const { root } = setup();
    const projectRoot = path.join(scratch, 'project');
    fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
    const doc = path.join(projectRoot, 'docs', 'LAW.md');
    fs.writeFileSync(doc, '# Law\nNo fake green.');
    const first = await snapshotProjectMarkdown({ projectRoot, root });
    fs.writeFileSync(doc, '# Law\nReceipts outrank claims.');
    const second = await snapshotProjectMarkdown({ projectRoot, root });
    expect(first.files).toBe(1);
    expect(second.files).toBe(1);
    expect(fs.readdirSync(second.object_root).filter((name) => name.endsWith('.md'))).toHaveLength(2);
  });

  test('redacts standalone mixed-complexity credentials but preserves hashes', () => {
    const output = redactReadable('ExampleSecret42!\nsha256=CC60EF624997E6D5F2346E842AC40B16903114ECF247BFF74577E51529845AAE');
    expect(output.text).toContain('[REDACTED_SECRET]');
    expect(output.text).toContain('CC60EF624997E6D5F2346E842AC40B16903114ECF247BFF74577E51529845AAE');
  });

  test('keeps large tool output cold while retaining both evidence edges', async () => {
    const { root, source } = setup();
    const toolBody = `HEAD-EVIDENCE-${'x'.repeat(10_000)}-TAIL-EVIDENCE`;
    fs.writeFileSync(source, `${codexLine({ type: 'custom_tool_call_output', call_id: 'large', output: toolBody })}\n`);
    const receipt = await ingestTranscript({ provider: 'codex', sourcePath: source }, { root });
    expect(fs.readFileSync(receipt.raw_path, 'utf8')).toContain(toolBody);
    const markdown = fs.readFileSync(receipt.markdown_path, 'utf8');
    expect(markdown).toContain('HEAD-EVIDENCE');
    expect(markdown).toContain('TAIL-EVIDENCE');
    expect(markdown).toContain('TOOL_BODY_COLD');
    expect(markdown.length).toBeLessThan(toolBody.length);
  });
});
