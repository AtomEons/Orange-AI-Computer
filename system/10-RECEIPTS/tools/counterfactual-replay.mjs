// counterfactual-replay.mjs — a time machine for reasoning.
//
// Orange5 already has deterministic replay: same seed + same order => byte-identical
// receipt. It has been used for testing. That is a fraction of what it is worth.
//
// Deterministic replay + a full causal chain + an injectable executor means history
// can be RE-RUN UNDER A CORRECTED ASSUMPTION.
//
//     "Replay AEyes seq 141->173 with the leakage-free nested evaluator from the
//      start. Which conclusions survive?"
//
// When a methodological error is found, the alternative is auditing thirty receipts
// by hand — which is how the AEyes-1 campaign actually ran, and it cost days per
// correction. Replay answers it mechanically: which conclusions were robust to the
// error, and which only ever existed because of it.
//
// Nothing here mutates history. Replay produces a SHADOW chain, compared against
// the real one. The original bytes and hashes are never touched.

import { loadChain, buildTrajectory } from './trajectory.mjs';

export const REPLAY_SCHEMA_ID = 'orange5.counterfactual-replay.v1';

/**
 * counterfactualReplay({ chain, fromSeq, toSeq, corrections, evaluator })
 *
 * @param corrections  [{ name, applies(receipt)->bool, verdict(receipt)->'SURVIVES'|'FALSIFIED'|'WEAKENED', why }]
 * @param evaluator    optional (receipt, corrections) -> { verdict, notes[] }
 * @returns shadow chain + survival analysis. Real chain untouched.
 */
export function counterfactualReplay({
  chain: injectedChain, chainPath, fromSeq = 0, toSeq = Infinity,
  corrections = [], evaluator = null,
} = {}) {
  const chain = injectedChain || loadChain(chainPath);
  const traj = buildTrajectory(chain);
  const window = chain.filter(r => r.seq >= fromSeq && r.seq <= toSeq);

  const shadow = [];
  for (const receipt of window) {
    const applied = corrections.filter(c => {
      try { return c.applies(receipt); } catch { return false; }
    });

    let verdict = 'UNAFFECTED';
    const notes = [];

    if (applied.length > 0) {
      if (evaluator) {
        const e = evaluator(receipt, applied);
        verdict = e.verdict; notes.push(...(e.notes || []));
      } else {
        // Worst verdict across applicable corrections wins.
        const rank = { SURVIVES: 0, WEAKENED: 1, FALSIFIED: 2 };
        let worst = 'SURVIVES';
        for (const c of applied) {
          let v = 'WEAKENED';
          try { v = c.verdict(receipt) || 'WEAKENED'; } catch { v = 'WEAKENED'; }
          if (rank[v] > rank[worst]) worst = v;
          notes.push(`${c.name}: ${v}${c.why ? ` — ${c.why}` : ''}`);
        }
        verdict = worst;
      }
    }

    const node = traj.nodes.get(receipt.seq);
    shadow.push({
      seq: receipt.seq, action: receipt.action,
      summary: String(receipt.summary || '').slice(0, 120),
      actual_status: node?.superseded_by != null ? `SUPERSEDED by ${node.superseded_by}` : 'LIVE',
      counterfactual_verdict: verdict,
      corrections_applied: applied.map(c => c.name),
      notes,
    });
  }

  const counts = shadow.reduce((a, s) => { a[s.counterfactual_verdict] = (a[s.counterfactual_verdict] || 0) + 1; return a; }, {});
  const falsified = shadow.filter(s => s.counterfactual_verdict === 'FALSIFIED');

  // The sharpest output: claims that were LIVE in the real chain but die under
  // the correction. These are wrong conclusions still being carried as current.
  const liveButFalsified = falsified.filter(s => s.actual_status === 'LIVE');
  // And the inverse: claims already superseded that would have survived — the
  // correction shows they were discarded for the wrong reason.
  const supersededButSurvives = shadow.filter(
    s => s.actual_status.startsWith('SUPERSEDED') && s.counterfactual_verdict === 'SURVIVES'
  );

  return {
    schema: REPLAY_SCHEMA_ID,
    window: { fromSeq, toSeq: Number.isFinite(toSeq) ? toSeq : (window.at(-1)?.seq ?? fromSeq), receipts: window.length },
    corrections: corrections.map(c => ({ name: c.name, why: c.why ?? null })),
    counts,
    shadow,
    liveButFalsified,
    supersededButSurvives,
    verdict: liveButFalsified.length > 0
      ? `${liveButFalsified.length} LIVE claim(s) do not survive the correction — currently carried as true and are not.`
      : 'no live claim is falsified by these corrections',
    historyMutated: false,
  };
}

/** Prebuilt correction: the selection-leakage error that inflated AEyes-1 TPR by 0.40. */
export function leakageCorrection({ matchAction = /tournament|law|calibrat|atlas/i } = {}) {
  return {
    name: 'nested_evaluation_from_start',
    why: 'data-dependent lane selection was made on the same samples used to score; nested evaluation removes the inflation',
    applies: r => matchAction.test(String(r.action || '')) || matchAction.test(String(r.summary || '')),
    verdict: r => {
      const s = String(r.summary || '').toLowerCase();
      if (/perfect|100%|1\.00|flawless/.test(s)) return 'FALSIFIED';
      if (/tpr|fpr|auc|accuracy|discriminat/.test(s)) return 'WEAKENED';
      return 'SURVIVES';
    },
  };
}

/** Prebuilt correction: scene/background confound in identity-discrimination claims. */
export function sceneConfoundCorrection() {
  return {
    name: 'scene_matched_negatives_required',
    why: 'classes differed on background/scene as well as category; the separator may have been scene structure',
    applies: r => /discriminat|separat|classif|recogni/i.test(`${r.action} ${r.summary}`),
    verdict: r => (/perfect|100%|1\.00/i.test(String(r.summary || '')) ? 'FALSIFIED' : 'WEAKENED'),
  };
}
