/**
 * shared/intelligence/data/mapSignalsToEngineInputs.ts
 *
 * Maps the single set of pre-computed global signals and decisions from
 * NormalizedIntelligenceInput into domain-specific signal views.
 *
 *   mapSignalsToEngineInputs(normalizedInput, completeness) → EngineSignalMap
 *
 * ─── Key invariant ────────────────────────────────────────────────────────────
 *
 * extractSignals() and derivePlanDecisions() were already called EXACTLY ONCE in
 * normalizeIntelligenceInput(). This function does NOT call either of them again.
 * It only reshapes and subsets what is already present in normalizedInput.
 *
 * The one computed value introduced here is `readinessTier`, obtained by calling
 * computeReadinessTier() with the three recovery metrics that are already in the
 * signals. This mirrors the call in workoutEngine.ts and recoveryEngine.ts so all
 * three callers produce the same tier for the same profile — guaranteed consistent
 * because all use the same shared export.
 *
 * ─── Design rules ─────────────────────────────────────────────────────────────
 * - Pure function. Deterministic. No side effects.
 * - Never throws. No external calls.
 * - Never mutates normalizedInput.
 * - Reads normalizedInput.signals for all PlanSignals fields.
 *   Reads normalizedInput.profile directly only for fields not present in
 *   PlanSignals (allergies, wakeTime, sleepTime). Does not read decisions.
 */

import type {
  NormalizedIntelligenceInput,
  ProfileCompletenessReport,
  EngineSignalMap,
  WorkoutEngineSignals,
  NutritionEngineSignals,
  RecoveryEngineSignals,
  SleepEngineSignals,
  PlannerEngineSignals,
} from "../types";
import { computeReadinessTier } from "../../planner/generateDailyPlan";

/**
 * Map pre-computed global signals and decisions to domain-specific views.
 *
 * @param normalizedInput — Already validated and normalized input.
 * @param completeness    — Domain completeness report, used to populate
 *                          PlannerEngineSignals.domainDegradedModes.
 * @returns               — EngineSignalMap with one view per engine domain.
 */
export function mapSignalsToEngineInputs(
  normalizedInput: NormalizedIntelligenceInput,
  completeness:    ProfileCompletenessReport,
): EngineSignalMap {
  const { profile, signals } = normalizedInput;

  // ── Shared computed values ─────────────────────────────────────────────────
  // Computed once and reused in both workout and recovery signal views.
  // Uses the same computeReadinessTier export used in workoutEngine and recoveryEngine
  // — all callers produce identical results for the same inputs.
  //
  // Signal source: signals.* (not profile.recovery.*) — after extractSignals() runs,
  // signals is the canonical source for all PlanSignals fields including the three
  // recovery metrics. Using profile.recovery.* directly would bypass this layer.
  const readinessTier = computeReadinessTier(
    signals.sleepQuality,
    signals.stressLevel,
    signals.energyBaseline,
  );

  const stressFlag =
    signals.stressLevel === "high" || signals.stressLevel === "very_high";

  // ── Workout signals ────────────────────────────────────────────────────────
  const workout: WorkoutEngineSignals = {
    goal:            signals.goal,
    experience:      signals.experience,
    trainingDays:    signals.trainingDays,
    sessionDuration: signals.sessionDuration,
    readinessTier,
  };

  // ── Nutrition signals ──────────────────────────────────────────────────────
  const nutrition: NutritionEngineSignals = {
    goal:          signals.goal,
    dietaryStyle:  signals.dietaryStyle,
    nutritionGoal: signals.nutritionGoal,
    // allergies is not in PlanSignals — read directly from profile
    allergies:     profile.nutrition.allergies,
    hasBodyWeight: Boolean(profile.profile.weight),
    hasAge:        Boolean(profile.profile.age),
  };

  // ── Recovery signals ───────────────────────────────────────────────────────
  const recovery: RecoveryEngineSignals = {
    sleepQuality:   signals.sleepQuality,
    stressLevel:    signals.stressLevel,
    energyBaseline: signals.energyBaseline,
    readinessTier,   // same value as in workout — computed once above
    stressFlag,
  };

  // ── Sleep signals ──────────────────────────────────────────────────────────
  // wakeTime/sleepTime are not in PlanSignals (they feed the schedule, not decisions).
  const sleep: SleepEngineSignals = {
    wakeTime:     profile.sleep.wakeTime,
    sleepTime:    profile.sleep.sleepTime,
    sleepQuality: signals.sleepQuality,
    stressLevel:  signals.stressLevel,
  };

  // ── Planner signals ────────────────────────────────────────────────────────
  // Carries the complete PlanSignals set plus domain degraded flags.
  const planner: PlannerEngineSignals = {
    goal:                 signals.goal,
    experience:           signals.experience,
    trainingDays:         signals.trainingDays,
    sessionDuration:      signals.sessionDuration,
    sleepQuality:         signals.sleepQuality,
    stressLevel:          signals.stressLevel,
    energyBaseline:       signals.energyBaseline,
    scheduleConsistency:  signals.scheduleConsistency,
    preferredWorkoutTime: signals.preferredWorkoutTime,
    dietaryStyle:         signals.dietaryStyle,
    nutritionGoal:        signals.nutritionGoal,
    domainDegradedModes: {
      workout:   completeness.workout.degradedMode,
      nutrition: completeness.nutrition.degradedMode,
      recovery:  completeness.recovery.degradedMode,
      sleep:     completeness.sleep.degradedMode,
    },
  };

  return { workout, nutrition, recovery, sleep, planner };
}
