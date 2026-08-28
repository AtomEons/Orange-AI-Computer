#!/usr/bin/env node
// init-collection.mjs
// OrangeEye Phase-1 — Qdrant collection bootstrap for 'orange5-vision'.
//
// Doctrine:
//   - Multi-vector ColPali-style index (one Qdrant point per page, N patches per point).
//   - vectors_config: size=128, distance=Dot, multi_vector_config.comparator=max_sim, datatype=uint8.
//   - Idempotent: if the collection already exists with a compatible config it no-ops.
//   - Talks ONLY to the local Qdrant at QDRANT_URL (default http://127.0.0.1:6333).
//   - Frontier-Isolation Law: no external calls. Codeless Law: no shelling out to repos.
//
// Usage:
//   node init-collection.mjs
//   QDRANT_URL=http://127.0.0.1:6333 node init-collection.mjs
//
// Exit codes:
//   0 — collection ready (created or already compatible)
//   1 — Qdrant unreachable
//   2 — existing collection has incompatible config (manual intervention required)
//   3 — Qdrant returned an unexpected error

const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const COLLECTION = process.env.ORANGE5_VISION_COLLECTION || "orange5-vision";
const VECTOR_SIZE = 128;
const DISTANCE = "Dot";
const MULTIVEC_COMPARATOR = "max_sim";
const DATATYPE = "uint8";

// Payload field schema. Keep in sync with README.md and Cobra Flux writer.
const PAYLOAD_INDEXES = [
  { field_name: "source",       field_schema: "keyword"  },
  { field_name: "page",         field_schema: "integer"  },
  { field_name: "doc_id",       field_schema: "keyword"  },
  { field_name: "ingested_at",  field_schema: "datetime" },
  { field_name: "lane",         field_schema: "keyword"  }, // doc|ui-screenshot|video-frame|chart|whiteboard
];

const LANE_VALUES = ["doc", "ui-screenshot", "video-frame", "chart", "whiteboard"];

async function qd(method, path, body) {
  const url = `${QDRANT_URL}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const e = new Error(`Qdrant unreachable at ${QDRANT_URL}: ${err.message}`);
    e.code = "UNREACHABLE";
    throw e;
  }
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
  }
  if (!res.ok) {
    const e = new Error(`Qdrant ${method} ${path} -> ${res.status} ${res.statusText}: ${text}`);
    e.status = res.status;
    e.body = json ?? text;
    throw e;
  }
  return json;
}

function isCompatibleConfig(existing) {
  // Walk the cluster response defensively — Qdrant has shifted this schema between minor versions.
  try {
    const cfg = existing?.result?.config ?? existing?.config ?? {};
    const params = cfg.params ?? {};
    const vectors = params.vectors ?? {};
    const size = vectors.size ?? vectors?.default?.size;
    const distance = vectors.distance ?? vectors?.default?.distance;
    const mv = vectors.multivector_config ?? vectors.multi_vector_config ?? vectors?.default?.multivector_config;
    const dtype = vectors.datatype ?? vectors?.default?.datatype;

    const sizeOk = size === VECTOR_SIZE;
    const distOk = String(distance).toLowerCase() === DISTANCE.toLowerCase();
    const mvOk = !!mv && String(mv.comparator).toLowerCase() === MULTIVEC_COMPARATOR.toLowerCase();
    // datatype mismatch is a warning, not a blocker — older deployments may store as float; we want uint8.
    const dtypeOk = !dtype || String(dtype).toLowerCase() === DATATYPE.toLowerCase();

    return { ok: sizeOk && distOk && mvOk, sizeOk, distOk, mvOk, dtypeOk, observed: { size, distance, mv, dtype } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function ensurePayloadIndexes() {
  for (const idx of PAYLOAD_INDEXES) {
    try {
      await qd("PUT", `/collections/${COLLECTION}/index`, idx);
      console.log(`  index ok: ${idx.field_name} (${idx.field_schema})`);
    } catch (err) {
      // 409/400 typically means the index already exists with same schema. Log and continue.
      if (err.status === 409 || err.status === 400) {
        console.log(`  index already present: ${idx.field_name}`);
      } else {
        throw err;
      }
    }
  }
}

async function main() {
  console.log(`[orange5-vision] target Qdrant: ${QDRANT_URL}`);
  console.log(`[orange5-vision] collection:    ${COLLECTION}`);

  // 1. Probe Qdrant root.
  let root;
  try {
    root = await qd("GET", "/", undefined);
    console.log(`[orange5-vision] Qdrant ${root?.version ?? "(unknown version)"} alive`);
  } catch (err) {
    if (err.code === "UNREACHABLE") {
      console.error(`[orange5-vision] FATAL: ${err.message}`);
      console.error(`[orange5-vision] hint: is the aeorangebox-ai-box-qdrant-1 container running?`);
      process.exit(1);
    }
    console.error(`[orange5-vision] FATAL: probe failed: ${err.message}`);
    process.exit(3);
  }

  // 2. Does collection exist?
  let existing = null;
  try {
    existing = await qd("GET", `/collections/${COLLECTION}`, undefined);
  } catch (err) {
    if (err.status !== 404) {
      console.error(`[orange5-vision] FATAL: collection probe failed: ${err.message}`);
      process.exit(3);
    }
  }

  if (existing) {
    const compat = isCompatibleConfig(existing);
    if (compat.ok) {
      console.log(`[orange5-vision] collection already exists with compatible config — no-op`);
      if (!compat.dtypeOk) {
        console.log(`[orange5-vision] note: existing datatype != ${DATATYPE} (observed: ${compat.observed?.dtype}). Tolerated, but reindex for uint8 storage gains.`);
      }
      await ensurePayloadIndexes();
      console.log(`[orange5-vision] DONE`);
      process.exit(0);
    } else {
      console.error(`[orange5-vision] FATAL: collection exists with INCOMPATIBLE config`);
      console.error(`  size_ok=${compat.sizeOk} distance_ok=${compat.distOk} multivec_ok=${compat.mvOk}`);
      console.error(`  observed=${JSON.stringify(compat.observed)}`);
      console.error(`[orange5-vision] action: drop or rename the collection, then re-run init.`);
      process.exit(2);
    }
  }

  // 3. Create.
  const createBody = {
    vectors: {
      size: VECTOR_SIZE,
      distance: DISTANCE,
      multivector_config: { comparator: MULTIVEC_COMPARATOR },
      datatype: DATATYPE,
      on_disk: true,
    },
    // Sane Phase-1 HNSW defaults; tune in PR-14.
    hnsw_config: { m: 16, ef_construct: 100, on_disk: true },
    optimizers_config: { default_segment_number: 2 },
  };

  try {
    await qd("PUT", `/collections/${COLLECTION}`, createBody);
    console.log(`[orange5-vision] collection created`);
  } catch (err) {
    console.error(`[orange5-vision] FATAL: create failed: ${err.message}`);
    process.exit(3);
  }

  // 4. Payload indexes.
  console.log(`[orange5-vision] adding payload indexes…`);
  try {
    await ensurePayloadIndexes();
  } catch (err) {
    console.error(`[orange5-vision] FATAL: payload index step failed: ${err.message}`);
    process.exit(3);
  }

  console.log(`[orange5-vision] lane vocabulary (enforced at writer layer, not Qdrant): ${LANE_VALUES.join(", ")}`);
  console.log(`[orange5-vision] DONE`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[orange5-vision] UNCAUGHT: ${err.stack || err.message}`);
  process.exit(3);
});
