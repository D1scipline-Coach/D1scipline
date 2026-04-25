/**
 * shared/intelligence/data/analyzeProfileCompleteness.ts
 *
 * Analyzes how complete a user's profile is across every intelligence domain.
 *
 *   analyzeProfileCompleteness(normalizedInput) → ProfileCompletenessReport
 *
 * ─── Why completeness analysis exists ────────────────────────────────────────
 *
 * The intelligence system needs to know — per domain — how much profile data it
 * has to work with before dispatching engines. This serves three purposes:
 *
 *   1. Engine degraded mode:
 *      If critical fields are absent, the engine falls back to conservative
 *      defaults. The completeness report makes this explicit and testable.
 *
 *   2. Confidence scoring:
 *      Domain packets carry a confidenceScore derived from completeness. UI
 *      consumers can show "plan is based on incomplete data" indicators.
 *
 *   3. Onboarding nudges:
 *      missingFields carries human-readable recommendations so the UI can
 *      surface exactly what data the user should complete next.
 *
 * ─── Scoring model ───────────────────────────────────────────────────────────
 *
 * Each domain defines two field lists:
 *   critical — must be present for the engine to produce meaningful output.
 *   optional — improve personalisation quality but do not block the engine.
 *
 * score = (criticalPresentFraction × 60) + (optionalPresentFraction × 40)
 *
 * This means:
 *   All critical + all optional   → 100 → "complete"
 *   All critical + no optional    →  60 → "partial"   (not degraded — can run)
 *   One critical missing          → <60 → "partial"   (degraded — falls back)
 *   No critical fields at all     →   0 → "missing"   (degraded — falls back)
 *
 * When a domain has NO optional fields, optionalPresentFraction is treated as
 * 1.0 (fully satisfied) to avoid penalising domains that intentionally have few
 * optional fields.
 *
 * status thresholds (from constants):
 *   complete  ≥ 80
 *   partial   ≥ 40
 *   missing   <  40
 *
 * canRun       = all critical fields present.
 * degradedMode = !canRun  (engine falls back to defaults when true).
 *
 * ─── Domain field definitions ─────────────────────────────────────────────────
 *
 * Workout  critical: primaryGoal, gymAccess, experience, daysPerWeek, sessionDuration
 *          optional: injuries, goalUrgency, age, weight
 *
 * Nutrition critical: dietaryStyle, nutritionGoal, mealPrepLevel, allergies (array)
 *          optional: allergyNotes, weight, age
 *
 * Recovery critical: sleepQuality, stressLevel, energyBaseline
 *          optional: injuries, wearable HRV, future recovery data
 *
 * Sleep    critical: wakeTime, sleepTime
 *          optional: sleepQuality (crossover), preferredWorkoutTime, wearable data
 *
 * Planner  critical: wakeTime, sleepTime, daysPerWeek, sessionDuration
 *          optional: preferredWorkoutTime, scheduleConsistency, calendarConnected
 *
 * ─── Design rules ─────────────────────────────────────────────────────────────
 * - Pure function. No side effects. Deterministic.
 * - Never throws. Returns safe defaults for any missing sub-object.
 * - Reads only from NormalizedIntelligenceInput.profile — no engine state.
 * - Future fields accessed via safe optional chaining — no hard failures.
 */

import type {
  NormalizedIntelligenceInput,
  ProfileCompletenessReport,
  DomainCompletenessReport,
  MissingDataItem,
  DataImpact,
  CompletenessStatus,
  IntelligenceEngineName,
} from "../types";
import {
  COMPLETENESS_COMPLETE_THRESHOLD,
  COMPLETENESS_PARTIAL_THRESHOLD,
} from "../constants";
import type { AiraUserProfile } from "../../types/profile";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze profile completeness for all domains.
 *
 * @param normalizedInput — Normalized input (already validated and normalized).
 * @returns               — ProfileCompletenessReport with per-domain breakdowns.
 */
export function analyzeProfileCompleteness(
  normalizedInput: NormalizedIntelligenceInput,
): ProfileCompletenessReport {
  const { profile } = normalizedInput;

  const workout   = analyzeWorkoutDomain(profile);
  const nutrition = analyzeNutritionDomain(profile);
  const recovery  = analyzeRecoveryDomain(profile);
  const sleep     = analyzeSleepDomain(profile);
  const planner   = analyzePlannerDomain(profile);

  const overall   = aggregateOverall([workout, nutrition, recovery, sleep, planner]);

  return { overall, workout, nutrition, recovery, sleep, planner };
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain analysers
// ─────────────────────────────────────────────────────────────────────────────

function analyzeWorkoutDomain(profile: AiraUserProfile): DomainCompletenessReport {
  const critical: CheckDef[] = [
    {
      present: Boolean(profile.goals.primaryGoal),
      item: missing("goals.primaryGoal", "Primary goal", "workout", "critical",
        "Set your primary fitness goal so Aira can build a plan around your intent."),
    },
    {
      present: Boolean(profile.training.gymAccess),
      item: missing("training.gymAccess", "Equipment access", "workout", "critical",
        "Specify your gym or equipment access so exercises match what you have available."),
    },
    {
      present: Boolean(profile.training.experience),
      item: missing("training.experience", "Training experience level", "workout", "critical",
        "Select your experience level so Aira can set appropriate volume and complexity."),
    },
    {
      present: typeof profile.training.daysPerWeek === "number" && profile.training.daysPerWeek >= 1,
      item: missing("training.daysPerWeek", "Training days per week", "workout", "critical",
        "Set how many days per week you want to train to structure the programme correctly."),
    },
    {
      present: Boolean(profile.training.sessionDuration),
      item: missing("training.sessionDuration", "Session duration", "workout", "critical",
        "Set your typical workout duration so sessions are designed to fit your schedule."),
    },
  ];

  const optional: CheckDef[] = [
    {
      present: Boolean(profile.training.injuries),
      item: missing("training.injuries", "Injury history", "workout", "moderate",
        "Add any injuries or movement restrictions so Aira can substitute exercises safely."),
    },
    {
      present: Boolean(profile.goals.urgency),
      item: missing("goals.urgency", "Goal urgency", "workout", "moderate",
        "Set your urgency level (gradual / steady / aggressive) to calibrate training intensity."),
    },
    {
      present: Boolean(profile.profile.age),
      item: missing("profile.age", "Age", "workout", "low",
        "Add your age to improve recovery time estimates and fatigue modelling."),
    },
    {
      present: Boolean(profile.profile.weight),
      item: missing("profile.weight", "Body weight", "workout", "low",
        "Add your weight for more accurate load progression and calorie calculations."),
    },
  ];

  return buildDomainReport(critical, optional, []);
}

function analyzeNutritionDomain(profile: AiraUserProfile): DomainCompletenessReport {
  const critical: CheckDef[] = [
    {
      present: Boolean(profile.nutrition.dietaryStyle),
      item: missing("nutrition.dietaryStyle", "Dietary style", "nutrition", "critical",
        "Set your dietary style (e.g. vegan, keto) so meal suggestions respect your eating preferences."),
    },
    {
      present: Boolean(profile.nutrition.nutritionGoal),
      item: missing("nutrition.nutritionGoal", "Nutrition goal", "nutrition", "critical",
        "Set your nutrition goal (fat loss / muscle gain / maintenance / performance) for accurate caloric targets."),
    },
    {
      present: Boolean(profile.nutrition.mealPrepLevel),
      item: missing("nutrition.mealPrepLevel", "Meal prep level", "nutrition", "critical",
        "Set your meal prep capacity so recipe complexity matches your lifestyle."),
    },
    {
      // allergies is always an array — present means the field was set during onboarding
      // An empty array is valid (no restrictions). Missing entirely is the gap.
      present: Array.isArray(profile.nutrition.allergies),
      item: missing("nutrition.allergies", "Allergy information", "nutrition", "critical",
        "Complete the allergy screening during onboarding so Aira can keep your meals safe."),
    },
  ];

  const optional: CheckDef[] = [
    {
      present: Boolean(profile.nutrition.allergyNotes),
      item: missing("nutrition.allergyNotes", "Additional allergy notes", "nutrition", "moderate",
        "Add any allergy or sensitivity notes not covered by the standard allergen list."),
    },
    {
      present: Boolean(profile.profile.weight),
      item: missing("profile.weight", "Body weight", "nutrition", "moderate",
        "Add your weight to calibrate macronutrient targets to your body mass."),
    },
    {
      present: Boolean(profile.profile.age),
      item: missing("profile.age", "Age", "nutrition", "low",
        "Add your age to calculate a more accurate basal metabolic rate and calorie target."),
    },
  ];

  return buildDomainReport(critical, optional, []);
}

function analyzeRecoveryDomain(profile: AiraUserProfile): DomainCompletenessReport {
  const critical: CheckDef[] = [
    {
      present: Boolean(profile.recovery.sleepQuality),
      item: missing("recovery.sleepQuality", "Sleep quality", "recovery", "critical",
        "Set your sleep quality so Aira can calculate your readiness tier for today."),
    },
    {
      present: Boolean(profile.recovery.stressLevel),
      item: missing("recovery.stressLevel", "Stress level", "recovery", "critical",
        "Set your stress level so Aira can assess systemic load and adjust training accordingly."),
    },
    {
      present: Boolean(profile.recovery.energyBaseline),
      item: missing("recovery.energyBaseline", "Energy baseline", "recovery", "critical",
        "Set your typical energy level so Aira can calibrate readiness alongside sleep and stress."),
    },
  ];

  // wearable HRV — read from either future.wearables or future.recovery (both optional)
  const wearableHrv =
    profile.future?.wearables?.hrv != null ||
    profile.future?.recovery?.hrv != null;

  const optional: CheckDef[] = [
    {
      present: Boolean(profile.training.injuries),
      item: missing("training.injuries", "Injury history", "recovery", "moderate",
        "Add injuries or movement limitations so recovery protocols are adapted to your needs."),
    },
    {
      present: wearableHrv,
      item: missing("future.wearables.hrv", "Wearable HRV data", "recovery", "low",
        "Connect a wearable device to provide HRV data for more precise recovery scoring."),
    },
  ];

  return buildDomainReport(critical, optional, []);
}

function analyzeSleepDomain(profile: AiraUserProfile): DomainCompletenessReport {
  const critical: CheckDef[] = [
    {
      present: Boolean(profile.sleep.wakeTime),
      item: missing("sleep.wakeTime", "Wake time", "sleep", "critical",
        "Set your typical wake time to anchor the daily schedule."),
    },
    {
      present: Boolean(profile.sleep.sleepTime),
      item: missing("sleep.sleepTime", "Sleep time", "sleep", "critical",
        "Set your target bedtime to schedule wind-down and calculate your sleep window."),
    },
  ];

  const hasWearableData = Boolean(profile.future?.wearables?.hasDevice);

  const optional: CheckDef[] = [
    {
      present: Boolean(profile.recovery.sleepQuality),
      item: missing("recovery.sleepQuality", "Sleep quality baseline", "sleep", "moderate",
        "Set your sleep quality so Aira can adjust tonight's sleep target based on your current state."),
    },
    {
      present: Boolean(profile.schedule?.preferredWorkoutTime),
      item: missing("schedule.preferredWorkoutTime", "Preferred workout time", "sleep", "moderate",
        "Set your preferred workout time so the sleep schedule respects your training windows."),
    },
    {
      present: hasWearableData,
      item: missing("future.wearables.hasDevice", "Wearable device", "sleep", "low",
        "Connect a wearable to enable passive sleep tracking and automated sleep goal completion."),
    },
    {
      present: Boolean(profile.schedule?.scheduleConsistency),
      item: missing("schedule.scheduleConsistency", "Schedule consistency", "sleep", "low",
        "Set your schedule consistency so Aira knows whether to use fixed or flexible sleep timing."),
    },
  ];

  return buildDomainReport(critical, optional, []);
}

function analyzePlannerDomain(profile: AiraUserProfile): DomainCompletenessReport {
  const critical: CheckDef[] = [
    {
      present: Boolean(profile.sleep.wakeTime),
      item: missing("sleep.wakeTime", "Wake time", "planner", "critical",
        "Set your wake time to anchor the full day schedule."),
    },
    {
      present: Boolean(profile.sleep.sleepTime),
      item: missing("sleep.sleepTime", "Sleep time", "planner", "critical",
        "Set your bedtime so the planner can allocate evening wind-down and sleep."),
    },
    {
      present: typeof profile.training.daysPerWeek === "number" && profile.training.daysPerWeek >= 1,
      item: missing("training.daysPerWeek", "Training days per week", "planner", "critical",
        "Set training frequency so the planner knows how many workout slots to allocate this week."),
    },
    {
      present: Boolean(profile.training.sessionDuration),
      item: missing("training.sessionDuration", "Session duration", "planner", "critical",
        "Set session duration so the planner can correctly block workout time."),
    },
  ];

  const hasCalendar = profile.future?.schedule?.calendarConnected === true;

  const optional: CheckDef[] = [
    {
      present: Boolean(profile.schedule?.preferredWorkoutTime),
      item: missing("schedule.preferredWorkoutTime", "Preferred workout time", "planner", "moderate",
        "Set a preferred workout time so the planner consistently places sessions when you perform best."),
    },
    {
      present: Boolean(profile.schedule?.scheduleConsistency),
      item: missing("schedule.scheduleConsistency", "Schedule consistency", "planner", "moderate",
        "Set schedule consistency so the planner uses fixed or adaptive timing appropriately."),
    },
    {
      present: hasCalendar,
      item: missing("future.schedule.calendarConnected", "Calendar integration", "planner", "low",
        "Connect your calendar so the planner can work around your existing commitments."),
    },
  ];

  return buildDomainReport(critical, optional, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate individual domain reports into a single overall report.
 *
 * - score:       average of all domain scores.
 * - canRun:      true only when ALL domains can run.
 * - degradedMode: true when ANY domain is degraded.
 * - missingFields: union of all domain missing fields, deduplicated by field path.
 * - warnings:    union of all domain warnings.
 */
function aggregateOverall(domains: DomainCompletenessReport[]): DomainCompletenessReport {
  const avgScore = Math.round(
    domains.reduce((sum, d) => sum + d.score, 0) / domains.length,
  );

  // Deduplicate by field path (same field may appear in multiple domains)
  const seen      = new Set<string>();
  const allFields = domains
    .flatMap((d) => d.missingFields)
    .filter((f) => {
      if (seen.has(f.field)) return false;
      seen.add(f.field);
      return true;
    });

  return {
    score:         avgScore,
    status:        scoreToStatus(avgScore),
    missingFields: allFields,
    warnings:      domains.flatMap((d) => d.warnings),
    canRun:        domains.every((d) => d.canRun),
    degradedMode:  domains.some((d) => d.degradedMode),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Internal check definition — field presence + the MissingDataItem to emit if absent. */
type CheckDef = { present: boolean; item: MissingDataItem };

/**
 * Build a DomainCompletenessReport from critical and optional check lists.
 *
 * Score formula:
 *   criticalFraction = (present criticals) / (total criticals)
 *   optionalFraction = (present optionals) / (total optionals)
 *   score = round(criticalFraction * 60 + optionalFraction * 40)
 *
 * When there are no optional fields, the optional contribution is treated as
 * fully satisfied (40/40) to avoid unfairly penalising domains with few optional fields.
 *
 * STATUS INVARIANT:
 *   status === "complete" REQUIRES canRun === true.
 *   If critical fields are missing (canRun === false), status is capped at "partial"
 *   regardless of the arithmetic score. This prevents the paradox where optional
 *   fields inflate the score to ≥80 while the engine cannot actually run.
 *   Example: workout 4/5 critical + 4/4 optional → score 88 → raw "complete",
 *            but canRun=false so status is corrected to "partial".
 */
function buildDomainReport(
  critical:       CheckDef[],
  optional:       CheckDef[],
  domainWarnings: string[],
): DomainCompletenessReport {
  const missingCriticals = critical.filter((c) => !c.present).map((c) => c.item);
  const missingOptionals = optional.filter((c) => !c.present).map((c) => c.item);

  const critCount = critical.length;
  const optCount  = optional.length;

  const critFraction = critCount > 0
    ? (critCount - missingCriticals.length) / critCount
    : 1.0;
  const optFraction  = optCount > 0
    ? (optCount - missingOptionals.length) / optCount
    : 1.0;

  const score        = Math.round(critFraction * 60 + optFraction * 40);
  const canRun       = missingCriticals.length === 0;
  const degradedMode = !canRun;

  // Cap status: "complete" is only valid when canRun === true.
  // If canRun is false, the highest allowed status is "partial".
  const rawStatus = scoreToStatus(score);
  const status: CompletenessStatus =
    !canRun && rawStatus === "complete" ? "partial" : rawStatus;

  return {
    score,
    status,
    missingFields: [...missingCriticals, ...missingOptionals],
    warnings:      domainWarnings,
    canRun,
    degradedMode,
  };
}

/** Map a 0–100 score to a CompletenessStatus (arithmetic only — see buildDomainReport for canRun enforcement). */
function scoreToStatus(score: number): CompletenessStatus {
  if (score >= COMPLETENESS_COMPLETE_THRESHOLD) return "complete";
  if (score >= COMPLETENESS_PARTIAL_THRESHOLD)  return "partial";
  return "missing";
}

/** Convenience builder for MissingDataItem. */
function missing(
  field:          string,
  label:          string,
  domain:         IntelligenceEngineName,
  impact:         DataImpact,
  recommendation: string,
): MissingDataItem {
  return { field, label, domain, impact, recommendation };
}
