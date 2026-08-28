// embedder.mjs
//
// Graph Weaver embedder wrapper. Wraps Ollama's /api/embeddings endpoint with
// the canonical Æ contract: deterministic dimensionality, exponential backoff
// on transient pressure (429 / 503), and a sibling helper that serializes the
// vector into a Node Buffer suitable for SQLite BLOB storage (3072 bytes,
// little-endian float32, 768 dims).
//
// This module is loaded by daemon.mjs as the default embedder. The daemon's
// internal `embeddingToBlob(vec)` accepts the Float32Array returned here and
// stores it in nodes.embedding (BLOB, 3072 bytes). A `toBuffer` helper is
// also exported for callers that want the raw BLOB form directly.
//
// Doctrine (Graph Weaver, locked):
//   - Model:     nomic-embed-text:latest (Ollama)
//   - Host:      127.0.0.1:11434 (operator's local Ollama)
//   - Dim:       768 float32
//   - Storage:   Buffer of 768*4 = 3072 bytes, little-endian
//
// No fallbacks, no silent shape changes. If Ollama is down or the model
// returns the wrong shape, this throws. The daemon decides whether to leave
// the node embedding null or to retry later.

const DEFAULT_HOST    = process.env.OLLAMA_HOST    || 'http://127.0.0.1:11434';
const DEFAULT_MODEL   = process.env.EMBED_MODEL    || 'nomic-embed-text:latest';
const DEFAULT_DIM     = 768;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF = [200, 1000, 5000]; // ms, attempt 1 / 2 / 3

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  // 429 = rate-limited (Ollama can emit this under load)
  // 503 = service unavailable (model still loading, host paused)
  return status === 429 || status === 503;
}

function normalizeHost(host) {
  return String(host || '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// raw Ollama call
// ---------------------------------------------------------------------------

async function callOllamaEmbeddings({ host, model, prompt, signal }) {
  const url = `${normalizeHost(host)}/api/embeddings`;
  const body = { model, prompt };

  let res;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Network failure (ECONNREFUSED, DNS, etc.) — wrap so the retry loop can
    // distinguish transport errors from HTTP-level errors.
    const e = new Error(`ollama-embed transport: ${err?.message || err}`);
    e.transport = true;
    e.cause = err;
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`ollama-embed http ${res.status}: ${text.slice(0, 240)}`);
    err.status = res.status;
    err.retryable = isRetryableStatus(res.status);
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`ollama-embed bad-json: ${err?.message || err}`);
  }

  const arr = data?.embedding;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('ollama-embed empty-embedding');
  }
  return arr;
}

// ---------------------------------------------------------------------------
// retry wrapper
// ---------------------------------------------------------------------------

async function withBackoff(fn, { retries = DEFAULT_RETRIES, schedule = DEFAULT_BACKOFF } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = err?.transport === true || err?.retryable === true;
      const isLast = attempt === retries - 1;
      if (!retryable || isLast) throw err;
      const delay = schedule[attempt] ?? schedule[schedule.length - 1] ?? 1000;
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Embed a single text string. Returns a Float32Array of length 768.
 *
 * Throws if Ollama is unreachable after retries, the model returns a
 * vector of the wrong dimensionality, or the input is not a non-empty string.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.host]    Ollama host (default 127.0.0.1:11434)
 * @param {string} [opts.model]   embedding model (default nomic-embed-text:latest)
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.retries] number of attempts including the first (default 3)
 * @returns {Promise<Float32Array>}
 */
export async function embedText(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('embedText: text must be a non-empty string');
  }
  const host    = opts.host    ?? DEFAULT_HOST;
  const model   = opts.model   ?? DEFAULT_MODEL;
  const signal  = opts.signal;
  const retries = Number.isFinite(opts.retries) ? opts.retries : DEFAULT_RETRIES;

  const arr = await withBackoff(
    () => callOllamaEmbeddings({ host, model, prompt: text, signal }),
    { retries }
  );

  if (arr.length !== DEFAULT_DIM) {
    throw new Error(`embedText: wrong dim ${arr.length}, expected ${DEFAULT_DIM} (model=${model})`);
  }
  return Float32Array.from(arr);
}

/**
 * Embed an array of texts. Returns Float32Array[] with one vector per input,
 * in the same order. Ollama's /api/embeddings is single-prompt, so this fans
 * out sequentially to keep ordering deterministic and avoid stampeding the
 * N150's model loader. Each call uses its own backoff budget.
 *
 * Empty array in -> empty array out.
 *
 * @param {string[]} texts
 * @param {object} [opts]
 * @returns {Promise<Float32Array[]>}
 */
export async function embedBatch(texts, opts = {}) {
  if (!Array.isArray(texts)) {
    throw new Error('embedBatch: texts must be an array of strings');
  }
  if (texts.length === 0) return [];
  const out = new Array(texts.length);
  for (let i = 0; i < texts.length; i += 1) {
    out[i] = await embedText(texts[i], opts);
  }
  return out;
}

/**
 * Serialize a Float32Array embedding to a Node Buffer for SQLite BLOB
 * storage. The result is exactly 3072 bytes (768 * 4) for the canonical
 * Graph Weaver dimensionality.
 *
 * Tolerates a plain number[] as input (will be coerced via Float32Array.from).
 *
 * @param {Float32Array | number[]} vec
 * @returns {Buffer | null}
 */
export function toBuffer(vec) {
  if (vec == null) return null;
  const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Inverse of toBuffer. Lift a SQLite BLOB back into a Float32Array view.
 * Returns null on null input. Throws if length is not a multiple of 4.
 *
 * @param {Buffer | Uint8Array | null} buf
 * @returns {Float32Array | null}
 */
export function fromBuffer(buf) {
  if (buf == null) return null;
  if (!(buf instanceof Uint8Array)) {
    throw new Error('fromBuffer: expected Buffer or Uint8Array');
  }
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`fromBuffer: byteLength ${buf.byteLength} not a multiple of 4`);
  }
  // Copy out so callers don't accidentally alias SQLite's internal buffer.
  const copy = new Float32Array(buf.byteLength / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < copy.length; i += 1) {
    copy[i] = view.getFloat32(i * 4, true /* little-endian */);
  }
  return copy;
}

export const EMBED_DIM        = DEFAULT_DIM;
export const EMBED_MODEL      = DEFAULT_MODEL;
export const EMBED_HOST       = DEFAULT_HOST;
export const EMBED_BLOB_BYTES = DEFAULT_DIM * 4;

export default {
  embedText,
  embedBatch,
  toBuffer,
  fromBuffer,
  EMBED_DIM,
  EMBED_MODEL,
  EMBED_HOST,
  EMBED_BLOB_BYTES,
};
