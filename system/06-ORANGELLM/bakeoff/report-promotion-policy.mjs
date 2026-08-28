export function evaluateReportPromotion(results = []) {
  if (!Array.isArray(results) || results.length < 2) {
    return { comparison_available: false, promoted: false, verdict: 'BASELINE_MEASURED' };
  }
  const [champion, challenger] = results;
  const validityNoWorse = challenger.validity_rate >= champion.validity_rate;
  const repairsNoWorse = challenger.repair_rate <= champion.repair_rate;
  const latencyWithinBudget = challenger.mean_latency_ms <= champion.mean_latency_ms * 1.1;
  const promoted = validityNoWorse && repairsNoWorse && latencyWithinBudget;
  return {
    comparison_available: true,
    promoted,
    verdict: promoted ? 'CHALLENGER_PROMOTION_ELIGIBLE' : 'CHALLENGER_NOT_PROMOTED',
    checks: { validityNoWorse, repairsNoWorse, latencyWithinBudget },
  };
}
