import fs from 'node:fs';
import path from 'node:path';
import {
  SUPERDIRECTORY_ROOT,
  discoverTranscriptSources,
  ingestTranscript,
  snapshotProjectMarkdown,
  superdirectoryStatus,
  transcriptSourceState,
} from './superdirectory.mjs';

const INTERVAL_MS = Math.max(15_000, Number(process.env.ORANGE5_TRANSCRIPT_INTERVAL_MS || 60_000));
const RECENT_WINDOW_MS = Math.max(86_400_000, Number(process.env.ORANGE5_TRANSCRIPT_RECENT_WINDOW_MS || 7 * 86_400_000));
const STATE_PATH = path.join(SUPERDIRECTORY_ROOT, 'daemon-status.json');
let running = false;
let lastDocumentSnapshot = fs.existsSync(path.join(SUPERDIRECTORY_ROOT, 'PROJECT-MARKDOWN-MANIFEST.json'))
  ? fs.statSync(path.join(SUPERDIRECTORY_ROOT, 'PROJECT-MARKDOWN-MANIFEST.json')).mtimeMs
  : 0;

function writeStatus(payload) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify({ schema: 'orange5.transcript-daemon.v1', ...payload, pid: process.pid, written_at: new Date().toISOString() }, null, 2)}\n`);
}

export async function archiveTick() {
  if (running) return { status: 'SKIPPED_OVERLAP' };
  running = true;
  const started = Date.now();
  const receipts = [];
  const failures = [];
  try {
    writeStatus({ status: 'RUNNING_TICK', phase: 'discovering', started_at: new Date(started).toISOString() });
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    const discovered = discoverTranscriptSources().filter((source, index) => source.mtimeMs >= cutoff || index === 0);
    const sources = discovered.filter((source) => {
      const state = transcriptSourceState(source.sourcePath);
      return !state || Number(state.archived_bytes) !== Number(source.size) || !state.flux_hash;
    }).slice(0, 8);
    for (const source of sources) {
      writeStatus({ status: 'RUNNING_TICK', phase: 'archiving', source_path: source.sourcePath, sources_remaining: sources.length - receipts.length });
      try { receipts.push(await ingestTranscript(source)); }
      catch (error) { failures.push({ source_path: source.sourcePath, error: error?.message || String(error) }); }
    }
    const documentSnapshotDue = Date.now() - lastDocumentSnapshot >= 6 * 60 * 60 * 1_000;
    if (documentSnapshotDue) writeStatus({ status: 'RUNNING_TICK', phase: 'project-markdown-snapshot' });
    const docs = documentSnapshotDue ? await snapshotProjectMarkdown() : null;
    if (docs) lastDocumentSnapshot = Date.now();
    const result = {
      status: failures.length ? 'OPERATIONAL_WITH_ERRORS' : 'OPERATIONAL',
      sources_checked: sources.length,
      sessions_ingested: receipts.length,
      appended_bytes: receipts.reduce((sum, item) => sum + item.appended_bytes, 0),
      new_records: receipts.reduce((sum, item) => sum + item.new_records, 0),
      project_markdown_files: docs?.files ?? null,
      project_markdown_snapshot_due: documentSnapshotDue,
      failures,
      elapsed_ms: Date.now() - started,
      index: superdirectoryStatus(),
    };
    writeStatus(result);
    return result;
  } finally { running = false; }
}

export async function runDaemon() {
  writeStatus({ status: 'STARTING' });
  await archiveTick();
  setInterval(() => archiveTick().catch((error) => writeStatus({ status: 'ERROR', error: error?.message || String(error) })), INTERVAL_MS);
}

// This file is a dedicated daemon entry point, including in Bun's compiled
// executable where import.meta.main is not a reliable launcher signal.
runDaemon().catch((error) => {
  writeStatus({ status: 'FATAL', error: error?.message || String(error) });
  process.exitCode = 1;
});
