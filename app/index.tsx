import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import React, { useEffect, useMemo, useState } from "react";
import AuthScreen from "../components/AuthScreen";
import { getAccessToken, loadSession, signOut as authSignOut, type AuthUser } from "../lib/auth";
import { loadUserData, saveUserData } from "../lib/db";
import {
  ActivityIndicator,
  Animated,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { API_BASE_URL } from "../constants/api";

// ---------- Storage keys ----------
const STORE = {
  profile:        "dc:profile",
  blocks:         "dc:blocks",
  tasks:          "dc:tasks",
  chat:           "dc:chat",
  motivationDate: "dc:motivation_date",
  streak:         "dc:streak",
  recovery:       "dc:recovery",
  history:        "dc:history",
  feedback:       "dc:feedback",
} as const;


/**
 * Discipline Coach — Notifications MVP
 * - Schedule blocks
 * - Timeline plan generator
 * - Local notifications for today's tasks
 * - "Test reminder (30s)" button to verify notifications immediately
 *
 * Uses Expo Router (this file is the route at /).
 */

// ---------- Types ----------
type Profile = {
  name: string;
  goal: string;
  wake: string;
  sleep: string;
  startingPoint?:    string;
  targetGoal?:       string;
  bodyFatDirection?: "lose_fat" | "maintain" | "build_lean";
  experienceLevel?:  "beginner" | "intermediate" | "advanced";
  equipment?:        "none" | "minimal" | "full_gym";
  workoutFrequency?: "2x" | "3x" | "4x" | "5x";
  dailyTrainingTime?:"20min" | "30min" | "45min" | "60min";
};

type DayLog     = { date: string; score: number; tasksTotal: number; tasksDone: number };
type StreakData  = { currentStreak: number; bestStreak: number; lastActiveDate: string };
type RecoveryData = {
  date:               string;
  energyLevel:        "low" | "moderate" | "high" | null;
  soreness?:          "fresh" | "mild" | "sore" | null;
  motivationLevel?:   "low" | "moderate" | "high" | null;
  timeAvailable?:     "minimal" | "moderate" | "full" | null;
  scheduleTightness?: "open" | "normal" | "tight" | null; // kept for backward compat
  focusArea?:         "workout" | "nutrition" | "consistency" | "recovery" | null;
};

type BlockType = "Work" | "School" | "Kids" | "Commute" | "Other";
type ScheduleBlock = {
  id: string;
  title: string;
  type: BlockType;
  startText: string;
  endText: string;
  startMin: number;
  endMin: number;
};

type TaskKind =
  | "Workout"
  | "Nutrition"
  | "Hydration"
  | "Mobility"
  | "Recovery"
  | "Habit"
  | "Sleep"
  | "Walk"   // legacy — kept for persisted task compat
  | "Meal";  // legacy — kept for persisted task compat

type TaskPriority = "high" | "medium" | "low";

type TimedTask = {
  id: string;
  timeMin: number;
  timeText: string;
  title: string;
  kind: TaskKind;
  done: boolean;
  priority?: TaskPriority; // optional — old persisted tasks without it default to "medium"
};

// Tracks the outcome of each high-priority task for the current day.
// `completed: true`  = user marked it done.
// `completed: false` = user marked it undone (reversal) or it was never completed.
// Keyed by taskId — toggling back and forth overwrites the same entry cleanly.
type TaskFeedbackEntry = {
  taskId:    string;
  title:     string;
  kind:      TaskKind;
  date:      string;                       // YYYY-MM-DD
  completed: boolean;
  readiness: GamePlan["readiness"] | null; // game plan context at time of toggle
};
type TaskFeedbackMap = Record<string, TaskFeedbackEntry>;

// AI-generated daily plan metadata. Tasks are stored as TimedTask in the
// existing `tasks` state so all downstream systems (score, streak, rebalancing)
// work unchanged.
type AIPlan = {
  id:               string;
  date:             string;   // YYYY-MM-DD
  summary:          string;
  coachingNote:     string;
  disciplineTarget: string;
  fallbackPlan:     string;
  generatedAt:      string;   // ISO timestamp
};

// ---------- Workout session types ----------
// V1 data structure — ready for planner-linked data when the backend supports it.
// Replace getWorkoutForTask() to connect to real data without touching this schema.
type ExerciseSet = {
  set_number:    number;
  reps:          number;
  target_weight: string | null; // e.g. "80kg", "bodyweight", null = not prescribed
};

type WorkoutExercise = {
  id:           string;
  name:         string;
  sets:         ExerciseSet[];
  rest_seconds: number;
  cue:          string;
};

type WorkoutSession = {
  workout_id:       string;
  title:            string;
  duration_minutes: number;
  focus:            string;     // e.g. "Chest, Shoulders & Triceps"
  exercises:        WorkoutExercise[];
};

type TabKey = "Today" | "Schedule" | "Chat" | "Progress" | "Settings";

// ---------- Helpers ----------
function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function parseTimeToMinutes(input: string): number | null {
  const raw = input.trim().toUpperCase();
  if (!raw) return null;

  const hasAm = raw.includes("AM");
  const hasPm = raw.includes("PM");

  let cleaned = raw.replace(/[^0-9:]/g, "");

  if (!cleaned.includes(":") && cleaned.length === 4) {
    cleaned = `${cleaned.slice(0, 2)}:${cleaned.slice(2)}`;
  } else if (!cleaned.includes(":") && cleaned.length <= 2) {
    cleaned = `${cleaned}:00`;
  }

  const parts = cleaned.split(":");
  if (parts.length !== 2) return null;

  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (m < 0 || m > 59) return null;

  let hour = h;

  if (hasAm || hasPm) {
    if (hour < 1 || hour > 12) return null;
    if (hasAm) {
      if (hour === 12) hour = 0;
    } else {
      if (hour !== 12) hour += 12;
    }
  } else {
    if (hour < 0 || hour > 23) return null;
  }

  return hour * 60 + m;
}

function minutesToTimeText(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const hour24 = Math.floor(m / 60);
  const minute = m % 60;
  const ampm = hour24 >= 12 ? "PM" : "AM";
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return `${hour12}:${pad2(minute)} ${ampm}`;
}

function overlapsBlock(t: number, block: ScheduleBlock): boolean {
  return t >= block.startMin && t < block.endMin;
}

function isBlocked(t: number, blocks: ScheduleBlock[]): boolean {
  return blocks.some((b) => overlapsBlock(t, b));
}

function nextFreeMinute(start: number, blocks: ScheduleBlock[], sleepMin: number): number | null {
  let t = start;
  while (t < sleepMin) {
    if (!isBlocked(t, blocks)) return t;
    t += 5;
  }
  return null;
}

function buildTodaysPlan(params: {
  wakeMin: number;
  sleepMin: number;
  blocks: ScheduleBlock[];
  profile?: Profile;
}): TimedTask[] {
  const { wakeMin, sleepMin, blocks, profile } = params;
  const dayLen = sleepMin - wakeMin;
  const tg  = profile?.targetGoal       ?? "";
  const bfd = profile?.bodyFatDirection ?? "";
  const exp = profile?.experienceLevel  ?? "";
  const eq  = profile?.equipment        ?? "";
  const dur = profile?.dailyTrainingTime ?? "";

  // Experience-aware prefix
  const expPrefix =
    exp === "beginner" ? "Foundation workout" :
    exp === "advanced" ? "Advanced workout"   : "Morning workout";

  // Equipment context
  const eqSuffix =
    eq === "none"     ? " — bodyweight only"       :
    eq === "minimal"  ? " — dumbbells & bands"     :
    eq === "full_gym" ? " — barbell & machines"    : "";

  // Duration string
  const durStr =
    dur === "20min" ? "20 min" :
    dur === "30min" ? "30 min" :
    dur === "45min" ? "45 min" :
    dur === "60min" ? "60 min" : "30 min";

  // Style/intensity based on target goal
  const styleStr =
    tg === "model_build"      ? "compound lifts"          :
    tg === "athletic_strong"  ? "strength + conditioning" :
    tg === "shredded"         ? "high-intensity circuits" :
    tg === "lean_defined"     ? "circuit training"        : "full-body";

  const workoutTitle = `${expPrefix} — ${styleStr}${eqSuffix} — ${durStr}`;

  // Nutrition direction from bodyFatDirection
  const nutritionSuffix =
    bfd === "lose_fat"   ? "stay in deficit"          :
    bfd === "build_lean" ? "slight surplus, high protein" :
    bfd === "maintain"   ? "maintenance calories"     : "high protein";

  const postWorkoutTitle =
    tg === "athletic_strong" ? `Performance meal — protein + quality carbs, ${nutritionSuffix}` :
                               `Post-workout meal — ${nutritionSuffix}`;

  const leanMealTitle =
    bfd === "lose_fat"   ? "Lean meal — protein + veg, caloric deficit" :
    bfd === "build_lean" ? "Lean meal — protein + complex carbs, slight surplus" :
                           "Lean meal — protein + complex carbs";

  // frac = fraction of day length (0.0–1.0); Sleep uses sleepMin - 45 directly
  // priority determines which tasks survive when timeMode filters the plan
  const desired: { kind: TaskKind; title: string; frac: number | null; priority: TaskPriority }[] = [
    { kind: "Hydration", title: "Morning hydration — drink 16oz water",     frac: 0.03,  priority: "medium" },
    { kind: "Workout",   title: workoutTitle,                                frac: 0.10,  priority: "high"   },
    { kind: "Nutrition", title: postWorkoutTitle,                            frac: 0.20,  priority: "high"   },
    { kind: "Hydration", title: "Midday hydration — 16oz water",            frac: 0.42,  priority: "low"    },
    { kind: "Nutrition", title: leanMealTitle,                               frac: 0.55,  priority: "medium" },
    { kind: "Mobility",  title: "Mobility & stretch — 10 min",              frac: 0.72,  priority: "medium" },
    { kind: "Recovery",  title: "Recovery block — foam roll or breath work", frac: 0.83,  priority: "medium" },
    { kind: "Sleep",     title: "Wind-down — screens off, sleep prep",       frac: null,  priority: "high"   },
  ];

  // Place each task at its proportional position, skipping blocks
  const placed: TimedTask[] = [];
  for (let i = 0; i < desired.length; i++) {
    const d = desired[i];
    const idealMin =
      d.frac === null
        ? sleepMin - 45
        : wakeMin + Math.round(d.frac * dayLen);
    const target = clamp(idealMin, wakeMin, sleepMin - 5);
    const free = nextFreeMinute(target, blocks, sleepMin);
    if (free == null) continue;
    placed.push({
      id: `task_${Date.now()}_${i}`,
      timeMin: free,
      timeText: minutesToTimeText(free),
      title: d.title,
      kind: d.kind,
      done: false,
      priority: d.priority,
    });
  }

  placed.sort((a, b) => a.timeMin - b.timeMin);

  // Spread-forward: instead of silently dropping tasks that land too close,
  // push each one to the next free slot at least MIN_GAP minutes after the previous.
  const MIN_GAP = 20;
  const spread: TimedTask[] = [];
  for (const t of placed) {
    const prev = spread[spread.length - 1];
    const earliest = prev ? prev.timeMin + MIN_GAP : wakeMin;
    if (t.timeMin >= earliest) {
      spread.push(t);
    } else {
      // Re-anchor to the next free slot from earliest
      const reanchored = nextFreeMinute(earliest, blocks, sleepMin);
      if (reanchored != null && reanchored < sleepMin - 5) {
        spread.push({ ...t, timeMin: reanchored, timeText: minutesToTimeText(reanchored) });
      }
      // If no free slot before sleep, task is omitted (day is genuinely too packed)
    }
  }

  return spread;
}

// V1 Discipline Score — flat-point system tied to daily execution.
//
// Required tasks (high priority):  +15 pts each
// Optional tasks (medium/low):     +5 pts each
// All-required-complete bonus:     +10 pts
// Cap:                             100 pts
//
// "Required" = high priority tasks the AI flagged as non-negotiable for the day.
// Modular: swap point values or add bonuses here without touching UI or state.
const SCORE_POINTS = {
  required: 15,   // high priority task completed
  optional:  5,   // medium or low priority task completed
  allRequiredBonus: 10,
  cap: 100,
} as const;

function calcScore(tasks: TimedTask[]): number {
  if (!tasks.length) return 0;

  const required = tasks.filter((t) => (t.priority ?? "medium") === "high");
  const optional = tasks.filter((t) => (t.priority ?? "medium") !== "high");

  const requiredDone = required.filter((t) => t.done);
  const optionalDone = optional.filter((t) => t.done);

  let pts = requiredDone.length * SCORE_POINTS.required
          + optionalDone.length * SCORE_POINTS.optional;

  if (required.length > 0 && requiredDone.length === required.length) {
    pts += SCORE_POINTS.allRequiredBonus;
  }

  return Math.min(pts, SCORE_POINTS.cap);
}

// ─── Dev Mock Planner Data ───────────────────────────────────────────────────
// Renders the Today screen with sample data when no real plan is available.
// Only activates in __DEV__ builds. Set DEV_MOCK_ENABLED = false to disable.
// Remove this entire block when mock data is no longer needed.
const DEV_MOCK_ENABLED = true;

const DEV_MOCK_PLAN: AIPlan = {
  id:               "dev-mock-plan",
  date:             new Date().toISOString().slice(0, 10),
  summary:          "Strength focus day. Hit your workout early, keep nutrition on point, and close the day with a solid sleep routine.",
  coachingNote:     "You don't need to feel motivated to start — you need to start to feel motivated. One task at a time.",
  disciplineTarget: "Complete all three required tasks before 6 PM.",
  fallbackPlan:     "If the day falls apart: 10 minutes of mobility, one solid meal, and 8 hours of sleep. That's enough.",
  generatedAt:      new Date().toISOString(),
};

const DEV_MOCK_TASKS: TimedTask[] = [
  { id: "mock_t0", timeMin: 360,  timeText: "6:00 AM",  title: "Morning workout — push A",          kind: "Workout",   priority: "high",   done: false },
  { id: "mock_t1", timeMin: 480,  timeText: "8:00 AM",  title: "High-protein breakfast",             kind: "Nutrition", priority: "high",   done: false },
  { id: "mock_t2", timeMin: 720,  timeText: "12:00 PM", title: "Midday walk — 20 minutes",           kind: "Mobility",  priority: "medium", done: false },
  { id: "mock_t3", timeMin: 780,  timeText: "1:00 PM",  title: "Lunch — lean protein + vegetables", kind: "Nutrition", priority: "medium", done: false },
  { id: "mock_t4", timeMin: 1080, timeText: "6:00 PM",  title: "Hydration — hit 3L today",           kind: "Hydration", priority: "low",    done: false },
  { id: "mock_t5", timeMin: 1320, timeText: "10:00 PM", title: "Wind-down & sleep by 10:30",         kind: "Sleep",     priority: "high",   done: false },
];
// ─── Dev Mock Workout Data ───────────────────────────────────────────────────
// Full workout session used when no planner-linked workout exists.
// Replace getWorkoutForTask() below to swap in real data — no other changes needed.
const DEV_MOCK_WORKOUT: WorkoutSession = {
  workout_id:       "mock-push-a",
  title:            "Push A — Chest, Shoulders & Triceps",
  duration_minutes: 45,
  focus:            "Chest, Shoulders & Triceps",
  exercises: [
    {
      id: "ex1",
      name: "Barbell Bench Press",
      sets: [
        { set_number: 1, reps: 8,  target_weight: "60kg" },
        { set_number: 2, reps: 8,  target_weight: "70kg" },
        { set_number: 3, reps: 6,  target_weight: "80kg" },
        { set_number: 4, reps: 6,  target_weight: "80kg" },
      ],
      rest_seconds: 90,
      cue: "Control the descent — 3 seconds down, drive up explosively. Keep shoulder blades pinched.",
    },
    {
      id: "ex2",
      name: "Incline Dumbbell Press",
      sets: [
        { set_number: 1, reps: 10, target_weight: "24kg" },
        { set_number: 2, reps: 10, target_weight: "28kg" },
        { set_number: 3, reps: 8,  target_weight: "28kg" },
      ],
      rest_seconds: 75,
      cue: "Slight arch, elbows at 45°. Full stretch at the bottom — don't bounce.",
    },
    {
      id: "ex3",
      name: "Overhead Press",
      sets: [
        { set_number: 1, reps: 10, target_weight: "40kg" },
        { set_number: 2, reps: 8,  target_weight: "45kg" },
        { set_number: 3, reps: 8,  target_weight: "45kg" },
      ],
      rest_seconds: 90,
      cue: "Bar path should travel straight up — tuck your chin on the way, push your face through at the top.",
    },
    {
      id: "ex4",
      name: "Cable Lateral Raise",
      sets: [
        { set_number: 1, reps: 15, target_weight: "8kg" },
        { set_number: 2, reps: 15, target_weight: "8kg" },
        { set_number: 3, reps: 12, target_weight: "10kg" },
      ],
      rest_seconds: 60,
      cue: "Lead with your elbows, not your wrists. Pause at the top for one second.",
    },
    {
      id: "ex5",
      name: "Tricep Pushdown",
      sets: [
        { set_number: 1, reps: 15, target_weight: null },
        { set_number: 2, reps: 15, target_weight: null },
        { set_number: 3, reps: 12, target_weight: null },
      ],
      rest_seconds: 60,
      cue: "Keep elbows pinned to your sides. Full lockout at the bottom — squeeze and hold.",
    },
  ],
};

/**
 * Resolve a TimedTask to a WorkoutSession.
 * V1: always returns the mock session. When the backend supplies planner-linked
 * workouts, fetch/look up by task.id or task.planId here — no other code changes.
 */
function getWorkoutForTask(_task: TimedTask): WorkoutSession {
  return DEV_MOCK_WORKOUT;
}
// ─────────────────────────────────────────────────────────────────────────────

// ---------- Game Plan ----------
//
// generateGamePlan is the single entry point for today's coaching directive.
// All logic lives here so it can be unit-tested, audited, or replaced with
// an AI call without touching the UI or state management.
//
// To connect to chat: pass gamePlan.readiness, gamePlan.timeMode, and
// gamePlan.message in the checkIn payload sent to the server.
//
// To connect to tasks: use readiness to adjust generated plan intensity and
// timeMode to filter which task categories appear.

type GamePlan = {
  readiness: "Push" | "Maintain" | "Recover";
  timeMode:  "Full" | "Condensed" | "Minimal";
  color:     string;
  message:   string; // 1–2 sentence coaching directive
};

function generateGamePlan(r: RecoveryData): GamePlan {
  const energy     = r.energyLevel     ?? "moderate";
  const motivation = r.motivationLevel ?? "moderate";
  const sore       = r.soreness        ?? "mild";
  const focus      = r.focusArea       ?? null;

  // Derive time from explicit field, fall back to legacy scheduleTightness
  const time =
    r.timeAvailable ??
    (r.scheduleTightness === "tight" ? "minimal" :
     r.scheduleTightness === "open"  ? "full"    : "moderate");

  // Time mode — drives session structure and message tone
  const timeMode: GamePlan["timeMode"] =
    time === "minimal" ? "Minimal" :
    time === "full"    ? "Full"    :
    "Condensed";

  // ── Readiness decision ─────────────────────────────────────────────────
  const isRecover =
    energy === "low"   ||
    motivation === "low" ||
    sore === "sore"    ||
    time === "minimal" ||
    focus === "recovery";

  const isPush =
    energy === "high"     &&
    motivation === "high" &&
    (sore === "fresh" || sore === "mild") &&
    time !== "minimal";

  // ── Message matrix (readiness × leading signal × time mode) ───────────
  let message: string;

  if (isRecover) {
    if (sore === "sore") {
      message = "Your body is flagging soreness — skip the intensity. Mobility, hydration, and clean nutrition are the work today.";
    } else if (energy === "low" && motivation === "low") {
      message = "Both energy and drive are down. Hit the minimum effective dose, nail your nutrition, and make sleep the priority tonight.";
    } else if (energy === "low") {
      message = "Low energy is a signal, not an excuse. Keep effort light, execute your nutrition plan, and protect tonight's sleep.";
    } else if (motivation === "low") {
      message = "Motivation is low — that's when discipline matters most. Do the minimum, tick the boxes, and show up again tomorrow.";
    } else if (time === "minimal") {
      message = "Under 30 minutes — pick the single highest-value task, execute it cleanly, then protect your recovery window.";
    } else {
      message = timeMode === "Full"
        ? "Recovery day with a full window available. Do it properly — mobility work, breathwork, and a dialled-in nutrition block."
        : "Recovery focus today. Prioritise mobility, hydration, and clean meals over any additional intensity.";
    }
    return { readiness: "Recover", timeMode, color: "#FF9800", message };
  }

  if (isPush) {
    if (focus === "nutrition") {
      message = timeMode === "Full"
        ? "You're locked in with a full day ahead — nail every meal, hit your protein target, and treat nutrition like a training session."
        : "Fired up and fuelled. Build your meals around the session window — this is where the real physique change happens.";
    } else {
      message = timeMode === "Full"
        ? "All systems green and a full session ahead. Hit the workout hard — heavier loads, tighter rest periods, nothing left in the tank."
        : "Dialled in with time to work. Lead with the compound movements, push the intensity, and make every rep count.";
    }
    return { readiness: "Push", timeMode, color: "#66bb6a", message };
  }

  // Maintain
  if (focus === "nutrition") {
    message = "Solid day to lock in your nutrition. Hit every meal window, reach your protein target, and stay ahead on hydration.";
  } else if (focus === "consistency") {
    message = "Consistency is the job today — not heroics. Complete every task in the plan exactly as written.";
  } else {
    message =
      timeMode === "Full"      ? "Solid baseline with a full session. Execute the plan methodically — clean completion beats skipped heroics." :
      timeMode === "Condensed" ? "About an hour to work with — lead with the workout, then sort nutrition. Clean execution over perfection." :
                                 "Tight window, but discipline counts. Hit the highest-value task and build on yesterday's momentum.";
  }
  return { readiness: "Maintain", timeMode, color: ACCENT, message };
}

// adaptTasksForPlan returns the subset of tasks that should be visible on the
// Today screen given the current game plan. It never mutates `tasks`.
// Score, streak, and chat always receive the full task list.
function adaptTasksForPlan(tasks: TimedTask[], plan: GamePlan | null): TimedTask[] {
  if (!plan) return tasks; // no check-in yet — show everything

  // Minimal mode: show only high-priority tasks (and already-done tasks)
  if (plan.timeMode === "Minimal") {
    return tasks.filter((t) => t.done || (t.priority ?? "medium") === "high");
  }

  // Recover readiness: hide low-priority tasks
  if (plan.readiness === "Recover") {
    return tasks.filter((t) => t.done || (t.priority ?? "medium") !== "low");
  }

  // Condensed mode (non-Recover): show high + medium only
  if (plan.timeMode === "Condensed") {
    return tasks.filter((t) => t.done || (t.priority ?? "medium") !== "low");
  }

  // Push / Full — show everything
  return tasks;
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

// selectTopPriorities picks the top 2–3 undone tasks from the already-adapted
// visible list. It does not re-filter or re-adapt — it only sorts and caps.
// Passing visibleTasks (not tasks) ensures the priorities respect the game plan.
function selectTopPriorities(visibleTasks: TimedTask[]): TimedTask[] {
  return visibleTasks
    .filter((t) => !t.done)
    .sort((a, b) => PRIORITY_ORDER[a.priority ?? "medium"] - PRIORITY_ORDER[b.priority ?? "medium"])
    .slice(0, 3);
}

// rebalanceTasks adjusts task priorities based on explicit user feedback signals.
// It NEVER filters tasks — only priority values are changed. Filtering is
// adaptTasksForPlan's job.
//
// "Missed" = feedback entry exists with completed: false (user explicitly unchecked
// a previously-checked task). Tasks that were never touched have no feedback entry
// and are left as-is.
//
// Rules:
//   Nutrition / Sleep missed → keep "high" (time-sensitive, always critical)
//   Workout missed, tight window (Condensed/Minimal) → "low" (window is gone)
//   Workout missed, open window (Full) → "medium" (may still fit later)
//   Any other kind missed → "medium"
function rebalanceTasks(
  tasks:    TimedTask[],
  feedback: TaskFeedbackMap | null | undefined,
  gamePlan: GamePlan | null
): TimedTask[] {
  if (!feedback) return tasks; // guard: feedback not yet loaded
  return tasks.map((t) => {
    const entry = feedback[t.id];
    // No feedback, or the feedback says it was completed — nothing to rebalance.
    if (!entry || entry.completed) return t;

    const timeMode        = gamePlan?.timeMode ?? "Full";
    const currentPriority = t.priority ?? "medium";

    // Already at the floor — no further downgrade.
    if (currentPriority === "low") return t;

    // Nutrition and Sleep are non-negotiable regardless of the missed signal.
    if (t.kind === "Nutrition" || t.kind === "Sleep") return t;

    if (t.kind === "Workout") {
      const newPriority: TaskPriority =
        (timeMode === "Condensed" || timeMode === "Minimal") ? "low" : "medium";
      return { ...t, priority: newPriority };
    }

    // All other kinds: one step down from high → medium.
    return { ...t, priority: "medium" };
  });
}

function dateForDayAtMinutes(minSinceMidnight: number, dayOffset: 0 | 1) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  d.setMinutes(minSinceMidnight);
  return d;
}

// ---------- Design tokens ----------
const ACCENT = "#6C63FF"; // electric indigo — blue-purple neon

// ---------- Kind pill colours ----------
const KIND_COLORS: Partial<Record<TaskKind, { color: string; borderColor: string; backgroundColor: string }>> = {
  Workout:   { color: "#a89fff", borderColor: "#4a44cc", backgroundColor: "#0e0c2a" },
  Nutrition: { color: "#66bb6a", borderColor: "#2e6b31", backgroundColor: "#0a1f0b" },
  Hydration: { color: "#42a5f5", borderColor: "#1a4d7a", backgroundColor: "#081828" },
  Mobility:  { color: "#ffa040", borderColor: "#7a4010", backgroundColor: "#1f1000" },
  Recovery:  { color: "#ce93d8", borderColor: "#5a2e6b", backgroundColor: "#1a0a20" },
  Habit:     { color: "#ef9a9a", borderColor: "#6b2020", backgroundColor: "#200a0a" },
  Sleep:     { color: "#90a4ae", borderColor: "#2e3f47", backgroundColor: "#0a1015" },
};


// ---------- Nutrition guidance ----------
type NutritionGuide = { protein: string; hydration: string; priority: string };

const TARGET_GOAL_LABELS: Record<string, string> = {
  lean_defined:    "Lean & Defined",
  model_build:     "Model Build",
  athletic_strong: "Athletic & Strong",
  shredded:        "Shredded",
};

const NUTRITION_GUIDANCE: Record<string, NutritionGuide> = {
  lean_defined: {
    protein:   "0.8–1g per lb of bodyweight daily. Best sources: chicken, eggs, fish, Greek yogurt.",
    hydration: "Target 80–100oz of water daily. Start with 16oz before your first meal.",
    priority:  "Eat in a moderate calorie deficit. Don't skip breakfast — it anchors your appetite for the day.",
  },
  model_build: {
    protein:   "1–1.2g per lb of bodyweight. High protein is non-negotiable for this physique.",
    hydration: "Minimum 100oz daily. Add electrolytes if you're training hard.",
    priority:  "Time protein around workouts. Eat your largest meal within 2 hours post-training.",
  },
  athletic_strong: {
    protein:   "1–1.2g per lb of bodyweight. Don't underfuel — performance requires adequate intake.",
    hydration: "100–120oz daily. Hydrate before, during, and after every session.",
    priority:  "Don't fear carbs around training. They fuel output and recovery.",
  },
  shredded: {
    protein:   "1.2–1.5g per lb of bodyweight. High protein protects muscle during a deep cut.",
    hydration: "100oz minimum. Water helps curb hunger during a deficit.",
    priority:  "Calorie deficit is the driver. Track intake and cut ultra-processed foods first.",
  },
};

const DEFAULT_NUTRITION: NutritionGuide = {
  protein:   "Aim for 0.8–1g of protein per lb of bodyweight daily.",
  hydration: "Target 80–100oz of water. Start your morning with at least 16oz.",
  priority:  "Prioritize whole foods and consistent meal timing to support your routine.",
};

// ---------- Leaderboard ----------
type LeaderboardEntry = {
  id: string;
  name: string;
  currentStreak: number;
  bestStreak: number;
  isMe: boolean;
};

const SAMPLE_USERS: Omit<LeaderboardEntry, "isMe">[] = [
  { id: "u1", name: "Marcus",  currentStreak: 12, bestStreak: 19 },
  { id: "u2", name: "Jordan",  currentStreak: 7,  bestStreak: 14 },
  { id: "u3", name: "Taylor",  currentStreak: 4,  bestStreak: 11 },
  { id: "u4", name: "Riley",   currentStreak: 2,  bestStreak: 7  },
  { id: "u5", name: "Alex",    currentStreak: 0,  bestStreak: 5  },
  { id: "u6", name: "Morgan",  currentStreak: 1,  bestStreak: 3  },
];

// ---------- Styles ----------
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000", padding: 16, gap: 12 },

  h1: { color: "#fff", fontSize: 34, fontWeight: "800" },
  h2: { color: "#fff", fontSize: 26, fontWeight: "800" },
  sub: { color: "#bdbdbd", fontSize: 14, marginBottom: 6 },
  sub2: { color: "#bdbdbd", fontSize: 13, marginBottom: 6 },

  card: { backgroundColor: "#121212", borderRadius: 16, padding: 14, borderWidth: 1, borderColor: "#1a1a2e", gap: 8 },

  label: { color: "#fff", fontSize: 14, fontWeight: "700" },
  smallLabel: { color: "#bdbdbd", fontSize: 12, fontWeight: "700", marginTop: 4 },
  bodyMuted: { color: "#bdbdbd", fontSize: 13, lineHeight: 18 },
  miniNote: { color: "#777", fontSize: 12, lineHeight: 16 },

  input: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 12, padding: 12, color: "#fff" },

  primaryBtn: { backgroundColor: ACCENT, padding: 14, borderRadius: 14, alignItems: "center", width: "100%" },
  primaryBtnText: { color: "#ffffff", fontWeight: "800", fontSize: 14 },

  smallBtn: {
    backgroundColor: "#0f0f0f",
    borderWidth: 1,
    borderColor: "#262626",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    flex: 1,
    alignItems: "center",
  },
  smallBtnText: { color: "#fff", fontWeight: "900", fontSize: 12 },

  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },

  chip: { backgroundColor: "#12122a", paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: "#3d3b8e" },
  chipText: { color: "#fff", fontWeight: "800", fontSize: 12 },

  linkBtn: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#2d2b5a", borderRadius: 12, paddingVertical: 8, paddingHorizontal: 10 },
  linkText: { color: ACCENT, fontWeight: "900", fontSize: 12 },

  timelineRow: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 14, padding: 12, flexDirection: "row", justifyContent: "space-between", gap: 10 },
  timelineRowDone: { borderColor: "#3a3a3a", opacity: 0.92 },
  timelineLeft: { flex: 1, gap: 4 },
  timelineRight: { alignItems: "flex-end", gap: 6, justifyContent: "center" },

  timeText: { color: "#fff", fontWeight: "900", fontSize: 12 },
  taskText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  taskTextDone: { color: "#bdbdbd", textDecorationLine: "line-through" },
  taskTap: { color: "#777", fontSize: 12, fontWeight: "800" },

  kindPill: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "900",
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#2d2b5a",
    backgroundColor: "#0e0e20",
    overflow: "hidden",
  },

  typeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  typeBtn: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12 },
  typeBtnActive: { backgroundColor: "#ffffff", borderColor: "#ffffff" },
  typeText: { color: "#bdbdbd", fontWeight: "900", fontSize: 12 },
  typeTextActive: { color: "#0b0b0b" },

  blockRow: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 14, padding: 12, flexDirection: "row", gap: 10, alignItems: "center" },
  blockTitle: { color: "#fff", fontWeight: "900", fontSize: 13 },

  removeBtn: { backgroundColor: "#141414", borderWidth: 1, borderColor: "#2a2a2a", borderRadius: 12, paddingVertical: 8, paddingHorizontal: 10 },
  removeText: { color: "#fff", fontWeight: "900", fontSize: 12 },

  tabBar: { flexDirection: "row", gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#1e1e1e" },
  tabBtn: { flex: 1, backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 14, paddingVertical: 10, alignItems: "center" },
  tabBtnActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  tabText: { color: "#bdbdbd", fontWeight: "900", fontSize: 11 },
  tabTextActive: { color: "#ffffff" },
});

// ---------- UI ----------
function Card({ children, style }: { children: React.ReactNode; style?: any }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function PrimaryButton({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.primaryBtn, disabled && { opacity: 0.5 }]}>
      <Text style={styles.primaryBtnText}>{title}</Text>
    </Pressable>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{label}</Text>
    </View>
  );
}

function SmallButton({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.smallBtn}>
      <Text style={styles.smallBtnText}>{title}</Text>
    </Pressable>
  );
}

function Splash() {
  const fadeAnim = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 480,
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />

      <Animated.View style={{ alignItems: "center", opacity: fadeAnim }}>
        {/* Icon mark */}
        <View style={{
          width: 76,
          height: 76,
          borderRadius: 22,
          backgroundColor: "#0a0a14",
          borderWidth: 1,
          borderColor: ACCENT + "28",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 28,
          shadowColor: ACCENT,
          shadowOpacity: 0.18,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 0 },
        }}>
          <Text style={{ color: ACCENT, fontSize: 34, fontWeight: "900", letterSpacing: -1 }}>A</Text>
        </View>

        {/* Wordmark */}
        <Text style={{
          color: "#ffffff",
          fontSize: 26,
          fontWeight: "900",
          letterSpacing: 6,
          marginBottom: 8,
        }}>
          AIRA
        </Text>

        {/* Tagline */}
        <Text style={{
          color: "#3a3a55",
          fontSize: 10,
          fontWeight: "700",
          letterSpacing: 3,
        }}>
          DISCIPLINE ENGINE
        </Text>

        {/* Loading indicator */}
        <View style={{ marginTop: 52 }}>
          <ActivityIndicator size="small" color="#2a2a40" />
        </View>
      </Animated.View>
    </View>
  );
}

const PRIORITY_LEFT_COLOR: Record<string, string> = {
  high:   "#FF5252",
  medium: "#FFB300",
  low:    "#2a2a2a",
};

const KIND_DURATION: Partial<Record<TaskKind, string>> = {
  Workout:   "45 min",
  Nutrition: "20 min",
  Hydration: "5 min",
  Mobility:  "15 min",
  Recovery:  "20 min",
  Habit:     "10 min",
  Sleep:     "8 hr",
};

// ---------- Workout Detail Modal ----------
function WorkoutDetailModal({
  task,
  taskDone,
  visible,
  onClose,
  onCompleteTask,
}: {
  task:            TimedTask | null;
  taskDone:        boolean;          // live from global tasks — never stale
  visible:         boolean;
  onClose:         () => void;
  onCompleteTask:  (id: string) => void;
}) {
  const [completedIds, setCompletedIds] = React.useState<Set<string>>(new Set());

  // Scroll refs — cardYRef stores each card's Y within the list container;
  // listContainerYRef stores the list container's Y within the ScrollView.
  // Together they give the absolute scroll offset for any card.
  const scrollViewRef      = React.useRef<ScrollView>(null);
  const cardYRef           = React.useRef<Record<string, number>>({});
  const listContainerYRef  = React.useRef(0);

  const workout        = task ? getWorkoutForTask(task) : null;
  const totalExercises = workout?.exercises.length ?? 0;

  // When the modal opens:
  //   - if the task is already done, pre-fill all exercises so the
  //     completion summary is shown immediately instead of an empty list.
  //   - otherwise start fresh.
  React.useEffect(() => {
    if (!visible || !workout) return;
    if (taskDone) {
      setCompletedIds(new Set(workout.exercises.map((e) => e.id)));
    } else {
      setCompletedIds(new Set());
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const doneCount   = completedIds.size;
  const allDone     = doneCount === totalExercises && totalExercises > 0;

  // Auto-complete the task the moment all exercises are ticked off.
  // Fires at most once per session — the taskDone guard prevents re-firing
  // after the parent state update propagates back through the taskDone prop.
  React.useEffect(() => {
    if (allDone && !taskDone && task) {
      onCompleteTask(task.id);
    }
  }, [allDone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to the newly active exercise after layout settles.
  // The timeout lets the layout reflow (card expand/collapse) complete first.
  const activeId = workout?.exercises.find((e) => !completedIds.has(e.id))?.id ?? null;

  React.useEffect(() => {
    if (!activeId || allDone) return;
    const timer = setTimeout(() => {
      const cardY = cardYRef.current[activeId];
      if (cardY == null) return;
      const scrollY = listContainerYRef.current + cardY;
      scrollViewRef.current?.scrollTo({ y: Math.max(0, scrollY - 24), animated: true });
    }, 80);
    return () => clearTimeout(timer);
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!task || !workout) return null;

  const progressPct = totalExercises > 0 ? Math.round((doneCount / totalExercises) * 100) : 0;

  // The exercise immediately after active — shown with "NEXT" pill
  const activeIndex = workout.exercises.findIndex((e) => e.id === activeId);
  const nextId      = activeIndex >= 0 && activeIndex + 1 < workout.exercises.length
    ? workout.exercises[activeIndex + 1].id
    : null;
  const isLastExercise = activeIndex === workout.exercises.length - 1;

  const markDone = (id: string) =>
    setCompletedIds((prev) => new Set([...prev, id]));

  function formatRest(seconds: number): string {
    if (seconds >= 60) {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return s > 0 ? `${m}m ${s}s` : `${m}m`;
    }
    return `${seconds}s`;
  }

  // One-line summary for upcoming exercises: "4 sets · 8 reps · 80kg"
  function summarizeSets(sets: ExerciseSet[]): string {
    if (!sets.length) return "";
    const count = sets.length;
    const minReps = Math.min(...sets.map((s) => s.reps));
    const maxReps = Math.max(...sets.map((s) => s.reps));
    const repStr  = minReps === maxReps ? `${minReps} reps` : `${minReps}–${maxReps} reps`;
    const weightSample = sets.find((s) => s.target_weight)?.target_weight;
    const weightStr    = weightSample ? ` · ${weightSample}` : "";
    return `${count} set${count !== 1 ? "s" : ""} · ${repStr}${weightStr}`;
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: "#06060c" }}>
        <StatusBar barStyle="light-content" />

        {/* ── Top bar ─────────────────────────────────────────────────────────── */}
        <View style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 20,
          paddingTop: 10,
          paddingBottom: 14,
        }}>
          <Pressable
            onPress={onClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: "#0e0e18",
              borderWidth: 1,
              borderColor: "#1e1e2e",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: "#5a5a7a", fontSize: 14, fontWeight: "700", lineHeight: 16 }}>✕</Text>
          </Pressable>

          <View style={{ flex: 1 }} />

          {/* Progress counter pill */}
          <View style={{
            backgroundColor: doneCount > 0 ? ACCENT + "18" : "#0e0e18",
            borderWidth: 1,
            borderColor: doneCount > 0 ? ACCENT + "40" : "#1e1e2e",
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 6,
          }}>
            <Text style={{
              color: doneCount > 0 ? ACCENT : "#3a3a5a",
              fontSize: 12,
              fontWeight: "800",
              letterSpacing: 0.3,
            }}>
              {doneCount}/{totalExercises} complete
            </Text>
          </View>
        </View>

        <ScrollView
          ref={scrollViewRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 56 }}
        >

          {/* ── Workout identity ──────────────────────────────────────────────── */}
          <View style={{ marginBottom: 28 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <View style={{ backgroundColor: "#0e0c2a", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ color: "#a89fff", fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }}>WORKOUT</Text>
              </View>
              <Text style={{ color: "#2e2e48", fontSize: 11, fontWeight: "600" }}>
                {workout.duration_minutes} min
              </Text>
            </View>

            <Text style={{
              color: "#eeeef5",
              fontSize: 26,
              fontWeight: "900",
              letterSpacing: -0.8,
              lineHeight: 32,
              marginBottom: 6,
            }}>
              {workout.title}
            </Text>
            <Text style={{ color: "#4a4a7a", fontSize: 13, fontWeight: "600" }}>
              {workout.focus}
            </Text>
          </View>

          {/* ── Progress bar ──────────────────────────────────────────────────── */}
          <View style={{ marginBottom: 32 }}>
            <View style={{ height: 3, backgroundColor: "#111120", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
              <View style={{
                height: 3,
                width: `${progressPct}%` as any,
                backgroundColor: allDone ? "#66bb6a" : ACCENT,
                borderRadius: 2,
              }} />
            </View>
            <Text style={{ color: "#3a3a5a", fontSize: 11, fontWeight: "600" }}>
              {allDone
                ? `All ${totalExercises} exercises done`
                : doneCount > 0
                  ? `${doneCount} of ${totalExercises} complete`
                  : `${totalExercises} exercises`}
            </Text>
          </View>

          {/* ── Exercise cards ────────────────────────────────────────────────── */}
          <View
            style={{ gap: 10 }}
            onLayout={(e) => { listContainerYRef.current = e.nativeEvent.layout.y; }}
          >
            {workout.exercises.map((exercise, index) => {
              const isDone   = completedIds.has(exercise.id);
              const isActive = exercise.id === activeId;
              const isNext   = exercise.id === nextId;

              // ── Done: collapsed row ──────────────────────────────────────────
              if (isDone) {
                return (
                  <View
                    key={exercise.id}
                    onLayout={(e) => { cardYRef.current[exercise.id] = e.nativeEvent.layout.y; }}
                    style={{
                      backgroundColor: "#080808",
                      borderWidth: 1,
                      borderColor: "#0e0e0e",
                      borderRadius: 14,
                      flexDirection: "row",
                      alignItems: "center",
                      paddingHorizontal: 16,
                      paddingVertical: 14,
                      gap: 12,
                    }}
                  >
                    <View style={{
                      width: 26,
                      height: 26,
                      borderRadius: 13,
                      backgroundColor: "#66bb6a18",
                      borderWidth: 1,
                      borderColor: "#66bb6a30",
                      alignItems: "center",
                      justifyContent: "center",
                    }}>
                      <Text style={{ color: "#66bb6a", fontSize: 11, fontWeight: "900" }}>✓</Text>
                    </View>
                    <Text style={{
                      flex: 1,
                      color: "#2e2e2e",
                      fontSize: 14,
                      fontWeight: "700",
                      textDecorationLine: "line-through",
                    }}>
                      {exercise.name}
                    </Text>
                    <Text style={{ color: "#1e2e1e", fontSize: 11, fontWeight: "700" }}>DONE</Text>
                  </View>
                );
              }

              // ── Active: full detail card ─────────────────────────────────────
              if (isActive) {
                return (
                  <View
                    key={exercise.id}
                    onLayout={(e) => { cardYRef.current[exercise.id] = e.nativeEvent.layout.y; }}
                    style={{
                      backgroundColor: "#0d0b22",
                      borderWidth: 1,
                      borderColor: "#3d35a0",
                      borderRadius: 16,
                      overflow: "hidden",
                    }}
                  >
                    {/* ACCENT top strip — signals "you are here" */}
                    <View style={{ height: 3, backgroundColor: ACCENT }} />

                    <View style={{ padding: 20, gap: 18 }}>

                      {/* Header: NOW badge + name */}
                      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
                        <View style={{ flex: 1, gap: 6 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <View style={{
                              backgroundColor: ACCENT + "28",
                              borderRadius: 4,
                              paddingHorizontal: 6,
                              paddingVertical: 2,
                            }}>
                              <Text style={{ color: ACCENT, fontSize: 9, fontWeight: "900", letterSpacing: 1.2 }}>NOW</Text>
                            </View>
                            <Text style={{ color: ACCENT + "70", fontSize: 10, fontWeight: "700", letterSpacing: 0.6 }}>
                              {index + 1} of {workout.exercises.length}
                            </Text>
                          </View>
                          <Text style={{
                            color: "#ffffff",
                            fontSize: 21,
                            fontWeight: "900",
                            letterSpacing: -0.5,
                            lineHeight: 27,
                          }}>
                            {exercise.name}
                          </Text>
                        </View>
                      </View>

                      {/* Sets table */}
                      <View>
                        <View style={{
                          flexDirection: "row",
                          paddingBottom: 10,
                          borderBottomWidth: 1,
                          borderBottomColor: "#1e1c3a",
                          marginBottom: 2,
                        }}>
                          <Text style={{ color: "#4a4a7a", fontSize: 10, fontWeight: "800", letterSpacing: 1, width: 44 }}>SET</Text>
                          <Text style={{ color: "#4a4a7a", fontSize: 10, fontWeight: "800", letterSpacing: 1, width: 64 }}>REPS</Text>
                          <Text style={{ color: "#4a4a7a", fontSize: 10, fontWeight: "800", letterSpacing: 1, flex: 1 }}>WEIGHT</Text>
                        </View>
                        {exercise.sets.map((set) => (
                          <View key={set.set_number} style={{ flexDirection: "row", paddingVertical: 9 }}>
                            <Text style={{ color: "#5a5a9a", fontSize: 15, fontWeight: "700", width: 44 }}>
                              {set.set_number}
                            </Text>
                            <Text style={{ color: "#d0d0f0", fontSize: 17, fontWeight: "700", width: 64 }}>
                              {set.reps}
                            </Text>
                            <Text style={{ color: set.target_weight ? "#d0d0f0" : "#3a3a5a", fontSize: 17, fontWeight: "700", flex: 1 }}>
                              {set.target_weight ?? "—"}
                            </Text>
                          </View>
                        ))}
                      </View>

                      {/* Coaching cue */}
                      {exercise.cue ? (
                        <View style={{
                          backgroundColor: "#09090e",
                          borderRadius: 10,
                          borderLeftWidth: 2,
                          borderLeftColor: ACCENT + "70",
                          paddingHorizontal: 14,
                          paddingVertical: 12,
                        }}>
                          <Text style={{ color: "#7070b0", fontSize: 13, lineHeight: 21, fontStyle: "italic" }}>
                            {exercise.cue}
                          </Text>
                        </View>
                      ) : null}

                      {/* Rest time */}
                      {exercise.rest_seconds > 0 ? (
                        <Text style={{ color: "#3a3a60", fontSize: 12, fontWeight: "600" }}>
                          Rest between sets — {formatRest(exercise.rest_seconds)}
                        </Text>
                      ) : null}

                      {/* Primary action */}
                      <Pressable
                        onPress={() => markDone(exercise.id)}
                        style={{
                          backgroundColor: ACCENT,
                          borderRadius: 14,
                          paddingVertical: 17,
                          alignItems: "center",
                          marginTop: 2,
                        }}
                      >
                        <Text style={{ color: "#fff", fontSize: 15, fontWeight: "900", letterSpacing: 0.3 }}>
                          {isLastExercise ? "Finish workout →" : "Done — next exercise →"}
                        </Text>
                      </Pressable>

                    </View>
                  </View>
                );
              }

              // ── Upcoming: compact summary row ────────────────────────────────
              return (
                <View
                  key={exercise.id}
                  onLayout={(e) => { cardYRef.current[exercise.id] = e.nativeEvent.layout.y; }}
                  style={{
                    backgroundColor: isNext ? "#0a0918" : "#080810",
                    borderWidth: 1,
                    borderColor: isNext ? "#1e1c38" : "#111118",
                    borderRadius: 14,
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    gap: 12,
                  }}
                >
                  <View style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    backgroundColor: isNext ? "#14122a" : "#0e0e18",
                    borderWidth: 1,
                    borderColor: isNext ? "#2a2848" : "#1a1a28",
                    alignItems: "center",
                    justifyContent: "center",
                  }}>
                    <Text style={{ color: isNext ? "#5a58a0" : "#2e2e48", fontSize: 11, fontWeight: "800" }}>{index + 1}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={{ color: isNext ? "#6060a0" : "#404060", fontSize: 14, fontWeight: "700" }}>{exercise.name}</Text>
                    <Text style={{ color: isNext ? "#2e2e50" : "#252535", fontSize: 11, fontWeight: "600" }}>{summarizeSets(exercise.sets)}</Text>
                  </View>
                  {isNext && (
                    <View style={{
                      backgroundColor: "#1a1830",
                      borderRadius: 4,
                      paddingHorizontal: 6,
                      paddingVertical: 3,
                    }}>
                      <Text style={{ color: "#4a4880", fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>NEXT</Text>
                    </View>
                  )}
                </View>
              );
            })}
          </View>

          {/* ── Completion section ────────────────────────────────────────────── */}
          {allDone && (
            <View style={{ marginTop: 28, gap: 12 }}>
              {/* Summary banner */}
              <View style={{
                backgroundColor: "#66bb6a0e",
                borderWidth: 1,
                borderColor: "#66bb6a28",
                borderRadius: 16,
                padding: 20,
                alignItems: "center",
                gap: 6,
              }}>
                <Text style={{ color: "#66bb6a", fontSize: 22, fontWeight: "900", letterSpacing: -0.5 }}>
                  Workout done
                </Text>
                <Text style={{ color: "#66bb6a50", fontSize: 13, fontWeight: "500" }}>
                  {totalExercises} exercise{totalExercises !== 1 ? "s" : ""} · {workout.duration_minutes} min
                </Text>
                {/* Confirm task was auto-completed */}
                {taskDone && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 }}>
                    <Text style={{ color: "#66bb6a60", fontSize: 11, fontWeight: "700" }}>✓</Text>
                    <Text style={{ color: "#66bb6a60", fontSize: 11, fontWeight: "600" }}>Logged in today's plan</Text>
                  </View>
                )}
              </View>

              {/* Single dismiss — task was already auto-completed by the effect */}
              <Pressable
                onPress={onClose}
                style={{
                  backgroundColor: taskDone ? "#66bb6a" : "#0e0e18",
                  borderWidth: 1,
                  borderColor: taskDone ? "#66bb6a" : "#1e1e2e",
                  borderRadius: 14,
                  paddingVertical: 16,
                  alignItems: "center",
                }}
              >
                <Text style={{
                  color: taskDone ? "#fff" : "#4a4a6a",
                  fontSize: 15,
                  fontWeight: "800",
                }}>
                  Back to today
                </Text>
              </Pressable>
            </View>
          )}

        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ---------- Task detail content ----------
// Per-kind instructions, success criteria, and why-it-matters copy shown in
// the Task Detail screen. Add new kinds here — no other files need to change.
type TaskDetailContent = {
  instructions:    string[];
  successCriteria: string[];
  whyItMatters:    string;
};

const TASK_CONTENT: Partial<Record<TaskKind, TaskDetailContent>> = {
  Workout: {
    instructions: [
      "Warm up 3–5 min — light cardio or dynamic stretching",
      "Lead with your heaviest compound lift while you're fresh",
      "Move through accessory work at controlled tempo",
      "Finish with a 2–3 min cooldown stretch — don't skip it",
    ],
    successCriteria: [
      "All working sets completed",
      "Weight and reps logged",
      "Cooldown done",
    ],
    whyItMatters:
      "Every session is compounding interest on your physique and discipline. Skip once, break the chain.",
  },
  Nutrition: {
    instructions: [
      "Prep before you're hungry — decision fatigue kills good eating",
      "Anchor the meal around a protein source: chicken, fish, eggs, or Greek yogurt",
      "Fill the rest of the plate with vegetables and a complex carb",
      "Eat slowly — 20 minutes for your brain to register fullness",
    ],
    successCriteria: [
      "Protein target hit for this meal",
      "No junk substitutions",
      "Meal eaten — not skipped",
    ],
    whyItMatters:
      "Nutrition drives 70% of body composition. The workout earns the right to eat well — don't waste it.",
  },
  Hydration: {
    instructions: [
      "Fill a large bottle before you start",
      "Drink 500ml before your first meal",
      "Sip steadily through the day — don't chug all at once",
      "Add a pinch of salt if you're sweating heavily or training hard",
    ],
    successCriteria: [
      "Daily water target hit (2–3L minimum)",
      "Urine is pale yellow — not dark",
    ],
    whyItMatters:
      "Even mild dehydration tanks focus, energy, and strength output. Water is the cheapest performance tool available.",
  },
  Mobility: {
    instructions: [
      "Hip flexor stretch — 60 seconds each side",
      "Thoracic rotation — 10 slow reps each side",
      "Doorframe chest stretch — 30 seconds",
      "Hamstring stretch — 30 seconds each side",
    ],
    successCriteria: [
      "10+ minutes completed",
      "Major muscle groups addressed",
      "Full range of motion — no rushing",
    ],
    whyItMatters:
      "Daily mobility compounds over months. Five minutes now prevents years of stiffness and avoids injuries that kill your progress.",
  },
  Recovery: {
    instructions: [
      "5 slow diaphragmatic breaths to settle your nervous system",
      "Foam roll the main muscle groups worked today — 30–60 sec per area",
      "Light static stretching on your tightest areas",
      "End with 2–3 min of stillness — no phone",
    ],
    successCriteria: [
      "20+ minutes completed",
      "Worked muscle groups addressed",
      "Calmer at the end than at the start",
    ],
    whyItMatters:
      "Adaptation happens during recovery, not during training. Skipping this is stealing from tomorrow's performance.",
  },
  Habit: {
    instructions: [
      "Identify the exact trigger that starts this habit",
      "Execute immediately — no negotiation, no delay",
      "Stack it onto an existing routine to reduce friction",
      "Mark it done as soon as it's complete",
    ],
    successCriteria: [
      "Habit completed — not modified or abbreviated",
      "Logged and marked done",
    ],
    whyItMatters:
      "Habits are the architecture of identity. Every rep of this makes the behaviour more automatic and effortless.",
  },
  Sleep: {
    instructions: [
      "Begin wind-down 30–45 min before your target sleep time",
      "Screens off — phone on charger, out of reach",
      "Dim lights; lower room temperature if possible",
      "Set your alarm once and don't touch it again",
    ],
    successCriteria: [
      "In bed by target time",
      "7–9 hours of sleep",
      "No phone after wind-down starts",
    ],
    whyItMatters:
      "Sleep is when your body rebuilds and your brain consolidates everything learned. There is no high performance without consistent, quality sleep.",
  },
  Walk: {
    instructions: [
      "Get outside — fresh air multiplies the benefit",
      "Pace should feel brisk — slightly elevated heart rate",
      "Phone in pocket or listening to something useful",
      "Aim for 20+ minutes of continuous movement",
    ],
    successCriteria: [
      "20+ minutes completed",
      "Continuous movement throughout",
    ],
    whyItMatters:
      "Daily walking improves mood, lowers cortisol, and adds low-intensity activity that compounds over weeks into real results.",
  },
  Meal: {
    instructions: [
      "Prep before you're hungry",
      "Protein first — anchor the plate around it",
      "Eat without screens for at least this meal",
      "Track or note calories if you're in a specific phase",
    ],
    successCriteria: [
      "Meal eaten — not skipped",
      "Protein-first composition",
    ],
    whyItMatters:
      "Consistent meals regulate energy, reduce cravings, and directly support your body composition goal.",
  },
};

// ---------- Task Detail Modal ----------
function TaskDetailModal({
  task,
  visible,
  onClose,
  onToggle,
}: {
  task:     TimedTask | null;
  visible:  boolean;
  onClose:  () => void;
  onToggle: (id: string) => void;
}) {
  if (!task) return null;

  const content    = TASK_CONTENT[task.kind];
  const kindStyle  = KIND_COLORS[task.kind];
  const kindColor  = kindStyle?.color      ?? "#888";
  const kindBg     = kindStyle?.backgroundColor ?? "#111";
  const duration   = KIND_DURATION[task.kind];
  const priority   = task.priority ?? "medium";
  const priorityColor =
    priority === "high"   ? "#FF5252" :
    priority === "medium" ? "#FFB300" : "#555";
  const priorityLabel =
    priority === "high"   ? "REQUIRED" :
    priority === "medium" ? "OPTIONAL" : "OPTIONAL";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}
        onPress={onClose}
      >
        <Pressable onPress={() => {}} style={{ maxHeight: "92%" }}>
          <View style={{ backgroundColor: "#0a0a0f", borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden" }}>

            {/* Drag handle */}
            <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 4 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: "#252535" }} />
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 40, gap: 0 }}
            >
              {/* ── Kind + priority header ─────────────────────────────────────── */}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 16, paddingBottom: 20 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ backgroundColor: kindBg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ color: kindColor, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }}>
                      {task.kind.toUpperCase()}
                    </Text>
                  </View>
                  {duration && (
                    <Text style={{ color: "#2e2e48", fontSize: 11, fontWeight: "600" }}>{duration}</Text>
                  )}
                </View>
                <View style={{ backgroundColor: priorityColor + "18", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ color: priorityColor, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }}>
                    {priorityLabel}
                  </Text>
                </View>
              </View>

              {/* ── Time + title ───────────────────────────────────────────────── */}
              <Text style={{ color: "#3a3a5a", fontSize: 12, fontWeight: "700", letterSpacing: 0.3, marginBottom: 8 }}>
                {task.timeText}
              </Text>
              <Text style={{
                color: task.done ? "#555" : "#eeeef5",
                fontSize: 22,
                fontWeight: "800",
                lineHeight: 30,
                letterSpacing: -0.5,
                textDecorationLine: task.done ? "line-through" : "none",
                marginBottom: 28,
              }}>
                {task.title}
              </Text>

              {content ? (
                <>
                  {/* Thin divider */}
                  <View style={{ height: 1, backgroundColor: "#111120", marginBottom: 28 }} />

                  {/* ── Instructions ───────────────────────────────────────────── */}
                  <View style={{ marginBottom: 28 }}>
                    <Text style={{ color: "#3a3a5a", fontSize: 10, fontWeight: "800", letterSpacing: 1.2, marginBottom: 14 }}>
                      HOW TO DO IT
                    </Text>
                    <View style={{ gap: 12 }}>
                      {content.instructions.map((step, i) => (
                        <View key={i} style={{ flexDirection: "row", gap: 12 }}>
                          <Text style={{ color: kindColor + "80", fontSize: 12, fontWeight: "800", width: 16, paddingTop: 1 }}>
                            {i + 1}
                          </Text>
                          <Text style={{ flex: 1, color: "#8888a8", fontSize: 14, lineHeight: 22, fontWeight: "500" }}>
                            {step}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>

                  {/* ── Success criteria ───────────────────────────────────────── */}
                  <View style={{ marginBottom: 28 }}>
                    <Text style={{ color: "#3a3a5a", fontSize: 10, fontWeight: "800", letterSpacing: 1.2, marginBottom: 14 }}>
                      DONE WHEN
                    </Text>
                    <View style={{ gap: 10 }}>
                      {content.successCriteria.map((criterion, i) => (
                        <View key={i} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
                          <Text style={{ color: "#66bb6a", fontSize: 12, fontWeight: "900", paddingTop: 2 }}>✓</Text>
                          <Text style={{ flex: 1, color: "#7070a0", fontSize: 14, lineHeight: 22, fontWeight: "500" }}>
                            {criterion}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>

                  {/* ── Why it matters ─────────────────────────────────────────── */}
                  <View style={{
                    backgroundColor: "#08080f",
                    borderWidth: 1,
                    borderColor: "#111120",
                    borderRadius: 12,
                    padding: 16,
                    marginBottom: 32,
                  }}>
                    <Text style={{ color: "#2e2e48", fontSize: 10, fontWeight: "800", letterSpacing: 1.2, marginBottom: 8 }}>
                      WHY IT MATTERS
                    </Text>
                    <Text style={{ color: "#6060a0", fontSize: 13, lineHeight: 21, fontStyle: "italic" }}>
                      {content.whyItMatters}
                    </Text>
                  </View>
                </>
              ) : (
                <View style={{ height: 24 }} />
              )}

              {/* ── Completion button ──────────────────────────────────────────── */}
              <Pressable
                onPress={() => { onToggle(task.id); onClose(); }}
                style={{
                  backgroundColor: task.done ? "#0e0e0e" : "#66bb6a",
                  borderWidth: 1,
                  borderColor: task.done ? "#1e1e1e" : "#66bb6a",
                  borderRadius: 14,
                  paddingVertical: 16,
                  alignItems: "center",
                }}
              >
                <Text style={{
                  color: task.done ? "#444" : "#fff",
                  fontSize: 15,
                  fontWeight: "800",
                  letterSpacing: 0.2,
                }}>
                  {task.done ? "Mark incomplete" : "Mark complete"}
                </Text>
              </Pressable>
            </ScrollView>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function TaskRow({
  task,
  onToggle,
  onDetail,
}: {
  task:     TimedTask;
  onToggle: () => void;
  onDetail: () => void;
}) {
  const priority  = task.priority ?? "medium";
  const accentBar = PRIORITY_LEFT_COLOR[priority] ?? "#2a2a2a";

  return (
    <Pressable
      onPress={onDetail}
      style={{
        backgroundColor: task.done ? "#0a0a0a" : "#0f0f0f",
        borderWidth: 1,
        borderColor: task.done ? "#1a1a1a" : "#1e1e1e",
        borderRadius: 14,
        flexDirection: "row",
        overflow: "hidden",
      }}
    >
      {/* Priority accent bar */}
      <View style={{ width: 3, backgroundColor: task.done ? "#1e1e1e" : accentBar }} />

      {/* Content */}
      <View style={{ flex: 1, paddingVertical: 14, paddingLeft: 14, paddingRight: 4, gap: 7 }}>
        {/* Meta row: time · duration */}
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={{ color: task.done ? "#2a2a2a" : "#5a5a7a", fontSize: 11, fontWeight: "700", letterSpacing: 0.4 }}>
            {task.timeText}
          </Text>
          {KIND_DURATION[task.kind] && (
            <Text style={{ color: task.done ? "#222" : "#2e2e48", fontSize: 11, fontWeight: "500", marginLeft: 5 }}>
              · {KIND_DURATION[task.kind]}
            </Text>
          )}
        </View>

        {/* Title */}
        <Text
          style={{
            color: task.done ? "#373737" : "#ececef",
            fontSize: 15,
            fontWeight: "700",
            lineHeight: 21,
            textDecorationLine: task.done ? "line-through" : "none",
          }}
        >
          {task.title}
        </Text>
      </View>

      {/* Completion toggle — separate pressable so it doesn't open detail */}
      <Pressable
        onPress={(e) => { e.stopPropagation?.(); onToggle(); }}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 0 }}
        style={{ justifyContent: "center", paddingRight: 16, paddingLeft: 4 }}
      >
        <View style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: 2,
          borderColor: task.done ? "#66bb6a" : "#2a2a2a",
          backgroundColor: task.done ? "#66bb6a18" : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}>
          {task.done && (
            <Text style={{ color: "#66bb6a", fontSize: 12, fontWeight: "900", lineHeight: 14 }}>✓</Text>
          )}
        </View>
      </Pressable>
    </Pressable>
  );
}

// ---------- Notifications setup ----------
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,

    // ✅ add these (required by some Expo versions/types)
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function ensureNotificationPermissions(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === "granted") return true;
  const req = await Notifications.requestPermissionsAsync();
  return req.status === "granted";
}

// ---------- ChatScreen (top-level component) ----------
// Defined outside Index so its hooks are registered in a stable fiber,
// not conditionally inside Index's fiber.

type ChatMessage = { role: "user" | "assistant"; content: string };

type ChatScreenProps = {
  messages:         ChatMessage[];
  setMessages:      React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  sessionId:        string | null;
  setSessionId:     React.Dispatch<React.SetStateAction<string | null>>;
  profile:          Profile | null;
  recovery:         RecoveryData;
  blocks:           ScheduleBlock[];
  tasks:            TimedTask[];  // full raw list — for score context
  rebalancedTasks:  TimedTask[];  // adapted + rebalanced — what Aira should prioritise
  recoveryStatus:   string;
  liveStreak:       number;
  score:            number;
  gamePlan:         GamePlan | null;
};

function ChatScreen({
  messages, setMessages, sessionId, setSessionId,
  profile, recovery, blocks, tasks, rebalancedTasks, recoveryStatus, liveStreak, score, gamePlan,
}: ChatScreenProps) {
  const [chatInput,   setChatInput]   = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatControllerRef = React.useRef<AbortController | null>(null);
  const scrollRef         = React.useRef<ScrollView>(null);

  const handleAskCoach = async (overrideText?: string) => {
    const trimmed = (overrideText ?? chatInput).trim();
    if (!trimmed || chatLoading) return;

    if (chatControllerRef.current) {
      console.log("[chat] Aborting previous in-flight request");
      chatControllerRef.current.abort();
    }

    const controller = new AbortController();
    chatControllerRef.current = controller;
    let timedOut = false;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setChatInput("");
    setChatLoading(true);

    const timeout = setTimeout(() => {
      timedOut = true;
      console.log("[chat] Request timed out after 60 s — aborting");
      controller.abort();
    }, 60000);

    console.log("[chat] Starting request to", `${API_BASE_URL}/api/coach`);

    try {
      const startingPointLabels: Record<string, string> = {
        soft:          "Soft / Skinny Fat",
        average:       "Average / Untrained",
        somewhat_lean: "Somewhat Lean",
        athletic:      "Athletic / Lean",
      };

      const res = await fetch(`${API_BASE_URL}/api/coach`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          sessionId: sessionId ?? undefined,
          name:  profile?.name  ?? "User",
          goal:  profile?.goal  ?? "Build discipline",
          wake:  profile?.wake  ?? "",
          sleep: profile?.sleep ?? "",
          startingPoint: profile?.startingPoint
            ? (startingPointLabels[profile.startingPoint] ?? profile.startingPoint)
            : "",
          targetGoal: profile?.targetGoal
            ? (TARGET_GOAL_LABELS[profile.targetGoal] ?? profile.targetGoal)
            : "",
          bodyFatDirection: profile?.bodyFatDirection ?? "",
          experienceLevel:  profile?.experienceLevel  ?? "",
          equipment:        profile?.equipment        ?? "",
          workoutFrequency: profile?.workoutFrequency ?? "",
          dailyTrainingTime:profile?.dailyTrainingTime ?? "",
          checkIn: {
            energyLevel:      recovery.energyLevel      ?? null,
            soreness:         recovery.soreness         ?? null,
            motivationLevel:  recovery.motivationLevel  ?? null,
            timeAvailable:    recovery.timeAvailable    ?? null,
            focusArea:        recovery.focusArea        ?? null,
            isToday:          recovery.date === new Date().toISOString().slice(0, 10),
          },
          scheduleBlocks: blocks.map((b) => `${b.title} (${b.type}): ${b.startText}–${b.endText}`),
          recoveryStatus,
          tasksToday: rebalancedTasks.map((t) => ({
            title:    t.title,
            kind:     t.kind,
            done:     t.done,
            time:     t.timeText,
            priority: t.priority ?? "medium",
          })),
          streak: liveStreak,
          score,
          gamePlan: gamePlan
            ? { readiness: gamePlan.readiness, timeMode: gamePlan.timeMode, message: gamePlan.message }
            : null,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      chatControllerRef.current = null;
      console.log("[chat] Response received, status =", res.status);

      const text = await res.text();
      console.log("[chat] Raw response length =", text.length);

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("Response was not valid JSON. Raw: " + text.slice(0, 200));
      }

      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      console.log("[chat] Reply received, length =", data?.reply?.length ?? 0);

      if (data.sessionId) setSessionId(data.sessionId);

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data?.reply ?? "No reply field returned." },
      ]);
    } catch (err: any) {
      clearTimeout(timeout);
      chatControllerRef.current = null;

      const isAbort = err?.name === "AbortError";

      if (isAbort && !timedOut) {
        console.log("[chat] Request cancelled (superseded by new request)");
        return;
      }

      console.error("[chat] Request failed:", err?.name, err?.message);

      const userMessage = isAbort && timedOut
        ? "The server is taking a while to respond (it may be warming up). Please try again."
        : "Something went wrong. Please try again.";

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: userMessage },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const STARTER_PROMPTS = [
    "What should I do today?",
    "Adjust my workout",
    "Help me stay disciplined",
    "Build my day",
  ];

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      {/* Message list */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 12, gap: 12 }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {/* Empty state — starter prompts */}
        {messages.length === 0 && !chatLoading && (
          <View style={{ gap: 16, paddingTop: 8 }}>
            <View style={{ gap: 4 }}>
              <Text style={styles.h2}>Aira</Text>
              <Text style={styles.bodyMuted}>Your discipline coach. Ask anything.</Text>
            </View>
            <View style={{ gap: 8 }}>
              {STARTER_PROMPTS.map((prompt) => (
                <Pressable
                  key={prompt}
                  onPress={() => handleAskCoach(prompt)}
                  style={{
                    borderWidth: 1,
                    borderColor: "#262626",
                    borderRadius: 12,
                    padding: 14,
                    backgroundColor: "#0a0a0a",
                  }}
                >
                  <Text style={{ color: "#bdbdbd", fontSize: 14 }}>{prompt}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Messages */}
        {messages.map((msg, i) => (
          <View
            key={i}
            style={{ alignSelf: msg.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", gap: 4 }}
          >
            {msg.role === "assistant" && (
              <Text style={{ color: ACCENT, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 }}>
                AIRA
              </Text>
            )}
            <View
              style={{
                backgroundColor: msg.role === "user" ? ACCENT : "#0f0f0f",
                borderWidth: 1,
                borderColor: msg.role === "user" ? ACCENT : "#1e1e1e",
                borderRadius: 14,
                borderTopRightRadius: msg.role === "user" ? 4 : 14,
                borderTopLeftRadius: msg.role === "assistant" ? 4 : 14,
                padding: 12,
              }}
            >
              <Text style={{ color: "#fff", fontSize: 14, lineHeight: 21 }}>
                {msg.content}
              </Text>
            </View>
          </View>
        ))}

        {/* Loading bubble */}
        {chatLoading && (
          <View style={{ alignSelf: "flex-start", maxWidth: "85%", gap: 4 }}>
            <Text style={{ color: ACCENT, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 }}>
              AIRA
            </Text>
            <View
              style={{
                backgroundColor: "#0f0f0f",
                borderWidth: 1,
                borderColor: "#1e1e1e",
                borderRadius: 14,
                borderTopLeftRadius: 4,
                padding: 12,
              }}
            >
              <Text style={{ color: "#555", fontSize: 14 }}>Thinking…</Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Input bar */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 10,
          padding: 12,
          borderTopWidth: 1,
          borderTopColor: "#1e1e1e",
          backgroundColor: "#000",
        }}
      >
        <TextInput
          value={chatInput}
          onChangeText={setChatInput}
          onSubmitEditing={() => handleAskCoach()}
          returnKeyType="send"
          placeholder="Message Aira…"
          placeholderTextColor="#555"
          multiline
          style={{
            flex: 1,
            backgroundColor: "#0f0f0f",
            borderWidth: 1,
            borderColor: "#262626",
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 10,
            color: "#fff",
            fontSize: 14,
            maxHeight: 100,
          }}
        />
        <Pressable
          onPress={() => handleAskCoach()}
          disabled={chatLoading || !chatInput.trim()}
          style={{
            backgroundColor: chatLoading || !chatInput.trim() ? "#1a1a1a" : ACCENT,
            borderRadius: 12,
            paddingHorizontal: 18,
            paddingVertical: 12,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text
            style={{
              color: chatLoading || !chatInput.trim() ? "#444" : "#fff",
              fontWeight: "800",
              fontSize: 14,
            }}
          >
            Send
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

// ---------- App ----------
export default function Index() {
  // auth
  const [authUser, setAuthUser]       = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    // Read stored session from AsyncStorage (and silently refresh if expiring).
    // No persistent listener needed — fetch is the only transport.
    loadSession().then((user) => {
      setAuthUser(user);
      setAuthChecked(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // persistence — false until the initial AsyncStorage load completes
  const [loaded, setLoaded] = useState(false);
  const [showMotivation, setShowMotivation] = useState(false);
  const [detailTask,  setDetailTask]  = useState<TimedTask | null>(null);
  const [workoutTask, setWorkoutTask] = useState<TimedTask | null>(null);

  // profile/auth
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<TabKey>("Today");
  const [profile, setProfile] = useState<Profile | null>(null);

  // routine
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [tasks, setTasks] = useState<TimedTask[]>([]);

  // chat — lifted here so they survive tab switches and can be persisted
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // notifications
  const [notifReady, setNotifReady] = useState(false);
  const [scheduledNotifIds, setScheduledNotifIds] = useState<string[]>([]);
const [dayMode, setDayMode] = useState<"today" | "tomorrow">("today");

  // streak
  const [streak, setStreak] = useState<StreakData>({ currentStreak: 0, bestStreak: 0, lastActiveDate: "" });

  // recovery + daily check-in
  const [recovery, setRecovery] = useState<RecoveryData>({ date: "", energyLevel: null });
  const [gamePlan, setGamePlan] = useState<GamePlan | null>(null);

  // task feedback — tracks high-priority task outcomes for the current day
  const [taskFeedback, setTaskFeedback] = useState<TaskFeedbackMap>({});

  // Task display pipeline — all three state dependencies (tasks, gamePlan, taskFeedback)
  // must be declared ABOVE this block. Babel transpiles `const` → `var`, so any state
  // referenced before its useState() line is hoisted as `undefined`, causing crashes.
  const visibleTasks    = useMemo(() => adaptTasksForPlan(tasks, gamePlan),                   [tasks, gamePlan]);
  const rebalancedTasks = useMemo(() => rebalanceTasks(visibleTasks, taskFeedback, gamePlan), [visibleTasks, taskFeedback, gamePlan]);
  const score           = useMemo(() => calcScore(rebalancedTasks),                           [rebalancedTasks]);

  // AI planner — plan metadata; tasks live in the existing `tasks` state
  const [aiPlan,        setAiPlan]        = useState<AIPlan | null>(null);
  const [aiPlanLoading, setAiPlanLoading] = useState(false);
  const [aiPlanError,   setAiPlanError]   = useState<string | null>(null);
  // Ephemeral picker state for the check-in modal (not persisted independently)
  const [ciEnergy,     setCiEnergy]     = useState<RecoveryData["energyLevel"]>(null);
  const [ciSoreness,   setCiSoreness]   = useState<RecoveryData["soreness"]>(null);
  const [ciMotivation, setCiMotivation] = useState<RecoveryData["motivationLevel"]>(null);
  const [ciTime,       setCiTime]       = useState<RecoveryData["timeAvailable"]>(null);
  const [ciSchedule,   setCiSchedule]   = useState<RecoveryData["scheduleTightness"]>(null);
  const [ciFocus,      setCiFocus]      = useState<RecoveryData["focusArea"]>(null);

  // day-log history (last 30 days of scores)
  const [history, setHistory] = useState<DayLog[]>([]);
  const historyLastScoreRef   = React.useRef<number | null>(null);
  const historyLastDateRef    = React.useRef<string>("");

  const recoveryStatus = useMemo((): "Low" | "Solid" | "High" => {
    const sleepDone     = tasks.some((t) => t.kind === "Sleep"    && t.done);
    const mobilityDone  = tasks.some((t) => t.kind === "Mobility" && t.done);
    const recoveryDone  = tasks.some((t) => t.kind === "Recovery" && t.done);
    const hydrationAll  = tasks.filter((t) => t.kind === "Hydration");
    const hydrationDone = hydrationAll.length > 0 && hydrationAll.every((t) => t.done);

    let pts = 0;
    if (sleepDone)    pts++;
    if (mobilityDone) pts++;
    if (hydrationDone) pts++;
    if (recoveryDone) pts++;
    if (recovery.energyLevel === "high") pts++;
    if (recovery.energyLevel === "low")  pts = Math.max(0, pts - 1);

    if (pts >= 4) return "High";
    if (pts >= 2) return "Solid";
    return "Low";
  }, [tasks, recovery]);

  // Live streak: drops to 0 if lastActiveDate is neither today nor yesterday,
  // so a missed day is reflected immediately without needing a separate write.
  const liveStreak = useMemo(() => {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    const yesterdayStr = yest.toISOString().slice(0, 10);
    return (streak.lastActiveDate === todayStr || streak.lastActiveDate === yesterdayStr)
      ? streak.currentStreak
      : 0;
  }, [streak]);

  // Core task toggle — used by both Today's inline toggle and TaskDetailModal.
  // Streak, feedback, and backend sync are handled separately inside Today's
  // toggleTask closure; this function owns only the state mutation.
  const toggleTaskById = (id: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  };

  // Onboarding fields
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("Model Build (Lean + Athletic)");
  const [wake, setWake] = useState("7:00 AM");
  const [sleep, setSleep] = useState("11:00 PM");
  const [onboardingStep, setOnboardingStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [startingPoint, setStartingPoint]   = useState("");
  const [targetGoal, setTargetGoal]         = useState("");
  const [bodyFatDirection, setBodyFatDirection] = useState("");
  const [experienceLevel, setExperienceLevel]   = useState("");
  const [equipment, setEquipment]               = useState("");
  const [workoutFrequency, setWorkoutFrequency] = useState("");
  const [dailyTrainingTime, setDailyTrainingTime] = useState("");

  // Load persisted data once on mount
  useEffect(() => {
    (async () => {
      try {
        const [profileRaw, blocksRaw, tasksRaw, chatRaw, motivationDateRaw, streakRaw, recoveryRaw, historyRaw, feedbackRaw] = await Promise.all([
          AsyncStorage.getItem(STORE.profile),
          AsyncStorage.getItem(STORE.blocks),
          AsyncStorage.getItem(STORE.tasks),
          AsyncStorage.getItem(STORE.chat),
          AsyncStorage.getItem(STORE.motivationDate),
          AsyncStorage.getItem(STORE.streak),
          AsyncStorage.getItem(STORE.recovery),
          AsyncStorage.getItem(STORE.history),
          AsyncStorage.getItem(STORE.feedback),
        ]);
        if (profileRaw) {
          setProfile(JSON.parse(profileRaw) as Profile);
          setAuthed(true);

          // Show motivation once per calendar day
          const today = new Date().toISOString().slice(0, 10);
          if (motivationDateRaw !== today) {
            setShowMotivation(true);
            AsyncStorage.setItem(STORE.motivationDate, today).catch(console.warn);
          }
        }
        if (blocksRaw)  setBlocks(JSON.parse(blocksRaw) as ScheduleBlock[]);
        if (tasksRaw)   setTasks(JSON.parse(tasksRaw) as TimedTask[]);
        if (streakRaw)  setStreak(JSON.parse(streakRaw) as StreakData);
        if (recoveryRaw) {
          const parsed = JSON.parse(recoveryRaw) as RecoveryData;
          const todayDate = new Date().toISOString().slice(0, 10);
          if (parsed.date === todayDate && parsed.energyLevel) {
            setRecovery(parsed);
            setGamePlan(generateGamePlan(parsed));
          }
        }
        if (chatRaw) {
          const { messages: msgs, sessionId: sid } = JSON.parse(chatRaw);
          if (msgs)  setMessages(msgs);
          if (sid)   setSessionId(sid);
        }
        if (historyRaw) setHistory(JSON.parse(historyRaw) as DayLog[]);
        if (feedbackRaw) {
          const stored = JSON.parse(feedbackRaw) as TaskFeedbackMap;
          const todayStr = new Date().toISOString().slice(0, 10);
          // Discard stale feedback from a previous day
          const todayOnly = Object.fromEntries(
            Object.entries(stored).filter(([, e]) => e.date === todayStr)
          );
          if (Object.keys(todayOnly).length > 0) setTaskFeedback(todayOnly);
        }
      } catch (e) {
        console.warn("[storage] Load failed:", e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- AI Planner helpers ----------

  /** Convert a raw backend task record to the app's TimedTask format. */
  const aiTaskToTimedTask = (t: {
    id: string; timeText: string; title: string;
    kind: string; priority: string; done: boolean;
  }): TimedTask => ({
    id:       t.id,
    timeMin:  parseTimeToMinutes(t.timeText) ?? 480, // default 8 AM if parse fails
    timeText: t.timeText,
    title:    t.title,
    kind:     t.kind     as TaskKind,
    priority: t.priority as TaskPriority,
    done:     t.done,
  });

  /**
   * Silently fetch today's plan on app open.
   * If no plan exists the app stays in the manual-plan state — no error shown.
   */
  const fetchTodayAIPlan = async (userId: string) => {
    const date = new Date().toISOString().slice(0, 10);
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/planner/today?userId=${encodeURIComponent(userId)}&date=${date}`
      );
      if (res.status === 404) return; // no plan yet — fine
      if (!res.ok) {
        console.warn("[planner] fetchTodayAIPlan: unexpected status", res.status);
        return;
      }
      let data: Record<string, unknown>;
      try {
        data = await res.json();
      } catch {
        console.warn("[planner] fetchTodayAIPlan: non-JSON response, status:", res.status);
        return;
      }
      if (data.plan) {
        console.log("[planner] fetchTodayAIPlan: restored plan from server");
        setAiPlan(data.plan as AIPlan);
        if (Array.isArray(data.tasks) && data.tasks.length) {
          setTasks(
            (data.tasks as any[])
              .map(aiTaskToTimedTask)
              .sort((a: { timeMin: number }, b: { timeMin: number }) => a.timeMin - b.timeMin)
          );
        }
      }
    } catch (err) {
      console.warn("[planner] fetchTodayAIPlan error:", err);
      // Silent — planner is an enhancement, not a requirement
    }
  };

  /**
   * Generate (or regenerate) today's AI plan.
   * Validates + stores on the backend, then hydrates local state.
   */
  const generateAIPlan = async () => {
    if (!authUser || !profile) return;
    setAiPlanLoading(true);
    setAiPlanError(null);
    console.log("[planner] generateAIPlan start — userId:", authUser.id.slice(0, 8) + "…");
    try {
      const res = await fetch(`${API_BASE_URL}/api/planner/generate`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId:  authUser.id,
          profile,
          schedule: {
            blocks: blocks.map((b) => ({
              title: b.title, type: b.type, start: b.startText, end: b.endText,
            })),
          },
          condition: {
            energyLevel:     recovery.energyLevel,
            soreness:        recovery.soreness,
            motivationLevel: recovery.motivationLevel,
            timeAvailable:   recovery.timeAvailable,
            focusArea:       recovery.focusArea,
          },
          behavior: {
            streak: liveStreak,
            score,
            taskFeedback: Object.values(taskFeedback),
          },
          context: {
            date:     new Date().toISOString().slice(0, 10),
            gamePlan: gamePlan
              ? { readiness: gamePlan.readiness, timeMode: gamePlan.timeMode, message: gamePlan.message }
              : null,
          },
        }),
      });

      // Parse JSON defensively — a non-JSON body (e.g. HTML 404 from a proxy or cold-start
      // error page) would throw here and obscure the real HTTP status code.
      let data: Record<string, unknown>;
      try {
        data = await res.json();
      } catch {
        console.error("[planner] generate: server returned non-JSON response, status:", res.status);
        setAiPlanError(`Server error (${res.status}) — please try again.`);
        return;
      }

      if (!res.ok) {
        const msg = (data.error as string | undefined) ?? `Request failed (${res.status}).`;
        console.error("[planner] generate: server error:", res.status, msg, data.details ?? "");
        setAiPlanError(msg);
        return;
      }

      console.log("[planner] generate success — tasks:", (data.tasks as unknown[])?.length ?? 0);
      setAiPlan(data.plan as AIPlan);
      if (Array.isArray(data.tasks) && data.tasks.length) {
        setTasks(
          (data.tasks as any[])
            .map(aiTaskToTimedTask)
            .sort((a: { timeMin: number }, b: { timeMin: number }) => a.timeMin - b.timeMin)
        );
      }
    } catch (err) {
      console.error("[planner] generate network error:", err);
      setAiPlanError("Network error — check your connection and try again.");
    } finally {
      setAiPlanLoading(false);
    }
  };

  /**
   * Sync a task's done state to the backend and reconcile local state from
   * the server's response. Local state is updated optimistically before this
   * runs — this ensures the persisted state stays in sync.
   */
  const syncAIPlanTask = async (taskId: string, done: boolean) => {
    if (!authUser) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/planner/task/${encodeURIComponent(taskId)}/complete`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userId: authUser.id, done }),
      });
      if (!res.ok) {
        console.warn(`[planner] task sync failed: ${res.status}`);
        return;
      }
      const data = await res.json();
      // Reconcile local task done state from server response
      if (data.task) {
        setTasks((prev) =>
          prev.map((t) => t.id === taskId ? { ...t, done: data.task.done } : t)
        );
      }
    } catch (err) {
      console.warn("[planner] task sync error:", err);
      // Optimistic update stays — will reconcile on next app open via fetchTodayAIPlan
    }
  };

  // Once both auth and local storage are ready:
  //   1. Pull profile/blocks/streak/tasks from Supabase (source of truth for user data)
  //   2. Then fetch today's AI plan — runs AFTER Supabase so its task list wins
  // The AI plan fetch shows a loading state so users never see an empty-state flash.
  useEffect(() => {
    if (!authUser || !loaded) return;

    const init = async () => {
      // Show spinner immediately — prevents empty-state flash before data arrives.
      // React 19 batches this with the renders below, so no flicker.
      setAiPlanLoading(true);

      // Step 1 — Supabase user data (profile, blocks, streak, manual tasks)
      try {
        const token = await getAccessToken();
        if (token) {
          const data = await loadUserData(authUser.id, token);
          if (data) {
            if (data.profile) { setProfile(data.profile as Profile); setAuthed(true); }
            if (data.blocks)  setBlocks(data.blocks as ScheduleBlock[]);
            if (data.streak)  setStreak(data.streak as StreakData);
            if (data.tasks)   setTasks(data.tasks as TimedTask[]);
          }
        }
      } catch {
        // Non-fatal — local storage already populated state
      }

      // Step 2 — AI plan (overwrites tasks above if a plan exists for today)
      try {
        await fetchTodayAIPlan(authUser.id);
      } finally {
        setAiPlanLoading(false);
      }
    };

    init();
  }, [authUser, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save profile whenever it changes (after initial load)
  useEffect(() => {
    if (!loaded || !profile) return;
    AsyncStorage.setItem(STORE.profile, JSON.stringify(profile)).catch(console.warn);
    if (authUser) getAccessToken().then((t) => t && saveUserData(authUser.id, t, { profile })).catch(console.warn);
  }, [profile, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save blocks whenever they change (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.blocks, JSON.stringify(blocks)).catch(console.warn);
    if (authUser) getAccessToken().then((t) => t && saveUserData(authUser.id, t, { blocks })).catch(console.warn);
  }, [blocks, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save tasks whenever they change (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.tasks, JSON.stringify(tasks)).catch(console.warn);
    if (authUser) getAccessToken().then((t) => t && saveUserData(authUser.id, t, { tasks })).catch(console.warn);
  }, [tasks, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save chat messages and sessionId whenever either changes (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.chat, JSON.stringify({ messages, sessionId })).catch(console.warn);
  }, [messages, sessionId, loaded]);

  // Save streak whenever it changes (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.streak, JSON.stringify(streak)).catch(console.warn);
    if (authUser) getAccessToken().then((t) => t && saveUserData(authUser.id, t, { streak })).catch(console.warn);
  }, [streak, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save recovery whenever it changes (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.recovery, JSON.stringify(recovery)).catch(console.warn);
  }, [recovery, loaded]);

  // Save task feedback whenever it changes (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.feedback, JSON.stringify(taskFeedback)).catch(console.warn);
  }, [taskFeedback, loaded]);

  // Upsert today's score into history whenever score changes (after initial load)
  useEffect(() => {
    if (!loaded) return;
    const todayStr = new Date().toISOString().slice(0, 10);
    if (historyLastScoreRef.current === score && historyLastDateRef.current === todayStr) return;
    historyLastScoreRef.current = score;
    historyLastDateRef.current  = todayStr;
    setHistory((prev) => {
      const without = prev.filter((d) => d.date !== todayStr);
      return [...without, { date: todayStr, score, tasksTotal: tasks.length, tasksDone: tasks.filter((t) => t.done).length }]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-30);
    });
  }, [score, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save history whenever it changes (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.history, JSON.stringify(history)).catch(console.warn);
  }, [history, loaded]);

  useEffect(() => {
    (async () => {
      if (!authed) return;

      // Android needs a channel (safe to call on iOS too)
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("discipline", {
          name: "Discipline Reminders",
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      }

      const ok = await ensureNotificationPermissions();
      setNotifReady(ok);
      if (!ok) {
        Alert.alert(
          "Notifications are OFF",
          "Enable notifications for Expo Go in your phone settings to receive discipline reminders."
        );
      }
    })();
  }, [authed]);

  async function cancelAllScheduled() {
    try {
      for (const id of scheduledNotifIds) {
        await Notifications.cancelScheduledNotificationAsync(id);
      }
    } catch {}
    setScheduledNotifIds([]);
  }

  async function scheduleFromTasks(newTasks: TimedTask[]) {
    await cancelAllScheduled();

    if (!notifReady) return;

    const now = new Date();
    const ids: string[] = [];

    for (const t of newTasks) {
      const fireDate = dateForDayAtMinutes(t.timeMin, dayMode === "today" ? 0 : 1);

      // only schedule if in the future (give 30s buffer)
      if (fireDate.getTime() <= now.getTime() + 30_000) continue;

      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: "Aira",
          body: `${t.timeText} — ${t.title}`,
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireDate },
      });

      ids.push(id);
    }

    setScheduledNotifIds(ids);
  }

  function generatePlanFromProfileAndSchedule(p: Profile, schedule: ScheduleBlock[]) {
    const wakeMin = parseTimeToMinutes(p.wake);
    const sleepMin = parseTimeToMinutes(p.sleep);

    if (wakeMin == null || sleepMin == null) {
      Alert.alert("Time format issue", "Enter wake/sleep like '7:00 AM' or '23:00'.");
      return;
    }
    if (sleepMin <= wakeMin + 60) {
      Alert.alert("Sleep time issue", "Sleep must be at least 1 hour after wake.");
      return;
    }

    const plan = buildTodaysPlan({ wakeMin, sleepMin, blocks: schedule, profile: p });
    setTasks(plan);
    scheduleFromTasks(plan);
  }

  async function testReminderIn30s() {
    if (!notifReady) {
      Alert.alert("Notifications are OFF", "Enable notifications permission first.");
      return;
    }
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Aira (Test)",
        body: "If you see this, reminders are working ✅",
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 30  },
    });
    Alert.alert("Test scheduled", "You should get a notification in ~30 seconds.");
  }

  // ---------- Auth gate ----------
  // Show splash while Supabase checks stored session or AsyncStorage is loading.
  if (!authChecked || !loaded) return <Splash />;

  // No session → show sign in / sign up.
  if (!authUser) return <AuthScreen onSuccess={setAuthUser} />;

  // ---------- Onboarding ----------
  if (!authed) {
    // ── Shared option-card renderer ──────────────────────────────────────
    const OptionCard = ({
      value,
      label,
      desc,
      selected,
      onSelect,
    }: {
      value: string;
      label: string;
      desc: string;
      selected: boolean;
      onSelect: () => void;
    }) => (
      <Pressable
        onPress={onSelect}
        style={{
          backgroundColor: selected ? "#12122a" : "#0a0a0a",
          borderWidth: 1,
          borderColor: selected ? ACCENT : "#2d2b5a",
          borderRadius: 14,
          padding: 16,
          marginBottom: 10,
        }}
      >
        <Text style={{ color: "#fff", fontWeight: "800", fontSize: 14 }}>
          {label}
        </Text>
        <Text style={{ color: "#777", fontSize: 12, marginTop: 4 }}>
          {desc}
        </Text>
      </Pressable>
    );

    // ── Step 1 — Basic info ───────────────────────────────────────────────
    if (onboardingStep === 1) {
      const canAdvance = name.trim().length >= 2;
      return (
        <SafeAreaView style={styles.screen}>
          <StatusBar barStyle="light-content" />
          <Text style={styles.h1}>Aira</Text>
          <Text style={styles.sub}>Routine → Consistency → Physique.</Text>

          <Card>
            <Text style={styles.label}>Name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g., Nate"
              placeholderTextColor="#777"
              style={styles.input}
            />

            <View style={{ height: 12 }} />

            <Text style={styles.label}>Goal</Text>
            <TextInput value={goal} onChangeText={setGoal} style={styles.input} />

            <View style={{ height: 12 }} />

            <Text style={styles.label}>Wake time</Text>
            <TextInput value={wake} onChangeText={setWake} style={styles.input} />

            <View style={{ height: 12 }} />

            <Text style={styles.label}>Sleep time</Text>
            <TextInput value={sleep} onChangeText={setSleep} style={styles.input} />
          </Card>

          <View style={{ flexDirection: "row" }}>
            <PrimaryButton
              title="Next  →"
              disabled={!canAdvance}
              onPress={() => setOnboardingStep(2)}
            />
          </View>

          <Text style={styles.miniNote}>
            After setup you’ll be asked for notification permission. Approve it to activate reminders.
          </Text>
        </SafeAreaView>
      );
    }

    // ── Step 2 — Starting point ───────────────────────────────────────────
    const startingOptions = [
      { value: "soft",         label: "Soft / Skinny Fat",   desc: "Visible softness, low definition, little training base" },
      { value: "average",      label: "Average / Untrained", desc: "Normal composition, no consistent training history" },
      { value: "somewhat_lean",label: "Somewhat Lean",       desc: "Moderate body fat, some muscle, inconsistent training" },
      { value: "athletic",     label: "Athletic / Lean",     desc: "Low body fat, solid muscle base, active lifestyle" },
    ];

    if (onboardingStep === 2) {
      return (
        <SafeAreaView style={styles.screen}>
          <StatusBar barStyle="light-content" />
          <Text style={styles.h1}>Starting point</Text>
          <Text style={styles.sub}>Where are you right now?</Text>

          <View style={{ flex: 1 }}>
            {startingOptions.map((o) => (
              <OptionCard
                key={o.value}
                value={o.value}
                label={o.label}
                desc={o.desc}
                selected={startingPoint === o.value}
                onSelect={() => setStartingPoint(o.value)}
              />
            ))}
          </View>

          <View style={{ flexDirection: "row" }}>
            <PrimaryButton
              title="Next  →"
              disabled={startingPoint === ""}
              onPress={() => setOnboardingStep(3)}
            />
          </View>

          <Pressable onPress={() => setOnboardingStep(1)} style={{ alignItems: "center", paddingVertical: 10 }}>
            <Text style={styles.miniNote}>← Back</Text>
          </Pressable>
        </SafeAreaView>
      );
    }

    // ── Step 3 — Target goal + body-fat direction ────────────────────────
    const targetOptions = [
      { value: "lean_defined",   label: "Lean & Defined",     desc: "Visible muscle definition, athletic physique" },
      { value: "model_build",    label: "Model Build",         desc: "Very lean, V-taper, aesthetic proportions" },
      { value: "athletic_strong",label: "Athletic & Strong",   desc: "Strength and performance, lean but powerful" },
      { value: "shredded",       label: "Shredded",            desc: "Elite-level leanness, maximum definition" },
    ];
    const bodyFatOptions = [
      { value: "lose_fat",    label: "Lose Fat",         desc: "Reduce body fat — stay in a caloric deficit" },
      { value: "maintain",    label: "Maintain",          desc: "Hold current composition while building habits" },
      { value: "build_lean",  label: "Build Lean Mass",   desc: "Gain muscle with minimal fat — slight surplus" },
    ];

    if (onboardingStep === 3) {
      return (
        <SafeAreaView style={styles.screen}>
          <StatusBar barStyle="light-content" />
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
            <Text style={styles.h1}>Target</Text>
            <Text style={styles.sub}>What are you building toward?</Text>
            <View style={{ height: 12 }} />

            {targetOptions.map((o) => (
              <OptionCard
                key={o.value}
                value={o.value}
                label={o.label}
                desc={o.desc}
                selected={targetGoal === o.value}
                onSelect={() => setTargetGoal(o.value)}
              />
            ))}

            <View style={{ height: 16 }} />
            <Text style={styles.label}>Body composition direction</Text>
            <View style={{ height: 8 }} />

            {bodyFatOptions.map((o) => (
              <OptionCard
                key={o.value}
                value={o.value}
                label={o.label}
                desc={o.desc}
                selected={bodyFatDirection === o.value}
                onSelect={() => setBodyFatDirection(o.value)}
              />
            ))}

            <View style={{ height: 16 }} />
            <PrimaryButton
              title="Next  →"
              disabled={targetGoal === "" || bodyFatDirection === ""}
              onPress={() => setOnboardingStep(4)}
            />
            <Pressable onPress={() => setOnboardingStep(2)} style={{ alignItems: "center", paddingVertical: 10 }}>
              <Text style={styles.miniNote}>← Back</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      );
    }

    // ── Step 4 — Experience + equipment ──────────────────────────────────
    const experienceOptions = [
      { value: "beginner",     label: "Beginner",      desc: "New to structured training — under 1 year" },
      { value: "intermediate", label: "Intermediate",  desc: "1–3 years of consistent training" },
      { value: "advanced",     label: "Advanced",      desc: "3+ years, strong foundation and technique" },
    ];
    const equipmentOptions = [
      { value: "none",     label: "No Equipment",       desc: "Bodyweight only — home or travel workouts" },
      { value: "minimal",  label: "Minimal Equipment",  desc: "Dumbbells, bands, or a pull-up bar" },
      { value: "full_gym", label: "Full Gym Access",    desc: "Barbells, machines, full weight room" },
    ];

    if (onboardingStep === 4) {
      return (
        <SafeAreaView style={styles.screen}>
          <StatusBar barStyle="light-content" />
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
            <Text style={styles.h1}>Training setup</Text>
            <Text style={styles.sub}>How you train shapes the plan.</Text>
            <View style={{ height: 12 }} />

            <Text style={styles.label}>Experience level</Text>
            <View style={{ height: 8 }} />
            {experienceOptions.map((o) => (
              <OptionCard
                key={o.value}
                value={o.value}
                label={o.label}
                desc={o.desc}
                selected={experienceLevel === o.value}
                onSelect={() => setExperienceLevel(o.value)}
              />
            ))}

            <View style={{ height: 16 }} />
            <Text style={styles.label}>Available equipment</Text>
            <View style={{ height: 8 }} />
            {equipmentOptions.map((o) => (
              <OptionCard
                key={o.value}
                value={o.value}
                label={o.label}
                desc={o.desc}
                selected={equipment === o.value}
                onSelect={() => setEquipment(o.value)}
              />
            ))}

            <View style={{ height: 16 }} />
            <PrimaryButton
              title="Next  →"
              disabled={experienceLevel === "" || equipment === ""}
              onPress={() => setOnboardingStep(5)}
            />
            <Pressable onPress={() => setOnboardingStep(3)} style={{ alignItems: "center", paddingVertical: 10 }}>
              <Text style={styles.miniNote}>← Back</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      );
    }

    // ── Step 5 — Frequency + daily training time ──────────────────────────
    const frequencyOptions = [
      { value: "2x", label: "2× per week",  desc: "Minimal commitment — quality over quantity" },
      { value: "3x", label: "3× per week",  desc: "Solid foundation — standard recommendation" },
      { value: "4x", label: "4× per week",  desc: "Serious training — good recovery balance" },
      { value: "5x", label: "5× per week",  desc: "High frequency — advanced athletes" },
    ];
    const durationOptions = [
      { value: "20min", label: "20 minutes",  desc: "Short and focused — no time to waste" },
      { value: "30min", label: "30 minutes",  desc: "Efficient — most popular training window" },
      { value: "45min", label: "45 minutes",  desc: "Full session — warm-up through cooldown" },
      { value: "60min", label: "60 minutes",  desc: "Complete session — strength + accessory work" },
    ];

    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="light-content" />
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
          <Text style={styles.h1}>Schedule</Text>
          <Text style={styles.sub}>How often and how long?</Text>
          <View style={{ height: 12 }} />

          <Text style={styles.label}>Workout frequency</Text>
          <View style={{ height: 8 }} />
          {frequencyOptions.map((o) => (
            <OptionCard
              key={o.value}
              value={o.value}
              label={o.label}
              desc={o.desc}
              selected={workoutFrequency === o.value}
              onSelect={() => setWorkoutFrequency(o.value)}
            />
          ))}

          <View style={{ height: 16 }} />
          <Text style={styles.label}>Daily training time</Text>
          <View style={{ height: 8 }} />
          {durationOptions.map((o) => (
            <OptionCard
              key={o.value}
              value={o.value}
              label={o.label}
              desc={o.desc}
              selected={dailyTrainingTime === o.value}
              onSelect={() => setDailyTrainingTime(o.value)}
            />
          ))}

          <View style={{ height: 16 }} />
          <PrimaryButton
            title="Create my plan"
            disabled={workoutFrequency === "" || dailyTrainingTime === ""}
            onPress={() => {
              const p: Profile = {
                name: name.trim(),
                goal,
                wake,
                sleep,
                startingPoint,
                targetGoal,
                bodyFatDirection: bodyFatDirection as Profile["bodyFatDirection"],
                experienceLevel:  experienceLevel  as Profile["experienceLevel"],
                equipment:        equipment         as Profile["equipment"],
                workoutFrequency: workoutFrequency  as Profile["workoutFrequency"],
                dailyTrainingTime:dailyTrainingTime as Profile["dailyTrainingTime"],
              };
              setProfile(p);
              setAuthed(true);
              setTab("Today");
              generatePlanFromProfileAndSchedule(p, []);
            }}
          />
          <Pressable onPress={() => setOnboardingStep(4)} style={{ alignItems: "center", paddingVertical: 10 }}>
            <Text style={styles.miniNote}>← Back</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---------- Screens ----------
  const Today = () => {
    // visibleTasks and rebalancedTasks are computed at Index level (useMemo) and
    // available via closure — no recomputation needed here.
    const pausedCount = tasks.length - visibleTasks.length;

    const toggleTask = (id: string) => {
      // Snapshot the task before the state update so we can read its current values.
      const task = tasks.find((t) => t.id === id);
      const willBeCompleted = task ? !task.done : false;

      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));

      // Keep AI plan backend in sync when a plan is active (best-effort)
      if (aiPlan) syncAIPlanTask(id, willBeCompleted);

      // Record feedback for high-priority tasks only.
      // completed: true  → positive signal (done)
      // completed: false → missed/reversed signal (undone)
      if (task && (task.priority ?? "medium") === "high") {
        const entry: TaskFeedbackEntry = {
          taskId:    id,
          title:     task.title,
          kind:      task.kind,
          date:      new Date().toISOString().slice(0, 10),
          completed: willBeCompleted,
          readiness: gamePlan?.readiness ?? null,
        };
        setTaskFeedback((prev) => ({ ...prev, [id]: entry }));
      }

      // Update streak on the first task completion of the calendar day.
      // Simulate what the post-toggle state will look like before React re-renders.
      const todayStr = new Date().toISOString().slice(0, 10);
      if (streak.lastActiveDate !== todayStr) {
        const willHaveDone = tasks.some((t) => (t.id === id ? !t.done : t.done));
        if (willHaveDone) {
          const yest = new Date();
          yest.setDate(yest.getDate() - 1);
          const yesterdayStr = yest.toISOString().slice(0, 10);
          const newCurrent = streak.lastActiveDate === yesterdayStr
            ? streak.currentStreak + 1
            : 1;
          setStreak({
            currentStreak: newCurrent,
            bestStreak: Math.max(newCurrent, streak.bestStreak),
            lastActiveDate: todayStr,
          });
        }
      }
    };

    // Mock fallback — only active in dev builds when no real data is present.
    const isMockActive   = __DEV__ && DEV_MOCK_ENABLED && !aiPlanLoading && !aiPlanError && aiPlan === null && tasks.length === 0;
    const effectivePlan  = isMockActive ? DEV_MOCK_PLAN  : aiPlan;
    const effectiveTasks = isMockActive ? DEV_MOCK_TASKS : rebalancedTasks;
    const effectiveScore = isMockActive ? calcScore(DEV_MOCK_TASKS) : score;

    const doneCount  = effectiveTasks.filter((t) => t.done).length;
    const totalCount = effectiveTasks.length;
    const allDone    = totalCount > 0 && doneCount === totalCount;
    const dateStr    = new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });

    // ── Loading ────────────────────────────────────────────────────────────────
    if (aiPlanLoading) {
      return (
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 20 }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, borderWidth: 1, borderColor: ACCENT + "30", alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={ACCENT} size="small" />
          </View>
          <View style={{ alignItems: "center", gap: 6 }}>
            <Text style={{ color: "#ccc", fontSize: 15, fontWeight: "700" }}>Building your plan</Text>
            <Text style={{ color: "#444", fontSize: 12, fontWeight: "500" }}>Personalising to your day…</Text>
          </View>
        </View>
      );
    }

    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 2, paddingBottom: 48, gap: 0 }}
        showsVerticalScrollIndicator={false}
      >

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <View style={{ paddingBottom: 24 }}>
          <Text style={{ color: "#fff", fontSize: 32, fontWeight: "800", letterSpacing: -1 }}>Today</Text>
          <Text style={{ color: "#666", fontSize: 12, fontWeight: "600", marginTop: 4, letterSpacing: 0.2 }}>{dateStr}</Text>
          {profile?.name ? (
            <Text style={{ color: "#4a4a6a", fontSize: 13, marginTop: 6, fontWeight: "500" }}>
              {getGreeting()}, {profile.name}.
            </Text>
          ) : null}
          {isMockActive && (
            <View style={{ marginTop: 10, backgroundColor: "#1a1000", borderWidth: 1, borderColor: "#3a2800", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, alignSelf: "flex-start" }}>
              <Text style={{ color: "#8a6400", fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }}>DEV · MOCK DATA</Text>
            </View>
          )}
        </View>

        {/* ── Score anchor ────────────────────────────────────────────────────── */}
        {totalCount > 0 && (
          <View style={{
            backgroundColor: "#09090f",
            borderWidth: 1,
            borderColor: "#18182a",
            borderRadius: 16,
            padding: 20,
            marginBottom: 16,
          }}>
            <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }}>
              {/* Score */}
              <View style={{ gap: 5 }}>
                <Text style={{
                  color: effectiveScore >= 80 ? "#66bb6a" : "#fff",
                  fontSize: 52,
                  fontWeight: "900",
                  letterSpacing: -2,
                  lineHeight: 52,
                }}>
                  {effectiveScore}
                </Text>
                <Text style={{ color: "#2e2e48", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 }}>
                  DISCIPLINE SCORE
                </Text>
              </View>

              {/* Streak */}
              <View style={{ alignItems: "flex-end", gap: 5 }}>
                <Text style={{
                  color: liveStreak > 0 ? ACCENT : "#252535",
                  fontSize: 32,
                  fontWeight: "900",
                  letterSpacing: -1,
                  lineHeight: 32,
                }}>
                  {liveStreak}
                </Text>
                <Text style={{ color: "#2e2e48", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 }}>
                  {liveStreak === 1 ? "DAY STREAK" : "DAY STREAK"}
                </Text>
              </View>
            </View>

            {/* Progress bar */}
            <View style={{ marginTop: 20, gap: 7 }}>
              <View style={{ height: 2, backgroundColor: "#14142a", borderRadius: 1, overflow: "hidden" }}>
                <View style={{
                  height: 2,
                  width: `${Math.round((doneCount / totalCount) * 100)}%` as any,
                  backgroundColor: allDone ? "#66bb6a" : ACCENT,
                  borderRadius: 1,
                }} />
              </View>
              <Text style={{ color: "#2a2a42", fontSize: 11, fontWeight: "600" }}>
                {allDone
                  ? "All tasks complete"
                  : `${doneCount} of ${totalCount} complete`}
              </Text>
            </View>
          </View>
        )}

        {/* ── Game Plan strip ─────────────────────────────────────────────────── */}
        {gamePlan ? (
          <Pressable
            onPress={() => setShowMotivation(true)}
            style={{
              backgroundColor: gamePlan.color + "0d",
              borderWidth: 1,
              borderColor: gamePlan.color + "28",
              borderRadius: 14,
              padding: 14,
              marginBottom: 20,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
            }}
          >
            <View style={{ flex: 1, gap: 6 }}>
              <View style={{ flexDirection: "row", gap: 6 }}>
                <View style={{ backgroundColor: gamePlan.color + "20", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ color: gamePlan.color, fontSize: 10, fontWeight: "900", letterSpacing: 0.8 }}>
                    {gamePlan.readiness.toUpperCase()}
                  </Text>
                </View>
                <View style={{ backgroundColor: "#141414", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ color: "#666", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 }}>
                    {gamePlan.timeMode.toUpperCase()}
                  </Text>
                </View>
              </View>
              <Text style={{ color: "#bbb", fontSize: 13, lineHeight: 19, fontWeight: "500" }} numberOfLines={3}>
                {gamePlan.message}
              </Text>
            </View>
            <Text style={{ color: "#333", fontSize: 20 }}>›</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => setShowMotivation(true)}
            style={{
              backgroundColor: "#0c0c12",
              borderWidth: 1,
              borderColor: "#1c1c2a",
              borderRadius: 14,
              padding: 14,
              marginBottom: 20,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <View style={{ gap: 3 }}>
              <Text style={{ color: ACCENT, fontSize: 10, fontWeight: "900", letterSpacing: 0.8 }}>TODAY'S GAME PLAN</Text>
              <Text style={{ color: "#444", fontSize: 13 }}>Complete check-in to set today's direction.</Text>
            </View>
            <Text style={{ color: ACCENT, fontSize: 20 }}>›</Text>
          </Pressable>
        )}

        {/* ── Error state ─────────────────────────────────────────────────────── */}
        {aiPlanError && (
          <View style={{
            backgroundColor: "#110808",
            borderWidth: 1,
            borderColor: "#2e1010",
            borderRadius: 14,
            padding: 16,
            marginBottom: 20,
            gap: 10,
          }}>
            <Text style={{ color: "#ff5252", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 }}>PLAN ERROR</Text>
            <Text style={{ color: "#aa6666", fontSize: 13, lineHeight: 19 }}>{aiPlanError}</Text>
            <Pressable onPress={generateAIPlan}>
              <Text style={{ color: ACCENT, fontSize: 13, fontWeight: "700" }}>Try again →</Text>
            </Pressable>
          </View>
        )}

        {/* ── Plan exists ─────────────────────────────────────────────────────── */}
        {effectivePlan && !aiPlanError && (
          <>
            {/* Day focus summary */}
            <View style={{
              backgroundColor: "#0a0a12",
              borderWidth: 1,
              borderColor: "#16162a",
              borderRadius: 14,
              padding: 16,
              marginBottom: 20,
              gap: 6,
            }}>
              <Text style={{ color: "#4a4a7a", fontSize: 10, fontWeight: "800", letterSpacing: 1 }}>TODAY'S FOCUS</Text>
              <Text style={{ color: "#b0b0c0", fontSize: 14, lineHeight: 22, fontWeight: "500" }}>{effectivePlan.summary}</Text>
            </View>
          </>
        )}

        {/* ── Task list ───────────────────────────────────────────────────────── */}
        {totalCount > 0 ? (
          <View style={{ gap: 8, marginBottom: 28 }}>
            {/* Section header */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <Text style={{ color: "#2e2e48", fontSize: 10, fontWeight: "800", letterSpacing: 1 }}>
                TODAY'S TASKS
              </Text>
              {pausedCount > 0 && (
                <Text style={{ color: "#252535", fontSize: 10, fontWeight: "600" }}>
                  {pausedCount} paused · {gamePlan?.timeMode}
                </Text>
              )}
            </View>

            {effectiveTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggle={() => toggleTask(task.id)}
                onDetail={() => {
                  if (task.kind === "Workout") setWorkoutTask(task);
                  else setDetailTask(task);
                }}
              />
            ))}

          </View>
        ) : (
          /* ── Empty state ──────────────────────────────────────────────────── */
          <View style={{ alignItems: "center", paddingTop: 40, paddingBottom: 48, gap: 14 }}>
            <View style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              borderWidth: 1,
              borderColor: ACCENT + "28",
              backgroundColor: ACCENT + "08",
              alignItems: "center",
              justifyContent: "center",
            }}>
              <Text style={{ color: ACCENT + "60", fontSize: 22 }}>◎</Text>
            </View>
            <View style={{ alignItems: "center", gap: 6 }}>
              <Text style={{ color: "#ccc", fontSize: 15, fontWeight: "700" }}>No plan yet</Text>
              <Text style={{ color: "#444", fontSize: 13, textAlign: "center", lineHeight: 20, maxWidth: 240 }}>
                {gamePlan
                  ? "Your check-in is done. Generate your plan to see today's tasks."
                  : "Complete your daily check-in first, then generate a plan."}
              </Text>
            </View>
            {gamePlan ? (
              <Pressable
                onPress={generateAIPlan}
                style={{
                  marginTop: 4,
                  backgroundColor: ACCENT,
                  borderRadius: 14,
                  paddingVertical: 15,
                  paddingHorizontal: 32,
                }}
              >
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800", letterSpacing: 0.2 }}>Generate today's plan</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => setShowMotivation(true)}
                style={{
                  marginTop: 4,
                  backgroundColor: "#0e0e1c",
                  borderWidth: 1,
                  borderColor: ACCENT + "30",
                  borderRadius: 14,
                  paddingVertical: 15,
                  paddingHorizontal: 32,
                }}
              >
                <Text style={{ color: ACCENT, fontSize: 14, fontWeight: "800", letterSpacing: 0.2 }}>Start check-in</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* ── Coaching note + fallback ────────────────────────────────────────── */}
        {effectivePlan && (
          <View style={{ gap: 10, marginTop: 8 }}>
            {/* Coaching note card */}
            <View style={{
              backgroundColor: "#09090f",
              borderWidth: 1,
              borderColor: "#14142a",
              borderRadius: 14,
              padding: 16,
              gap: 6,
            }}>
              <Text style={{ color: "#4a4a7a", fontSize: 10, fontWeight: "800", letterSpacing: 1 }}>COACHING NOTE</Text>
              <Text style={{ color: "#9090a8", fontSize: 13, lineHeight: 20, fontWeight: "500" }}>{effectivePlan.coachingNote}</Text>
            </View>

            {/* Fallback card */}
            <View style={{
              backgroundColor: "#080808",
              borderWidth: 1,
              borderColor: "#111",
              borderRadius: 14,
              padding: 16,
              gap: 6,
            }}>
              <Text style={{ color: "#3a3a5a", fontSize: 10, fontWeight: "800", letterSpacing: 1 }}>IF THE DAY FALLS APART</Text>
              <Text style={{ color: "#585870", fontSize: 13, lineHeight: 20, fontStyle: "italic" }}>{effectivePlan.fallbackPlan}</Text>
            </View>

          </View>
        )}

        {/* ── Generate prompt — no plan yet but game plan exists ─────────────── */}
        {!effectivePlan && !aiPlanError && totalCount === 0 && gamePlan && (
          <View style={{ marginTop: 8 }} />
        )}

        {/* ── No AI plan but has local tasks — show generate nudge ────────────── */}
        {!effectivePlan && !aiPlanError && totalCount > 0 && (
          <Pressable
            onPress={generateAIPlan}
            style={{
              marginTop: 8,
              backgroundColor: ACCENT + "14",
              borderWidth: 1,
              borderColor: ACCENT + "35",
              borderRadius: 14,
              padding: 16,
              alignItems: "center",
              gap: 3,
            }}
          >
            <Text style={{ color: ACCENT, fontSize: 13, fontWeight: "800" }}>Generate AI plan →</Text>
            <Text style={{ color: ACCENT + "80", fontSize: 11, fontWeight: "500" }}>Replaces the local plan with a personalised one</Text>
          </Pressable>
        )}

        {/* ── Regenerate nudge when plan exists ─────────────────────────────── */}
        {effectivePlan && !isMockActive && totalCount > 0 && (
          <Pressable onPress={generateAIPlan} style={{ alignSelf: "flex-start", paddingVertical: 4, marginTop: 4 }}>
            <Text style={{ color: "#252535", fontSize: 12, fontWeight: "700" }}>Regenerate plan →</Text>
          </Pressable>
        )}
      </ScrollView>
    );
  };

  const Schedule = () => {
    // Kept local so typing doesn't re-render Index and dismiss the keyboard
    const [blockTitle, setBlockTitle] = useState("");
    const [blockType, setBlockType] = useState<BlockType>("Work");
    const [blockStart, setBlockStart] = useState("9:00 AM");
    const [blockEnd, setBlockEnd] = useState("5:00 PM");

    const typeButtons: BlockType[] = ["Work", "School", "Kids", "Commute", "Other"];

    const addBlock = () => {
      const title = blockTitle.trim() || blockType;
      const s = parseTimeToMinutes(blockStart);
      const e = parseTimeToMinutes(blockEnd);

      if (s == null || e == null) {
        Alert.alert("Time format", "Use times like '9:00 AM' or '13:30'.");
        return;
      }
      if (e <= s) {
        Alert.alert("Time range", "End time must be after start time.");
        return;
      }

      const newBlock: ScheduleBlock = {
        id: `blk_${Date.now()}`,
        title,
        type: blockType,
        startText: minutesToTimeText(s),
        endText: minutesToTimeText(e),
        startMin: s,
        endMin: e,
      };

      setBlocks((prev) => [...prev, newBlock].sort((a, b) => a.startMin - b.startMin));
      setBlockTitle("");
    };

    const removeBlock = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));

    return (
      <View style={{ flex: 1, gap: 12 }}>
        <Text style={styles.h2}>Schedule</Text>
        <Text style={styles.sub2}>Add blocks so the coach builds around your real life.</Text>

        <Card>
          <Text style={styles.label}>Add a block</Text>

          <Text style={styles.smallLabel}>Type</Text>
          <View style={styles.typeRow}>
            {typeButtons.map((t) => {
              const active = blockType === t;
              return (
                <Pressable key={t} onPress={() => setBlockType(t)} style={[styles.typeBtn, active && styles.typeBtnActive]}>
                  <Text style={[styles.typeText, active && styles.typeTextActive]}>{t}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.smallLabel}>Label (optional)</Text>
          <TextInput value={blockTitle} onChangeText={setBlockTitle} placeholder="e.g., Work shift" placeholderTextColor="#777" style={styles.input} />

          <View style={{ height: 10 }} />

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.smallLabel}>Start</Text>
              <TextInput value={blockStart} onChangeText={setBlockStart} style={styles.input} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.smallLabel}>End</Text>
              <TextInput value={blockEnd} onChangeText={setBlockEnd} style={styles.input} />
            </View>
          </View>

          <View style={{ height: 10 }} />
          <PrimaryButton title="Add block" onPress={addBlock} />
        </Card>

        <Card style={{ flex: 1 }}>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>Your blocks</Text>
            <Pressable
              onPress={() => {
                if (!profile) return;
                generatePlanFromProfileAndSchedule(profile, blocks);
                setTab("Today");
              }}
              style={styles.linkBtn}
            >
              <Text style={styles.linkText}>Generate Plan</Text>
            </Pressable>
          </View>

          {blocks.length === 0 ? (
            <Text style={styles.bodyMuted}>No blocks yet. Add Work/School/Kids time so the plan fits your day.</Text>
          ) : (
            <FlatList
              data={blocks}
              keyExtractor={(b) => b.id}
              ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
              renderItem={({ item }) => (
                <View style={styles.blockRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.blockTitle}>{item.title}</Text>
                    <Text style={styles.bodyMuted}>
                      {item.type} • {item.startText}–{item.endText}
                    </Text>
                  </View>

                  <Pressable onPress={() => removeBlock(item.id)} style={styles.removeBtn}>
                    <Text style={styles.removeText}>Remove</Text>
                  </Pressable>
                </View>
              )}
            />
          )}

        </Card>
      </View>
    );
  };

  // ---------- Progress ----------
  const Progress = () => {
    const done = tasks.filter((t) => t.done).length;
    const total = tasks.length;

    const kinds: TaskKind[] = ["Workout", "Nutrition", "Hydration", "Mobility", "Recovery", "Habit", "Sleep", "Walk", "Meal"];
    const breakdown = kinds
      .map((k) => ({
        kind: k,
        done: tasks.filter((t) => t.kind === k && t.done).length,
        total: tasks.filter((t) => t.kind === k).length,
      }))
      .filter((b) => b.total > 0);

    // Derived insights from today's data
    const complete  = breakdown.filter((b) => b.done === b.total);
    const untouched = breakdown.filter((b) => b.done === 0);
    const partial   = breakdown.filter((b) => b.done > 0 && b.done < b.total);

    const insight = (() => {
      if (total === 0) return "Generate a plan in Today to start tracking your progress.";
      if (score === 100) return "Flawless day. Every category complete — that's the standard.";
      if (complete.length > 0 && untouched.length > 0)
        return `${complete.map((b) => b.kind).join(" and ")} ${complete.length === 1 ? "is" : "are"} done. ${untouched[0].kind} still needs attention.`;
      if (complete.length > 0 && partial.length > 0)
        return `Strong on ${complete.map((b) => b.kind).join(", ")}. Finish your ${partial[0].kind} to close the day out.`;
      if (complete.length > 0)
        return `${complete.map((b) => b.kind).join(", ")} ${complete.length === 1 ? "is" : "are"} complete. Keep building.`;
      if (untouched.length === breakdown.length)
        return "Start with your first task to build today's momentum.";
      return `${partial.length} categor${partial.length === 1 ? "y" : "ies"} in progress. Finish what you started.`;
    })();

    const scoreStatus = (() => {
      if (total === 0)       return "No plan yet — go to Today and generate one.";
      if (score === 100)     return "Perfect day. Every task complete.";
      if (score >= 75)       return "Strong day. Keep the momentum going.";
      if (score >= 50)       return "Halfway there. Finish strong.";
      if (score > 0)         return "You've started. Keep going.";
      return "No tasks completed yet today.";
    })();

    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
        <View style={{ gap: 12 }}>
          <Text style={styles.h2}>Progress</Text>
          <Text style={styles.sub2}>{profile?.goal ?? "Your goal"}</Text>

          {/* Streaks */}
          <Card>
            <Text style={styles.label}>Streaks</Text>
            <View style={[styles.rowBetween, { marginTop: 6 }]}>
              <Text style={styles.bodyMuted}>Current streak</Text>
              <Text style={[styles.label, { color: liveStreak > 0 ? ACCENT : "#555" }]}>
                {liveStreak} day{liveStreak !== 1 ? "s" : ""}
              </Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={styles.bodyMuted}>Best streak</Text>
              <Text style={styles.label}>
                {streak.bestStreak} day{streak.bestStreak !== 1 ? "s" : ""}
              </Text>
            </View>
            {streak.bestStreak > 0 && (
              <Text style={[styles.miniNote, { marginTop: 6, color: liveStreak >= streak.bestStreak ? ACCENT : "#555" }]}>
                {liveStreak >= streak.bestStreak
                  ? "Current streak is your best — keep going."
                  : `${streak.bestStreak - liveStreak} day${streak.bestStreak - liveStreak !== 1 ? "s" : ""} from your best`}
              </Text>
            )}
          </Card>

          {/* Weekly snapshot */}
          {(() => {
            const todayStr = new Date().toISOString().slice(0, 10);
            const days = Array.from({ length: 7 }, (_, i) => {
              const d = new Date();
              d.setDate(d.getDate() - (6 - i));
              const dateStr = d.toISOString().slice(0, 10);
              const entry   = history.find((h) => h.date === dateStr);
              const label   = d.toLocaleDateString("en", { weekday: "short" });
              const isToday = dateStr === todayStr;
              return { dateStr, label, entry, isToday };
            });
            const hasAny = days.some((d) => d.entry);
            if (!hasAny && history.length === 0) return null;
            return (
              <Card>
                <Text style={styles.label}>This week</Text>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 10 }}>
                  {days.map(({ dateStr, label, entry, isToday }) => {
                    const s = entry?.score ?? 0;
                    const boxColor =
                      s === 100 ? "#66bb6a" :
                      s >= 50   ? ACCENT    :
                      s > 0     ? "#3a3060" : "#1a1a1a";
                    const textColor =
                      s === 100 ? "#66bb6a" :
                      s >= 50   ? ACCENT    :
                      s > 0     ? "#666"    : "#333";
                    return (
                      <View key={dateStr} style={{ alignItems: "center", gap: 4 }}>
                        <View
                          style={{
                            width: 36, height: 36, borderRadius: 8,
                            backgroundColor: boxColor,
                            borderWidth: isToday ? 1 : 0,
                            borderColor: ACCENT,
                            alignItems: "center", justifyContent: "center",
                          }}
                        >
                          {s > 0 && (
                            <Text style={{ color: s >= 50 ? "#fff" : "#666", fontSize: 9, fontWeight: "700" }}>
                              {s}%
                            </Text>
                          )}
                        </View>
                        <Text style={[styles.miniNote, { fontSize: 9, color: isToday ? ACCENT : "#555" }]}>
                          {label}
                        </Text>
                      </View>
                    );
                  })}
                </View>
                <View style={{ flexDirection: "row", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
                  {[
                    { color: "#66bb6a", label: "Perfect" },
                    { color: ACCENT,    label: "50%+" },
                    { color: "#3a3060", label: "Started" },
                    { color: "#1a1a1a", label: "No data" },
                  ].map((k) => (
                    <View key={k.label} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: k.color }} />
                      <Text style={[styles.miniNote, { fontSize: 9 }]}>{k.label}</Text>
                    </View>
                  ))}
                </View>
              </Card>
            );
          })()}

          {/* Today's performance */}
          <Card>
            <View style={styles.rowBetween}>
              <Text style={styles.label}>Today's performance</Text>
              <Chip label={`${score}/100`} />
            </View>
            <View
              style={{
                height: 6,
                backgroundColor: "#1a1a1a",
                borderRadius: 3,
                marginTop: 10,
                marginBottom: 6,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  height: 6,
                  borderRadius: 3,
                  width: `${score}%`,
                  backgroundColor: score === 100 ? "#66bb6a" : ACCENT,
                }}
              />
            </View>
            <Text style={styles.bodyMuted}>{scoreStatus}</Text>
            {total > 0 && (
              <Text style={[styles.miniNote, { marginTop: 4 }]}>
                {done} of {total} tasks completed
              </Text>
            )}
            {total > 0 && (
              <View style={[styles.rowBetween, { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#1a1a1a" }]}>
                <Text style={styles.bodyMuted}>Recovery</Text>
                <Text style={[styles.label, {
                  color: recoveryStatus === "High"  ? "#66bb6a" :
                         recoveryStatus === "Solid" ? ACCENT    : "#FF9800",
                  fontSize: 13,
                }]}>
                  {recoveryStatus}
                </Text>
              </View>
            )}
          </Card>

          {/* Check-in summary */}
          {(() => {
            const todayStr = new Date().toISOString().slice(0, 10);
            if (recovery.date !== todayStr || !recovery.energyLevel) return null;
            const rows: { label: string; value: string; good: boolean | null }[] = [
              {
                label: "Energy",
                value: recovery.energyLevel.charAt(0).toUpperCase() + recovery.energyLevel.slice(1),
                good:  recovery.energyLevel === "high" ? true : recovery.energyLevel === "low" ? false : null,
              },
              {
                label: "Body",
                value: recovery.soreness
                  ? recovery.soreness.charAt(0).toUpperCase() + recovery.soreness.slice(1)
                  : "—",
                good:  recovery.soreness === "fresh" ? true : recovery.soreness === "sore" ? false : null,
              },
              {
                label: "Motivation",
                value: recovery.motivationLevel
                  ? recovery.motivationLevel.charAt(0).toUpperCase() + recovery.motivationLevel.slice(1)
                  : "—",
                good:  recovery.motivationLevel === "high" ? true : recovery.motivationLevel === "low" ? false : null,
              },
              {
                label: "Time",
                value: recovery.timeAvailable === "minimal" ? "< 30 min"
                     : recovery.timeAvailable === "moderate" ? "~1 hour"
                     : recovery.timeAvailable === "full" ? "2+ hours"
                     : "—",
                good:  recovery.timeAvailable === "full" ? true : recovery.timeAvailable === "minimal" ? false : null,
              },
              {
                label: "Focus",
                value: recovery.focusArea
                  ? recovery.focusArea.charAt(0).toUpperCase() + recovery.focusArea.slice(1)
                  : "—",
                good:  null,
              },
            ];
            return (
              <Card>
                <View style={styles.rowBetween}>
                  <Text style={styles.label}>Today's check-in</Text>
                  <Pressable onPress={() => setShowMotivation(true)}>
                    <Text style={[styles.miniNote, { color: ACCENT }]}>Update →</Text>
                  </Pressable>
                </View>
                <View style={{ gap: 8, marginTop: 6 }}>
                  {rows.map((r) => (
                    <View key={r.label} style={styles.rowBetween}>
                      <Text style={styles.bodyMuted}>{r.label}</Text>
                      <Text style={[styles.miniNote, {
                        color: r.good === true ? "#66bb6a" : r.good === false ? "#FF9800" : "#bdbdbd",
                        fontWeight: "700",
                      }]}>
                        {r.value}
                      </Text>
                    </View>
                  ))}
                </View>
              </Card>
            );
          })()}

          {/* Adherence summary */}
          {tasks.length > 0 && (() => {
            const workoutTasks    = tasks.filter((t) => t.kind === "Workout");
            const nutritionTasks  = tasks.filter((t) => t.kind === "Nutrition");
            const hydrationTasks  = tasks.filter((t) => t.kind === "Hydration");

            if (!workoutTasks.length && !nutritionTasks.length && !hydrationTasks.length) return null;

            const workoutDone    = workoutTasks.filter((t) => t.done).length;
            const nutritionDone  = nutritionTasks.filter((t) => t.done).length;
            const hydrationDone  = hydrationTasks.filter((t) => t.done).length;

            const adherenceRows: { label: string; done: number; total: number }[] = [
              ...(workoutTasks.length  ? [{ label: "Training",   done: workoutDone,   total: workoutTasks.length   }] : []),
              ...(nutritionTasks.length ? [{ label: "Nutrition",  done: nutritionDone, total: nutritionTasks.length  }] : []),
              ...(hydrationTasks.length ? [{ label: "Hydration",  done: hydrationDone, total: hydrationTasks.length  }] : []),
            ];
            return (
              <Card>
                <Text style={styles.label}>Adherence</Text>
                <View style={{ gap: 8, marginTop: 6 }}>
                  {adherenceRows.map((r) => {
                    const allDone = r.done === r.total;
                    const none    = r.done === 0;
                    const color   = allDone ? "#66bb6a" : none ? "#555" : ACCENT;
                    const label   = allDone ? "Complete ✓" : none ? "Pending" : `${r.done}/${r.total}`;
                    return (
                      <View key={r.label} style={styles.rowBetween}>
                        <Text style={styles.bodyMuted}>{r.label}</Text>
                        <Text style={[styles.miniNote, { color, fontWeight: "700" }]}>{label}</Text>
                      </View>
                    );
                  })}
                </View>
              </Card>
            );
          })()}

          {/* By category with colour bars */}
          {breakdown.length > 0 && (
            <Card>
              <Text style={styles.label}>By category</Text>
              <View style={{ gap: 10, marginTop: 6 }}>
                {breakdown.map((b) => {
                  const pct = b.total === 0 ? 0 : Math.round((b.done / b.total) * 100);
                  const kindColor = KIND_COLORS[b.kind]?.color ?? "#555";
                  const kindBg    = KIND_COLORS[b.kind]?.backgroundColor ?? "#111";
                  return (
                    <View key={b.kind} style={{ gap: 4 }}>
                      <View style={styles.rowBetween}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                          <View
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: 4,
                              backgroundColor: kindColor,
                            }}
                          />
                          <Text style={styles.bodyMuted}>{b.kind}</Text>
                        </View>
                        <Text style={[styles.miniNote, b.done === b.total && { color: kindColor }]}>
                          {b.done}/{b.total}{b.done === b.total ? " ✓" : ""}
                        </Text>
                      </View>
                      <View
                        style={{
                          height: 4,
                          backgroundColor: kindBg,
                          borderRadius: 2,
                          overflow: "hidden",
                        }}
                      >
                        <View
                          style={{
                            height: 4,
                            borderRadius: 2,
                            width: `${pct}%`,
                            backgroundColor: kindColor,
                          }}
                        />
                      </View>
                    </View>
                  );
                })}
              </View>
            </Card>
          )}

          {/* Today's insight */}
          {total > 0 && (
            <Card>
              <Text style={styles.label}>Today's insight</Text>
              <Text style={[styles.bodyMuted, { marginTop: 4, lineHeight: 20 }]}>
                {insight}
              </Text>
            </Card>
          )}

          {tasks.length > 0 && (
            <Card>
              <Text style={styles.label}>Task list</Text>
              <View style={{ gap: 8, marginTop: 4 }}>
                {tasks.map((t) => (
                  <View key={t.id} style={styles.rowBetween}>
                    <Text
                      style={[
                        styles.bodyMuted,
                        t.done && { textDecorationLine: "line-through", color: "#555" },
                      ]}
                    >
                      {t.timeText}{"  "}{t.title}
                    </Text>
                    <Text style={styles.miniNote}>{t.done ? "✓" : "·"}</Text>
                  </View>
                ))}
              </View>
            </Card>
          )}

          {(() => {
            const myEntry: LeaderboardEntry = {
              id: "me",
              name: profile?.name ?? "You",
              currentStreak: liveStreak,
              bestStreak: streak.bestStreak,
              isMe: true,
            };
            const board: LeaderboardEntry[] = [
              myEntry,
              ...SAMPLE_USERS.map((u) => ({ ...u, isMe: false })),
            ].sort(
              (a, b) =>
                b.bestStreak - a.bestStreak ||
                b.currentStreak - a.currentStreak
            );
            return (
              <Card>
                <View style={styles.rowBetween}>
                  <Text style={styles.label}>D1 Leaderboard</Text>
                  <Chip label={`${board.length} athletes`} />
                </View>
                <Text style={[styles.miniNote, { marginBottom: 8 }]}>
                  Ranked by best streak
                </Text>
                <View style={[styles.rowBetween, { marginBottom: 4 }]}>
                  <Text style={[styles.miniNote, { width: 24 }]}>#</Text>
                  <Text style={[styles.miniNote, { flex: 1 }]}>Name</Text>
                  <Text style={[styles.miniNote, { width: 52, textAlign: "right" }]}>Streak</Text>
                  <Text style={[styles.miniNote, { width: 40, textAlign: "right" }]}>Best</Text>
                </View>
                {board.map((entry, i) => {
                  const rank = i + 1;
                  const rankColor =
                    rank === 1 ? ACCENT : rank <= 3 ? "#fff" : "#555";
                  return (
                    <View
                      key={entry.id}
                      style={[
                        styles.rowBetween,
                        { paddingVertical: 5, borderRadius: 6, paddingHorizontal: 4 },
                        entry.isMe && {
                          backgroundColor: "#12122a",
                          borderWidth: 1,
                          borderColor: ACCENT,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.miniNote,
                          { width: 24, color: rankColor, fontWeight: "700" },
                        ]}
                      >
                        {rank}
                      </Text>
                      <Text style={[styles.bodyMuted, { flex: 1 }]}>
                        {entry.name}
                        {entry.isMe && (
                          <Text style={{ color: ACCENT }}> (you)</Text>
                        )}
                      </Text>
                      <Text
                        style={[
                          styles.bodyMuted,
                          { width: 52, textAlign: "right" },
                        ]}
                      >
                        {entry.currentStreak}d
                      </Text>
                      <Text
                        style={[
                          styles.bodyMuted,
                          { width: 40, textAlign: "right" },
                        ]}
                      >
                        {entry.bestStreak}d
                      </Text>
                    </View>
                  );
                })}
              </Card>
            );
          })()}
        </View>
      </ScrollView>
    );
  };

  // ---------- Settings ----------
  const Settings = () => {
    const [editName, setEditName] = useState(profile?.name ?? "");
    const [editGoal, setEditGoal] = useState(profile?.goal ?? "");
    const [editWake, setEditWake] = useState(profile?.wake ?? "7:00 AM");
    const [editSleep, setEditSleep] = useState(profile?.sleep ?? "11:00 PM");

    const saveProfile = () => {
      const updated: Profile = {
        ...profile!,
        name: editName.trim(),
        goal: editGoal.trim(),
        wake: editWake.trim(),
        sleep: editSleep.trim(),
      };
      if (!updated.name) {
        Alert.alert("Name required", "Please enter your name.");
        return;
      }
      setProfile(updated);
      Alert.alert("Saved", "Your profile has been updated.");
    };

    const resetApp = () => {
      Alert.alert(
        "Reset app",
        "This will delete your profile, schedule, tasks, and chat history. This cannot be undone.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Reset",
            style: "destructive",
            onPress: async () => {
              await AsyncStorage.multiRemove(Object.values(STORE));
              setProfile(null);
              setBlocks([]);
              setTasks([]);
              setMessages([]);
              setSessionId(null);
              setStreak({ currentStreak: 0, bestStreak: 0, lastActiveDate: "" });
              setAuthed(false);
            },
          },
        ]
      );
    };

    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
        <View style={{ gap: 12 }}>
          <Text style={styles.h2}>Settings</Text>
          <Text style={styles.sub2}>Adjust your profile and preferences.</Text>

          <Card>
            <Text style={styles.label}>Profile</Text>
            <Text style={styles.smallLabel}>Name</Text>
            <TextInput
              value={editName}
              onChangeText={setEditName}
              placeholderTextColor="#777"
              style={styles.input}
            />
            <Text style={styles.smallLabel}>Goal</Text>
            <TextInput
              value={editGoal}
              onChangeText={setEditGoal}
              placeholderTextColor="#777"
              style={styles.input}
            />
            <Text style={styles.smallLabel}>Wake time</Text>
            <TextInput
              value={editWake}
              onChangeText={setEditWake}
              placeholderTextColor="#777"
              style={styles.input}
            />
            <Text style={styles.smallLabel}>Sleep time</Text>
            <TextInput
              value={editSleep}
              onChangeText={setEditSleep}
              placeholderTextColor="#777"
              style={styles.input}
            />
            <View style={{ height: 10 }} />
            <PrimaryButton title="Save profile" onPress={saveProfile} />
          </Card>

          <Card>
            <Text style={styles.label}>Notifications</Text>
            <View style={styles.rowBetween}>
              <Text style={styles.bodyMuted}>
                Status: {notifReady ? "Enabled" : "Disabled"}
              </Text>
              {scheduledNotifIds.length > 0 && (
                <Chip label={`${scheduledNotifIds.length} scheduled`} />
              )}
            </View>
            {!notifReady ? (
              <Text style={styles.miniNote}>
                To enable, open your phone's Settings → Notifications → Expo Go and turn them on.
              </Text>
            ) : (
              <Text style={styles.miniNote}>
                {scheduledNotifIds.length === 0
                  ? "No reminders scheduled. Go to Today to set them."
                  : "Reminders are active for today's plan."}
              </Text>
            )}
            <View style={{ height: 6 }} />
            <SmallButton title="Test reminder (30s)" onPress={testReminderIn30s} />
          </Card>

          <Card>
            <Text style={styles.label}>Data</Text>
            <Text style={styles.bodyMuted}>
              Erase everything and return to onboarding.
            </Text>
            <View style={{ height: 8 }} />
            <SmallButton title="Reset app" onPress={resetApp} />
          </Card>

          <Card>
            <Text style={styles.label}>Account</Text>
            <Text style={styles.bodyMuted}>
              {authUser?.email ?? "Signed in"}
            </Text>
            <View style={{ height: 8 }} />
            <SmallButton
              title="Sign out"
              onPress={async () => {
                await authSignOut();
                await AsyncStorage.multiRemove(Object.values(STORE));
                setProfile(null);
                setBlocks([]);
                setTasks([]);
                setMessages([]);
                setSessionId(null);
                setStreak({ currentStreak: 0, bestStreak: 0, lastActiveDate: "" });
                setRecovery({ date: "", energyLevel: null });
                setGamePlan(null);
                setAuthed(false);
                setAuthUser(null);
              }}
            />
          </Card>
        </View>
      </ScrollView>
    );
  };

  // ---------- Authenticated shell ----------
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <View style={{ flex: 1 }}>
        {tab === "Today" && Today()}
        {tab === "Schedule" && <Schedule />}
        {tab === "Chat" && (
          <ChatScreen
            messages={messages}
            setMessages={setMessages}
            sessionId={sessionId}
            setSessionId={setSessionId}
            profile={profile}
            recovery={recovery}
            blocks={blocks}
            tasks={tasks}
            rebalancedTasks={rebalancedTasks}
            recoveryStatus={recoveryStatus}
            liveStreak={liveStreak}
            score={score}
            gamePlan={gamePlan}
          />
        )}
        {tab === "Progress" && <Progress />}
        {tab === "Settings" && <Settings />}
      </View>
      <View style={styles.tabBar}>
        {(["Today", "Schedule", "Chat", "Progress", "Settings"] as TabKey[]).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>

      {/* ---------- Workout detail modal ---------- */}
      <WorkoutDetailModal
        task={workoutTask}
        taskDone={tasks.find((t) => t.id === workoutTask?.id)?.done ?? false}
        visible={workoutTask !== null}
        onClose={() => setWorkoutTask(null)}
        onCompleteTask={(id) => toggleTaskById(id)}
      />

      {/* ---------- Task detail modal ---------- */}
      <TaskDetailModal
        task={detailTask}
        visible={detailTask !== null}
        onClose={() => setDetailTask(null)}
        onToggle={(id) => {
          toggleTaskById(id);
          // Reflect toggled state immediately in the modal's task reference
          setDetailTask((prev) => prev ? { ...prev, done: !prev.done } : null);
        }}
      />

      {/* ---------- Daily check-in modal ---------- */}
      <Modal
        visible={showMotivation}
        transparent
        animationType="fade"
        onRequestClose={() => setShowMotivation(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.92)", justifyContent: "center", padding: 20 }}>
          <ScrollView contentContainerStyle={{ paddingVertical: 16 }} showsVerticalScrollIndicator={false}>
            <View style={[styles.card, { gap: 18 }]}>
              <View style={{ gap: 4 }}>
                <Text style={styles.label}>Daily check-in</Text>
                <Text style={styles.bodyMuted}>Good morning, {profile?.name ?? "Coach"}. 5 questions.</Text>
              </View>

              {/* Energy */}
              <View style={{ gap: 8 }}>
                <Text style={styles.smallLabel}>Energy level</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {(["low", "moderate", "high"] as const).map((v) => (
                    <Pressable
                      key={v}
                      onPress={() => setCiEnergy(v)}
                      style={[styles.smallBtn, { flex: 1 }, ciEnergy === v && { borderColor: ACCENT, backgroundColor: "#12122a" }]}
                    >
                      <Text style={[styles.smallBtnText, ciEnergy === v && { color: ACCENT }]}>
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Soreness */}
              <View style={{ gap: 8 }}>
                <Text style={styles.smallLabel}>Body / soreness</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {([
                    { value: "fresh", label: "Fresh" },
                    { value: "mild",  label: "Mild"  },
                    { value: "sore",  label: "Sore"  },
                  ] as const).map((o) => (
                    <Pressable
                      key={o.value}
                      onPress={() => setCiSoreness(o.value)}
                      style={[styles.smallBtn, { flex: 1 }, ciSoreness === o.value && { borderColor: ACCENT, backgroundColor: "#12122a" }]}
                    >
                      <Text style={[styles.smallBtnText, ciSoreness === o.value && { color: ACCENT }]}>{o.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Motivation */}
              <View style={{ gap: 8 }}>
                <Text style={styles.smallLabel}>Motivation level</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {(["low", "moderate", "high"] as const).map((v) => (
                    <Pressable
                      key={v}
                      onPress={() => setCiMotivation(v)}
                      style={[styles.smallBtn, { flex: 1 }, ciMotivation === v && { borderColor: ACCENT, backgroundColor: "#12122a" }]}
                    >
                      <Text style={[styles.smallBtnText, ciMotivation === v && { color: ACCENT }]}>
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Time available */}
              <View style={{ gap: 8 }}>
                <Text style={styles.smallLabel}>Time available today</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {([
                    { value: "minimal",  label: "< 30 min" },
                    { value: "moderate", label: "~1 hour"  },
                    { value: "full",     label: "2+ hours" },
                  ] as const).map((o) => (
                    <Pressable
                      key={o.value}
                      onPress={() => setCiTime(o.value)}
                      style={[styles.smallBtn, { flex: 1 }, ciTime === o.value && { borderColor: ACCENT, backgroundColor: "#12122a" }]}
                    >
                      <Text style={[styles.smallBtnText, ciTime === o.value && { color: ACCENT }]}>{o.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Focus */}
              <View style={{ gap: 8 }}>
                <Text style={styles.smallLabel}>Focus for today</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {([
                    { value: "workout",     label: "Workout"     },
                    { value: "nutrition",   label: "Nutrition"   },
                    { value: "consistency", label: "Consistency" },
                    { value: "recovery",    label: "Recovery"    },
                  ] as const).map((o) => (
                    <Pressable
                      key={o.value}
                      onPress={() => setCiFocus(o.value)}
                      style={[styles.smallBtn, { minWidth: "45%" as any }, ciFocus === o.value && { borderColor: ACCENT, backgroundColor: "#12122a" }]}
                    >
                      <Text style={[styles.smallBtnText, ciFocus === o.value && { color: ACCENT }]}>{o.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={{ gap: 10, marginTop: 4 }}>
                <PrimaryButton
                  title="Lock in"
                  disabled={!ciEnergy || !ciSoreness || !ciMotivation || !ciTime || !ciFocus}
                  onPress={() => {
                    const todayDate = new Date().toISOString().slice(0, 10);
                    const newRecovery: RecoveryData = {
                      date:            todayDate,
                      energyLevel:     ciEnergy,
                      soreness:        ciSoreness,
                      motivationLevel: ciMotivation,
                      timeAvailable:   ciTime,
                      focusArea:       ciFocus,
                    };
                    setRecovery(newRecovery);
                    setGamePlan(generateGamePlan(newRecovery));
                    setShowMotivation(false);
                  }}
                />
                <Pressable onPress={() => setShowMotivation(false)} style={{ alignItems: "center", paddingVertical: 8 }}>
                  <Text style={styles.miniNote}>Skip for today</Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}