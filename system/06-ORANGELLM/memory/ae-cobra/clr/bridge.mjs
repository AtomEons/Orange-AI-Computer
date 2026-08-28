// clr/bridge.mjs — CLR phase router.
//
// Doctrine (Æ Cobra, Phase-5 over Night-1):
//   The Memory Daemon and any callers that used to import verifier-k1 directly
//   should call this bridge instead. The bridge selects K=1 (Night-1) vs K=5
//   (Phase-5) per turn based on (a) the event risk_level, and (b) operator
//   config. Once Phase-5 is enabled for a risk band, there is no silent fall
//   back to K=1 for that band — if K=5 cannot be evaluated (e.g. K!=5 candidates
//   supplied), the bridge reports the gap and refuses, per Mom's Law: no
//   silent fall-back.
//
// Risk-level vocabulary used by this bridge (operator/event layer, NOT the
// AgentTurn.risk enum which is limited to low/medium/high):
//   "low", "medium", "high", "destructive", "production"
//
// Default routing policy (overridable via opts.policy or opts.config):
//   low         -> K=1
//   medium      -> K=1
//   high        -> K=5
//   destructive -> K=5
//   production  -> K=5
//
// Public API:
//   verify(turn, opts) -> {
//     phase: 'k1' | 'k5',
//     accepted: boolean,
//     score?: number,           // K=1
//     median?: number,          // K=5
//     scores?: number[5],       // K=5
//     reasons: string[] | string[][],
//     k: 1 | 5,
//     threshold: number,
//     risk_level: string,
//     routed_by: 'risk_level' | 'force' | 'default',
//     gap?: string,             // present when bridge cannot honor a phase
//   }
//
// Inputs:
//   turn  : either a single AgentTurn (for K=1) OR an object of the form
//           { candidates: AgentTurn[5], event?: { risk_level?: string } }
//           for K=5. The bridge auto-detects shape, but you can also force
//           a shape via opts.force = 'k1' | 'k5'.
//   opts  : {
//     risk_level?: string,                 // explicit override
//     force?: 'k1' | 'k5',                 // force phase regardless of risk
//     threshold?: number,                  // default 0.5 (CLR-K5 doctrine)
//     context?: { reality_events?, hermes_receipts? }, // K=5 only
//     policy?: { [risk_level]: 'k1' | 'k5' }, // override per-risk routing
//     config?: { default_phase?: 'k1' | 'k5' }, // global default
//   }
//
// This bridge is a router. It performs no scoring of its own — it delegates
// to verifier-k1 and verifier-k5. That keeps the doctrine layers honest:
// promotion-gate consumes bridge output; bakeoff harness consumes K=5 output
// for the head-to-head eval; this file just decides which lens to apply.

import { verifyAgentTurnK1 } from './verifier-k1.mjs';
import { verifyCandidatesK5 } from './verifier-k5.mjs';

const DEFAULT_POLICY = Object.freeze({
  low: 'k1',
  medium: 'k1',
  high: 'k5',
  destructive: 'k5',
  production: 'k5',
});

const VALID_RISK_LEVELS = new Set(Object.keys(DEFAULT_POLICY));
const VALID_PHASES = new Set(['k1', 'k5']);

function extractRiskLevel(turn, opts) {
  if (typeof opts.risk_level === 'string' && opts.risk_level.length > 0) {
    return { risk_level: opts.risk_level.toLowerCase(), source: 'opts' };
  }
  // candidates-bundle form
  if (turn && typeof turn === 'object' && turn.event && typeof turn.event.risk_level === 'string') {
    return { risk_level: turn.event.risk_level.toLowerCase(), source: 'event' };
  }
  // single-turn form: map AgentTurn.risk (low/medium/high) through directly.
  if (turn && typeof turn === 'object' && typeof turn.risk === 'string') {
    return { risk_level: turn.risk.toLowerCase(), source: 'turn.risk' };
  }
  return { risk_level: 'low', source: 'default' };
}

function selectPhase(risk_level, opts) {
  // 1. Hard force wins.
  if (opts.force && VALID_PHASES.has(opts.force)) {
    return { phase: opts.force, routed_by: 'force' };
  }
  // 2. Per-risk policy (operator override or default).
  const policy = { ...DEFAULT_POLICY, ...(opts.policy || {}) };
  if (Object.prototype.hasOwnProperty.call(policy, risk_level)) {
    const p = policy[risk_level];
    if (VALID_PHASES.has(p)) {
      return { phase: p, routed_by: 'risk_level' };
    }
  }
  // 3. Global config default.
  const cfgDefault = opts.config?.default_phase;
  if (cfgDefault && VALID_PHASES.has(cfgDefault)) {
    return { phase: cfgDefault, routed_by: 'default' };
  }
  // 4. Last resort: K=1 is the conservative Night-1 default.
  return { phase: 'k1', routed_by: 'default' };
}

function isCandidatesBundle(turn) {
  return (
    turn &&
    typeof turn === 'object' &&
    Array.isArray(turn.candidates)
  );
}

function singleTurnFromBundle(bundle) {
  // For K=1 routing on a bundle we score candidates[0] only (per Night-1
  // doctrine — single candidate). The other 4 are discarded by this lens
  // but remain available to the caller for promotion-gate audit.
  return bundle.candidates[0];
}

export function verify(turn, opts = {}) {
  if (turn === null || turn === undefined) {
    throw new Error('CLR bridge: turn is required');
  }
  if (typeof opts !== 'object' || opts === null) {
    throw new Error('CLR bridge: opts must be an object');
  }

  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.5;
  const { risk_level } = extractRiskLevel(turn, opts);
  const { phase, routed_by } = selectPhase(risk_level, opts);

  // Honest-error on unknown risk levels: we still route (per default),
  // but we expose the gap so the operator can fix policy upstream.
  let gap;
  if (!VALID_RISK_LEVELS.has(risk_level)) {
    gap = `unknown risk_level "${risk_level}" — routing fell back to default phase ${phase}`;
  }

  if (phase === 'k5') {
    if (!isCandidatesBundle(turn)) {
      // Mom's Law: no silent fall-back. We surface the gap and refuse
      // the K=5 verification. Caller must supply 5 candidates.
      return {
        phase: 'k5',
        accepted: false,
        scores: [],
        median: 0,
        reasons: [[`bridge: K=5 selected for risk_level "${risk_level}" but no candidates[] bundle supplied`]],
        k: 5,
        threshold,
        risk_level,
        routed_by,
        gap: gap
          ? `${gap}; also missing candidates[] for K=5`
          : 'K=5 selected but candidates[] missing — Mom\'s Law: no silent fall-back to K=1',
      };
    }
    if (turn.candidates.length !== 5) {
      return {
        phase: 'k5',
        accepted: false,
        scores: [],
        median: 0,
        reasons: [[`bridge: K=5 requires exactly 5 candidates, got ${turn.candidates.length}`]],
        k: 5,
        threshold,
        risk_level,
        routed_by,
        gap: `K=5 selected but candidates.length=${turn.candidates.length} (expected 5)`,
      };
    }
    const r = verifyCandidatesK5(turn.candidates, {
      threshold,
      context: opts.context || {},
    });
    return {
      phase: 'k5',
      accepted: r.accepted,
      scores: r.scores,
      median: r.median,
      reasons: r.reasons,
      per_candidate: r.per_candidate,
      k: 5,
      threshold: r.threshold,
      risk_level,
      routed_by,
      ...(gap ? { gap } : {}),
    };
  }

  // phase === 'k1'
  const singleTurn = isCandidatesBundle(turn) ? singleTurnFromBundle(turn) : turn;
  if (!singleTurn || typeof singleTurn !== 'object') {
    throw new Error('CLR bridge: K=1 path requires an AgentTurn object');
  }
  const r = verifyAgentTurnK1(singleTurn);
  // verifier-k1 uses its own internal 0.5 cutoff; we honor opts.threshold by
  // re-evaluating acceptance against the requested threshold for consistency
  // with K=5 callers.
  const accepted = r.score >= threshold;
  return {
    phase: 'k1',
    accepted,
    score: r.score,
    reasons: r.reasons,
    k: 1,
    threshold,
    risk_level,
    routed_by,
    ...(gap ? { gap } : {}),
  };
}

export { DEFAULT_POLICY };
export default verify;
