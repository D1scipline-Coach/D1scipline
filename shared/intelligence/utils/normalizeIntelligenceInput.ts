/**
 * shared/intelligence/utils/normalizeIntelligenceInput.ts
 *
 * Converts AiraIntelligenceInput → NormalizedIntelligenceInput.
 *
 * This is the ONLY place in the intelligence system where:
 *   - extractSignals()        is called  (single source of truth)
 *   - derivePlanDecisions()   is called  (single decision derivation)
 *   - deriveConfidenceLevel() is called  (single confidence assessment)
 *
 * Every downstream engine receives these pre-computed values — they MUST NOT
 * re-derive signals, re-run decisions, or re-assess confidence independently.
 *
 * Design rules:
 *   - The source profile is never mutated.
 *   - Safe defaults are applied here, not in engines.
 *   - Validation warnings are threaded through to NormalizedIntelligenceInput
 *     so engines can check them without needing access to the raw validation result.
 *   - `degradedMode: true` signals engines to apply conservative defaults and
 *     report lower confidence.
 *
 * Precondition:
 *   validateIntelligenceInput(input).valid === true before calling this.
 *   Passing invalid input is a programming error — behavior is undefined.
 */

import type { AiraIntelligenceInput, NormalizedIntelligenceInput } from "../types";
import {
  DEFAULT_DAILY_CONDITION,
  DEFAULT_INTERACTION_COUNT,
} from "../constants";
import {
  extractSignals,
  derivePlanDecisions,
  deriveConfidenceLevel,
} from "../../planner/generateDailyPlan";

/**
 * Normalize validated intelligence input into the stable internal shape.
 *
 * @param input              — Validated AiraIntelligenceInput.
 * @param validationWarnings — Warnings from validateIntelligenceInput (threaded through).
 * @param degradedMode       — Phase 1 validation-based flag: true when validation found
 *                             significant data gaps (warning count ≥ 3). This is stored
 *                             in NormalizedIntelligenceInput.degradedMode and consumed
 *                             by Phase 1 engines for conservative defaults. It is
 *                             distinct from the Phase 2 completeness-based
 *                             globalDegradedMode in DataFlowMetadata — the two can
 *                             diverge. Phase 3 should unify them.
 * @param generatedAt        — ISO 8601 timestamp for this plan run. Supplied by the
 *                             orchestrator so the same instant is recorded in both
 *                             normalizedAt and the final plan's generatedAt field.
 *                             When absent, falls back to new Date().toISOString().
 *                             See AiraIntelligenceInput.generatedAt for the determinism
 *                             contract around this value.
 * @returns                  — NormalizedIntelligenceInput with all fields resolved.
 */
export function normalizeIntelligenceInput(
  input:              AiraIntelligenceInput,
  validationWarnings: string[]  = [],
  degradedMode:       boolean   = false,
  generatedAt:        string    = new Date().toISOString(),
): NormalizedIntelligenceInput {
  const { profile } = input;

  // ── Date ──────────────────────────────────────────────────────────────────
  const date = resolveDate(input.date);

  // ── Signal extraction — ONCE ──────────────────────────────────────────────
  // extractSignals is the single source of truth for all user-state signals.
  // The result is threaded to every engine. No engine may call extractSignals again.
  const signals = extractSignals(profile);

  // ── Decision derivation — ONCE ────────────────────────────────────────────
  // derivePlanDecisions receives the pre-computed signals to avoid a second
  // extraction. The local reasoning array is discarded — engines that need their
  // own reasoning trace create a fresh local array inside their own function.
  const normalizationReasoning: string[] = [];
  const decisions = derivePlanDecisions(profile, normalizationReasoning, signals);

  // ── Confidence level — ONCE ───────────────────────────────────────────────
  const confidenceLevel = deriveConfidenceLevel(profile);

  // ── Daily condition — merge overrides with safe defaults ──────────────────
  // Always produces a complete object — engines never receive a partial condition.
  const dailyCondition: Required<typeof DEFAULT_DAILY_CONDITION> = {
    ...DEFAULT_DAILY_CONDITION,
    ...input.dailyCondition,
  };

  // ── Onboarding connection flag ─────────────────────────────────────────────
  // True when the critical gate-enforced onboarding fields are present.
  // A false value here indicates a legacy or corrupted profile.
  const onboardingConnected =
    Boolean(profile.goals?.primaryGoal) &&
    typeof profile.training?.daysPerWeek === "number" &&
    profile.training.daysPerWeek >= 1 &&
    Boolean(profile.sleep?.wakeTime) &&
    Boolean(profile.sleep?.sleepTime) &&
    Boolean(profile.recovery?.sleepQuality) &&
    Boolean(profile.recovery?.stressLevel) &&
    Boolean(profile.recovery?.energyBaseline);

  // ── Source classification ──────────────────────────────────────────────────
  const source: NormalizedIntelligenceInput["source"] =
    onboardingConnected ? "onboarding"
    : validationWarnings.length > 0 ? "partial"
    : "unknown";

  return {
    profile,
    signals,
    decisions,
    confidenceLevel,
    date,
    dailyCondition,
    onboardingConnected,
    degradedMode,
    source,
    // generatedAt and normalizedAt share the same timestamp — set once by the
    // orchestrator and threaded in so both fields record the same instant.
    generatedAt:           generatedAt,
    normalizedAt:          generatedAt,
    validationWarnings,
    interactionCount:      input.interactionCount      ?? DEFAULT_INTERACTION_COUNT,
    lastRefinementShownAt: input.lastRefinementShownAt ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the plan date. Falls back to today when absent or malformed. */
function resolveDate(date: string | undefined): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date;
  }
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, "0");
  const d   = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
