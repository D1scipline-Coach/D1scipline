/**
 * shared/intelligence/utils/AiraIntelligenceError.ts
 *
 * Structured error class for the Aira Intelligence System.
 *
 * Thrown by generateAiraIntelligencePlan() on hard failures.
 * Callers should catch AiraIntelligenceError specifically to distinguish
 * intelligence pipeline failures from other runtime errors, then fall back
 * to generateDailyPlan().
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   try {
 *     const plan = generateAiraIntelligencePlan({ profile });
 *   } catch (err) {
 *     if (err instanceof AiraIntelligenceError) {
 *       console.error(err.code, err.failedFields, err.inputSnapshot);
 *     }
 *     // fall back to generateDailyPlan(profile)
 *   }
 */

/** Discriminant codes for intelligence pipeline hard failures. */
export type IntelligenceErrorCode =
  | "VALIDATION_FAILED"   // blocking validation errors — profile shape is invalid
  | "PIPELINE_ERROR";     // orchestrator-level failure outside validation

/**
 * Structured error thrown by generateAiraIntelligencePlan on hard failures.
 *
 * Properties:
 *   code          — machine-readable failure category
 *   failedFields  — list of specific profile fields / reasons that blocked the plan
 *   inputSnapshot — safe structural snapshot of the input (no raw user data)
 */
export class AiraIntelligenceError extends Error {
  readonly code:          IntelligenceErrorCode;
  readonly failedFields:  readonly string[];
  readonly inputSnapshot: Readonly<Record<string, unknown>>;

  constructor(
    code:          IntelligenceErrorCode,
    message:       string,
    failedFields:  string[]                = [],
    inputSnapshot: Record<string, unknown> = {},
  ) {
    super(message);
    // Ensure `instanceof` checks work correctly when the class is transpiled.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name          = "AiraIntelligenceError";
    this.code          = code;
    this.failedFields  = Object.freeze([...failedFields]);
    this.inputSnapshot = Object.freeze({ ...inputSnapshot });
  }
}
