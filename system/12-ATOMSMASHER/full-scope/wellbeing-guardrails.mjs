// AtomSmasher Full-Scope — 27-Guardrails Wellbeing Constitution
//
// Faithful Bun port of `AeoNs/extracted/atomeons/covenant/wellbeing.py` (372 LOC).
//
// THE 27 GUARDRAILS the operator's CLAUDE.md treats as constitutional invariant.
// The Bun-side 27-guardrails daemon was flagging these as MISSING — they exist
// here, just at a path the daemon wasn't checking. This port closes the audit.
//
// Constitution status (from source): "Constitutional Law (immutable)"
//
// Final constitutional line:
//   AtomEons should materially improve human life without eroding
//   human sovereignty, truth contact, dignity, or agency.
//
// Acceptance question for every feature:
//   Did this make the user more capable, calmer, clearer, safer, and more sovereign?

import { performance } from 'node:perf_hooks';

export const CONSTITUTION_VERSION = 'wellbeing-v1';

function now() { return Date.now() / 1000; }

// ═══════════════════════════════════════════════════════════════════
// ANTI-METRICS — things we must NEVER optimize for
// ═══════════════════════════════════════════════════════════════════

export const ANTI_METRICS = new Set([
  'session_length',
  'notification_clicks',
  'compulsive_revisit_loops',
  'emotional_volatility',
  'surveillance_yield',
  'ad_yield',
  'content_throughput',
  'attention_capture',
  'return_frequency_addiction',
  'time_on_device',
]);

export const PRO_METRICS = new Set([
  'task_completion_quality',
  'regret_reduction',
  'overload_reduction',
  'continuity',
  'mastery',
  'mindstate_stability',
  'time_restored_to_life',
  'trust',
  'rhythm_health',
  'creative_followthrough',
  'relational_followthrough',
]);

// ═══════════════════════════════════════════════════════════════════
// GUARDRAIL VIOLATIONS
// ═══════════════════════════════════════════════════════════════════

export const GuardrailCategory = Object.freeze({
  FOUNDATIONAL: 'foundational',
  BEHAVIORAL: 'behavioral',
  COGNITIVE: 'cognitive',
  EMOTIONAL: 'emotional',
  TRUST: 'trust',
  TECHNICAL: 'technical',
});

export class GuardrailViolation {
  constructor({
    guardrailId = 0,
    category = GuardrailCategory.FOUNDATIONAL,
    description = '',
    severity = 0.5,
    actionBlocked = false,
    timestamp = null,
  } = {}) {
    this.guardrailId = Number(guardrailId);
    this.category = String(category);
    this.description = String(description);
    this.severity = Number(severity);
    this.actionBlocked = Boolean(actionBlocked);
    this.timestamp = timestamp == null ? now() : Number(timestamp);
  }

  toDict() {
    return {
      id: this.guardrailId,
      category: this.category,
      desc: this.description.slice(0, 80),
      severity: Number(this.severity.toFixed(2)),
      blocked: this.actionBlocked,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// InteractionProfile — tracks usage for anti-metric detection
// ═══════════════════════════════════════════════════════════════════

export class InteractionProfile {
  constructor() {
    this.sessionStart = now();
    this.interactionsThisSession = 0;
    this.interruptionsSent = 0;
    this.lastInterruption = 0.0;
    this.missionsToday = 0;
    this.voiceInterventionsToday = 0;
    this.consecutiveSessions = 0;
    this.lastSessionEnd = 0.0;
  }

  get sessionMinutes() {
    return (now() - this.sessionStart) / 60;
  }

  get interactionsPerMinute() {
    const mins = Math.max(1, this.sessionMinutes);
    return this.interactionsThisSession / mins;
  }
}

// ═══════════════════════════════════════════════════════════════════
// WellbeingMonitor — continuous guardrail enforcement
// ═══════════════════════════════════════════════════════════════════

export class WellbeingMonitor {
  constructor({ store = null, maxViolations = 200 } = {}) {
    this._profile = new InteractionProfile();
    this._violations = [];
    this._maxViolations = maxViolations;
    this.store = store;
  }

  /**
   * Check an action against all applicable guardrails.
   * Returns list of violations. Empty = action is clean.
   * Called before every submit.
   */
  checkAction({
    actionTitle = '',
    actionType = 'mission',
    mindstate = 'unknown',
    isProactive = false,
    uncertainty = 0.5,
  } = {}) {
    const violations = [];
    let blockedCount = 0;
    const profile = this._profile;
    profile.interactionsThisSession += 1;

    // Hoist invariants: single now() per call, lowercase actionType once, sessionMinutes once.
    const tNow = now();
    const sessionMinutes = (tNow - profile.sessionStart) / 60;
    // Avoid .toLowerCase() unless uncertainty actually gates G9.
    let actionTypeLower = null;

    // G6: Bounded proactivity
    if (isProactive && profile.interruptionsSent >= 3) {
      violations.push(new GuardrailViolation({
        guardrailId: 6,
        category: GuardrailCategory.BEHAVIORAL,
        description: 'Proactive limit reached (3/hour). Silence is correct.',
        severity: 0.4,
        actionBlocked: true,
      }));
      blockedCount++;
    }

    // G7: Interruption law
    if (isProactive) {
      const sinceLast = tNow - profile.lastInterruption;
      if (sinceLast < 300) {
        violations.push(new GuardrailViolation({
          guardrailId: 7,
          category: GuardrailCategory.BEHAVIORAL,
          description: `Interruption too soon (${sinceLast.toFixed(0)}s < 300s)`,
          severity: 0.3,
          actionBlocked: true,
        }));
        blockedCount++;
      }
    }

    // G9: No false omniscience — only lowercase when uncertainty gate is hot.
    if (uncertainty > 0.7) {
      actionTypeLower = actionType.toLowerCase();
      if (actionTypeLower.indexOf('answer') !== -1) {
        violations.push(new GuardrailViolation({
          guardrailId: 9,
          category: GuardrailCategory.BEHAVIORAL,
          description: `High uncertainty (${Math.round(uncertainty * 100)}%) — must express uncertainty, not fluency`,
          severity: 0.5,
        }));
      }
    }

    // G14: Protect deep attention
    if (isProactive && mindstate === 'focused') {
      violations.push(new GuardrailViolation({
        guardrailId: 14,
        category: GuardrailCategory.COGNITIVE,
        description: 'User in deep focus. Do not fragment attention.',
        severity: 0.6,
        actionBlocked: true,
      }));
      blockedCount++;
    }

    // G15: Respect recovery
    if (isProactive && (mindstate === 'recovering' || mindstate === 'calm')) {
      violations.push(new GuardrailViolation({
        guardrailId: 15,
        category: GuardrailCategory.COGNITIVE,
        description: 'User recovering. Not every silence should be filled.',
        severity: 0.5,
        actionBlocked: true,
      }));
      blockedCount++;
    }

    // G18: Encourage real-world life
    if (sessionMinutes > 120) {
      violations.push(new GuardrailViolation({
        guardrailId: 18,
        category: GuardrailCategory.EMOTIONAL,
        description: `Session at ${sessionMinutes.toFixed(0)} min. Bias toward life, not device.`,
        severity: 0.4,
      }));
    }

    // Record — use blockedCount instead of re-scanning violations with .some().
    if (isProactive && blockedCount === 0) {
      profile.interruptionsSent += 1;
      profile.lastInterruption = tNow;
    }

    // Append in-place to avoid spread-allocation of an extra array.
    const ownViolations = this._violations;
    for (let i = 0; i < violations.length; i++) ownViolations.push(violations[i]);
    if (ownViolations.length > this._maxViolations) this._trim();

    if (this.store && violations.length > 0) {
      this.store.insertReceipt('wellbeing.check_action', 'ok',
        `${violations.length} violations for '${actionTitle.slice(0, 40)}' (blocked: ${blockedCount})`,
        { violations: violations.map(v => v.toDict()) });
    }

    return violations;
  }

  /**
   * G4: Check if a metric is an anti-metric (must never be optimized for).
   * Returns violation if anti-metric, null otherwise.
   */
  checkMetric(metricName) {
    const normalized = String(metricName).toLowerCase().replace(/\s+/g, '_');
    if (ANTI_METRICS.has(normalized)) {
      const v = new GuardrailViolation({
        guardrailId: 4,
        category: GuardrailCategory.FOUNDATIONAL,
        description: `Anti-metric '${metricName}' must not be optimized for`,
        severity: 0.9,
        actionBlocked: true,
      });
      this._violations.push(v);
      if (this.store) {
        this.store.insertReceipt('wellbeing.anti_metric', 'error',
          `anti-metric blocked: ${metricName}`,
          v.toDict());
      }
      return v;
    }
    return null;
  }

  /**
   * Should voice intervention be allowed right now?
   * Composite of G15, G7, G6.
   */
  checkVoice(mindstate) {
    if (mindstate === 'recovering' || mindstate === 'calm') return false;
    if (now() - this._profile.lastInterruption < 300) return false;
    if (this._profile.voiceInterventionsToday >= 6) return false;
    return true;
  }

  recordVoice() {
    this._profile.voiceInterventionsToday += 1;
  }

  /**
   * Run the acceptance question on a feature.
   * 'Did this make the user more capable, calmer, clearer, safer, and more sovereign?'
   */
  acceptanceTest(featureDescription) {
    const positiveSignals = ['capable', 'calmer', 'clearer', 'safer', 'sovereign',
                             'mastery', 'understanding', 'reduce', 'help', 'support'];
    const negativeSignals = ['addictive', 'compulsive', 'engagement', 'session_length',
                             'notification', 'attention', 'gamif', 'streak'];

    const descLower = String(featureDescription).toLowerCase();
    const pos = positiveSignals.filter(s => descLower.includes(s)).length;
    const neg = negativeSignals.filter(s => descLower.includes(s)).length;

    return {
      passes: pos > neg && neg === 0,
      positive_signals: pos,
      negative_signals: neg,
      question: 'Did this make the user more capable, calmer, clearer, safer, and more sovereign?',
    };
  }

  newSession() {
    this._profile = new InteractionProfile();
  }

  _trim() {
    if (this._violations.length > this._maxViolations) {
      this._violations = this._violations.slice(-this._maxViolations);
    }
  }

  get isBlocked() {
    // Reverse scan with early-out — violations are timestamp-ordered (append-only),
    // so once we pass the 60s window we can stop. Avoids materializing a filtered
    // array and avoids re-scanning with .some().
    const v = this._violations;
    const cutoff = now() - 60;
    for (let i = v.length - 1; i >= 0; i--) {
      const cur = v[i];
      if (cur.timestamp < cutoff) break;
      if (cur.actionBlocked) return true;
    }
    return false;
  }

  stats() {
    // Single pass over violations: count recent + blocked in one walk, reverse
    // with early-out at the 3600s window. Avoids two .filter() allocations.
    const v = this._violations;
    const profile = this._profile;
    const cutoff = now() - 3600;
    let recentCount = 0;
    let blockedCount = 0;
    for (let i = v.length - 1; i >= 0; i--) {
      const cur = v[i];
      if (cur.timestamp < cutoff) break;
      recentCount++;
      if (cur.actionBlocked) blockedCount++;
    }
    // Math.round path avoids the string round-trip of Number(x.toFixed(1)).
    const sm = profile.sessionMinutes;
    return {
      version: CONSTITUTION_VERSION,
      session_minutes: Math.round(sm * 10) / 10,
      interactions: profile.interactionsThisSession,
      interruptions_sent: profile.interruptionsSent,
      violations_last_hour: recentCount,
      blocked_last_hour: blockedCount,
      voice_today: profile.voiceInterventionsToday,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// MemoryInspector — G19: Memory must be inspectable
// ═══════════════════════════════════════════════════════════════════

export class MemoryInspector {
  /**
   * Return everything the system knows about the user, with sources.
   * Node argument: a structured object with optional crystal/world/goals/working_memory/predictor.
   */
  static inspect(node) {
    const knowledge = { version: CONSTITUTION_VERSION };

    if (node?.crystal?.stats) {
      const stats = node.crystal.stats();
      knowledge.conversation_memory = {
        entities: stats.entities || 0,
        facts: stats.facts || 0,
        decisions: stats.decisions || 0,
        boundaries: stats.boundaries || 0,
        rejections: stats.rejections || 0,
      };
    }

    if (node?.world?._beliefs) {
      const beliefs = [];
      const iterable = node.world._beliefs instanceof Map ? node.world._beliefs.values() : Object.values(node.world._beliefs);
      for (const b of iterable) {
        beliefs.push({
          key: b.key,
          value: String(b.value),
          confidence: Number((b.confidence || 0).toFixed(2)),
          source: b.source,
          stale: b.stale,
        });
      }
      knowledge.beliefs = beliefs;
    }

    if (node?.goals?.all_goals) {
      knowledge.goals = node.goals.all_goals().map(g => g.to_dict ? g.to_dict() : { ...g });
    }

    if (node?.working_memory?.recent) {
      knowledge.working_memory = node.working_memory.recent(10).map(i => ({
        content: i.content,
        tag: i.tag?.value || i.tag,
        source: i.source,
      }));
    }

    if (node?.predictor?.stats) {
      knowledge.prediction_performance = node.predictor.stats();
    }

    return knowledge;
  }

  /**
   * G19/G20: User requests deletion of a specific belief.
   */
  static forget(node, key) {
    if (node?.world?._beliefs) {
      const beliefs = node.world._beliefs;
      if (beliefs instanceof Map && beliefs.has(key)) {
        beliefs.delete(key);
        return true;
      }
      if (typeof beliefs === 'object' && key in beliefs) {
        delete beliefs[key];
        return true;
      }
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// ConsequenceDisplay — G22: Consequence state must be legible
// ═══════════════════════════════════════════════════════════════════

export class ConsequenceDisplay {
  static explainAction({
    actionTitle = '',
    simulationResult = null,
    prediction = null,
    taskProfile = null,
    governor = null,
  } = {}) {
    const explanation = { action: actionTitle };

    if (taskProfile) {
      explanation.model = taskProfile.model || 'unknown';
      explanation.cost = `$${((taskProfile.cost_cents || 0) / 100).toFixed(2)}`;
      explanation.context_strategy = taskProfile.context || 'full';
    }
    if (simulationResult) {
      explanation.simulated_success = simulationResult.success_prob || 'unknown';
      explanation.risk = simulationResult.total_risk || 0;
      explanation.proceed = simulationResult.proceed !== false;
    }
    if (prediction) {
      explanation.predicted_outcome = prediction.predicted || 'unknown';
      explanation.confidence = prediction.confidence || 0.5;
    }
    if (governor) {
      explanation.governor_allowed = governor.allowed !== false;
      explanation.reason = governor.reason || '';
    }
    return explanation;
  }
}
