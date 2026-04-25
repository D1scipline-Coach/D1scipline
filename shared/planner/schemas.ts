/**
 * shared/planner/schemas.ts
 *
 * Zod schemas for the two validation surfaces:
 *   1. PlannerInputSchema    — validates the client request body (untrusted user input)
 *   2. AIPlannerOutputSchema — validates the AI JSON response (untrusted model output)
 *
 * Both surfaces are validated before any data is stored or returned.
 * Schema-inferred types are the authoritative TypeScript types for all callers.
 *
 * Extension points:
 *   - Add new fields to PlannerInputSchema.shape as planner inputs grow
 *   - Tighten AIPlannerOutputSchema constraints to guide model quality
 *   - Add .refine() rules for cross-field validation (e.g. wake < sleep)
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Primitive schemas — reused across input and output validation
// ─────────────────────────────────────────────────────────────────────────────

export const TaskKindSchema = z.enum([
  "Workout",
  "Nutrition",
  "Hydration",
  "Mobility",
  "Recovery",
  "Habit",
  "Sleep",
]);

export const TaskPrioritySchema = z.enum(["high", "medium", "low"]);

export const ReadinessSchema  = z.enum(["Push", "Maintain", "Recover"]);
export const TimeModeSchema   = z.enum(["Full", "Condensed", "Minimal"]);
export const PlannerModeSchema = z.enum(["standard", "recovery", "minimal", "nutrition"]);

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

// ─────────────────────────────────────────────────────────────────────────────
// Planner input schema — validates POST /api/planner/generate body
// ─────────────────────────────────────────────────────────────────────────────

export const PlannerProfileSchema = z.object({
  name:               z.string().min(1).max(100),
  goal:               z.string().min(1).max(200),
  wake:               z.string().min(1).max(20),
  sleep:              z.string().min(1).max(20),
  // ── New performance profile fields ─────────────────────────────────────
  age:                z.string().max(10).optional(),
  gender:             z.enum(["male", "female", "other"]).optional(),
  height:             z.string().max(30).optional(),
  weight:             z.string().max(30).optional(),
  bodyFatPercentage:  z.string().max(20).optional(),
  gymAccess:          z.enum(["full_gym", "limited_equipment", "bodyweight_only"]).optional(),
  primaryTrainingStyle: z.enum(["athlete", "muscle", "strength", "fat_loss", "general_fitness", "calisthenics"]).optional(),
  goalType:           z.enum(["lose_fat", "build_muscle", "get_stronger", "improve_athleticism", "stay_consistent"]).optional(),
  goalNotes:          z.string().max(400).optional(),
  trainingDaysPerWeek: z.number().int().min(2).max(7).optional(),
  // ── Phase 1 additions ─────────────────────────────────────────────────
  goalUrgency:          z.enum(["gradual", "steady", "aggressive"]).optional(),
  injuries:             z.string().max(300).optional(),
  dietaryStyle:         z.enum(["everything", "vegetarian", "vegan", "pescatarian", "keto", "gluten_free"]).optional(),
  nutritionGoal:        z.enum(["fat_loss", "muscle_gain", "maintenance", "performance"]).optional(),
  mealPrepLevel:        z.enum(["minimal", "moderate", "full_prep"]).optional(),
  sleepQuality:         z.enum(["poor", "fair", "good", "great"]).optional(),
  stressLevel:          z.enum(["low", "moderate", "high", "very_high"]).optional(),
  energyBaseline:       z.enum(["low", "moderate", "high"]).optional(),
  preferredWorkoutTime: z.enum(["early_morning", "morning", "afternoon", "evening", "night"]).optional(),
  scheduleConsistency:  z.enum(["very_consistent", "somewhat_consistent", "inconsistent"]).optional(),
  // ── Food safety ────────────────────────────────────────────────────────
  foodAllergies:        z.array(z.string().max(50)).max(20).optional(),
  allergyNotes:         z.string().max(400).optional(),
  // ── Legacy fields — kept for backward compat ───────────────────────────
  startingPoint:      z.string().max(200).optional(),
  targetGoal:         z.string().max(200).optional(),
  bodyFatDirection:   z.enum(["lose_fat", "maintain", "build_lean"]).optional(),
  experienceLevel:    z.enum(["beginner", "intermediate", "advanced"]).optional(),
  equipment:          z.enum(["none", "minimal", "full_gym"]).optional(),
  workoutFrequency:   z.enum(["2x", "3x", "4x", "5x"]).optional(),
  dailyTrainingTime:  z.enum(["20min", "30min", "45min", "60min", "90min+"]).optional(),
});

export const PlannerScheduleBlockSchema = z.object({
  title: z.string().min(1).max(100),
  type:  z.string().min(1).max(50),
  start: z.string().min(1).max(20),
  end:   z.string().min(1).max(20),
});

export const PlannerScheduleSchema = z.object({
  blocks: z.array(PlannerScheduleBlockSchema).max(20).default([]),
});

export const PlannerConditionSchema = z.object({
  energyLevel:     z.enum(["low", "moderate", "high"]).nullable().optional(),
  soreness:        z.enum(["fresh", "mild", "sore"]).nullable().optional(),
  motivationLevel: z.enum(["low", "moderate", "high"]).nullable().optional(),
  timeAvailable:   z.enum(["minimal", "moderate", "full"]).nullable().optional(),
  focusArea:       z.enum(["workout", "nutrition", "consistency", "recovery"]).nullable().optional(),
});

export const TaskFeedbackEntrySchema = z.object({
  taskId:    z.string().min(1).max(100),
  title:     z.string().min(1).max(200),
  kind:      z.string().min(1).max(50),
  date:      IsoDateSchema,
  completed: z.boolean(),
  readiness: ReadinessSchema.nullable(),
});

export const PlannerBehaviorSchema = z.object({
  streak:        z.number().int().min(0).max(3650),
  score:         z.number().min(0).max(100),
  taskFeedback:  z.array(TaskFeedbackEntrySchema).max(50).optional(),
  patternHints:  z.string().max(500).optional(), // client-derived behavior pattern summary
});

export const PlannerGamePlanSchema = z
  .object({
    readiness: ReadinessSchema,
    timeMode:  TimeModeSchema,
    message:   z.string().min(1).max(600),
  })
  .nullable();

export const PlannerContextSchema = z.object({
  date:     IsoDateSchema,
  gamePlan: PlannerGamePlanSchema.optional(),
});

export const PlannerInputSchema = z
  .object({
    userId:    z.string().uuid("userId must be a valid UUID"),
    profile:   PlannerProfileSchema,
    schedule:  PlannerScheduleSchema,
    condition: PlannerConditionSchema,
    behavior:  PlannerBehaviorSchema,
    context:   PlannerContextSchema,
  });

// ─────────────────────────────────────────────────────────────────────────────
// Regenerate-specific input schema — extends PlannerInput with a reason field
// ─────────────────────────────────────────────────────────────────────────────

export const RegenerateReasonSchema = z.enum([
  "workout_missed",
  "schedule_changed",
  "condition_changed",
  "user_requested",
]);

export const RegeneratePlanInputSchema = PlannerInputSchema.extend({
  regenerateReason: RegenerateReasonSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// AI planner output schema — validates the model's JSON before storage
//
// This is the trust boundary. Nothing from the model enters storage or
// reaches the client without passing this schema first.
// ─────────────────────────────────────────────────────────────────────────────

// AI-generated exercise entry — attached to Workout tasks only
export const AIWorkoutExerciseSchema = z.object({
  name:   z.string().min(1).max(100),
  sets:   z.number().int().min(1).max(10),
  reps:   z.string().min(1).max(20),   // "10", "6-8", "AMRAP"
  rest:   z.string().max(20).optional(),
  notes:  z.string().max(300).optional(),
});

export const AITaskOutputSchema = z.object({
  id:        z.string().min(1).max(50),
  timeText:  z.string().min(1).max(20),
  title:     z.string().min(1).max(200),
  kind:      TaskKindSchema,
  priority:  TaskPrioritySchema,
  rationale: z.string().min(1).max(400),
  // Present only on Workout tasks — carries the full exercise structure
  exercises: z.array(AIWorkoutExerciseSchema).min(1).max(8).optional(),
});

export type AIWorkoutExerciseData = z.infer<typeof AIWorkoutExerciseSchema>;

export const AIPlannerOutputSchema = z
  .object({
    summary:          z.string().min(1).max(600),
    coachingNote:     z.string().min(1).max(600),
    disciplineTarget: z.string().min(1).max(300),
    fallbackPlan:     z.string().min(1).max(300),
    tasks:            z.array(AITaskOutputSchema).min(1).max(15),
  });

// Multi-day AI output — each day has its own task list and purpose label
export const AIProgramDaySchema = z.object({
  dayIndex: z.number().int().min(0).max(6),
  purpose:  z.string().max(200).optional(),
  tasks:    z.array(AITaskOutputSchema).min(1).max(15),
});

export const MultiDayAIPlannerOutputSchema = z.object({
  summary:          z.string().min(1).max(600),
  coachingNote:     z.string().min(1).max(600),
  disciplineTarget: z.string().min(1).max(300),
  fallbackPlan:     z.string().min(1).max(300),
  days:             z.array(AIProgramDaySchema).min(1).max(5),
});

// ─────────────────────────────────────────────────────────────────────────────
// Task completion PATCH body
// ─────────────────────────────────────────────────────────────────────────────

export const CompleteTaskBodySchema = z.object({
  userId: z.string().uuid(),
  done:   z.boolean(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema-inferred TypeScript types
//
// Use these as the canonical types everywhere, rather than maintaining
// parallel interface definitions. The schemas are the single source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export type PlannerInputData          = z.infer<typeof PlannerInputSchema>;
export type RegeneratePlanInputData   = z.infer<typeof RegeneratePlanInputSchema>;
export type AIPlannerOutputData       = z.infer<typeof AIPlannerOutputSchema>;
export type AITaskOutputData          = z.infer<typeof AITaskOutputSchema>;
export type AIProgramDayData          = z.infer<typeof AIProgramDaySchema>;
export type MultiDayAIPlannerOutput   = z.infer<typeof MultiDayAIPlannerOutputSchema>;
export type PlannerProfileData        = z.infer<typeof PlannerProfileSchema>;
export type PlannerConditionData      = z.infer<typeof PlannerConditionSchema>;
export type PlannerBehaviorData       = z.infer<typeof PlannerBehaviorSchema>;
export type TaskFeedbackEntryData     = z.infer<typeof TaskFeedbackEntrySchema>;
export type PlannerContextData        = z.infer<typeof PlannerContextSchema>;
export type CompleteTaskBodyData      = z.infer<typeof CompleteTaskBodySchema>;
