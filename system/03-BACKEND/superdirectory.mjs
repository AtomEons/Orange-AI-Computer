import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from '#sqlite';
import { recordTranscriptArchive } from './memory-runtime.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ORANGE5_ROOT = path.resolve(HERE, '..');
export const SUPERDIRECTORY_ROOT = process.env.ORANGE5_SUPERDIRECTORY_ROOT
  || path.join(process.env.USERPROFILE || os.homedir(), 'OrangeBox-Data', 'orange5', 'superdirectory');

const EXCLUDED_PROJECT_DIRS = new Set([
  '.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'target', 'venv', '.venv', '__pycache__',
]);

function nowIso() {
  return new Date().toISOString();
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function safeName(value) {
  return String(value || 'session').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || 'session';
}

function normalizeRelative(value) {
  return String(value).replaceAll('\\', '/');
}

export function ensureSuperdirectory(root = SUPERDIRECTORY_ROOT) {
  const dirs = [
    root,
    path.join(root, 'raw', 'codex'),
    path.join(root, 'raw', 'claude-code'),
    path.join(root, 'transcripts', 'codex'),
    path.join(root, 'transcripts', 'claude-code'),
    path.join(root, 'documents', 'objects'),
    path.join(root, 'receipts'),
  ];
  dirs.forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
  return root;
}

function openIndex(root = SUPERDIRECTORY_ROOT) {
  ensureSuperdirectory(root);
  const dbPath = path.join(root, 'superdirectory.db');
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      source_path TEXT NOT NULL UNIQUE,
      raw_path TEXT NOT NULL,
      markdown_path TEXT NOT NULL,
      archived_bytes INTEGER NOT NULL DEFAULT 0,
      parsed_bytes INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      tool_event_count INTEGER NOT NULL DEFAULT 0,
      redaction_count INTEGER NOT NULL DEFAULT 0,
      raw_sha256 TEXT,
      flux_hash TEXT,
      flux_ts INTEGER,
      first_ts TEXT,
      last_ts TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT,
      text TEXT NOT NULL,
      text_sha256 TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id),
      UNIQUE(session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS messages_session_seq ON messages(session_id, seq);
    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
      id UNINDEXED,
      session_id UNINDEXED,
      role UNINDEXED,
      text,
      tokenize='unicode61'
    );
  `);
  ensureColumn(db, 'sessions', 'flux_hash', 'TEXT');
  ensureColumn(db, 'sessions', 'flux_ts', 'INTEGER');
  return { db, dbPath };
}

function ensureColumn(db, table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function sqlRun(db, sql, ...params) {
  const statement = db.prepare(sql);
  try { return statement.run(...params); }
  finally { statement.finalize(); }
}

function sqlGet(db, sql, ...params) {
  const statement = db.prepare(sql);
  try { return statement.get(...params); }
  finally { statement.finalize(); }
}

function sqlAll(db, sql, ...params) {
  const statement = db.prepare(sql);
  try { return statement.all(...params); }
  finally { statement.finalize(); }
}

function walkJsonl(root, out, provider) {
  if (!root || !fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        const stat = fs.statSync(full);
        out.push({ provider, sourcePath: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
}

export function discoverTranscriptSources({ home = process.env.USERPROFILE || os.homedir() } = {}) {
  const sources = [];
  walkJsonl(path.join(home, '.codex', 'sessions'), sources, 'codex');
  walkJsonl(path.join(home, '.claude', 'projects'), sources, 'claude-code');
  return sources.sort((a, b) => b.mtimeMs - a.mtimeMs || a.sourcePath.localeCompare(b.sourcePath));
}

function sessionIdentity(sourcePath, provider) {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const codexId = /([0-9a-f]{8}-[0-9a-f-]{27,})$/i.exec(base)?.[1];
  const claudeId = /([0-9a-f]{8}-[0-9a-f-]{27,})/i.exec(base)?.[1];
  const sourceHash = sha256Text(path.resolve(sourcePath).toLowerCase()).slice(0, 12);
  return safeName(`${provider}-${codexId || claudeId || base}-${sourceHash}`);
}

function countSecretKinds(value) {
  let score = 0;
  if (/[a-z]/.test(value)) score += 1;
  if (/[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^a-zA-Z0-9\s]/.test(value)) score += 1;
  return score;
}

export function redactReadable(value) {
  let redactions = 0;
  const replace = () => { redactions += 1; return '[REDACTED_SECRET]'; };
  let text = String(value || '')
    .replace(/((?:password|passwd|passphrase|api[_-]?key|access[_-]?token|auth[_-]?token|rail[_-]?token|secret)\s*[:=]\s*)[^\s,;"']+/gi,
      (match, prefix) => `${prefix}${replace()}`)
    .replace(/\b(?:KGAT_|sk-|ghp_|github_pat_|hf_)[A-Za-z0-9_-]{8,}\b/g, replace)
    .replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+=*/gi,
      (match, prefix) => `${prefix}${replace()}`);
  text = text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (trimmed.length >= 10 && trimmed.length <= 160 && !/\s/.test(trimmed) && !/[=:]/.test(trimmed)
      && countSecretKinds(trimmed) >= 4 && !/^[0-9a-f]{32,128}$/i.test(trimmed)) return replace();
    return line;
  }).join('\n');
  return { text, redactions };
}

function contentText(content, acceptedTypes = null) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && (!acceptedTypes || acceptedTypes.has(item.type)))
    .map((item) => item.text ?? item.content ?? '')
    .filter((item) => typeof item === 'string' && item.length)
    .join('\n');
}

function boundedOperationalText(record) {
  const text = String(record.text || '');
  if (!record.kind.startsWith('tool_') || text.length <= 8_000) return text;
  const head = text.slice(0, 5_000);
  const tail = text.slice(-2_000);
  return `${head}\n\n[TOOL_BODY_COLD; omitted_chars=${text.length - 7_000}; hydrate exact raw event at source_offset]\n\n${tail}`;
}

function extractCodex(object) {
  const payload = object?.payload || {};
  if (object?.type === 'response_item' && payload.type === 'message') {
    const text = contentText(payload.content, new Set(['input_text', 'output_text', 'text']));
    if (text) return { ts: object.timestamp, role: payload.role || 'unknown', kind: 'message', name: null, text };
  }
  if (object?.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(payload.type)) {
    const text = String(payload.arguments ?? payload.input ?? '');
    return { ts: object.timestamp, role: 'tool', kind: 'tool_call', name: payload.name || 'tool', text };
  }
  if (object?.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
    return { ts: object.timestamp, role: 'tool', kind: 'tool_output', name: payload.call_id || 'tool-result', text: String(payload.output ?? '') };
  }
  if (object?.type === 'turn_context') {
    const state = object.payload || {};
    return {
      ts: object.timestamp,
      role: 'system',
      kind: 'turn_context',
      name: state.turn_id || null,
      text: JSON.stringify({ cwd: state.cwd, model: state.model, effort: state.effort, mode: state.collaboration_mode }),
    };
  }
  if (object?.type === 'compacted') {
    return { ts: object.timestamp, role: 'system', kind: 'compaction', name: null, text: 'Context compacted. Exact replacement history remains in the raw archive.' };
  }
  return null;
}

function extractClaudeParts(object) {
  const message = object?.message;
  if (!message) return [];
  const role = message.role || object.type || 'unknown';
  if (typeof message.content === 'string') return [{ ts: object.timestamp, role, kind: 'message', name: null, text: message.content }];
  if (!Array.isArray(message.content)) return [];
  const records = [];
  for (const item of message.content) {
    if (!item || item.type === 'thinking') continue;
    if (item.type === 'text' && item.text) records.push({ ts: object.timestamp, role, kind: 'message', name: null, text: item.text });
    else if (item.type === 'tool_use') records.push({ ts: object.timestamp, role: 'tool', kind: 'tool_call', name: item.name || 'tool', text: JSON.stringify(item.input ?? {}) });
    else if (item.type === 'tool_result') records.push({ ts: object.timestamp, role: 'tool', kind: 'tool_output', name: item.tool_use_id || 'tool-result', text: contentText(item.content) || String(item.content ?? '') });
  }
  return records;
}

export function extractTranscriptRecords(object, provider) {
  if (provider === 'codex') {
    const record = extractCodex(object);
    return record ? [record] : [];
  }
  if (provider === 'claude-code') return extractClaudeParts(object);
  return [];
}

async function copyAppend(sourcePath, rawPath, existingBytes) {
  const sourceSize = fs.statSync(sourcePath).size;
  const rawSize = fs.existsSync(rawPath) ? fs.statSync(rawPath).size : 0;
  const start = Math.max(Number(existingBytes || 0), rawSize);
  if (sourceSize < start) throw new Error(`source transcript shrank: source=${sourceSize} archive=${start}`);
  if (sourceSize === start) return { sourceSize, appendedBytes: 0 };
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(sourcePath, { start });
    const output = fs.createWriteStream(rawPath, { flags: 'a' });
    input.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    input.pipe(output);
  });
  return { sourceSize, appendedBytes: sourceSize - start };
}

async function parseNewRaw({ db, session, provider, rawPath, startOffset }) {
  const insertMessage = db.prepare(`INSERT OR IGNORE INTO messages
    (id,session_id,seq,ts,role,kind,name,text,text_sha256,source_offset)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const insertFts = db.prepare('INSERT INTO message_fts(id,session_id,role,text) VALUES(?,?,?,?)');
  let seq = Number(sqlGet(db, 'SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE session_id=?', session)?.seq || 0);
  let carry = Buffer.alloc(0);
  let carryStart = Number(startOffset || 0);
  let inserted = 0;
  let toolEvents = 0;
  let redactions = 0;
  let firstTs = null;
  let lastTs = null;
  const pending = [];

  const flush = () => {
    if (!pending.length) return;
    const tx = db.transaction(() => {
      for (const row of pending) {
        const result = insertMessage.run(row.id, session, row.seq, row.ts, row.role, row.kind, row.name, row.text, row.textHash, row.offset);
        if (Number(result.changes || 0) > 0) insertFts.run(row.id, session, row.role, row.text);
      }
    });
    tx();
    pending.length = 0;
  };

  try {
    for await (const chunk of fs.createReadStream(rawPath, { start: startOffset })) {
      const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let cursor = 0;
      let newline;
      while ((newline = buffer.indexOf(10, cursor)) !== -1) {
        const lineOffset = carryStart + cursor;
        const line = buffer.subarray(cursor, newline).toString('utf8').replace(/\r$/, '');
        cursor = newline + 1;
        if (!line.trim()) continue;
        let object;
        try { object = JSON.parse(line); }
        catch { continue; }
        for (const record of extractTranscriptRecords(object, provider)) {
          const readable = redactReadable(boundedOperationalText(record));
          seq += 1;
          redactions += readable.redactions;
          if (record.kind.startsWith('tool_')) toolEvents += 1;
          firstTs ||= record.ts || null;
          lastTs = record.ts || lastTs;
          const id = sha256Text(`${session}\n${lineOffset}\n${seq}\n${record.kind}\n${record.name || ''}`);
          const row = {
            id, seq, ts: record.ts || null, role: record.role, kind: record.kind, name: record.name || null,
            text: readable.text, textHash: sha256Text(readable.text), offset: lineOffset,
          };
          pending.push(row);
          inserted += 1;
          if (pending.length >= 300) flush();
        }
      }
      carry = buffer.subarray(cursor);
      carryStart += cursor;
    }
    flush();
  } finally {
    insertMessage.finalize();
    insertFts.finalize();
  }
  return { parsedBytes: carryStart, inserted, toolEvents, redactions, firstTs, lastTs };
}

function markdownBlock(text) {
  return `~~~~text\n${String(text || '').replace(/~~~~/g, '~~ ~~')}\n~~~~`;
}

function renderSessionMarkdown(db, sessionRow) {
  const rows = sqlAll(db, 'SELECT ts,role,kind,name,text,text_sha256,source_offset FROM messages WHERE session_id=? ORDER BY seq', sessionRow.session_id);
  const lines = [
    `# Full Transcript: ${sessionRow.session_id}`,
    '',
    '> Orange AI Computer OS from AtomEons',
    '>',
    '> This readable mirror redacts likely credentials. The exact provider JSONL is preserved in the private raw archive.',
    '',
    `- Provider: \`${sessionRow.provider}\``,
    `- Source: \`${sessionRow.source_path}\``,
    `- Raw archive: \`${sessionRow.raw_path}\``,
    `- Raw SHA-256: \`${sessionRow.raw_sha256 || 'pending'}\``,
    `- Indexed records: ${rows.length}`,
    `- Updated: ${sessionRow.updated_at}`,
    '',
  ];
  for (const row of rows) {
    const label = row.kind === 'message' ? row.role.toUpperCase() : `${row.kind.toUpperCase()} ${row.name || ''}`.trim();
    lines.push(`## ${label} · ${row.ts || 'timestamp unavailable'}`);
    lines.push('');
    lines.push(`<!-- source_offset=${row.source_offset} sha256=${row.text_sha256} -->`);
    lines.push(row.kind === 'message' ? row.text : markdownBlock(row.text));
    lines.push('');
  }
  fs.mkdirSync(path.dirname(sessionRow.markdown_path), { recursive: true });
  fs.writeFileSync(sessionRow.markdown_path, `${lines.join('\n')}\n`);
}

function writeIndexFiles(db, root) {
  const sessions = sqlAll(db, 'SELECT * FROM sessions ORDER BY COALESCE(last_ts,updated_at) DESC');
  const index = [
    '# Orange AI Computer OS Superdirectory',
    '',
    'Disk is durable world-memory. RAM receives only a bounded working crystal.',
    '',
    '## Guarantees',
    '',
    '- Exact provider logs are copied incrementally into the private raw archive.',
    '- Human-readable Markdown mirrors are searchable and credential-redacted.',
    '- SQLite is the disk-resident search index, not the source of truth.',
    '- Project Markdown is content-addressed so edits and deletions do not erase prior knowledge.',
    '- No transcript body is retained in a long-lived RAM cache.',
    '',
    '## Sessions',
    '',
    '| Provider | Records | Raw bytes | Last event | Transcript |',
    '|---|---:|---:|---|---|',
    ...sessions.map((row) => {
      const relative = normalizeRelative(path.relative(root, row.markdown_path));
      return `| ${row.provider} | ${row.message_count} | ${row.archived_bytes} | ${row.last_ts || row.updated_at} | [${row.session_id}](${relative}) |`;
    }),
    '',
  ];
  fs.writeFileSync(path.join(root, 'SUPERINDEX.md'), `${index.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), `${JSON.stringify({ schema: 'orange5.superdirectory.manifest.v1', generated_at: nowIso(), sessions }, null, 2)}\n`);
}

function appendReceipt(root, payload) {
  const stamp = payload.generated_at.replace(/[:.]/g, '-');
  const body = { ...payload };
  body.receipt_sha256 = sha256Text(JSON.stringify(body));
  const receiptPath = path.join(root, 'receipts', `${stamp}-${safeName(payload.session_id)}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(body, null, 2)}\n`);
  fs.appendFileSync(path.join(root, 'MANIFEST.jsonl'), `${JSON.stringify(body)}\n`);
  return receiptPath;
}

export async function ingestTranscript(source, { root = SUPERDIRECTORY_ROOT, fluxRoot } = {}) {
  ensureSuperdirectory(root);
  const provider = source.provider;
  const sourcePath = path.resolve(source.sourcePath);
  if (!['codex', 'claude-code'].includes(provider)) throw new Error(`unsupported transcript provider: ${provider}`);
  if (!fs.existsSync(sourcePath)) throw new Error(`transcript source missing: ${sourcePath}`);
  const sessionId = sessionIdentity(sourcePath, provider);
  const rawPath = path.join(root, 'raw', provider, `${sessionId}.jsonl`);
  const markdownPath = path.join(root, 'transcripts', provider, `${sessionId}.md`);
  const { db, dbPath } = openIndex(root);
  try {
    const existing = sqlGet(db, 'SELECT * FROM sessions WHERE source_path=?', sourcePath);
    sqlRun(db, `INSERT INTO sessions(session_id,provider,source_path,raw_path,markdown_path,archived_bytes,parsed_bytes,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET provider=excluded.provider,source_path=excluded.source_path,
      raw_path=excluded.raw_path,markdown_path=excluded.markdown_path,updated_at=excluded.updated_at`,
      sessionId, provider, sourcePath, rawPath, markdownPath, existing?.archived_bytes || 0, existing?.parsed_bytes || 0, nowIso());
    const copied = await copyAppend(sourcePath, rawPath, existing?.archived_bytes || 0);
    const parsed = await parseNewRaw({ db, session: sessionId, provider, rawPath, startOffset: existing?.parsed_bytes || 0 });
    const archivedBytes = fs.statSync(rawPath).size;
    const rawSha256 = await sha256File(rawPath);
    const counts = sqlGet(db, `SELECT COUNT(*) AS messages,
      SUM(CASE WHEN kind LIKE 'tool_%' THEN 1 ELSE 0 END) AS tools,
      MIN(ts) AS first_ts,MAX(ts) AS last_ts FROM messages WHERE session_id=?`, sessionId);
    sqlRun(db, `UPDATE sessions SET archived_bytes=?,parsed_bytes=?,message_count=?,tool_event_count=?,
      redaction_count=redaction_count+?,raw_sha256=?,first_ts=?,last_ts=?,updated_at=? WHERE session_id=?`,
      archivedBytes, parsed.parsedBytes, counts.messages || 0, counts.tools || 0, parsed.redactions,
      rawSha256, counts.first_ts || parsed.firstTs, counts.last_ts || parsed.lastTs, nowIso(), sessionId);
    let row = sqlGet(db, 'SELECT * FROM sessions WHERE session_id=?', sessionId);
    renderSessionMarkdown(db, row);
    const payload = {
      schema: 'orange5.superdirectory.ingest.v1',
      status: 'GREEN',
      session_id: sessionId,
      provider,
      source_path: sourcePath,
      raw_path: rawPath,
      markdown_path: markdownPath,
      index_path: dbPath,
      source_bytes: fs.statSync(sourcePath).size,
      archived_bytes: archivedBytes,
      appended_bytes: copied.appendedBytes,
      parsed_bytes: parsed.parsedBytes,
      indexed_records: row.message_count,
      new_records: parsed.inserted,
      tool_events: row.tool_event_count,
      readable_redactions: row.redaction_count,
      raw_sha256: rawSha256,
      generated_at: nowIso(),
    };
    const flux = recordTranscriptArchive({
      ...payload,
      prior_flux_hash: existing?.flux_hash || null,
    }, { fluxRoot });
    sqlRun(db, 'UPDATE sessions SET flux_hash=?,flux_ts=?,updated_at=? WHERE session_id=?',
      flux.hash, flux.ts, nowIso(), sessionId);
    row = sqlGet(db, 'SELECT * FROM sessions WHERE session_id=?', sessionId);
    writeIndexFiles(db, root);
    payload.flux = {
      ledger: 'ae-cobra-flux',
      lane: flux.lane,
      hash: flux.hash,
      ts: flux.ts,
      memory_id: flux.memory_id,
      deduped: flux.deduped === true,
      sqlite_projection: 'graph-weaver-derived',
    };
    payload.receipt_path = appendReceipt(root, payload);
    return payload;
  } finally {
    db.close();
  }
}

function walkMarkdown(root, current, out) {
  let entries = [];
  try { entries = fs.readdirSync(current, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_PROJECT_DIRS.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) walkMarkdown(root, full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push({ full, relative: normalizeRelative(path.relative(root, full)) });
  }
}

export async function snapshotProjectMarkdown({ projectRoot = ORANGE5_ROOT, root = SUPERDIRECTORY_ROOT } = {}) {
  ensureSuperdirectory(root);
  const files = [];
  walkMarkdown(projectRoot, projectRoot, files);
  const records = [];
  for (const file of files.sort((a, b) => a.relative.localeCompare(b.relative))) {
    const hash = await sha256File(file.full);
    const objectPath = path.join(root, 'documents', 'objects', `${hash}.md`);
    if (!fs.existsSync(objectPath)) fs.copyFileSync(file.full, objectPath);
    const stat = fs.statSync(file.full);
    records.push({ source_path: file.full, relative_path: file.relative, sha256: hash, bytes: stat.size, modified_at: stat.mtime.toISOString(), object_path: objectPath });
  }
  const lines = [
    '# OrangeFive Project Markdown History', '',
    'Each document points to an immutable content-addressed copy. A changed source creates a new object; prior content remains.', '',
    '| Source | Bytes | SHA-256 | Immutable object |', '|---|---:|---|---|',
    ...records.map((row) => `| \`${row.relative_path.replaceAll('|', '\\|')}\` | ${row.bytes} | \`${row.sha256}\` | [object](${normalizeRelative(path.relative(root, row.object_path))}) |`), '',
  ];
  const mapPath = path.join(root, 'PROJECT-MARKDOWN-MAP.md');
  fs.writeFileSync(mapPath, `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'PROJECT-MARKDOWN-MANIFEST.json'), `${JSON.stringify({ schema: 'orange5.project-markdown-history.v1', project_root: projectRoot, generated_at: nowIso(), documents: records }, null, 2)}\n`);
  return { status: 'GREEN', files: records.length, map_path: mapPath, object_root: path.join(root, 'documents', 'objects') };
}

export function searchSuperdirectory(query, { root = SUPERDIRECTORY_ROOT, limit = 12 } = {}) {
  const { db } = openIndex(root);
  try {
    const terms = [...new Set(String(query).toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) || [])].slice(0, 12);
    if (!terms.length) return [];
    const expression = terms.map((term) => `"${term.replaceAll('"', '')}"*`).join(' OR ');
    return sqlAll(db, `SELECT m.id,m.session_id,m.seq,m.ts,m.role,m.kind,m.name,m.text,m.text_sha256,m.source_offset,
      s.provider,s.raw_path,s.raw_sha256,bm25(message_fts) AS rank
      FROM message_fts JOIN messages m ON m.id=message_fts.id JOIN sessions s ON s.session_id=m.session_id
      WHERE message_fts MATCH ? ORDER BY rank LIMIT ?`, expression, limit);
  } finally { db.close(); }
}

function readRawLineAtOffset(filePath, offset, maxBytes) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('transcript source offset must be a non-negative safe integer');
  const stat = fs.statSync(filePath);
  if (offset >= stat.size) throw new Error(`transcript source offset is outside the raw archive: ${offset}`);
  const handle = fs.openSync(filePath, 'r');
  const chunks = [];
  let position = offset;
  let total = 0;
  try {
    while (position < stat.size && total < maxBytes) {
      const size = Math.min(64 * 1024, stat.size - position, maxBytes - total);
      const chunk = Buffer.allocUnsafe(size);
      const bytesRead = fs.readSync(handle, chunk, 0, size, position);
      if (!bytesRead) break;
      const value = chunk.subarray(0, bytesRead);
      const newline = value.indexOf(10);
      chunks.push(newline === -1 ? value : value.subarray(0, newline));
      total += newline === -1 ? bytesRead : newline;
      if (newline !== -1) break;
      position += bytesRead;
    }
  } finally {
    fs.closeSync(handle);
  }
  if (position < stat.size && total >= maxBytes) throw new Error(`transcript event exceeds hydration limit: ${maxBytes} bytes`);
  const line = Buffer.concat(chunks);
  return line.at(-1) === 13 ? line.subarray(0, -1) : line;
}

export async function hydrateTranscriptHit(hit, { root = SUPERDIRECTORY_ROOT, maxEventBytes = 16 * 1024 * 1024 } = {}) {
  if (!hit || typeof hit !== 'object' || !hit.id) throw new Error('transcript search hit with id is required');
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) {
    throw new TypeError('transcript hydration maxEventBytes must be a positive safe integer');
  }
  const { db } = openIndex(root);
  let row;
  try {
    row = sqlGet(db, `SELECT m.id,m.session_id,m.seq,m.ts,m.role,m.kind,m.name,m.text_sha256,m.source_offset,
      s.provider,s.raw_path,s.raw_sha256 FROM messages m JOIN sessions s ON s.session_id=m.session_id WHERE m.id=?`, hit.id);
  } finally { db.close(); }
  if (!row) throw new Error(`transcript search hit is no longer indexed: ${hit.id}`);
  for (const field of ['session_id', 'source_offset', 'text_sha256']) {
    if (hit[field] !== undefined && hit[field] !== null && String(hit[field]) !== String(row[field])) {
      throw new Error(`transcript search hit ${field} does not match the disk index`);
    }
  }
  const configuredRawRoot = path.resolve(root, 'raw');
  const configuredRawPath = path.resolve(row.raw_path);
  if (!row.raw_sha256 || !fs.existsSync(configuredRawPath)) throw new Error(`transcript raw archive is unavailable: ${row.session_id}`);
  const rawRoot = fs.realpathSync(configuredRawRoot);
  const rawPath = fs.realpathSync(configuredRawPath);
  const relativeRawPath = path.relative(rawRoot, rawPath);
  if (relativeRawPath === '..' || relativeRawPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRawPath)) {
    throw new Error('transcript raw archive path escapes the superdirectory');
  }
  const actualRawHash = await sha256File(rawPath);
  if (actualRawHash !== row.raw_sha256) throw new Error(`transcript raw archive hash mismatch: ${row.session_id}`);
  const rawLine = readRawLineAtOffset(rawPath, Number(row.source_offset), maxEventBytes);
  let event;
  try { event = JSON.parse(rawLine.toString('utf8')); }
  catch (error) { throw new Error(`transcript raw event is not valid JSON at offset ${row.source_offset}: ${error.message}`); }
  const hydrated = extractTranscriptRecords(event, row.provider)
    .map((record) => ({ record, readable: redactReadable(boundedOperationalText(record)) }))
    .find(({ record, readable }) => record.role === row.role && record.kind === row.kind
      && (record.name || null) === (row.name || null) && sha256Text(readable.text) === row.text_sha256);
  if (!hydrated) throw new Error(`transcript raw event does not reproduce indexed record: ${row.id}`);
  return {
    schema: 'orange5.superdirectory.hydration.v1',
    id: row.id,
    session_id: row.session_id,
    seq: row.seq,
    provider: row.provider,
    ts: row.ts,
    role: row.role,
    kind: row.kind,
    name: row.name,
    content: hydrated.readable.text,
    source: {
      kind: 'transcript-raw-event',
      path: rawPath,
      sha256: actualRawHash,
      offset: Number(row.source_offset),
      bytes: rawLine.length,
      event_sha256: sha256Bytes(rawLine),
      text_sha256: row.text_sha256,
      verification: { algorithm: 'sha256', scope: 'file-and-event', matched: true },
      verified: true,
      authorized: true,
    },
  };
}

export function superdirectoryStatus({ root = SUPERDIRECTORY_ROOT } = {}) {
  const { db, dbPath } = openIndex(root);
  try {
    const counts = sqlGet(db, `SELECT COUNT(*) AS sessions,COALESCE(SUM(message_count),0) AS records,
      COALESCE(SUM(archived_bytes),0) AS raw_bytes,COALESCE(SUM(redaction_count),0) AS redactions FROM sessions`);
    return { schema: 'orange5.superdirectory.status.v1', status: 'OPERATIONAL', root, index_path: dbPath, ...counts };
  } finally { db.close(); }
}

export function transcriptSourceState(sourcePath, { root = SUPERDIRECTORY_ROOT } = {}) {
  const { db } = openIndex(root);
  try {
    return sqlGet(db, 'SELECT session_id,provider,source_path,archived_bytes,parsed_bytes,flux_hash,flux_ts,updated_at FROM sessions WHERE source_path=?', path.resolve(sourcePath)) || null;
  } finally { db.close(); }
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

async function cli(args = process.argv.slice(2)) {
  const command = args[0] || 'status';
  const root = argValue(args, '--root') || SUPERDIRECTORY_ROOT;
  if (command === 'discover') return { sources: discoverTranscriptSources() };
  if (command === 'status') return superdirectoryStatus({ root });
  if (command === 'search') return { query: args.slice(1).filter((arg) => arg !== '--root' && arg !== root).join(' '), hits: searchSuperdirectory(args.slice(1).join(' '), { root }) };
  if (command === 'snapshot-docs') return snapshotProjectMarkdown({ root });
  if (command === 'ingest') {
    const sourcePath = argValue(args, '--source');
    const provider = argValue(args, '--provider');
    if (!sourcePath || !provider) throw new Error('usage: superdirectory.mjs ingest --provider codex|claude-code --source <jsonl>');
    return ingestTranscript({ provider, sourcePath }, { root });
  }
  if (command === 'ingest-current') {
    const source = discoverTranscriptSources()[0];
    if (!source) throw new Error('no Codex or Claude Code transcripts discovered');
    return ingestTranscript(source, { root });
  }
  if (command === 'ingest-all') {
    const receipts = [];
    for (const source of discoverTranscriptSources()) receipts.push(await ingestTranscript(source, { root }));
    return { status: 'GREEN', sessions: receipts.length, receipts };
  }
  throw new Error(`unknown superdirectory command: ${command}`);
}

if (import.meta.main) {
  cli().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(JSON.stringify({ status: 'RED', error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}
