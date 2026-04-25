/**
 * shared/intelligence/adaptation/deriveAdaptationSignals.ts
 *
 * Maps feedback and history summaries to structured AdaptationSignal objects.
 *
 * Signal taxonomy (grouped by domain):
 *
 *   Recovery:
 *     reduce_intensity_due_to_soreness  — repeated soreness check-ins
 *     stress_management_needed          — repeated high stress check-ins
 *     recovery_load_warning             — low recovery task completion
 *
 *   Sleep:
 *     improve_sleep_consistency         — repeated poor/fair sleep check-ins
 *     sleep_consistency_risk            — low sleep task completion
 *
 *   Workout:
 *     reduce_training_load              — repeated low energy check-ins
 *     workout_consistency_risk          — low workout completion
 *     increase_training_challenge       — strong consistency across all domains
 *
 *   Nutrition:
 *     improve_meal_consistency          — low nutrition task completion
 *     nutrition_consistency_risk        — same as above (alias for future use)
 *
 *   Planner:
 *     plan_stability_warning            — ≥3 adjusted/fallback plans
 *     simplify_daily_plan               — low overall task completion
 *     increase_structure_support        — repeated low motivation check-ins
 *
 * Rules:
 *   - Deterministic: same input → same signals, same order, always.
 *   - No randomness. No module-level state.
 *   - Each condition fires at most once per call.
 *   - Signal IDs: `signal-{type}-{index}` (sequential within a single call).
 *   - Never throws.
 */

import type { AdaptationSignal } from "../types";
import type { FeedbackSummary }  from "./analyzeUserFeedback";
import type { HistorySummary }   from "./analyzePlanHistory";

// ─────────────────────────────────────────────────────────────────────────────
// Severity escalation threshold
// ─────────────────────────────────────────────────────────────────────────────

/** Count at which a pattern escalates from medium → high severity. */
const HIGH_SEVERITY_COUNT = 3 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive adaptation signals from analyzed feedback and history summaries.
 *
 * @param params.feedbackSummary — Output of analyzeUserFeedback().
 * @param params.historySummary  — Output of analyzePlanHistory().
 * @returns                      — Ordered list of AdaptationSignal objects.
 */
export function deriveAdaptationSignals(params: {
  feedbackSummary: FeedbackSummary;
  historySummary:  HistorySummary;
}): AdaptationSignal[] {
  const { feedbackSummary: fb, historySummary: hs } = params;
  const signals: AdaptationSignal[] = [];
  let idx = 0;

  // Helper: push a signal and auto-assign a deterministic ID
  function push(signal: Omit<AdaptationSignal, "id">): void {
    signals.push({ ...signal, id: `signal-${signal.type}-${idx++}` });
  }

  // ── Recovery domain ───────────────────────────────────────────────────────

  if (fb.hasHighSorenessPattern) {
    push({
      domain:            "recovery",
      severity:          fb.highSorenessCount >= HIGH_SEVERITY_COUNT ? "high" : "medium",
      type:              "reduce_intensity_due_to_soreness",
      message:           `High or moderate soreness reported in ${fb.highSorenessCount} recent check-ins.`,
      recommendedAction: "Reduce workout intensity and increase recovery protocol emphasis.",
    });
  }

  if (fb.hasHighStressPattern) {
    push({
      domain:            "recovery",
      severity:          fb.highStressCount >= HIGH_SEVERITY_COUNT ? "high" : "medium",
      type:              "stress_management_needed",
      message:           `Elevated stress reported in ${fb.highStressCount} recent check-ins.`,
      recommendedAction: "Prioritise stress management protocols and protect the evening wind-down.",
    });
  }

  const recoveryCompletion = hs.domainCompletions.find((d) => d.domain === "recovery");
  if (recoveryCompletion?.hasLowCompletion) {
    push({
      domain:            "recovery",
      severity:          "medium",
      type:              "recovery_load_warning",
      message:           `Recovery task completion is ${pct(recoveryCompletion.completionRate)} — below target.`,
      recommendedAction: "Simplify recovery protocols or reduce protocol count to improve adherence.",
    });
  }

  // ── Sleep domain ──────────────────────────────────────────────────────────

  if (fb.hasPoorSleepPattern) {
    push({
      domain:            "sleep",
      severity:          fb.poorSleepCount >= HIGH_SEVERITY_COUNT ? "high" : "medium",
      type:              "improve_sleep_consistency",
      message:           `Poor or fair sleep quality reported in ${fb.poorSleepCount} recent check-ins.`,
      recommendedAction: "Protect the sleep window and start wind-down earlier tonight.",
    });
  }

  const sleepCompletion = hs.domainCompletions.find((d) => d.domain === "sleep");
  if (sleepCompletion?.hasLowCompletion) {
    push({
      domain:            "sleep",
      severity:          "medium",
      type:              "sleep_consistency_risk",
      message:           `Sleep task completion is ${pct(sleepCompletion.completionRate)} — below target.`,
      recommendedAction: "Simplify the sleep wind-down routine to build consistency.",
    });
  }

  // ── Workout domain ────────────────────────────────────────────────────────

  if (fb.hasLowEnergyPattern) {
    push({
      domain:            "workout",
      severity:          fb.lowEnergyCount >= HIGH_SEVERITY_COUNT ? "high" : "medium",
      type:              "reduce_training_load",
      message:           `Low energy reported in ${fb.lowEnergyCount} recent check-ins.`,
      recommendedAction: "Reduce training load until energy levels recover.",
    });
  }

  const workoutCompletion = hs.domainCompletions.find((d) => d.domain === "workout");
  if (workoutCompletion?.hasLowCompletion) {
    push({
      domain:            "workout",
      severity:          "medium",
      type:              "workout_consistency_risk",
      message:           `Workout completion is ${pct(workoutCompletion.completionRate)} — below target.`,
      recommendedAction: "Review session duration or format — consider reducing volume temporarily.",
    });
  }

  // Positive signal: all domains strong + no negative feedback → challenge opportunity
  if (
    hs.hasStrongConsistency &&
    !fb.hasLowEnergyPattern &&
    !fb.hasHighSorenessPattern &&
    !fb.hasHighStressPattern
  ) {
    push({
      domain:            "workout",
      severity:          "low",
      type:              "increase_training_challenge",
      message:           "Consistent performance across all domains over the recent period.",
      recommendedAction: "Consider a modest increase in training challenge or session volume.",
    });
  }

  // ── Nutrition domain ──────────────────────────────────────────────────────

  const nutritionCompletion = hs.domainCompletions.find((d) => d.domain === "nutrition");
  if (nutritionCompletion?.hasLowCompletion) {
    push({
      domain:            "nutrition",
      severity:          "medium",
      type:              "improve_meal_consistency",
      message:           `Nutrition task completion is ${pct(nutritionCompletion.completionRate)} — below target.`,
      recommendedAction: "Simplify meal targets or focus on 2–3 core nutrition behaviours.",
    });
  }

  // ── Planner domain ────────────────────────────────────────────────────────

  if (hs.hasPlanStabilityWarning) {
    push({
      domain:            "planner",
      severity:          hs.fallbackCount >= 2 ? "high" : "medium",
      type:              "plan_stability_warning",
      message:
        `${hs.fallbackCount + hs.adjustedCount} of ${hs.planCount} recent plans were adjusted or fallback.`,
      recommendedAction: "Review profile completeness and fill in missing data fields.",
    });
  }

  if (hs.hasLowOverallCompletion) {
    push({
      domain:            "planner",
      severity:          "medium",
      type:              "simplify_daily_plan",
      message:           `Overall task completion is ${pct(hs.overallCompletionRate)} — below target.`,
      recommendedAction: "Reduce total task count to improve daily adherence.",
    });
  }

  if (fb.hasLowMotivationPattern) {
    push({
      domain:            "planner",
      severity:          "low",
      type:              "increase_structure_support",
      message:           `Low motivation reported in ${fb.lowMotivationCount} recent check-ins.`,
      recommendedAction: "Provide clearer daily structure and a shorter task list to rebuild momentum.",
    });
  }

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Format a 0–1 rate as a readable percentage string. */
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
