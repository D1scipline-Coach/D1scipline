/**
 * shared/intelligence/generateAiraIntelligencePlan.ts
 *
 * Main orchestration function for the Aira Intelligence System.
 *
 *   generateAiraIntelligencePlan(input) → AiraIntelligencePlan
 *
 * ─── Pipeline ────────────────────────────────────────────────────────────────
 *
 * Phase 2 Data Flow (steps 1–5 are delegated to buildIntelligenceDataFlow):
 *
 * Step 1  validateIntelligenceInput(input)
 *           → Blocking errors → valid: false → orchestrator throws.
 *           → Non-blocking warnings + validationDegradedMode → continues.
 *
 * Step 2  normalizeIntelligenceInput(...)
 *           → extractSignals()        — called ONCE; threaded to all engines.
 *           → derivePlanDecisions()   — called ONCE; receives pre-computed signals.
 *           → deriveConfidenceLevel() — called ONCE.
 *
 * Step 3  analyzeProfileCompleteness(normalizedInput)
 *           → Per-domain completeness scores, canRun / degradedMode flags.
 *
 * Step 4  mapSignalsToEngineInputs(normalizedInput, completeness)
 *           → Domain-scoped signal views. computeReadinessTier runs ONCE here.
 *
 * Step 5  createDomainDataPackets(normalizedInput, completeness, signalMap)
 *           → Five typed engine packets. Carried in metadata for Phase 3 migration.
 *
 * Engine execution (Phase 1 — engines still consume NormalizedIntelligenceInput):
 *
 * Step 6  runWorkoutEngine(normalized)    → WorkoutEngineOutput
 * Step 7  runNutritionEngine(normalized)  → NutritionEngineOutput
 * Step 8  runRecoveryEngine(normalized)   → RecoveryEngineOutput
 * Step 9  runSleepEngine(normalized, recovery) → SleepEngineOutput
 *           ↑ Sleep depends on recovery output (windDownMins, sleepTargetHrs).
 * Step 10 runPlannerEngine({...all}) → PlannerEngineOutput
 *           → generateSchedule() — the ONLY call to this function in the system.
 *           → Resolves scheduledTime on all tasks (PLANNER OWNERSHIP RULE).
 *           → Merges + time-sorts all engine tasks.
 *
 * Step 11 buildAdaptationContext(input.adaptation) → AdaptationContext | undefined
 *           → Runs BEFORE engines in Phase 5 Prompt #2 so effects can be wired.
 *           → Skipped entirely when input.adaptation is absent.
 *
 * Step 12 deriveAdaptationEffects(adaptationContext) → AdaptationEffect
 *           → Merges signal effects into one typed effect bundle.
 *           → Empty object when no adaptation or no signals.
 *
 * Step 13 buildLearningProfile(input.learning) → AiraLearningProfile | undefined
 *           → Phase 5 Prompt #3: derives long-term baseline from historical window.
 *           → Skipped entirely when input.learning is absent or has no data.
 *
 * Step 14 applyLearningAdjustments(plannerTasks, learningProfile, adaptationEffect)
 *           → Post-planner soft baseline adjustments.
 *           → Applied AFTER the planner so all adaptation effects are baked in first.
 *           → Adaptation overrides learning: each adjustment is skipped when
 *             adaptation already applied a same-or-stronger effect.
 *           → No-op when learningProfile is undefined or confidenceScore < 0.5.
 *
 * Step 15 Assemble and return AiraIntelligencePlan with adaptation + learning metadata.
 *
 * ─── Design guarantees ───────────────────────────────────────────────────────
 *
 * Deterministic:     same input → same output, always.
 * No randomness:     no Math.random(), no uuid, no timestamp-seeded logic.
 * No async:          synchronous from start to finish.
 * No external calls: no API calls, no AI model calls.
 * No mutation:       source input is never modified.
 * No signal dups:    extractSignals/derivePlanDecisions run exactly once each.
 * Safe fallback:     callers should wrap in try/catch and fall back to
 *                    generateDailyPlan() if the intelligence system errors.
 *
 * ─── Relationship to generateDailyPlan ───────────────────────────────────────
 *
 * generateDailyPlan() (shared/planner/generateDailyPlan.ts) still exists and
 * is NOT deprecated. This system currently wraps its generator functions.
 *
 * Planned migration (Phase 3+, not now):
 *   Domain engines will replace their internal calls to generateWorkout /
 *   generateNutrition / generateRecovery / generateSchedule with native logic.
 *   Once all engines are self-sufficient, generateDailyPlan can be deprecated
 *   and generateAiraIntelligencePlan becomes the sole planning entry point.
 *
 *   DO NOT start this migration until each engine's logic is production-validated.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  AiraIntelligenceInput,
  AiraIntelligencePlan,
  AdaptationContext,
  AdaptationEffect,
  AiraLearningProfile,
  IntelligenceTask,
  IntelligencePriority,
} from "./types";
import { INTELLIGENCE_SYSTEM_VERSION }   from "./constants";
import { buildIntelligenceDataFlow }     from "./data/buildIntelligenceDataFlow";
import { runWorkoutEngine }              from "./engines/workoutEngine";
import { runNutritionEngine }            from "./engines/nutritionEngine";
import { runRecoveryEngine }             from "./engines/recoveryEngine";
import { runSleepEngine }                from "./engines/sleepEngine";
import { runPlannerEngine }              from "./engines/plannerEngine";
import { buildAdaptationContext }        from "./adaptation/buildAdaptationContext";
import { deriveAdaptationEffects }       from "./adaptation/adaptationEffects";
import { buildLearningProfile }          from "./learning/buildLearningProfile";
import { applyLearningAdjustments }      from "./learning/applyLearningAdjustments";
import { AiraIntelligenceError }         from "./utils/AiraIntelligenceError";
import { buildPlanExperience }           from "./experience/buildPlanExperience";
import { TaskKind }                      from "../planner/types";

/**
 * Generate a complete Aira Intelligence Plan from a user profile.
 *
 * @param input — AiraIntelligenceInput: profile + optional daily condition override.
 * @returns     — AiraIntelligencePlan: unified, typed, deterministic.
 * @throws      — Error with all blocking errors listed when validation fails.
 *
 * Recommended caller pattern:
 * ```
 * try {
 *   const plan = generateAiraIntelligencePlan({ profile });
 * } catch (err) {
 *   // fall back to existing generateDailyPlan(profile)
 * }
 * ```
 */
export function generateAiraIntelligencePlan(
  input: AiraIntelligenceInput,
): AiraIntelligencePlan {

  // ── Steps 1–5: Phase 2 data flow pipeline ─────────────────────────────────
  // buildIntelligenceDataFlow handles: validate → normalize → analyzeCompleteness
  // → mapSignals → createPackets. It never throws — we throw on valid: false.
  const dataFlow = buildIntelligenceDataFlow(input);

  if (!dataFlow.valid) {
    // Build a safe structural snapshot — no raw user data, only key presence flags.
    const inputSnapshot = buildSafeInputSnapshot(input);
    throw new AiraIntelligenceError(
      "VALIDATION_FAILED",
      `[generateAiraIntelligencePlan] Input validation failed — cannot generate plan.\n` +
      `Blocking errors:\n` +
      dataFlow.errors.map((e) => `  • ${e}`).join("\n") +
      (dataFlow.warnings.length > 0
        ? `\nAdditional warnings:\n` + dataFlow.warnings.map((w) => `  ⚠ ${w}`).join("\n")
        : ""),
      dataFlow.errors,
      inputSnapshot,
    );
  }

  // dataFlow.valid === true narrows the discriminated union — normalizedInput and
  // domainPackets are guaranteed non-null by the type system. No cast needed.
  const normalized         = dataFlow.normalizedInput;
  const domainPackets      = dataFlow.domainPackets;
  const generatedAt        = dataFlow.metadata.builtAt;
  const validationWarnings = dataFlow.warnings;
  // degradedMode is the domain-derived global flag:
  //   workout.degraded || nutrition.degraded || recovery.degraded || sleep.degraded
  // NOT the validation flag — see buildIntelligenceDataFlow for the distinction.
  const degradedMode       = dataFlow.metadata.globalDegradedMode;

  // When degradedMode is true, the plan's stated confidence must reflect that
  // one or more domains are operating on insufficient data. Cap to "low" so
  // consumers do not present an overly confident plan on degraded input.
  const safeConfidenceLevel = degradedMode
    ? ("low" as const)
    : normalized.confidenceLevel;

  // ── Step 11: Adaptation context — built BEFORE engines (Phase 5 Prompt #2) ─
  // Must run before engines so effects can be passed to each engine and planner.
  // Produces signals, recommendations, and an effect bundle.
  // Skipped entirely when input.adaptation is absent — no behavior change.
  let adaptationContext: AdaptationContext | undefined;
  let adaptationEffect: AdaptationEffect = {};

  if (input.adaptation !== undefined) {
    adaptationContext = buildAdaptationContext(input.adaptation);
    adaptationEffect  = deriveAdaptationEffects(adaptationContext);
  }

  // ── Step 6: Workout Engine ─────────────────────────────────────────────────
  // Phase 3: engines receive their domain packet as the primary input.
  // normalizedInput is retained as a backward-compat secondary input for
  // delegation to the existing generateWorkout/Nutrition/Recovery generators.
  // Phase 5: adaptationEffect passed — engines add adaptation reasoning/recs only.
  const workoutOutput   = runWorkoutEngine(domainPackets.workout, normalized, adaptationEffect);

  // ── Step 7: Nutrition Engine ──────────────────────────────────────────────
  const nutritionOutput = runNutritionEngine(domainPackets.nutrition, normalized, adaptationEffect);

  // ── Step 8: Recovery Engine ───────────────────────────────────────────────
  // Must run before Sleep — sleep engine reads recovery.plan.windDownMins
  // and recovery.plan.sleepTargetHrs. This is the only allowed inter-engine
  // dependency in Phase 3.
  const recoveryOutput  = runRecoveryEngine(domainPackets.recovery, normalized, adaptationEffect);

  // ── Step 9: Sleep Engine ──────────────────────────────────────────────────
  const sleepOutput     = runSleepEngine(domainPackets.sleep, normalized, recoveryOutput, adaptationEffect);

  // ── Step 10: Planner Engine ───────────────────────────────────────────────
  // Must run LAST.
  // Owns: generateSchedule(), scheduledTime resolution, task merging, priorities.
  // Phase 5: adaptationEffect passed — planner applies structural task changes.
  const plannerOutput   = runPlannerEngine({
    normalizedInput: normalized,
    domainPackets,
    workoutOutput,
    nutritionOutput,
    recoveryOutput,
    sleepOutput,
    adaptationEffect,
  });

  // ── Step 12: Derive adaptation traceability summary ──────────────────────
  // Collect human-readable summary of what adaptation changed, for plan metadata.
  const adaptationApplied       = isEffectActive(adaptationEffect);
  const adaptationEffectSummary = adaptationApplied
    ? buildEffectSummary(adaptationEffect)
    : undefined;

  // ── Step 13: Build learning profile ───────────────────────────────────────
  // Long-term baseline bias derived from historical patterns.
  // Skipped entirely when input.learning is absent or all arrays are empty.
  let learningProfile: AiraLearningProfile | undefined;
  if (input.learning !== undefined) {
    learningProfile = buildLearningProfile(input.learning);
  }

  // ── Step 14: Apply learning adjustments ───────────────────────────────────
  // Post-planner soft adjustments: applied AFTER all engines and the planner so
  // adaptation effects are fully baked in. Adaptation overrides learning —
  // each adjustment is skipped when adaptation already covered that domain.
  // No-op when learningProfile is undefined or confidenceScore < 0.5.
  let finalTasks             = plannerOutput.tasks;
  let learningEffectSummary: string[] | undefined;

  if (learningProfile !== undefined) {
    const lr = applyLearningAdjustments(
      plannerOutput.tasks,
      learningProfile,
      adaptationEffect,
    );
    finalTasks            = lr.finalTasks;
    learningEffectSummary = lr.learningEffectSummary.length > 0
      ? lr.learningEffectSummary
      : undefined;
  }

  // ── Step 14b: Post-processing safety guards ──────────────────────────────
  // Applied after all adjustments (adaptation + learning) to enforce production
  // safety invariants on the final task list before returning.

  // 1. Deduplicate by task ID — deterministic; first-seen wins.
  //    Engine IDs are deterministic by design but this guard catches any
  //    edge-case where two engines produce an identical buildTaskId() output.
  finalTasks = deduplicateTasksById(finalTasks);

  // 2. Priority sanitization — clamp any invalid priority value to "medium".
  //    Guards against future engine changes producing out-of-range values.
  finalTasks = finalTasks.map(sanitizeTaskPriority);

  // 3. Minimum task floor — inject a survival baseline when all engines somehow
  //    return empty task arrays (extremely unlikely given current engine fallbacks,
  //    but required for a production-safe contract).
  if (finalTasks.length === 0) {
    finalTasks = buildMinimumViableTasks();
  }

  // ── Step 14c: Priorities fallback ────────────────────────────────────────
  // deriveDayPriorities always returns at least 1 item (decisions.focus), so
  // this guard only fires on a future regression. Ensures the field is never empty.
  const safePriorities = plannerOutput.priorities.length > 0
    ? plannerOutput.priorities
    : ["Stay consistent — focus on your core habits today."];

  // ── Step 14d: Adaptation context trimming ────────────────────────────────
  // Cap the arrays inside AdaptationContext to prevent large metadata payloads
  // on mobile. Summary fields (trend, risks, metadata) are always kept intact.
  const trimmedAdaptationContext = adaptationContext !== undefined
    ? trimAdaptationContext(adaptationContext)
    : undefined;

  // ── Step 16: Experience & Humanization Layer ─────────────────────────────
  // Produces enhanced summary, coaching priorities, confidence explanation,
  // and task-level benefit + executionHint fields.
  // NEVER changes task count, order, priority, status, id, or scheduledTime.
  const experience = buildPlanExperience({
    confidenceLevel:     safeConfidenceLevel,
    degradedMode,
    plannerStatus:       plannerOutput.status,
    readinessTier:       recoveryOutput.readinessTier,
    stressFlag:          recoveryOutput.stressFlag,
    adaptationEffect,
    adaptationApplied,
    tasks:               finalTasks,
    workoutSplit:        workoutOutput.split,
    workoutDurationMins: workoutOutput.durationMins,
  });

  // Apply experience fields to the task list (adds benefit + executionHint;
  // preserves all task structure, ordering, and priorities).
  finalTasks = experience.tasks;

  // ── Step 15: Assemble plan ────────────────────────────────────────────────
  const source: "onboarding" | "override" =
    input.dailyCondition ? "override" : "onboarding";

  return {
    generatedAt:           generatedAt ?? new Date().toISOString(),
    systemVersion:         INTELLIGENCE_SYSTEM_VERSION,
    confidenceLevel:       safeConfidenceLevel,
    confidenceExplanation: experience.confidenceExplanation,
    // Phase 4: convenience top-level accessors for the most-used planner outputs
    dailyFocus:            plannerOutput.dailyFocus || "Stay consistent and build on yesterday.",
    // Phase 6: experience layer replaces planner summary and priorities for UI.
    // Original planner versions preserved at plan.planner.summary / plan.planner.priorities.
    summary:               experience.summary,
    plannerStatus:         plannerOutput.status,
    priorities:            experience.priorities,
    // finalTasks: planner owns task structure; learning applies soft post-adjustments.
    // Note: scheduleBlocks and planner.tasks reflect the pre-learning state (see
    // applyLearningAdjustments for the known limitation and rationale).
    tasks:           finalTasks,
    scheduleBlocks:  plannerOutput.scheduleBlocks ?? [],
    conflicts:       plannerOutput.conflicts      ?? [],
    resolutions:     plannerOutput.resolutions    ?? [],
    workout:         workoutOutput,
    nutrition:       nutritionOutput,
    recovery:        recoveryOutput,
    sleep:           sleepOutput,
    planner:         plannerOutput,
    metadata: {
      source,
      deterministic:        true,
      onboardingConnected:  normalized.onboardingConnected,
      degradedMode,
      date:                 normalized.date,
      systemVersion:        INTELLIGENCE_SYSTEM_VERSION,
      validationWarnings:   validationWarnings ?? [],
      dataFlow:             dataFlow.metadata,
      adaptationConnected:  adaptationContext !== undefined,
      adaptationApplied,
      adaptationEffectSummary,
      // Trimmed: signals and recommendations capped to 10 entries each.
      // domainSummaries, risks, overallTrend, and metadata are always preserved.
      adaptationContext:    trimmedAdaptationContext,
      learningConnected:    learningProfile !== undefined,
      learningProfile,
      learningEffectSummary,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// File-private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a safe structural snapshot of the input for error reporting.
 * Never includes raw profile data — only key presence flags.
 */
function buildSafeInputSnapshot(input: AiraIntelligenceInput): Record<string, unknown> {
  const profile = input.profile as Record<string, unknown> | null | undefined;
  return {
    hasProfile:    Boolean(profile),
    hasDate:       Boolean(input.date),
    hasCondition:  Boolean(input.dailyCondition),
    hasAdaptation: Boolean(input.adaptation),
    hasLearning:   Boolean(input.learning),
    profileKeys:   profile ? Object.keys(profile) : [],
  };
}

/** Valid IntelligencePriority values — used for sanitization. */
const VALID_PRIORITIES = new Set<string>(["critical", "high", "medium", "low"]);

/**
 * Returns the task unchanged if its priority is valid; otherwise replaces the
 * priority with "medium" and marks the task as "adjusted" for traceability.
 */
function sanitizeTaskPriority(task: IntelligenceTask): IntelligenceTask {
  if (VALID_PRIORITIES.has(task.priority)) return task;
  return {
    ...task,
    priority: "medium" as IntelligencePriority,
    status:   "adjusted" as IntelligenceTask["status"],
    metadata: {
      ...task.metadata,
      sanitizationNote: `Priority "${String(task.priority)}" was not a valid value — clamped to "medium".`,
    },
  };
}

/**
 * Deduplicates a task array by ID (first-seen wins).
 * Engine IDs are deterministic by design; this guard catches edge-case regressions.
 */
function deduplicateTasksById(tasks: IntelligenceTask[]): IntelligenceTask[] {
  const seen = new Set<string>();
  return tasks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

/**
 * Minimum viable task list injected only when all engines return empty.
 * Provides basic hydration, movement, and sleep anchors as a survival baseline.
 * These are deterministic constants — no randomness, no timestamps.
 */
function buildMinimumViableTasks(): IntelligenceTask[] {
  return [
    {
      id:               "fallback-hydration-0",
      title:            "Hydration — drink 2–3L today",
      category:         "nutrition",
      kind:             TaskKind.Hydration,
      priority:         "medium",
      estimatedMinutes: 0,
      sourceEngine:     "nutrition",
      isRequired:       true,
      completionType:   "check",
      status:           "fallback",
      metadata:         { tags: ["hydration", "fallback"], fallback: true },
    },
    {
      id:               "fallback-movement-0",
      title:            "Light movement — 20 min walk",
      category:         "workout",
      kind:             TaskKind.Mobility,
      priority:         "medium",
      estimatedMinutes: 20,
      sourceEngine:     "workout",
      isRequired:       false,
      completionType:   "timer",
      status:           "fallback",
      metadata:         { tags: ["movement", "fallback"], fallback: true },
    },
    {
      id:               "fallback-sleep-0",
      title:            "Sleep — 8h target",
      category:         "sleep",
      kind:             TaskKind.Sleep,
      priority:         "high",
      estimatedMinutes: 480,
      sourceEngine:     "sleep",
      isRequired:       true,
      completionType:   "timer",
      status:           "fallback",
      metadata:         { tags: ["sleep", "fallback"], fallback: true, sleepTargetHrs: 8 },
    },
  ];
}

/**
 * Trim AdaptationContext arrays to prevent oversized metadata payloads on mobile.
 * Caps signals and recommendations to MAX_ARRAY entries.
 * All summary fields (domainSummaries, risks, overallTrend, metadata) are kept intact.
 */
function trimAdaptationContext(ctx: AdaptationContext): AdaptationContext {
  const MAX_ARRAY = 10 as const;
  if (ctx.signals.length <= MAX_ARRAY && ctx.recommendations.length <= MAX_ARRAY) {
    return ctx;  // already within bounds — no copy needed
  }
  return {
    ...ctx,
    signals:         ctx.signals.slice(0, MAX_ARRAY),
    recommendations: ctx.recommendations.slice(0, MAX_ARRAY),
  };
}

/**
 * Returns true if the effect object contains at least one active (truthy) field.
 * Used to determine whether adaptation actually changed anything in the plan.
 */
function isEffectActive(effect: AdaptationEffect): boolean {
  return !!(
    (effect.planner   && Object.values(effect.planner).some(Boolean))   ||
    (effect.workout   && Object.values(effect.workout).some(Boolean))   ||
    (effect.nutrition && Object.values(effect.nutrition).some(Boolean)) ||
    (effect.recovery  && Object.values(effect.recovery).some(Boolean))  ||
    (effect.sleep     && Object.values(effect.sleep).some(Boolean))
  );
}

/**
 * Returns a human-readable string[] summarising every active adaptation effect.
 * Included in plan metadata for traceability and UI display.
 */
function buildEffectSummary(effect: AdaptationEffect): string[] {
  const lines: string[] = [];
  const p = effect.planner;
  const w = effect.workout;
  const n = effect.nutrition;
  const r = effect.recovery;
  const s = effect.sleep;

  if (p?.enforceRecoveryBias)    lines.push("Recovery tasks elevated to high priority.");
  if (p?.reduceTaskCount)        lines.push("Daily task count reduced for manageability.");
  if (p?.simplifyStructure)      lines.push("Plan structure simplified.");
  if (p?.capIntensity)           lines.push(`Workout intensity capped at ${p.capIntensity}.`);
  if (w?.reduceVolume)           lines.push("Workout volume reduced.");
  if (w?.reduceIntensity)        lines.push("Workout intensity reduced.");
  if (w?.capPriority)            lines.push(`Workout priority capped at ${w.capPriority}.`);
  if (n?.simplifyPlan)           lines.push("Nutrition plan simplified.");
  if (n?.increaseProteinFocus)   lines.push("Protein intake focus increased.");
  if (n?.increaseHydrationFocus) lines.push("Hydration focus increased.");
  if (r?.increasePriority)       lines.push("Recovery prioritized.");
  if (r?.addProtocol)            lines.push("Additional recovery protocol recommended.");
  if (s?.enforceWindDown)        lines.push("Wind-down routine enforced.");
  if (s?.increaseSleepTarget)    lines.push("Sleep target increase recommended (+0.5 hr).");

  return lines;
}
