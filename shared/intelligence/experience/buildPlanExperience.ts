/**
 * shared/intelligence/experience/buildPlanExperience.ts
 *
 * Phase 6 Prompt #3 — Output Experience & Humanization Layer.
 *
 * Takes the final assembled plan state and produces enhanced presentation fields:
 *   summary               — coaching-voice plan overview (replaces planner structural summary)
 *   priorities            — task-tied coaching statements (replaces planner generic priorities)
 *   confidenceExplanation — human-readable confidence context
 *   tasks                 — original fields preserved; benefit + executionHint added
 *
 * ─── Invariants ──────────────────────────────────────────────────────────────
 *
 * - NEVER changes task count, order, id, priority, status, or scheduledTime
 * - NEVER re-runs engine, planner, or data flow logic
 * - Deterministic: same input → same output, always
 * - No randomness, no external calls, no async, no mutation of input
 *
 * ─── Separation from the planner ─────────────────────────────────────────────
 *
 * The planner produces structural summaries / priorities optimised for logic
 * correctness. This layer produces the user-facing equivalents optimised for
 * experience. Both are preserved in the final plan:
 *
 *   plan.summary   / plan.priorities            → experience layer (canonical for UI)
 *   plan.planner.summary / plan.planner.priorities → planner output (for debugging)
 */

import type {
  IntelligenceTask,
  AdaptationEffect,
} from "../types";
import type { EngineOutputStatus } from "../types";
import type { ConfidenceLevel, ReadinessTier } from "../../planner/generateDailyPlan";
import { TaskKind } from "../../planner/types";

// ─────────────────────────────────────────────────────────────────────────────
// Context and output types
// ─────────────────────────────────────────────────────────────────────────────

/** All context needed to produce the experience layer. Passed by the orchestrator. */
export type PlanExperienceContext = {
  /** Confidence level after degraded-mode cap has been applied. */
  confidenceLevel:     ConfidenceLevel;
  /** True when one or more domains are running on insufficient data. */
  degradedMode:        boolean;
  /** Planner status — "optimal" | "adjusted" | "fallback". */
  plannerStatus:       EngineOutputStatus;
  /** Recovery readiness tier: Push | Maintain | Recover. */
  readinessTier:       ReadinessTier;
  /** True when stress signal is elevated in the recovery engine. */
  stressFlag:          boolean;
  /** Merged adaptation effect bundle (may be empty object when no adaptation). */
  adaptationEffect:    AdaptationEffect;
  /** True when at least one adaptation effect was applied to the plan. */
  adaptationApplied:   boolean;
  /** Final ordered task list from the planner + learning layer. */
  tasks:               IntelligenceTask[];
  /** Workout split name as produced by the workout engine (e.g. "upper_body"). */
  workoutSplit:        string;
  /** Workout session duration in minutes as produced by the workout engine. */
  workoutDurationMins: number;
};

/** Fields produced by the experience layer. */
export type PlanExperienceOutput = {
  summary:               string;
  priorities:            string[];
  confidenceExplanation: string;
  tasks:                 IntelligenceTask[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the experience and humanization layer for a fully assembled plan.
 *
 * @param ctx — PlanExperienceContext assembled by the orchestrator.
 * @returns   — PlanExperienceOutput with enhanced summary, priorities, explanation, and tasks.
 */
export function buildPlanExperience(ctx: PlanExperienceContext): PlanExperienceOutput {
  return {
    summary:               buildEnhancedSummary(ctx),
    priorities:            buildCoachingPriorities(ctx),
    confidenceExplanation: buildConfidenceExplanation(ctx),
    tasks:                 ctx.tasks.map((t) => applyExperienceToTask(t, ctx)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces a coaching-voice plan summary.
 * Explains WHAT the day is focused on and WHY, personalised to plan state.
 * Tone adjusts for degraded mode, adaptation, readiness tier, and confidence.
 */
function buildEnhancedSummary(ctx: PlanExperienceContext): string {
  const {
    confidenceLevel, degradedMode, plannerStatus,
    readinessTier, stressFlag, adaptationApplied, adaptationEffect: ae,
  } = ctx;

  // ── Degraded / fallback — supportive, consistency-first ─────────────────────
  if (plannerStatus === "fallback" || degradedMode) {
    return (
      "Today is a simplified plan based on limited data. " +
      "Focus on consistency and completing the core habits — " +
      "each one you complete helps rebuild a stronger, more personalised baseline."
    );
  }

  // ── Adaptation applied — acknowledge what changed ────────────────────────────
  if (adaptationApplied) {
    if (ae.planner?.enforceRecoveryBias || ae.recovery?.increasePriority) {
      return (
        "Today is a recovery-first day. Recent patterns show your body is under load — " +
        "recovery and sleep take priority over training intensity to rebuild your baseline."
      );
    }
    if (ae.workout?.reduceVolume || ae.workout?.reduceIntensity) {
      return readinessTier === "Recover"
        ? (
          "Today's plan is adjusted for recovery. Recent signals suggest your body needs restoration — " +
          "training volume and intensity are reduced to support your readiness for tomorrow."
        )
        : (
          "Today's plan is adapted based on recent feedback. Training load is reduced while keeping " +
          "all key habits in place — consistency and recovery are the priorities."
        );
    }
    if (ae.sleep?.increaseSleepTarget || ae.sleep?.enforceWindDown) {
      return (
        "Today's focus extends into your evening. Recent sleep patterns indicate you need more recovery time — " +
        "your wind-down and sleep targets have been extended to help rebuild consistency."
      );
    }
  }

  // ── Standard paths: confidence level × readiness tier ────────────────────────

  if (confidenceLevel === "high") {
    if (readinessTier === "Push") {
      return (
        "Today is built for performance. Your recovery signals are strong, " +
        "so we're pushing intensity while maintaining balance across training, nutrition, and recovery."
      );
    }
    if (readinessTier === "Recover") {
      return (
        "Today prioritises recovery. Your signals indicate your body needs restoration — " +
        "the plan is structured to support full recovery while keeping your habits consistent."
      );
    }
    // Maintain
    const stressLine = stressFlag
      ? " Stress management and wind-down are non-negotiable priorities tonight."
      : "";
    return (
      "Today is a balanced performance day. Your readiness is solid — " +
      `the plan maintains training quality, consistent nutrition, and active recovery.${stressLine}`
    );
  }

  if (confidenceLevel === "medium") {
    if (readinessTier === "Recover") {
      return (
        "Today's plan is built conservatively. Recovery signals are elevated and some profile data is partial — " +
        "the focus is on consistent habits and protecting your readiness for the days ahead."
      );
    }
    const stressLine = stressFlag ? " Manage stress actively and protect your sleep tonight." : "";
    return (
      "Today's plan is moderately personalised. Some profile data is estimated, so the prescription is conservative — " +
      `follow the structure and complete the missing data to sharpen future plans.${stressLine}`
    );
  }

  // Low confidence
  return (
    "Today's plan uses safe defaults based on limited profile data. " +
    "Complete your profile to unlock a fully personalised plan — " +
    "for now, focus on the core habits and build momentum from there."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Coaching priorities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts the plan's task composition into 3–5 short, actionable coaching statements.
 * Tied to actual tasks in the plan. Tone adjusts for degraded mode and adaptation.
 */
function buildCoachingPriorities(ctx: PlanExperienceContext): string[] {
  const {
    tasks, adaptationEffect: ae, adaptationApplied,
    degradedMode, readinessTier, workoutSplit,
  } = ctx;

  const priorities: string[] = [];

  const workoutTask    = tasks.find(
    (t) => t.category === "workout" && t.kind === TaskKind.Workout && t.priority !== "low",
  );
  const recoveryTasks  = tasks.filter((t) => t.category === "recovery");
  const highRecovery   = recoveryTasks.some(
    (t) => t.priority === "high" || t.priority === "critical",
  );
  const nutritionMeals = tasks.filter(
    (t) => t.category === "nutrition" && t.kind === TaskKind.Nutrition,
  );
  const sleepTask = tasks.find(
    (t) => t.category === "sleep" && t.kind === TaskKind.Sleep,
  );

  // ── Degraded mode — consistency-only priorities ──────────────────────────────
  if (degradedMode) {
    priorities.push(
      "Focus on consistency today — completing your core habits is the highest-value action.",
    );
    if (sleepTask) {
      priorities.push(
        "Protect your sleep window tonight — quality sleep is your most important recovery tool.",
      );
    }
    if (recoveryTasks.length > 0) {
      priorities.push(
        "Work through the recovery protocols — they will help stabilise your baseline.",
      );
    }
    return priorities.slice(0, 5);
  }

  // ── Workout coaching line ─────────────────────────────────────────────────────
  if (workoutTask) {
    const split = workoutSplit.replace(/_/g, " ");
    if (ae.workout?.reduceVolume || ae.workout?.reduceIntensity) {
      priorities.push(
        `Complete your ${split} session at a reduced load — your body signals a need for managed effort today.`,
      );
    } else if (readinessTier === "Push") {
      priorities.push(
        `Push your ${split} session with full intent — your recovery signals are strong and today is a high-output opportunity.`,
      );
    } else if (readinessTier === "Recover") {
      priorities.push(
        `Complete your ${split} session at reduced intensity — recovery takes precedence over training load today.`,
      );
    } else {
      priorities.push(
        `Execute your ${split} session with consistent effort — this is your main performance driver today.`,
      );
    }
  }

  // ── Recovery coaching line ────────────────────────────────────────────────────
  if (
    highRecovery ||
    ae.planner?.enforceRecoveryBias ||
    ae.recovery?.increasePriority
  ) {
    priorities.push(
      adaptationApplied && ae.recovery?.increasePriority
        ? "Prioritise your recovery protocols today — recent patterns show your body needs extra restoration."
        : "Complete all recovery protocols — they directly build your readiness for tomorrow.",
    );
  }

  // ── Nutrition coaching line ───────────────────────────────────────────────────
  if (nutritionMeals.length > 0) {
    if (adaptationApplied && ae.nutrition?.increaseProteinFocus) {
      priorities.push(
        "Hit your protein target first — it is the highest-leverage nutritional action on a training day.",
      );
    } else {
      priorities.push(
        "Stay on top of your nutrition schedule — consistent fuelling supports both performance and recovery.",
      );
    }
  }

  // ── Sleep coaching line ───────────────────────────────────────────────────────
  if (sleepTask) {
    if (adaptationApplied && (ae.sleep?.increaseSleepTarget || ae.sleep?.enforceWindDown)) {
      priorities.push(
        "Protect your extended sleep window tonight — recent patterns show additional recovery time is needed.",
      );
    } else {
      priorities.push(
        "Honour your sleep schedule — quality sleep is where your training adaptations happen.",
      );
    }
  }

  return priorities.slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence explanation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces a single sentence explaining confidence level and what the user
 * can do to improve it. Always present; never technical jargon.
 */
function buildConfidenceExplanation(ctx: PlanExperienceContext): string {
  const { confidenceLevel, degradedMode } = ctx;

  if (degradedMode) {
    return (
      "Low confidence — one or more domains are operating on incomplete data. " +
      "The plan uses safe defaults and conservative prescriptions. " +
      "Completing your profile will unlock more precise recommendations."
    );
  }

  switch (confidenceLevel) {
    case "high":
      return (
        "High confidence — your profile is complete and signals are consistent. " +
        "Prescriptions are fully personalised."
      );
    case "medium":
      return (
        "Moderate confidence — some profile data is partial or estimated. " +
        "Prescriptions are conservative. Adding the missing data will improve precision."
      );
    case "low":
    default:
      return (
        "Low confidence — profile data is incomplete or missing. " +
        "Plan uses safe defaults. Completing your profile is the highest-leverage action."
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task experience fields
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the task with `description`, `benefit`, and `executionHint` populated.
 * Existing task fields (id, title, priority, status, scheduledTime, etc.) are
 * never modified. Task count and order are never changed.
 */
function applyExperienceToTask(
  task: IntelligenceTask,
  ctx:  PlanExperienceContext,
): IntelligenceTask {
  const { description, benefit, executionHint } = deriveTaskExperience(task, ctx);
  return { ...task, description, benefit, executionHint };
}

type TaskExperience = { description: string; benefit: string; executionHint: string };

/**
 * Derive experience fields for a single task based on kind, category, and plan context.
 * Deterministic: same task + same context → same strings, always.
 */
function deriveTaskExperience(task: IntelligenceTask, ctx: PlanExperienceContext): TaskExperience {
  switch (task.kind) {
    case TaskKind.Workout:   return deriveWorkoutExperience(task, ctx);
    case TaskKind.Mobility:  return deriveMobilityExperience();
    case TaskKind.Nutrition: return deriveMealExperience(task, ctx.adaptationEffect);
    case TaskKind.Hydration: return deriveHydrationExperience();
    case TaskKind.Recovery: return deriveRecoveryExperience(ctx.adaptationEffect);
    case TaskKind.Habit:    return deriveWindDownExperience();
    case TaskKind.Sleep:    return deriveSleepExperience(task, ctx.adaptationEffect);
    default:                return deriveDefaultExperience(task);
  }
}

// ── Workout ───────────────────────────────────────────────────────────────────

function deriveWorkoutExperience(task: IntelligenceTask, ctx: PlanExperienceContext): TaskExperience {
  const { readinessTier, adaptationEffect: ae, workoutSplit, workoutDurationMins } = ctx;
  const split = workoutSplit.replace(/_/g, " ");

  let description: string;
  let executionHint: string;

  if (ae.workout?.reduceVolume) {
    description  = `A ${split} session at reduced volume — training load is managed today based on recent feedback.`;
    executionHint = "Train lighter than usual. Stop a couple of reps short of failure and honour the reduced set count — adaptation happens during recovery.";
  } else if (ae.workout?.reduceIntensity) {
    description  = `A ${split} session at reduced intensity — effort is moderated based on recent recovery signals.`;
    executionHint = "Back off intensity from your normal working loads. Consistent movement at a lower effort is the goal today.";
  } else if (readinessTier === "Recover") {
    description  = `A ${split} session (${workoutDurationMins} min) — intensity is moderated to respect your recovery state. Showing up consistently matters more than the load.`;
    executionHint = "Auto-regulate based on how you feel. If movement quality drops, reduce the load. Consistency over output today.";
  } else if (readinessTier === "Push") {
    description  = `A ${split} session (${workoutDurationMins} min) — your primary training block for today. Recovery signals are strong and this is a high-output opportunity.`;
    executionHint = "Push your working sets with intent. Track loads so you can progress next session. Prioritise form on every rep.";
  } else {
    description  = `A ${split} session (${workoutDurationMins} min) — your main performance driver today, prescribed based on your goals and current readiness.`;
    executionHint = "Stay controlled on each rep and prioritise form over load. Finish your sets with intent and log your numbers.";
  }

  const benefit = "Drives strength adaptation, supports your training goal, and builds the consistency that compounds across weeks and months.";

  return { description, benefit, executionHint };
}

// ── Mobility / fallback movement ─────────────────────────────────────────────

function deriveMobilityExperience(): TaskExperience {
  return {
    description:   "A gentle movement session to keep you active and mobile today.",
    benefit:       "Maintains blood flow, joint health, and readiness without adding training stress.",
    executionHint: "Keep effort comfortable — this is active rest, not structured training. Focus on how you feel.",
  };
}

// ── Meal ─────────────────────────────────────────────────────────────────────

function deriveMealExperience(task: IntelligenceTask, ae: AdaptationEffect): TaskExperience {
  const title = task.title.toLowerCase();

  let description: string;
  if (title.includes("breakfast")) {
    description = "Your breakfast — the first fuelling opportunity to set your energy and nutrient foundation for the day.";
  } else if (title.includes("lunch")) {
    description = "Your lunch — mid-day fuelling to maintain energy and support ongoing recovery from training.";
  } else if (title.includes("dinner")) {
    description = "Your dinner — your main evening meal to replenish glycogen and deliver recovery nutrients overnight.";
  } else if (title.includes("snack")) {
    description = "A planned snack to bridge your energy between main meals and support consistent fuelling.";
  } else {
    description = "A planned meal to deliver consistent energy and nutrients throughout your day.";
  }

  const benefit = ae.nutrition?.increaseProteinFocus
    ? "Protein-forward fuelling supports muscle repair, controls hunger, and directly drives training adaptation."
    : "Consistent meals maintain energy, support muscle repair, and prevent the hunger-driven choices that disrupt nutrition targets.";

  let executionHint: string;
  if (ae.nutrition?.increaseProteinFocus) {
    executionHint = "Build this meal around a quality protein source first — hit your protein target before managing total calories.";
  } else if (ae.nutrition?.simplifyPlan) {
    executionHint = "Keep this meal simple — a quality protein source, vegetables, and a whole-food carbohydrate is enough.";
  } else {
    executionHint = "Eat without screens and chew slowly. A calm, focused meal improves digestion and nutrient absorption.";
  }

  return { description, benefit, executionHint };
}

// ── Hydration ─────────────────────────────────────────────────────────────────

function deriveHydrationExperience(): TaskExperience {
  return {
    description:   "Daily hydration target — spread consistently throughout the day, not consumed all at once.",
    benefit:       "Proper hydration improves physical performance, mental focus, and speeds up recovery between sessions.",
    executionHint: "Keep a water bottle visible and drink consistently before you feel thirsty — thirst is a lag indicator.",
  };
}

// ── Recovery ─────────────────────────────────────────────────────────────────

function deriveRecoveryExperience(ae: AdaptationEffect): TaskExperience {
  const isElevated = ae.recovery?.increasePriority || ae.planner?.enforceRecoveryBias;

  const description = isElevated
    ? "A structured recovery protocol — elevated to high priority today based on recent stress and readiness signals. This is a high-impact session, not optional maintenance."
    : "A structured recovery protocol to reduce soreness and rebuild readiness for your next training session.";

  return {
    description,
    benefit:       "Consistent recovery work accelerates adaptation, reduces injury risk, and maintains the readiness you need to train effectively day after day.",
    executionHint: "Follow the protocol fully and in order. Quality of execution matters more than speed — this is an investment in tomorrow's performance.",
  };
}

// ── Wind-down habit ───────────────────────────────────────────────────────────

function deriveWindDownExperience(): TaskExperience {
  return {
    description:   "A pre-sleep wind-down routine to ease your nervous system into rest mode and improve sleep onset.",
    benefit:       "A consistent wind-down improves sleep quality, reduces time to fall asleep, and directly shapes tomorrow's readiness.",
    executionHint: "Dim lights, avoid screens, and allow 20–30 minutes for your system to decelerate. Treat this as a non-negotiable transition.",
  };
}

// ── Sleep ─────────────────────────────────────────────────────────────────────

function deriveSleepExperience(task: IntelligenceTask, ae: AdaptationEffect): TaskExperience {
  const isExtended = ae.sleep?.increaseSleepTarget;
  const targetHrs  = typeof task.metadata?.sleepTargetHrs === "number"
    ? (task.metadata.sleepTargetHrs as number)
    : null;

  let description: string;
  if (isExtended && targetHrs !== null) {
    description = `Your sleep window — extended to ${targetHrs}h based on recent sleep consistency data. This is your most powerful recovery tool and it needs protecting tonight.`;
  } else if (targetHrs !== null) {
    description = `Your sleep window — targeting ${targetHrs}h to fully support recovery and adaptation from today's training load.`;
  } else {
    description = "Your sleep window — the most powerful recovery and adaptation mechanism in your entire plan.";
  }

  return {
    description,
    benefit:       "Quality sleep is where muscles repair, hormones reset, and neural adaptations consolidate. It directly determines tomorrow's readiness and performance ceiling.",
    executionHint: "Aim to be in bed at the scheduled time. Keep your room cool and dark, avoid caffeine after 2pm, and protect the last 30 minutes before bed from screens.",
  };
}

// ── Default fallback ──────────────────────────────────────────────────────────

function deriveDefaultExperience(task: IntelligenceTask): TaskExperience {
  return {
    description:   `${task.title} — part of your structured plan for today.`,
    benefit:       "Contributes to your overall consistency and daily momentum.",
    executionHint: "Complete this task as scheduled and mark it done when finished.",
  };
}
