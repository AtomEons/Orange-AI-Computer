#!/usr/bin/env bun
import { runCrossOrganMission } from './cross-organ-mission.mjs';

try {
  const result = await runCrossOrganMission();
  console.log(JSON.stringify({
    ok: result.ok,
    status: result.status,
    receiptPath: result.receiptPath,
    hash: result.receipt.hash,
    evidence: result.receipt.evidence,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, status: 'BLOCKED', error: error?.message ?? String(error) }, null, 2));
  process.exit(1);
}

