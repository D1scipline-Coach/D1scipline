/**
 * shared/intelligence/adaptation/analyzePlanHistory.ts
 *
 * Analyzes PlanHistoryRecord[] and TaskCompletionRecord[] to detect plan
 * stability and domain-level completion patterns.
 *
 * Rules:
 *   - Deterministic: same records → same output, always.
 *   - No ML, no randomness.
 *   - PlanHistoryRecord.domainCompletion takes precedence over TaskCompletionRecord
 *     for per-domain rates (plan-level data is more authoritative).
 *   - TaskCompletionRecord is used as a fallback when plan-level domain data
 *     is absent.
 *   - Never throws. Empty arrays → safe zero-state summary.
 *
 * Thresholds:
 *   - Plan stability warning: ≥3 adjusted/fallback plans in the window.
 *   - Low completion: < 50% completion rate.
 *   - Strong consistency: all domains with data ≥ 80%.
 */

import type { PlanHistoryRecord, TaskCompletionRecord, IntelligenceTaskCategory } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

export type DomainCompletionSummary = {
  domain:           IntelligenceTaskCategory;
  /** 0–1 average completion rate. -1 when no data is available. */
  completionRate:   number;
  hasLowCompletion: boolean;
};

export type HistorySummary = {
  planCount:    number;
  fallbackCount: number;
  adjustedCount: number;
  optimalCount:  number;

  // Plan stability
  hasPlanStabilityWarning: boolean;

  // Overall task completion averaged across plan records
  overallCompletionRate:   number;  // 0–1; -1 if no data
  hasLowOverallCompletion: boolean;

  // Per-domain completion
  domainCompletions:  DomainCompletionSummary[];
  hasStrongConsistency: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Number of adjusted + fallback plans that triggers a stability warning. */
const PLAN_STABILITY_THRESHOLD   = 3 as const;
const LOW_COMPLETION_THRESHOLD   = 0.5 as const;
const STRONG_COMPLETION_THRESHOLD = 0.8 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze recent plan history and task completion records.
 *
 * @param recentPlans     — PlanHistoryRecord[] (caller provides the window).
 * @param taskCompletions — TaskCompletionRecord[] (used as fallback for per-domain rates).
 * @returns               — HistorySummary with plan stability and domain completion data.
 */
export function analyzePlanHistory(
  recentPlans:     PlanHistoryRecord[],
  taskCompletions: TaskCompletionRecord[],
): HistorySummary {
  let fallbackCount = 0;
  let adjustedCount = 0;
  let optimalCount  = 0;
  let totalCompleted = 0;
  let totalTasks     = 0;

  for (const plan of recentPlans) {
    if (plan.plannerStatus === "fallback")        fallbackCount++;
    else if (plan.plannerStatus === "adjusted")   adjustedCount++;
    else if (plan.plannerStatus === "optimal")    optimalCount++;

    if (
      plan.completedTaskCount !== undefined &&
      plan.totalTaskCount     !== undefined &&
      plan.totalTaskCount > 0
    ) {
      totalCompleted += plan.completedTaskCount;
      totalTasks     += plan.totalTaskCount;
    }
  }

  const overallCompletionRate = totalTasks > 0 ? totalCompleted / totalTasks : -1;

  const domainCompletions = buildDomainCompletions(recentPlans, taskCompletions);

  // Strong consistency: every domain that has data is above the strong threshold
  const domainRatesWithData = domainCompletions
    .filter((d) => d.completionRate >= 0)
    .map((d) => d.completionRate);

  const hasStrongConsistency =
    domainRatesWithData.length > 0 &&
    domainRatesWithData.every((r) => r >= STRONG_COMPLETION_THRESHOLD);

  return {
    planCount:     recentPlans.length,
    fallbackCount,
    adjustedCount,
    optimalCount,
    hasPlanStabilityWarning: (fallbackCount + adjustedCount) >= PLAN_STABILITY_THRESHOLD,
    overallCompletionRate,
    hasLowOverallCompletion:
      overallCompletionRate >= 0 && overallCompletionRate < LOW_COMPLETION_THRESHOLD,
    domainCompletions,
    hasStrongConsistency,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build per-domain completion summaries.
 *
 * Priority order:
 *   1. Average from PlanHistoryRecord.domainCompletion (most authoritative).
 *   2. Computed from TaskCompletionRecord[] (fallback).
 *   3. -1 (no data) when neither source has data for the domain.
 */
function buildDomainCompletions(
  recentPlans:     PlanHistoryRecord[],
  taskCompletions: TaskCompletionRecord[],
): DomainCompletionSummary[] {
  const DOMAINS: IntelligenceTaskCategory[] = ["workout", "nutrition", "recovery", "sleep"];

  return DOMAINS.map((domain): DomainCompletionSummary => {
    // ── Source 1: plan-level domain completion ────────────────────────────
    let planSum       = 0;
    let planDataCount = 0;

    for (const plan of recentPlans) {
      const rate = plan.domainCompletion?.[domain as keyof NonNullable<typeof plan.domainCompletion>];
      if (typeof rate === "number") {
        planSum += rate;
        planDataCount++;
      }
    }

    if (planDataCount > 0) {
      const completionRate = planSum / planDataCount;
      return {
        domain,
        completionRate,
        hasLowCompletion: completionRate < LOW_COMPLETION_THRESHOLD,
      };
    }

    // ── Source 2: task completion records fallback ────────────────────────
    const domainTasks    = taskCompletions.filter((t) => t.domain === domain);
    const completedTasks = domainTasks.filter((t) => t.completed && t.skipped !== true);

    if (domainTasks.length === 0) {
      return { domain, completionRate: -1, hasLowCompletion: false };
    }

    const completionRate = completedTasks.length / domainTasks.length;
    return {
      domain,
      completionRate,
      hasLowCompletion: completionRate < LOW_COMPLETION_THRESHOLD,
    };
  });
}
