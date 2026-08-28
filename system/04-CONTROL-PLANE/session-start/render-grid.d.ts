// Orange5 — Compact Deploy Grid Renderer (TypeScript declarations)
// Path: 04-CONTROL-PLANE/session-start/render-grid.d.ts
//
// Companion to render-grid.mjs. Lets the Atomic Orange first-launch hook
// (TypeScript) import the pure renderer with full type safety.

export const GRID_MAX_LINES: 12;
export const GRID_DEFAULT_WIDTH: 80;
export const GRID_MIN_WIDTH: 48;

export interface OperatorInfo {
  name?: string | null;
  alias?: string | null;
  email?: string | null;
  location?: string | null;
}

export interface SovereignInfo {
  name?: string | null;
  alias?: string | null;
  email?: string | null;
}

export interface HealthInfo {
  band: "GREEN" | "YELLOW" | "RED" | string;
  reds: string[];
  yellows: string[];
}

export interface SoulGenomeStep {
  ok: boolean;
  reason?: string;
  sovereign?: SovereignInfo | null;
}

export interface ContinuityStep {
  ok: boolean;
  reason?: string;
  date?: string | null;
  stale?: boolean;
  summary?: {
    progress_count?: number;
    open_blockers_count?: number;
    tomorrow_first_action?: string | null;
    hot_currents_count?: number;
  };
}

export interface GuardrailsStep {
  ok: boolean;
  reason?: string;
  violations_count?: number;
  stop?: boolean;
  transport?: "gateway" | "module" | string;
}

export interface HotCurrent {
  event_type?: string | null;
  type?: string | null;
  origin?: string | null;
  ts?: string | number | null;
  title?: string | null;
  severity?: string | null;
}

export interface HotCurrentsStep {
  ok: boolean;
  reason?: string;
  count?: number;
  stale?: boolean;
  currents?: HotCurrent[];
}

export interface NotGreenLedgerStep {
  ok: boolean;
  reason?: string;
  total_open?: number;
}

export interface SessionStartGrid {
  schema?: string;
  session_id?: string;
  generated_at?: string;
  elapsed_ms?: number;
  cache_hit?: boolean;
  operator?: OperatorInfo;
  health?: HealthInfo;
  steps?: {
    soul_genome?: SoulGenomeStep;
    continuity?: ContinuityStep;
    guardrails?: GuardrailsStep;
    hot_currents?: HotCurrentsStep;
    not_green_ledger?: NotGreenLedgerStep;
  };
  receipt?: { path?: string; sha256?: string } | null;
}

export interface RenderGridOptions {
  /** Output width in chars; clamped to [GRID_MIN_WIDTH, 200]. Default 80. */
  width?: number;
  /** When true, use pure-ASCII frame chars (+ - |). Default false. */
  ascii?: boolean;
}

export interface ExtractedGridFields {
  time: string;
  location: string;
  operator: string;
  sovereign: string;
  hot_currents: string;
  guardrails_status: string;
  blockers: string;
  continuity_lookback: string;
}

/**
 * Render an Orange5 SessionStartGrid into a compact 12-line ASCII string.
 * Pure function. Deterministic. No I/O. No model invocations.
 */
export function renderGrid(grid: SessionStartGrid, opts?: RenderGridOptions): string;

/** Extract the eight field-row values without rendering the frame. */
export function extractGridFields(grid: SessionStartGrid): ExtractedGridFields;

export default renderGrid;
