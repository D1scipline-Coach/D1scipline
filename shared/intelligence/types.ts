/**
 * shared/intelligence/types.ts
 *
 * Canonical TypeScript types for the Aira Intelligence System.
 *
 * Design rules:
 *   - All types are plain interfaces/type aliases — no classes, no runtime state.
 *   - Types import from existing planner modules rather than duplicating definitions.
 *   - AiraIntelligenceInput → NormalizedIntelligenceInput is a strict one-way transform.
 *     The normalized shape is the ONLY thing engines ever see.
 *   - All engine outputs carry a literal `engine` discriminant for type narrowing.
 *   - IntelligenceTask is the universal task shape used throughout the system.
 *     Domain engines suggest tasks but NEVER set scheduledTime — that is the
 *     exclusive responsibility of the Planner Engine.
 *
 * Planner Ownership Rule (enforced at the type level):
 *   Domain engine tasks have `scheduledTime?: string` as an optional field.
 *   If a domain engine sets it, it is treated as a suggestion only.
 *   The Planner Engine owns the final value of scheduledTime on every task
 *   before the plan is returned to the caller.
 *
 * Extension points (Phase 2+):
 *   - Add fields to NormalizedIntelligenceInput as new data sources connect.
 *   - Add new engine output types here; register the engine in constants.ts.
 *   - IntelligenceTask.metadata carries arbitrary per-task data without schema changes.
 *
 * ─── Migration note ────────────────────────────────────────────────────────────
 * Current state (Phase 1):
 *   The Intelligence System wraps the existing generateDailyPlan pipeline.
 *   generateWorkout / generateNutrition / generateRecovery / generateSchedule
 *   are still called inside domain engines. The intelligence layer adds typed
 *   wrappers, unified tasks, and structured metadata on top.
 *
 * Future state (Phase 3+):
 *   The Intelligence System should become the PRIMARY planning brain.
 *   generateDailyPlan will be deprecated in favour of generateAiraIntelligencePlan.
 *   Domain engines will contain their own logic and no longer delegate to
 *   the existing generator functions.
 *
 *   DO NOT perform that migration in Phase 1 or Phase 2.
 *   DO add logic inside engines only when the new intelligence layer is ready
 *   to fully replace the behaviour of its corresponding generator function.
 * ───────────────────────────────────────────────────────────────────────────────
 */

import type {
  AiraUserProfile,
  GoalKind,
  ExperienceLevel,
  SessionDuration,
  GymAccess,
  TrainingStyle,
  DietaryStyle,
  NutritionGoalKind,
  MealPrepLevel,
  SleepQuality,
  StressLevel,
  EnergyLevel,
  PreferredWorkoutTime,
  ScheduleConsistency,
} from "../types/profile";
import type {
  PlanSignals,
  PlanDecisions,
  ConfidenceLevel,
  IntensityLevel,
  VolumeLevel,
  ScheduleStrategy,
  WorkoutSplit,
  ReadinessTier,
  WorkoutPlan,
  NutritionPlan,
  RecoveryPlan,
  SchedulePlan,
} from "../planner/generateDailyPlan";
import type { TaskKind } from "../planner/types";

// ─────────────────────────────────────────────────────────────────────────────
// Primitive aliases
// ─────────────────────────────────────────────────────────────────────────────

/** Which engine produced a given output or task. */
export type IntelligenceEngineName =
  | "workout"
  | "nutrition"
  | "recovery"
  | "sleep"
  | "planner";

/** How urgent a task is within the intelligence plan. */
export type IntelligencePriority = "critical" | "high" | "medium" | "low";

/**
 * High-level domain category for a task.
 * Distinct from `kind: TaskKind` (which is the planner system's finer enum).
 * Used for UI grouping and filtering without coupling to planner internals.
 */
export type IntelligenceTaskCategory =
  | "workout"
  | "nutrition"
  | "recovery"
  | "sleep"
  | "planning";

/**
 * High-level status of an engine run.
 *
 *   "optimal"  — canRun === true AND confidenceScore ≥ 76.
 *                All critical data present; output is fully personalised.
 *   "adjusted" — canRun === true AND confidenceScore < 76.
 *                Engine ran but some data was incomplete; output is conservative.
 *   "fallback" — canRun === false.
 *                Critical data absent; engine returned safe generic output.
 */
export type EngineOutputStatus = "optimal" | "adjusted" | "fallback";

/**
 * User-facing formatted output layer — Phase 3.
 *
 * This is the PRESENTATION layer on top of the engine's machine output.
 * Everything here is human-readable and UI-ready.
 *
 *   summary    — 1–2 sentence overview, tone: confident and direct.
 *   plan       — short, actionable steps (no paragraphs, no fluff).
 *   reasoning  — simplified explanation of WHY the output was produced.
 *   warnings   — only present when data is missing or output is degraded;
 *                short and helpful, not technical.
 *   confidence — "High confidence" | "Moderate confidence" | "Low confidence".
 *   status     — mirrors EngineOutputStatus for quick UI branching.
 *
 * This field is computed by each engine's formatXOutput() function from the
 * already-computed engine output fields. It does NOT re-run any logic.
 */
export type EngineFormattedOutput = {
  summary:    string;
  plan:       string[];
  reasoning:  string[];
  warnings?:  string[];
  confidence: string;
  status:     EngineOutputStatus;
};

/**
 * How a user completes a task.
 *   check   — tap to mark done (binary)
 *   numeric — enter a number (e.g. liters consumed)
 *   timer   — start/stop a countdown (e.g. breathing protocol)
 *   text    — write a note (e.g. meal log)
 *   passive — system-tracked; no user action required (e.g. sleep duration via wearable).
 *             The task can be isRequired: true (affects score) while still being passive —
 *             the system supplies the completion signal rather than the user.
 */
export type IntelligenceTaskCompletionType = "check" | "numeric" | "timer" | "text" | "passive";

/**
 * Per-task planning status — set by the Planner Engine after applying the priority model.
 * Domain engines do not set this field; it will be undefined on raw engine task lists.
 *
 *   "planned"  — included as-is; no planner override on this task.
 *   "adjusted" — planner modified this task's priority via PlannerPriorityModel.
 *   "fallback" — sourced from an engine that ran in fallback mode (generic output).
 */
export type IntelligenceTaskStatus = "planned" | "adjusted" | "fallback";

// ─────────────────────────────────────────────────────────────────────────────
// Intelligence task — universal format across all engines
//
// PLANNER OWNERSHIP RULE:
//   `scheduledTime` is OPTIONAL on domain engine tasks.
//   Domain engines should leave it undefined — they suggest tasks, not schedules.
//   The Planner Engine is the ONLY place that sets scheduledTime to a real value.
//   Any domain engine that sets scheduledTime is violating this contract.
// ─────────────────────────────────────────────────────────────────────────────

export type IntelligenceTask = {
  /**
   * Deterministic ID: `{sourceEngine}-{kind.toLowerCase()}-{index}`
   * Same input → same IDs, always. No UUIDs, no randomness.
   */
  id:              string;

  /** Display title shown to the user. */
  title:           string;

  /**
   * Optional longer description or coaching note.
   * Carries the rationale that was previously in a separate `rationale` field.
   */
  description?:    string;

  /**
   * High-level domain category for UI grouping.
   * Separate from `kind` (the planner system's finer task classification).
   */
  category:        IntelligenceTaskCategory;

  /** Planner-system task type — preserves backward compat with Today-screen. */
  kind:            TaskKind;

  priority:        IntelligencePriority;

  /**
   * Estimated time required (minutes).
   * Optional — some tasks (e.g. "drink more water all day") have no fixed duration.
   */
  estimatedMinutes?: number;

  /**
   * Final scheduled time string (e.g. "7:00 AM").
   *
   * PLANNER OWNERSHIP: This field is undefined on tasks produced by domain engines.
   * The Planner Engine is the ONLY place that assigns a real scheduled time.
   * Do not set this field in workoutEngine, nutritionEngine, recoveryEngine, or sleepEngine.
   */
  scheduledTime?:  string;

  /** Which engine produced this task. */
  sourceEngine:    IntelligenceEngineName;

  /**
   * Whether the user MUST complete this task for the day to count as successful.
   * false = recommended / tracked passively.
   */
  isRequired:      boolean;

  /**
   * How the user interacts with completion.
   * Undefined when the task is not user-completable (e.g. tracked sleep).
   */
  completionType?: IntelligenceTaskCompletionType;

  /**
   * Per-task planning status — set by the Planner Engine after priority model is applied.
   * Undefined on raw domain engine task lists; always set on the final planner output.
   *
   * "planned"  — included as-is, no planner override.
   * "adjusted" — planner modified this task's priority via PlannerPriorityModel.
   * "fallback" — sourced from an engine that ran in fallback mode.
   */
  status?:         IntelligenceTaskStatus;

  /**
   * Task-level data quality warnings.
   * Short, user-friendly strings — no technical jargon.
   * Set by domain engines when a task is based on incomplete or low-confidence data.
   * Optional — absent when all relevant data is present.
   */
  warnings?:       string[];

  /**
   * Phase 6 Prompt #3 — Experience layer fields.
   * Added by buildPlanExperience() in the orchestrator after all engine and
   * planner logic is complete. Optional here to preserve backward compatibility
   * with mid-pipeline task objects; always present on AiraIntelligencePlan.tasks.
   *
   * description   — 1–2 sentence purpose explanation (may also be set by engines).
   * benefit       — outcome-driven statement: "what this task does for the user".
   * executionHint — concise guidance on how to approach the task efficiently.
   */
  benefit?:        string;
  executionHint?:  string;

  /**
   * Arbitrary engine-specific metadata.
   * Carries tags, exercise details, macro targets, etc.
   * Callers may read this but should not depend on its shape across engines.
   * Example: { tags: ["compound", "push"], sets: 4, reps: "8-10" }
   */
  metadata?:       Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Input types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional same-day condition check-in.
 * Allows the user to signal a different energy/recovery state than their baseline.
 * Phase 1: stored in NormalizedIntelligenceInput but not yet used to modify output.
 * Phase 2: will override recovery signals and influence engine decisions.
 */
export type DailyConditionOverride = {
  energyLevel?:     "low" | "moderate" | "high";
  soreness?:        "fresh" | "mild" | "sore";
  motivationLevel?: "low" | "moderate" | "high";
  timeAvailable?:   "minimal" | "moderate" | "full";
  focusArea?:       "workout" | "nutrition" | "consistency" | "recovery";
};

/**
 * Raw input to the Aira Intelligence System.
 *
 * Required:
 *   profile — AiraUserProfile from onboarding (via normalizeProfileForPlanning)
 *
 * Optional:
 *   date                  — YYYY-MM-DD; defaults to today when absent or malformed
 *   generatedAt           — ISO 8601 timestamp for this plan generation.
 *                           DETERMINISM NOTE:
 *                             Plan logic (signals, decisions, tasks) is fully deterministic
 *                             for the same profile+date+dailyCondition — same input always
 *                             produces the same logical plan.
 *                             Runtime timestamps (generatedAt, normalizedAt) are NOT part
 *                             of the deterministic contract unless the caller supplies them.
 *                             When absent, new Date().toISOString() is used at call time.
 *                             Supply this field when you need reproducible output for testing,
 *                             caching, or deep-equality checks.
 *   dailyCondition        — same-day override; stored now, applied in Phase 2+
 *   interactionCount      — total user interactions; used by refinement timing gate
 *   lastRefinementShownAt — ISO 8601; used by the 24h cooldown gate
 */
export type AiraIntelligenceInput = {
  profile:                AiraUserProfile;
  date?:                  string;
  generatedAt?:           string;
  dailyCondition?:        DailyConditionOverride;
  interactionCount?:      number;
  lastRefinementShownAt?: string;
  /**
   * Phase 5: optional adaptation context input.
   * When provided, buildAdaptationContext() runs and its output is attached
   * to the plan metadata. Adaptation is observational only in Phase 5 Prompt #1 —
   * it does not yet modify engine or planner decisions.
   */
  adaptation?:            AiraAdaptationInput;
  /**
   * Phase 5 Prompt #3: optional learning layer input.
   * When provided, buildLearningProfile() derives long-term baseline adjustments
   * from the historical window. Learning is softer than adaptation — adaptation
   * overrides learning when both are active for the same domain.
   *
   * Caller should supply a longer window than adaptation (e.g. last 14 days)
   * to capture persistent tendencies rather than recent spikes.
   */
  learning?:              AiraLearningInput;
};

/**
 * Internally normalized shape produced by normalizeIntelligenceInput().
 *
 * Signals and decisions are pre-computed here — engines NEVER re-derive them.
 * This is the single source of truth for all downstream computation.
 *
 * Immutable contract: engines receive this object and must not mutate it.
 */
export type NormalizedIntelligenceInput = {
  /** Original profile — never mutated. */
  profile:               AiraUserProfile;

  /**
   * Canonical signal set from extractSignals().
   * Called exactly ONCE in normalizeIntelligenceInput. No engine may call it again.
   */
  signals:               PlanSignals;

  /**
   * All plan decisions from derivePlanDecisions().
   * Called exactly ONCE, receives pre-computed signals. No engine may re-derive.
   */
  decisions:             PlanDecisions;

  confidenceLevel:       ConfidenceLevel;

  /** YYYY-MM-DD — always set, defaults to today. */
  date:                  string;

  /** Daily condition with safe defaults applied — always a complete object. */
  dailyCondition:        Required<DailyConditionOverride>;

  /**
   * True when profile contains the gate-enforced onboarding fields and signals
   * were successfully extracted. Engines may check this to decide whether to
   * trust pre-computed values or apply ultra-conservative fallbacks.
   */
  onboardingConnected:   boolean;

  /**
   * True when valid === true but significant warnings were raised.
   * Engines use this to add caveats to their outputs and lower their confidence.
   */
  degradedMode:          boolean;

  /**
   * Data source quality assessment.
   *   "onboarding" — full profile from the onboarding system; all gate fields present
   *   "partial"    — some gate fields missing; plan may be less accurate
   *   "unknown"    — source cannot be determined from the data
   */
  source:                "onboarding" | "partial" | "unknown";

  /**
   * ISO 8601 timestamp used for all runtime metadata in this plan generation run.
   * Sourced from AiraIntelligenceInput.generatedAt when provided; otherwise set to
   * new Date().toISOString() at call time (non-deterministic).
   *
   * DETERMINISM NOTE: This field is runtime metadata — it is explicitly excluded
   * from the deterministic plan contract. Plan logic (signals, decisions, tasks)
   * is deterministic. Timestamps are not, unless the caller supplies generatedAt.
   */
  generatedAt:           string;

  /** ISO 8601 timestamp of when normalization ran — same value as generatedAt. */
  normalizedAt:          string;

  /** Warnings collected during validation — carried forward for observability. */
  validationWarnings:    string[];

  interactionCount:      number;
  lastRefinementShownAt: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured result from validateIntelligenceInput().
 *
 * errors      — hard failures; the system cannot produce a reliable plan.
 *               Callers MUST stop if valid === false.
 * warnings    — soft issues; generation can proceed with degraded confidence.
 * degradedMode — true when valid === true but significant warnings are present.
 *               Orchestrator signals this to engines via NormalizedIntelligenceInput.
 */
export type AiraIntelligenceValidationResult = {
  valid:       boolean;
  errors:      string[];
  warnings:    string[];
  /** True when valid but notable data gaps exist that will reduce plan precision. */
  degradedMode: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared engine output base
//
// Every engine output includes these fields.
// Individual outputs extend with domain-specific fields.
//
// Phase 1 design notes (per engine):
//   confidence    — mirrors normalizedInput.confidenceLevel; may be downgraded
//                   by the engine if it has additional quality signals.
//   recommendations — actionable suggestions surfaced when confidence is medium/low.
//   engineVersion — "phase1" for all Phase 1 engines. Bump when engine logic changes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WorkoutEngineOutput
 *
 * Domain: training session for the day.
 * Planner dependency: tasks have no scheduledTime; planner sets workoutTimeText.
 *
 * Phase 2+ expansion:
 *   - Adaptive volume periodisation from weekly history
 *   - Injury-aware movement substitutions (training.injuries)
 *   - HRV-based intensity adjustment (future.wearables)
 *   - Multi-day programme view
 */
export type WorkoutEngineOutput = {
  engine:          "workout";
  readinessTier:   ReadinessTier;
  split:           WorkoutSplit;
  durationMins:    number;
  intensityLevel:  IntensityLevel;
  confidence:      ConfidenceLevel;
  /** Phase 3: structured output status — optimal / adjusted / fallback. */
  status:          EngineOutputStatus;
  /** Phase 3: why this session was prescribed — decision chain from packet signals. */
  reasoning:       string[];
  recommendations: string[];
  /** Phase 3: data quality alerts — only present when missingCriticalData or degradedMode. */
  warnings?:       string[];
  engineVersion:   string;
  /** Suggested tasks — scheduledTime is undefined; Planner Engine resolves it. */
  tasks:           IntelligenceTask[];
  /** Raw generateWorkout output — preserved for Today-screen and AI context. */
  plan:            WorkoutPlan;
  notes:           string[];
  /** Phase 3: user-facing presentation layer produced by formatWorkoutOutput(). */
  formatted:       EngineFormattedOutput;
};

/**
 * NutritionEngineOutput
 *
 * Domain: daily nutrition targets and meal suggestions.
 * Planner dependency: meal tasks have no scheduledTime; planner schedules them.
 *
 * Phase 2+ expansion:
 *   - Allergy-aware meal substitutions (nutrition.allergies)
 *   - Nutrient timing windows around workout time
 *   - Supplement scheduling
 *   - Dietary-style specific recipe suggestions
 */
export type NutritionEngineOutput = {
  engine:          "nutrition";
  caloricStrategy: "deficit" | "maintenance" | "surplus";
  confidence:      ConfidenceLevel;
  /** Phase 3: structured output status — optimal / adjusted / fallback. */
  status:          EngineOutputStatus;
  /** Phase 3: why this nutrition plan was prescribed — decision chain from packet signals. */
  reasoning:       string[];
  recommendations: string[];
  /** Phase 3: data quality alerts — only present when missingCriticalData or degradedMode. */
  warnings?:       string[];
  engineVersion:   string;
  /** Suggested tasks — scheduledTime undefined; Planner Engine resolves it. */
  tasks:           IntelligenceTask[];
  /** Raw generateNutrition output — preserved for Today-screen and AI context. */
  plan:            NutritionPlan;
  notes:           string[];
  /** Phase 3: user-facing presentation layer produced by formatNutritionOutput(). */
  formatted:       EngineFormattedOutput;
};

/**
 * RecoveryEngineOutput
 *
 * Domain: readiness assessment and recovery protocols.
 * Planner dependency: morning/evening buckets; Planner schedules exact times.
 *
 * Phase 2+ expansion:
 *   - HRV-based recovery scoring (future.wearables)
 *   - Adaptive protocol selection from weekly stress accumulation
 *   - Body-scan-informed targets (future.bodyScan)
 */
export type RecoveryEngineOutput = {
  engine:          "recovery";
  readinessTier:   ReadinessTier;
  stressFlag:      boolean;
  confidence:      ConfidenceLevel;
  /** Phase 3: structured output status — optimal / adjusted / fallback. */
  status:          EngineOutputStatus;
  /** Phase 3: why these protocols were prescribed — decision chain from packet signals. */
  reasoning:       string[];
  recommendations: string[];
  /** Phase 3: data quality alerts — only present when missingCriticalData or degradedMode. */
  warnings?:       string[];
  engineVersion:   string;
  /** Suggested tasks — scheduled to "Morning" / "Evening" buckets; Planner refines. */
  tasks:           IntelligenceTask[];
  /** Raw generateRecovery output — preserved for Today-screen and AI context. */
  plan:            RecoveryPlan;
  notes:           string[];
  /** Phase 3: user-facing presentation layer produced by formatRecoveryOutput(). */
  formatted:       EngineFormattedOutput;
};

/**
 * SleepEngineOutput
 *
 * Domain: sleep scheduling and wind-down protocol.
 * Dependency: reads RecoveryEngineOutput for windDownMins and sleepTargetHrs.
 *
 * Dependency direction (important):
 *   Sleep Engine → Recovery Engine output (reads plan.windDownMins, plan.sleepTargetHrs)
 *   Recovery Engine → Sleep Engine (NEVER — this direction is forbidden)
 *
 * Phase 2+ expansion:
 *   - Sleep stage analysis from wearable HRV (future.wearables)
 *   - Sleep debt calculation from weekly history
 *   - Chronotype-based schedule optimisation
 *   - Smart bedtime push notifications
 */
export type SleepEngineOutput = {
  engine:           "sleep";
  sleepTargetHrs:   number;
  windDownMins:     number;
  windDownTimeText: string;
  bedtimeText:      string;
  confidence:       ConfidenceLevel;
  /** Phase 3: structured output status — optimal / adjusted / fallback. */
  status:           EngineOutputStatus;
  /** Phase 3: why this sleep schedule was prescribed — decision chain from packet signals. */
  reasoning:        string[];
  recommendations:  string[];
  /** Phase 3: data quality alerts — only present when missingCriticalData or degradedMode. */
  warnings?:        string[];
  engineVersion:    string;
  /** Suggested tasks — wind-down time is approximate; Planner confirms from schedule. */
  tasks:            IntelligenceTask[];
  notes:            string[];
  /** Phase 3: user-facing presentation layer produced by formatSleepOutput(). */
  formatted:        EngineFormattedOutput;
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — Planner Engine types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-domain state snapshot stored in PlannerMetadata.
 * Captures each domain's health at plan-generation time.
 */
export type PlannerDomainState = {
  canRun:          boolean;
  degraded:        boolean;
  confidenceScore: number;
  status:          EngineOutputStatus;
};

/**
 * A grouped block of tasks within a deterministic time window.
 *
 * Time buckets:
 *   morning   — 00:00–11:59
 *   midday    — 12:00–14:59
 *   afternoon — 15:00–17:59
 *   evening   — 18:00–21:59
 *   night     — 22:00–23:59  (wind-down and sleep tasks)
 *
 * Blocks are non-overlapping and deterministic — same input → same blocks, always.
 * UI consumers can iterate `tasks` directly — no separate lookup required.
 */
export type PlannerScheduleBlock = {
  id:               string;
  title:            string;
  category:         IntelligenceTaskCategory | "mixed";
  /** Full task objects in this block — ordered by sort key. UI-ready. */
  tasks:            IntelligenceTask[];
  /** Sum of task durations in this block. 0 when no tasks carry estimatedMinutes. */
  estimatedMinutes: number;
  suggestedTime?:   string;
  priority:         IntelligencePriority;
  /** Why these tasks are grouped in this time block. */
  reason:           string;
};

/**
 * A cross-domain conflict detected by the Planner Engine.
 *
 * Conflicts are informational — they drive resolutions but never hard-block the plan.
 * Planner adjusts task priorities and ordering in response; it does not mutate
 * domain engine outputs.
 */
export type PlannerConflict = {
  id:          string;
  type:        string;
  severity:    "low" | "medium" | "high";
  /** Domain engines involved in this conflict. */
  domains:     IntelligenceEngineName[];
  description: string;
};

/**
 * Resolution the Planner Engine produced for a specific conflict.
 *
 * Resolutions adjust planner-level priorities and task ordering.
 * They do NOT mutate domain engine outputs directly.
 */
export type PlannerResolution = {
  /** ID of the conflict this resolution addresses. */
  conflictId:    string;
  /** What the planner did to mitigate the conflict. */
  action:        string;
  /** IDs of tasks whose priority or ordering was affected. */
  affectedTasks: string[];
  /** Why this resolution was chosen. */
  reason:        string;
};

/**
 * The planner's intended priority level per domain for the day.
 *
 * Applied as a ceiling/floor adjustment to individual task priorities:
 *   - "critical" tasks from domain engines are never downgraded.
 *   - Required tasks are never downgraded below "medium".
 *   - "low" is used when the domain has insufficient data and cannot be precisely prescribed.
 */
export type PlannerPriorityModel = {
  workout:   IntelligencePriority;
  nutrition: IntelligencePriority;
  recovery:  IntelligencePriority;
  sleep:     IntelligencePriority;
  /** Human-readable explanation of which rules fired to produce this model. */
  reason:    string;
};

/**
 * Observability metadata emitted by the Planner Engine.
 */
export type PlannerMetadata = {
  plannerVersion:            string;
  deterministic:             true;
  domainStates: {
    workout:   PlannerDomainState;
    nutrition: PlannerDomainState;
    recovery:  PlannerDomainState;
    sleep:     PlannerDomainState;
  };
  conflictCount:             number;
  highSeverityConflictCount: number;
  /** Number of non-empty schedule blocks produced for this plan. */
  scheduleBlockCount:        number;
  generatedFromPackets:      true;
};

/**
 * PlannerEngineOutput
 *
 * PLANNER OWNERSHIP: This is the only engine that sets scheduledTime on tasks.
 *
 * The Planner Engine:
 *   1. Calls generateSchedule() — the only call site in the intelligence system.
 *   2. Resolves scheduledTime on schedule-anchored tasks (workout, wind-down, sleep).
 *   3. Sorts remaining tasks using deterministic time-bucket fallbacks.
 *   4. Derives the day's coaching priorities.
 *   5. Returns the definitive task list that AiraIntelligencePlan.tasks points to.
 *
 * Phase 1 scheduledTime guarantee:
 *   RESOLVED  — workout, wind-down, sleep tasks get a real "HH:MM AM/PM" string.
 *   UNDEFINED — nutrition and recovery tasks; ordered via deterministic bucket sort.
 *   Phase 2 will assign real scheduledTime to all tasks via schedule.blocks.
 *
 * Phase 2+ expansion:
 *   - Calendar-aware scheduling (future.schedule.calendarConnected)
 *   - Dynamic task reordering based on dailyCondition override
 *   - Conflict detection and resolution when blocks overlap
 *   - Notification schedule generation
 *   - Multi-day continuity and programme progression
 */
export type PlannerEngineOutput = {
  engine:     "planner";

  /** Phase 4: overall planner output status — optimal / adjusted / fallback. */
  status:          EngineOutputStatus;
  /** Phase 4: thematic daily focus — human-readable, deterministic string. */
  dailyFocus:      string;
  /** Phase 4: user-facing 1–3 sentence summary of why the plan is structured this way. */
  summary:         string;
  /** Legacy: raw decisions.focus string — preserved for backward compatibility. */
  focus:           string;

  /** Ordered coaching priorities for the day — highest urgency first. Max 5. */
  priorities:      string[];

  /**
   * All tasks from all engines, sorted by time and priority-adjusted by the planner.
   * This is the canonical task list used by AiraIntelligencePlan.tasks.
   *
   * Phase 4 priority adjustment: domain-assigned priorities may be modified by
   * the planner's PlannerPriorityModel before the final sorted list is produced.
   *
   * scheduledTime is resolved on:
   *   - Workout task:    from schedule.workoutTimeText
   *   - Wind-down task:  from schedule.windDownTimeText
   *   - Sleep task:      from sleepOutput.bedtimeText
   *   - Nutrition tasks: scheduledTime undefined; ordered by deterministic meal-index buckets
   *   - Recovery tasks:  scheduledTime undefined; ordered by morning/evening timeBucket
   *
   * Consumers MUST treat scheduledTime as optional.
   */
  tasks:           IntelligenceTask[];

  /** Phase 4: tasks grouped into deterministic time blocks for display and scheduling. */
  scheduleBlocks:  PlannerScheduleBlock[];
  /** Phase 4: cross-domain conflicts detected by the planner. May be empty. */
  conflicts:       PlannerConflict[];
  /** Phase 4: planner-level resolutions for each detected conflict. */
  resolutions:     PlannerResolution[];
  /** Phase 4: per-domain priority model applied to task priority adjustment. */
  priorityModel:   PlannerPriorityModel;

  /** Raw generateSchedule output — preserved for Today-screen. */
  schedule:        SchedulePlan;
  notes:           string[];
  /** Phase 4: planner observability metadata. */
  plannerMetadata: PlannerMetadata;
};

/**
 * Input bundle passed to the Planner Engine.
 * All upstream engine outputs are provided together.
 *
 * Phase 3: domainPackets is the Phase 2 data layer — carries per-domain canRun,
 * degradedMode, and completeness flags. The planner uses these to adjust
 * scheduling conservatism and surface domain health in metadata.
 * normalizedInput is retained for backward-compat delegation to generateSchedule().
 * Phase 4+ will reduce or remove the normalizedInput dependency here.
 */
export type PlannerEngineInput = {
  normalizedInput: NormalizedIntelligenceInput;
  /** Phase 3: domain packet context — per-domain readiness, signals, and degraded flags. */
  domainPackets:   DomainDataPackets;
  workoutOutput:   WorkoutEngineOutput;
  nutritionOutput: NutritionEngineOutput;
  recoveryOutput:  RecoveryEngineOutput;
  sleepOutput:     SleepEngineOutput;
  /**
   * Phase 5: optional adaptation effects derived from the user's recent history.
   * When present, the planner applies structural adjustments (priority caps, task removal).
   * Absent when no adaptation input was provided — no behavior change in that case.
   */
  adaptationEffect?: AdaptationEffect;
};

// ─────────────────────────────────────────────────────────────────────────────
// Final unified output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete Aira Intelligence Plan.
 *
 * Authoritative output of generateAiraIntelligencePlan().
 * Stable, typed, deterministic.
 *
 * Consumers:
 *   Today Screen        — tasks, schedule, workout.plan, nutrition.plan
 *   Discipline Score    — tasks (isRequired, completionType)
 *   Notifications       — tasks (scheduledTime, title)
 *   Progress tracking   — metadata, confidenceLevel
 *   Chat / AI context   — all engine outputs + metadata
 *
 * ─── Migration path ──────────────────────────────────────────────────────────
 * Phase 1: generateDailyPlan() still exists and is UNTOUCHED.
 *   AiraIntelligencePlan wraps its outputs — engine plans mirror GeneratedDailyPlan.
 *
 * Phase 3+ migration (do not start until intelligence engines are self-sufficient):
 *   1. Replace generateWorkout/Nutrition/Recovery/Schedule calls inside engines
 *      with native engine logic.
 *   2. Deprecate generateDailyPlan() in favour of generateAiraIntelligencePlan().
 *   3. Update Today Screen to read from AiraIntelligencePlan directly.
 *   4. Remove GeneratedDailyPlan from the type system.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type AiraIntelligencePlan = {
  generatedAt:     string;           // ISO 8601
  systemVersion:   string;           // INTELLIGENCE_SYSTEM_VERSION constant
  confidenceLevel: ConfidenceLevel;
  /**
   * Phase 6 Prompt #3: Human-readable explanation of what the confidence level
   * means for this specific plan and what the user can do to improve it.
   * Always present. Generated by buildPlanExperience() in the orchestrator.
   */
  confidenceExplanation: string;
  /**
   * Phase 4: thematic daily focus — convenience accessor for planner.dailyFocus.
   * Human-readable, deterministic. Reflects readiness tier, domain health, and goals.
   */
  dailyFocus:      string;
  /**
   * Phase 4: user-facing plan summary — convenience accessor for planner.summary.
   * 1–3 sentences explaining why today's plan is structured as it is.
   */
  summary:         string;
  /**
   * Phase 4: planner output status — convenience accessor for planner.status.
   * "optimal" | "adjusted" | "fallback"
   */
  plannerStatus:   EngineOutputStatus;
  /** Top coaching priorities — ordered by urgency, max 5. */
  priorities:      string[];
  /**
   * Definitive task list — set by Planner Engine, not domain engines.
   *
   * Phase 4: priorities are adjusted by PlannerPriorityModel before the list is sorted.
   * scheduledTime is resolved on workout, wind-down, and sleep tasks.
   * Nutrition and recovery tasks have scheduledTime undefined and are ordered
   * via deterministic time-bucket fallbacks. See PlannerEngineOutput.tasks for details.
   *
   * Consumers must treat scheduledTime as optional.
   */
  tasks:           IntelligenceTask[];
  /**
   * Phase 4: schedule blocks — convenience accessor for planner.scheduleBlocks.
   * Tasks are grouped into deterministic time windows by the Planner Engine.
   *
   * ⚠ CANONICAL TASK LIST: use `plan.tasks`, not `scheduleBlocks[n].tasks`.
   *
   * Task objects inside scheduleBlocks reflect the planner's output BEFORE
   * Phase 5 learning adjustments are applied. `plan.tasks` is always updated
   * by applyLearningAdjustments and carries the final priority, status, and
   * learningNote / adaptationNote metadata.
   *
   * scheduleBlocks are useful for time-based grouping and display layout only.
   * Do NOT read task priority, status, or metadata from blocks — read from
   * `plan.tasks` (keyed by task.id) for the authoritative post-learning values.
   */
  scheduleBlocks:  PlannerScheduleBlock[];
  /**
   * Phase 4: cross-domain conflicts — convenience accessor for planner.conflicts.
   * May be empty. Drives the resolutions list.
   */
  conflicts:       PlannerConflict[];
  /**
   * Phase 4: conflict resolutions — convenience accessor for planner.resolutions.
   * One resolution per conflict. May be empty when no conflicts exist.
   */
  resolutions:     PlannerResolution[];
  workout:         WorkoutEngineOutput;
  nutrition:       NutritionEngineOutput;
  recovery:        RecoveryEngineOutput;
  sleep:           SleepEngineOutput;
  planner:         PlannerEngineOutput;
  metadata: {
    /**
     * "onboarding" — profile from the standard onboarding flow, condition not overridden.
     * "override"   — dailyCondition was provided; plan reflects a same-day check-in.
     */
    source:              "onboarding" | "override";
    /**
     * Always true — plan logic (signals, decisions, tasks) is deterministic.
     * No AI model call was made. Same profile+date+dailyCondition → same logical plan.
     * Note: generatedAt/normalizedAt timestamps are runtime metadata and are non-
     * deterministic unless AiraIntelligenceInput.generatedAt is supplied by the caller.
     */
    deterministic:       true;
    onboardingConnected: boolean;
    degradedMode:        boolean;
    date:                string;          // YYYY-MM-DD
    systemVersion:       string;
    /** Non-blocking validation warnings — preserved for observability and QA. */
    validationWarnings:  string[];
    /**
     * Phase 2: data flow analysis metadata.
     * Present when buildIntelligenceDataFlow ran as part of this plan generation.
     * Carries per-domain completeness flags and the phase version string.
     */
    dataFlow?:           DataFlowMetadata;
    /**
     * Phase 5: true when AiraAdaptationInput was provided and adaptation context
     * was successfully built. False when no adaptation input was given.
     */
    adaptationConnected: boolean;
    /**
     * Phase 5: true when at least one adaptation effect was non-empty and was
     * applied to task priorities, structure, or engine recommendations.
     * False when adaptation was connected but produced no active effects.
     */
    adaptationApplied:   boolean;
    /**
     * Phase 5: human-readable summary of what the adaptation layer changed.
     * One entry per active effect. Absent when adaptationApplied is false.
     */
    adaptationEffectSummary?: string[];
    /**
     * Phase 5: full adaptation context — signals, recommendations, and domain
     * summaries derived from task completions, check-ins, and plan history.
     * Absent when no AiraAdaptationInput was provided.
     */
    adaptationContext?:  AdaptationContext;
    /**
     * Phase 5 Prompt #3: true when AiraLearningInput was provided and a
     * learning profile was successfully built from the historical window.
     * False when no learning input was given or all input arrays were empty.
     */
    learningConnected:       boolean;
    /**
     * Phase 5 Prompt #3: full learning profile when learning is connected.
     * Contains patterns, tendencies, baseline adjustments, and confidence score.
     * Absent when learningConnected is false.
     */
    learningProfile?:        AiraLearningProfile;
    /**
     * Phase 5 Prompt #3: human-readable summary of what the learning layer changed.
     * One entry per active adjustment. Absent when no learning adjustments were applied.
     */
    learningEffectSummary?:  string[];
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Data Flow & Signal Integration types
//
// These types model the data layer between the raw profile and the engines.
//
// Flow:
//   AiraIntelligenceInput
//   → validation → normalization
//   → ProfileCompletenessReport      (analyzeProfileCompleteness)
//   → EngineSignalMap                (mapSignalsToEngineInputs)
//   → DomainDataPackets              (createDomainDataPackets)
//   → IntelligenceDataFlowResult     (buildIntelligenceDataFlow)
//
// Phase 2: domain packets are BUILT here but engines still consume
//   NormalizedIntelligenceInput for backward compatibility.
// Phase 3: engines will switch to consuming their own DomainDataPacket,
//   removing their direct dependency on the full normalized profile.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How severely a missing field impacts engine quality.
 *   critical — engine cannot produce meaningful output without this field
 *   moderate — engine works but quality is meaningfully reduced
 *   low      — nice-to-have; marginally improves personalisation
 */
export type DataImpact = "critical" | "moderate" | "low";

/** Whether a domain has enough data to be considered complete, partial, or missing. */
export type CompletenessStatus = "complete" | "partial" | "missing";

/**
 * Describes a specific missing profile field.
 * Used in completeness reports and surface-level recommendations.
 */
export type MissingDataItem = {
  /** Dot-notation profile field path, e.g. "training.injuries". */
  field:           string;
  /** Human-readable field name, e.g. "Injury history". */
  label:           string;
  /** Which engine is most affected by this field being absent. */
  domain:          IntelligenceEngineName;
  impact:          DataImpact;
  /** What the user should do to fill this gap. */
  recommendation?: string;
};

/**
 * Completeness analysis for one domain.
 *
 * score       — 0–100 composite score (60% from critical fields, 40% from optional).
 * status      — complete ≥ 80 / partial ≥ 40 / missing < 40.
 * canRun      — true when all critical fields are present; engine will execute normally.
 * degradedMode — true when critical fields are absent; engine falls back to defaults.
 */
export type DomainCompletenessReport = {
  score:         number;
  status:        CompletenessStatus;
  missingFields: MissingDataItem[];
  warnings:      string[];
  canRun:        boolean;
  degradedMode:  boolean;
};

/**
 * Full profile completeness across all five domains plus an aggregate overall report.
 *
 * Each domain's report is independent — a user can have complete recovery data but
 * incomplete nutrition data without the workout report being affected.
 */
export type ProfileCompletenessReport = {
  overall:   DomainCompletenessReport;
  workout:   DomainCompletenessReport;
  nutrition: DomainCompletenessReport;
  recovery:  DomainCompletenessReport;
  sleep:     DomainCompletenessReport;
  planner:   DomainCompletenessReport;
};

// ── Domain-specific signal views ──────────────────────────────────────────────
// Each type is a focused subset of PlanSignals + computed fields.
// These replace the "pass the entire NormalizedIntelligenceInput" pattern in Phase 3.

/** Signals consumed by the Workout Engine. */
export type WorkoutEngineSignals = {
  goal:            GoalKind;
  experience:      ExperienceLevel;
  trainingDays:    number;
  sessionDuration: SessionDuration;
  /** Computed once via computeReadinessTier — shared with RecoveryEngineSignals. */
  readinessTier:   ReadinessTier;
};

/** Signals consumed by the Nutrition Engine. */
export type NutritionEngineSignals = {
  goal:          GoalKind;
  dietaryStyle:  DietaryStyle;
  nutritionGoal: NutritionGoalKind;
  allergies:     string[];
  /** True when profile.profile.weight is present — enables precise calorie calibration. */
  hasBodyWeight: boolean;
  /** True when profile.profile.age is present — enables BMR-based calorie targets. */
  hasAge:        boolean;
};

/** Signals consumed by the Recovery Engine. */
export type RecoveryEngineSignals = {
  sleepQuality:   SleepQuality;
  stressLevel:    StressLevel;
  energyBaseline: EnergyLevel;
  /** Computed once via computeReadinessTier — shared with WorkoutEngineSignals. */
  readinessTier:  ReadinessTier;
  /** True when stressLevel is "high" or "very_high". */
  stressFlag:     boolean;
};

/** Signals consumed by the Sleep Engine. */
export type SleepEngineSignals = {
  wakeTime:     string;
  sleepTime:    string;
  sleepQuality: SleepQuality;
  stressLevel:  StressLevel;
};

/**
 * Signals consumed by the Planner Engine.
 * Carries the complete PlanSignals set plus domain-level degraded mode flags
 * so the planner can adjust scheduling conservatism per domain.
 */
export type PlannerEngineSignals = {
  goal:                 GoalKind;
  experience:           ExperienceLevel;
  trainingDays:         number;
  sessionDuration:      SessionDuration;
  sleepQuality:         SleepQuality;
  stressLevel:          StressLevel;
  energyBaseline:       EnergyLevel;
  scheduleConsistency:  ScheduleConsistency | undefined;
  preferredWorkoutTime: PreferredWorkoutTime | undefined;
  dietaryStyle:         DietaryStyle;
  nutritionGoal:        NutritionGoalKind;
  /** Per-domain degraded flags — planner uses these to adjust scheduling conservatism. */
  domainDegradedModes: {
    workout:   boolean;
    nutrition: boolean;
    recovery:  boolean;
    sleep:     boolean;
  };
};

// ── Domain-specific decision views ───────────────────────────────────────────

export type WorkoutEngineDecisions = {
  intensity: IntensityLevel;
  volume:    VolumeLevel;
  frequency: number;
  focus:     string;
};

export type NutritionEngineDecisions = {
  nutritionStrategy: string;
};

export type RecoveryEngineDecisions = {
  recoveryPriority: VolumeLevel;
  /** Training intensity context — informs how aggressively to prescribe recovery. */
  intensity:        IntensityLevel;
};

export type SleepEngineDecisions = {
  /** Drives sleep target duration calculation. */
  recoveryPriority: VolumeLevel;
};

export type PlannerEngineDecisions = {
  intensity:         IntensityLevel;
  volume:            VolumeLevel;
  frequency:         number;
  focus:             string;
  recoveryPriority:  VolumeLevel;
  scheduleStrategy:  ScheduleStrategy;
  nutritionStrategy: string;
};

// ── Profile snapshots — minimal read-only profile extracts per domain ─────────
// Each snapshot carries only the profile fields that engine needs.
// Phase 3: engines will receive their snapshot instead of the full profile,
// removing the direct dependency on AiraUserProfile from engine code.

export type WorkoutProfileSnapshot = {
  gymAccess:       GymAccess;
  trainingStyle:   TrainingStyle;
  experience:      ExperienceLevel;
  daysPerWeek:     number;
  sessionDuration: SessionDuration;
  primaryGoal:     GoalKind;
  injuries?:       string;
  recoveryState: {
    sleepQuality:   SleepQuality;
    stressLevel:    StressLevel;
    energyBaseline: EnergyLevel;
  };
};

export type NutritionProfileSnapshot = {
  dietaryStyle:  DietaryStyle;
  nutritionGoal: NutritionGoalKind;
  mealPrepLevel: MealPrepLevel;
  allergies:     string[];
  allergyNotes?: string;
  primaryGoal:   GoalKind;
  bodyMetrics: {
    weight?: string;
    age?:    string;
  };
};

export type RecoveryProfileSnapshot = {
  sleepQuality:   SleepQuality;
  stressLevel:    StressLevel;
  energyBaseline: EnergyLevel;
  injuries?:      string;
  /** True when future.wearables.hrv or future.recovery.hrv is present. */
  hasWearableHrv: boolean;
  hrv?:           number;
};

export type SleepProfileSnapshot = {
  wakeTime:       string;
  sleepTime:      string;
  sleepQuality:   SleepQuality;
  stressLevel:    StressLevel;
  hasWearableData: boolean;
};

export type PlannerProfileSnapshot = {
  wakeTime:              string;
  sleepTime:             string;
  preferredWorkoutTime?: PreferredWorkoutTime;
  scheduleConsistency?:  ScheduleConsistency;
  hasCalendarConnected:  boolean;
  /** Whether each domain engine can produce a full (non-degraded) output. */
  domainCanRun: {
    workout:   boolean;
    nutrition: boolean;
    recovery:  boolean;
    sleep:     boolean;
  };
};

// ── Per-engine readiness summary ──────────────────────────────────────────────

/**
 * Quick readiness check for a single engine.
 * Derived from the domain's DomainCompletenessReport.
 */
export type EngineInputReadiness = {
  canRun:          boolean;
  degradedMode:    boolean;
  confidenceScore: number;
  blockers:        MissingDataItem[];
};

// ── Signal map — all domain signal views in one object ────────────────────────

/**
 * Global signals and decisions mapped to domain-specific views.
 * Produced by mapSignalsToEngineInputs() from the single set of pre-computed
 * signals in NormalizedIntelligenceInput — no re-extraction occurs.
 */
export type EngineSignalMap = {
  workout:   WorkoutEngineSignals;
  nutrition: NutritionEngineSignals;
  recovery:  RecoveryEngineSignals;
  sleep:     SleepEngineSignals;
  planner:   PlannerEngineSignals;
};

// ── Domain data packets ───────────────────────────────────────────────────────
//
// A packet is the complete, self-contained input contract for one domain engine.
// It bundles everything an engine needs: readiness flags, domain-scoped signals,
// pre-computed decisions, and a minimal profile snapshot.
//
// WHY DO PACKETS EXIST?
//   Phase 1 engines receive the full NormalizedIntelligenceInput — they can read
//   any profile field, creating invisible dependencies that are hard to test.
//   Packets make each engine's data contract explicit and narrow. Phase 3 will
//   migrate engines to consume only their own typed packet, eliminating the direct
//   AiraUserProfile dependency from engine code entirely.
//
// TWO SCORE FIELDS (important):
//   completenessScore — raw profile data coverage for this domain (0–100).
//                       Comes directly from ProfileCompletenessReport.score.
//                       Formula: (criticalFraction * 60) + (optionalFraction * 40).
//   confidenceScore   — estimated engine output quality (0–100).
//                       Derived from completenessScore + status tier.
//                       Phase 2 formula: linear interpolation within each tier:
//                         complete  [80–100] → [90–100]
//                         partial   [40–79]  → [60–85]
//                         missing   [ 0–39]  → [ 0–50]
//                       The two scores are always correlated but are intentionally
//                       separate: completeness is a raw data-coverage measure;
//                       confidence is a quality estimate for downstream consumers.
//
// CONSISTENT STRUCTURE:
//   All five packets share the same field order and naming so consumers can treat
//   them uniformly. New engines added in Phase 3+ must follow this contract.

export type WorkoutDataPacket = {
  domain:              "workout";
  canRun:              boolean;
  degradedMode:        boolean;
  /** Raw profile data coverage for this domain: (criticalFraction * 60) + (optionalFraction * 40). */
  completenessScore:   number;
  /** Estimated engine output quality derived from completenessScore + status tier. */
  confidenceScore:     number;
  /** Critical profile fields that are absent and block full engine execution. */
  missingCriticalData: MissingDataItem[];
  signals:             WorkoutEngineSignals;
  decisions:           WorkoutEngineDecisions;
  profileSnapshot:     WorkoutProfileSnapshot;
  metadata:            Record<string, unknown>;
};

export type NutritionDataPacket = {
  domain:              "nutrition";
  canRun:              boolean;
  degradedMode:        boolean;
  /** Raw profile data coverage for this domain: (criticalFraction * 60) + (optionalFraction * 40). */
  completenessScore:   number;
  /** Estimated engine output quality derived from completenessScore + status tier. */
  confidenceScore:     number;
  /** Critical profile fields that are absent and block full engine execution. */
  missingCriticalData: MissingDataItem[];
  signals:             NutritionEngineSignals;
  decisions:           NutritionEngineDecisions;
  profileSnapshot:     NutritionProfileSnapshot;
  metadata:            Record<string, unknown>;
};

export type RecoveryDataPacket = {
  domain:              "recovery";
  canRun:              boolean;
  degradedMode:        boolean;
  /** Raw profile data coverage for this domain: (criticalFraction * 60) + (optionalFraction * 40). */
  completenessScore:   number;
  /** Estimated engine output quality derived from completenessScore + status tier. */
  confidenceScore:     number;
  /** Critical profile fields that are absent and block full engine execution. */
  missingCriticalData: MissingDataItem[];
  signals:             RecoveryEngineSignals;
  decisions:           RecoveryEngineDecisions;
  profileSnapshot:     RecoveryProfileSnapshot;
  metadata:            Record<string, unknown>;
};

export type SleepDataPacket = {
  domain:              "sleep";
  canRun:              boolean;
  degradedMode:        boolean;
  /** Raw profile data coverage for this domain: (criticalFraction * 60) + (optionalFraction * 40). */
  completenessScore:   number;
  /** Estimated engine output quality derived from completenessScore + status tier. */
  confidenceScore:     number;
  /** Critical profile fields that are absent and block full engine execution. */
  missingCriticalData: MissingDataItem[];
  signals:             SleepEngineSignals;
  decisions:           SleepEngineDecisions;
  profileSnapshot:     SleepProfileSnapshot;
  metadata:            Record<string, unknown>;
};

export type PlannerDataPacket = {
  domain:              "planner";
  canRun:              boolean;
  degradedMode:        boolean;
  /** Raw profile data coverage for this domain: (criticalFraction * 60) + (optionalFraction * 40). */
  completenessScore:   number;
  /** Estimated engine output quality derived from completenessScore + status tier. */
  confidenceScore:     number;
  /** Critical profile fields that are absent and block full engine execution. */
  missingCriticalData: MissingDataItem[];
  signals:             PlannerEngineSignals;
  decisions:           PlannerEngineDecisions;
  profileSnapshot:     PlannerProfileSnapshot;
  metadata:            Record<string, unknown>;
};

/** Container for all five domain packets — the output of createDomainDataPackets(). */
export type DomainDataPackets = {
  workout:   WorkoutDataPacket;
  nutrition: NutritionDataPacket;
  recovery:  RecoveryDataPacket;
  sleep:     SleepDataPacket;
  planner:   PlannerDataPacket;
};

// ── Data flow metadata ────────────────────────────────────────────────────────

export type DataFlowMetadata = {
  /** ISO 8601 — equals generatedAt for this plan run. */
  builtAt:                        string;
  systemVersion:                  string;
  phase:                          "phase_2_data_flow";
  /**
   * True when AiraIntelligenceInput.generatedAt was supplied by the caller.
   * When true, all timestamps in this plan generation are reproducible.
   */
  deterministicTimestampProvided: boolean;
  /**
   * True when ANY domain engine is in degraded mode.
   *
   * Derivation rule (Phase 2):
   *   globalDegradedMode = workout.degradedMode
   *                      || nutrition.degradedMode
   *                      || recovery.degradedMode
   *                      || sleep.degradedMode
   *
   * Planner is excluded: planner degradation is a downstream consequence of
   * domain states and does not independently trigger the global flag.
   *
   * This is deliberately narrow (one weak domain can trigger it). Callers
   * should consult per-domain flags when they need a more granular picture.
   */
  globalDegradedMode:             boolean;
  /** Per-domain degraded flags derived directly from ProfileCompletenessReport. */
  domainDegradedModes: {
    workout:   boolean;
    nutrition: boolean;
    recovery:  boolean;
    sleep:     boolean;
    planner:   boolean;
  };
};

// ── Intelligence Data Flow Result ─────────────────────────────────────────────

/**
 * The complete output of buildIntelligenceDataFlow().
 *
 * Discriminated union on `valid` — TypeScript narrows safely after a
 * `if (!dataFlow.valid)` guard with no need for `as` casts.
 *
 * valid: true — pipeline ran fully.
 *   normalizedInput, completeness, and domainPackets are guaranteed non-null.
 *   warnings[] may still be non-empty (non-blocking validation warnings).
 *   errors[] is always empty.
 *
 * valid: false — validation blocked plan generation.
 *   normalizedInput, completeness, and domainPackets are all null.
 *   errors[] contains all blocking validation messages.
 *   Downstream callers must not attempt plan generation.
 */
export type IntelligenceDataFlowResult =
  | {
      valid:           true;
      normalizedInput: NormalizedIntelligenceInput;
      completeness:    ProfileCompletenessReport;
      domainPackets:   DomainDataPackets;
      warnings:        string[];
      errors:          string[];
      metadata:        DataFlowMetadata;
    }
  | {
      valid:           false;
      normalizedInput: null;
      completeness:    null;
      domainPackets:   null;
      warnings:        string[];
      errors:          string[];
      metadata:        DataFlowMetadata;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Adaptation Effect type
//
// Used by adaptationEffects.ts to describe the structural changes the adaptation
// layer requests. Engines and planner consume this to apply controlled adjustments.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A typed description of what structural adjustments adaptation signals have
 * requested across each domain.
 *
 * All fields are optional — callers should treat absent fields as "no change".
 * The planner owns structural changes (task removal, priority caps).
 * Engines use this for additive reasoning/recommendation text only.
 *
 * Phase 5 design rule:
 *   Engines MUST NOT mutate plan values (intensityLevel, durationMins, etc.)
 *   based on adaptation effects — they only add explanatory text.
 *   All structural changes (priority caps, task removal) are applied by the planner.
 */
export type AdaptationEffect = {
  planner?: {
    /** Remove optional low-priority tasks to reduce cognitive load. */
    reduceTaskCount?:     boolean;
    /** Cap workout-category task intensity signal in daily focus/summary. */
    capIntensity?:        "low" | "medium";
    /** Elevate recovery and sleep tasks to at least "high" priority. */
    enforceRecoveryBias?: boolean;
    /** Reduce non-essential optional tasks; keep plan lean. */
    simplifyStructure?:   boolean;
  };
  workout?: {
    /** Inject recommendation to reduce workout volume. */
    reduceVolume?:    boolean;
    /** Inject recommendation to reduce workout intensity. */
    reduceIntensity?: boolean;
    /** Cap workout task priority at this level in the planner. */
    capPriority?:     "low" | "medium";
  };
  nutrition?: {
    /** Inject recommendation to simplify meal tracking. */
    simplifyPlan?:           boolean;
    /** Inject recommendation to focus on consistent protein intake. */
    increaseProteinFocus?:   boolean;
    /** Inject recommendation to focus on hydration. */
    increaseHydrationFocus?: boolean;
  };
  recovery?: {
    /** Inject recommendation to treat recovery as the day's top priority. */
    increasePriority?: boolean;
    /** Inject a conservative additional recovery protocol recommendation. */
    addProtocol?:      boolean;
  };
  sleep?: {
    /** Inject recommendation to enforce the wind-down window. */
    enforceWindDown?:      boolean;
    /** Inject recommendation to aim for +30 min extra sleep. */
    increaseSleepTarget?:  boolean;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Adaptation Foundation types
//
// These types model the adaptation layer that learns from user feedback,
// task completion history, and plan history to improve future plans.
//
// Phase 5 Prompt #1 design:
//   Adaptation is OBSERVATIONAL ONLY. It produces signals and recommendations
//   but does NOT mutate domain engine or planner decisions.
//   Future prompts will wire adaptation signals into engine/planner adjustments.
//
// Flow:
//   AiraAdaptationInput
//   → analyzeUserFeedback(checkIns)        → FeedbackSummary   (internal)
//   → analyzePlanHistory(plans, records)   → HistorySummary    (internal)
//   → deriveAdaptationSignals(summaries)   → AdaptationSignal[]
//   → createAdaptationRecommendations(signals) → AdaptationRecommendation[]
//   → buildAdaptationContext(input)        → AdaptationContext
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single user check-in — a same-day or recent self-reported condition.
 * Used by the adaptation layer to detect patterns across multiple days.
 */
export type UserCheckIn = {
  /** YYYY-MM-DD */
  date:          string;
  energy?:       "low" | "moderate" | "high";
  soreness?:     "none" | "mild" | "moderate" | "high";
  stress?:       "low" | "moderate" | "high";
  sleepQuality?: "poor" | "fair" | "good" | "great";
  motivation?:   "low" | "moderate" | "high";
  /** Optional free-text note — not parsed by the adaptation layer. */
  notes?:        string;
};

/**
 * A record of whether a specific task was completed on a given day.
 * Sourced from the UI task-completion layer.
 */
export type TaskCompletionRecord = {
  taskId:          string;
  /** YYYY-MM-DD */
  date:            string;
  domain:          IntelligenceTaskCategory;
  completed:       boolean;
  /** true when the user intentionally skipped (distinct from not completing) */
  skipped?:        boolean;
  /** 0–1; relevant for partial-completion tasks (e.g. % of meals logged) */
  completionRate?: number;
  /** Optional user-supplied reason for skipping or not completing. */
  reason?:         string;
};

/**
 * A lightweight summary of a past plan day.
 * Sourced from the persistence layer — does not store the full AiraIntelligencePlan.
 */
export type PlanHistoryRecord = {
  /** YYYY-MM-DD */
  date:               string;
  plannerStatus:      EngineOutputStatus;
  dailyFocus?:        string;
  completedTaskCount?: number;
  totalTaskCount?:    number;
  /** Per-domain completion rates (0–1) for that day. */
  domainCompletion?: {
    workout?:   number;
    nutrition?: number;
    recovery?:  number;
    sleep?:     number;
  };
};

/**
 * Input bundle for the adaptation system.
 * All fields are optional — the system degrades gracefully when any are absent.
 */
export type AiraAdaptationInput = {
  /** Current plan — used for context; not mutated. */
  currentPlan?:      AiraIntelligencePlan;
  /** Recent plan history — caller provides the appropriate window (e.g. last 7 days). */
  recentPlans?:      PlanHistoryRecord[];
  /** Task completion records — caller provides the appropriate window. */
  taskCompletions?:  TaskCompletionRecord[];
  /** User check-ins — caller provides the appropriate window. */
  checkIns?:         UserCheckIn[];
  /** ISO 8601 — supply for deterministic timestamps; defaults to runtime now(). */
  generatedAt?:      string;
};

/**
 * Directionality of a domain's recent performance.
 *
 *   "improving"         — completion rates high, no negative signals
 *   "stable"            — moderate completion, mixed signals
 *   "declining"         — low completion or repeated negative signals
 *   "insufficient_data" — too few records to assess
 */
export type AdaptationTrend = "improving" | "stable" | "declining" | "insufficient_data";

/**
 * A detected risk from the adaptation layer.
 * Risks are elevated from medium/high severity signals.
 */
export type AdaptationRisk = {
  id:          string;
  domain:      IntelligenceEngineName;
  severity:    "medium" | "high";
  description: string;
};

/**
 * A structured signal derived from feedback and history patterns.
 * Signals are the atomic unit of the adaptation layer.
 */
export type AdaptationSignal = {
  /** Deterministic ID: `signal-{type}-{index}` */
  id:                string;
  domain:            IntelligenceEngineName;
  severity:          "low" | "medium" | "high";
  /**
   * Signal type — machine-readable key.
   * See deriveAdaptationSignals.ts for the full signal taxonomy.
   */
  type:              string;
  /** Human-readable description of what was detected. */
  message:           string;
  /** What the adaptation layer recommends doing about it. */
  recommendedAction: string;
};

/**
 * An actionable recommendation derived from one or more adaptation signals.
 * Recommendations are for the NEXT plan — they do not mutate the current plan.
 */
export type AdaptationRecommendation = {
  /** Deterministic ID: `recommendation-{type}-{index}` */
  id:                string;
  domain:            IntelligenceEngineName;
  priority:          "low" | "medium" | "high";
  /** Short, user-friendly action string. */
  recommendation:    string;
  /** Why this recommendation was produced — references the signal that drove it. */
  reason:            string;
  /**
   * Whether this recommendation should be passed to the next plan generation.
   * True for all Phase 5 Prompt #1 recommendations — wiring comes in Prompt #2.
   */
  appliesToNextPlan: boolean;
};

/**
 * Aggregated view of a single domain's adaptation state.
 * Summarises trend, completion, and active signals for the domain.
 */
export type AdaptationDomainSummary = {
  domain:          IntelligenceEngineName;
  trend:           AdaptationTrend;
  /** 0–1 average completion rate. -1 when insufficient data. */
  completionRate:  number;
  /** Human-readable descriptions of detected issues. */
  recentIssues:    string[];
  /** Signals that fired for this domain. */
  signals:         AdaptationSignal[];
};

/**
 * Observability metadata for the adaptation context build.
 */
export type AdaptationMetadata = {
  generatedAt:         string;
  adaptationVersion:   string;
  deterministic:       true;
  /** Expected history window passed by the caller (days). */
  historyWindowDays:   number;
  plansAnalyzed:       number;
  completionsAnalyzed: number;
  checkInsAnalyzed:    number;
};

/**
 * The complete output of buildAdaptationContext().
 *
 * Attached to AiraIntelligencePlan.metadata.adaptationContext when adaptation
 * input is provided. Observational only in Phase 5 Prompt #1.
 */
export type AdaptationContext = {
  signals:         AdaptationSignal[];
  recommendations: AdaptationRecommendation[];
  domainSummaries: AdaptationDomainSummary[];
  risks:           AdaptationRisk[];
  overallTrend:    AdaptationTrend;
  metadata:        AdaptationMetadata;
};

// ─────────────────────────────────────────────────────────────────────────────
//   Phase 5 Prompt #3 — Learning Layer
//
//   Distinct from adaptation:
//     Adaptation — short-term response to recent signals (triggered, 7-day window)
//     Learning   — long-term baseline bias from repeated patterns (always present, 14-day window)
//
//   Relationship: Learning = soft defaults. Adaptation = active override.
//   When both apply to the same domain, adaptation takes precedence.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input bundle for the learning layer.
 * All fields optional — the system degrades gracefully when any are absent.
 * Caller should supply a wider window than adaptation (e.g. last 14 days) to
 * capture persistent tendencies rather than short-term fluctuations.
 */
export type AiraLearningInput = {
  recentPlans?:     PlanHistoryRecord[];
  taskCompletions?: TaskCompletionRecord[];
  checkIns?:        UserCheckIn[];
  /** ISO 8601 — supply for deterministic timestamp generation. */
  generatedAt?:     string;
};

/**
 * Frequency-based pattern summary derived from the historical window.
 * All values are 0–1 (fraction of data points that matched the criterion).
 */
export type LearningPatternSummary = {
  /** Fraction of check-ins with low energy, high soreness, or poor sleep quality. */
  lowReadinessFrequency: number;
  /** Fraction of check-ins where stress was "high". */
  highStressFrequency:   number;
  /** Fraction of check-ins where sleepQuality was "poor" or "fair". */
  poorSleepFrequency:    number;
  /** 1 minus average plan/task completion rate — higher = worse compliance. */
  lowCompletionRate:     number;
};

/**
 * Boolean tendencies derived from pattern frequencies.
 * Each tendency is true when its source frequency exceeds TENDENCY_THRESHOLD (0.4).
 */
export type LearningTendencies = {
  /** lowReadinessFrequency > 0.4 → long-term preference for lower training volume. */
  prefersLowerVolume:     boolean;
  /** highStressFrequency > 0.4 → chronic stress pattern; extra recovery needed. */
  needsMoreRecovery:      boolean;
  /** poorSleepFrequency > 0.4 → persistent sleep inconsistency. */
  inconsistentSleep:      boolean;
  /** lowCompletionRate > 0.4 → low nutrition adherence; simplification helps. */
  nutritionComplianceLow: boolean;
};

/**
 * Soft baseline adjustments derived from long-term tendencies.
 * Each field is present only when its associated tendency is active.
 * Applied by applyLearningAdjustments ONLY when confidenceScore >= 0.5.
 */
export type LearningBaselineAdjustments = {
  /** Cap workout task priority to this level (prefersLowerVolume → "medium"). */
  workoutIntensityBias?:       "low" | "medium";
  /** Elevate recovery task priority to this level (needsMoreRecovery → "high"). */
  recoveryPriorityBias?:       "medium" | "high";
  /** Hours to add to the sleep target task (inconsistentSleep → 0.5 = +30 min). */
  sleepTargetBias?:            number;
  /** When true: mark nutrition tasks for simplified approach (nutritionComplianceLow). */
  nutritionSimplificationBias?: boolean;
};

/** Provenance and confidence metadata attached to the learning profile. */
export type LearningMetadata = {
  /** Always true — all learning logic is deterministic. */
  deterministic:  true;
  /** Total check-in + plan history records used (denominator for confidence). */
  dataPointsUsed: number;
  /** The window (in days) the caller is expected to supply data for. */
  windowDays:     number;
};

/**
 * The complete deterministic learning profile for a user.
 *
 * Generated by buildLearningProfile() from a historical window of plan history,
 * task completions, and check-ins.
 *
 * confidenceScore (0–1):
 *   = min(1, dataPointsUsed / 20)
 *   Adjustments are applied only when confidenceScore >= 0.5 (≥ 10 of 20 data points).
 *   Below this threshold the profile exists but no plan changes are made.
 */
export type AiraLearningProfile = {
  /** Schema version — bump when structure or semantics change. */
  version:             "phase5_learning_v1";
  /** Raw frequency measurements from the historical window. */
  patterns:            LearningPatternSummary;
  /** Boolean tendencies derived from patterns exceeding the 0.4 threshold. */
  tendencies:          LearningTendencies;
  /** Soft baseline adjustments; applied only when confidenceScore >= 0.5. */
  baselineAdjustments: LearningBaselineAdjustments;
  /** 0–1. Below 0.5 (< 10 data points): profile exists but adjustments are skipped. */
  confidenceScore:     number;
  metadata:            LearningMetadata;
};
