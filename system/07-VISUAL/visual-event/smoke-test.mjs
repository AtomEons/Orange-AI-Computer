import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyChain } from '../../06-ORANGELLM/memory/ae-cobra/flux/writer.mjs';
import { writeVisualEvent } from './writer.mjs';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orangeeye-visual-event-'));
const fixturePath = new URL('./test-fixtures.json', import.meta.url);
const { fixtures } = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

try {
  const records = fixtures.map(({ name, description, ...input }) => ({
    name,
    record: writeVisualEvent({ ...input, fluxRoot: workspace }),
  }));

  assert.equal(records.length, 3);
  for (const { name, record } of records) {
    assert.equal(record.lane, 'reality', `${name}: reality lane`);
    assert.equal(record.origin, 'orangeeye', `${name}: orangeeye origin`);
    assert.equal(record.kind, 'observation', `${name}: observation kind`);
    assert.match(record.hash, /^[a-f0-9]{64}$/, `${name}: hash`);
    assert.ok(record.body.ae_visual, `${name}: ae_visual payload`);
  }

  assert.equal(records[0].record.prev_hash, 'GENESIS');
  assert.equal(records[1].record.prev_hash, records[0].record.hash);
  assert.equal(records[2].record.prev_hash, records[1].record.hash);

  const chain = verifyChain({ lane: 'reality', fluxRoot: workspace });
  assert.equal(chain.ok, true, JSON.stringify(chain.broken));
  assert.equal(chain.count, 3);

  console.log('PASS - OrangeEye visual-event fixtures persisted and hash chain verified');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
