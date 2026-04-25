/**
 * shared/types/appTypes.ts
 *
 * App-side task and plan types shared between app/index.tsx and the
 * Aira Integration Bridge.
 *
 * Extracted from app/index.tsx so the bridge can import them without
 * a circular reference. app/index.tsx imports these instead of owning
 * local-only copies.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Task primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * High-level task category string used by the Today screen.
 * Includes legacy values "Walk" and "Meal" for backward compatibility
 * with tasks persisted to AsyncStorage before the intelligence system.
 */
export type TaskKind =
  | "Workout"
  | "Nutrition"
  | "Hydration"
  | "Mobility"
  | "Recovery"
  | "Habit"
  | "Sleep"
  | "Walk"   // legacy — kept for persisted task compat
  | "Meal";  // legacy — kept for persisted task compat

export type TaskPriority = "high" | "medium" | "low";

export type TaskTag = "carried_over" | "focus";

// AI-generated exercise — compact structure from the planner.
// Stored on TimedTask.exercises so WorkoutDetailModal can render real sessions.
export type AIWorkoutExercise = {
  name:   string;
  sets:   number;
  reps:   string;    // "10", "6-8", "8-12 reps", "AMRAP"
  rest?:  string;    // "60s", "90s", "2 min"
  notes?: string;    // one-line coaching cue
};

// ─────────────────────────────────────────────────────────────────────────────
// Core app types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single scheduled task rendered by the Today screen.
 * Sorted by timeMin (minutes since midnight) for display.
 */
export type TimedTask = {
  id:        string;
  timeMin:   number;           // minutes since midnight — sort key
  timeText:  string;           // display string, e.g. "7:00 AM"
  title:     string;
  kind:      TaskKind;
  done:      boolean;
  priority?: TaskPriority;     // optional — old persisted tasks default to "medium"
  tag?:      TaskTag;          // system-assigned label shown on the task card
  exercises?: AIWorkoutExercise[]; // only set on Workout tasks
};

/**
 * AI-generated daily plan metadata.
 * Tasks are stored separately as TimedTask[] in the `tasks` state so all
 * downstream systems (score, streak, rebalancing) work unchanged.
 */
export type AIPlan = {
  id:               string;
  date:             string;   // YYYY-MM-DD
  summary:          string;
  coachingNote:     string;
  disciplineTarget: string;
  fallbackPlan:     string;
  generatedAt:      string;   // ISO timestamp
};
