/**
 * shared/intelligence/learning/buildLearningProfile.ts
 *
 * Build a deterministic learning profile from a historical window of user data.
 *
 * The learning layer is distinct from adaptation:
 *   Adaptation — short-term response to current signals (triggered, 7-day window)
 *   Learning   — long-term baseline bias from repeated patterns (always present, 14-day window)
 *
 * ─── Pipeline ────────────────────────────────────────────────────────────────
 *
 * 1. Normalize all input arrays to [] when absent.
 * 2. Count total data points (check-ins + plan history records).
 *    If zero → return undefined (no profile; no behavior change).
 * 3. Compute frequency-based pattern summary from check-ins + plan history.
 * 4. Derive boolean tendencies (threshold: 0.4).
 * 5. Derive baseline adjustments from active tendencies.
 * 6. Compute confidence = min(1, totalDataPoints / LEARNING_CONFIDENCE_DATAPOINTS).
 * 7. Return AiraLearningProfile.
 *
 * ─── Confidence gate ─────────────────────────────────────────────────────────
 *
 * Returns undefined only when ALL input arrays are empty (zero data points).
 * With limited data (confidence < 0.5) the profile is returned but
 * applyLearningAdjustments will skip all adjustments.
 *
 * ─── Design rules ────────────────────────────────────────────────────────────
 *
 * Deterministic:     same input → same output, always.
 * No randomness:     no Math.random(), no uuid.
 * No async:          synchronous throughout.
 * No external calls: no API calls, no AI model calls.
 * No mutation:       input is never modified.
 * Never throws.
 */

import type {
  AiraLearningInput,
  AiraLearningProfile,
  LearningPatternSummary,
  LearningTendencies,
  LearningBaselineAdjustments,
  UserCheckIn,
  PlanHistoryRecord,
  TaskCompletionRecord,
} from "../types";
import {
  LEARNING_WINDOW_DAYS,
  LEARNING_CONFIDENCE_DATAPOINTS,
} from "../constants";

// Frequency threshold above which a pattern is treated as a persistent tendency.
const TENDENCY_THRESHOLD = 0.4 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pattern analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute frequency-based pattern metrics from the raw historical data.
 *
 * lowReadinessFrequency:
 *   Fraction of check-ins where energy === "low", soreness === "high",
 *   or sleepQuality === "poor". Measures how often the user is in a depleted
 *   state regardless of the specific cause.
 *
 * highStressFrequency:
 *   Fraction of check-ins where stress === "high". Isolated separately from
 *   readiness because stress management requires specific recovery protocols.
 *
 * poorSleepFrequency:
 *   Fraction of check-ins where sleepQuality === "poor" or "fair".
 *   "Fair" is included because it persistently degrades readiness even without
 *   being individually notable.
 *
 * lowCompletionRate:
 *   1 minus the average plan/task completion rate.
 *   Plan history takes priority; task completions are used as a fallback.
 *   Higher value = lower adherence to the plan.
 */
function analyzePatterns(
  checkIns:        UserCheckIn[],
  recentPlans:     PlanHistoryRecord[],
  taskCompletions: TaskCompletionRecord[],
): LearningPatternSummary {
  // ── Low readiness ─────────────────────────────────────────────────────────
  const lowReadinessCount = checkIns.filter(
    (c) => c.energy === "low" || c.soreness === "high" || c.sleepQuality === "poor",
  ).length;
  const lowReadinessFrequency = checkIns.length > 0
    ? lowReadinessCount / checkIns.length
    : 0;

  // ── High stress ───────────────────────────────────────────────────────────
  const highStressCount = checkIns.filter((c) => c.stress === "high").length;
  const highStressFrequency = checkIns.length > 0
    ? highStressCount / checkIns.length
    : 0;

  // ── Poor sleep ────────────────────────────────────────────────────────────
  const poorSleepCount = checkIns.filter(
    (c) => c.sleepQuality === "poor" || c.sleepQuality === "fair",
  ).length;
  const poorSleepFrequency = checkIns.length > 0
    ? poorSleepCount / checkIns.length
    : 0;

  // ── Completion rate ───────────────────────────────────────────────────────
  // Plan history is the authoritative source (plan-level completion captures
  // cross-domain adherence). Task completions are a fallback when no plan
  // history is available.
  let lowCompletionRate = 0;

  if (recentPlans.length > 0) {
    let totalRate = 0;
    let counted   = 0;

    for (const plan of recentPlans) {
      if (
        plan.completedTaskCount != null &&
        plan.totalTaskCount     != null &&
        plan.totalTaskCount > 0
      ) {
        // Task-count-based completion (most precise)
        totalRate += plan.completedTaskCount / plan.totalTaskCount;
        counted++;
      } else if (plan.domainCompletion) {
        // Fall back to average of available domain rates
        const rates = Object.values(plan.domainCompletion).filter(
          (r): r is number => typeof r === "number",
        );
        if (rates.length > 0) {
          totalRate += rates.reduce((s, r) => s + r, 0) / rates.length;
          counted++;
        }
      }
    }

    if (counted > 0) {
      lowCompletionRate = 1 - totalRate / counted;
    }
  } else if (taskCompletions.length > 0) {
    const completedCount = taskCompletions.filter((t) => t.completed).length;
    lowCompletionRate = 1 - completedCount / taskCompletions.length;
  }

  return {
    lowReadinessFrequency,
    highStressFrequency,
    poorSleepFrequency,
    lowCompletionRate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tendency derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive boolean tendencies from pattern frequencies.
 * A tendency is true when its frequency exceeds TENDENCY_THRESHOLD (0.4),
 * meaning the pattern is present in more than 40% of the data points.
 */
function deriveTendencies(patterns: LearningPatternSummary): LearningTendencies {
  return {
    prefersLowerVolume:     patterns.lowReadinessFrequency > TENDENCY_THRESHOLD,
    needsMoreRecovery:      patterns.highStressFrequency   > TENDENCY_THRESHOLD,
    inconsistentSleep:      patterns.poorSleepFrequency    > TENDENCY_THRESHOLD,
    nutritionComplianceLow: patterns.lowCompletionRate     > TENDENCY_THRESHOLD,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline adjustment derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive baseline adjustments from active tendencies.
 * Returns an empty object when no tendencies are active.
 *
 * Adjustments are applied by applyLearningAdjustments only when
 * the profile's confidenceScore >= 0.5 (≥ 10 of 20 data points).
 */
function deriveBaselineAdjustments(
  tendencies: LearningTendencies,
): LearningBaselineAdjustments {
  const adj: LearningBaselineAdjustments = {};

  if (tendencies.prefersLowerVolume)     adj.workoutIntensityBias        = "medium";
  if (tendencies.needsMoreRecovery)      adj.recoveryPriorityBias        = "high";
  if (tendencies.inconsistentSleep)      adj.sleepTargetBias             = 0.5;
  if (tendencies.nutritionComplianceLow) adj.nutritionSimplificationBias = true;

  return adj;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a learning profile from a historical window of user data.
 *
 * @param input — AiraLearningInput with optional checkIns, recentPlans, taskCompletions.
 * @returns     — AiraLearningProfile, or undefined when all input arrays are empty.
 *
 * Returns undefined (not a low-confidence profile) only when there are zero data
 * points — i.e. checkIns.length + recentPlans.length === 0.
 * With limited data, the profile is returned with low confidence and
 * applyLearningAdjustments will skip adjustments until confidence >= 0.5.
 */
export function buildLearningProfile(
  input: AiraLearningInput,
): AiraLearningProfile | undefined {
  const checkIns        = input.checkIns        ?? [];
  const recentPlans     = input.recentPlans     ?? [];
  const taskCompletions = input.taskCompletions ?? [];

  // Zero data points → cannot derive any patterns; skip entirely
  const totalDataPoints = checkIns.length + recentPlans.length;
  if (totalDataPoints === 0) return undefined;

  const patterns            = analyzePatterns(checkIns, recentPlans, taskCompletions);
  const tendencies          = deriveTendencies(patterns);
  const baselineAdjustments = deriveBaselineAdjustments(tendencies);
  const confidenceScore     = Math.min(1, totalDataPoints / LEARNING_CONFIDENCE_DATAPOINTS);

  return {
    version:             "phase5_learning_v1",
    patterns,
    tendencies,
    baselineAdjustments,
    confidenceScore,
    metadata: {
      deterministic:  true,
      dataPointsUsed: totalDataPoints,
      windowDays:     LEARNING_WINDOW_DAYS,
    },
  };
}
