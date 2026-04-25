/**
 * shared/intelligence/index.ts
 *
 * Public API for the Aira Intelligence System.
 *
 * Import from here — do not import directly from sub-modules.
 *
 * Usage:
 *   import {
 *     generateAiraIntelligencePlan,
 *     validateIntelligenceInput,
 *     normalizeIntelligenceInput,
 *     INTELLIGENCE_SYSTEM_VERSION,
 *   } from "../shared/intelligence";
 *
 *   import type {
 *     AiraIntelligenceInput,
 *     AiraIntelligencePlan,
 *     IntelligenceTask,
 *     WorkoutEngineOutput,
 *     // ... etc.
 *   } from "../shared/intelligence";
 */

// ── Main orchestrator ────────────────────────────────────────────────────────
export { generateAiraIntelligencePlan } from "./generateAiraIntelligencePlan";

// ── Phase 5 — Adaptation System ──────────────────────────────────────────────
export { buildAdaptationContext }                       from "./adaptation/buildAdaptationContext";
export { analyzeUserFeedback }                          from "./adaptation/analyzeUserFeedback";
export { analyzePlanHistory }                           from "./adaptation/analyzePlanHistory";
export { deriveAdaptationSignals }                      from "./adaptation/deriveAdaptationSignals";
export { createAdaptationRecommendations }              from "./adaptation/createAdaptationRecommendations";
export { ADAPTATION_EFFECTS, deriveAdaptationEffects }  from "./adaptation/adaptationEffects";

// ── Phase 5 Prompt #3 — Learning System ──────────────────────────────────────
export { buildLearningProfile }      from "./learning/buildLearningProfile";
export { applyLearningAdjustments }  from "./learning/applyLearningAdjustments";

// ── Phase 6 Prompt #3 — Experience & Humanization Layer ──────────────────────
export { buildPlanExperience }       from "./experience/buildPlanExperience";
export type { PlanExperienceContext, PlanExperienceOutput } from "./experience/buildPlanExperience";

// ── Phase 2 — Data Flow & Signal Integration ─────────────────────────────────
export { buildIntelligenceDataFlow }    from "./data/buildIntelligenceDataFlow";
export { analyzeProfileCompleteness }  from "./data/analyzeProfileCompleteness";
export { mapSignalsToEngineInputs }    from "./data/mapSignalsToEngineInputs";
export { createDomainDataPackets }     from "./data/createDomainDataPackets";

// ── Utilities ────────────────────────────────────────────────────────────────
export { validateIntelligenceInput }  from "./utils/validateIntelligenceInput";
export { normalizeIntelligenceInput } from "./utils/normalizeIntelligenceInput";
export { AiraIntelligenceError }      from "./utils/AiraIntelligenceError";
export type { IntelligenceErrorCode } from "./utils/AiraIntelligenceError";

// ── Engines (exported for direct use and testing) ────────────────────────────
export { runWorkoutEngine }   from "./engines/workoutEngine";
export { runNutritionEngine } from "./engines/nutritionEngine";
export { runRecoveryEngine }  from "./engines/recoveryEngine";
export { runSleepEngine }     from "./engines/sleepEngine";
export { runPlannerEngine }   from "./engines/plannerEngine";

// ── Constants ────────────────────────────────────────────────────────────────
export {
  INTELLIGENCE_SYSTEM_VERSION,
  ENGINE_PHASE_VERSION,
  PLANNER_ENGINE_VERSION,
  ADAPTATION_VERSION,
  ADAPTATION_HISTORY_WINDOW_DAYS,
  LEARNING_VERSION,
  LEARNING_WINDOW_DAYS,
  LEARNING_CONFIDENCE_DATAPOINTS,
  INTELLIGENCE_ENGINE_NAMES,
  INTELLIGENCE_TASK_CATEGORIES,
  DEFAULT_DAILY_CONDITION,
  DEFAULT_INTERACTION_COUNT,
  MIN_CONFIDENCE_SCORE_FOR_NO_WARNING,
  DEGRADED_MODE_WARNING_THRESHOLD,
  PHASE_2_DATA_FLOW_VERSION,
  COMPLETENESS_COMPLETE_THRESHOLD,
  COMPLETENESS_PARTIAL_THRESHOLD,
  buildTaskId,
} from "./constants";

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  // Input
  AiraIntelligenceInput,
  NormalizedIntelligenceInput,
  DailyConditionOverride,

  // Validation
  AiraIntelligenceValidationResult,

  // Tasks
  IntelligenceTask,
  IntelligenceEngineName,
  IntelligencePriority,
  IntelligenceTaskCategory,
  IntelligenceTaskCompletionType,
  IntelligenceTaskStatus,
  EngineOutputStatus,
  EngineFormattedOutput,

  // Engine outputs
  WorkoutEngineOutput,
  NutritionEngineOutput,
  RecoveryEngineOutput,
  SleepEngineOutput,
  PlannerEngineOutput,
  PlannerEngineInput,

  // Phase 4 — Planner types
  PlannerDomainState,
  PlannerScheduleBlock,
  PlannerConflict,
  PlannerResolution,
  PlannerPriorityModel,
  PlannerMetadata,

  // Final plan
  AiraIntelligencePlan,

  // Phase 5 Prompt #3 — Learning types
  AiraLearningInput,
  AiraLearningProfile,
  LearningPatternSummary,
  LearningTendencies,
  LearningBaselineAdjustments,
  LearningMetadata,

  // Phase 6 Prompt #3 — new task experience fields (benefit, executionHint) are on IntelligenceTask

  // Phase 5 — Adaptation types
  AiraAdaptationInput,
  UserCheckIn,
  TaskCompletionRecord,
  PlanHistoryRecord,
  AdaptationContext,
  AdaptationEffect,
  AdaptationSignal,
  AdaptationRecommendation,
  AdaptationDomainSummary,
  AdaptationTrend,
  AdaptationRisk,
  AdaptationMetadata,

  // Phase 2 — Data Flow types
  DataImpact,
  CompletenessStatus,
  MissingDataItem,
  DomainCompletenessReport,
  ProfileCompletenessReport,
  WorkoutEngineSignals,
  NutritionEngineSignals,
  RecoveryEngineSignals,
  SleepEngineSignals,
  PlannerEngineSignals,
  WorkoutEngineDecisions,
  NutritionEngineDecisions,
  RecoveryEngineDecisions,
  SleepEngineDecisions,
  PlannerEngineDecisions,
  WorkoutProfileSnapshot,
  NutritionProfileSnapshot,
  RecoveryProfileSnapshot,
  SleepProfileSnapshot,
  PlannerProfileSnapshot,
  EngineInputReadiness,
  EngineSignalMap,
  WorkoutDataPacket,
  NutritionDataPacket,
  RecoveryDataPacket,
  SleepDataPacket,
  PlannerDataPacket,
  DomainDataPackets,
  DataFlowMetadata,
  IntelligenceDataFlowResult,
} from "./types";
