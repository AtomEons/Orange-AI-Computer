#!/usr/bin/env node
// query.mjs
// OrangeEye Phase-1 — max-sim multi-vector query against 'orange5-vision'.
//
// Night-1 query embedding stand-in:
//   - nomic-embed-text via Ollama at http://127.0.0.1:11434/api/embeddings
//   - That model emits a single 768-dim float vector. Our collection expects 128-dim multi-vector.
//   - For Night-1 we down-project the 768 vec to 128 via deterministic block-mean pooling
//     (6 contiguous blocks of 128 wouldn't fit; we use stride pooling: 768 -> 128 means avg every 6 dims).
//     Then we tile it as a single-row "multi-vector" so Qdrant max_sim still scores.
//   - This is a *stand-in*. Phase-2 swaps in ColQwen2.5 query embedding which emits true ~16 patch tokens
//     of 128-dim Int8; until then expect retrieval quality to be smeared.
//
// Shape contract:
//   queryMaxSim({
//     queryText,                    // required string
//     topK = 8,
//     laneFilter = null,            // string or string[] — restricts to lane payload values
//     qdrantUrl, collection, ollamaUrl,
//   }) -> { ok, hits: [{id, score, payload}], stand_in: "nomic-768-to-128-blockpool", error? }

const DEFAULT_QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const DEFAULT_COLLECTION = process.env.ORANGE5_VISION_COLLECTION || "orange5-vision";
const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.ORANGE5_EMBED_MODEL || "nomic-embed-text";

const VECTOR_DIM = 128;
const VALID_LANES = new Set(["doc", "ui-screenshot", "video-frame", "chart", "whiteboard"]);

async function embedQueryText(text, ollamaUrl) {
  if (!text || typeof text !== "string") {
    throw new Error("queryText (non-empty string) required");
  }
  let res, body;
  try {
    res = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    });
    body = await res.text();
  } catch (err) {
    const e = new Error(`Ollama unreachable at ${ollamaUrl}: ${err.message}`);
    e.code = "EMBED_UNREACHABLE";
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Ollama embedding failed (${res.status}): ${body}`);
    e.code = "EMBED_FAILED";
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch (err) {
    throw new Error(`Ollama returned non-JSON: ${err.message}`);
  }
  const vec = parsed.embedding || parsed.embeddings?.[0];
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error(`Ollama response missing 'embedding' array`);
  }
  return vec;
}

function downprojectTo128(srcVec) {
  // Block-mean pool srcVec.length -> 128. Then min-max scale to uint8.
  const src = srcVec;
  const targetDim = VECTOR_DIM;
  const out = new Array(targetDim).fill(0);
  if (src.length === targetDim) {
    // Already 128; just scale.
    for (let i = 0; i < targetDim; i++) out[i] = src[i];
  } else {
    const block = src.length / targetDim;
    for (let i = 0; i < targetDim; i++) {
      const lo = Math.floor(i * block);
      const hi = Math.floor((i + 1) * block);
      let sum = 0;
      let count = 0;
      for (let j = lo; j < hi && j < src.length; j++) { sum += src[j]; count++; }
      out[i] = count > 0 ? sum / count : 0;
    }
  }
  // Min-max scale -> uint8 to match collection datatype expectation.
  let mn = Infinity, mx = -Infinity;
  for (const v of out) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const range = mx - mn || 1;
  return out.map((v) => Math.max(0, Math.min(255, Math.round(((v - mn) / range) * 255))));
}

function buildLaneFilter(laneFilter) {
  if (!laneFilter) return null;
  const lanes = Array.isArray(laneFilter) ? laneFilter : [laneFilter];
  for (const l of lanes) {
    if (!VALID_LANES.has(l)) {
      throw new Error(`unknown lane '${l}'. valid: ${[...VALID_LANES].join(", ")}`);
    }
  }
  return {
    must: [
      { key: "lane", match: { any: lanes } },
    ],
  };
}

export async function queryMaxSim({
  queryText,
  topK = 8,
  laneFilter = null,
  qdrantUrl = DEFAULT_QDRANT_URL,
  collection = DEFAULT_COLLECTION,
  ollamaUrl = DEFAULT_OLLAMA_URL,
} = {}) {
  // 1. Embed.
  let rawVec;
  try {
    rawVec = await embedQueryText(queryText, ollamaUrl);
  } catch (err) {
    return { ok: false, hits: [], stand_in: "nomic-768-to-128-blockpool", error: err.message };
  }

  // 2. Down-project to 128-dim, wrap as single-row multi-vector.
  const projected = downprojectTo128(rawVec);
  const queryVector = [projected]; // 1 x 128 multi-vector

  // 3. Build filter.
  let filter = null;
  try {
    filter = buildLaneFilter(laneFilter);
  } catch (err) {
    return { ok: false, hits: [], stand_in: "nomic-768-to-128-blockpool", error: err.message };
  }

  // 4. Qdrant Query API. Multivectors use `query: number[][]`; the retired
  // `/points/search` endpoint expects a single VectorStruct and rejects this
  // shape on current Qdrant releases.
  const body = {
    query: queryVector,
    limit: topK,
    with_payload: true,
    with_vector: false,
  };
  if (filter) body.filter = filter;

  let res, text;
  try {
    res = await fetch(`${qdrantUrl}/collections/${collection}/points/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (err) {
    return { ok: false, hits: [], stand_in: "nomic-768-to-128-blockpool", error: `Qdrant unreachable: ${err.message}` };
  }
  if (!res.ok) {
    return { ok: false, hits: [], stand_in: "nomic-768-to-128-blockpool", error: `Qdrant ${res.status}: ${text}` };
  }

  let parsed;
  try { parsed = JSON.parse(text); } catch (err) {
    return { ok: false, hits: [], stand_in: "nomic-768-to-128-blockpool", error: `Qdrant returned non-JSON: ${err.message}` };
  }

  // Query API returns result.points. Accept a legacy result array as a
  // defensive read-only compatibility path for older installations.
  const rows = Array.isArray(parsed.result?.points)
    ? parsed.result.points
    : Array.isArray(parsed.result)
      ? parsed.result
      : [];
  const hits = rows.map((h) => ({
    id: h.id,
    score: h.score,
    payload: h.payload || {},
  }));

  return {
    ok: true,
    hits,
    stand_in: "nomic-768-to-128-blockpool",
    note: "Phase-2 swaps in ColQwen2.5 query embedding (true multi-vector); Night-1 quality is approximate.",
  };
}

// CLI smoke-test:
//   node query.mjs "what does the schematic say about coolant flow"
//   node query.mjs --lane chart "Q3 revenue chart"
if (process.argv[1] && process.argv[1].endsWith("query.mjs")) {
  const argv = process.argv.slice(2);
  let lane = null;
  const textParts = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lane" && argv[i + 1]) { lane = argv[++i]; }
    else if (argv[i] === "--topk" && argv[i + 1]) { /* parsed below */ }
    else textParts.push(argv[i]);
  }
  const topkIdx = argv.indexOf("--topk");
  const topK = topkIdx >= 0 ? parseInt(argv[topkIdx + 1], 10) || 8 : 8;
  const queryText = textParts.join(" ").trim();
  if (!queryText) {
    console.error('usage: node query.mjs [--lane <lane>] [--topk N] "your query text"');
    process.exit(2);
  }
  queryMaxSim({ queryText, topK, laneFilter: lane }).then((out) => {
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
  });
}
