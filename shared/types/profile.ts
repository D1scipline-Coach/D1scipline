/**
 * shared/types/profile.ts
 *
 * Canonical nested user profile type for the Aira app.
 *
 * AiraUserProfile is the client-side source of truth, stored in AsyncStorage
 * and passed between screens. It is NOT sent to the API directly — call
 * flattenProfileForAPI() at the fetch boundary to produce the flat shape that
 * PlannerProfileSchema expects.
 *
 * AI system consumers:
 *   Workout AI   → training.*  + derived.*
 *   Nutrition AI → nutrition.* + goals.primaryGoal
 *   Recovery AI  → recovery.*  (includes sleepQuality, stressLevel, energyBaseline)
 *   Planner AI   → flattenProfileForAPI(profile)  [full flat shape]
 *   Sleep AI     → sleep.*     + recovery.sleepQuality + recovery.stressLevel
 *
 * Field classification:
 *   Required (always set, never undefined after onboarding):
 *     profile.firstName, sleep.wakeTime, sleep.sleepTime, goals.goalLabel
 *     goals.primaryGoal, training.gymAccess, training.trainingStyle,
 *     training.experience, training.daysPerWeek, training.sessionDuration,
 *     nutrition.dietaryStyle, nutrition.nutritionGoal, nutrition.mealPrepLevel,
 *     recovery.stressLevel, recovery.energyBaseline, recovery.sleepQuality
 *
 *   Genuinely optional (user may skip):
 *     profile.age, profile.gender, profile.height, profile.weight
 *     goals.urgency, goals.notes
 *     training.injuries
 *     schedule.preferredWorkoutTime, schedule.scheduleConsistency
 */

import type { PlannerProfileData } from "../planner/schemas";

// ─────────────────────────────────────────────────────────────────────────────
// Primitive type aliases
//
// Single source of truth for every domain value set.
// Import these instead of repeating union literals in schemas, AI consumers,
// or other type files.
// ─────────────────────────────────────────────────────────────────────────────

export type Gender              = "male" | "female" | "other";
export type GoalKind            = "lose_fat" | "build_muscle" | "get_stronger" | "improve_athleticism" | "stay_consistent";
export type GoalUrgency         = "gradual" | "steady" | "aggressive";
export type TrainingStyle       = "athlete" | "muscle" | "strength" | "fat_loss" | "general_fitness" | "calisthenics";
export type GymAccess           = "full_gym" | "limited_equipment" | "bodyweight_only";
export type ExperienceLevel     = "beginner" | "intermediate" | "advanced";
export type SessionDuration     = "20min" | "30min" | "45min" | "60min" | "90min+";
export type DietaryStyle        = "everything" | "vegetarian" | "vegan" | "pescatarian" | "keto" | "gluten_free";
export type NutritionGoalKind   = "fat_loss" | "muscle_gain" | "maintenance" | "performance";
export type MealPrepLevel       = "minimal" | "moderate" | "full_prep";
export type SleepQuality        = "poor" | "fair" | "good" | "great";
export type StressLevel         = "low" | "moderate" | "high" | "very_high";
export type EnergyLevel         = "low" | "moderate" | "high";
export type PreferredWorkoutTime = "early_morning" | "morning" | "afternoon" | "evening" | "night";
export type ScheduleConsistency = "very_consistent" | "somewhat_consistent" | "inconsistent";
// Legacy derived types — used by buildTodaysPlan and the flat API shape
export type BodyFatDirection    = "lose_fat" | "maintain" | "build_lean";
export type Equipment           = "none" | "minimal" | "full_gym";
export type WorkoutFrequency    = "2x" | "3x" | "4x" | "5x";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical nested profile type
// ─────────────────────────────────────────────────────────────────────────────

export type AiraUserProfile = {
  /**
   * Identity & body composition — feeds Workout AI and Nutrition AI caloric targets.
   * firstName is required. All body metrics are optional (contextual data).
   */
  profile: {
    firstName: string;
    age?:      string;
    gender?:   Gender;
    height?:   string;
    weight?:   string;
  };

  /**
   * User intent — primary driver for Planner AI task prioritisation.
   * primaryGoal and goalLabel are required (gate-enforced in Step 4).
   */
  goals: {
    primaryGoal: GoalKind;             // required — Step 4 gate
    /** Human-readable label derived from primaryGoal at onboarding completion */
    goalLabel:   string;
    urgency?:    GoalUrgency;
    notes?:      string;
  };

  /**
   * Training configuration — feeds Workout AI programme generation.
   * Core fields are required (gate-enforced in Steps 2–3).
   */
  training: {
    gymAccess:       GymAccess;        // required — Step 2 gate
    trainingStyle:   TrainingStyle;    // required — Step 3 gate
    experience:      ExperienceLevel;  // required — Step 2 gate
    daysPerWeek:     number;           // required — Step 2 gate (2–7)
    sessionDuration: SessionDuration;  // required — resolved with fallback if skipped
    injuries?:       string;           // optional — user may have none
  };

  /**
   * Dietary preferences and food prep capacity — feeds Nutrition AI.
   * All three core fields are required (gate-enforced in Step 5).
   * allergies is always an array (empty = no restrictions). Collected in Step 6.
   */
  nutrition: {
    dietaryStyle:  DietaryStyle;       // required — Step 5 gate
    nutritionGoal: NutritionGoalKind;  // required — Step 5 gate
    mealPrepLevel: MealPrepLevel;      // required — Step 5 gate
    /** BIG 9 allergens flagged during onboarding. Empty array = no restrictions. */
    allergies:     string[];
    /** Free-text additional allergy or sensitivity notes (optional). */
    allergyNotes?: string;
  };

  /**
   * Baseline recovery state — feeds Recovery AI and Planner AI readiness tier.
   * All three fields are required (gate-enforced in Step 6).
   * sleepQuality is a recovery metric, not a sleep-scheduling field — it lives
   * here alongside stressLevel and energyBaseline, where it is collected.
   */
  recovery: {
    sleepQuality:    SleepQuality;     // required — Step 6 gate
    stressLevel:     StressLevel;      // required — Step 6 gate
    energyBaseline:  EnergyLevel;      // required — Step 6 gate
  };

  /**
   * Sleep scheduling — required for daily plan timeline generation.
   * wakeTime and sleepTime are the structural inputs that anchor every task.
   * Feeds Sleep AI (alongside recovery.sleepQuality and recovery.stressLevel).
   */
  sleep: {
    wakeTime:  string;    // required (e.g. "6:00 AM")
    sleepTime: string;    // required (e.g. "11:00 PM")
  };

  /** Schedule preferences — Planner AI uses these to time-slot workout tasks */
  schedule: {
    preferredWorkoutTime?: PreferredWorkoutTime;
    scheduleConsistency?:  ScheduleConsistency;
  };

  /**
   * Future-expansion data — populated by optional integrations (body scan upload,
   * wearable device connection, calendar sync). All fields are genuinely optional:
   * presence of any field indicates the user has connected the corresponding source.
   * Used to boost `dataConfidenceScore` and generate targeted refinement prompts.
   * No UI shown during initial onboarding — populated later via Settings flows.
   */
  future?: {
    bodyScan?: {
      /** Body-fat percentage from a DEXA, InBody, or similar scan (0–60) */
      bodyFat?:    number;
      /** Lean muscle mass in kg from the same scan */
      muscleMass?: number;
      /** ISO 8601 date when the scan was taken */
      takenAt?:    string;
    };
    wearables?: {
      /** True when the user has connected a wearable device (Apple Watch, Garmin, etc.) */
      hasDevice:          boolean;
      /** Device brand label (display only, not used in logic) */
      deviceLabel?:       string;
      /** Resting heart rate in bpm as reported by the device */
      restingHeartRate?:  number;
      /** Heart-rate variability in ms */
      hrv?:               number;
    };
    schedule?: {
      /** True when the user has authorised calendar read access */
      calendarConnected: boolean;
      /** Number of busy blocks detected this week (informational) */
      busyBlockCount?:   number;
    };
    recovery?: {
      /** Device-reported resting heart rate (may duplicate wearables.restingHeartRate) */
      restingHeartRate?: number;
      /** Device-reported HRV in ms */
      hrv?:              number;
    };
  };

  /**
   * Values computed from source fields at onboarding completion.
   * Stored as a sub-object so buildTodaysPlan and the legacy coach API can read
   * them without re-running mapping logic. derivedAt records when they were
   * computed — if training.trainingStyle or goals.primaryGoal are later edited,
   * compare derivedAt against meta.lastUpdatedAt to detect staleness.
   */
  derived: {
    equipment:        Equipment;
    bodyFatDirection: BodyFatDirection;
    /** e.g. "athletic_strong" — used by buildTodaysPlan for workout naming */
    targetGoal:       string;
    workoutFrequency: WorkoutFrequency;
    derivedAt:        string;           // ISO 8601 — timestamp of last computation
  };

  /**
   * Onboarding bookkeeping — not shown to the user but used for AI context
   * headers, data-quality gating, and future schema migration.
   *
   * dataConfidenceScore (0–100) measures only genuinely optional fields:
   * age, gender, height, weight, goalUrgency, preferredWorkoutTime,
   * scheduleConsistency. Gate-enforced fields are excluded because they are
   * always filled — they tell us nothing about data quality.
   */
  meta: {
    onboardingVersion:     number;
    completedAt:           string;    // ISO 8601 — when onboarding was first finished
    lastUpdatedAt:         string;    // ISO 8601 — updated on every profile edit
    dataConfidenceScore:   number;    // 0–100: % of truly-optional fields filled in
    optionalFieldsSkipped: string[];  // dot-notation paths of optional fields left blank
    /**
     * Refinement prompt history — records when prompts were last shown and which
     * prompt keys the user has already seen. Used by shouldShowRefinementPrompt
     * and prioritizeRefinementSignals to avoid repetition and enforce cooldowns.
     * Safe to omit: undefined is treated as "no history" throughout the engine.
     */
    refinementHistory?: {
      /** ISO 8601 — when a refinement prompt was last surfaced to the user */
      lastPromptShownAt?: string;
      /** Signal keys (not prompt strings) already seen by the user */
      promptsSeen?:       string[];
    };
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Data confidence computation
//
// Checks only genuinely optional fields — those the user can intentionally
// leave blank. Gate-enforced fields (always filled after onboarding) and
// "fill only if applicable" fields like injuries/notes are excluded.
//
// Call at onboarding completion and on every Settings save.
// AI consumers can gate on dataConfidenceScore < 50 to prompt for more context.
// ─────────────────────────────────────────────────────────────────────────────

type ProfileMetaOutput = Pick<AiraUserProfile["meta"], "dataConfidenceScore" | "optionalFieldsSkipped">;

export function computeProfileMeta(
  p: Pick<AiraUserProfile, "profile" | "goals" | "schedule">,
  future?: AiraUserProfile["future"],
): ProfileMetaOutput {
  // Only fields the user can genuinely skip — not gate-enforced, not "N/A by nature"
  const checks: Array<[string, unknown]> = [
    ["profile.age",                      p.profile.age],
    ["profile.gender",                   p.profile.gender],
    ["profile.height",                   p.profile.height],
    ["profile.weight",                   p.profile.weight],
    ["goals.urgency",                    p.goals.urgency],
    ["schedule.preferredWorkoutTime",    p.schedule.preferredWorkoutTime],
    ["schedule.scheduleConsistency",     p.schedule.scheduleConsistency],
  ];

  const skipped = checks
    .filter(([, v]) => v === undefined || v === null || v === "")
    .map(([k]) => k);

  const baseScore = Math.round(((checks.length - skipped.length) / checks.length) * 100);

  // Future-data bonus — each connected integration adds a small confidence boost
  // (max +10 total) to reflect richer context beyond onboarding optional fields.
  let bonus = 0;
  if (future) {
    if (future.bodyScan?.bodyFat != null || future.bodyScan?.muscleMass != null) bonus += 3;
    if (future.wearables?.hasDevice)                                              bonus += 4;
    if (future.schedule?.calendarConnected)                                       bonus += 3;
    if (future.recovery?.restingHeartRate != null || future.recovery?.hrv != null) bonus += 3;
  }

  const score = Math.min(100, baseScore + Math.min(10, bonus));

  return { dataConfidenceScore: score, optionalFieldsSkipped: skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// API flattening
//
// Maps AiraUserProfile → PlannerProfileData (flat wire format expected by the
// server's PlannerProfileSchema). Call immediately before POSTing to
// /api/planner/generate. The nested client type is never sent directly.
// ─────────────────────────────────────────────────────────────────────────────

export function flattenProfileForAPI(p: AiraUserProfile): PlannerProfileData {
  return {
    // Identity
    name:                 p.profile.firstName,
    age:                  p.profile.age,
    gender:               p.profile.gender,
    height:               p.profile.height,
    weight:               p.profile.weight,
    // Goals
    goal:                 p.goals.goalLabel,
    goalType:             p.goals.primaryGoal,
    goalNotes:            p.goals.notes,
    goalUrgency:          p.goals.urgency,
    // Training
    gymAccess:            p.training.gymAccess,
    primaryTrainingStyle: p.training.trainingStyle,
    experienceLevel:      p.training.experience,
    trainingDaysPerWeek:  p.training.daysPerWeek,
    dailyTrainingTime:    p.training.sessionDuration,
    injuries:             p.training.injuries,
    // Nutrition
    dietaryStyle:         p.nutrition.dietaryStyle,
    nutritionGoal:        p.nutrition.nutritionGoal,
    mealPrepLevel:        p.nutrition.mealPrepLevel,
    foodAllergies:        p.nutrition.allergies,
    allergyNotes:         p.nutrition.allergyNotes,
    // Recovery
    sleepQuality:         p.recovery.sleepQuality,
    stressLevel:          p.recovery.stressLevel,
    energyBaseline:       p.recovery.energyBaseline,
    // Sleep scheduling
    wake:                 p.sleep.wakeTime,
    sleep:                p.sleep.sleepTime,
    // Schedule
    preferredWorkoutTime: p.schedule.preferredWorkoutTime,
    scheduleConsistency:  p.schedule.scheduleConsistency,
    // Legacy derived — from derived sub-object
    targetGoal:           p.derived.targetGoal,
    bodyFatDirection:     p.derived.bodyFatDirection,
    equipment:            p.derived.equipment,
    workoutFrequency:     p.derived.workoutFrequency,
  };
}
