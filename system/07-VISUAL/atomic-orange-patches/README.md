# OrangeEye Vault — atomic-orange patches

Manual patches for the `atomic-orange` UI (the 02-APP shell). Apply by hand; nothing in this folder commits itself.

## Files

- `Vault.tsx` — Full replacement for `02-APP/src/Vault.tsx`. OrangeEye-aware visual vault: drag-drop ingest, multi-vector search, grounded result cards, on-demand describe.
- `vault-styles.css` — ~120 lines of additional CSS. Appends to `02-APP/src/styles.css`. Uses existing palette variables (`--orange`, `--stroke-hot`, `--panel`, `--text`).

## Apply

```powershell
# from C:\AtomEons\Orange5
Copy-Item .\07-VISUAL\atomic-orange-patches\Vault.tsx .\02-APP\src\Vault.tsx -Force

# append (do NOT overwrite) the styles
Get-Content .\07-VISUAL\atomic-orange-patches\vault-styles.css | Add-Content .\02-APP\src\styles.css

# validate
cd .\02-APP
npm run dev
```

> Note: the current `Vault.tsx` lives at `02-APP/src/lanes/Vault.tsx` in the working tree (sub-folder), not `02-APP/src/Vault.tsx`. If your tree matches that, copy to `02-APP/src/lanes/Vault.tsx` instead. The patch is path-agnostic — the export shape (`export function Vault()` and `export default Vault`) matches both call sites.

After `npm run dev`:
- Open the Vault lane in the running atomic-orange app.
- Drop a PDF onto the dropzone. Expect a row to appear in the ingest queue moving from `encoding...` to `doc=... pages=...`.
- Type a query; expect results within ~1s once the index has content.

## What this does

- Drag-drop (or click-to-pick) PDFs and images, POST to `/v1/visual/ingest` on the OrangeEye edge surface.
- Debounced search bar POSTs to `/v1/visual/query` with `{ q, k: 12 }`. Aborts in-flight queries on new keystrokes.
- Renders each hit as a card with: page thumbnail, page number, score meter, MaxSim score, cited summary, and orange-stroked grounding overlays drawn from the patch bboxes the server returned.
- "describe" button hits `/v1/visual/describe` for the hit's first grounding bbox. "/deep" button forces frontier offload via the OrangeLLM gateway.
- Surfaces `frontier_used` and the cortex model name returned by the describe endpoint so the operator can see when frontier was actually used.
- Honest error states for Qdrant-unreachable, Eye-unreachable, and GLM-4.6V-unreachable failure modes.

## What this does NOT do yet

- **No client-side PDF rasterization.** The server is expected to return `thumbnail_url` per hit. If the OrangeEye backend hasn't shipped thumbnails yet, cards show a `no thumb` placeholder and the grounding overlays still render against that placeholder rect (degraded but functional).
- **No multi-page expansion.** A hit is one page. There's no "view all pages of this doc" affordance — that belongs to a follow-up Reader lane, not the Vault.
- **No bbox editing.** Grounding overlays are read-only. Operator cannot draw a region and ask for a description of it; that's a Phase-2 affordance.
- **No streaming describe.** The describe call is a single POST/response. No SSE/WS yet. A long-running frontier call will block the button (disabled state) until it returns.
- **No auth.** The component assumes the OrangeEye HTTP surface is reachable on localhost via the dev proxy. Production auth lives in the gateway, not here.
- **No code editor, file tree, or repo indexer.** Codeless Law. This is not a feature gap — it is enforced.
- **API base override.** Defaults to `/api/orangeeye`. Set `window.__ORANGEEYE_API__` (e.g. in `index.html` for the dev shell) to point at a non-default host. No env-var plumbing was added — kept the patch surface small.

## Failure modes covered

| Failure | UI behavior |
|---|---|
| Ingest endpoint 4xx/5xx | Row in ingest queue marked red with HTTP code + first 140 chars of body. |
| Network error during ingest | Same as above, status `err`, detail shows the JS error message. |
| Query endpoint unreachable | Red error banner: "Qdrant or Eye unreachable — &lt;reason&gt;". Hits cleared. |
| Describe endpoint unreachable | Inline red note under the card body: "GLM-4.6V or gateway unreachable — &lt;reason&gt;". Other cards keep working. |
| Empty index with a query | Soft empty state: "No visual hits. Try dropping a doc first, or rephrase." |
| Empty query and no hits | Soft empty state pointing the operator at the dropzone. |

## Contract assumed of the backend

```ts
POST /v1/visual/ingest        // multipart 'file' → { doc_id, pages, image_sha256 }
POST /v1/visual/query         // { q, k } → { hits: VisualHit[] }
POST /v1/visual/describe      // { doc_id, page, bbox?, deep? } → { description, model, confidence, frontier_used }
```

`VisualHit` shape the UI consumes:

```ts
{
  doc_id: string;
  page: number;
  score: number;          // MaxSim, expected 0..1ish
  summary?: string;
  thumbnail_url?: string; // relative URL the dev proxy serves
  grounding?: Array<{ x: number; y: number; w: number; h: number; score?: number }>; // normalized 0..1
  source?: string;
  image_sha256?: string;
}
```

If the OrangeEye edge surface diverges from this contract, the patch needs a sibling update — flag it in `07-VISUAL/PR-13-SPEC.md`, don't paper over it in the UI.

## Verification checklist

- [ ] `npm run dev` boots without TypeScript errors against React 19.
- [ ] Vault lane mounts; dropzone is visible and palette-correct (orange hot border on hover).
- [ ] Dragging a PDF over the zone toggles the `.is-over` glow.
- [ ] An ingest call appears in DevTools Network with `multipart/form-data` body.
- [ ] A search call appears with `Content-Type: application/json` and `{ q, k: 12 }` payload.
- [ ] Grounding boxes render with orange strokes scaled correctly inside the thumbnail aspect box.
- [ ] No code editor, no file tree, no repo browser anywhere in the lane (Codeless Law).
