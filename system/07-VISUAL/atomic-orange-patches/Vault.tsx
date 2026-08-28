// Vault.tsx — OrangeEye Phase-1 Vault lane
//
// Replaces atomic-orange/src/Vault.tsx with the OrangeEye-aware visual vault.
// React 19. No code-editor surface (Codeless Law). No file tree. No repo indexer.
// Just drag-drop ingest, multi-vector visual search, grounded result cards, and
// on-demand cortex describe.
//
// Talks to the OrangeEye HTTP surface running on Codexa:
//   POST /v1/visual/ingest    — multipart upload, returns { doc_id, pages, image_sha256 }
//   POST /v1/visual/query     — JSON { q, k }, returns { hits: VisualHit[] }
//   POST /v1/visual/describe  — JSON { doc_id, page, bbox? }, returns { description, model, confidence, frontier_used }
//
// Frontier-Isolation Law: this UI never talks to a frontier model directly. It hits
// the OrangeEye edge surface, which in turn calls GLM-4.6V locally and only fans
// out to the OrangeLLM gateway (:1337) when /deep is set or confidence<0.7.
//
// Mom's Law: every block earns its place. No theater.

import { useCallback, useEffect, useRef, useState } from "react";

// ---- types ----------------------------------------------------------------

interface PatchBBox {
  /** Normalized 0..1 coords against the page image. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Optional patch score (MaxSim contribution). Higher = brighter overlay. */
  score?: number;
}

interface VisualHit {
  doc_id: string;
  page: number;
  score: number;
  /** Server-side summary of the page or cited region. */
  summary?: string;
  /** Server-provided thumbnail URL (relative path served by the OrangeEye API). */
  thumbnail_url?: string;
  /** Patch-level grounding bboxes the cortex / retriever attributed the score to. */
  grounding?: PatchBBox[];
  /** Source filename, when available. */
  source?: string;
  image_sha256?: string;
}

interface DescribeState {
  loading: boolean;
  text?: string;
  model?: string;
  confidence?: number;
  frontier_used?: boolean;
  error?: string;
}

// ---- config ---------------------------------------------------------------

const API_BASE = (typeof window !== "undefined" && (window as any).__ORANGEEYE_API__) || "/api/orangeeye";
const INGEST_URL = `${API_BASE}/v1/visual/ingest`;
const QUERY_URL = `${API_BASE}/v1/visual/query`;
const DESCRIBE_URL = `${API_BASE}/v1/visual/describe`;

const ACCEPT_TYPES = "application/pdf,image/png,image/jpeg,image/webp,image/tiff";

// ---- component ------------------------------------------------------------

export function Vault() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<VisualHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>();

  const [dragOver, setDragOver] = useState(false);
  const [ingestQueue, setIngestQueue] = useState<
    Array<{ name: string; status: "pending" | "ok" | "err"; detail?: string }>
  >([]);

  const [describe, setDescribe] = useState<Record<string, DescribeState>>({});

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queryAbortRef = useRef<AbortController | null>(null);

  // ---- ingest ----

  const ingestFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      const key = `${file.name}-${file.size}-${Date.now()}`;
      setIngestQueue(prev => [{ name: file.name, status: "pending" }, ...prev].slice(0, 20));
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(INGEST_URL, { method: "POST", body: fd });
        if (!res.ok) {
          const txt = await res.text().catch(() => res.statusText);
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 140)}`);
        }
        const json = (await res.json()) as { doc_id?: string; pages?: number };
        setIngestQueue(prev =>
          prev.map(item =>
            item.name === file.name && item.status === "pending"
              ? { ...item, status: "ok", detail: `doc=${json.doc_id ?? "?"} pages=${json.pages ?? "?"}` }
              : item
          )
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setIngestQueue(prev =>
          prev.map(item =>
            item.name === file.name && item.status === "pending" ? { ...item, status: "err", detail: msg } : item
          )
        );
      }
      // small interleave so the UI repaints between files
      await new Promise(r => setTimeout(r, 10));
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) void ingestFiles(files);
    },
    [ingestFiles]
  );

  const onPickFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length) void ingestFiles(files);
      // reset so same file can be re-picked
      e.target.value = "";
    },
    [ingestFiles]
  );

  // ---- search ----

  const runQuery = useCallback(async (q: string) => {
    if (!q.trim()) {
      setHits([]);
      setSearchError(undefined);
      return;
    }
    queryAbortRef.current?.abort();
    const ac = new AbortController();
    queryAbortRef.current = ac;
    setSearching(true);
    setSearchError(undefined);
    try {
      const res = await fetch(QUERY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, k: 12 }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText);
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const json = (await res.json()) as { hits?: VisualHit[] };
      setHits(Array.isArray(json.hits) ? json.hits : []);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setSearchError(`Qdrant or Eye unreachable — ${msg}`);
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, []);

  // debounced search
  useEffect(() => {
    const id = setTimeout(() => void runQuery(query), 220);
    return () => clearTimeout(id);
  }, [query, runQuery]);

  // ---- describe ----

  const runDescribe = useCallback(
    async (hit: VisualHit, deep = false) => {
      const key = `${hit.doc_id}:${hit.page}`;
      setDescribe(prev => ({ ...prev, [key]: { loading: true } }));
      try {
        const res = await fetch(DESCRIBE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            doc_id: hit.doc_id,
            page: hit.page,
            bbox: hit.grounding?.[0] ?? null,
            deep,
          }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => res.statusText);
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
        }
        const json = (await res.json()) as {
          description?: string;
          model?: string;
          confidence?: number;
          frontier_used?: boolean;
        };
        setDescribe(prev => ({
          ...prev,
          [key]: {
            loading: false,
            text: json.description,
            model: json.model,
            confidence: json.confidence,
            frontier_used: json.frontier_used,
          },
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDescribe(prev => ({
          ...prev,
          [key]: { loading: false, error: `GLM-4.6V or gateway unreachable — ${msg}` },
        }));
      }
    },
    []
  );

  // ---- render ----

  return (
    <div className="lane vault-lane">
      <section className="lane-hero">
        <div>
          <div className="eyebrow">OrangeEye vault</div>
          <h1>See, don't read</h1>
          <p className="whisper">
            Drop PDFs and screenshots. Eye encodes them as 196 visual patches per page (ColQwen2.5 / Int8) into Qdrant.
            Search returns spatial grounding — not OCR soup. Edge cortex (GLM-4.6V) describes what landed.
          </p>
        </div>
        <div className="hero-panel">
          <div className="vault-count">{hits.length}</div>
          <div className="vault-label">visual hits this query</div>
          <div className="micro-grid">
            <span>multi-vector</span>
            <span>MaxSim</span>
            <span>frontier-isolated</span>
          </div>
        </div>
      </section>

      {/* drag-drop ingest */}
      <div
        className={`oe-dropzone${dragOver ? " is-over" : ""}`}
        onDragOver={e => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
        }}
      >
        <div className="oe-dropzone-icon" aria-hidden>
          {"◉"}
        </div>
        <div className="oe-dropzone-title">Drop PDFs or images here</div>
        <div className="oe-dropzone-sub">or click to pick — encoded with ColQwen2.5, indexed in Qdrant</div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_TYPES}
          multiple
          hidden
          onChange={onPickFiles}
        />
      </div>

      {ingestQueue.length > 0 && (
        <div className="oe-ingest-queue">
          {ingestQueue.map((item, i) => (
            <div key={`${item.name}-${i}`} className={`oe-ingest-row oe-${item.status}`}>
              <span className="oe-ingest-dot" aria-hidden />
              <span className="oe-ingest-name">{item.name}</span>
              <span className="oe-ingest-detail">
                {item.status === "pending" ? "encoding..." : item.detail ?? item.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* search */}
      <div className="vault-searchbar">
        <input
          className="chat-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="ask the vault — 'the chart on page 4', 'a stop sign', 'the table totaling Q3'..."
        />
        {searching && <span className="oe-spinner" aria-label="searching" />}
      </div>

      {searchError && <div className="oe-error">{searchError}</div>}

      {/* results */}
      <div className="oe-results">
        {hits.map(hit => {
          const key = `${hit.doc_id}:${hit.page}`;
          const d = describe[key];
          return (
            <article key={key} className="oe-card">
              <div className="oe-card-thumb">
                {hit.thumbnail_url ? (
                  <img
                    src={hit.thumbnail_url}
                    alt={`page ${hit.page}`}
                    loading="lazy"
                    draggable={false}
                  />
                ) : (
                  <div className="oe-thumb-fallback">no thumb</div>
                )}
                {(hit.grounding ?? []).map((bb, i) => (
                  <div
                    key={i}
                    className="oe-grounding"
                    style={{
                      left: `${bb.x * 100}%`,
                      top: `${bb.y * 100}%`,
                      width: `${bb.w * 100}%`,
                      height: `${bb.h * 100}%`,
                      opacity: 0.4 + Math.min(0.6, (bb.score ?? hit.score) * 0.6),
                    }}
                  />
                ))}
              </div>
              <div className="oe-card-body">
                <div className="oe-card-meta">
                  <span className="oe-card-page">page {hit.page}</span>
                  <span className="oe-score-meter" title={`MaxSim ${hit.score.toFixed(3)}`}>
                    <span
                      className="oe-score-fill"
                      style={{ width: `${Math.min(100, Math.max(4, hit.score * 100))}%` }}
                    />
                  </span>
                  <span className="oe-card-score">{hit.score.toFixed(2)}</span>
                </div>
                <div className="oe-card-source">{hit.source ?? hit.doc_id}</div>
                {hit.summary && <p className="oe-card-summary">{hit.summary}</p>}

                <div className="oe-card-actions">
                  <button
                    className="quick-button"
                    type="button"
                    disabled={d?.loading}
                    onClick={() => runDescribe(hit, false)}
                  >
                    {d?.loading ? "describing..." : "describe"}
                  </button>
                  <button
                    className="quick-button"
                    type="button"
                    disabled={d?.loading}
                    onClick={() => runDescribe(hit, true)}
                    title="Force frontier offload via OrangeLLM gateway"
                  >
                    /deep
                  </button>
                </div>

                {d?.error && <div className="oe-error inline">{d.error}</div>}
                {d?.text && (
                  <div className="oe-describe">
                    <div className="oe-describe-text">{d.text}</div>
                    <div className="oe-describe-meta">
                      <span>{d.model ?? "cortex"}</span>
                      {typeof d.confidence === "number" && <span>conf {d.confidence.toFixed(2)}</span>}
                      {d.frontier_used && <span className="oe-frontier-tag">frontier</span>}
                    </div>
                  </div>
                )}
              </div>
            </article>
          );
        })}

        {!searching && !searchError && query.trim() && hits.length === 0 && (
          <div className="oe-empty">No visual hits. Try dropping a doc first, or rephrase.</div>
        )}
        {!query.trim() && hits.length === 0 && (
          <div className="oe-empty soft">
            Index is dark. Drop a doc above to seed the vault, then ask a visual question.
          </div>
        )}
      </div>

      <section className="panel vault-guidance">
        <div className="card-h">OrangeEye posture</div>
        <p>
          Phase-1 honesty: ingest runs ColQwen2.5 on Codexa CPU+NPU (~500ms–2s/page). Search hits Qdrant
          collection <code>orange5-vision</code> with MaxSim. Describe runs GLM-4.6V Q4 via Ollama locally; <code>/deep</code> or
          confidence&lt;0.7 routes to the OrangeLLM gateway at <code>127.0.0.1:1337/v1</code>. The Vault does not expose code, a
          file tree, or a repo indexer — Codeless Law.
        </p>
      </section>
    </div>
  );
}

export default Vault;
