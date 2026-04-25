/**
 * shared/planner/previewPlan.ts
 *
 * Lightweight synchronous plan preview — derives focus, workout label, and
 * estimated calorie target from partial onboarding inputs.
 *
 * Designed to be called during onboarding as the user fills in steps.
 * No full AiraUserProfile required — works with whatever fields are available.
 *
 * Logic mirrors generateDailyPlan.ts but operates on partial inputs with graceful
 * fallbacks for every field. Pure function, no side effects, O(1).
 *
 * Consumers:
 *   OnboardingFlow.tsx → PlanPreviewCard (live preview shown during onboarding)
 */

import type {
  GoalKind,
  TrainingStyle,
  GymAccess,
  SleepQuality,
  StressLevel,
  EnergyLevel,
  NutritionGoalKind,
} from "../types/profile";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Partial onboarding inputs passed to the preview builder. All fields optional. */
export type PlanPreviewInputs = {
  goalType?:       GoalKind;
  trainingStyle?:  TrainingStyle;
  gymAccess?:      GymAccess;
  daysPerWeek?:    number;
  sleepQuality?:   SleepQuality;
  stressLevel?:    StressLevel;
  energyBaseline?: EnergyLevel;
  nutritionGoal?:  NutritionGoalKind;
  gender?:         "male" | "female" | "other";
};

/** Lightweight plan preview computed during onboarding. */
export type PlanPreview = {
  /**
   * One-line coaching focus label.
   * Falls back to "Building your plan…" when no goal is available yet.
   */
  focus:         string;
  /** Human-readable workout type label. */
  workoutLabel:  string;
  /**
   * Estimated daily calorie target in kcal.
   * null when nutritionGoal is not yet set.
   */
  calorieTarget: number | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// Mirrors the logic in generateDailyPlan.ts — same decision rules, partial inputs.
// ─────────────────────────────────────────────────────────────────────────────

function computePreviewReadiness(
  sleepQuality:   SleepQuality,
  stressLevel:    StressLevel,
  energyBaseline: EnergyLevel,
): "Push" | "Maintain" | "Recover" {
  const sleepScore:  Record<SleepQuality, number> = { poor: 0, fair: 1, good: 2, great: 3 };
  const stressScore: Record<StressLevel,  number> = { very_high: -2, high: -1, moderate: 0, low: 1 };
  const energyScore: Record<EnergyLevel,  number> = { low: -1, moderate: 0, high: 1 };
  const total = sleepScore[sleepQuality] + stressScore[stressLevel] + energyScore[energyBaseline];
  if (total >= 4) return "Push";
  if (total <= 0) return "Recover";
  return "Maintain";
}

function derivePreviewFocus(inputs: PlanPreviewInputs): string {
  const { goalType, sleepQuality, stressLevel, energyBaseline } = inputs;
  if (!goalType) return "Building your plan…";

  // When recovery signals are available, mirror derivePlanFocus priority chain
  if (sleepQuality && stressLevel && energyBaseline) {
    const poorSleep  = sleepQuality === "poor" || sleepQuality === "fair";
    const highStress = stressLevel  === "high" || stressLevel  === "very_high";

    // Worst-case combined state overrides everything
    if (poorSleep && highStress) return "Recovery optimization day";

    const tier = computePreviewReadiness(sleepQuality, stressLevel, energyBaseline);
    if (tier === "Recover") return "Active recovery day";

    if (tier === "Push") {
      if (goalType === "build_muscle")        return "High-volume muscle building day";
      if (goalType === "get_stronger")        return "Max-strength execution day";
      if (goalType === "lose_fat")            return "High-intensity calorie burn day";
      if (goalType === "improve_athleticism") return "Athletic performance day";
      return "Full effort execution day";
    }

    // Maintain tier — goal shapes the day's priority
    if (goalType === "lose_fat")            return "Consistent calorie deficit day";
    if (goalType === "build_muscle")        return "Progressive volume day";
    if (goalType === "get_stronger")        return "Strength skill day";
    if (goalType === "stay_consistent")     return "Show up and execute day";
    if (goalType === "improve_athleticism") return "Movement quality day";
  }

  // Goal-only fallback — no recovery signals available yet
  const goalFocus: Record<GoalKind, string> = {
    lose_fat:            "Calorie deficit execution day",
    build_muscle:        "Progressive muscle building day",
    get_stronger:        "Strength execution day",
    improve_athleticism: "Athletic performance day",
    stay_consistent:     "Show up and execute day",
  };
  return goalFocus[goalType];
}

function derivePreviewWorkoutLabel(inputs: PlanPreviewInputs): string {
  const { trainingStyle, gymAccess, daysPerWeek, sleepQuality, stressLevel } = inputs;

  // Recovery state overrides workout type — mirrors generateDailyPlan behaviour
  if (sleepQuality && stressLevel) {
    const poorSleep  = sleepQuality === "poor" || sleepQuality === "fair";
    const highStress = stressLevel  === "high" || stressLevel  === "very_high";
    if (poorSleep && highStress) return "Active Recovery / Mobility";
  }

  if (!trainingStyle) return "Personalized Training Session";

  // Mirror determineWorkoutSplit → human-readable label
  if (gymAccess === "bodyweight_only") {
    if (trainingStyle === "calisthenics") return "Bodyweight Circuit";
    if (trainingStyle === "fat_loss")     return "HIIT Circuit";
    return "Full Body Workout";
  }

  if (trainingStyle === "athlete")      return "Athletic Performance Circuit";
  if (trainingStyle === "fat_loss")     return (daysPerWeek && daysPerWeek >= 4) ? "HIIT Training" : "Full Body Fat Burn";
  if (trainingStyle === "calisthenics") return "Bodyweight Circuit";
  if (trainingStyle === "strength")     return "Compound Strength Training";
  if (trainingStyle === "muscle")       return "Hypertrophy Training";
  return "Full Body Training"; // general_fitness
}

function derivePreviewCalories(inputs: PlanPreviewInputs): number | null {
  const { nutritionGoal, daysPerWeek, gender } = inputs;
  if (!nutritionGoal) return null;

  const base =
    gender === "female" ? 1900 :
    gender === "male"   ? 2400 : 2150;

  const activityBonus =
    daysPerWeek == null ? 200 :
    daysPerWeek >= 6    ? 500 :
    daysPerWeek >= 4    ? 350 :
    daysPerWeek >= 2    ? 200 : 100;

  const goalAdj: Record<NutritionGoalKind, number> = {
    fat_loss:    -400,
    muscle_gain: +400,
    maintenance:    0,
    performance: +250,
  };

  return base + activityBonus + goalAdj[nutritionGoal];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a lightweight plan preview from partial onboarding inputs.
 *
 * Safe to call with any combination of filled/missing fields — every internal
 * helper falls back gracefully when its required inputs are absent.
 *
 * Deterministic, synchronous, O(1). No side effects.
 */
export function buildPlanPreview(inputs: PlanPreviewInputs): PlanPreview {
  return {
    focus:         derivePreviewFocus(inputs),
    workoutLabel:  derivePreviewWorkoutLabel(inputs),
    calorieTarget: derivePreviewCalories(inputs),
  };
}
