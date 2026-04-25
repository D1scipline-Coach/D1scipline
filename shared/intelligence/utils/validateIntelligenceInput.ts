/**
 * shared/intelligence/utils/validateIntelligenceInput.ts
 *
 * Input validation for the Aira Intelligence System.
 *
 * Contract:
 *   - NEVER throws. Returns a structured result the caller can inspect.
 *   - The caller (orchestrator) decides whether to abort or continue in degraded mode.
 *   - Works on `unknown` input — safe to call even with completely arbitrary data.
 *
 * Validation tiers:
 *
 *   BLOCKING ERRORS (valid: false):
 *     Hard failures that make it impossible to produce any useful plan.
 *     The orchestrator must stop and surface the error to the caller.
 *     Examples: input is not an object, profile is missing entirely,
 *               required sub-blocks are absent, gate-enforced fields are missing.
 *
 *   NON-BLOCKING WARNINGS (valid: true):
 *     Soft issues where plan generation can proceed with reduced accuracy.
 *     Carried into the plan's metadata for observability.
 *     Examples: missing optional fields, low confidence score, no injury info.
 *
 *   DEGRADED MODE (valid: true, degradedMode: true):
 *     Triggered when warnings exceed DEGRADED_MODE_WARNING_THRESHOLD.
 *     The orchestrator signals this to engines so they can apply conservative
 *     defaults and reduce their confidence ratings.
 *
 * Phase 1 scope:
 *   Validates structural requirements and optional-field completeness.
 *
 * Phase 2+ extension points:
 *   - Cross-field rules (e.g. wake < sleep, daysPerWeek ≤ 7)
 *   - Allergy / dietary style cross-validation
 *   - Profile staleness check (meta.lastUpdatedAt)
 */

import type { AiraIntelligenceInput, AiraIntelligenceValidationResult } from "../types";
import {
  MIN_CONFIDENCE_SCORE_FOR_NO_WARNING,
  DEGRADED_MODE_WARNING_THRESHOLD,
} from "../constants";

/**
 * Validate raw intelligence input before normalization.
 *
 * @param input — Anything the caller passes in (typed as `unknown` for safety).
 * @returns     — { valid, errors, warnings, degradedMode }
 */
export function validateIntelligenceInput(
  input: unknown,
): AiraIntelligenceValidationResult {
  const errors:   string[] = [];
  const warnings: string[] = [];

  // ── Tier 1: Existence + type ───────────────────────────────────────────────
  if (input === null || input === undefined) {
    errors.push("Input is null or undefined — cannot generate a plan without a profile.");
    return { valid: false, errors, warnings, degradedMode: false };
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    errors.push(`Input must be a plain object, received: ${Array.isArray(input) ? "array" : typeof input}.`);
    return { valid: false, errors, warnings, degradedMode: false };
  }

  const raw = input as Record<string, unknown>;

  // ── Tier 2: Profile presence ───────────────────────────────────────────────
  if (!raw.profile || typeof raw.profile !== "object" || Array.isArray(raw.profile)) {
    errors.push("input.profile is missing or not a plain object — onboarding data is required.");
    return { valid: false, errors, warnings, degradedMode: false };
  }

  const profile = raw.profile as Record<string, unknown>;

  // ── Tier 3: Required sub-block presence ───────────────────────────────────
  // All five blocks are required. Collect all missing-block errors together
  // before returning so the caller can see the full picture at once.

  const requiredBlocks: Array<[string, string]> = [
    ["goals",    "profile.goals is missing — primaryGoal required for plan intent."],
    ["training", "profile.training is missing — gymAccess, experience, daysPerWeek required."],
    ["sleep",    "profile.sleep is missing — wakeTime and sleepTime required to anchor the schedule."],
    ["recovery", "profile.recovery is missing — sleepQuality, stressLevel, energyBaseline required."],
    ["nutrition","profile.nutrition is missing — dietaryStyle and nutritionGoal required."],
  ];

  for (const [key, message] of requiredBlocks) {
    if (!profile[key] || typeof profile[key] !== "object" || Array.isArray(profile[key])) {
      errors.push(message);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, degradedMode: false };
  }

  // ── Tier 4: Gate-enforced field checks ────────────────────────────────────
  // These should never fail for profiles from the current onboarding system.
  // Failures indicate a corrupted, migrated, or manually constructed profile.

  const goals    = profile.goals    as Record<string, unknown>;
  const training = profile.training as Record<string, unknown>;
  const sleep    = profile.sleep    as Record<string, unknown>;
  const recovery = profile.recovery as Record<string, unknown>;

  if (!goals.primaryGoal) {
    errors.push("profile.goals.primaryGoal is missing — plan intent cannot be determined.");
  }
  if (!training.daysPerWeek || typeof training.daysPerWeek !== "number" || training.daysPerWeek < 1) {
    errors.push("profile.training.daysPerWeek is missing or invalid (must be a number ≥ 1).");
  }
  if (!training.sessionDuration) {
    errors.push("profile.training.sessionDuration is missing — workout duration cannot be set.");
  }
  if (!training.gymAccess) {
    errors.push("profile.training.gymAccess is missing — exercise selection requires this field.");
  }
  if (!training.experience) {
    errors.push("profile.training.experience is missing — volume and intensity scaling require this field.");
  }
  if (!sleep.wakeTime) {
    errors.push("profile.sleep.wakeTime is missing — day schedule cannot be generated.");
  }
  if (!sleep.sleepTime) {
    errors.push("profile.sleep.sleepTime is missing — wind-down and bedtime cannot be scheduled.");
  }
  if (!recovery.sleepQuality) {
    errors.push("profile.recovery.sleepQuality is missing — readiness tier cannot be computed.");
  }
  if (!recovery.stressLevel) {
    errors.push("profile.recovery.stressLevel is missing — readiness tier cannot be computed.");
  }
  if (!recovery.energyBaseline) {
    errors.push("profile.recovery.energyBaseline is missing — readiness tier cannot be computed.");
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings, degradedMode: false };
  }

  // ── Tier 5: Non-blocking warnings ────────────────────────────────────────
  // All checks below are soft — plan generation continues regardless.

  // Profile confidence score
  const meta = profile.meta && typeof profile.meta === "object"
    ? (profile.meta as Record<string, unknown>)
    : null;

  const confidenceScore = meta?.dataConfidenceScore;
  if (typeof confidenceScore === "number" && confidenceScore < MIN_CONFIDENCE_SCORE_FOR_NO_WARNING) {
    warnings.push(
      `Profile confidence score is ${confidenceScore}/100 — plan will use conservative defaults. ` +
      "Adding optional profile data will sharpen plan precision."
    );
  } else if (confidenceScore == null) {
    warnings.push(
      "profile.meta.dataConfidenceScore is absent — cannot assess plan confidence level. " +
      "Profile may be from a pre-confidence-score onboarding version."
    );
  }

  // Optional schedule fields
  const schedule = profile.schedule && typeof profile.schedule === "object"
    ? (profile.schedule as Record<string, unknown>)
    : null;

  if (!schedule?.preferredWorkoutTime) {
    warnings.push(
      "profile.schedule.preferredWorkoutTime not set — workout will default to morning timing."
    );
  }
  if (!schedule?.scheduleConsistency) {
    warnings.push(
      "profile.schedule.scheduleConsistency not set — plan will use fixed scheduling strategy."
    );
  }

  // Training injury info
  if (!training.injuries) {
    warnings.push(
      "profile.training.injuries not set — plan cannot account for movement restrictions."
    );
  }

  // Nutrition completeness
  const nutrition = profile.nutrition as Record<string, unknown>;
  if (!nutrition.dietaryStyle) {
    warnings.push(
      "profile.nutrition.dietaryStyle not set — nutrition suggestions will use general guidelines."
    );
  }
  if (!nutrition.nutritionGoal) {
    warnings.push(
      "profile.nutrition.nutritionGoal not set — caloric strategy may not match user intent."
    );
  }
  if (!nutrition.mealPrepLevel) {
    warnings.push(
      "profile.nutrition.mealPrepLevel not set — meal complexity will default to minimal prep."
    );
  }
  // Allergy info: empty array is valid (no restrictions); undefined/missing is a gap
  if (!Array.isArray(nutrition.allergies)) {
    warnings.push(
      "profile.nutrition.allergies not set — food allergy safety cannot be confirmed."
    );
  }

  // Goal completeness
  if (!goals.urgency) {
    warnings.push(
      "profile.goals.urgency not set — training intensity bias will use neutral defaults."
    );
  }

  // Optional identity fields
  const profileBlock = profile.profile && typeof profile.profile === "object"
    ? (profile.profile as Record<string, unknown>)
    : null;

  if (!profileBlock?.age) {
    warnings.push("profile.profile.age not set — calorie targets will use population averages.");
  }
  if (!profileBlock?.weight) {
    warnings.push("profile.profile.weight not set — macro targets cannot be calibrated to body mass.");
  }

  // Input date format
  if (raw.date !== undefined && raw.date !== null) {
    if (typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date as string)) {
      warnings.push(
        `input.date "${raw.date}" is not in YYYY-MM-DD format — today's date will be used.`
      );
    }
  }

  // ── Determine degraded mode ────────────────────────────────────────────────
  // Degraded mode triggers when enough warnings accumulate to meaningfully
  // reduce plan reliability. Engines check this flag to apply conservative
  // defaults and lower their confidence ratings.
  const degradedMode = warnings.length >= DEGRADED_MODE_WARNING_THRESHOLD;

  return { valid: true, errors, warnings, degradedMode };
}
