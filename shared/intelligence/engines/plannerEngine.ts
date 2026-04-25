/**
 * shared/intelligence/engines/plannerEngine.ts
 *
 * Planner Engine — Phase 4 (Core Build)
 *
 * The Planner Engine is the master coordinator of the Aira Intelligence System.
 * It runs LAST — after all domain engines — and owns:
 *
 *   1. Daily focus         — thematic "theme" for the day, derived from domain states
 *   2. Daily summary       — 1–3 sentence user-facing description of the plan
 *   3. Task priority model — final per-domain priority assignments
 *   4. Task ordering       — deterministic merge + sort of all engine tasks
 *   5. Schedule blocks     — tasks grouped into morning/midday/afternoon/evening
 *   6. Conflict detection  — cross-domain signal conflicts
 *   7. Conflict resolution — planner-level adjustments for each conflict
 *   8. Planner status      — optimal / adjusted / fallback
 *   9. Planner metadata    — domain state snapshot + conflict counts
 *
 * Architecture rules:
 *   - Deterministic: same input → same output.
 *   - Never throws. Never mutates inputs.
 *   - Never calls external APIs.
 *   - No domain engine logic duplicated — only coordination.
 *   - PLANNER OWNERSHIP RULE: this is the only place scheduledTime is set.
 *
 * Phase 4 design:
 *   Domain engines are unchanged. The planner consumes their outputs and
 *   applies cross-domain intelligence on top. Priority adjustments are applied
 *   to individual tasks without mutating domain engine output objects.
 *
 *   normalizedInput is retained for generateSchedule() backward compatibility.
 *   domainPackets carry per-domain health and drive all new Phase 4 logic.
 *
 * Phase 5+ will expand:
 *   - Calendar-aware scheduling (hasCalendarConnected)
 *   - Dynamic reordering from daily condition override
 *   - Notification schedule generation
 *   - Multi-day continuity and programme progression
 */

import type {
  NormalizedIntelligenceInput,
  PlannerEngineInput,
  PlannerEngineOutput,
  IntelligenceTask,
  IntelligenceTaskStatus,
  IntelligencePriority,
  IntelligenceEngineName,
  EngineOutputStatus,
  AdaptationEffect,
  PlannerScheduleBlock,
  PlannerConflict,
  PlannerResolution,
  PlannerPriorityModel,
  PlannerMetadata,
  WorkoutDataPacket,
  NutritionDataPacket,
  RecoveryDataPacket,
  SleepDataPacket,
} from "../types";
import { generateSchedule } from "../../planner/generateDailyPlan";
import { TaskKind } from "../../planner/types";
import { PLANNER_ENGINE_VERSION } from "../constants";

// ─────────────────────────────────────────────────────────────────────────────
// Priority rank table — used throughout for ceiling/floor comparisons
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<IntelligencePriority, number> = {
  critical: 3,
  high:     2,
  medium:   1,
  low:      0,
};

function higherOf(a: IntelligencePriority, b: IntelligencePriority): IntelligencePriority {
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
}

function lowerOf(a: IntelligencePriority, b: IntelligencePriority): IntelligencePriority {
  return PRIORITY_RANK[a] <= PRIORITY_RANK[b] ? a : b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 8 — Planner status
// ─────────────────────────────────────────────────────────────────────────────

function deriveStatus(
  wp:        WorkoutDataPacket,
  np:        NutritionDataPacket,
  rp:        RecoveryDataPacket,
  sp:        SleepDataPacket,
  conflicts: PlannerConflict[],
): EngineOutputStatus {
  const notCanRunCount = [wp, np, rp, sp].filter((p) => !p.canRun).length;

  // Fallback: ≥2 domains have insufficient critical data to run meaningfully
  if (notCanRunCount >= 2) return "fallback";

  // Adjusted: any medium/high conflict, any domain !canRun, or below-high average confidence.
  //   - low-severity conflicts are awareness-only and do not downgrade status.
  //   - avgConfidence < 76 catches cases where all domains can run but output quality is limited.
  const hasSignificantConflict = conflicts.some(
    (c) => c.severity === "high" || c.severity === "medium"
  );
  const avgConfidence =
    (wp.confidenceScore + np.confidenceScore + rp.confidenceScore + sp.confidenceScore) / 4;

  if (hasSignificantConflict || notCanRunCount > 0 || avgConfidence < 76) return "adjusted";

  // Optimal: all domains can run, no medium/high conflicts, all confidence scores are high
  return "optimal";
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 1 — Daily focus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces a short, deterministic "theme" for the day.
 * Priority order: critical degradation → readiness tier → domain states → goal.
 */
function buildDailyFocus(input: PlannerEngineInput): string {
  const { workoutOutput, recoveryOutput, sleepOutput, nutritionOutput, domainPackets } = input;
  const { workout: wp, nutrition: np, recovery: rp, sleep: sp } = domainPackets;

  const notCanRunCount = [wp, np, rp, sp].filter((p) => !p.canRun).length;

  // Multiple critical domains down — stabilise first
  if (notCanRunCount >= 2) {
    return "Stabilise your routine and stay consistent.";
  }

  // Recovery cannot run OR readiness in Recover tier — restoration day
  if (!rp.canRun || recoveryOutput.readinessTier === "Recover") {
    return "Recover, reset, and protect your consistency.";
  }

  // Sleep cannot run — energy is the limiting factor
  if (!sp.canRun) {
    return "Protect your energy and rebuild sleep habits.";
  }

  // Stress elevated — recovery and sleep lead
  if (recoveryOutput.stressFlag) {
    return "Manage stress and protect your sleep tonight.";
  }

  // Nutrition fallback + training active — train first, fix data second
  if (!np.canRun && wp.canRun) {
    return "Train consistently and complete your nutrition profile.";
  }

  // Nutrition adjusted (partial data) + workout running
  if (nutritionOutput.status === "adjusted" && workoutOutput.status !== "fallback") {
    return "Train well while tightening your nutrition.";
  }

  // Optimal readiness — push performance
  if (recoveryOutput.readinessTier === "Push" && workoutOutput.status !== "fallback") {
    return "Push performance while protecting recovery.";
  }

  // Maintain readiness — stay the course
  if (recoveryOutput.readinessTier === "Maintain") {
    return "Stay consistent and build on yesterday.";
  }

  // Default: surface the planner decisions focus from the packet
  return domainPackets.planner.decisions.focus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 2 — Daily summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces a 1–3 sentence user-facing summary of why today's plan is structured
 * the way it is. Deterministic. No technical jargon.
 */
function buildDailySummary(
  input:     PlannerEngineInput,
  status:    EngineOutputStatus,
  conflicts: PlannerConflict[],
): string {
  const { workoutOutput, recoveryOutput, domainPackets } = input;
  const { workout: wp, nutrition: np, recovery: rp, sleep: sp } = domainPackets;

  if (status === "fallback") {
    // Name the failing areas in plain language — no technical terms
    const failingAreas = [
      !wp.canRun ? "training" : null,
      !np.canRun ? "nutrition" : null,
      !rp.canRun ? "recovery" : null,
      !sp.canRun ? "sleep" : null,
    ].filter(Boolean) as string[];
    const gapClause = failingAreas.length > 0
      ? ` Some ${failingAreas.join(" and ")} profile details are missing.`
      : "";
    return (
      `Today's plan is simplified.${gapClause} ` +
      "Focus on consistent movement, eating well, and protecting your sleep. " +
      "Filling in those details will unlock a fully personalised plan."
    );
  }

  const readinessTier         = recoveryOutput.readinessTier;
  const hasHighConflict       = conflicts.some((c) => c.severity === "high");
  const hasMediumConflict     = conflicts.some((c) => c.severity === "medium");
  const stressActive          = recoveryOutput.stressFlag;
  const stressNote            = stressActive
    ? " Keep stress management and wind-down a priority tonight."
    : "";

  if (workoutOutput.status !== "fallback") {
    const sessionLabel = workoutOutput.split.replace(/_/g, " ");
    const duration     = `${workoutOutput.durationMins} min`;

    if (readinessTier === "Recover") {
      return (
        `Today prioritises recovery over training output. A lighter ${sessionLabel} session (${duration}) ` +
        "is on the plan, but recovery protocols take precedence. " +
        "How well you recover today directly shapes tomorrow's performance."
      );
    }

    if (hasHighConflict) {
      return (
        `Today includes a ${sessionLabel} session (${duration}), but some signals suggest caution. ` +
        "Honour the prescribed intensity, auto-regulate if needed, and prioritise recovery alongside training."
      );
    }

    if (hasMediumConflict) {
      const readinessLine =
        readinessTier === "Push"
          ? "Your readiness is strong, though a few areas need attention."
          : "Your readiness is moderate — balance training with adequate recovery today.";
      return (
        `Today is built around a ${sessionLabel} session (${duration}). ${readinessLine}` +
        `${stressNote}`
      );
    }

    const readinessLine =
      readinessTier === "Push"
        ? "Your recovery signals are strong — the plan supports full training effort."
        : "Your recovery is moderate — the plan balances training with recovery support.";

    return (
      `Today is built around a ${sessionLabel} session (${duration}), ` +
      `supported by recovery protocols and consistent nutrition. ${readinessLine}` +
      `${stressNote}`
    );
  }

  // Workout fallback — recovery and consistency day
  if (recoveryOutput.status !== "fallback") {
    return (
      "Today focuses on recovery and consistency. " +
      "Complete your training profile to unlock a personalised workout. " +
      `Recovery protocols and nutrition guidance are active.${stressNote}`
    );
  }

  return (
    "Today's plan covers what data is available. " +
    "Complete your profile in the areas shown to unlock full personalisation."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 6 — Conflict detection
// ─────────────────────────────────────────────────────────────────────────────

function detectConflicts(input: PlannerEngineInput): PlannerConflict[] {
  const { workoutOutput, nutritionOutput, recoveryOutput, sleepOutput, domainPackets } = input;
  const { workout: wp, nutrition: np, recovery: rp, sleep: sp } = domainPackets;
  const conflicts: PlannerConflict[] = [];
  let idx = 0;

  const isHighIntensity =
    workoutOutput.intensityLevel === "high" || workoutOutput.intensityLevel === "max";

  // ── Conflict 1: High workout intensity + low readiness ────────────────────
  if (
    isHighIntensity &&
    recoveryOutput.readinessTier === "Recover" &&
    workoutOutput.status !== "fallback"
  ) {
    conflicts.push({
      id:          `conflict-high-intensity-low-readiness-${idx++}`,
      type:        "high-intensity-low-readiness",
      severity:    "high",
      domains:     ["workout", "recovery"] satisfies IntelligenceEngineName[],
      description:
        "High workout intensity is prescribed while recovery signals indicate depleted readiness. " +
        "Training at this load may compromise recovery and increase injury risk.",
    });
  }

  // ── Conflict 2: Workout running + recovery fallback ──────────────────────
  // Any active workout (not just optimal) paired with a recovery fallback is a conflict —
  // readiness cannot be validated regardless of workout data quality.
  if (workoutOutput.status !== "fallback" && recoveryOutput.status === "fallback") {
    conflicts.push({
      id:          `conflict-workout-running-recovery-fallback-${idx++}`,
      type:        "workout-running-recovery-fallback",
      severity:    "medium",
      domains:     ["workout", "recovery"] satisfies IntelligenceEngineName[],
      description:
        "A structured workout is scheduled but recovery data is insufficient to validate readiness. " +
        "Training intensity cannot be confirmed as appropriate for current recovery state.",
    });
  }

  // ── Conflict 3: Sleep degraded + active training demand ───────────────────
  if (sleepOutput.status === "fallback" && workoutOutput.status !== "fallback") {
    conflicts.push({
      id:          `conflict-sleep-degraded-training-demand-${idx++}`,
      type:        "sleep-degraded-training-demand",
      severity:    "medium",
      domains:     ["sleep", "workout"] satisfies IntelligenceEngineName[],
      description:
        "Sleep scheduling is generic due to missing profile data, making it difficult to align " +
        "training, recovery, and sleep timing. Sleep quality cannot be confirmed.",
    });
  }

  // ── Conflict 4: Nutrition insufficient + high training demand ────────────
  // Covers both fallback (generic targets) and adjusted (partial targets) when
  // intensity is high — fuelling quality matters most on demanding days.
  if (
    (nutritionOutput.status === "fallback" || nutritionOutput.status === "adjusted") &&
    isHighIntensity &&
    workoutOutput.status !== "fallback"
  ) {
    const severity = nutritionOutput.status === "fallback" ? "medium" : "low";
    conflicts.push({
      id:          `conflict-nutrition-insufficient-high-demand-${idx++}`,
      type:        "nutrition-insufficient-high-training-demand",
      severity,
      domains:     ["nutrition", "workout"] satisfies IntelligenceEngineName[],
      description:
        nutritionOutput.status === "fallback"
          ? "Nutrition targets are generic while training intensity is high. " +
            "Fuelling precision is significantly reduced during a demanding training period."
          : "Nutrition targets are partially personalised while training intensity is high. " +
            "Completing the nutrition profile would improve fuelling accuracy on hard training days.",
    });
  }

  // ── Conflict 5: Multiple domains cannot run ───────────────────────────────
  // High severity — multiple critical domains have insufficient data to produce
  // personalised output. Triggers "fallback" plan status.
  const failedDomains = (
    [
      { name: "workout"   as IntelligenceEngineName, canRun: wp.canRun },
      { name: "nutrition" as IntelligenceEngineName, canRun: np.canRun },
      { name: "recovery"  as IntelligenceEngineName, canRun: rp.canRun },
      { name: "sleep"     as IntelligenceEngineName, canRun: sp.canRun },
    ]
  ).filter((d) => !d.canRun);

  if (failedDomains.length >= 2) {
    conflicts.push({
      id:          `conflict-multiple-domains-insufficient-data-${idx++}`,
      type:        "multiple-domains-insufficient-data",
      severity:    "high",
      domains:     failedDomains.map((d) => d.name),
      description:
        `${failedDomains.length} domains (${failedDomains.map((d) => d.name).join(", ")}) are operating ` +
        "on insufficient data. Overall plan quality is significantly reduced until the missing profile " +
        "fields are completed.",
    });
  }

  // ── Conflict 6: Multiple adjusted domains ────────────────────────────────
  // Low severity — ≥2 domains running on partial data limits cross-domain
  // optimisation even though individual domains can produce output.
  const adjustedDomains = (
    [
      { name: "workout"   as IntelligenceEngineName, status: workoutOutput.status   },
      { name: "nutrition" as IntelligenceEngineName, status: nutritionOutput.status },
      { name: "recovery"  as IntelligenceEngineName, status: recoveryOutput.status  },
      { name: "sleep"     as IntelligenceEngineName, status: sleepOutput.status     },
    ]
  ).filter((d) => d.status === "adjusted");

  if (adjustedDomains.length >= 2) {
    conflicts.push({
      id:          `conflict-multiple-adjusted-domains-${idx++}`,
      type:        "multiple-adjusted-domains",
      severity:    "low",
      domains:     adjustedDomains.map((d) => d.name),
      description:
        `${adjustedDomains.length} domains (${adjustedDomains.map((d) => d.name).join(", ")}) are running on ` +
        "partial data. Individual domains can operate, but cross-domain optimisation is limited. " +
        "Completing the missing profile fields will improve overall plan coherence.",
    });
  }

  return conflicts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 7 — Conflict resolution
// ─────────────────────────────────────────────────────────────────────────────

function buildResolutions(
  conflicts: PlannerConflict[],
  input:     PlannerEngineInput,
): PlannerResolution[] {
  const { workoutOutput, nutritionOutput, recoveryOutput, sleepOutput } = input;

  return conflicts.map((conflict): PlannerResolution => {
    switch (conflict.type) {
      case "high-intensity-low-readiness":
        return {
          conflictId:    conflict.id,
          action:
            "Workout task priority capped at medium. Recovery and sleep tasks elevated to high priority.",
          affectedTasks: workoutOutput.tasks.map((t) => t.id),
          reason:
            "When readiness is in the Recover tier, training volume should yield to recovery. " +
            "The session continues but effort should be auto-regulated downward based on how you feel.",
        };

      case "workout-running-recovery-fallback":
        return {
          conflictId:    conflict.id,
          action:
            "Recovery protocols defaulted to basic rest and sleep guidance. Self-assess readiness before training.",
          affectedTasks: recoveryOutput.tasks.map((t) => t.id),
          reason:
            "Recovery data is unavailable — training intensity cannot be validated against actual readiness. " +
            "Complete your recovery profile to align training load with true recovery state.",
        };

      case "sleep-degraded-training-demand":
        return {
          conflictId:    conflict.id,
          action:
            "Wind-down timing is approximate. Sleep consistency takes priority over incremental training gains tonight.",
          affectedTasks: sleepOutput.tasks.map((t) => t.id),
          reason:
            "Sleep timing data is missing — precise scheduling cannot be confirmed. " +
            "Protect sleep as the primary training recovery mechanism.",
        };

      case "nutrition-insufficient-high-training-demand":
        return {
          conflictId:    conflict.id,
          action:
            "Nutrition guidance defaults to balanced eating. Prioritise protein and caloric adequacy around training.",
          affectedTasks: nutritionOutput.tasks.map((t) => t.id),
          reason:
            "Training intensity is high but fuelling targets are not fully personalised. " +
            "Completing your nutrition profile is the highest-leverage action on hard training days.",
        };

      case "multiple-adjusted-domains":
        return {
          conflictId:    conflict.id,
          action:
            "Cross-domain recommendations are conservative. Focus on execution consistency while the profile gaps are addressed.",
          affectedTasks: [],
          reason:
            "Multiple domains are operating on partial data, limiting how well they can be optimised together. " +
            "Each domain still runs, but cross-domain precision is reduced until all profiles are complete.",
        };

      case "multiple-domains-insufficient-data":
        return {
          conflictId:    conflict.id,
          action:
            "Plan conservatism increased across all domains. Focus on execution consistency over prescription specifics.",
          affectedTasks: [],
          reason:
            "Multiple domains lack the critical data needed to personalise their recommendations. " +
            "Completing the missing profile fields is the single highest-leverage action available.",
        };

      default:
        return {
          conflictId:    conflict.id,
          action:        "No automated resolution available — manual review recommended.",
          affectedTasks: [],
          reason:        "Unrecognised conflict type.",
        };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 3 — Priority model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the planner's intended priority level per domain for this day.
 * Rules are applied in priority order; later rules can override earlier ones.
 */
function buildPriorityModel(
  input:     PlannerEngineInput,
  conflicts: PlannerConflict[],
): PlannerPriorityModel {
  const { workoutOutput, recoveryOutput, sleepOutput, nutritionOutput, domainPackets } = input;
  const wp            = domainPackets.workout;
  const readinessTier = recoveryOutput.readinessTier;
  const stressFlag    = recoveryOutput.stressFlag;

  // Neutral baselines
  let workout:   IntelligencePriority = "medium";
  let nutrition: IntelligencePriority = "medium";
  let recovery:  IntelligencePriority = "medium";
  let sleep:     IntelligencePriority = "medium";
  const reasons: string[] = [];

  // Rule: readiness tier drives training and recovery balance
  // Confidence gate: only elevate to "high" when workout data quality is sufficient
  // (confidenceScore ≥ 50). Low confidence means we can't trust the Push signal fully.
  if (readinessTier === "Push" && workoutOutput.status !== "fallback") {
    const workoutConfidenceAdequate = wp.confidenceScore >= 50;
    if (workoutConfidenceAdequate) {
      workout   = "high";
      nutrition = "high";
      reasons.push("Readiness optimal (Push) — training and fuelling elevated to high.");
    } else {
      workout   = "medium";
      nutrition = "medium";
      reasons.push(
        "Readiness indicates Push, but workout confidence is low — training held at medium until data improves."
      );
    }
  } else if (readinessTier === "Recover") {
    workout   = "medium";  // keep visible but don't lead the day
    recovery  = "high";
    sleep     = "high";
    reasons.push("Readiness low (Recover) — recovery and sleep elevated; training de-emphasised.");
  }

  // Rule: stress flag elevates sleep and recovery for cortisol management
  if (stressFlag) {
    recovery = higherOf(recovery, "high");
    sleep    = higherOf(sleep, "high");
    reasons.push("Stress flag active — sleep and recovery elevated for cortisol management.");
  }

  // Rule: sleep fallback — floor sleep at high so it stays prominent
  if (sleepOutput.status === "fallback") {
    sleep = higherOf(sleep, "high");
    reasons.push("Sleep profile incomplete — sleep priority floored at high.");
  }

  // Rule: nutrition fallback — cap at medium (user still needs basic fuelling guidance)
  // "low" would make nutrition tasks invisible; "medium" keeps them visible without overpromising.
  if (nutritionOutput.status === "fallback") {
    nutrition = lowerOf(nutrition, "medium");
    reasons.push("Nutrition data insufficient — nutrition tasks capped at medium for basic fuelling guidance.");
  }

  // Rule: workout fallback — light movement only, don't drive the day
  if (workoutOutput.status === "fallback") {
    workout = lowerOf(workout, "low");
    reasons.push("Workout data insufficient — light movement replaces structured training.");
  }

  // Rule: high-intensity-low-readiness conflict caps workout priority
  const hasIntensityConflict = conflicts.some((c) => c.type === "high-intensity-low-readiness");
  if (hasIntensityConflict) {
    workout  = lowerOf(workout, "medium");
    recovery = higherOf(recovery, "high");
    reasons.push(
      "High-intensity vs low-readiness conflict — workout capped at medium, recovery elevated."
    );
  }

  const reason =
    reasons.length > 0
      ? reasons.join(" ")
      : "Standard priority allocation — all domains within normal operating range.";

  return { workout, nutrition, recovery, sleep, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 3 (cont.) — Apply priority model to tasks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies the planner's priority model to all tasks.
 *
 * Rules:
 *   - "critical" tasks from domain engines are never downgraded.
 *   - Required tasks are never downgraded below "medium".
 *   - "planning" category tasks are left unchanged.
 *   - All other tasks receive the model's per-domain priority.
 */
function applyPriorityModel(
  tasks: IntelligenceTask[],
  model: PlannerPriorityModel,
): IntelligenceTask[] {
  const categoryMap: Partial<Record<string, IntelligencePriority>> = {
    workout:   model.workout,
    nutrition: model.nutrition,
    recovery:  model.recovery,
    sleep:     model.sleep,
  };

  return tasks.map((task) => {
    const modelPriority = categoryMap[task.category];
    if (modelPriority === undefined) return task;   // "planning" or unknown: unchanged
    if (task.priority === "critical") return task;   // never downgrade "critical"

    let finalPriority = modelPriority;

    // Required tasks: floor at "medium"
    if (task.isRequired && PRIORITY_RANK[finalPriority] < PRIORITY_RANK["medium"]) {
      finalPriority = "medium";
    }

    if (finalPriority === task.priority) return task;

    // Planner is overriding the engine's priority — preserve the original in metadata
    return {
      ...task,
      priority: finalPriority,
      metadata: { ...task.metadata, enginePriority: task.priority },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 4 — Task ordering
// ─────────────────────────────────────────────────────────────────────────────

function sortTasksByScheduledTime(tasks: IntelligenceTask[]): IntelligenceTask[] {
  return [...tasks].sort((a, b) => resolveTaskSortKey(a) - resolveTaskSortKey(b));
}

/**
 * Map a task to a sort key (minutes since midnight).
 *
 * Priority order for unscheduled tasks:
 *   1. Morning recovery / hydration     → 7:00 AM
 *   2. Training prep (workout tasks)    → resolved from schedule when available
 *   3. Nutrition (meal spread)          → 7 AM / 12 PM / 3 PM / 7 PM
 *   4. Recovery evening protocols       → 7:00 PM
 *   5. Wind-down                        → 9:00 PM
 *   6. Sleep                            → 10:00 PM
 */
function resolveTaskSortKey(task: IntelligenceTask): number {
  // Planner-resolved scheduledTime takes precedence
  if (task.scheduledTime) {
    return parseTimeMinsLocal(task.scheduledTime);
  }

  // Nutrition: spread across the day by meal index
  if (task.category === "nutrition") {
    if (task.kind === TaskKind.Hydration) return 12 * 60; // noon
    const idParts      = task.id.split("-");
    const idx          = parseInt(idParts[idParts.length - 1], 10);
    const MEAL_BUCKETS = [7 * 60, 12 * 60, 15 * 60, 19 * 60];
    return MEAL_BUCKETS[isFinite(idx) ? idx % MEAL_BUCKETS.length : 0];
  }

  // Recovery: use the typed timeBucket metadata set by recoveryEngine
  if (task.category === "recovery") {
    const bucket = task.metadata?.timeBucket as string | undefined;
    if (bucket === "morning") return 7 * 60;   // 7:00 AM
    if (bucket === "evening") return 19 * 60;  // 7:00 PM
  }

  // Sleep tasks: wind-down before bedtime
  if (task.category === "sleep") {
    if (task.kind === TaskKind.Habit) return 21 * 60;  // 9:00 PM (wind-down)
    if (task.kind === TaskKind.Sleep) return 22 * 60;  // 10:00 PM (sleep)
  }

  return 12 * 60; // noon fallback for anything unclassified
}

function parseTimeMinsLocal(input: string): number {
  const raw    = input.trim().toUpperCase();
  const hasAm  = raw.includes("AM");
  const hasPm  = raw.includes("PM");
  let cleaned  = raw.replace(/[^0-9:]/g, "");
  if (!cleaned.includes(":")) {
    cleaned = cleaned.length <= 2
      ? `${cleaned}:00`
      : `${cleaned.slice(0, 2)}:${cleaned.slice(2)}`;
  }
  const parts = cleaned.split(":");
  if (parts.length !== 2) return 720;
  let h       = parseInt(parts[0], 10);
  const m     = parseInt(parts[1], 10);
  if (!isFinite(h) || !isFinite(m)) return 720;
  if (hasAm || hasPm) {
    if (hasAm && h === 12) h = 0;
    if (hasPm && h !== 12) h += 12;
  }
  return h * 60 + m;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 5 — Schedule blocks
// ─────────────────────────────────────────────────────────────────────────────

type BucketKey = "morning" | "midday" | "afternoon" | "evening" | "night";

const BUCKET_META: readonly {
  key:           BucketKey;
  title:         string;
  minMins:       number;
  maxMins:       number;
  suggestedTime: string;
  reason:        string;
}[] = [
  {
    key:           "morning",
    title:         "Morning",
    minMins:       0,
    maxMins:       12 * 60,
    suggestedTime: "7:00 AM",
    reason:        "Start your day with hydration, morning protocols, and training preparation.",
  },
  {
    key:           "midday",
    title:         "Midday",
    minMins:       12 * 60,
    maxMins:       15 * 60,
    suggestedTime: "12:00 PM",
    reason:        "Keep nutrition and hydration on track through the middle of the day.",
  },
  {
    key:           "afternoon",
    title:         "Afternoon",
    minMins:       15 * 60,
    maxMins:       18 * 60,
    suggestedTime: "3:00 PM",
    reason:        "Your main training window and post-workout nutrition or recovery work.",
  },
  {
    key:           "evening",
    title:         "Evening",
    minMins:       18 * 60,
    maxMins:       22 * 60,
    suggestedTime: "7:00 PM",
    reason:        "Recovery protocols and evening nutrition to close out the training day.",
  },
  {
    key:           "night",
    title:         "Night",
    minMins:       22 * 60,
    maxMins:       24 * 60,
    suggestedTime: "10:00 PM",
    reason:        "Wind-down and sleep. Protect this block — it is when your body recovers.",
  },
] as const;

function buildScheduleBlocks(orderedTasks: IntelligenceTask[]): PlannerScheduleBlock[] {
  // Bucket tasks by sort key
  const buckets: Record<BucketKey, IntelligenceTask[]> = {
    morning:   [],
    midday:    [],
    afternoon: [],
    evening:   [],
    night:     [],
  };

  for (const task of orderedTasks) {
    const sortKey = resolveTaskSortKey(task);
    const meta    = BUCKET_META.find((b) => sortKey >= b.minMins && sortKey < b.maxMins);
    if (meta) {
      buckets[meta.key].push(task);
    } else {
      buckets.night.push(task); // overflow → night (past midnight)
    }
  }

  const blocks: PlannerScheduleBlock[] = [];

  for (const meta of BUCKET_META) {
    const tasks = buckets[meta.key];
    if (tasks.length === 0) continue;

    // Sum estimated minutes (tasks with no duration contribute 0)
    const totalMins = tasks.reduce((sum, t) => sum + (t.estimatedMinutes ?? 0), 0);

    // Highest priority in this block
    let blockPriority: IntelligencePriority = "low";
    for (const t of tasks) {
      if (PRIORITY_RANK[t.priority] > PRIORITY_RANK[blockPriority]) {
        blockPriority = t.priority;
      }
    }

    // Dominant category — most frequent; "mixed" when multiple categories share the block
    const categoryFreq: Record<string, number> = {};
    for (const t of tasks) {
      categoryFreq[t.category] = (categoryFreq[t.category] ?? 0) + 1;
    }
    const uniqueCategories = Object.keys(categoryFreq);
    const isMixed          = uniqueCategories.length > 1;
    const dominantCategory = uniqueCategories
      .sort((a, b) => (categoryFreq[b] ?? 0) - (categoryFreq[a] ?? 0))[0];

    // Prefer the first task's scheduledTime over the bucket default
    const firstScheduled = tasks.find((t) => t.scheduledTime);
    const suggestedTime  = firstScheduled?.scheduledTime ?? meta.suggestedTime;

    blocks.push({
      id:               `block-${meta.key}`,
      title:            meta.title,
      category:         (isMixed ? "mixed" : dominantCategory) as PlannerScheduleBlock["category"],
      tasks,
      estimatedMinutes: totalMins,
      suggestedTime,
      priority:         blockPriority,
      reason:           meta.reason,
    });
  }

  return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy — day coaching priorities (backward compat)
// ─────────────────────────────────────────────────────────────────────────────

function deriveDayPriorities(
  normalizedInput: NormalizedIntelligenceInput,
  stressFlag:      boolean,
): string[] {
  const { decisions, confidenceLevel } = normalizedInput;
  const priorities: string[] = [];

  if (decisions.recoveryPriority === "high") {
    priorities.push("Prioritise recovery protocols today — your body needs restoration.");
  }
  if (stressFlag) {
    priorities.push(
      "Cortisol is elevated — breathing protocols and early wind-down are non-negotiable."
    );
  }
  priorities.push(decisions.focus);
  priorities.push(decisions.nutritionStrategy);
  if (confidenceLevel === "low") {
    priorities.push(
      "Your profile has missing data — completing it will sharpen this plan significantly."
    );
  }

  return priorities.slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Planner-level adaptation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply structural adaptation effects to the final ordered task list.
 *
 * This is the ONLY place where adaptation causes structural plan changes:
 *   1. enforceRecoveryBias  — elevate recovery/sleep tasks to at least "high" priority
 *   2. capIntensity         — cap workout task priority
 *   3. workout.capPriority  — cap workout task priority (from workout signal)
 *   4. reduceTaskCount      — remove optional low-priority tasks (conservative cap)
 *   5. simplifyStructure    — additionally remove optional medium-priority tasks
 *
 * Safety rules (always enforced):
 *   - Required tasks (isRequired: true) are NEVER removed.
 *   - High/critical optional tasks are NEVER removed.
 *   - Total removal is capped at REMOVE_CAP to prevent over-simplification.
 *   - When no effects are active, tasks are returned unchanged.
 *
 * @param tasks  — Ordered IntelligenceTask[] from setTaskStatuses.
 * @param effect — Merged AdaptationEffect. Empty → no changes.
 * @returns      — { finalTasks, adaptationNotes }
 */
function applyAdaptationToTasks(
  tasks:  IntelligenceTask[],
  effect: AdaptationEffect,
): { finalTasks: IntelligenceTask[]; adaptationNotes: string[] } {
  // Guard: no-op when no planner or workout effects are active
  const hasPlanner = Boolean(effect.planner);
  const hasPriorityCap =
    Boolean(effect.workout?.capPriority) || Boolean(effect.planner?.capIntensity);
  if (!hasPlanner && !hasPriorityCap) {
    return { finalTasks: tasks, adaptationNotes: [] };
  }

  const notes: string[] = [];
  let result = [...tasks];

  // ── 1. Enforce recovery bias ──────────────────────────────────────────────
  if (effect.planner?.enforceRecoveryBias) {
    result = result.map((t) => {
      if ((t.category === "recovery" || t.category === "sleep") &&
          PRIORITY_RANK[t.priority] < PRIORITY_RANK["high"]) {
        return {
          ...t,
          priority: "high" as IntelligencePriority,
          status:   "adjusted" as IntelligenceTaskStatus,
          metadata: {
            ...t.metadata,
            enginePriority:  t.metadata?.enginePriority ?? t.priority,
            adaptationNote:  "Recovery bias enforced — recent soreness or stress signals.",
          },
        };
      }
      return t;
    });
    notes.push("Recovery and sleep task priorities elevated (recovery bias enforced due to recent signals).");
  }

  // ── 2. Cap workout task priority ──────────────────────────────────────────
  // Use the safer of workout.capPriority and planner.capIntensity
  const workoutCap = saferCap(
    effect.workout?.capPriority,
    effect.planner?.capIntensity,
  );
  if (workoutCap) {
    result = result.map((t) => {
      if (t.category === "workout" &&
          t.priority !== "critical" &&
          PRIORITY_RANK[t.priority] > PRIORITY_RANK[workoutCap]) {
        return {
          ...t,
          priority: workoutCap,
          status:   "adjusted" as IntelligenceTaskStatus,
          metadata: {
            ...t.metadata,
            enginePriority: t.metadata?.enginePriority ?? t.priority,
            adaptationNote: `Workout priority capped at ${workoutCap} (adaptation: load reduction signal).`,
          },
        };
      }
      return t;
    });
    notes.push(`Workout task priority capped at "${workoutCap}" (adaptation: reduce training load signal).`);
  }

  // ── 3. Remove optional tasks to reduce cognitive load ─────────────────────
  // reduceTaskCount → remove optional "low" priority tasks (up to REDUCE_CAP)
  // simplifyStructure → additionally remove optional "medium" priority tasks
  const REDUCE_CAP = 3 as const;
  let removed = 0;

  if (effect.planner?.reduceTaskCount && removed < REDUCE_CAP) {
    const candidatesLow = result.filter(
      (t) => !t.isRequired && t.priority === "low"
    );
    const toRemove = candidatesLow.slice(0, REDUCE_CAP - removed);
    if (toRemove.length > 0) {
      const ids = new Set(toRemove.map((t) => t.id));
      result  = result.filter((t) => !ids.has(t.id));
      removed += toRemove.length;
      notes.push(`Plan simplified: ${toRemove.length} optional low-priority task(s) removed to reduce cognitive load.`);
    }
  }

  if (effect.planner?.simplifyStructure && removed < REDUCE_CAP) {
    const candidatesMedium = result.filter(
      (t) => !t.isRequired && t.priority === "medium"
    );
    // Conservative: remove at most 1 medium optional task
    const toRemove = candidatesMedium.slice(0, Math.min(1, REDUCE_CAP - removed));
    if (toRemove.length > 0) {
      const ids = new Set(toRemove.map((t) => t.id));
      result  = result.filter((t) => !ids.has(t.id));
      removed += toRemove.length;
      notes.push(`Plan further simplified: ${toRemove.length} optional medium-priority task(s) removed (simplifyStructure active).`);
    }
  }

  return { finalTasks: result, adaptationNotes: notes };
}

/** Return the safer (more conservative/lower) of two priority cap values. */
function saferCap(
  a: "low" | "medium" | undefined,
  b: "low" | "medium" | undefined,
): "low" | "medium" | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (a === "low" || b === "low") ? "low" : "medium";
}

// ─────────────────────────────────────────────────────────────────────────────
// Task status assignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stamps IntelligenceTaskStatus onto every task in the final ordered list.
 *
 * Rules (evaluated in priority order):
 *   1. Planner override (metadata.enginePriority set)  → "adjusted"
 *   2. Source engine ran in fallback mode               → "fallback"
 *   3. Source engine ran in adjusted mode               → "adjusted"
 *   4. Otherwise                                        → "planned"
 *
 * Domain engines do not set task.status — this is the single call site.
 */
function setTaskStatuses(
  tasks:           IntelligenceTask[],
  workoutStatus:   EngineOutputStatus,
  nutritionStatus: EngineOutputStatus,
  recoveryStatus:  EngineOutputStatus,
  sleepStatus:     EngineOutputStatus,
): IntelligenceTask[] {
  const engineStatusMap: Partial<Record<string, EngineOutputStatus>> = {
    workout:   workoutStatus,
    nutrition: nutritionStatus,
    recovery:  recoveryStatus,
    sleep:     sleepStatus,
  };

  return tasks.map((task): IntelligenceTask => {
    // Already has a status — respect it (e.g. explicitly set by a future engine)
    if (task.status !== undefined) return task;

    // Planner overrode this task's priority → adjusted
    if (task.metadata?.enginePriority !== undefined) {
      return { ...task, status: "adjusted" as IntelligenceTaskStatus };
    }

    // Inherit from source engine status
    const engineStatus = engineStatusMap[task.sourceEngine];
    if (engineStatus === "fallback") return { ...task, status: "fallback" as IntelligenceTaskStatus };
    if (engineStatus === "adjusted") return { ...task, status: "adjusted" as IntelligenceTaskStatus };

    return { ...task, status: "planned" as IntelligenceTaskStatus };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main engine function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the Planner Engine.
 *
 * Must be called LAST — depends on all domain engine outputs.
 *
 * Deterministic. Never throws. Never mutates inputs. Never sets scheduledTime
 * on tasks other than through this function.
 */
export function runPlannerEngine(input: PlannerEngineInput): PlannerEngineOutput {
  const {
    normalizedInput,
    domainPackets,
    workoutOutput,
    nutritionOutput,
    recoveryOutput,
    sleepOutput,
    adaptationEffect = {},
  } = input;

  const { workout: wp, nutrition: np, recovery: rp, sleep: sp } = domainPackets;
  const { profile, decisions } = normalizedInput;
  const notes: string[] = [];

  // ── Generate the authoritative schedule ───────────────────────────────────
  // generateSchedule is called HERE and nowhere else in the intelligence system.
  const scheduleReasoning: string[] = [];
  const schedule = generateSchedule(
    profile,
    workoutOutput.plan,
    recoveryOutput.plan,
    decisions,
    scheduleReasoning,
  );
  notes.push(...scheduleReasoning);

  // ── Resolve scheduledTime on time-anchored tasks (PLANNER OWNERSHIP RULE) ─
  const resolvedWorkoutTasks: IntelligenceTask[] = workoutOutput.tasks.map((t) =>
    t.kind === TaskKind.Workout ? { ...t, scheduledTime: schedule.workoutTimeText } : t
  );

  const resolvedSleepTasks: IntelligenceTask[] = sleepOutput.tasks.map((t) => {
    if (t.title.startsWith("Wind-down")) return { ...t, scheduledTime: schedule.windDownTimeText };
    if (t.kind === TaskKind.Sleep)        return { ...t, scheduledTime: sleepOutput.bedtimeText };
    return t;
  });

  // ── Conflict detection (Task 6) ───────────────────────────────────────────
  const conflicts   = detectConflicts(input);
  const resolutions = buildResolutions(conflicts, input);

  // ── Planner status (Task 8) ───────────────────────────────────────────────
  const status = deriveStatus(wp, np, rp, sp, conflicts);

  // ── Priority model (Task 3) ───────────────────────────────────────────────
  const priorityModel = buildPriorityModel(input, conflicts);

  // ── Merge, priority-adjust, and order tasks (Tasks 3 + 4) ─────────────────
  const mergedTasks   = [
    ...resolvedWorkoutTasks,
    ...nutritionOutput.tasks,
    ...recoveryOutput.tasks,
    ...resolvedSleepTasks,
  ];
  const adjustedTasks = applyPriorityModel(mergedTasks, priorityModel);
  const sortedTasks   = sortTasksByScheduledTime(adjustedTasks);
  const statusedTasks = setTaskStatuses(
    sortedTasks,
    workoutOutput.status,
    nutritionOutput.status,
    recoveryOutput.status,
    sleepOutput.status,
  );

  // ── Phase 5: adaptation structural adjustments ────────────────────────────
  // Applied AFTER status stamping so adaptation-modified tasks get status "adjusted".
  const { finalTasks: orderedTasks, adaptationNotes } = applyAdaptationToTasks(
    statusedTasks,
    adaptationEffect,
  );
  notes.push(...adaptationNotes);

  // ── Schedule blocks (Task 5) ──────────────────────────────────────────────
  // Rebuilt from finalTasks so blocks reflect any adaptation-driven task removals.
  const scheduleBlocks = buildScheduleBlocks(orderedTasks);

  // ── Daily focus and summary (Tasks 1 + 2) ────────────────────────────────
  const dailyFocus = buildDailyFocus(input);
  const summary    = buildDailySummary(input, status, conflicts);

  // ── Legacy coaching priorities (backward compat) ──────────────────────────
  const priorities = deriveDayPriorities(normalizedInput, recoveryOutput.stressFlag);
  notes.push(`Day priorities: ${priorities.join(" → ")}`);

  // ── Planner metadata (Task 9) ─────────────────────────────────────────────
  const plannerMetadata: PlannerMetadata = {
    plannerVersion:            PLANNER_ENGINE_VERSION,
    deterministic:             true,
    domainStates: {
      workout:   {
        canRun:          wp.canRun,
        degraded:        wp.degradedMode,
        confidenceScore: wp.confidenceScore,
        status:          workoutOutput.status,
      },
      nutrition: {
        canRun:          np.canRun,
        degraded:        np.degradedMode,
        confidenceScore: np.confidenceScore,
        status:          nutritionOutput.status,
      },
      recovery:  {
        canRun:          rp.canRun,
        degraded:        rp.degradedMode,
        confidenceScore: rp.confidenceScore,
        status:          recoveryOutput.status,
      },
      sleep:     {
        canRun:          sp.canRun,
        degraded:        sp.degradedMode,
        confidenceScore: sp.confidenceScore,
        status:          sleepOutput.status,
      },
    },
    conflictCount:             conflicts.length,
    highSeverityConflictCount: conflicts.filter((c) => c.severity === "high").length,
    scheduleBlockCount:        scheduleBlocks.length,
    generatedFromPackets:      true,
  };

  const adaptationActive = adaptationNotes.length > 0;
  notes.push(
    `[planner] status: ${status} | tasks: ${orderedTasks.length} | blocks: ${scheduleBlocks.length} | ` +
    `conflicts: ${conflicts.length} (high: ${plannerMetadata.highSeverityConflictCount}) | ` +
    `adaptation: ${adaptationActive ? `active (${adaptationNotes.length} change(s))` : "inactive"} | ` +
    `workout at: ${schedule.workoutTimeText} | wind-down at: ${schedule.windDownTimeText} | ` +
    `domain canRun: workout=${wp.canRun} nutrition=${np.canRun} recovery=${rp.canRun} sleep=${sp.canRun} | ` +
    `domain confidence: workout=${wp.confidenceScore} nutrition=${np.confidenceScore} ` +
    `recovery=${rp.confidenceScore} sleep=${sp.confidenceScore}.`
  );

  return {
    engine:          "planner",
    status,
    dailyFocus,
    summary,
    focus:           decisions.focus,    // backward compat
    priorities,
    tasks:           orderedTasks,
    scheduleBlocks,
    conflicts,
    resolutions,
    priorityModel,
    schedule,
    notes,
    plannerMetadata,
  };
}
