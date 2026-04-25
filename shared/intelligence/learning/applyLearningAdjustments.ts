/**
 * shared/intelligence/learning/applyLearningAdjustments.ts
 *
 * Post-planner learning adjustments — Phase 5 Prompt #3.
 *
 * Applies soft, long-term baseline biases to the final ordered task list.
 * This is the ONLY place where learning causes structural plan changes.
 *
 * ─── When adjustments are applied ────────────────────────────────────────────
 *
 * Adjustments are applied only when learningProfile.confidenceScore >= 0.5.
 * Below this threshold (< 10 of 20 data points) the function is a no-op.
 *
 * ─── Adaptation overrides learning ───────────────────────────────────────────
 *
 * Each adjustment checks the adaptationEffect for same-domain effects.
 * If adaptation has already applied a same-or-stronger effect, the learning
 * adjustment for that domain is skipped. This guarantees the short-term
 * adaptation signal takes precedence over the long-term learning baseline.
 *
 * ─── Adjustments ─────────────────────────────────────────────────────────────
 *
 * A. workoutIntensityBias "medium"
 *    Cap workout task priority to "medium" when the task is "high".
 *    Skipped when adaptation already applied reduceIntensity, capPriority,
 *    or planner.capIntensity.
 *
 * B. recoveryPriorityBias "high"
 *    Elevate recovery and sleep task priorities below "high" to "high".
 *    Skipped when adaptation already applied enforceRecoveryBias or
 *    recovery.increasePriority.
 *
 * C. sleepTargetBias 0.5
 *    Add +0.5h to the sleep task's estimated duration (30 min) and update
 *    its title and metadata.sleepTargetHrs.
 *    Skipped when adaptation already applied sleep.increaseSleepTarget.
 *
 * D. nutritionSimplificationBias
 *    Mark nutrition tasks with a learning note and "adjusted" status.
 *    All nutrition tasks are isRequired: true, so they cannot be removed.
 *    The status/metadata mark signals to the UI that the learning layer
 *    recommends a simplified approach for this domain.
 *    Skipped when adaptation already applied nutrition.simplifyPlan or
 *    planner.simplifyStructure.
 *
 * ─── Safety rules ────────────────────────────────────────────────────────────
 *
 * - Required tasks (isRequired: true) are never removed.
 * - "critical" priority tasks are never downgraded.
 * - The task list is never emptied.
 * - When confidenceScore < 0.5, no changes are applied.
 *
 * ─── Known limitation ────────────────────────────────────────────────────────
 *
 * Learning operates on the canonical `plan.tasks` list only.
 * `plan.scheduleBlocks` and `plan.planner.tasks` contain pre-learning task
 * objects (schedule groupings are time-based, not priority-based, so block
 * membership is not affected). This is an accepted trade-off for Phase 5.
 */

import type {
  IntelligenceTask,
  IntelligencePriority,
  IntelligenceTaskStatus,
  AdaptationEffect,
  AiraLearningProfile,
} from "../types";
import { TaskKind } from "../../planner/types";
import { LEARNING_CONFIDENCE_DATAPOINTS } from "../constants";

// Minimum confidence required to apply any learning adjustments
const MIN_LEARNING_CONFIDENCE = 0.5 as const;

const PRIORITY_RANK: Record<IntelligencePriority, number> = {
  critical: 3,
  high:     2,
  medium:   1,
  low:      0,
};

/**
 * Safely narrow an `unknown` metadata value to IntelligencePriority.
 * Returns `fallback` when the value is absent or not a valid priority string.
 * Replaces unsafe `as IntelligencePriority | undefined` casts on metadata fields.
 */
function narrowPriority(
  value:    unknown,
  fallback: IntelligencePriority,
): IntelligencePriority {
  if (
    value === "critical" ||
    value === "high"     ||
    value === "medium"   ||
    value === "low"
  ) {
    return value;
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply soft learning baseline adjustments to the final ordered task list.
 *
 * @param tasks           — Ordered IntelligenceTask[] from the planner (post-adaptation).
 * @param learningProfile — AiraLearningProfile from buildLearningProfile().
 * @param adaptationEffect — Merged AdaptationEffect; used to detect dominated adjustments.
 * @returns — { finalTasks, learningNotes, learningEffectSummary }
 */
export function applyLearningAdjustments(
  tasks:            IntelligenceTask[],
  learningProfile:  AiraLearningProfile,
  adaptationEffect: AdaptationEffect,
): {
  finalTasks:            IntelligenceTask[];
  learningNotes:         string[];
  learningEffectSummary: string[];
} {
  // Guard: confidence too low → no-op
  if (learningProfile.confidenceScore < MIN_LEARNING_CONFIDENCE) {
    return {
      finalTasks: tasks,
      learningNotes: [
        `[learning] Confidence ${learningProfile.confidenceScore.toFixed(2)} < ${MIN_LEARNING_CONFIDENCE} ` +
        `(${learningProfile.metadata.dataPointsUsed} of ${LEARNING_CONFIDENCE_DATAPOINTS} target data points) ` +
        "— no adjustments applied.",
      ],
      learningEffectSummary: [],
    };
  }

  const { baselineAdjustments: adj } = learningProfile;
  const notes:   string[] = [];
  const summary: string[] = [];
  let result = [...tasks];

  // ── A. Workout intensity bias ─────────────────────────────────────────────
  // Cap workout task priority to "medium" if adaptation has not already done so.
  const adaptationCappedWorkout =
    Boolean(adaptationEffect.workout?.reduceIntensity) ||
    Boolean(adaptationEffect.workout?.capPriority)     ||
    Boolean(adaptationEffect.planner?.capIntensity);

  if (adj.workoutIntensityBias === "medium" && !adaptationCappedWorkout) {
    let changed = false;
    result = result.map((t): IntelligenceTask => {
      if (
        t.category !== "workout"                           ||
        t.priority === "critical"                          ||
        PRIORITY_RANK[t.priority] <= PRIORITY_RANK["medium"]
      ) return t;

      changed = true;
      return {
        ...t,
        priority: "medium" as IntelligencePriority,
        status:   "adjusted" as IntelligenceTaskStatus,
        metadata: {
          ...t.metadata,
          enginePriority: narrowPriority(t.metadata?.enginePriority, t.priority),
          learningNote:   "Learning adjustment: workout capped at medium — long-term readiness history suggests lower volume works better.",
        },
      };
    });
    if (changed) {
      notes.push("[learning] Workout intensity bias applied: high-priority workout tasks capped at medium.");
      summary.push("Learning adjustment: workout intensity capped to medium based on long-term readiness patterns.");
    }
  }

  // ── B. Recovery priority bias ─────────────────────────────────────────────
  // Elevate recovery/sleep tasks below "high" to "high" if adaptation has not done so.
  const adaptationElevatedRecovery =
    Boolean(adaptationEffect.planner?.enforceRecoveryBias) ||
    Boolean(adaptationEffect.recovery?.increasePriority);

  if (adj.recoveryPriorityBias === "high" && !adaptationElevatedRecovery) {
    let changed = false;
    result = result.map((t): IntelligenceTask => {
      if (
        (t.category !== "recovery" && t.category !== "sleep") ||
        PRIORITY_RANK[t.priority] >= PRIORITY_RANK["high"]
      ) return t;

      changed = true;
      return {
        ...t,
        priority: "high" as IntelligencePriority,
        status:   "adjusted" as IntelligenceTaskStatus,
        metadata: {
          ...t.metadata,
          enginePriority: narrowPriority(t.metadata?.enginePriority, t.priority),
          learningNote:   "Learning adjustment: recovery priority elevated — repeated high-stress patterns detected.",
        },
      };
    });
    if (changed) {
      notes.push("[learning] Recovery priority bias applied: recovery/sleep tasks elevated to high.");
      summary.push("Learning adjustment: recovery priority increased based on repeated high-stress history.");
    }
  }

  // ── C. Sleep target bias ──────────────────────────────────────────────────
  // Add +0.5h to the sleep task when adaptation has not already increased the target.
  const adaptationIncreasedSleep = Boolean(adaptationEffect.sleep?.increaseSleepTarget);

  if (adj.sleepTargetBias != null && adj.sleepTargetBias > 0 && !adaptationIncreasedSleep) {
    let changed = false;
    result = result.map((t): IntelligenceTask => {
      if (t.category !== "sleep" || t.kind !== TaskKind.Sleep) return t;

      // Derive the current sleep target from metadata or estimatedMinutes
      const currentHrs = typeof t.metadata?.sleepTargetHrs === "number"
        ? (t.metadata.sleepTargetHrs as number)
        : Math.round(((t.estimatedMinutes ?? 480) / 60) * 10) / 10;
      const newHrs = parseFloat((currentHrs + adj.sleepTargetBias!).toFixed(1));

      changed = true;
      return {
        ...t,
        title:            `Sleep — ${newHrs}h target`,
        estimatedMinutes: Math.round(newHrs * 60),
        status:           "adjusted" as IntelligenceTaskStatus,
        metadata: {
          ...t.metadata,
          sleepTargetHrs: newHrs,
          learningNote:   `Learning adjustment: sleep target increased to ${newHrs}h — inconsistent sleep pattern detected over ${learningProfile.metadata.windowDays} days.`,
        },
      };
    });
    if (changed) {
      notes.push(`[learning] Sleep target bias applied: +${adj.sleepTargetBias}h added to sleep task target.`);
      summary.push(`Learning adjustment: sleep target extended (+${adj.sleepTargetBias}h) based on persistent sleep inconsistency.`);
    }
  }

  // ── D. Nutrition simplification bias ─────────────────────────────────────
  // Mark nutrition tasks with a learning note (all nutrition tasks are isRequired:
  // true so they cannot be removed; status/metadata signals the simplified intent).
  // Skipped when adaptation already simplified the nutrition plan or structure.
  const adaptationSimplifiedNutrition =
    Boolean(adaptationEffect.nutrition?.simplifyPlan) ||
    Boolean(adaptationEffect.planner?.simplifyStructure);

  if (adj.nutritionSimplificationBias === true && !adaptationSimplifiedNutrition) {
    let changed = false;
    result = result.map((t): IntelligenceTask => {
      if (t.category !== "nutrition" || t.metadata?.learningNote) return t;

      changed = true;
      return {
        ...t,
        status: "adjusted" as IntelligenceTaskStatus,
        metadata: {
          ...t.metadata,
          learningNote: "Learning adjustment: nutrition simplified — focus on core habits based on long-term completion data.",
        },
      };
    });
    if (changed) {
      notes.push("[learning] Nutrition simplification bias applied: nutrition tasks marked for simplified approach.");
      summary.push("Learning adjustment: nutrition simplified — focus on core habits based on low long-term completion rate.");
    }
  }

  return { finalTasks: result, learningNotes: notes, learningEffectSummary: summary };
}
