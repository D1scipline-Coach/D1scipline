/**
 * shared/intelligence/adaptation/buildAdaptationContext.ts
 *
 * Main entry point for the Phase 5 Adaptation System.
 *
 *   buildAdaptationContext(input) → AdaptationContext
 *
 * ─── Pipeline ────────────────────────────────────────────────────────────────
 *
 * Step 1  Normalize input — missing arrays become []; never throws.
 * Step 2  analyzeUserFeedback(checkIns)
 *           → FeedbackSummary: pattern counts and flags.
 * Step 3  analyzePlanHistory(recentPlans, taskCompletions)
 *           → HistorySummary: plan stability and per-domain completion rates.
 * Step 4  deriveAdaptationSignals(feedbackSummary, historySummary)
 *           → AdaptationSignal[]: structured, typed signals.
 * Step 5  createAdaptationRecommendations(signals)
 *           → AdaptationRecommendation[]: actionable, next-plan recommendations.
 * Step 6  buildDomainSummaries(historySummary, signals)
 *           → AdaptationDomainSummary[]: per-domain view of trend and issues.
 * Step 7  deriveOverallTrend(historySummary, feedbackSummary)
 *           → AdaptationTrend: overall performance trajectory.
 * Step 8  buildRisks(signals)
 *           → AdaptationRisk[]: elevated from medium/high severity signals.
 * Step 9  Assemble and return AdaptationContext.
 *
 * ─── Design guarantees ───────────────────────────────────────────────────────
 *
 * Deterministic:     same input → same output, always.
 * No randomness:     no Math.random(), no uuid.
 * No async:          synchronous from start to finish.
 * No external calls: no API calls, no AI model calls.
 * No mutation:       inputs are never modified.
 * Never throws:      all missing/undefined inputs degrade gracefully.
 * Observational:     does not mutate any engine or planner output.
 *
 * ─── Phase 5 Prompt #1 note ──────────────────────────────────────────────────
 *
 * Adaptation context is attached to AiraIntelligencePlan.metadata but does NOT
 * influence engine or planner decisions yet. That wiring comes in Prompt #2.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  AiraAdaptationInput,
  AdaptationContext,
  AdaptationDomainSummary,
  AdaptationRisk,
  AdaptationSignal,
  AdaptationTrend,
  IntelligenceEngineName,
} from "../types";
import { ADAPTATION_VERSION, ADAPTATION_HISTORY_WINDOW_DAYS } from "../constants";
import { analyzeUserFeedback }            from "./analyzeUserFeedback";
import { analyzePlanHistory }             from "./analyzePlanHistory";
import { deriveAdaptationSignals }        from "./deriveAdaptationSignals";
import { createAdaptationRecommendations } from "./createAdaptationRecommendations";
import type { FeedbackSummary }           from "./analyzeUserFeedback";
import type { HistorySummary }            from "./analyzePlanHistory";

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a complete adaptation context from available history and feedback.
 *
 * All input arrays are optional — the function degrades gracefully when any
 * are absent or empty. Callers should provide the appropriate time window
 * (recommended: ADAPTATION_HISTORY_WINDOW_DAYS = 7).
 *
 * @param input — AiraAdaptationInput with optional history, feedback, and plan data.
 * @returns     — AdaptationContext: signals, recommendations, domain summaries, risks.
 */
export function buildAdaptationContext(input: AiraAdaptationInput): AdaptationContext {
  // ── Step 1: Normalize — safe defaults for all optional arrays ─────────────
  const checkIns        = input.checkIns        ?? [];
  const recentPlans     = input.recentPlans      ?? [];
  const taskCompletions = input.taskCompletions  ?? [];
  const generatedAt     = input.generatedAt      ?? new Date().toISOString();

  // ── Step 2: Analyze user check-ins ────────────────────────────────────────
  const feedbackSummary = analyzeUserFeedback(checkIns);

  // ── Step 3: Analyze plan history and task completions ─────────────────────
  const historySummary = analyzePlanHistory(recentPlans, taskCompletions);

  // ── Step 4: Derive adaptation signals ────────────────────────────────────
  const signals = deriveAdaptationSignals({ feedbackSummary, historySummary });

  // ── Step 5: Create recommendations ───────────────────────────────────────
  const recommendations = createAdaptationRecommendations(signals);

  // ── Step 6: Build per-domain summaries ───────────────────────────────────
  const domainSummaries = buildDomainSummaries(historySummary, signals);

  // ── Step 7: Derive overall trend ─────────────────────────────────────────
  const overallTrend = deriveOverallTrend(historySummary, feedbackSummary);

  // ── Step 8: Extract risks from medium/high signals ───────────────────────
  const risks = buildRisks(signals);

  // ── Step 9: Assemble context ──────────────────────────────────────────────
  return {
    signals,
    recommendations,
    domainSummaries,
    risks,
    overallTrend,
    metadata: {
      generatedAt,
      adaptationVersion:   ADAPTATION_VERSION,
      deterministic:       true,
      historyWindowDays:   ADAPTATION_HISTORY_WINDOW_DAYS,
      plansAnalyzed:       recentPlans.length,
      completionsAnalyzed: taskCompletions.length,
      checkInsAnalyzed:    checkIns.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a per-domain summary from history and signals.
 * Only covers the four core domains (workout/nutrition/recovery/sleep).
 */
function buildDomainSummaries(
  hs:      HistorySummary,
  signals: AdaptationSignal[],
): AdaptationDomainSummary[] {
  const DOMAINS: IntelligenceEngineName[] = ["workout", "nutrition", "recovery", "sleep"];

  return DOMAINS.map((domain): AdaptationDomainSummary => {
    const domainSignals    = signals.filter((s) => s.domain === domain);
    const domainCompletion = hs.domainCompletions.find((d) => d.domain === domain);
    const completionRate   = domainCompletion?.completionRate ?? -1;
    const recentIssues     = domainSignals.map((s) => s.message);

    const trend = deriveDomainTrend(completionRate, domainSignals);

    return { domain, trend, completionRate, recentIssues, signals: domainSignals };
  });
}

/**
 * Derive a single domain's trend from its completion rate and active signals.
 *
 * Rules (evaluated in priority order):
 *   1. No data → "insufficient_data"
 *   2. Has high-severity signal → "declining"
 *   3. Completion ≥ 80% + no negative signals → "improving"
 *   4. Completion ≥ 50% → "stable"
 *   5. Completion < 50% → "declining"
 */
function deriveDomainTrend(
  completionRate: number,
  domainSignals:  AdaptationSignal[],
): AdaptationTrend {
  if (completionRate < 0) return "insufficient_data";

  const hasHighSignal = domainSignals.some((s) => s.severity === "high");
  if (hasHighSignal) return "declining";

  const hasMediumSignal = domainSignals.some((s) => s.severity === "medium");

  if (completionRate >= 0.8 && !hasMediumSignal) return "improving";
  if (completionRate >= 0.5) return "stable";
  return "declining";
}

/**
 * Derive the overall system trend from plan history and feedback.
 *
 * Rules (evaluated in priority order):
 *   1. No data at all                                 → "insufficient_data"
 *   2. Strong consistency + no negative feedback      → "improving"
 *   3. Plan stability warning OR low overall completion
 *      OR high stress pattern                         → "declining"
 *   4. Otherwise                                      → "stable"
 */
function deriveOverallTrend(
  hs: HistorySummary,
  fb: FeedbackSummary,
): AdaptationTrend {
  const hasAnyData = hs.planCount > 0 || fb.checkInCount > 0;
  if (!hasAnyData) return "insufficient_data";

  if (
    hs.hasStrongConsistency &&
    !fb.hasLowEnergyPattern  &&
    !fb.hasHighSorenessPattern &&
    !fb.hasHighStressPattern
  ) {
    return "improving";
  }

  if (
    hs.hasPlanStabilityWarning ||
    hs.hasLowOverallCompletion  ||
    fb.hasHighStressPattern
  ) {
    return "declining";
  }

  return "stable";
}

/**
 * Elevate medium and high signals into AdaptationRisk objects.
 * Low-severity signals are awareness-only and are not surfaced as risks.
 */
function buildRisks(signals: AdaptationSignal[]): AdaptationRisk[] {
  return signals
    .filter((s): s is AdaptationSignal & { severity: "medium" | "high" } =>
      s.severity === "medium" || s.severity === "high"
    )
    .map((s, idx): AdaptationRisk => ({
      id:          `risk-${s.type}-${idx}`,
      domain:      s.domain,
      severity:    s.severity,
      description: s.message,
    }));
}
