/**
 * shared/intelligence/adaptation/createAdaptationRecommendations.ts
 *
 * Maps AdaptationSignal[] to AdaptationRecommendation[].
 *
 * Each signal produces one recommendation. Well-known signal types get
 * domain-specific, user-friendly language. Unrecognised types fall back
 * to the signal's recommendedAction text.
 *
 * Rules:
 *   - One recommendation per signal — no merging or deduplication in Phase 5 P1.
 *   - Deterministic: same signals → same recommendations, always.
 *   - Recommendations are for the NEXT plan. They do not mutate the current plan.
 *   - Never throws.
 *
 * Recommendation IDs: `recommendation-{type}-{index}` (sequential).
 */

import type { AdaptationSignal, AdaptationRecommendation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Recommendation text map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Human-friendly recommendation strings keyed by signal type.
 * Keeps user-facing text centralised and easy to iterate.
 */
const RECOMMENDATION_TEXT: Record<string, string> = {
  // Recovery
  reduce_intensity_due_to_soreness:
    "Reduce workout intensity by one tier for the next plan if soreness persists.",
  stress_management_needed:
    "Add a dedicated stress management protocol to the next plan and protect the wind-down block.",
  recovery_load_warning:
    "Simplify recovery protocols in the next plan to improve adherence — fewer, higher-impact items.",

  // Sleep
  improve_sleep_consistency:
    "Move wind-down start time 15 minutes earlier in the next plan to protect sleep quality.",
  sleep_consistency_risk:
    "Reduce the sleep wind-down task list to one or two essentials to rebuild the habit.",

  // Workout
  reduce_training_load:
    "Reduce training load in the next plan — consider a deload session or reduced volume.",
  workout_consistency_risk:
    "Shorten the workout duration or reduce required exercise count in the next plan.",
  increase_training_challenge:
    "Increase training challenge in the next plan — the consistency data supports it.",

  // Nutrition
  improve_meal_consistency:
    "Simplify nutrition tasks in the next plan to 2–3 core habits rather than full meal tracking.",

  // Planner
  plan_stability_warning:
    "Complete missing profile fields before the next plan to unlock full personalisation.",
  simplify_daily_plan:
    "Reduce the total task count in the next plan to improve adherence.",
  increase_structure_support:
    "Build the next plan around a short, clearly structured task list to restore motivation.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert adaptation signals into actionable recommendations.
 *
 * @param signals — Output of deriveAdaptationSignals().
 * @returns       — One recommendation per signal, deterministically ordered.
 */
export function createAdaptationRecommendations(
  signals: AdaptationSignal[],
): AdaptationRecommendation[] {
  return signals.map((signal, idx): AdaptationRecommendation => {
    const recommendation =
      RECOMMENDATION_TEXT[signal.type] ?? signal.recommendedAction;

    return {
      id:                `recommendation-${signal.type}-${idx}`,
      domain:            signal.domain,
      priority:          signal.severity,
      recommendation,
      reason:            signal.message,
      appliesToNextPlan: true,
    };
  });
}
