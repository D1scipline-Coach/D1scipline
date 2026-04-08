/**
 * shared/planner/types.ts
 *
 * Pure TypeScript enums and interfaces for the Aira Daily Planner.
 * No runtime dependencies — safe to import from any environment.
 *
 * Ownership model:
 *   - Every plan and task carries `userId`.
 *   - All reads and writes are keyed by `userId` on the server.
 *   - The client never receives records belonging to another user.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export enum TaskKind {
  Workout   = "Workout",
  Nutrition = "Nutrition",
  Hydration = "Hydration",
  Mobility  = "Mobility",
  Recovery  = "Recovery",
  Habit     = "Habit",
  Sleep     = "Sleep",
}

export enum TaskPriority {
  High   = "high",
  Medium = "medium",
  Low    = "low",
}

export enum PlannerReadiness {
  Push     = "Push",
  Maintain = "Maintain",
  Recover  = "Recover",
}

export enum PlannerTimeMode {
  Full      = "Full",
  Condensed = "Condensed",
  Minimal   = "Minimal",
}

/**
 * PlannerMode drives agent selection.
 * Future: pass to `selectPlannerAgent(mode)` to route to a specialised prompt.
 */
export enum PlannerMode {
  Standard  = "standard",
  Recovery  = "recovery",
  Minimal   = "minimal",
  Nutrition = "nutrition",
}

/**
 * RegenerateReason records why a plan was replaced.
 * Stored on the new plan for future memory/history features.
 */
export enum RegenerateReason {
  WorkoutMissed    = "workout_missed",
  ScheduleChanged  = "schedule_changed",
  ConditionChanged = "condition_changed",
  UserRequested    = "user_requested",
}

// ─────────────────────────────────────────────────────────────────────────────
// Planner input — what the client sends to the planner API
// ─────────────────────────────────────────────────────────────────────────────

export interface PlannerProfile {
  name:               string;
  goal:               string;
  wake:               string;
  sleep:              string;
  startingPoint?:     string;
  targetGoal?:        string;
  bodyFatDirection?:  "lose_fat" | "maintain" | "build_lean";
  experienceLevel?:   "beginner" | "intermediate" | "advanced";
  equipment?:         "none" | "minimal" | "full_gym";
  workoutFrequency?:  "2x" | "3x" | "4x" | "5x";
  dailyTrainingTime?: "20min" | "30min" | "45min" | "60min";
}

export interface PlannerScheduleBlock {
  title: string;
  type:  string;
  start: string; // "HH:MM AM/PM"
  end:   string; // "HH:MM AM/PM"
}

export interface PlannerSchedule {
  blocks: PlannerScheduleBlock[];
}

export interface PlannerCondition {
  energyLevel?:     "low" | "moderate" | "high" | null;
  soreness?:        "fresh" | "mild" | "sore"    | null;
  motivationLevel?: "low" | "moderate" | "high" | null;
  timeAvailable?:   "minimal" | "moderate" | "full" | null;
  focusArea?:       "workout" | "nutrition" | "consistency" | "recovery" | null;
}

export interface PlannerTaskFeedbackEntry {
  taskId:    string;
  title:     string;
  kind:      string;
  date:      string;            // YYYY-MM-DD
  completed: boolean;
  readiness: PlannerReadiness | null;
}

export interface PlannerBehavior {
  streak:       number;
  score:        number;         // 0–100, priority-weighted
  taskFeedback?: PlannerTaskFeedbackEntry[];
}

export interface PlannerGamePlan {
  readiness: PlannerReadiness;
  timeMode:  PlannerTimeMode;
  message:   string;
}

export interface PlannerContext {
  date:      string;                      // YYYY-MM-DD
  gamePlan?: PlannerGamePlan | null;
}

/** Complete input to POST /api/planner/generate and POST /api/planner/regenerate. */
export interface PlannerInput {
  userId:    string;
  profile:   PlannerProfile;
  schedule:  PlannerSchedule;
  condition: PlannerCondition;
  behavior:  PlannerBehavior;
  context:   PlannerContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI output — the raw JSON shape the model must return.
// Validated by AIPlannerOutputSchema before any record is stored.
// ─────────────────────────────────────────────────────────────────────────────

export interface AITaskOutput {
  id:        string;
  timeText:  string;  // "7:00 AM"
  title:     string;
  kind:      TaskKind;
  priority:  TaskPriority;
  rationale: string;
}

export interface AIPlannerOutput {
  summary:          string;
  coachingNote:     string;
  disciplineTarget: string;
  fallbackPlan:     string;
  tasks:            AITaskOutput[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Stored records — what the server saves and the client reads.
// These are the authoritative shapes after AI output is validated and transformed.
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyPlan {
  id:               string;
  userId:           string;
  date:             string;     // YYYY-MM-DD
  summary:          string;
  coachingNote:     string;
  disciplineTarget: string;
  fallbackPlan:     string;
  generatedAt:      string;     // ISO timestamp
  mode:             PlannerMode;
  previousPlanId?:  string;     // set on regeneration — links to replaced plan
  regenerateReason?: RegenerateReason;
}

export interface DailyTask {
  id:          string;
  planId:      string;
  userId:      string;
  date:        string;          // YYYY-MM-DD
  timeText:    string;
  title:       string;
  kind:        TaskKind;
  priority:    TaskPriority;
  rationale:   string;
  done:        boolean;
  completedAt: string | null;   // ISO timestamp or null
}
