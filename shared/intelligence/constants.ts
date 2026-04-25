/**
 * shared/intelligence/constants.ts
 *
 * Static configuration for the Aira Intelligence System.
 *
 * All values are build-time constants — no runtime resolution, no env reads,
 * no randomness.
 *
 * Versioning rules:
 *   INTELLIGENCE_SYSTEM_VERSION — bump when AiraIntelligencePlan shape changes
 *                                 in a way that would break cached plan consumers.
 *   ENGINE_PHASE_VERSION        — "phase1" for all Phase 1 engines. Bump per-engine
 *                                 when its internal logic changes independently.
 */

import type {
  IntelligenceEngineName,
  IntelligenceTaskCategory,
  DailyConditionOverride,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// System identity
// ─────────────────────────────────────────────────────────────────────────────

/** Semantic version of the intelligence system. Carried in every plan's metadata. */
export const INTELLIGENCE_SYSTEM_VERSION = "1.0.0-phase5" as const;

/**
 * Phase marker attached to every engine output's `engineVersion` field.
 * Bump when an engine's internal logic changes enough to invalidate cached outputs.
 */
export const ENGINE_PHASE_VERSION = "phase3" as const;

/**
 * Phase marker for the Planner Engine specifically.
 * Incremented independently of ENGINE_PHASE_VERSION since the planner's logic
 * evolves separately from domain engines.
 */
export const PLANNER_ENGINE_VERSION = "phase4" as const;

/**
 * Phase marker for the Adaptation System.
 * Bump when the adaptation logic changes in a way that would invalidate cached
 * AdaptationContext objects or change signal/recommendation semantics.
 */
export const ADAPTATION_VERSION = "phase5" as const;

/** Default history window (days) the caller should provide to the adaptation system. */
export const ADAPTATION_HISTORY_WINDOW_DAYS = 7 as const;

/** Phase 5 Prompt #3 — Learning layer version string. */
export const LEARNING_VERSION = "phase5_learning_v1" as const;

/**
 * Recommended history window (days) for the learning system.
 * Wider than adaptation to capture long-term tendencies rather than recent spikes.
 */
export const LEARNING_WINDOW_DAYS = 14 as const;

/**
 * Data-points required to reach full learning confidence (confidenceScore = 1.0).
 * Below this number confidence scales linearly: confidenceScore = min(1, n / 20).
 * Adjustments are only applied when confidenceScore >= 0.5 (≥ 10 data points).
 */
export const LEARNING_CONFIDENCE_DATAPOINTS = 20 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Engine registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ordered list of engine names.
 * The ORDER IS SIGNIFICANT:
 *   1–4: domain engines (no inter-engine dependencies within this group)
 *   5:   planner engine — ALWAYS last; depends on all domain engine outputs
 *
 * The sleep engine is an exception: it depends on the recovery engine output
 * (reads plan.windDownMins and plan.sleepTargetHrs). It therefore runs after
 * recovery (position 4) but before planner (position 5).
 */
export const INTELLIGENCE_ENGINE_NAMES: readonly IntelligenceEngineName[] = [
  "workout",    // 1 — no inter-engine dependency
  "nutrition",  // 2 — no inter-engine dependency
  "recovery",   // 3 — no inter-engine dependency
  "sleep",      // 4 — depends on recovery output
  "planner",    // 5 — ALWAYS LAST; depends on all four domain engines
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Task categories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical list of IntelligenceTaskCategory values.
 * Use this when you need to iterate or validate categories at runtime.
 */
export const INTELLIGENCE_TASK_CATEGORIES: readonly IntelligenceTaskCategory[] = [
  "workout",
  "nutrition",
  "recovery",
  "sleep",
  "planning",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Defaults for NormalizedIntelligenceInput
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safe defaults for DailyConditionOverride.
 * Applied when the caller does not supply a daily check-in.
 * Represents a neutral baseline — no strong signal in any direction.
 */
export const DEFAULT_DAILY_CONDITION: Required<DailyConditionOverride> = {
  energyLevel:     "moderate",
  soreness:        "fresh",
  motivationLevel: "moderate",
  timeAvailable:   "moderate",
  focusArea:       "consistency",
} as const;

/** Default interaction count when not supplied by the caller. */
export const DEFAULT_INTERACTION_COUNT = 0 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Validation thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum dataConfidenceScore to suppress the low-confidence warning.
 * Below this, validateIntelligenceInput emits a warning that plan precision is limited.
 */
export const MIN_CONFIDENCE_SCORE_FOR_NO_WARNING = 50 as const;

/**
 * Number of significant validation warnings required to trigger degradedMode.
 * A single missing optional field is not degraded; multiple structural gaps are.
 */
export const DEGRADED_MODE_WARNING_THRESHOLD = 3 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Data Flow & Signal Integration constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Literal phase marker written into DataFlowMetadata.phase.
 * Increment when the data flow shape changes in a way that would invalidate
 * any cached data flow results.
 */
export const PHASE_2_DATA_FLOW_VERSION = "phase_2_data_flow" as const;

/**
 * Domain completeness score (0–100) at or above which the domain is "complete".
 * All critical fields present + most optional fields filled.
 */
export const COMPLETENESS_COMPLETE_THRESHOLD = 80 as const;

/**
 * Domain completeness score (0–100) at or above which the domain is "partial".
 * Enough data to run, but quality could be improved with more profile data.
 */
export const COMPLETENESS_PARTIAL_THRESHOLD = 40 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Task ID builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a deterministic task ID.
 *
 * Format: `{engine}-{kind.toLowerCase()}-{index}`
 * Contract: same engine + kind + index → same ID, always.
 * No UUID, no randomness, no timestamp.
 *
 * Collision note: IDs are unique within a single plan because each engine
 * uses its own namespace prefix and sequential indexes. Two engines may
 * produce the same kind string but their engine prefix differs.
 */
export function buildTaskId(
  engine: IntelligenceEngineName,
  kind:   string,
  index:  number,
): string {
  return `${engine}-${kind.toLowerCase()}-${index}`;
}
