/**
 * shared/intelligence/data/createDomainDataPackets.ts
 *
 * Assembles the five typed domain data packets from pre-computed data.
 *
 *   createDomainDataPackets(normalizedInput, completeness, signalMap) → DomainDataPackets
 *
 * ─── Why domain packets exist ──────────────────────────────────────────────────
 *
 * Phase 1 engines receive the full NormalizedIntelligenceInput — they can read
 * any profile field, making dependencies invisible and hard to test. A domain
 * packet makes the data contract for each engine explicit: only the signals,
 * decisions, and profile fields that engine actually needs.
 *
 * Phase 2: packets are built and carried in IntelligenceDataFlowResult, but
 * engines still consume NormalizedIntelligenceInput (backward-compat).
 * Phase 3: engines migrate to consuming their own packet, removing the
 * AiraUserProfile import from each engine file entirely.
 *
 * ─── Two score fields ─────────────────────────────────────────────────────────
 *
 * completenessScore — raw profile data coverage (0–100).
 *   Directly from DomainCompletenessReport.score.
 *   Formula: (criticalFraction × 60) + (optionalFraction × 40).
 *   Answers: "How much profile data exists for this domain?"
 *
 * confidenceScore — estimated engine output quality (0–100).
 *   Derived by deriveConfidenceScore() from completenessScore + CompletenessStatus.
 *   Answers: "How reliable is this engine's output likely to be?"
 *   Tier mapping (Phase 2):
 *     complete  [80–100] → [90–100]  (linear interpolation)
 *     partial   [40–79]  → [60–85]   (linear interpolation)
 *     missing   [ 0–39]  → [ 0–50]   (linear interpolation)
 *
 * ─── Key invariant ────────────────────────────────────────────────────────────
 *
 * This function does NOT call extractSignals, derivePlanDecisions, or
 * computeReadinessTier. All signals, decisions, and the readiness tier are
 * already present in normalizedInput and signalMap — computed exactly once
 * upstream. This function only subsets and reshapes what is already there.
 *
 * ─── Design rules ─────────────────────────────────────────────────────────────
 * - Pure function. Deterministic. No side effects.
 * - Never throws. No external calls.
 * - Never mutates inputs.
 * - missingCriticalData: only items with impact === "critical" are included.
 *   Moderate / low items are filtered out — packets model hard blockers only.
 */

import type {
  NormalizedIntelligenceInput,
  ProfileCompletenessReport,
  EngineSignalMap,
  DomainDataPackets,
  WorkoutDataPacket,
  NutritionDataPacket,
  RecoveryDataPacket,
  SleepDataPacket,
  PlannerDataPacket,
  WorkoutEngineDecisions,
  NutritionEngineDecisions,
  RecoveryEngineDecisions,
  SleepEngineDecisions,
  PlannerEngineDecisions,
  WorkoutProfileSnapshot,
  NutritionProfileSnapshot,
  RecoveryProfileSnapshot,
  SleepProfileSnapshot,
  PlannerProfileSnapshot,
  MissingDataItem,
  CompletenessStatus,
} from "../types";
import {
  COMPLETENESS_COMPLETE_THRESHOLD,
  COMPLETENESS_PARTIAL_THRESHOLD,
} from "../constants";

/**
 * Build the five typed domain data packets.
 *
 * @param normalizedInput — Already normalized; source of decisions and profile fields.
 * @param completeness    — Per-domain completeness reports: canRun, degradedMode, scores,
 *                          and the missing-field lists.
 * @param signalMap       — Domain-scoped signal views from mapSignalsToEngineInputs().
 * @returns               — DomainDataPackets with one fully typed packet per engine.
 */
export function createDomainDataPackets(
  normalizedInput: NormalizedIntelligenceInput,
  completeness:    ProfileCompletenessReport,
  signalMap:       EngineSignalMap,
): DomainDataPackets {
  const { profile, decisions } = normalizedInput;

  return {
    workout:   buildWorkoutPacket(profile, completeness, signalMap, decisions),
    nutrition: buildNutritionPacket(profile, completeness, signalMap, decisions),
    recovery:  buildRecoveryPacket(profile, completeness, signalMap, decisions),
    sleep:     buildSleepPacket(profile, completeness, signalMap, decisions),
    planner:   buildPlannerPacket(profile, completeness, signalMap, decisions),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal builders — one per domain
// Each builder follows the same structure:
//   1. Pull the domain report from completeness.
//   2. Subset decisions into the domain-scoped decisions type.
//   3. Build a minimal profile snapshot (only what this engine needs).
//   4. Return the packet with both completenessScore and confidenceScore.
// ─────────────────────────────────────────────────────────────────────────────

function buildWorkoutPacket(
  profile:      NormalizedIntelligenceInput["profile"],
  completeness: ProfileCompletenessReport,
  signalMap:    EngineSignalMap,
  decisions:    NormalizedIntelligenceInput["decisions"],
): WorkoutDataPacket {
  const domain = completeness.workout;

  const workoutDecisions: WorkoutEngineDecisions = {
    intensity: decisions.intensity,
    volume:    decisions.volume,
    frequency: decisions.frequency,
    focus:     decisions.focus,
  };

  const profileSnapshot: WorkoutProfileSnapshot = {
    gymAccess:       profile.training.gymAccess,
    trainingStyle:   profile.training.trainingStyle,
    experience:      profile.training.experience,
    daysPerWeek:     profile.training.daysPerWeek,
    sessionDuration: profile.training.sessionDuration,
    primaryGoal:     profile.goals.primaryGoal,
    injuries:        profile.training.injuries ?? undefined,
    recoveryState: {
      sleepQuality:   profile.recovery.sleepQuality,
      stressLevel:    profile.recovery.stressLevel,
      energyBaseline: profile.recovery.energyBaseline,
    },
  };

  return {
    domain:              "workout",
    canRun:              domain.canRun,
    degradedMode:        domain.degradedMode,
    completenessScore:   domain.score,
    confidenceScore:     deriveConfidenceScore(domain.score, domain.status),
    missingCriticalData: criticalOnly(domain.missingFields),
    signals:             signalMap.workout,
    decisions:           workoutDecisions,
    profileSnapshot,
    metadata:            {},
  };
}

function buildNutritionPacket(
  profile:      NormalizedIntelligenceInput["profile"],
  completeness: ProfileCompletenessReport,
  signalMap:    EngineSignalMap,
  decisions:    NormalizedIntelligenceInput["decisions"],
): NutritionDataPacket {
  const domain = completeness.nutrition;

  const nutritionDecisions: NutritionEngineDecisions = {
    nutritionStrategy: decisions.nutritionStrategy,
  };

  const profileSnapshot: NutritionProfileSnapshot = {
    dietaryStyle:  profile.nutrition.dietaryStyle,
    nutritionGoal: profile.nutrition.nutritionGoal,
    mealPrepLevel: profile.nutrition.mealPrepLevel,
    allergies:     profile.nutrition.allergies ?? [],
    allergyNotes:  profile.nutrition.allergyNotes ?? undefined,
    primaryGoal:   profile.goals.primaryGoal,
    bodyMetrics: {
      weight: profile.profile.weight ?? undefined,
      age:    profile.profile.age    ?? undefined,
    },
  };

  return {
    domain:              "nutrition",
    canRun:              domain.canRun,
    degradedMode:        domain.degradedMode,
    completenessScore:   domain.score,
    confidenceScore:     deriveConfidenceScore(domain.score, domain.status),
    missingCriticalData: criticalOnly(domain.missingFields),
    signals:             signalMap.nutrition,
    decisions:           nutritionDecisions,
    profileSnapshot,
    metadata:            {},
  };
}

function buildRecoveryPacket(
  profile:      NormalizedIntelligenceInput["profile"],
  completeness: ProfileCompletenessReport,
  signalMap:    EngineSignalMap,
  decisions:    NormalizedIntelligenceInput["decisions"],
): RecoveryDataPacket {
  const domain = completeness.recovery;

  const recoveryDecisions: RecoveryEngineDecisions = {
    recoveryPriority: decisions.recoveryPriority,
    intensity:        decisions.intensity,
  };

  // HRV may be in future.wearables or future.recovery — check both.
  const wearableHrv =
    profile.future?.wearables?.hrv != null ||
    profile.future?.recovery?.hrv  != null;
  const hrv =
    profile.future?.wearables?.hrv ??
    profile.future?.recovery?.hrv  ??
    undefined;

  const profileSnapshot: RecoveryProfileSnapshot = {
    sleepQuality:   profile.recovery.sleepQuality,
    stressLevel:    profile.recovery.stressLevel,
    energyBaseline: profile.recovery.energyBaseline,
    injuries:       profile.training.injuries ?? undefined,
    hasWearableHrv: wearableHrv,
    hrv,
  };

  return {
    domain:              "recovery",
    canRun:              domain.canRun,
    degradedMode:        domain.degradedMode,
    completenessScore:   domain.score,
    confidenceScore:     deriveConfidenceScore(domain.score, domain.status),
    missingCriticalData: criticalOnly(domain.missingFields),
    signals:             signalMap.recovery,
    decisions:           recoveryDecisions,
    profileSnapshot,
    metadata:            {},
  };
}

function buildSleepPacket(
  profile:      NormalizedIntelligenceInput["profile"],
  completeness: ProfileCompletenessReport,
  signalMap:    EngineSignalMap,
  decisions:    NormalizedIntelligenceInput["decisions"],
): SleepDataPacket {
  const domain = completeness.sleep;

  const sleepDecisions: SleepEngineDecisions = {
    recoveryPriority: decisions.recoveryPriority,
  };

  const profileSnapshot: SleepProfileSnapshot = {
    wakeTime:        profile.sleep.wakeTime,
    sleepTime:       profile.sleep.sleepTime,
    sleepQuality:    profile.recovery.sleepQuality,
    stressLevel:     profile.recovery.stressLevel,
    hasWearableData: Boolean(profile.future?.wearables?.hasDevice),
  };

  return {
    domain:              "sleep",
    canRun:              domain.canRun,
    degradedMode:        domain.degradedMode,
    completenessScore:   domain.score,
    confidenceScore:     deriveConfidenceScore(domain.score, domain.status),
    missingCriticalData: criticalOnly(domain.missingFields),
    signals:             signalMap.sleep,
    decisions:           sleepDecisions,
    profileSnapshot,
    metadata:            {},
  };
}

function buildPlannerPacket(
  profile:      NormalizedIntelligenceInput["profile"],
  completeness: ProfileCompletenessReport,
  signalMap:    EngineSignalMap,
  decisions:    NormalizedIntelligenceInput["decisions"],
): PlannerDataPacket {
  const domain = completeness.planner;

  const plannerDecisions: PlannerEngineDecisions = {
    intensity:         decisions.intensity,
    volume:            decisions.volume,
    frequency:         decisions.frequency,
    focus:             decisions.focus,
    recoveryPriority:  decisions.recoveryPriority,
    scheduleStrategy:  decisions.scheduleStrategy,
    nutritionStrategy: decisions.nutritionStrategy,
  };

  const profileSnapshot: PlannerProfileSnapshot = {
    wakeTime:              profile.sleep.wakeTime,
    sleepTime:             profile.sleep.sleepTime,
    preferredWorkoutTime:  profile.schedule?.preferredWorkoutTime ?? undefined,
    scheduleConsistency:   profile.schedule?.scheduleConsistency  ?? undefined,
    hasCalendarConnected:  profile.future?.schedule?.calendarConnected === true,
    // The planner needs to know whether each domain engine can produce full output.
    // This drives scheduling conservatism per domain.
    domainCanRun: {
      workout:   completeness.workout.canRun,
      nutrition: completeness.nutrition.canRun,
      recovery:  completeness.recovery.canRun,
      sleep:     completeness.sleep.canRun,
    },
  };

  return {
    domain:              "planner",
    canRun:              domain.canRun,
    degradedMode:        domain.degradedMode,
    completenessScore:   domain.score,
    confidenceScore:     deriveConfidenceScore(domain.score, domain.status),
    missingCriticalData: criticalOnly(domain.missingFields),
    signals:             signalMap.planner,
    decisions:           plannerDecisions,
    profileSnapshot,
    metadata:            {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a 0–100 confidence score from a domain's completeness score and status tier.
 *
 * Confidence answers "how reliable is this engine's output likely to be?" —
 * a quality estimate for downstream consumers (UI, discipline score, etc.).
 *
 * Within each tier, the score is linearly interpolated so a domain with more
 * optional fields filled earns a higher confidence score than a bare-minimum
 * domain in the same tier.
 *
 * Tiers and ranges (Phase 2):
 *   complete  [COMPLETE_THRESHOLD,  100]              → confidence [90, 100]
 *   partial   [PARTIAL_THRESHOLD,   COMPLETE_THRESHOLD-1] → confidence [60, 85]
 *   missing   [0,                   PARTIAL_THRESHOLD-1]  → confidence [ 0, 50]
 *
 * Divisors are derived from the threshold constants so this function stays
 * correct if the thresholds are ever adjusted.
 *
 * This function is deterministic: same completenessScore + status → same result.
 */
function deriveConfidenceScore(
  completenessScore: number,
  status:            CompletenessStatus,
): number {
  // Width of the partial tier: [PARTIAL_THRESHOLD, COMPLETE_THRESHOLD - 1]
  // e.g. [40, 79] = 39 intervals when thresholds are 40 / 80.
  const partialRangeWidth = COMPLETENESS_COMPLETE_THRESHOLD - COMPLETENESS_PARTIAL_THRESHOLD - 1;
  // Width of the missing tier: [0, PARTIAL_THRESHOLD - 1]
  // e.g. [0, 39] = 39 intervals when partial threshold is 40.
  const missingRangeMax   = COMPLETENESS_PARTIAL_THRESHOLD - 1;

  switch (status) {
    case "complete":
      // [COMPLETE_THRESHOLD, 100] → [90, 100]:  20-point input range → 10-point output range
      return Math.min(100, Math.round(
        90 + (completenessScore - COMPLETENESS_COMPLETE_THRESHOLD) * 0.5,
      ));

    case "partial":
      // [PARTIAL_THRESHOLD, COMPLETE_THRESHOLD-1] → [60, 85]
      return Math.round(
        60 + ((completenessScore - COMPLETENESS_PARTIAL_THRESHOLD) / partialRangeWidth) * 25,
      );

    case "missing":
      // [0, PARTIAL_THRESHOLD-1] → [0, 50]
      return missingRangeMax > 0
        ? Math.round((completenessScore / missingRangeMax) * 50)
        : 0;
  }
}

/** Filter a missing-field list to hard blockers (impact === "critical") only. */
function criticalOnly(fields: MissingDataItem[]): MissingDataItem[] {
  return fields.filter((f) => f.impact === "critical");
}
