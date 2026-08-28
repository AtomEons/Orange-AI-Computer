# OrangeEye visual-event writer

Thin wrapper that turns one OrangeEye page-level observation into one
hash-chained record on the **Reality** lane via the Æ Cobra Flux writer.

- Code: `writer.mjs`
- Fixtures: `test-fixtures.json` (3 samples — PDF describe, UI ground, frontier offload)
- Flux backend: `../../06-ORANGELLM/memory/ae-cobra/flux/writer.mjs`

## What gets recorded

One Flux record per visual event, where `body` carries both an
agent_turn-compatible payload and a structured `ae_visual` block:

```json
{
  "ae_visual": {
    "image_sha256": "8b7a2f4d…4a9b",
    "qdrant_doc_id": "doc-q4deck-p3-a1b2c3",
    "page": 2,
    "cortex_model": "glm-4.6v",
    "frontier_used": false,
    "patch_grounding": [
      { "idx": 47, "bbox": [120, 200, 80, 30], "confidence": 0.92 }
    ]
  },
  "summary": "Operator dropped Q4 deck p.3 — bar chart of revenue by region",
  "entities": ["Q4 deck", "revenue chart"],
  "files": ["q4-deck.pdf#page=3"],
  "commands": [],
  "risk": "low",
  "next_action": "wait for follow-up query",
  "confidence": 0.9
}
```

The Æ Cobra writer wraps that body in the standard envelope —
`{ts, lane, origin, kind, body, prev_hash, hash}` — and appends it to
`<fluxRoot>/events/reality/<YYYY-MM-DD>.jsonl` with the day's hash chain
maintained.

Fixed envelope values for this writer:

| field  | value         |
| ------ | ------------- |
| lane   | `reality`     |
| origin | `orangeeye`   |
| kind   | `observation` |

## Why it lands in Reality (origin-based classifier — V1 mitigation)

The Flux lane is decided **by origin**, not by content. Any record whose
`origin === 'orangeeye'` is recording **something the system actually
observed in the operator's world** — a dropped PDF page, a UI screenshot,
a schematic. That is Reality by definition, the same way a sensor reading
is Reality regardless of how analytical the summary prose happens to read.

This is intentional and conservative. A content-aware classifier could
mis-route the GLM-4.6V summary into Thought just because the summary
contains analytical language ("bar chart shows…", "three subsystems…").
We avoid that whole class of bug by pinning the lane at the writer.

If a downstream consumer later wants to derive a Thought-lane synthesis
from a Reality-lane observation, it must do so through an explicit Merge
or Thought write — never by reclassifying the original event in place.

## How to query it back via Mirage StateBrief

Mirage's StateBrief reads the Reality JSONL files line-by-line. To pull
visual events back:

1. Open `<fluxRoot>/events/reality/<YYYY-MM-DD>.jsonl`.
2. For each line, `JSON.parse` and keep records where
   `record.origin === 'orangeeye'` and `record.kind === 'observation'`.
3. The `body.ae_visual` block is the structured surface: use
   `image_sha256` to deduplicate, `qdrant_doc_id` to re-fetch the page
   image from the `orange5-vision` collection, and `patch_grounding` to
   re-draw bounding boxes over the original image.
4. The agent_turn fields (`summary`, `entities`, `files`, `risk`,
   `next_action`, `confidence`) are what StateBrief surfaces to the LLM
   as the "recent visual context" slot.

Hash-chain integrity for the day's Reality file can be verified with
`verifyChain({lane:'reality', fluxRoot, date})` exported from the
Æ Cobra writer — useful before a StateBrief assembles a summary.

## What this does NOT do yet

Honest scope. The writer is one narrow surface; these are *not* its job:

- **It does not embed.** It assumes ColQwen2.5 / ColPali-3 already ran
  upstream and produced `image_sha256` + `qdrant_doc_id`. Patch
  embeddings live in Qdrant, not in the Flux record.
- **It does not call GLM-4.6V or any frontier model.** The
  `cortex_response` object is supplied by the caller. `frontier_used` is
  a *recorded fact* about an upstream gateway decision — this file
  contains zero network code. (Frontier-Isolation Law: external models
  are only ever reached via the OrangeLLM gateway at
  `127.0.0.1:1337/v1`.)
- **It does not gate confidence.** If the caller passes
  `cortex_response.confidence: 0.41`, the record is written with 0.41.
  The offload decision happens upstream; we just record the outcome.
- **It does not verify the Qdrant point exists.** A bogus
  `qdrant_doc_id` will still be written. The contract is "record what
  the upstream pipeline said happened" — verification belongs in the
  ingestion smoke test, not here.
- **It does not auto-promote to Thought or Merge.** Synthesizing across
  multiple visual events into a Thought is a separate writer's job.
- **No retry / no dedup.** One call writes one record. Re-running with
  the same `image_sha256` produces a second record. Idempotency, if
  needed, belongs in the caller.
- **No StateBrief reader is included here.** This is the *write* side
  only. Mirage StateBrief lives elsewhere; the README documents the
  contract it can rely on.

## Failure modes the writer does handle

- Missing `image_sha256` / `qdrant_doc_id` / `cortex_model` →
  `Error` before any disk write.
- `image_sha256` not 64-char hex → `Error`.
- `frontier_used: true` without `frontier_model` → `Error`.
- Malformed `patch_grounding` entries → silently dropped (invalid bboxes
  are skipped, not crashed on; this matches how ColPali sometimes emits
  partial grounding payloads).
- Underlying Flux append failure (disk full, fluxRoot unwritable,
  prev-day chain unreadable) → re-thrown as
  `writeVisualEvent: Flux append failed: <cause>` with `.cause` set.

## Smoke test sketch

```js
import fs from 'node:fs';
import { writeVisualEvent } from './writer.mjs';

const { fixtures } = JSON.parse(fs.readFileSync('./test-fixtures.json', 'utf8'));
const fluxRoot = '/tmp/oe-flux-smoke'; // disposable
for (const f of fixtures) {
  const { name, description, ...kwargs } = f;
  const rec = writeVisualEvent({ ...kwargs, fluxRoot });
  console.log(name, '->', rec.hash.slice(0, 12));
}
```

Expected: three records appended to
`/tmp/oe-flux-smoke/events/reality/<today>.jsonl`, each chained to the
previous via `prev_hash`, all with `origin: 'orangeeye'` and
`kind: 'observation'`.
