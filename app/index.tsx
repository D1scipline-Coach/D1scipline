import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import Svg, { Circle, Defs, LinearGradient as SvgLinearGradient, Path, Stop } from "react-native-svg";
import AuthScreen from "../components/AuthScreen";
import OnboardingFlow from "../components/onboarding/OnboardingFlow";
import { type AiraUserProfile, flattenProfileForAPI, computeProfileMeta } from "../shared/types/profile";
import { generateDailyPlan, type GeneratedDailyPlan } from "../shared/planner/generateDailyPlan";
import type { AIPlan, TimedTask, TaskKind, TaskPriority, TaskTag, AIWorkoutExercise } from "../shared/types/appTypes";
import { generateLocalAiraPlan } from "../shared/integration/airaIntegrationBridge";
import { AiraIntelligenceError } from "../shared/intelligence/utils/AiraIntelligenceError";
import { getAccessToken, loadSession, signOut as authSignOut, type AuthUser } from "../lib/auth";
import { loadUserData, saveUserData } from "../lib/db";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Alert,
  Dimensions,
  FlatList,
  Image,
  ImageBackground,
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

// Animated SVG circle — enables animating strokeDashoffset for the progress ring
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// ---------- Storage keys ----------
//
// Plan storage relationship:
//   dc:ai_plan       — PRIMARY. AIPlan JSON written by the local Aira bridge on every
//                      successful plan generation (onboarding or regenerate). This is
//                      the source of truth on app restart. Preferred over dc:generated_plan.
//   dc:generated_plan — LEGACY FALLBACK ONLY. Written by the pre-Aira rule-based planner.
//                      Only read at startup when dc:ai_plan is absent (backward compat
//                      for devices that ran the app before Phase 7). Never written by
//                      the Aira path except in the onboarding error fallback.
//   dc:tasks          — Task list stored independently. Auto-saved by useEffect on every
//                      task state change. Restored at startup regardless of which plan
//                      key is present, so task done-states survive app restarts.
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
  patterns:       "dc:patterns",
  programPlan:    "dc:program_plan",
  generatedPlan:  "dc:generated_plan", // legacy — see note above
  aiPlan:         "dc:ai_plan",        // primary Aira plan — see note above
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
// Profile is the canonical nested user profile — see shared/types/profile.ts
type Profile = AiraUserProfile;

type DayLog     = { date: string; score: number; tasksTotal: number; tasksDone: number; evalStatus?: DayEvalStatus };

// Cumulative behavior patterns — persisted across sessions, updated on every task toggle.
// kindDone:    completions per category. kindUndone: unchecks per category (skip proxy).
// workoutSlots: how many workouts completed in each part of the day.
// Adaptive Day Engine trigger types (defined here so PredictiveInsight can reference them)
type AdaptTrigger = "less_time" | "missed_workout" | "low_completion" | "low_energy" | "shift_later";

// A single proactive coaching insight — shown before failure happens
type PredictiveInsight = {
  key:     string;
  label:   string;
  message: string;
  action?: { label: string; trigger: AdaptTrigger };
};

type BehaviorPatterns = {
  kindDone:     Partial<Record<TaskKind, number>>;
  kindUndone:   Partial<Record<TaskKind, number>>;
  workoutSlots: { morning: number; afternoon: number; evening: number };
};
const emptyPatterns = (): BehaviorPatterns => ({
  kindDone: {}, kindUndone: {}, workoutSlots: { morning: 0, afternoon: 0, evening: 0 },
});
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

// TaskKind, TaskPriority, TaskTag, TimedTask — imported from shared/types/appTypes

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

// Long-term user memory — derived from persisted history + behavior patterns.
// Computed via useMemo; all inputs are already persisted so no separate storage needed.
type UserMemory = {
  preferredWorkoutTime:  "morning" | "afternoon" | "evening" | null;
  mostSkippedCategory:   TaskKind | null;
  consistencyScore:      number; // 0–100, rolling 7-day completion %
  lastMissedWorkoutTime: number | null; // timeMin of today's missed workout task
};

// AIPlan — imported from shared/types/appTypes

// Multi-day program structure — foundation for Plan first → Adapt daily
type ProgramDay = {
  dayIndex: number;    // 0 = day program was generated, 1 = next day, etc.
  tasks:    TimedTask[];
};

type ProgramPlan = {
  generatedDate: string;    // YYYY-MM-DD — anchor date for dayIndex 0
  days:          ProgramDay[];
};

// Signals that drive forward adjustments to upcoming program days
type ProgramSignals = {
  missedWorkout:           boolean;
  missedWorkoutTask?:      TimedTask;   // kept for legacy compatibility
  missedHighPriorityTasks: TimedTask[]; // all missed high-priority tasks (capped at 2 in function)
  lowEnergy:               boolean;
  highCompletion:          boolean;
  recoveryModeTriggered:   boolean;
  dayMissed:               boolean;     // dayEvaluation.status === "MISS"
};

// AIWorkoutExercise — imported from shared/types/appTypes

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

// Replace getNutritionForTask() to connect to real data without touching this schema.
type MealEntry = {
  id:      string;
  label:   string;   // "Breakfast", "Lunch", "Dinner", "Snack"
  time:    string;   // "7:30 AM"
  focus:   string;   // one-line description of this meal's job
  example: string;   // suggested foods — short, scannable
};

type NutritionPlan = {
  plan_id:     string;
  title:       string;
  focus:       string;    // day-level objective
  calories:    number | null;
  protein_g:   number | null;
  meals:       MealEntry[];
  groceryList: string[];
};

// Replace getRecoveryForTask() to connect to real data without touching this schema.
type RecoveryStep = {
  id:       string;
  label:    string;   // "Foam Roll Quads", "Box Breathing", etc.
  duration: string;   // "60 sec", "5 min", "8 hr" — displayed as-is
  cue:      string;   // one-line coaching instruction
};

type RecoveryPlan = {
  plan_id:      string;
  type:         "Sleep" | "Stretch" | "Cold" | "Rest";  // drives the display colour + icon
  title:        string;
  focus:        string;        // one-sentence day-level objective
  duration_min: number | null; // total duration in minutes (null = overnight / open)
  steps:        RecoveryStep[];
  coachingCue:  string;        // closing directive shown at the bottom
};

type TabKey = "Home" | "Coach" | "Progress";

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

/** Strips redundant ":00" from time strings for cleaner display: "7:00 AM" → "7 AM". */
function formatDisplayTime(t: string): string {
  return t.replace(/:00 /, " ");
}

/**
 * Returns the sleep duration in minutes, correctly handling overnight ranges.
 * e.g. sleep "11:30 PM" → wake "7:30 AM" = 480 min (not negative).
 * Adds 1440 to wakeMin when wake <= sleep (crosses midnight).
 * Returns null if either string fails to parse.
 */
function sleepDurationMins(sleepTimeStr: string, wakeTimeStr: string): number | null {
  const s = parseTimeToMinutes(sleepTimeStr);
  const w = parseTimeToMinutes(wakeTimeStr);
  if (s == null || w == null) return null;
  const adjustedWake = w <= s ? w + 1440 : w;
  return adjustedWake - s;
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

/**
 * Converts the user's saved schedule blocks into a compact context string
 * that describes busy time and free windows.
 * Used for: (1) injecting into the AI plan prompt (server-side mirrors this),
 *           (2) generating the UI feedback note shown after plan generation.
 */
/**
 * Extracts today's tasks from a stored ProgramPlan.
 * currentDayIndex = days elapsed since programPlan.generatedDate.
 * Returns [] when the program doesn't cover the requested day yet.
 */
function getTodayFromProgram(plan: ProgramPlan, currentDayIndex: number): TimedTask[] {
  return plan.days.find((d) => d.dayIndex === currentDayIndex)?.tasks ?? [];
}

/**
 * Derives the correct program day index for right now.
 *
 * Rules:
 *   Same calendar day as generatedDate  → 0
 *   Each elapsed calendar day           → +1
 *   Beyond the last generated day       → clamped to highest available dayIndex
 *   programPlan is null / empty         → 0 (safe fallback)
 *
 * Date arithmetic uses UTC strings to stay consistent with how generatedDate is stored.
 */
function getCurrentProgramDayIndex(
  plan: ProgramPlan | null,
  now:  Date = new Date(),
): number {
  if (!plan || !plan.days.length) return 0;

  // Use UTC date strings for both sides so timezone offsets don't skew the diff
  const startMs   = new Date(plan.generatedDate).getTime();           // midnight UTC of generation day
  const todayMs   = new Date(now.toISOString().slice(0, 10)).getTime(); // midnight UTC of today
  const elapsed   = Math.max(0, Math.round((todayMs - startMs) / 86400000));

  // Clamp: never exceed the highest dayIndex present in the program
  const maxDayIndex = Math.max(...plan.days.map((d) => d.dayIndex));
  return Math.min(elapsed, maxDayIndex);
}

/**
 * Applies today's outcome signals as forward adjustments to upcoming program days.
 * Pure function — never mutates past or current day. Returns an updated ProgramPlan.
 *
 * Rules (applied in order, each is independent):
 *   MISSED_WORKOUT   → inject the missed task into the next day if it has no workout yet
 *   LOW_ENERGY       → mark next-day Workout tasks as "(light)" at medium priority
 *   HIGH_COMPLETION  → promote up to 2 medium tasks on the next day to high priority
 *   RECOVERY_MODE    → elevate Mobility/Hydration/Sleep/Recovery, downgrade Workout
 */
/**
 * Applies today's performance signals as forward adjustments to the next program day.
 * Pure function — never mutates past or current day. Returns a new ProgramPlan.
 *
 * Rules applied in order:
 *   1. CARRYOVER      — inject up to 2 missed high-priority tasks into the next day
 *   2. LOW ENERGY     — soften Workout tasks on the next day (light label + medium priority)
 *   3. HIGH COMPLETION — promote up to 2 medium tasks to high (only on a genuinely good day)
 *   4. RECOVERY MODE  — elevate rest tasks, downgrade Workout
 *   5. MISS / RESET   — remove low-priority tasks + trim 1 medium to reduce volume
 *
 * Framing for rule 5: "reset and refocus" — not punishment.
 */
function updateFutureProgramDays(
  plan:            ProgramPlan,
  currentDayIndex: number,
  signals:         ProgramSignals,
): ProgramPlan {
  const {
    missedHighPriorityTasks,
    lowEnergy,
    highCompletion,
    recoveryModeTriggered,
    dayMissed,
  } = signals;

  const hasCarryovers = missedHighPriorityTasks.length > 0;
  const hasAnySignal  = hasCarryovers || lowEnergy || highCompletion || recoveryModeTriggered || dayMissed;
  if (!hasAnySignal) return plan;

  const nextIndex  = currentDayIndex + 1;
  const hasNextDay = plan.days.some((d) => d.dayIndex === nextIndex);

  // Enforce max 2 carryovers — avoid overloading the next day
  const toCarry = missedHighPriorityTasks.slice(0, 2);

  let days = plan.days.map((day): ProgramDay => {
    if (day.dayIndex <= currentDayIndex) return day; // immutable guard: past + current
    if (day.dayIndex !== nextIndex)      return day; // only touch the immediate next day

    let tasks = [...day.tasks];

    // 1. CARRYOVER — inject missed high-priority tasks, grouped by kind, no duplicates
    if (hasCarryovers) {
      for (const missed of toCarry) {
        // Skip if an identical task already exists (prevent duplication on re-trigger)
        const alreadyExists = tasks.some(
          (t) => t.kind === missed.kind && t.title === missed.title
        );
        if (alreadyExists) continue;

        // Workout: never stack two in one day
        if (missed.kind === "Workout" && tasks.some((t) => t.kind === "Workout")) continue;

        // Prefer inserting after the last task of the same kind for logical grouping
        const sameKind   = tasks.filter((t) => t.kind === missed.kind);
        const insertTime = sameKind.length > 0
          ? Math.max(...sameKind.map((t) => t.timeMin)) + 30
          : missed.timeMin;

        tasks = [...tasks, { ...missed, timeMin: insertTime, done: false, tag: "carried_over" as TaskTag }]
          .sort((a, b) => a.timeMin - b.timeMin);
      }
    }

    // 2. LOW ENERGY — soften Workout tasks (append "(light)", drop to medium priority)
    if (lowEnergy) {
      tasks = tasks.map((t) =>
        t.kind !== "Workout" ? t : {
          ...t,
          title:    t.title.includes("(light)") ? t.title : `${t.title} (light)`,
          priority: "medium" as TaskPriority,
        }
      );
    }

    // 3. HIGH COMPLETION — promote up to 2 medium tasks to high (good days only)
    if (highCompletion && !lowEnergy && !recoveryModeTriggered && !dayMissed) {
      let bumped = 0;
      tasks = tasks.map((t) => {
        if (bumped < 2 && (t.priority ?? "medium") === "medium") {
          bumped++;
          return { ...t, priority: "high" as TaskPriority, tag: "focus" as TaskTag };
        }
        return t;
      });
    }

    // 4. RECOVERY MODE — elevate Mobility/Hydration/Sleep/Recovery, downgrade Workout
    if (recoveryModeTriggered) {
      tasks = tasks.map((t) => {
        if (t.kind === "Workout") return { ...t, priority: "low" as TaskPriority };
        if (
          t.kind === "Mobility" || t.kind === "Hydration" ||
          t.kind === "Sleep"    || t.kind === "Recovery"
        ) return { ...t, priority: "high" as TaskPriority };
        return t;
      });
    }

    // 5. MISS / RESET — remove low-priority tasks + trim 1 medium to reduce volume
    //    High-priority tasks (including just-carried ones) are never removed.
    if (dayMissed) {
      tasks = tasks.filter((t) => (t.priority ?? "medium") !== "low");
      // Drop the last medium-priority task (reduces volume without gutting the plan)
      const lastMedIdx = tasks.map((t) => t.priority ?? "medium").lastIndexOf("medium");
      if (lastMedIdx !== -1) tasks = tasks.filter((_, i) => i !== lastMedIdx);
    }

    return { ...day, tasks };
  });

  // CARRYOVER edge case: next day doesn't exist in the program yet — create a stub
  if (hasCarryovers && !hasNextDay) {
    const stubTasks = toCarry
      .filter((missed) => {
        // Same no-dup / no-stack rules as above, but against an empty day
        if (missed.kind === "Workout" &&
            toCarry.filter((t) => t.kind === "Workout").indexOf(missed) > 0) return false;
        return true;
      })
      .map((t) => ({ ...t, done: false, tag: "carried_over" as TaskTag }));
    if (stubTasks.length) {
      days = [...days, { dayIndex: nextIndex, tasks: stubTasks }]
        .sort((a, b) => a.dayIndex - b.dayIndex);
    }
  }

  return { ...plan, days };
}

function getScheduleContext(blocks: ScheduleBlock[]): string {
  if (!blocks.length) return "";

  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin);

  function fmtHour(min: number): string {
    const h = Math.floor(min / 60) % 24;
    const m = min % 60;
    const suf = h < 12 ? "AM" : "PM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${suf}` : `${h12}:${pad2(m)}${suf}`;
  }

  const busyParts = sorted.map((b) => `${b.title} (${fmtHour(b.startMin)}–${fmtHour(b.endMin)})`);

  // Detect free gaps anchored to a rough 6AM–10PM day
  const WAKE = 6 * 60, SLEEP = 22 * 60;
  const free: string[] = [];
  if (sorted[0].startMin - WAKE > 30) free.push(`before ${fmtHour(sorted[0].startMin)}`);
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].startMin - sorted[i].endMin;
    if (gap > 30) free.push(`${fmtHour(sorted[i].endMin)}–${fmtHour(sorted[i + 1].startMin)}`);
  }
  const last = sorted[sorted.length - 1];
  if (SLEEP - last.endMin > 30) free.push(`after ${fmtHour(last.endMin)}`);

  let out = `Busy: ${busyParts.join(", ")}.`;
  if (free.length) out += ` Free: ${free.join(", ")}.`;
  return out.slice(0, 200);
}

/**
 * Derives a short human-readable note about how the plan was adapted
 * to the user's schedule. Shown as a subtle line in Today's plan section.
 */
function getScheduleNote(blocks: ScheduleBlock[]): string | null {
  if (!blocks.length) return null;

  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin);
  const totalBusy = sorted.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const dayLen = 16 * 60; // assume 6AM–10PM window
  const busyRatio = totalBusy / dayLen;

  if (busyRatio > 0.6) return "Tight schedule — focused plan.";

  // Surface the dominant block type
  const typeCounts: Partial<Record<string, number>> = {};
  for (const b of sorted) typeCounts[b.type] = (typeCounts[b.type] ?? 0) + 1;
  const topType = Object.entries(typeCounts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]?.[0];

  const first = sorted[0];
  const last  = sorted[sorted.length - 1];

  function fmtHour(min: number): string {
    const h = Math.floor(min / 60) % 24;
    const m = min % 60;
    const suf = h < 12 ? "AM" : "PM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${suf}` : `${h12}:${pad2(m)}${suf}`;
  }

  if (topType === "Work" && sorted.length === 1) {
    return `Built around your ${fmtHour(first.startMin)}–${fmtHour(last.endMin)} schedule.`;
  }
  if (sorted.length === 1) {
    return `Built around your ${first.title.toLowerCase()} block.`;
  }
  return `Built around ${sorted.length} committed block${sorted.length !== 1 ? "s" : ""}.`;
}

/**
 * Generates a short, human-readable explanation of why the plan looks the way it does.
 * Derived entirely from available client-side context — no extra API call.
 * Returns null when no meaningful explanation exists (section is hidden).
 *
 * Priority order:
 *   1. Game plan mode (Recover / Minimal) — most explanatory
 *   2. Heavy schedule pressure  (>60% busy)
 *   3. Workout placement relative to schedule blocks
 *   4. Moderate schedule — conflict avoidance
 *   5. Behaviour pattern — workout time preference
 *   6. Behaviour pattern — previously skipped kind moved earlier
 */
function buildPlanRationale(
  tasks:  TimedTask[],
  blocks: ScheduleBlock[],
  gamePlan: GamePlan | null,
  pi: {
    preferredWorkoutTime: "morning" | "afternoon" | "evening" | null;
    mostSkippedKind:      TaskKind | null;
    hasData:              boolean;
  }
): string | null {
  if (!tasks.length) return null;

  // 1 — Game plan mode overrides everything else
  if (gamePlan?.readiness === "Recover") {
    return "Recovery day — rest and repair take priority over intensity.";
  }
  if (gamePlan?.timeMode === "Minimal") {
    return "Minimal mode — one focused task beats a long list left untouched.";
  }

  const workout   = tasks.find((t) => t.kind === "Workout");
  const hasBlocks = blocks.length > 0;

  if (hasBlocks) {
    const totalBusy = blocks.reduce((s, b) => s + (b.endMin - b.startMin), 0);
    const busyRatio = totalBusy / (16 * 60); // fraction of a 16-hr waking day

    // 2 — Heavy day: plan was compressed
    if (busyRatio > 0.6) {
      return "Tight schedule today — the plan keeps only what will actually move the needle.";
    }

    // 3 — Workout placement driven by which windows are free
    if (workout) {
      const wMin              = workout.timeMin;
      const blocksInMorning   = blocks.some((b) => b.startMin < 12 * 60 && b.endMin > 6 * 60);
      const blocksInAfternoon = blocks.some((b) => b.startMin < 17 * 60 && b.endMin > 12 * 60);

      if (wMin < 12 * 60 && blocksInAfternoon && !blocksInMorning) {
        return "Your workout leads the day — afternoon commitments make the morning your strongest window.";
      }
      if (wMin < 12 * 60 && !blocksInMorning) {
        return "Workout placed early while your morning is free — the best window before your schedule fills up.";
      }
      if (wMin >= 12 * 60 && wMin < 17 * 60 && blocksInMorning) {
        return "Workout scheduled after your morning commitments — your first open window of the day.";
      }
    }

    // 4 — Moderate schedule: conflict-avoidance explanation
    if (busyRatio > 0.2) {
      return "Tasks were slotted into your free windows — nothing conflicts with your commitments.";
    }
  }

  // 5 & 6 — Behaviour pattern explanations (only when we have enough data)
  if (pi.hasData) {
    if (workout && pi.preferredWorkoutTime) {
      const wMin = workout.timeMin;
      const matchesPref =
        (pi.preferredWorkoutTime === "morning"   && wMin <  12 * 60) ||
        (pi.preferredWorkoutTime === "afternoon" && wMin >= 12 * 60 && wMin < 17 * 60) ||
        (pi.preferredWorkoutTime === "evening"   && wMin >= 17 * 60);
      if (matchesPref) {
        return `Workout in the ${pi.preferredWorkoutTime} — that's when you're most consistent.`;
      }
    }

    if (pi.mostSkippedKind) {
      const skippedTask = tasks.find((t) => t.kind === pi.mostSkippedKind);
      if (skippedTask && skippedTask.timeMin < 14 * 60) {
        return `${pi.mostSkippedKind} is earlier today — you tend to skip it when it's left for later.`;
      }
    }
  }

  return null; // no explanation worth surfacing
}

// ─── Coach Personality System ────────────────────────────────────────────────
//
// Derives the current coaching tone from observable user state.
// Drives: chat prompt injection, UI labels, auto-pilot banner phrasing.
// Pure function — no side effects, no React hooks.

type CoachMode = "PUSH" | "BUILD" | "RECOVERY";

const COACH_MODE_META: Record<CoachMode, { label: string; color: string; sub: string }> = {
  PUSH:     { label: "PUSH MODE",     color: "#FF5252", sub: "Direct · Urgent · Challenging"   },
  BUILD:    { label: "BUILD MODE",    color: "#6C63FF", sub: "Structured · Focused · Forward"   },
  RECOVERY: { label: "RECOVERY MODE", color: "#FFB300", sub: "Calm · Simple · Supportive"      },
};

function getCoachMode(p: {
  todayDoneCount:      number;
  rebalancedTaskCount: number;
  liveStreak:          number;
  gamePlan:            GamePlan | null;
  energyLevel:         RecoveryData["energyLevel"];
  adaptTrigger:        AdaptTrigger | null;
  hasWorkoutRecovered: boolean;
  hasMiddayAdjusted:   boolean;
  hasDayRecovered:     boolean;
}): CoachMode {
  const { todayDoneCount, rebalancedTaskCount, liveStreak, gamePlan,
          energyLevel, adaptTrigger, hasWorkoutRecovered, hasMiddayAdjusted, hasDayRecovered } = p;
  const nowHour = new Date().getHours();

  // RECOVERY — body/plan signals override everything
  if (gamePlan?.readiness === "Recover")                         return "RECOVERY";
  if (energyLevel === "low")                                     return "RECOVERY";
  if (adaptTrigger === "low_energy" || adaptTrigger === "less_time") return "RECOVERY";
  if (hasWorkoutRecovered || hasMiddayAdjusted || hasDayRecovered)  return "RECOVERY";

  // PUSH — time pressure or streak at risk
  const streakAtRisk  = liveStreak > 0 && todayDoneCount === 0 && nowHour >= 12;
  const runningLate   = todayDoneCount === 0 && nowHour >= 14;
  const lateAndBehind = nowHour >= 18 && rebalancedTaskCount > 0
    && todayDoneCount < Math.ceil(rebalancedTaskCount / 2);

  if (streakAtRisk || runningLate || lateAndBehind) return "PUSH";

  return "BUILD";
}

// Mode-aware auto-pilot banner messages — selected at trigger time based on current mode
const AUTO_PILOT_BANNERS: Record<
  "MIDDAY_ADJUST" | "MISSED_WORKOUT_AUTO" | "DAY_RECOVERY",
  Record<CoachMode, string>
> = {
  MIDDAY_ADJUST: {
    PUSH:     "Running behind — stripped to essentials. Move now.",
    BUILD:    "Plan adjusted to keep you on track.",
    RECOVERY: "We're adjusting — still time for a solid win.",
  },
  MISSED_WORKOUT_AUTO: {
    PUSH:     "Workout window passed. Re-prioritized — get it done now.",
    BUILD:    "Workout moved — still time to get it done.",
    RECOVERY: "Workout re-slotted — a short session still counts.",
  },
  DAY_RECOVERY: {
    PUSH:     "Evening sprint — essentials only. Execute.",
    BUILD:    "Refocusing your day.",
    RECOVERY: "Simplified for the evening — let's finish clean.",
  },
};

// ─── AI Command System ────────────────────────────────────────────────────────
//
// Keyword-based intent detection — no NLP, no dependencies.
// Returns a structured command when the user's chat message signals a plan action.
// Runs client-side before the AI request so the plan updates feel instant.

type CommandType = "LESS_TIME" | "MISSED_WORKOUT" | "LOW_ENERGY" | "SHIFT_LATER" | "LOCK_PLAN";
type Command = { type: CommandType } | null;

// ─────────────────────────────────────────────────────────────────────────────
// Next Best Action — real-time decision engine
// ─────────────────────────────────────────────────────────────────────────────

type NextAction = {
  label:   string;
  taskId?: string;
  reason:  string;
};

function getNextBestAction(p: {
  tasks:     TimedTask[];
  coachMode: CoachMode;
  nowMin:    number;
}): NextAction | null {
  const { tasks, coachMode, nowMin } = p;
  const undone = tasks.filter((t) => !t.done);
  if (!undone.length) return null;

  const doneCount  = tasks.length - undone.length;
  const totalCount = tasks.length;

  // 1. Nothing done yet — return first high-priority task
  if (doneCount === 0) {
    const first = undone.find((t) => (t.priority ?? "medium") === "high") ?? undone[0];
    return { label: first.title, taskId: first.id, reason: "Start your day — momentum matters." };
  }

  // 2. Workout not done and the window is still open (within the next 3 hours)
  const workout = undone.find((t) => t.kind === "Workout");
  if (workout && workout.timeMin <= nowMin + 3 * 60) {
    return { label: workout.title, taskId: workout.id, reason: "Best time to train based on your schedule." };
  }

  // 3. Behind schedule: < 40% complete and past noon
  const completionPct = totalCount > 0 ? doneCount / totalCount : 0;
  if (completionPct < 0.4 && nowMin >= 12 * 60) {
    const highImpact = undone.find((t) => (t.priority ?? "medium") === "high") ?? undone[0];
    return { label: highImpact.title, taskId: highImpact.id, reason: "Let's secure a win and build momentum." };
  }

  // 4. Recovery mode — return the easiest meaningful task
  if (coachMode === "RECOVERY") {
    const kindOrder: Partial<Record<TaskKind, number>> = {
      Mobility: 0, Hydration: 1, Recovery: 2, Habit: 3, Nutrition: 4, Sleep: 5, Workout: 6,
    };
    const easiest = [...undone].sort(
      (a, b) => (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9)
    )[0];
    return { label: easiest.title, taskId: easiest.id, reason: "Keep it light — stay consistent." };
  }

  // 5. Next chronological high-priority task
  const nextHigh = undone
    .filter((t) => (t.priority ?? "medium") === "high")
    .sort((a, b) => a.timeMin - b.timeMin)[0];
  const next = nextHigh ?? [...undone].sort((a, b) => a.timeMin - b.timeMin)[0];
  return { label: next.title, taskId: next.id, reason: "Your next priority — keep the momentum going." };
}

// ─────────────────────────────────────────────────────────────────────────────
// Win Condition — daily success framework
// ─────────────────────────────────────────────────────────────────────────────

type WinCondition = {
  primary:    string;
  secondary?: string;
  flex?:      string[];
};

function getWinCondition(p: {
  tasks:       TimedTask[];
  coachMode:   CoachMode;
  gamePlan:    GamePlan | null;
  adaptTrigger: AdaptTrigger | null;
}): WinCondition | null {
  const { tasks, coachMode, gamePlan, adaptTrigger } = p;
  if (!tasks.length) return null;

  const undone   = tasks.filter((t) => !t.done);
  const highUndone = undone.filter((t) => (t.priority ?? "medium") === "high");
  const isCompressed = adaptTrigger === "less_time" || gamePlan?.timeMode === "Minimal"
    || adaptTrigger === "low_energy";
  const isTight  = gamePlan?.timeMode === "Condensed" || adaptTrigger === "shift_later";

  // Recovery mode — single achievable outcome
  if (coachMode === "RECOVERY" || gamePlan?.readiness === "Recover") {
    const mobility  = undone.find((t) => t.kind === "Mobility"  && !t.done);
    const hydration = undone.find((t) => t.kind === "Hydration" && !t.done);
    const primary = mobility?.title ?? hydration?.title ?? "Complete one recovery task";
    return { primary };
  }

  // Plan compressed (minimal/less_time) — one thing only
  if (isCompressed) {
    const workout   = undone.find((t) => t.kind === "Workout");
    const topHigh   = highUndone[0];
    const primary   = workout?.title ?? topHigh?.title ?? undone[0]?.title ?? "One thing done";
    return { primary };
  }

  // Workout is high priority and undone — anchor the day around it
  const workoutHigh = highUndone.find((t) => t.kind === "Workout");
  if (workoutHigh) {
    const second = highUndone.find((t) => t.id !== workoutHigh.id && t.kind !== "Workout");
    const flexItems = isTight ? [] : undone
      .filter((t) => (t.priority ?? "medium") !== "high" && t.id !== workoutHigh.id)
      .slice(0, 2)
      .map((t) => t.title);
    return {
      primary:   workoutHigh.title,
      ...(second    ? { secondary: second.title } : {}),
      ...(flexItems.length ? { flex: flexItems } : {}),
    };
  }

  // No workout anchor — use top two high-priority tasks
  if (highUndone.length >= 2) {
    const flexItems = isTight ? [] : undone
      .filter((t) => (t.priority ?? "medium") !== "high")
      .slice(0, 2)
      .map((t) => t.title);
    return {
      primary:   highUndone[0].title,
      secondary: highUndone[1].title,
      ...(flexItems.length ? { flex: flexItems } : {}),
    };
  }

  if (highUndone.length === 1) {
    const flexItems = undone
      .filter((t) => (t.priority ?? "medium") !== "high")
      .slice(0, 2)
      .map((t) => t.title);
    return {
      primary: highUndone[0].title,
      ...(flexItems.length ? { flex: flexItems } : {}),
    };
  }

  // All tasks are medium/low — just take the first chronological one
  if (undone.length > 0) {
    return { primary: undone[0].title };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Day Evaluation — end-of-day accountability
// ─────────────────────────────────────────────────────────────────────────────

type DayEvalStatus = "WIN" | "PARTIAL" | "MISS";

type DayEvaluation = {
  status:          DayEvalStatus;
  message:         string;
  focusTomorrow?:  string;
};

function evaluateDay(p: {
  tasks:             TimedTask[];
  winCondition:      WinCondition | null;
  consistencyScore:  number;
  coachMode:         CoachMode;
}): DayEvaluation {
  const { tasks, winCondition, consistencyScore, coachMode } = p;

  const totalCount = tasks.length;
  const doneCount  = tasks.filter((t) => t.done).length;
  const pct        = totalCount > 0 ? doneCount / totalCount : 0;

  // Determine primary completion
  const primaryTask = winCondition?.primary
    ? tasks.find((t) => t.title === winCondition.primary)
    : null;
  const primaryDone = primaryTask ? primaryTask.done : pct >= 0.8;

  // Determine secondary completion
  const secondaryTask = winCondition?.secondary
    ? tasks.find((t) => t.title === winCondition.secondary)
    : null;
  const secondaryDone = secondaryTask ? secondaryTask.done : pct >= 0.5;

  // Identify the most impactful undone category for tomorrow focus
  const missedHighTasks = tasks.filter(
    (t) => !t.done && (t.priority ?? "medium") === "high"
  );
  const missedKind = missedHighTasks[0]?.kind ?? null;
  const focusTomorrow = missedKind
    ? missedKind === "Workout"   ? "Get your workout done early — don't let it slip again."
    : missedKind === "Nutrition" ? "Simplify nutrition — one solid meal is enough to start."
    : missedKind === "Habit"     ? "Lock in your habit first thing tomorrow."
    : missedKind === "Sleep"     ? "Prioritise sleep prep — it sets the next day's tone."
    : `Finish your ${missedKind.toLowerCase()} task earlier tomorrow.`
    : undefined;

  // Tone variants per coach mode
  const winMsg: Record<CoachMode, string> = {
    PUSH:     "Strong day. You handled what mattered — don't lose that edge.",
    BUILD:    "Strong day. You handled what mattered.",
    RECOVERY: "Good day. You kept it going — consistency is the whole game.",
  };
  const partialMsg: Record<CoachMode, string> = {
    PUSH:     "Not enough. Solid effort, but tighten execution tomorrow — primary must happen.",
    BUILD:    "Solid effort. Let's tighten execution tomorrow.",
    RECOVERY: "Decent day. One thing at a time — let's close the gap tomorrow.",
  };
  const missMsg: Record<CoachMode, string> = {
    PUSH:     "We missed today. That's not acceptable. Reset hard and come back stronger.",
    BUILD:    "We missed today. Reset and come back stronger.",
    RECOVERY: "Today didn't go to plan. That's okay — reset tomorrow and make one thing happen.",
  };

  if (primaryDone) {
    return { status: "WIN", message: winMsg[coachMode] };
  }

  if (secondaryDone || pct >= 0.4) {
    return {
      status:  "PARTIAL",
      message: partialMsg[coachMode],
      ...(focusTomorrow ? { focusTomorrow } : {}),
    };
  }

  return {
    status:  "MISS",
    message: missMsg[coachMode],
    ...(focusTomorrow ? { focusTomorrow } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Readiness Check — start-of-day input interpretation
// ─────────────────────────────────────────────────────────────────────────────

type ReadinessLevel = "RECOVER" | "BUILD" | "PUSH";

type ReadinessState = {
  readiness: ReadinessLevel;
  reason:    string;
};

/**
 * Derive a ReadinessState from the already-computed gamePlan + energyState.
 * Delegates the heavy mapping to generateGamePlan (single source of truth);
 * this function only adds the human-readable reason string.
 */
function getReadinessState(p: {
  gamePlan:    GamePlan | null;
  energyState: EnergyState;
  energyLevel: RecoveryData["energyLevel"];
  soreness:    RecoveryData["soreness"];
}): ReadinessState | null {
  const { gamePlan, energyState, energyLevel, soreness } = p;

  // No check-in yet — nothing to show
  if (!gamePlan && energyLevel === null) return null;

  // Map gamePlan.readiness → ReadinessLevel (gamePlan is authoritative post check-in)
  if (gamePlan) {
    const level: ReadinessLevel =
      gamePlan.readiness === "Push"    ? "PUSH"    :
      gamePlan.readiness === "Recover" ? "RECOVER" :
      "BUILD";

    const reason =
      level === "PUSH"
        ? "Strong energy and readiness — press your advantage today."
        : level === "RECOVER"
        ? soreness === "sore"
          ? "Body is flagging soreness — simplify and protect recovery."
          : energyLevel === "low"
          ? "Low energy — stay consistent, keep it light."
          : "Schedule or readiness signals a recovery-focused day."
        : energyState === "MEDIUM"
        ? "Solid baseline — stack a disciplined, structured day."
        : "Good readiness — execute the plan and build momentum.";

    return { readiness: level, reason };
  }

  // Pre check-in: fall back to energy state alone (rare path)
  const level: ReadinessLevel =
    energyState === "HIGH" ? "PUSH"    :
    energyState === "LOW"  ? "RECOVER" :
    "BUILD";

  const reason =
    level === "PUSH"    ? "High energy detected — lead with your hardest task." :
    level === "RECOVER" ? "Low energy signals a recovery-focused approach."      :
                          "Moderate readiness — execute steadily.";

  return { readiness: level, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Energy-Aware Planning — state-based plan adaptation
// ─────────────────────────────────────────────────────────────────────────────

type EnergyState = "HIGH" | "MEDIUM" | "LOW";

type EnergyAdaptation = {
  modifiedTasks: TimedTask[];
  message?:      string;
};

/**
 * Derive a three-tier energy state from check-in signals + recent behaviour.
 * Falls back to MEDIUM when no data exists so the default experience is neutral.
 */
function deriveEnergyState(p: {
  energyLevel:      RecoveryData["energyLevel"];
  soreness:         RecoveryData["soreness"];
  motivationLevel:  RecoveryData["motivationLevel"];
  recentMissCount:  number;   // misses in last 3 days (from history)
  adaptTrigger:     AdaptTrigger | null;
}): EnergyState {
  const { energyLevel, soreness, motivationLevel, recentMissCount, adaptTrigger } = p;

  // Explicit LOW signals win immediately
  if (
    energyLevel === "low" ||
    soreness === "sore" ||
    adaptTrigger === "low_energy" ||
    (motivationLevel === "low" && energyLevel !== "high")
  ) return "LOW";

  // Recent behaviour drags toward LOW even without check-in data
  if (recentMissCount >= 2 && energyLevel !== "high") return "LOW";

  // HIGH: explicitly stated + adequate motivation
  // (soreness === "sore" already returned LOW above, so no need to recheck)
  if (energyLevel === "high" && motivationLevel !== "low") return "HIGH";

  return "MEDIUM";
}

/**
 * Apply energy-state rules to the current task list.
 * Delegates actual mutations to the existing adaptTodayPlan engine where possible
 * (avoids duplicating sorting / priority logic).
 */
function adaptPlanToEnergy(
  tasks:       TimedTask[],
  energyState: EnergyState
): EnergyAdaptation {
  if (energyState === "HIGH") {
    // Front-load the hardest task (highest-priority, highest effort kind)
    const kindWeight: Partial<Record<TaskKind, number>> = {
      Workout: 0, Mobility: 1, Habit: 2,
      Nutrition: 3, Hydration: 4, Recovery: 5, Sleep: 6,
    };
    const reordered = [...tasks].sort((a, b) => {
      const pa = (a.priority ?? "medium") === "high" ? 0 : (a.priority ?? "medium") === "medium" ? 1 : 2;
      const pb = (b.priority ?? "medium") === "high" ? 0 : (b.priority ?? "medium") === "medium" ? 1 : 2;
      if (pa !== pb) return pa - pb;
      return (kindWeight[a.kind] ?? 9) - (kindWeight[b.kind] ?? 9);
    });
    return {
      modifiedTasks: reordered,
      message: "High energy — hardest tasks front-loaded. Go get it.",
    };
  }

  if (energyState === "LOW") {
    // Reuse the existing low_energy adaptation (de-intensify + strip non-essentials)
    const result = adaptTodayPlan(tasks, "low_energy");
    return { modifiedTasks: result.tasks, message: result.message };
  }

  // MEDIUM — standard order, no changes
  return { modifiedTasks: tasks };
}

// ─────────────────────────────────────────────────────────────────────────────
// Save The Day — streak protection + active intervention
// ─────────────────────────────────────────────────────────────────────────────

type SaveTheDay = {
  trigger: boolean;
  action:  string;
  reason:  string;
  taskId?: string;  // the one task to surface
};

function getSaveTheDayAction(p: {
  tasks:         TimedTask[];
  nowMin:        number;
  liveStreak:    number;
  todayDoneCount: number;
  planLocked:    boolean;
  dismissed:     boolean;
}): SaveTheDay {
  const { tasks, nowMin, liveStreak, todayDoneCount, planLocked, dismissed } = p;
  const NO_TRIGGER: SaveTheDay = { trigger: false, action: "", reason: "" };
  if (planLocked || dismissed || !tasks.length) return NO_TRIGGER;

  const nowHour = nowMin / 60;
  const undone  = tasks.filter((t) => !t.done);
  const doneCount = tasks.length - undone.length;
  const completionPct = tasks.length > 0 ? doneCount / tasks.length : 0;

  // Determine which condition fires (evaluated in priority order)
  const middayInactive  = nowHour >= 13 && todayDoneCount === 0;
  const lateDayRisk     = nowHour >= 18 && completionPct < 0.4 && tasks.length > 0;
  const streakAtRisk    = liveStreak > 0 && todayDoneCount === 0;

  if (!middayInactive && !lateDayRisk && !streakAtRisk) return NO_TRIGGER;

  // Pick the single best task to rescue the day
  // Priority: smallest high-priority task → any high-priority → first undone
  const highUndone = undone.filter((t) => (t.priority ?? "medium") === "high");

  // "Smallest" = quickest kind (Hydration/Mobility before Workout)
  const kindWeight: Partial<Record<TaskKind, number>> = {
    Hydration: 1, Mobility: 2, Habit: 3, Recovery: 4,
    Nutrition: 5, Sleep: 6, Workout: 7,
  };
  const sortedHigh = [...highUndone].sort(
    (a, b) => (kindWeight[a.kind] ?? 8) - (kindWeight[b.kind] ?? 8)
  );
  const pick = sortedHigh[0] ?? undone[0];
  if (!pick) return NO_TRIGGER;

  // Generate a concrete, short action directive
  const actionMap: Partial<Record<TaskKind, string>> = {
    Workout:   "20-minute workout — no excuses, just start.",
    Nutrition: "One solid meal — prep it right now.",
    Hydration: "Drink a full bottle of water — takes 60 seconds.",
    Mobility:  "10 minutes of mobility — floor stretches count.",
    Habit:     `Complete "${pick.title}" — it takes less time than you think.`,
    Sleep:     "Start your wind-down — everything else can wait.",
    Recovery:  "One recovery task — protect your body for tomorrow.",
  };
  const action = actionMap[pick.kind] ?? `Complete "${pick.title}" right now.`;

  // Reason driven by which condition fired
  const reason = streakAtRisk && liveStreak > 1
    ? `Your ${liveStreak}-day streak is on the line — one task saves it.`
    : middayInactive
    ? "It's after 1 PM and nothing's done. One task changes everything."
    : "Less than 40% done and the evening is here. Secure this win.";

  return { trigger: true, action, reason, taskId: pick.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Momentum — multi-day progress signal
// ─────────────────────────────────────────────────────────────────────────────

type WeeklyMomentumStatus = "STRONG" | "BUILDING" | "SLIPPING";

type WeeklyMomentum = {
  status:  WeeklyMomentumStatus;
  summary: string;
  focus:   string;
};

function getWeeklyMomentum(p: {
  history:          DayLog[];       // last 30 days — filtered to last 7 here
  consistencyScore: number;         // 0-100, 7-day rolling average
  currentStreak:    number;
}): WeeklyMomentum | null {
  const { history, consistencyScore, currentStreak } = p;

  const todayStr = new Date().toISOString().slice(0, 10);
  // Build a view of the last 7 days, newest last
  const last7: DayLog[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const entry = history.find((h) => h.date === dateStr);
    if (entry) last7.push(entry);
  }

  // Need at least 2 data points to say anything meaningful
  if (last7.length < 2) return null;

  // Tally eval results from stored evalStatus; fall back to score when absent
  const wins    = last7.filter((d) => d.evalStatus === "WIN"     || (!d.evalStatus && d.score >= 80)).length;
  const partials = last7.filter((d) => d.evalStatus === "PARTIAL" || (!d.evalStatus && d.score >= 40 && d.score < 80)).length;
  const misses  = last7.filter((d) => d.evalStatus === "MISS"    || (!d.evalStatus && d.score > 0 && d.score < 40)).length;
  const active  = last7.filter((d) => d.score > 0).length;

  // Recency bias: look at just the last 3 days for trend direction
  const recent3 = last7.slice(-3);
  const recentWins   = recent3.filter((d) => d.evalStatus === "WIN"  || (!d.evalStatus && d.score >= 80)).length;
  const recentMisses = recent3.filter((d) => d.evalStatus === "MISS" || (!d.evalStatus && d.score > 0 && d.score < 40)).length;

  // ── STRONG: multiple wins, rising trend, solid streak, high consistency ───
  const isStrong = (
    wins >= 3 &&
    recentWins >= 2 &&
    consistencyScore >= 65 &&
    currentStreak >= 3
  );

  // ── SLIPPING: repeated misses or low consistency with no upward trend ─────
  const isSlipping = (
    misses >= 2 &&
    recentMisses >= 1 &&
    consistencyScore < 50
  ) || (
    active >= 3 &&
    wins === 0 &&
    consistencyScore < 40
  );

  // Descriptive components
  const streakNote = currentStreak >= 5
    ? `${currentStreak}-day streak on the line.`
    : currentStreak >= 2
    ? `${currentStreak} days in a row.`
    : "";

  if (isStrong) {
    return {
      status:  "STRONG",
      summary: wins >= 5
        ? `${wins} wins this week — this is what consistency looks like.`
        : `${wins} strong day${wins !== 1 ? "s" : ""} this week${streakNote ? " · " + streakNote : ""} Keep building.`,
      focus: "Protect your standard — one disciplined day at a time.",
    };
  }

  if (isSlipping) {
    const slipNote = misses >= 3
      ? `${misses} missed day${misses !== 1 ? "s" : ""} this week.`
      : "Momentum is dropping.";
    return {
      status:  "SLIPPING",
      summary: `${slipNote} Consistency score: ${consistencyScore}%.`,
      focus:   "Simplify — secure one clear win and rebuild from there.",
    };
  }

  // ── BUILDING: the default middle state ────────────────────────────────────
  const buildNote = wins > 0
    ? `${wins} win${wins !== 1 ? "s" : ""} so far this week.`
    : partials > 0
    ? `${partials} partial day${partials !== 1 ? "s" : ""} — effort is there.`
    : "You're showing up.";
  return {
    status:  "BUILDING",
    summary: `${buildNote} ${consistencyScore > 0 ? `Consistency: ${consistencyScore}%.` : ""}`.trim(),
    focus:   recentMisses >= 1
      ? "Don't let two misses become three — win tomorrow."
      : "Momentum is building — protect it with a strong tomorrow.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tomorrow Prep — next-day continuity from today's evaluation
// ─────────────────────────────────────────────────────────────────────────────

type TomorrowPrep = {
  primaryFocus:      string;
  prepAction?:       string;
  carryOverReason?:  string;
};

// Lightweight prep actions per task kind
const PREP_ACTIONS: Partial<Record<TaskKind, string>> = {
  Workout:   "Lay out your gym clothes tonight.",
  Nutrition: "Prep a protein source or plan your first meal now.",
  Hydration: "Fill your water bottle and leave it visible.",
  Mobility:  "Set a 10-minute block in the morning for mobility.",
  Habit:     "Stack your habit onto an existing morning routine.",
  Sleep:     "Set a wind-down alarm 30 minutes before your target sleep time.",
  Recovery:  "Plan one recovery activity — even 10 minutes counts.",
};

function getTomorrowPrep(p: {
  dayEvaluation:     DayEvaluation | null;
  tasks:             TimedTask[];
  coachMode:         CoachMode;
  consistencyScore:  number;
}): TomorrowPrep | null {
  const { dayEvaluation, tasks, coachMode, consistencyScore } = p;
  if (!dayEvaluation) return null;

  const { status } = dayEvaluation;

  // Highest-priority missed task drives the primary focus
  const missedHigh = tasks
    .filter((t) => !t.done && (t.priority ?? "medium") === "high")
    .sort((a, b) => a.timeMin - b.timeMin);

  // ── WIN — reinforce momentum, don't reset ─────────────────────────────────
  if (status === "WIN") {
    const nextHighKind = missedHigh[0]?.kind ?? null;
    if (nextHighKind) {
      return {
        primaryFocus:     `Keep the momentum — lead with ${nextHighKind.toLowerCase()} again.`,
        prepAction:       PREP_ACTIONS[nextHighKind],
        carryOverReason:  "You built real momentum today — don't let it go cold.",
      };
    }
    return {
      primaryFocus:    coachMode === "PUSH"
        ? "Push the standard higher tomorrow."
        : "Repeat today's execution — consistency compounds.",
      carryOverReason: "A strong day is the best foundation for the next.",
    };
  }

  // ── PARTIAL — tighten the one thing that slipped ──────────────────────────
  if (status === "PARTIAL") {
    const missed = missedHigh[0];
    if (missed) {
      const focus = missed.kind === "Workout"
        ? "Schedule your workout in your first available free window."
        : missed.kind === "Nutrition"
        ? "Simplify nutrition — one clean meal, done early."
        : missed.kind === "Habit"
        ? "Do your habit task first, before anything else."
        : `Complete your ${missed.kind.toLowerCase()} task before midday.`;
      return {
        primaryFocus:    focus,
        prepAction:      PREP_ACTIONS[missed.kind],
        carryOverReason: `You completed most of today — ${missed.kind.toLowerCase()} was the gap.`,
      };
    }
    return {
      primaryFocus:    "Tighten execution — close the gap between planned and done.",
      carryOverReason: "Good effort today, but there's more on the table.",
    };
  }

  // ── MISS — simplify and rebuild ───────────────────────────────────────────
  const missed = missedHigh[0];
  const isLowConsistency = consistencyScore > 0 && consistencyScore < 50;

  if (missed) {
    const focus = missed.kind === "Workout"
      ? "One workout, done early — that's the whole win condition."
      : missed.kind === "Nutrition"
      ? "One solid meal. That's it. Start there."
      : `One ${missed.kind.toLowerCase()} task. Make it non-negotiable.`;
    const reason = isLowConsistency
      ? "Consistency is the gap — make tomorrow simpler, not bigger."
      : "Today didn't land. Rebuild with one clear win.";
    return {
      primaryFocus:    focus,
      prepAction:      PREP_ACTIONS[missed.kind],
      carryOverReason: reason,
    };
  }

  return {
    primaryFocus:    "Start tomorrow with one clear action — don't overthink it.",
    carryOverReason: "Reset tonight. One win tomorrow is enough.",
  };
}

function detectCommand(input: string): Command {
  const s = input.toLowerCase();
  if (/less time|short on time|only have \d+ min|not much time|tight on time|quick session/.test(s))
    return { type: "LESS_TIME" };
  if (/missed.*workout|miss.*workout|didn.?t.*train|skipped.*workout|skip.*gym|no workout/.test(s))
    return { type: "MISSED_WORKOUT" };
  if (/\btired\b|exhausted|low energy|no energy|drained|wiped out|feel rough|not feeling it/.test(s))
    return { type: "LOW_ENERGY" };
  if (/push.*(later|back|evening)|move.*(later|evening|night)|shift.*(later|back|plan)|everything later/.test(s))
    return { type: "SHIFT_LATER" };
  if (/lock.*(it|plan|this).*in|this works|looks good.*plan|keep this plan|stick with this/.test(s))
    return { type: "LOCK_PLAN" };
  return null;
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
  const tg  = profile?.derived?.targetGoal       ?? "";
  const bfd = profile?.derived?.bodyFatDirection ?? "";
  const exp = profile?.training?.experience      ?? "";
  const eq  = profile?.derived?.equipment        ?? "";
  const dur = profile?.training?.sessionDuration  ?? "";

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

// ─────────────────────────────────────────────────────────────────────────────
// Profile normalization
//
// Any profile loaded from AsyncStorage must pass through here before being
// used in plan generation. Two failure modes:
//
//   1. Old flat shape — profile stored before the nested AiraUserProfile type
//      was introduced. May have `name`/`firstName` at root, `profile.profile`
//      sub-object missing entirely.
//
//   2. Partial nested shape — profile stored mid-migration or with a required
//      sub-object undefined (e.g. `derived`, `meta`).
//
// Strategy: detect shape, fill every sub-object with safe fallbacks, require
// sleep.wakeTime + sleep.sleepTime (needed to anchor the schedule). If those
// are absent the function returns null and callers skip plan generation.
// ─────────────────────────────────────────────────────────────────────────────

function normalizeProfileForPlanning(raw: unknown): AiraUserProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  // Helper: safely extract an object sub-block
  function sub(key: string): Record<string, unknown> {
    const v = r[key];
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  }

  // ── Identity ──────────────────────────────────────────────────────────────
  // New shape: r.profile.firstName
  // Old shape: r.firstName or r.name at root
  const profileBlock = sub("profile");
  const firstName =
    (profileBlock.firstName as string | undefined) ||
    (r.firstName as string | undefined) ||
    (r.name      as string | undefined) ||
    "";

  // ── Sleep — required to anchor the schedule ───────────────────────────────
  const sleepBlock = sub("sleep");
  const wakeTime  = (sleepBlock.wakeTime  as string | undefined) || "";
  const sleepTime = (sleepBlock.sleepTime as string | undefined) || "";

  if (!wakeTime || !sleepTime) {
    // Without wake/sleep times we cannot build a scheduled plan — skip silently.
    return null;
  }

  // ── Optional sub-blocks ───────────────────────────────────────────────────
  const goalsBlock     = sub("goals");
  const trainingBlock  = sub("training");
  const nutritionBlock = sub("nutrition");
  const recoveryBlock  = sub("recovery");
  const scheduleBlock  = sub("schedule");
  const derivedBlock   = sub("derived");
  const metaBlock      = sub("meta");
  const futureBlock    = sub("future");

  return {
    profile: {
      firstName,
      age:    profileBlock.age    as string | undefined,
      gender: profileBlock.gender as AiraUserProfile["profile"]["gender"],
      height: profileBlock.height as string | undefined,
      weight: profileBlock.weight as string | undefined,
    },
    goals: {
      primaryGoal: (goalsBlock.primaryGoal as AiraUserProfile["goals"]["primaryGoal"]) ?? "stay_consistent",
      goalLabel:   (goalsBlock.goalLabel   as string) ?? "Stay consistent",
      urgency:     goalsBlock.urgency  as AiraUserProfile["goals"]["urgency"],
      notes:       goalsBlock.notes    as string | undefined,
    },
    training: {
      gymAccess:       (trainingBlock.gymAccess       as AiraUserProfile["training"]["gymAccess"])       ?? "bodyweight_only",
      trainingStyle:   (trainingBlock.trainingStyle   as AiraUserProfile["training"]["trainingStyle"])   ?? "general_fitness",
      experience:      (trainingBlock.experience      as AiraUserProfile["training"]["experience"])      ?? "beginner",
      daysPerWeek:     (trainingBlock.daysPerWeek     as number)                                         ?? 3,
      sessionDuration: (trainingBlock.sessionDuration as AiraUserProfile["training"]["sessionDuration"]) ?? "30min",
      injuries:        trainingBlock.injuries as string | undefined,
    },
    nutrition: {
      dietaryStyle:  (nutritionBlock.dietaryStyle  as AiraUserProfile["nutrition"]["dietaryStyle"])  ?? "everything",
      nutritionGoal: (nutritionBlock.nutritionGoal as AiraUserProfile["nutrition"]["nutritionGoal"]) ?? "maintenance",
      mealPrepLevel: (nutritionBlock.mealPrepLevel as AiraUserProfile["nutrition"]["mealPrepLevel"]) ?? "minimal",
      // Added in onboarding v2 — default to [] for backward-compat with pre-allergy stored profiles
      allergies:     Array.isArray(nutritionBlock.allergies) ? (nutritionBlock.allergies as string[]) : [],
      allergyNotes:  nutritionBlock.allergyNotes as string | undefined,
    },
    recovery: {
      sleepQuality:   (recoveryBlock.sleepQuality   as AiraUserProfile["recovery"]["sleepQuality"])   ?? "fair",
      stressLevel:    (recoveryBlock.stressLevel    as AiraUserProfile["recovery"]["stressLevel"])    ?? "moderate",
      energyBaseline: (recoveryBlock.energyBaseline as AiraUserProfile["recovery"]["energyBaseline"]) ?? "moderate",
    },
    sleep: { wakeTime, sleepTime },
    schedule: {
      preferredWorkoutTime: scheduleBlock.preferredWorkoutTime as AiraUserProfile["schedule"]["preferredWorkoutTime"],
      scheduleConsistency:  scheduleBlock.scheduleConsistency  as AiraUserProfile["schedule"]["scheduleConsistency"],
    },
    derived: {
      equipment:        (derivedBlock.equipment        as AiraUserProfile["derived"]["equipment"])        ?? "none",
      bodyFatDirection: (derivedBlock.bodyFatDirection as AiraUserProfile["derived"]["bodyFatDirection"]) ?? "maintain",
      targetGoal:       (derivedBlock.targetGoal       as string)                                         ?? "general_fitness",
      workoutFrequency: (derivedBlock.workoutFrequency as AiraUserProfile["derived"]["workoutFrequency"]) ?? "3x",
      derivedAt:        (derivedBlock.derivedAt        as string)                                         ?? new Date().toISOString(),
    },
    meta: {
      onboardingVersion:     (metaBlock.onboardingVersion     as number)   ?? 1,
      completedAt:           (metaBlock.completedAt           as string)   ?? new Date().toISOString(),
      lastUpdatedAt:         (metaBlock.lastUpdatedAt         as string)   ?? new Date().toISOString(),
      dataConfidenceScore:   (metaBlock.dataConfidenceScore   as number)   ?? 0,
      optionalFieldsSkipped: (metaBlock.optionalFieldsSkipped as string[]) ?? [],
      // refinementHistory is optional — safe default is undefined (engine treats as "no history")
      ...(metaBlock.refinementHistory && typeof metaBlock.refinementHistory === "object"
        ? {
            refinementHistory: {
              lastPromptShownAt: (metaBlock.refinementHistory as Record<string, unknown>).lastPromptShownAt as string | undefined,
              promptsSeen:       Array.isArray((metaBlock.refinementHistory as Record<string, unknown>).promptsSeen)
                ? ((metaBlock.refinementHistory as Record<string, unknown>).promptsSeen as string[])
                : undefined,
            },
          }
        : {}),
    },
    // future is entirely optional — only included when at least one sub-block exists
    ...(Object.keys(futureBlock).length > 0
      ? {
          future: {
            bodyScan: (() => {
              const bs = futureBlock.bodyScan && typeof futureBlock.bodyScan === "object"
                ? (futureBlock.bodyScan as Record<string, unknown>)
                : null;
              if (!bs) return undefined;
              return {
                bodyFat:    bs.bodyFat    != null ? (bs.bodyFat    as number) : undefined,
                muscleMass: bs.muscleMass != null ? (bs.muscleMass as number) : undefined,
                takenAt:    bs.takenAt    as string | undefined,
              };
            })(),
            wearables: (() => {
              const w = futureBlock.wearables && typeof futureBlock.wearables === "object"
                ? (futureBlock.wearables as Record<string, unknown>)
                : null;
              if (!w) return undefined;
              return {
                hasDevice:         Boolean(w.hasDevice),
                deviceLabel:       w.deviceLabel       as string | undefined,
                restingHeartRate:  w.restingHeartRate  != null ? (w.restingHeartRate  as number) : undefined,
                hrv:               w.hrv               != null ? (w.hrv               as number) : undefined,
              };
            })(),
            schedule: (() => {
              const s = futureBlock.schedule && typeof futureBlock.schedule === "object"
                ? (futureBlock.schedule as Record<string, unknown>)
                : null;
              if (!s) return undefined;
              return {
                calendarConnected: Boolean(s.calendarConnected),
                busyBlockCount:    s.busyBlockCount != null ? (s.busyBlockCount as number) : undefined,
              };
            })(),
            recovery: (() => {
              const fr = futureBlock.recovery && typeof futureBlock.recovery === "object"
                ? (futureBlock.recovery as Record<string, unknown>)
                : null;
              if (!fr) return undefined;
              return {
                restingHeartRate: fr.restingHeartRate != null ? (fr.restingHeartRate as number) : undefined,
                hrv:              fr.hrv              != null ? (fr.hrv              as number) : undefined,
              };
            })(),
          },
        }
      : {}),
  };
}

/**
 * Convert a GeneratedDailyPlan into the AIPlan shape the Today screen already uses.
 * Defensive: gp comes from JSON.parse(AsyncStorage) — old stored plans may be missing
 * fields added in later phases (e.g. meta.focus added in Phase 4 P3).
 */
function synthesizeAIPlan(gp: GeneratedDailyPlan): AIPlan {
  return {
    id:               `local_${gp.meta?.generatedAt ?? Date.now()}`,
    date:             new Date().toISOString().slice(0, 10),
    summary:          `${gp.workout?.focus ?? ""}. ${gp.nutrition?.keyPrinciple ?? ""}`.trim().replace(/^\. /, ""),
    coachingNote:     gp.recovery?.notes ?? gp.meta?.reasoning?.[0] ?? "Execute the plan. Consistency compounds.",
    disciplineTarget: gp.meta?.focus ?? `${gp.workout?.split?.replace(/_/g, " ") ?? "Today's session"}`,
    fallbackPlan:     `Minimum viable day: hit your workout, reach your protein target, and sleep ${gp.recovery?.sleepTargetHrs ?? 8} hours.`,
    generatedAt:      gp.meta?.generatedAt ?? new Date().toISOString(),
  };
}

// Identity label — reflects who the user is becoming based on streak length
function getIdentityLabel(streak: number): { label: string; color: string } {
  if (streak >= 10) return { label: "Locked In",           color: "#66bb6a" };
  if (streak >= 5)  return { label: "Consistent",          color: ACCENT };
  if (streak >= 2)  return { label: "Building Discipline", color: ACCENT + "cc" };
  return               { label: "Getting Started",      color: "#505065" };
}

// ─── Dev Mock Planner Data ───────────────────────────────────────────────────
// Renders the Today screen with sample data when no real plan is available.
// Only activates in __DEV__ builds when aiPlan is null and tasks is empty.
//
// IMPORTANT: Set DEV_MOCK_ENABLED = false to test the local Aira Intelligence
// System (generateLocalAiraPlan). With mocks enabled, the real generation path
// is bypassed whenever the plan is absent on app start. Restore to true for
// UI-only development when a real plan is not needed.
const DEV_MOCK_ENABLED = false;

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

/** Parse AI rest strings ("90s", "2 min", "1:30") → seconds. Defaults to 60. */
function parseRestSeconds(rest?: string): number {
  if (!rest) return 60;
  const s = rest.toLowerCase().trim();
  const sec = s.match(/^(\d+)\s*s(?:ec)?s?$/);
  if (sec) return parseInt(sec[1], 10);
  const min = s.match(/^(\d+)\s*m(?:in)?s?$/);
  if (min) return parseInt(min[1], 10) * 60;
  const minSec = s.match(/^(\d+)[m:](\d+)/) ;
  if (minSec) return parseInt(minSec[1], 10) * 60 + parseInt(minSec[2], 10);
  const bare = parseInt(s, 10);
  return isNaN(bare) ? 60 : bare;
}

/** Build an ExerciseSet array from a reps string ("6-8", "10", "AMRAP") and set count. */
function buildExerciseSets(setsCount: number, repsStr: string): ExerciseSet[] {
  const parts  = repsStr.replace(/\s*reps?\s*/i, "").split("-").map((r) => parseInt(r.trim(), 10));
  const minRep = isNaN(parts[0]) ? 10 : parts[0];
  const maxRep = isNaN(parts[1]) ? minRep : parts[1];
  return Array.from({ length: setsCount }, (_, i) => {
    // Progress linearly through the rep range across sets (min → max)
    const frac = setsCount > 1 ? i / (setsCount - 1) : 0;
    const reps = Math.round(minRep + frac * (maxRep - minRep));
    return { set_number: i + 1, reps, target_weight: null };
  });
}

/**
 * Resolve a TimedTask to a WorkoutSession.
 * If the task carries AI-generated exercises, converts them into a full session.
 * Falls back to the dev mock when no exercises are present (dev / legacy tasks).
 */
function getWorkoutForTask(task: TimedTask): WorkoutSession {
  const exs = task.exercises;
  if (!exs || exs.length === 0) return DEV_MOCK_WORKOUT;

  return {
    workout_id:       task.id,
    title:            task.title,
    duration_minutes: 45,
    focus:            task.title,
    exercises: exs.map((ex, i): WorkoutExercise => ({
      id:           `${task.id}_ex${i}`,
      name:         ex.name,
      sets:         buildExerciseSets(ex.sets, ex.reps),
      rest_seconds: parseRestSeconds(ex.rest),
      cue:          ex.notes ?? "",
    })),
  };
}

// ─── Dev Mock Nutrition Data ─────────────────────────────────────────────────
// Full nutrition day used when no planner-linked nutrition plan exists.
// Replace getNutritionForTask() below to swap in real data — no other changes needed.
const DEV_MOCK_NUTRITION: NutritionPlan = {
  plan_id:   "mock-nutrition-day",
  title:     "Nutrition Day",
  focus:     "High protein, moderate carbs. Build the plate around the protein source every meal.",
  calories:  2200,
  protein_g: 175,
  meals: [
    {
      id:      "meal_1",
      label:   "Breakfast",
      time:    "7:30 AM",
      focus:   "Anchor the day with protein — prevents cravings later",
      example: "3 eggs + 150g Greek yogurt + oats + berries",
    },
    {
      id:      "meal_2",
      label:   "Lunch",
      time:    "12:30 PM",
      focus:   "Lean protein + complex carbs to fuel the afternoon",
      example: "200g chicken breast + rice + greens + olive oil",
    },
    {
      id:      "meal_3",
      label:   "Dinner",
      time:    "7:00 PM",
      focus:   "Protein-forward, lighter on carbs for the evening",
      example: "Salmon fillet + sweet potato + steamed broccoli",
    },
    {
      id:      "meal_4",
      label:   "Snack",
      time:    "4:00 PM",
      focus:   "Bridge the gap — protein over sugar",
      example: "Cottage cheese + handful of almonds, or protein shake",
    },
  ],
  groceryList: [
    "Chicken breast (500g)",
    "Salmon fillet (200g)",
    "Eggs (6-pack)",
    "Greek yogurt (500g tub)",
    "Oats",
    "Sweet potatoes",
    "Brown rice or quinoa",
    "Broccoli / mixed greens",
    "Almonds or mixed nuts",
    "Olive oil",
  ],
};

/**
 * Resolve a TimedTask to a NutritionPlan.
 * V1: always returns the mock plan. When the backend supplies planner-linked
 * nutrition data, fetch/look up by task.id or task.planId here.
 */
function getNutritionForTask(_task: TimedTask): NutritionPlan {
  return DEV_MOCK_NUTRITION;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Dev Mock Recovery Data ──────────────────────────────────────────────────
// Four recovery archetypes — getRecoveryForTask() picks the right one by
// matching the task title keywords. Replace with planner-linked data later.
const DEV_MOCK_RECOVERY_STRETCH: RecoveryPlan = {
  plan_id:      "mock-recovery-stretch",
  type:         "Stretch",
  title:        "Mobility & Stretch",
  focus:        "Release tension in the key muscle groups worked today. Ten minutes of deliberate stretching compounds into real range of motion over time.",
  duration_min: 15,
  steps: [
    { id: "rs1", label: "Hip Flexor Stretch",       duration: "60 sec / side", cue: "Lunge position — back knee down, drive hips forward. Breathe into the stretch." },
    { id: "rs2", label: "Seated Hamstring Stretch",  duration: "60 sec / side", cue: "Hinge from the hip, not the lower back. Soft knee, not locked." },
    { id: "rs3", label: "Thoracic Rotation",         duration: "10 reps / side", cue: "Slow and controlled. Stack your hands, rotate from the mid-back." },
    { id: "rs4", label: "Chest Doorframe Stretch",   duration: "30 sec",        cue: "Arms at 90°, lean gently through the doorway. No bouncing." },
    { id: "rs5", label: "Child's Pose Hold",         duration: "60 sec",        cue: "Arms extended, sink your hips back. Let gravity do the work." },
  ],
  coachingCue: "You don't need to be flexible to start — you need to start to become flexible. Ten minutes now prevents injuries that cost you weeks.",
};

const DEV_MOCK_RECOVERY_SLEEP: RecoveryPlan = {
  plan_id:      "mock-recovery-sleep",
  type:         "Sleep",
  title:        "Sleep Protocol",
  focus:        "Sleep is when your body rebuilds and your brain consolidates everything learned today. Protect it like the training session it is.",
  duration_min: null,
  steps: [
    { id: "sl1", label: "Screens off",         duration: "30 min before bed", cue: "Phone on charger — out of reach. Blue light suppresses melatonin for up to 90 minutes." },
    { id: "sl2", label: "Dim the lights",       duration: "30 min before bed", cue: "Bright overhead lights signal daytime. Switch to lamps or no lights at all." },
    { id: "sl3", label: "Cool the room",        duration: "Now",               cue: "Target 18–20°C (65–68°F). Core temperature must drop for sleep onset." },
    { id: "sl4", label: "Set a single alarm",   duration: "Now",               cue: "One alarm only. Multiple snooze alarms fragment your last sleep cycle — the most restorative one." },
    { id: "sl5", label: "Lights out",           duration: "Target time",       cue: "Same time every night. Consistency is the most powerful sleep intervention that exists." },
  ],
  coachingCue: "Every hour of sleep before midnight is worth two after it. This is not optional recovery — it is mandatory maintenance.",
};

const DEV_MOCK_RECOVERY_COLD: RecoveryPlan = {
  plan_id:      "mock-recovery-cold",
  type:         "Cold",
  title:        "Cold Exposure",
  focus:        "Cold exposure reduces inflammation, spikes norepinephrine, and resets your nervous system. Three minutes is enough to earn the full effect.",
  duration_min: 5,
  steps: [
    { id: "co1", label: "Preparation",     duration: "1 min",  cue: "Set water to 10–15°C if adjustable. Take three slow diaphragmatic breaths before entering." },
    { id: "co2", label: "Cold exposure",   duration: "2–3 min", cue: "Stay calm. Nasal breathing only — do not hyperventilate. The discomfort is the point." },
    { id: "co3", label: "Exit and warm up", duration: "1 min",  cue: "Air dry or towel off. Let your body generate its own heat — don't jump straight to a hot shower." },
  ],
  coachingCue: "The moment you want to quit is exactly when the adaptation is happening. Stay in. Breathe.",
};

const DEV_MOCK_RECOVERY_REST: RecoveryPlan = {
  plan_id:      "mock-recovery-rest",
  type:         "Rest",
  title:        "Active Recovery",
  focus:        "Low-intensity movement accelerates recovery more than complete rest. Keep the body moving without adding stress.",
  duration_min: 20,
  steps: [
    { id: "re1", label: "Diaphragmatic breathing", duration: "5 min",  cue: "4 counts in through the nose, 6 counts out through the mouth. Activates the parasympathetic system." },
    { id: "re2", label: "Foam roll — major groups", duration: "10 min", cue: "30–60 seconds per area. Pause on tight spots — don't roll through pain." },
    { id: "re3", label: "Light static stretching",  duration: "5 min",  cue: "Target whatever is tightest today. No forcing — just hold and breathe." },
  ],
  coachingCue: "Rest days are not wasted days. Adaptation happens during recovery, not during training. Protect this time.",
};

/**
 * Resolve a TimedTask to a RecoveryPlan by matching title keywords.
 * V1: returns one of four mock archetypes. Replace with planner-linked data later.
 */
function getRecoveryForTask(task: TimedTask): RecoveryPlan {
  const t = task.title.toLowerCase();
  if (t.includes("sleep") || t.includes("wind") || t.includes("bed"))  return DEV_MOCK_RECOVERY_SLEEP;
  if (t.includes("cold") || t.includes("plunge") || t.includes("ice")) return DEV_MOCK_RECOVERY_COLD;
  if (t.includes("stretch") || t.includes("mobil") || t.includes("flex")) return DEV_MOCK_RECOVERY_STRETCH;
  return DEV_MOCK_RECOVERY_REST;
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

// ─── Adaptive Day Engine ──────────────────────────────────────────────────────
//
// Rule-based, instant plan adaptation — no backend call.
// Operates on the current task list and returns an adapted copy + coaching message.
// The AI plan is the source of truth; adaptation is a local overlay.

type AdaptResult = {
  tasks:   TimedTask[];
  message: string;
  trigger: AdaptTrigger;
};

function adaptTodayPlan(tasks: TimedTask[], trigger: AdaptTrigger): AdaptResult {
  switch (trigger) {
    case "less_time": {
      // Keep only done tasks + high-priority undone tasks (MUST DO)
      // Medium/low tasks are "FLEX" — paused until time opens up
      const compressed = tasks.filter((t) => t.done || (t.priority ?? "medium") === "high");
      return {
        tasks:   compressed,
        message: "Plan compressed — high-priority tasks kept, flexible ones paused.",
        trigger,
      };
    }
    case "missed_workout": {
      // Promote undone Workout tasks to high priority + move to front of undone list
      // Prefix title to nudge a shorter session
      const workouts = tasks.filter((t) => t.kind === "Workout" && !t.done);
      const rest     = tasks.filter((t) => !(t.kind === "Workout" && !t.done));
      const promoted = workouts.map((t) => ({
        ...t,
        priority: "high" as TaskPriority,
        title: t.title.startsWith("[30 min]") ? t.title : `[30 min] ${t.title}`,
      }));
      return {
        tasks:   [...promoted, ...rest],
        message: "Workout moved up — a 20–30 min session still counts today.",
        trigger,
      };
    }
    case "low_completion": {
      // No task list changes — coaching message is the output
      return {
        tasks:   tasks,
        message: "Let's reset. Start with one small win.",
        trigger,
      };
    }
    case "low_energy": {
      // De-intensify workout + strip low-priority tasks
      const adjusted = tasks
        .map((t) =>
          t.kind === "Workout" && (t.priority ?? "medium") === "high"
            ? { ...t, priority: "medium" as TaskPriority, title: t.title.startsWith("[Light] ") ? t.title : `[Light] ${t.title}` }
            : t
        )
        .filter((t) => t.done || (t.priority ?? "medium") !== "low");
      return {
        tasks:   adjusted,
        message: "Low energy mode — workout de-intensified, optional tasks removed.",
        trigger,
      };
    }
    case "shift_later": {
      // Push all undone tasks 2 hours forward
      const SHIFT = 2 * 60;
      const shifted = tasks
        .map((t) => {
          if (t.done) return t;
          const newMin = t.timeMin + SHIFT;
          return { ...t, timeMin: newMin, timeText: minutesToTimeText(newMin) };
        })
        .sort((a, b) => a.timeMin - b.timeMin);
      return {
        tasks:   shifted,
        message: "All tasks shifted 2 hours later.",
        trigger,
      };
    }
  }
}

/**
 * Lightweight in-day rebalancer — runs continuously as the day progresses.
 *
 * Returns a trimmed task list when the user is behind schedule, or null when
 * no change is needed (ON_TRACK / AHEAD). Returning null avoids unnecessary
 * state updates and lets the existing adaptation chain remain untouched.
 *
 * State thresholds:
 *   BEHIND — low completion relative to time of day → compress (strip low-priority undone)
 *   AHEAD  — ≥70% done before 3 PM, tasks remain    → safe default: no change
 *   ON_TRACK                                         → no change
 *
 * Invariants:
 *   - Never removes done tasks
 *   - Never removes Workout tasks (use explicit adaptation for that)
 *   - Never modifies task data — only filters the list
 */
function rebalanceCurrentDay(
  tasks:     TimedTask[],
  doneCount: number,
  nowMin:    number,  // minutes since midnight
): TimedTask[] | null {
  if (!tasks.length) return null;

  const total      = tasks.length;
  const pct        = doneCount / total;
  const undoneCount = total - doneCount;

  const isNoon      = nowMin >= 12 * 60;  // 12:00 PM
  const isAfternoon = nowMin >= 15 * 60;  // 3:00 PM
  const isEvening   = nowMin >= 18 * 60;  // 6:00 PM

  // BEHIND — urgency increases as the day advances
  const behind =
    (isEvening   && pct < 0.50) ||
    (isAfternoon && pct < 0.25) ||
    (isNoon      && pct === 0   && undoneCount > 4);

  if (behind) {
    // Compress: keep done tasks + high/medium undone + Workout (protected)
    const compressed = tasks.filter(
      (t) => t.done || t.kind === "Workout" || (t.priority ?? "medium") !== "low"
    );
    // Only return a result if we actually removed something
    return compressed.length < tasks.length ? compressed : null;
  }

  // AHEAD: ≥70% done before 3 PM — stable (no-op for V1)
  // (future: pull in a later task here)

  return null; // ON_TRACK — no change needed
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

// Ionicons name map — used in TaskRow icon circle
const KIND_ICONS: Partial<Record<string, string>> = {
  Workout:   "flash-outline",
  Nutrition: "leaf-outline",
  Hydration: "water-outline",
  Mobility:  "sync-outline",
  Recovery:  "heart-outline",
  Habit:     "star-outline",
  Sleep:     "moon-outline",
};

// ─────────────────────────────────────────────────────────────────────────────
// SkeletonCard — pulsing placeholder for async content
// ─────────────────────────────────────────────────────────────────────────────

function SkeletonCard({ height = 72, radius = 16 }: { height?: number; radius?: number }) {
  const pulse = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.04, 0.09] });

  return (
    <Animated.View
      style={{
        height,
        borderRadius: radius,
        backgroundColor: "#fff",
        opacity,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.06)",
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SkeletonTaskRow — matches TaskRow height/layout for seamless swap
// ─────────────────────────────────────────────────────────────────────────────

function SkeletonTaskRow() {
  const pulse = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const bgOpacity  = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.03, 0.07] });
  const barOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.05, 0.12] });

  return (
    <Animated.View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.05)",
        backgroundColor: "rgba(255,255,255,0.04)",
        marginBottom: 8,
      }}
    >
      {/* Icon circle skeleton */}
      <Animated.View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: "#fff", opacity: bgOpacity }} />
      {/* Text lines skeleton */}
      <View style={{ flex: 1, gap: 7 }}>
        <Animated.View style={{ height: 13, width: "70%", borderRadius: 6, backgroundColor: "#fff", opacity: barOpacity }} />
        <Animated.View style={{ height: 10, width: "45%", borderRadius: 6, backgroundColor: "#fff", opacity: bgOpacity }} />
      </View>
      {/* Toggle skeleton */}
      <Animated.View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: "#fff", opacity: bgOpacity }} />
    </Animated.View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Circular Progress Ring — SVG-based, gradient stroke, glow shadow
// ─────────────────────────────────────────────────────────────────────────────

function CircularProgressRing({
  score,
  size = 180,
  strokeWidth = 10,
}: {
  score:        number;
  size?:        number;
  strokeWidth?: number;
}) {
  const radius        = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const targetOffset  = circumference * (1 - Math.min(Math.max(score / 100, 0), 1));
  const cx            = size / 2;
  const cy            = size / 2;

  // Animated dash offset — starts at full circumference (empty), fills to score
  const animDashOffset = React.useRef(new Animated.Value(circumference)).current;
  // Glow pulse — oscillates subtly on the purple bloom shadow
  const glowPulse      = React.useRef(new Animated.Value(0.20)).current;

  // Ring fill animation — fires on mount and whenever score changes
  React.useEffect(() => {
    Animated.timing(animDashOffset, {
      toValue:         targetOffset,
      duration:        1200,
      easing:          Easing.out(Easing.cubic),
      useNativeDriver: false, // SVG props are not on the native thread
    }).start();
  }, [score]); // eslint-disable-line react-hooks/exhaustive-deps

  // Continuous glow pulse — 3.2 s half-cycle, asymmetric ease for natural breath feel
  React.useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(glowPulse, { toValue: 0.44, duration: 3600, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        Animated.timing(glowPulse, { toValue: 0.16, duration: 3600, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      ])
    ).start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>

      {/* ── Radial atmospheric glow — faint halo behind the ring ────────────── */}
      {/* Blue glow — top-left */}
      <View style={{
        position: "absolute", width: 130, height: 130, borderRadius: 65,
        backgroundColor: "#000",
        shadowColor: "#00D1FF", shadowOpacity: 0.20, shadowRadius: 36,
        shadowOffset: { width: -18, height: -18 },
      }} />
      {/* Pink glow — bottom-right */}
      <View style={{
        position: "absolute", width: 130, height: 130, borderRadius: 65,
        backgroundColor: "#000",
        shadowColor: "#FF3D9A", shadowOpacity: 0.16, shadowRadius: 36,
        shadowOffset: { width: 18, height: 18 },
      }} />
      {/* Purple bloom — animated glow pulse */}
      <Animated.View style={{
        position: "absolute", width: size, height: size, borderRadius: size / 2,
        backgroundColor: "#000",
        shadowColor: "#7B61FF", shadowOpacity: glowPulse, shadowRadius: 38,
        shadowOffset: { width: 0, height: 0 },
      }} />

      {/* ── SVG ring ─────────────────────────────────────────────────────────── */}
      <Svg width={size} height={size} style={{ position: "absolute" }}>
        <Defs>
          <SvgLinearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0"   stopColor="#00D1FF" stopOpacity="1" />
            <Stop offset="0.5" stopColor="#7B61FF" stopOpacity="1" />
            <Stop offset="1"   stopColor="#FF3D9A" stopOpacity="1" />
          </SvgLinearGradient>
        </Defs>
        {/* Track */}
        <Circle
          cx={cx} cy={cy} r={radius}
          stroke="#14142a"
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Animated progress arc */}
        <AnimatedCircle
          cx={cx} cy={cy} r={radius}
          stroke="url(#ringGrad)"
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={animDashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      </Svg>

      {/* ── Center content ───────────────────────────────────────────────────── */}
      <View style={{ alignItems: "center" }}>
        <Text style={{
          color:         "#2a2a45",
          fontSize:      8,
          fontWeight:    "900",
          letterSpacing: 2,
          marginBottom:  4,
        }}>
          SCORE
        </Text>
        <Text style={{
          color:            "#ffffff",
          fontSize:         48,
          fontWeight:       "800",
          letterSpacing:    -1.5,
          lineHeight:       50,
          textShadowColor:  "#7B61FF38",
          textShadowRadius: 10,
          textShadowOffset: { width: 0, height: 0 },
        }}>
          {score}
        </Text>
        <Text style={{
          color:         "#2c2c44",
          fontSize:      8,
          fontWeight:    "700",
          letterSpacing: 1.8,
          marginTop:     4,
        }}>
          DISCIPLINE
        </Text>
      </View>
    </View>
  );
}

// ---------- Nutrition guidance ----------
type NutritionGuide = { protein: string; hydration: string; priority: string };

const TARGET_GOAL_LABELS: Record<string, string> = {
  lean_defined:    "Lean & Defined",
  model_build:     "Model Build",
  athletic_strong: "Athletic & Strong",
  shredded:        "Shredded",
};

// ── Performance profile mapping constants ────────────────────────────────────
const GOAL_TYPE_LABELS: Record<string, string> = {
  lose_fat:            "Lose fat and get lean",
  build_muscle:        "Build muscle and size",
  get_stronger:        "Get stronger and more powerful",
  improve_athleticism: "Improve athleticism and performance",
  stay_consistent:     "Build discipline and stay consistent",
};

// Maps primaryTrainingStyle → legacy targetGoal (for buildTodaysPlan workout naming)
const TRAINING_STYLE_TO_TARGET: Record<string, string> = {
  athlete:         "athletic_strong",
  muscle:          "model_build",
  strength:        "athletic_strong",
  fat_loss:        "shredded",
  general_fitness: "lean_defined",
  calisthenics:    "lean_defined",
};

// Maps goalType → legacy bodyFatDirection
const GOAL_TYPE_TO_BFD: Record<string, Profile["derived"]["bodyFatDirection"]> = {
  lose_fat:            "lose_fat",
  build_muscle:        "build_lean",
  get_stronger:        "maintain",
  improve_athleticism: "maintain",
  stay_consistent:     "maintain",
};

// Maps gymAccess → legacy equipment
const GYM_ACCESS_TO_EQUIPMENT: Record<string, Profile["derived"]["equipment"]> = {
  full_gym:          "full_gym",
  limited_equipment: "minimal",
  bodyweight_only:   "none",
};

// Maps trainingDaysPerWeek → legacy workoutFrequency
function daysToFrequency(d: number): Profile["derived"]["workoutFrequency"] {
  if (d <= 2) return "2x";
  if (d === 3) return "3x";
  if (d === 4) return "4x";
  return "5x";
}

// Maps experienceLevel → session duration default
const EXP_TO_DURATION: Record<string, Profile["training"]["sessionDuration"]> = {
  beginner:     "30min",
  intermediate: "45min",
  advanced:     "60min",
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
  screen: { flex: 1, backgroundColor: "transparent", padding: 16, gap: 12 },

  h1: { color: "#fff", fontSize: 34, fontWeight: "700", letterSpacing: -0.5 },
  h2: { color: "#fff", fontSize: 26, fontWeight: "700", letterSpacing: -0.3 },
  sub: { color: "#bdbdbd", fontSize: 14, marginBottom: 6 },
  sub2: { color: "#bdbdbd", fontSize: 13, marginBottom: 6 },

  card: { backgroundColor: "#0A0A0F", borderRadius: 16, padding: 14, borderWidth: 1, borderColor: "#1a1a2c", gap: 8, shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 18, shadowOffset: { width: 0, height: 5 }, elevation: 7 },

  label: { color: "#fff", fontSize: 14, fontWeight: "700" },
  smallLabel: { color: "#bdbdbd", fontSize: 12, fontWeight: "700", marginTop: 4 },
  bodyMuted: { color: "#bdbdbd", fontSize: 13, lineHeight: 20 },
  miniNote: { color: "#777", fontSize: 12, lineHeight: 16 },

  input: { backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 12, padding: 12, color: "#fff" },

  primaryBtn: { backgroundColor: ACCENT, padding: 14, borderRadius: 14, alignItems: "center", width: "100%", shadowColor: "#7B61FF", shadowOpacity: 0.5, shadowRadius: 20, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
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

  tabBar: { flexDirection: "row", gap: 8, paddingTop: 10, paddingBottom: 4, borderTopWidth: 1, borderTopColor: "#1e1e1e", overflow: "visible" },
  tabBtn: { flex: 1, backgroundColor: "#0f0f0f", borderWidth: 1, borderColor: "#262626", borderRadius: 14, paddingVertical: 10, alignItems: "center" },
  tabBtnActive: { backgroundColor: ACCENT, borderColor: ACCENT, shadowColor: ACCENT, shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
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
  const scaleAnim = React.useRef(new Animated.Value(1)).current;
  const glowAnim  = React.useRef(new Animated.Value(0.22)).current;

  const handlePressIn = () => {
    Animated.timing(scaleAnim, { toValue: 0.97, duration: 80, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    Animated.timing(glowAnim,  { toValue: 0.38, duration: 120, useNativeDriver: false }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, { toValue: 1, friction: 6, tension: 220, useNativeDriver: true }).start();
    Animated.timing(glowAnim,  { toValue: 0.22, duration: 180, useNativeDriver: false }).start();
  };

  // Outer view: shadow only — useNativeDriver:false (shadowOpacity is a layout prop)
  // Inner view: transform only — useNativeDriver:true (scale is a native-safe prop)
  // Keeping them on separate Animated.Views avoids the mixed-driver conflict.
  return (
    <Animated.View style={{
      width:         "100%",
      borderRadius:  14,
      shadowColor:   "#7B61FF",
      shadowOpacity: glowAnim,
      shadowRadius:  12,
      shadowOffset:  { width: 0, height: 4 },
      elevation:     6,
    }}>
      <Animated.View style={{
        transform: [{ scale: scaleAnim }],
        opacity:   disabled ? 0.45 : 1,
        borderRadius: 14,
      }}>
        <Pressable
          onPress={onPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          disabled={disabled}
          style={{ borderRadius: 14, overflow: "hidden" }}
        >
          <LinearGradient
            colors={["#5e7fff", "#7B61FF", "#a855f7"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ padding: 14, alignItems: "center", opacity: 0.92 }}
          >
            <Text style={styles.primaryBtnText}>{title}</Text>
          </LinearGradient>
        </Pressable>
      </Animated.View>
    </Animated.View>
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

function Splash({
  ready    = false,
  onFinish,
}: {
  ready?:    boolean;
  onFinish?: () => void;
}) {
  // ── Animations ─────────────────────────────────────────────────────────────
  // exitOpacity: wraps entire screen, fades to 0 on exit
  const exitOpacity  = React.useRef(new Animated.Value(1)).current;
  // progressAnim: drives fill width + dot translateX (useNativeDriver:false — layout prop)
  const BAR_WIDTH    = Dimensions.get("window").width * 0.6;
  const progressAnim = React.useRef(new Animated.Value(0)).current;

  // Progress — 0 → BAR_WIDTH over 4600ms ease-out, completes just before the 5s gate
  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue:         BAR_WIDTH,
      duration:        4600,
      easing:          Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Exit — 300ms delay after parent signals ready, then 600ms fade, then unmount
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      Animated.timing(exitOpacity, {
        toValue:         0,
        duration:        600,
        easing:          Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => onFinish?.());
    }, 300);
    return () => clearTimeout(t);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // Outermost wrapper: black bg prevents any white bleed on edges or during exit fade
    <Animated.View style={{ flex: 1, backgroundColor: "#000000", opacity: exitOpacity }}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      {/*
        Full-screen image — aira-splash-logo.png contains the entire visual design
        (background, glows, logo). resizeMode "cover" fills edge to edge.
        backgroundColor="#000000" on ImageBackground style eliminates any gap
        if the image doesn't perfectly cover due to device aspect ratios.
      */}
      <ImageBackground
        source={require("../assets/branding/aira-splash-logo.png")}
        style={{ flex: 1, width: "100%", height: "100%", backgroundColor: "#000000" }}
        resizeMode="cover"
      >
        {/* ── Progress bar + Loading text — 13% from bottom ─────────────────── */}
        <View style={{
          position:   "absolute",
          bottom:     "13%",
          left:       0,
          right:      0,
          alignItems: "center",
          gap:        10,
        }}>
          {/*
            BAR_WIDTH container: fixed pixel size gives animated children a stable
            coordinate space. overflow:hidden on the track clips the gradient fill.
            The dot is a sibling of the track (not inside it) so it isn't clipped.
          */}
          <View style={{ width: BAR_WIDTH, height: 3 }}>

            {/* Track — translucent white background, clips animated fill */}
            <View style={{
              position:        "absolute",
              top: 0, left: 0, right: 0, bottom: 0,
              borderRadius:    1.5,
              backgroundColor: "rgba(255,255,255,0.10)",
              overflow:        "hidden",
            }}>
              {/* Animated fill — grows from 0 → BAR_WIDTH, always renders full gradient inside */}
              <Animated.View style={{ width: progressAnim, height: 3, overflow: "hidden" }}>
                <LinearGradient
                  colors={["#00c8ff", "#a020f0", "#ff2d9b"]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={{ width: BAR_WIDTH, height: 3 }}
                />
              </Animated.View>
            </View>

            {/* Leading-edge dot — 7×7 white circle with cyan glow, tracks fill position */}
            <Animated.View style={{
              position:        "absolute",
              top:             -2,    // centers 7px dot vertically on 3px bar: (3−7)/2 = −2
              left:            -3.5,  // straddles the edge: offset by half dot width
              width:           7,
              height:          7,
              borderRadius:    3.5,
              backgroundColor: "#ffffff",
              shadowColor:     "#00c8ff",
              shadowOpacity:   0.95,
              shadowRadius:    8,
              shadowOffset:    { width: 0, height: 0 },
              transform:       [{ translateX: progressAnim }],
            }} />
          </View>

          {/* Loading text */}
          <Text style={{
            color:         "rgba(255,255,255,0.55)",
            fontSize:      14,
            fontWeight:    "300",
            letterSpacing: 0.5,
          }}>
            Loading...
          </Text>
        </View>
      </ImageBackground>
    </Animated.View>
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
/** Map a GeneratedDailyPlan workout to the WorkoutSession shape the modal renders. */
function workoutPlanToSession(
  task: TimedTask,
  wp: GeneratedDailyPlan["workout"],
): WorkoutSession {
  return {
    workout_id:       task.id,
    title:            wp.focus,
    duration_minutes: wp.durationMins,
    focus:            wp.focus,
    exercises: wp.exercises.map((ex, i): WorkoutExercise => ({
      id:           `${task.id}_ex${i}`,
      name:         ex.name,
      sets:         buildExerciseSets(ex.sets, ex.reps),
      rest_seconds: parseRestSeconds(ex.rest),
      cue:          ex.notes ?? "",
    })),
  };
}

/** Map a GeneratedDailyPlan nutrition plan to the local NutritionPlan shape. */
function generatedNutritionToLocal(gn: GeneratedDailyPlan["nutrition"]): NutritionPlan {
  const strategy = gn.caloricStrategy ?? "maintenance";
  const calories = gn.dailyTarget?.calories ?? 0;
  return {
    plan_id:   "generated",
    title:     `${strategy.charAt(0).toUpperCase() + strategy.slice(1)} — ${calories} kcal`,
    focus:     gn.keyPrinciple ?? "",
    calories,
    protein_g: gn.dailyTarget?.protein ?? null,
    meals: (gn.meals ?? []).map((m, i): MealEntry => ({
      id:      `meal_${i}`,
      label:   m.name ?? "",
      time:    m.timing ?? "",
      focus:   m.focus ?? "",
      example: m.description ?? "",
    })),
    groceryList: gn.supplements ?? [],
  };
}

/** Map a GeneratedDailyPlan recovery plan to the local RecoveryPlan shape. */
function generatedRecoveryToLocal(
  gr: GeneratedDailyPlan["recovery"],
  taskTitle: string,
): RecoveryPlan {
  const t        = taskTitle.toLowerCase();
  const isSleep  = t.includes("sleep") || t.includes("wind") || t.includes("bed");
  // Guard: old stored plans may lack protocol arrays
  const protocols = (isSleep ? gr.eveningProtocols : gr.morningProtocols) ?? [];
  const type: RecoveryPlan["type"] = isSleep ? "Sleep" : gr.readinessTier === "Recover" ? "Rest" : "Stretch";
  const totalMins = protocols.reduce((sum, p) => sum + (p.durationMins ?? 0), 0);
  return {
    plan_id:      "generated",
    type,
    title:        isSleep ? `Sleep — ${gr.sleepTargetHrs ?? 8}h target` : `Recovery — ${gr.readinessTier ?? "Maintain"}`,
    focus:        gr.notes ?? (gr.readinessTier === "Recover"
      ? "Focus on restoration today — mobility, hydration, and clean nutrition."
      : "Support your training with deliberate recovery habits."),
    duration_min: totalMins > 0 ? totalMins : null,
    steps: protocols.map((p, i): RecoveryStep => ({
      id:       `rp_${i}`,
      label:    p.name ?? "",
      duration: `${p.durationMins ?? 0} min`,
      cue:      p.description ?? "",
    })),
    coachingCue: gr.notes ?? "Consistency in recovery compounds just like consistency in training.",
  };
}

function WorkoutDetailModal({
  task,
  taskDone,
  visible,
  onClose,
  onCompleteTask,
  workoutPlan,
}: {
  task:            TimedTask | null;
  taskDone:        boolean;          // live from global tasks — never stale
  visible:         boolean;
  onClose:         () => void;
  onCompleteTask:  (id: string) => void;
  workoutPlan?:    GeneratedDailyPlan["workout"];
}) {
  const [completedIds, setCompletedIds] = React.useState<Set<string>>(new Set());

  // Scroll refs — cardYRef stores each card's Y within the list container;
  // listContainerYRef stores the list container's Y within the ScrollView.
  // Together they give the absolute scroll offset for any card.
  const scrollViewRef      = React.useRef<ScrollView>(null);
  const cardYRef           = React.useRef<Record<string, number>>({});
  const listContainerYRef  = React.useRef(0);

  const workout = task
    ? (workoutPlan ? workoutPlanToSession(task, workoutPlan) : getWorkoutForTask(task))
    : null;
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
          <View style={{ marginBottom: 24 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <View style={{ backgroundColor: "#0e0c2a", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ color: "#a89fff", fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }}>WORKOUT</Text>
              </View>
              <Text style={{ color: "#3a3a5a", fontSize: 11, fontWeight: "600" }}>
                {workout.duration_minutes} min
              </Text>
            </View>

            <Text style={{
              color: "#eeeef5",
              fontSize: 24,
              fontWeight: "900",
              letterSpacing: -0.8,
              lineHeight: 30,
              marginBottom: 8,
            }}>
              {workout.title}
            </Text>
            <Text style={{ color: "#4a4a7a", fontSize: 13, fontWeight: "500" }}>
              {workout.focus}
            </Text>
          </View>

          {/* ── Progress bar ──────────────────────────────────────────────────── */}
          <View style={{ marginBottom: 28 }}>
            <View style={{ height: 4, backgroundColor: "#111120", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
              <View style={{
                height: 4,
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
                      borderColor: ACCENT + "88",
                      borderRadius: 16,
                      overflow: "hidden",
                    }}
                  >
                    {/* ACCENT top strip — signals "you are here" */}
                    <View style={{ height: 4, backgroundColor: ACCENT }} />

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
                          shadowColor: ACCENT,
                          shadowOpacity: 0.3,
                          shadowRadius: 14,
                          shadowOffset: { width: 0, height: 4 },
                          elevation: 6,
                        }}
                      >
                        <Text style={{ color: "#fff", fontSize: 15, fontWeight: "800", letterSpacing: 0.3 }}>
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
                backgroundColor: "#66bb6a0a",
                borderWidth: 1,
                borderColor: "#66bb6a25",
                borderRadius: 14,
                padding: 16,
                alignItems: "center",
                gap: 6,
              }}>
                <Text style={{ color: "#66bb6a", fontSize: 18, fontWeight: "800", letterSpacing: -0.5 }}>
                  Workout done
                </Text>
                <Text style={{ color: "#66bb6a50", fontSize: 13, fontWeight: "500" }}>
                  {totalExercises} exercise{totalExercises !== 1 ? "s" : ""} · {workout.duration_minutes} min
                </Text>
                {/* Confirm task was auto-completed */}
                {taskDone && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 }}>
                    <Text style={{ color: "#66bb6a60", fontSize: 11, fontWeight: "700" }}>✓</Text>
                    <Text style={{ color: "#66bb6a60", fontSize: 11, fontWeight: "600" }}>Logged in today&apos;s plan</Text>
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
                  shadowColor: taskDone ? "#66bb6a" : "transparent",
                  shadowOpacity: taskDone ? 0.28 : 0,
                  shadowRadius: 12,
                  shadowOffset: { width: 0, height: 4 },
                  elevation: taskDone ? 6 : 0,
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

// ---------- Nutrition Detail Modal ----------
function NutritionDetailModal({
  task,
  taskDone,
  visible,
  onClose,
  onCompleteTask,
  nutritionPlan,
}: {
  task:           TimedTask | null;
  taskDone:       boolean;
  visible:        boolean;
  onClose:        () => void;
  onCompleteTask: (id: string) => void;
  nutritionPlan?: GeneratedDailyPlan["nutrition"];
}) {
  const [checkedMeals, setCheckedMeals] = React.useState<Set<string>>(new Set());

  const plan = task
    ? (nutritionPlan ? generatedNutritionToLocal(nutritionPlan) : getNutritionForTask(task))
    : null;
  const totalMeals  = plan?.meals.length ?? 0;
  const doneCount   = checkedMeals.size;
  const allDone     = totalMeals > 0 && doneCount === totalMeals;
  const progressPct = totalMeals > 0 ? Math.round((doneCount / totalMeals) * 100) : 0;

  // Reset or pre-fill on open
  React.useEffect(() => {
    if (!visible || !plan) return;
    if (taskDone) {
      setCheckedMeals(new Set(plan.meals.map((m) => m.id)));
    } else {
      setCheckedMeals(new Set());
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-complete task when all meals are checked
  React.useEffect(() => {
    if (allDone && !taskDone && task) {
      onCompleteTask(task.id);
    }
  }, [allDone]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!task || !plan) return null;

  const GREEN = "#66bb6a";
  const NUTRITION_COLOR = KIND_COLORS.Nutrition?.color ?? "#66bb6a";
  const NUTRITION_BG    = KIND_COLORS.Nutrition?.backgroundColor ?? "#0a1f0b";

  const toggleMeal = (id: string) => {
    setCheckedMeals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: "#06060c" }}>
        <StatusBar barStyle="light-content" />

        {/* ── Top bar ────────────────────────────────────────────────────────── */}
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

          {/* Meals progress pill */}
          <View style={{
            backgroundColor: doneCount > 0 ? NUTRITION_COLOR + "18" : "#0e0e18",
            borderWidth: 1,
            borderColor: doneCount > 0 ? NUTRITION_COLOR + "40" : "#1e1e2e",
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 6,
          }}>
            <Text style={{
              color: doneCount > 0 ? NUTRITION_COLOR : "#3a3a5a",
              fontSize: 12,
              fontWeight: "800",
              letterSpacing: 0.3,
            }}>
              {doneCount}/{totalMeals} meals
            </Text>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 56 }}
        >

          {/* ── Identity ──────────────────────────────────────────────────────── */}
          <View style={{ marginBottom: 24 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <View style={{ backgroundColor: NUTRITION_BG, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ color: NUTRITION_COLOR, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }}>NUTRITION</Text>
              </View>
              <Text style={{ color: "#3a3a5a", fontSize: 11, fontWeight: "600" }}>{task.timeText}</Text>
            </View>

            <Text style={{
              color: "#eeeef5",
              fontSize: 24,
              fontWeight: "900",
              letterSpacing: -0.6,
              lineHeight: 30,
              marginBottom: 6,
            }}>
              {task.title}
            </Text>
            <Text style={{ color: "#4a4a7a", fontSize: 13, fontWeight: "500", lineHeight: 20 }}>
              {plan.focus}
            </Text>
          </View>

          {/* ── Goals row ─────────────────────────────────────────────────────── */}
          {(plan.calories != null || plan.protein_g != null) && (
            <View style={{
              flexDirection: "row",
              gap: 10,
              marginBottom: 28,
            }}>
              {plan.calories != null && (
                <View style={{
                  flex: 1,
                  backgroundColor: "#0a0a14",
                  borderWidth: 1,
                  borderColor: "#1a1a2a",
                  borderRadius: 14,
                  padding: 14,
                  alignItems: "center",
                  gap: 4,
                }}>
                  <Text style={{ color: "#eeeef5", fontSize: 26, fontWeight: "900", letterSpacing: -1 }}>
                    {plan.calories.toLocaleString()}
                  </Text>
                  <Text style={{ color: "#40405a", fontSize: 10, fontWeight: "800", letterSpacing: 1 }}>
                    CALORIES
                  </Text>
                </View>
              )}
              {plan.protein_g != null && (
                <View style={{
                  flex: 1,
                  backgroundColor: "#0a0a14",
                  borderWidth: 1,
                  borderColor: "#1a1a2a",
                  borderRadius: 14,
                  padding: 14,
                  alignItems: "center",
                  gap: 4,
                }}>
                  <Text style={{ color: NUTRITION_COLOR, fontSize: 26, fontWeight: "900", letterSpacing: -1 }}>
                    {plan.protein_g}g
                  </Text>
                  <Text style={{ color: "#40405a", fontSize: 10, fontWeight: "800", letterSpacing: 1 }}>
                    PROTEIN
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* ── Progress bar ──────────────────────────────────────────────────── */}
          <View style={{ marginBottom: 28 }}>
            <View style={{ height: 4, backgroundColor: "#111120", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
              <View style={{
                height: 4,
                width: `${progressPct}%` as any,
                backgroundColor: allDone ? GREEN : NUTRITION_COLOR,
                borderRadius: 2,
              }} />
            </View>
            <Text style={{ color: "#3a3a5a", fontSize: 11, fontWeight: "600" }}>
              {allDone
                ? "All meals complete"
                : doneCount > 0
                  ? `${doneCount} of ${totalMeals} meals done`
                  : `${totalMeals} meals today`}
            </Text>
          </View>

          {/* ── Meal cards ────────────────────────────────────────────────────── */}
          <Text style={{ color: "#40405a", fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 12 }}>
            MEAL PLAN
          </Text>
          <View style={{ gap: 8, marginBottom: 32 }}>
            {plan.meals.map((meal) => {
              const done = checkedMeals.has(meal.id);
              return (
                <Pressable
                  key={meal.id}
                  onPress={() => toggleMeal(meal.id)}
                  style={{
                    backgroundColor: done ? "#080808" : "#0c0c18",
                    borderWidth: 1,
                    borderColor: done ? "#111118" : "#1c1c2c",
                    borderRadius: 14,
                    flexDirection: "row",
                    alignItems: "flex-start",
                    padding: 16,
                    gap: 14,
                  }}
                >
                  {/* Checkbox */}
                  <View style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    borderWidth: 1.5,
                    borderColor: done ? GREEN : "#2e2e42",
                    backgroundColor: done ? GREEN + "14" : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                    marginTop: 1,
                    flexShrink: 0,
                  }}>
                    {done && (
                      <Text style={{ color: GREEN, fontSize: 11, fontWeight: "900", lineHeight: 14 }}>✓</Text>
                    )}
                  </View>

                  {/* Meal info */}
                  <View style={{ flex: 1, gap: 4 }}>
                    {/* Label + time */}
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                      <Text style={{
                        color: done ? "#404040" : "#d0d0dc",
                        fontSize: 14,
                        fontWeight: "700",
                        textDecorationLine: done ? "line-through" : "none",
                      }}>
                        {meal.label}
                      </Text>
                      <Text style={{ color: done ? "#2a2a2a" : "#404058", fontSize: 11, fontWeight: "600" }}>
                        {meal.time}
                      </Text>
                    </View>

                    {/* Focus line */}
                    <Text style={{
                      color: done ? "#303030" : "#5858a0",
                      fontSize: 12,
                      fontWeight: "500",
                      lineHeight: 17,
                    }}>
                      {meal.focus}
                    </Text>

                    {/* Example */}
                    <Text style={{
                      color: done ? "#282828" : "#505065",
                      fontSize: 12,
                      lineHeight: 17,
                      fontStyle: "italic",
                      marginTop: 2,
                    }}>
                      {meal.example}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {/* ── Grocery list ──────────────────────────────────────────────────── */}
          {plan.groceryList.length > 0 && (
            <View style={{ marginBottom: 32 }}>
              <Text style={{ color: "#40405a", fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 12 }}>
                GROCERY LIST
              </Text>
              <View style={{
                backgroundColor: "#08080f",
                borderWidth: 1,
                borderColor: "#141420",
                borderRadius: 14,
                padding: 16,
                gap: 10,
              }}>
                {plan.groceryList.map((item, i) => (
                  <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <View style={{
                      width: 5,
                      height: 5,
                      borderRadius: 3,
                      backgroundColor: NUTRITION_COLOR + "60",
                      flexShrink: 0,
                    }} />
                    <Text style={{ color: "#6868a0", fontSize: 13, fontWeight: "500", flex: 1 }}>
                      {item}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* ── All done summary ──────────────────────────────────────────────── */}
          {allDone && (
            <View style={{
              backgroundColor: GREEN + "0a",
              borderWidth: 1,
              borderColor: GREEN + "25",
              borderRadius: 14,
              padding: 16,
              alignItems: "center",
              marginBottom: 20,
              gap: 4,
            }}>
              <Text style={{ color: GREEN, fontSize: 15, fontWeight: "800" }}>Nutrition locked in</Text>
              <Text style={{ color: GREEN + "80", fontSize: 12 }}>All meals complete for today.</Text>
            </View>
          )}

          {/* ── Completion button ─────────────────────────────────────────────── */}
          <Pressable
            onPress={() => {
              if (!taskDone) {
                // Mark all meals done visually, then complete
                setCheckedMeals(new Set(plan.meals.map((m) => m.id)));
                onCompleteTask(task.id);
              } else {
                onCompleteTask(task.id);
                onClose();
              }
            }}
            style={{
              backgroundColor: taskDone ? "#0e0e0e" : NUTRITION_COLOR,
              borderWidth: 1,
              borderColor: taskDone ? "#1e1e1e" : NUTRITION_COLOR,
              borderRadius: 14,
              paddingVertical: 16,
              alignItems: "center",
              shadowColor: taskDone ? "transparent" : NUTRITION_COLOR,
              shadowOpacity: taskDone ? 0 : 0.28,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
              elevation: taskDone ? 0 : 6,
            }}
          >
            <Text style={{
              color: taskDone ? "#444" : "#fff",
              fontSize: 15,
              fontWeight: "800",
              letterSpacing: 0.2,
            }}>
              {taskDone ? "Mark incomplete" : "Meals complete"}
            </Text>
          </Pressable>

        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ---------- Recovery Detail Modal ----------
function RecoveryDetailModal({
  task,
  taskDone,
  visible,
  onClose,
  onCompleteTask,
  recoveryPlan,
}: {
  task:           TimedTask | null;
  taskDone:       boolean;
  visible:        boolean;
  onClose:        () => void;
  onCompleteTask: (id: string) => void;
  recoveryPlan?:  GeneratedDailyPlan["recovery"];
}) {
  const [checkedSteps, setCheckedSteps] = React.useState<Set<string>>(new Set());

  const plan = task
    ? (recoveryPlan ? generatedRecoveryToLocal(recoveryPlan, task.title) : getRecoveryForTask(task))
    : null;
  const totalSteps  = plan?.steps.length ?? 0;
  const doneCount   = checkedSteps.size;
  const allDone     = totalSteps > 0 && doneCount === totalSteps;
  const progressPct = totalSteps > 0 ? Math.round((doneCount / totalSteps) * 100) : 0;

  // Reset or pre-fill when modal opens
  React.useEffect(() => {
    if (!visible || !plan) return;
    if (taskDone) {
      setCheckedSteps(new Set(plan.steps.map((s) => s.id)));
    } else {
      setCheckedSteps(new Set());
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-complete when all steps checked
  React.useEffect(() => {
    if (allDone && !taskDone && task) {
      onCompleteTask(task.id);
    }
  }, [allDone]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!task || !plan) return null;

  const RECOVERY_COLOR = KIND_COLORS.Recovery?.color ?? "#ce93d8";
  const RECOVERY_BG    = KIND_COLORS.Recovery?.backgroundColor ?? "#1a0a20";
  const GREEN          = "#66bb6a";

  // Sleep type uses a softer blue-grey accent for the stat card
  const statColor = plan.type === "Sleep" ? "#90a4ae" : RECOVERY_COLOR;

  const toggleStep = (id: string) => {
    setCheckedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const ctaLabel = taskDone
    ? "Mark incomplete"
    : plan.type === "Sleep"   ? "Sleep protocol complete"
    : plan.type === "Cold"    ? "Cold exposure complete"
    : plan.type === "Stretch" ? "Mobility complete"
    : "Recovery complete";

  const doneBannerLabel = plan.type === "Sleep"   ? "Sleep protocol locked in"
    : plan.type === "Cold"    ? "Cold exposure done"
    : plan.type === "Stretch" ? "Mobility complete"
    : "Recovery complete";

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: "#06060c" }}>
        <StatusBar barStyle="light-content" />

        {/* ── Top bar ────────────────────────────────────────────────────────── */}
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

          {/* Steps progress pill */}
          <View style={{
            backgroundColor: doneCount > 0 ? RECOVERY_COLOR + "18" : "#0e0e18",
            borderWidth: 1,
            borderColor: doneCount > 0 ? RECOVERY_COLOR + "40" : "#1e1e2e",
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 6,
          }}>
            <Text style={{
              color: doneCount > 0 ? RECOVERY_COLOR : "#3a3a5a",
              fontSize: 12,
              fontWeight: "800",
              letterSpacing: 0.3,
            }}>
              {doneCount}/{totalSteps} steps
            </Text>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 56 }}
        >

          {/* ── Identity ──────────────────────────────────────────────────────── */}
          <View style={{ marginBottom: 24 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <View style={{ backgroundColor: RECOVERY_BG, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ color: RECOVERY_COLOR, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }}>RECOVERY</Text>
              </View>
              <Text style={{ color: "#3a3a5a", fontSize: 11, fontWeight: "600" }}>{task.timeText}</Text>
            </View>

            <Text style={{
              color: "#eeeef5",
              fontSize: 24,
              fontWeight: "900",
              letterSpacing: -0.6,
              lineHeight: 30,
              marginBottom: 8,
            }}>
              {task.title}
            </Text>
            <Text style={{ color: "#4a4a7a", fontSize: 13, fontWeight: "500", lineHeight: 20 }}>
              {plan.focus}
            </Text>
          </View>

          {/* ── Duration stat card ────────────────────────────────────────────── */}
          {(plan.duration_min != null || plan.type === "Sleep") && (
            <View style={{
              backgroundColor: "#0a0a14",
              borderWidth: 1,
              borderColor: "#1a1a2a",
              borderRadius: 14,
              padding: 16,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 28,
            }}>
              <View style={{ gap: 4 }}>
                <Text style={{ color: statColor, fontSize: 28, fontWeight: "900", letterSpacing: -1 }}>
                  {plan.type === "Sleep" ? "8 hr" : `${plan.duration_min} min`}
                </Text>
                <Text style={{ color: "#40405a", fontSize: 10, fontWeight: "800", letterSpacing: 1 }}>
                  {plan.type === "Sleep" ? "TARGET SLEEP" : "DURATION"}
                </Text>
              </View>
              <View style={{
                backgroundColor: RECOVERY_COLOR + "12",
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 6,
              }}>
                <Text style={{ color: RECOVERY_COLOR, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 }}>
                  {plan.type.toUpperCase()}
                </Text>
              </View>
            </View>
          )}

          {/* ── Progress bar ──────────────────────────────────────────────────── */}
          <View style={{ marginBottom: 28 }}>
            <View style={{ height: 4, backgroundColor: "#111120", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
              <View style={{
                height: 4,
                width: `${progressPct}%` as any,
                backgroundColor: allDone ? GREEN : RECOVERY_COLOR,
                borderRadius: 2,
              }} />
            </View>
            <Text style={{ color: "#3a3a5a", fontSize: 11, fontWeight: "600" }}>
              {allDone
                ? "All steps complete"
                : doneCount > 0
                  ? `${doneCount} of ${totalSteps} steps done`
                  : `${totalSteps} steps`}
            </Text>
          </View>

          {/* ── Step cards ────────────────────────────────────────────────────── */}
          <Text style={{ color: "#40405a", fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 12 }}>
            STEPS
          </Text>
          <View style={{ gap: 8, marginBottom: 32 }}>
            {plan.steps.map((step) => {
              const done = checkedSteps.has(step.id);
              return (
                <Pressable
                  key={step.id}
                  onPress={() => toggleStep(step.id)}
                  style={{
                    backgroundColor: done ? "#080808" : "#0c0c18",
                    borderWidth: 1,
                    borderColor: done ? "#111118" : "#1c1c2c",
                    borderRadius: 14,
                    flexDirection: "row",
                    alignItems: "flex-start",
                    padding: 16,
                    gap: 14,
                  }}
                >
                  {/* Checkbox */}
                  <View style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    borderWidth: 1.5,
                    borderColor: done ? GREEN : "#2e2e42",
                    backgroundColor: done ? GREEN + "14" : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                    marginTop: 1,
                    flexShrink: 0,
                  }}>
                    {done && (
                      <Text style={{ color: GREEN, fontSize: 11, fontWeight: "900", lineHeight: 14 }}>✓</Text>
                    )}
                  </View>

                  {/* Step info */}
                  <View style={{ flex: 1, gap: 4 }}>
                    {/* Label + duration */}
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <Text style={{
                        color: done ? "#404040" : "#d0d0dc",
                        fontSize: 14,
                        fontWeight: "700",
                        textDecorationLine: done ? "line-through" : "none",
                        flex: 1,
                      }}>
                        {step.label}
                      </Text>
                      <Text style={{
                        color: done ? "#2a2a2a" : RECOVERY_COLOR + "88",
                        fontSize: 11,
                        fontWeight: "700",
                        flexShrink: 0,
                      }}>
                        {step.duration}
                      </Text>
                    </View>

                    {/* Coaching cue */}
                    <Text style={{
                      color: done ? "#282828" : "#505068",
                      fontSize: 12,
                      lineHeight: 18,
                      fontWeight: "500",
                      marginTop: 2,
                    }}>
                      {step.cue}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {/* ── Coaching cue card ─────────────────────────────────────────────── */}
          <View style={{
            backgroundColor: "#08080f",
            borderWidth: 1,
            borderColor: "#141420",
            borderRadius: 14,
            padding: 16,
            marginBottom: 24,
            gap: 8,
          }}>
            <Text style={{ color: "#40405a", fontSize: 10, fontWeight: "800", letterSpacing: 1 }}>
              COACHING CUE
            </Text>
            <Text style={{ color: "#6060a0", fontSize: 13, lineHeight: 21, fontStyle: "italic" }}>
              {plan.coachingCue}
            </Text>
          </View>

          {/* ── All done banner ───────────────────────────────────────────────── */}
          {allDone && (
            <View style={{
              backgroundColor: GREEN + "0a",
              borderWidth: 1,
              borderColor: GREEN + "25",
              borderRadius: 14,
              padding: 16,
              alignItems: "center",
              marginBottom: 20,
              gap: 4,
            }}>
              <Text style={{ color: GREEN, fontSize: 15, fontWeight: "800" }}>{doneBannerLabel}</Text>
              <Text style={{ color: GREEN + "80", fontSize: 12 }}>Recovery done for today.</Text>
            </View>
          )}

          {/* ── Completion button ─────────────────────────────────────────────── */}
          <Pressable
            onPress={() => {
              if (!taskDone) {
                setCheckedSteps(new Set(plan.steps.map((s) => s.id)));
                onCompleteTask(task.id);
              } else {
                onCompleteTask(task.id);
                onClose();
              }
            }}
            style={{
              backgroundColor: taskDone ? "#0e0e0e" : RECOVERY_COLOR,
              borderWidth: 1,
              borderColor: taskDone ? "#1e1e1e" : RECOVERY_COLOR,
              borderRadius: 14,
              paddingVertical: 16,
              alignItems: "center",
              shadowColor: taskDone ? "transparent" : RECOVERY_COLOR,
              shadowOpacity: taskDone ? 0 : 0.28,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
              elevation: taskDone ? 0 : 6,
            }}
          >
            <Text style={{
              color: taskDone ? "#444" : "#fff",
              fontSize: 15,
              fontWeight: "800",
              letterSpacing: 0.2,
            }}>
              {ctaLabel}
            </Text>
          </Pressable>

        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ---------- Habit content map ----------
type HabitContent = {
  description: string;  // 1–2 lines: the "why" behind this habit
  instruction: string;  // what to do right now — one sentence
  coachingCue: string;  // short, punchy, no filler
};

function getHabitContent(task: TimedTask): HabitContent {
  const t = task.title.toLowerCase();

  if (t.includes("cold shower") || (t.includes("cold") && t.includes("shower")))
    return {
      description: "Cold exposure resets your nervous system, boosts alertness, and reinforces that you can do hard things on demand.",
      instruction: "Step in, turn it cold, stay for 60–90 seconds. Breathe through it.",
      coachingCue: "The discomfort is the point. Every second you stay is a rep of discipline.",
    };

  if (t.includes("journal") || t.includes("journaling") || t.includes("morning pages") || t.includes("writing"))
    return {
      description: "Daily writing clears mental noise, surfaces what actually matters, and compounds into self-awareness over months.",
      instruction: "Open the page and write — anything. No editing, no rereading. Just output.",
      coachingCue: "You don't journal to record your life. You journal to understand it.",
    };

  if (t.includes("meditat") || t.includes("breathwork") || t.includes("mindful") || t.includes("breathing"))
    return {
      description: "Five minutes of deliberate stillness lowers cortisol, sharpens focus, and builds the capacity to stay calm under pressure.",
      instruction: "Sit, close your eyes, breathe in for 4 counts, out for 6. Stay with it.",
      coachingCue: "Your mind will wander. Noticing that and returning — that is the practice.",
    };

  if (t.includes("read") || t.includes("book") || t.includes("pages"))
    return {
      description: "Consistent reading compounds into an edge. Thirty minutes a day is twenty books a year.",
      instruction: "Open the book. Read until the timer goes — no switching to your phone.",
      coachingCue: "It doesn't matter how fast. It matters that you showed up.",
    };

  if (t.includes("walk") || t.includes("steps") || t.includes("outdoor"))
    return {
      description: "A short walk lowers cortisol, clears decision fatigue, and adds low-intensity movement that compounds into real results over time.",
      instruction: "Get outside, move at a brisk pace, and leave the phone in your pocket.",
      coachingCue: "The walk is not nothing. It is everything small that builds the person you are becoming.",
    };

  if (t.includes("no alcohol") || t.includes("alcohol-free") || t.includes("sober") || t.includes("no drink"))
    return {
      description: "Skipping alcohol today protects your sleep architecture, recovery, and hormone levels — gains that are invisible but real.",
      instruction: "Choose your alternative drink now. Decide before the moment, not in it.",
      coachingCue: "You are not missing out. You are outcompeting the version of you that would have said yes.",
    };

  if (t.includes("vitamin") || t.includes("supplement") || t.includes("omega") || t.includes("creatine"))
    return {
      description: "Consistent supplementation only works when it is truly consistent. Miss one day and the benefit compounds backward.",
      instruction: "Take them now with water. Don't think about it — just do it.",
      coachingCue: "The habit is the discipline. The supplement is just the object.",
    };

  if (t.includes("gratitude") || t.includes("grateful"))
    return {
      description: "A daily gratitude practice shifts baseline attention from what is missing to what is working — a measurable mood upgrade over weeks.",
      instruction: "Write three specific things you are grateful for. No generic answers.",
      coachingCue: "Specific beats vague. 'My coffee was perfect this morning' beats 'I'm grateful for life.'",
    };

  // Generic fallback — works for any habit the AI generates
  return {
    description: "Showing up for this habit today is a vote for the person you are building. Consistency beats intensity every time.",
    instruction: "Do it now, exactly as planned. No modifications, no delays.",
    coachingCue: "You don't need to feel like it. You just need to do it.",
  };
}

// ---------- Habit Detail Modal ----------
function HabitDetailModal({
  task,
  taskDone,
  visible,
  onClose,
  onToggle,
}: {
  task:     TimedTask | null;
  taskDone: boolean;
  visible:  boolean;
  onClose:  () => void;
  onToggle: (id: string) => void;
}) {
  if (!task) return null;

  const content      = getHabitContent(task);
  const HABIT_COLOR  = KIND_COLORS.Habit?.color          ?? "#ef9a9a";
  const HABIT_BG     = KIND_COLORS.Habit?.backgroundColor ?? "#200a0a";
  const duration     = KIND_DURATION[task.kind];
  const priority     = task.priority ?? "medium";
  const priorityColor =
    priority === "high"   ? "#FF5252" :
    priority === "medium" ? "#FFB300" : "#555";
  const priorityLabel = priority === "high" ? "REQUIRED" : "OPTIONAL";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}
        onPress={onClose}
      >
        <Pressable onPress={() => {}} style={{ maxHeight: "72%" }}>
          <View style={{
            backgroundColor: "#0a0a0f",
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            overflow: "hidden",
          }}>

            {/* Drag handle */}
            <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 4 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: "#1e1e2e" }} />
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 36 }}
            >
              {/* ── Kind + priority header ─────────────────────────────────────── */}
              <View style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingTop: 14,
                paddingBottom: 18,
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ backgroundColor: HABIT_BG, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ color: HABIT_COLOR, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }}>HABIT</Text>
                  </View>
                  {duration && (
                    <Text style={{ color: "#3a3a5a", fontSize: 11, fontWeight: "600" }}>{duration}</Text>
                  )}
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ color: "#3a3a5a", fontSize: 11, fontWeight: "600" }}>{task.timeText}</Text>
                  <View style={{ backgroundColor: priorityColor + "18", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <Text style={{ color: priorityColor, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }}>
                      {priorityLabel}
                    </Text>
                  </View>
                </View>
              </View>

              {/* ── Title ─────────────────────────────────────────────────────────── */}
              <Text style={{
                color: taskDone ? "#555" : "#eeeef5",
                fontSize: 22,
                fontWeight: "800",
                lineHeight: 28,
                letterSpacing: -0.4,
                textDecorationLine: taskDone ? "line-through" : "none",
                marginBottom: 10,
              }}>
                {task.title}
              </Text>

              {/* ── Description ───────────────────────────────────────────────────── */}
              <Text style={{
                color: "#606078",
                fontSize: 13,
                lineHeight: 20,
                fontWeight: "500",
                marginBottom: 24,
              }}>
                {content.description}
              </Text>

              {/* ── Instruction + cue card ────────────────────────────────────────── */}
              <View style={{
                backgroundColor: "#08080f",
                borderWidth: 1,
                borderColor: "#141420",
                borderRadius: 14,
                padding: 16,
                gap: 10,
                marginBottom: 28,
              }}>
                <Text style={{ color: "#40405a", fontSize: 10, fontWeight: "800", letterSpacing: 1 }}>
                  DO THIS NOW
                </Text>
                <Text style={{ color: "#9090b8", fontSize: 14, lineHeight: 22, fontWeight: "500" }}>
                  {content.instruction}
                </Text>
                <View style={{ height: 1, backgroundColor: "#111120" }} />
                <Text style={{ color: "#5050a0", fontSize: 12, lineHeight: 18, fontStyle: "italic" }}>
                  {content.coachingCue}
                </Text>
              </View>

              {/* ── CTA ──────────────────────────────────────────────────────────── */}
              <Pressable
                onPress={() => { onToggle(task.id); onClose(); }}
                style={{
                  backgroundColor: taskDone ? "#0e0e0e" : HABIT_COLOR,
                  borderWidth: 1,
                  borderColor: taskDone ? "#1e1e1e" : HABIT_COLOR,
                  borderRadius: 14,
                  paddingVertical: 16,
                  alignItems: "center",
                  shadowColor: taskDone ? "transparent" : HABIT_COLOR,
                  shadowOpacity: taskDone ? 0 : 0.25,
                  shadowRadius: 12,
                  shadowOffset: { width: 0, height: 4 },
                  elevation: taskDone ? 0 : 5,
                }}
              >
                <Text style={{
                  color: taskDone ? "#444" : "#1a0505",
                  fontSize: 15,
                  fontWeight: "800",
                  letterSpacing: 0.2,
                }}>
                  {taskDone ? "Mark incomplete" : "Complete habit"}
                </Text>
              </Pressable>
            </ScrollView>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

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
  isNext,
}: {
  task:     TimedTask;
  onToggle: () => void;
  onDetail: () => void;
  isNext?:  boolean;
}) {
  const priority  = task.priority ?? "medium";
  const kindColor = KIND_COLORS[task.kind]?.color ?? "#6C63FF";
  const kindIcon  = KIND_ICONS[task.kind] ?? "·";
  const isLowFlex = !task.done && priority === "low";

  // ── Micro-interactions ──────────────────────────────────────────────────────
  // Scale: shrinks slightly on completion then springs back
  const scaleAnim    = React.useRef(new Animated.Value(1)).current;
  // Flash: brief green overlay when marked done
  const flashOpacity = React.useRef(new Animated.Value(0)).current;
  // Track previous done state so we only trigger on the rising edge
  const prevDoneRef  = React.useRef(task.done);

  React.useEffect(() => {
    if (task.done && !prevDoneRef.current) {
      // Scale down → controlled spring back
      Animated.sequence([
        Animated.timing(scaleAnim, { toValue: 0.965, duration: 80, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.spring(scaleAnim, { toValue: 1, friction: 6, tension: 220, useNativeDriver: true }),
      ]).start();
      // Green glow flash — slightly faster fade for crispness
      Animated.sequence([
        Animated.timing(flashOpacity, { toValue: 1, duration: 120, useNativeDriver: true }),
        Animated.timing(flashOpacity, { toValue: 0, duration: 340, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]).start();
    }
    prevDoneRef.current = task.done;
  }, [task.done]); // eslint-disable-line react-hooks/exhaustive-deps

  // Press feedback: slight scale on press-in, released on press-out
  const handlePressIn  = () => Animated.timing(scaleAnim, { toValue: 0.98, duration: 80, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  const handlePressOut = () => Animated.spring(scaleAnim, { toValue: 1, friction: 6, tension: 160, useNativeDriver: true }).start();

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
    <Pressable
      onPress={onDetail}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={{
        backgroundColor: task.done ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)",
        borderRadius: 18,
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 14,
        paddingHorizontal: 14,
        gap: 13,
        opacity: isLowFlex ? 0.5 : 1,
        overflow: "hidden",
        // Glow: high-priority undone → kind-tinted; next → accent; done/low → neutral
        ...(isNext && !task.done ? {
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.10)",
          shadowColor: ACCENT,
          shadowOpacity: 0.18,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 6 },
          elevation: 7,
        } : priority === "high" && !task.done ? {
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.08)",
          shadowColor: kindColor,
          shadowOpacity: 0.10,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 6 },
          elevation: 5,
        } : {
          borderWidth: 1,
          borderColor: task.done ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.06)",
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 6 },
          elevation: 3,
        }),
      }}
    >
      {/* Top highlight line — 1px glass shimmer at card top edge */}
      {!task.done && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute", top: 0, left: 20, right: 20, height: 1,
            backgroundColor: "#ffffff",
            opacity: 0.04,
            borderRadius: 1,
          }}
        />
      )}
      {/* Completion glow flash — fades in/out on done transition */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: "#66bb6a",
          opacity: flashOpacity.interpolate({ inputRange: [0, 1], outputRange: [0, 0.10] }),
          borderRadius: 18,
        }}
      />
      {/* Kind icon circle */}
      <View style={{
        width:            40,
        height:           40,
        borderRadius:     12,
        backgroundColor:  task.done ? "#0e0e1a" : kindColor + "20",
        alignItems:       "center",
        justifyContent:   "center",
        flexShrink:       0,
        ...(task.done ? {} : {
          shadowColor:   kindColor,
          shadowOpacity: 0.22,
          shadowRadius:  8,
          shadowOffset:  { width: 0, height: 0 },
        }),
      }}>
        <Ionicons
          name={(kindIcon ?? "ellipse-outline") as any}
          size={task.done ? 16 : 17}
          color={task.done ? "#252535" : kindColor}
          style={{ opacity: task.done ? 0.5 : 1 }}
        />
      </View>

      {/* Content */}
      <View style={{ flex: 1, gap: 3 }}>
        {/* Title */}
        <Text style={{
          color:              task.done ? "#26263a" : priority === "high" ? "#eeeeff" : "#d0d0e8",
          fontSize:           14,
          fontWeight:         priority === "high" && !task.done ? "700" : "600",
          lineHeight:         22,
          letterSpacing:      priority === "high" && !task.done ? -0.3 : -0.1,
          textDecorationLine: task.done ? "line-through" : "none",
        }}>
          {task.title}
        </Text>

        {/* Subtitle: time · priority badge · optional tag */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: task.done ? "#222232" : "#383855", fontSize: 11, fontWeight: "500", letterSpacing: 0.2 }}>
            {formatDisplayTime(task.timeText)}
          </Text>
          {/* PRIORITY badge — shown on high-priority undone tasks */}
          {priority === "high" && !task.done && (
            <View style={{
              backgroundColor: kindColor + "1a",
              borderWidth:     1,
              borderColor:     kindColor + "30",
              borderRadius:    4,
              paddingHorizontal: 5,
              paddingVertical:   1,
            }}>
              <Text style={{
                color:         kindColor + "cc",
                fontSize:      8,
                fontWeight:    "900",
                letterSpacing: 0.7,
              }}>
                PRIORITY
              </Text>
            </View>
          )}
          {!task.done && task.tag && (
            <View style={{
              backgroundColor: task.tag === "carried_over" ? "#1a1a2c" : "#0e1828",
              borderRadius:    4,
              paddingHorizontal: 5,
              paddingVertical:   1,
            }}>
              <Text style={{
                color:         task.tag === "carried_over" ? "#404068" : "#3060a0",
                fontSize:      8,
                fontWeight:    "800",
                letterSpacing: 0.6,
              }}>
                {task.tag === "carried_over" ? "CARRIED" : "FOCUS"}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Circular completion toggle */}
      <Pressable
        onPress={(e) => { e.stopPropagation?.(); onToggle(); }}
        hitSlop={{ top: 12, bottom: 12, left: 8, right: 4 }}
        style={({ pressed }) => ({ flexShrink: 0, opacity: pressed ? 0.65 : 1 })}
      >
        <View style={{
          width:           26,
          height:          26,
          borderRadius:    13,
          borderWidth:     task.done ? 0 : 1.5,
          borderColor:     "#2a2a40",
          backgroundColor: task.done ? "#66bb6a" : "transparent",
          alignItems:      "center",
          justifyContent:  "center",
          ...(task.done ? {
            shadowColor:   "#66bb6a",
            shadowOpacity: 0.35,
            shadowRadius:  8,
            shadowOffset:  { width: 0, height: 0 },
          } : {}),
        }}>
          {task.done && (
            <Text style={{ color: "#1a2e1a", fontSize: 12, fontWeight: "900", lineHeight: 14 }}>✓</Text>
          )}
        </View>
      </Pressable>
    </Pressable>
    </Animated.View>
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
  bestStreak:       number;
  score:            number;
  gamePlan:         GamePlan | null;
  userContext:         string;
  predictiveInsights: PredictiveInsight[];
  nextBestAction:     NextAction | null;
  winCondition:       WinCondition | null;
  dayEvaluation:      DayEvaluation | null;
  tomorrowPrep:       TomorrowPrep | null;
  weeklyMomentum:     WeeklyMomentum | null;
  saveTheDay:         SaveTheDay;
  readinessState:     ReadinessState | null;
  coachMode:          CoachMode;
  memoryContext:      string;
  onPlanAction:       (action: string) => void;
};

function ChatScreen({
  messages, setMessages, sessionId, setSessionId,
  profile, recovery, blocks, tasks, rebalancedTasks, recoveryStatus, liveStreak, bestStreak, score, gamePlan,
  userContext, predictiveInsights, nextBestAction, winCondition, dayEvaluation, tomorrowPrep, weeklyMomentum, saveTheDay, readinessState, coachMode, memoryContext, onPlanAction,
}: ChatScreenProps) {
  const [chatInput,     setChatInput]     = useState("");
  const [chatLoading,   setChatLoading]   = useState(false);
  const [checkinActive, setCheckinActive] = useState(false);
  const [checkinStep,   setCheckinStep]   = useState(0);
  const [checkinData,   setCheckinData]   = useState<Record<string, string>>({});
  const chatControllerRef = React.useRef<AbortController | null>(null);
  const scrollRef         = React.useRef<ScrollView>(null);

  const handleAskCoach = async (overrideText?: string) => {
    const trimmed = (overrideText ?? chatInput).trim();
    if (!trimmed || chatLoading) return;

    // Day evaluation intercept — instant client-side answer, no API call
    if (/how did i do (today)?\??$|how was my day\??$/i.test(trimmed) && dayEvaluation) {
      const lines: string[] = [`**${dayEvaluation.status}** — ${dayEvaluation.message}`];
      if (dayEvaluation.focusTomorrow) lines.push(`Tomorrow: ${dayEvaluation.focusTomorrow}`);
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: lines.join("\n\n") },
      ]);
      setChatInput("");
      return;
    }

    // Weekly momentum intercept — instant client-side answer, no API call
    if (/how is my week (going)?\??|am i building momentum\??|how.s my week\??/i.test(trimmed) && weeklyMomentum) {
      const lines = [
        `**${weeklyMomentum.status}** — ${weeklyMomentum.summary}`,
        weeklyMomentum.focus,
      ];
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: lines.join("\n\n") },
      ]);
      setChatInput("");
      return;
    }

    // Tomorrow prep intercept — instant client-side answer, no API call
    if (/what should i focus on tomorrow\??|how do i bounce back tomorrow\??|what.s my focus tomorrow\??/i.test(trimmed) && tomorrowPrep) {
      const lines: string[] = [`**${tomorrowPrep.primaryFocus}**`];
      if (tomorrowPrep.prepAction) lines.push(`Tonight: ${tomorrowPrep.prepAction}`);
      if (tomorrowPrep.carryOverReason) lines.push(tomorrowPrep.carryOverReason);
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: lines.join("\n\n") },
      ]);
      setChatInput("");
      return;
    }

    // Readiness intercept — instant client-side answer, no API call
    if (/what kind of day (is this|am i having)\??|how should i approach today\??|what.s my readiness\??/i.test(trimmed) && readinessState) {
      const levelLabel =
        readinessState.readiness === "PUSH"    ? "Push day"    :
        readinessState.readiness === "RECOVER" ? "Recover day" :
        "Build day";
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        {
          role: "assistant",
          content: `**${levelLabel}.** ${readinessState.reason}`,
        },
      ]);
      setChatInput("");
      return;
    }

    // Energy-aware intercept — instant adapt + client-side confirmation, no API call
    if (/\bi.?m (tired|exhausted|drained|wiped)\b|low energy|not feeling it|no energy|feel rough/i.test(trimmed)) {
      onPlanAction("LOW_ENERGY");
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        {
          role: "assistant",
          content: "Got it — plan adjusted for low energy. Workout de-intensified, optional tasks cleared. What's your one thing right now?",
        },
      ]);
      setChatInput("");
      return;
    }

    // Save The Day intercept — instant client-side answer, no API call
    if (/i.m (behind|off track|falling behind)|i haven.?t done (anything|nothing)|i.m losing (my )?streak/i.test(trimmed) && saveTheDay.trigger) {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        {
          role: "assistant",
          content: `**${saveTheDay.action}**\n\n${saveTheDay.reason}`,
        },
      ]);
      setChatInput("");
      return;
    }

    // Win condition intercept — instant client-side answer, no API call
    if (/what (matters most|do i need to (get done|do)|should i focus on) today\??$/i.test(trimmed) && winCondition) {
      const lines: string[] = [`**${winCondition.primary}**`];
      if (winCondition.secondary) lines.push(winCondition.secondary);
      if (winCondition.flex?.length) lines.push(`If time allows: ${winCondition.flex.join(", ")}.`);
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: lines.join("\n\n") },
      ]);
      setChatInput("");
      return;
    }

    // "What should I do now?" — instant client-side answer, no API call
    if (/what should i do (now|right now|next)\??$/i.test(trimmed) && nextBestAction) {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        {
          role: "assistant",
          content: `**${nextBestAction.label}**\n\n${nextBestAction.reason}`,
        },
      ]);
      setChatInput("");
      return;
    }

    // Command detection — runs before AI call so plan updates feel instant
    const command = detectCommand(trimmed);
    if (command) {
      onPlanAction(command.type);
    } else if (trimmed.toLowerCase().includes("adjust my plan")) {
      onPlanAction("adjust"); // legacy quick-reply fallback
    }

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
          name:  profile?.profile?.firstName  ?? "User",
          goal:  profile?.goals?.goalLabel   ?? "Build discipline",
          wake:  profile?.sleep?.wakeTime    ?? "",
          sleep: profile?.sleep?.sleepTime   ?? "",
          targetGoal:       profile?.derived?.targetGoal
            ? (TARGET_GOAL_LABELS[profile.derived?.targetGoal] ?? profile.derived?.targetGoal ?? "")
            : "",
          bodyFatDirection: profile?.derived?.bodyFatDirection ?? "",
          experienceLevel:  profile?.training?.experience      ?? "",
          equipment:        profile?.derived?.equipment        ?? "",
          workoutFrequency: profile?.derived?.workoutFrequency ?? "",
          dailyTrainingTime:profile?.training?.sessionDuration  ?? "",
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
          bestStreak,
          identityLabel: getIdentityLabel(liveStreak).label,
          ...(predictiveInsights.length > 0 ? {
            predictiveContext: predictiveInsights.map((i) => `${i.label}: ${i.message}`).join(" | "),
          } : {}),
          score,
          gamePlan: gamePlan
            ? { readiness: gamePlan.readiness, timeMode: gamePlan.timeMode, message: gamePlan.message }
            : null,
          coachMode,
          ...(memoryContext ? { memoryContext } : {}),
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

  // ── Check-in flow steps ───────────────────────────────────────────────────
  const CHECKIN_STEPS = [
    { key: "energy",   label: "How's your energy today?",      options: ["Low", "Moderate", "High"] },
    { key: "soreness", label: "Any soreness or tightness?",    options: ["Feeling fresh", "Mild", "Pretty sore"] },
    { key: "time",     label: "How much time do you have?",    options: ["Under 30 min", "About an hour", "Full time"] },
    { key: "focus",    label: "What's your main focus today?", options: ["Training", "Nutrition", "Recovery", "All of it"] },
  ];

  // ── Quick reply pills (shown mid-conversation) ────────────────────────────
  const QUICK_REPLIES = [
    "What should I do now?",
    "What's my priority right now?",
    "Motivate me",
    "Adjust my plan",
    "I have less time",
    "What am I missing?",
  ];

  // ── Context-aware starter prompts ─────────────────────────────────────────
  const starterPrompts = React.useMemo(() => {
    const done    = rebalancedTasks.filter((t) => t.done);
    const high    = rebalancedTasks.filter((t) => !t.done && (t.priority ?? "medium") === "high");
    const workout = rebalancedTasks.find((t) => t.kind === "Workout");

    if (rebalancedTasks.length === 0) {
      return ["Build my day", "What should I focus on?", "How does this work?", "Set my goals"];
    }
    if (done.length === rebalancedTasks.length) {
      return liveStreak >= 5
        ? ["You're not starting anymore — you're consistent now.", "Build tomorrow", "How did I do today?", "Keep me accountable"]
        : ["How did I do today?", "What should I work on next?", "Build tomorrow", "Keep me accountable"];
    }

    const prompts: string[] = [];
    if (liveStreak > 0 && done.length === 0) prompts.push("Don't let me break my streak");
    if (workout && !workout.done) prompts.push("I haven't done my workout yet");
    if (high.length > 0)          prompts.push("What should I focus on right now?");
    prompts.push("I have less time today");
    prompts.push(done.length === 0 ? "Motivate me to start" : "Keep the momentum going");
    if (prompts.length < 4)       prompts.push("Adjust my plan");
    return prompts.slice(0, 4);
  }, [rebalancedTasks, liveStreak]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      {/* ── Message list ──────────────────────────────────────────────────────── */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 12, gap: 12 }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >

        {/* ── Empty state ───────────────────────────────────────────────────── */}
        {messages.length === 0 && !chatLoading && (
          <View style={{ gap: 22, paddingTop: 4 }}>

            {/* Identity */}
            <View style={{ gap: 5 }}>
              <Text style={{ color: "#fff", fontSize: 28, fontWeight: "900", letterSpacing: -0.8 }}>Aira</Text>
              <Text style={{ color: "#5050a0", fontSize: 9, fontWeight: "900", letterSpacing: 1.6 }}>YOUR COACH · ALWAYS ON</Text>
            </View>

            {/* Context strip — shows what Aira already knows */}
            {rebalancedTasks.length > 0 && (
              <View style={{
                backgroundColor: "#0a0a18",
                borderWidth: 1,
                borderColor: "#1e1e38",
                borderRadius: 16,
                padding: 16,
                gap: 12,
              }}>
                <Text style={{ color: "#404068", fontSize: 9, fontWeight: "900", letterSpacing: 1.2 }}>
                  AIRA KNOWS YOUR DAY
                </Text>

                {/* Stats row */}
                <View style={{ flexDirection: "row", gap: 20 }}>
                  <View style={{ gap: 3 }}>
                    <Text style={{ color: score > 0 ? "#fff" : "#444", fontSize: 20, fontWeight: "900", letterSpacing: -0.8 }}>
                      {score}
                    </Text>
                    <Text style={{ color: "#333350", fontSize: 9, fontWeight: "700", letterSpacing: 0.8 }}>SCORE</Text>
                  </View>
                  <View style={{ gap: 3 }}>
                    <Text style={{ color: rebalancedTasks.filter((t) => t.done).length > 0 ? "#66bb6a" : "#444", fontSize: 20, fontWeight: "900", letterSpacing: -0.8 }}>
                      {rebalancedTasks.filter((t) => t.done).length}/{rebalancedTasks.length}
                    </Text>
                    <Text style={{ color: "#333350", fontSize: 9, fontWeight: "700", letterSpacing: 0.8 }}>TASKS DONE</Text>
                  </View>
                  {liveStreak > 0 && (
                    <View style={{ gap: 3 }}>
                      <Text style={{ color: ACCENT, fontSize: 20, fontWeight: "900", letterSpacing: -0.8 }}>{liveStreak}</Text>
                      <Text style={{ color: "#333350", fontSize: 9, fontWeight: "700", letterSpacing: 0.8 }}>STREAK</Text>
                    </View>
                  )}
                  {bestStreak > 0 && liveStreak < bestStreak && (
                    <View style={{ gap: 3 }}>
                      <Text style={{ color: "#555580", fontSize: 20, fontWeight: "900", letterSpacing: -0.8 }}>{bestStreak}</Text>
                      <Text style={{ color: "#333350", fontSize: 9, fontWeight: "700", letterSpacing: 0.8 }}>BEST</Text>
                    </View>
                  )}
                  {/* Identity label */}
                  {(() => {
                    const { label, color } = getIdentityLabel(liveStreak);
                    return (
                      <View style={{ gap: 3 }}>
                        <Text style={{ color, fontSize: 11, fontWeight: "900", letterSpacing: -0.3 }}>{label}</Text>
                        <Text style={{ color: "#333350", fontSize: 9, fontWeight: "700", letterSpacing: 0.8 }}>IDENTITY</Text>
                      </View>
                    );
                  })()}
                  {gamePlan && (
                    <View style={{ flex: 1, alignItems: "flex-end", justifyContent: "flex-start", paddingTop: 2 }}>
                      <View style={{ backgroundColor: gamePlan.color + "18", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                        <Text style={{ color: gamePlan.color, fontSize: 9, fontWeight: "900", letterSpacing: 0.8 }}>
                          {gamePlan.readiness.toUpperCase()}
                        </Text>
                      </View>
                    </View>
                  )}
                </View>

                {/* Pending high-priority tasks */}
                {(() => {
                  const missedHigh = rebalancedTasks.filter((t) => !t.done && (t.priority ?? "medium") === "high");
                  if (missedHigh.length === 0) return null;
                  return (
                    <View style={{ borderTopWidth: 1, borderTopColor: "#141428", paddingTop: 10, gap: 5 }}>
                      {missedHigh.slice(0, 2).map((t) => (
                        <Text key={t.id} style={{ color: "#5050a0", fontSize: 11, fontWeight: "600", lineHeight: 16 }}>
                          · {t.title}
                        </Text>
                      ))}
                      {missedHigh.length > 2 && (
                        <Text style={{ color: "#333350", fontSize: 11, fontWeight: "600" }}>
                          +{missedHigh.length - 2} more pending
                        </Text>
                      )}
                    </View>
                  );
                })()}

                {/* Streak nudge line */}
                {(() => {
                  const doneTasks = rebalancedTasks.filter((t) => t.done);
                  if (liveStreak > 0 && doneTasks.length === 0) {
                    return (
                      <View style={{ borderTopWidth: 1, borderTopColor: "#141428", paddingTop: 10 }}>
                        <Text style={{ color: "#7744aa", fontSize: 11, fontWeight: "700" }}>
                          Don&apos;t break your {liveStreak}-day streak today.
                        </Text>
                      </View>
                    );
                  }
                  if (bestStreak > liveStreak && bestStreak - liveStreak <= 3 && liveStreak > 0) {
                    return (
                      <View style={{ borderTopWidth: 1, borderTopColor: "#141428", paddingTop: 10 }}>
                        <Text style={{ color: "#6060a0", fontSize: 11, fontWeight: "600" }}>
                          {bestStreak - liveStreak} day{bestStreak - liveStreak !== 1 ? "s" : ""} from your best streak ({bestStreak}).
                        </Text>
                      </View>
                    );
                  }
                  return null;
                })()}
              </View>
            )}

            {/* Starter prompts */}
            <View style={{ gap: 10 }}>
              <Text style={{ color: "#383858", fontSize: 9, fontWeight: "900", letterSpacing: 1.2 }}>QUICK START</Text>
              <View style={{ gap: 7 }}>
                {starterPrompts.map((prompt) => (
                  <Pressable
                    key={prompt}
                    onPress={() => {
                      if (prompt === "Build my day") {
                        setCheckinActive(true);
                        setCheckinStep(0);
                        setCheckinData({});
                      } else {
                        handleAskCoach(prompt);
                      }
                    }}
                    style={{
                      borderWidth: 1,
                      borderColor: "#1a1a2e",
                      borderRadius: 13,
                      paddingVertical: 13,
                      paddingHorizontal: 15,
                      backgroundColor: "#09091a",
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <Text style={{ color: "#c8c8e0", fontSize: 14, fontWeight: "600" }}>{prompt}</Text>
                    <Text style={{ color: ACCENT + "60", fontSize: 16, fontWeight: "700" }}>›</Text>
                  </Pressable>
                ))}
              </View>
            </View>

          </View>
        )}

        {/* ── Messages ──────────────────────────────────────────────────────── */}
        {messages.map((msg, i) => (
          <View
            key={i}
            style={{ alignSelf: msg.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%", gap: 4 }}
          >
            {msg.role === "assistant" && (
              <Text style={{ color: ACCENT, fontSize: 9, fontWeight: "900", letterSpacing: 1.2 }}>AIRA</Text>
            )}
            <View
              style={{
                backgroundColor: msg.role === "user" ? ACCENT : "#0d0d1a",
                borderWidth: 1,
                borderColor: msg.role === "user" ? ACCENT : "#1e1e30",
                borderRadius: 14,
                borderTopRightRadius: msg.role === "user" ? 4 : 14,
                borderTopLeftRadius: msg.role === "assistant" ? 4 : 14,
                padding: 13,
              }}
            >
              <Text style={{
                color: "#f0f0f8",
                fontSize: 14,
                lineHeight: 22,
                fontWeight: msg.role === "assistant" ? "500" : "600",
              }}>
                {msg.content}
              </Text>
            </View>
          </View>
        ))}

        {/* ── Typing indicator ──────────────────────────────────────────────── */}
        {chatLoading && (
          <View style={{ alignSelf: "flex-start", maxWidth: "85%", gap: 4 }}>
            <Text style={{ color: ACCENT, fontSize: 9, fontWeight: "900", letterSpacing: 1.2 }}>AIRA</Text>
            <View style={{
              backgroundColor: "#0d0d1a",
              borderWidth: 1,
              borderColor: "#1e1e30",
              borderRadius: 14,
              borderTopLeftRadius: 4,
              padding: 13,
            }}>
              <Text style={{ color: "#404060", fontSize: 14 }}>Coaching…</Text>
            </View>
          </View>
        )}

      </ScrollView>

      {/* ── Check-in flow ─────────────────────────────────────────────────────── */}
      {checkinActive && (
        <View style={{
          backgroundColor: "#070710",
          borderTopWidth: 1,
          borderTopColor: ACCENT + "30",
          padding: 18,
          gap: 16,
        }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: ACCENT, fontSize: 9, fontWeight: "900", letterSpacing: 1.2 }}>CHECK-IN</Text>
              <View style={{ flexDirection: "row", gap: 4 }}>
                {CHECKIN_STEPS.map((_, idx) => (
                  <View key={idx} style={{
                    width: 16,
                    height: 3,
                    borderRadius: 2,
                    backgroundColor: idx <= checkinStep ? ACCENT : "#1e1e30",
                  }} />
                ))}
              </View>
            </View>
            <Pressable
              onPress={() => setCheckinActive(false)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={{ color: "#3a3a5a", fontSize: 12, fontWeight: "700" }}>Cancel</Text>
            </Pressable>
          </View>

          <Text style={{ color: "#e8e8f4", fontSize: 16, fontWeight: "700", letterSpacing: -0.3 }}>
            {CHECKIN_STEPS[checkinStep].label}
          </Text>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {CHECKIN_STEPS[checkinStep].options.map((opt) => (
              <Pressable
                key={opt}
                onPress={() => {
                  const newData = { ...checkinData, [CHECKIN_STEPS[checkinStep].key]: opt };
                  setCheckinData(newData);
                  if (checkinStep < CHECKIN_STEPS.length - 1) {
                    setCheckinStep(checkinStep + 1);
                  } else {
                    setCheckinActive(false);
                    const summary = CHECKIN_STEPS
                      .map((s) => `${s.key}: ${newData[s.key]}`)
                      .join(", ");
                    handleAskCoach(`Check-in — ${summary}. Based on this, what should I do today? Be direct and specific.`);
                  }
                }}
                style={{
                  backgroundColor: "#0e0e1e",
                  borderWidth: 1,
                  borderColor: ACCENT + "40",
                  borderRadius: 10,
                  paddingVertical: 11,
                  paddingHorizontal: 18,
                }}
              >
                <Text style={{ color: "#c8c8e8", fontSize: 14, fontWeight: "700" }}>{opt}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* ── Quick reply pills — always visible so the user can always take action ── */}
      {!checkinActive && !chatLoading && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, borderTopWidth: 1, borderTopColor: "#111118" }}
          contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 9, gap: 7 }}
        >
          {QUICK_REPLIES.map((q) => (
            <Pressable
              key={q}
              onPress={() => handleAskCoach(q)}
              style={{
                backgroundColor: "#0a0a16",
                borderWidth: 1,
                borderColor: "#1e1e30",
                borderRadius: 20,
                paddingVertical: 7,
                paddingHorizontal: 14,
              }}
            >
              <Text style={{ color: "#8080a8", fontSize: 12, fontWeight: "700" }}>{q}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* ── Input bar ─────────────────────────────────────────────────────────── */}
      {!checkinActive && (
        <View style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 10,
          padding: 12,
          borderTopWidth: 1,
          borderTopColor: "#141420",
          backgroundColor: "#000",
        }}>
          <TextInput
            value={chatInput}
            onChangeText={setChatInput}
            onSubmitEditing={() => handleAskCoach()}
            returnKeyType="send"
            placeholder="Ask your coach…"
            placeholderTextColor="#333350"
            multiline
            style={{
              flex: 1,
              backgroundColor: "#0a0a14",
              borderWidth: 1,
              borderColor: chatInput.trim() ? "#28283e" : "#1a1a28",
              borderRadius: 14,
              paddingHorizontal: 14,
              paddingVertical: 10,
              color: "#f0f0f8",
              fontSize: 14,
              maxHeight: 100,
            }}
          />
          <Pressable
            onPress={() => handleAskCoach()}
            disabled={chatLoading || !chatInput.trim()}
            style={{
              backgroundColor: chatLoading || !chatInput.trim() ? "#0a0a14" : ACCENT,
              borderRadius: 14,
              paddingHorizontal: 18,
              paddingVertical: 12,
              justifyContent: "center",
              alignItems: "center",
              borderWidth: 1,
              borderColor: chatLoading || !chatInput.trim() ? "#1a1a28" : ACCENT,
              ...(chatInput.trim() && !chatLoading ? {
                shadowColor: ACCENT,
                shadowOpacity: 0.28,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 3 },
                elevation: 4,
              } : {}),
            }}
          >
            <Text style={{
              color: chatLoading || !chatInput.trim() ? "#2a2a40" : "#fff",
              fontWeight: "800",
              fontSize: 14,
            }}>
              Send
            </Text>
          </Pressable>
        </View>
      )}

    </KeyboardAvoidingView>
  );
}

// ---------- App ----------
export default function Index() {
  // auth
  const [authUser, setAuthUser]       = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  // Splash transition — true once the Splash fade-out animation finishes
  const [splashDone, setSplashDone]   = useState(false);
  // Minimum splash display time — prevents instant-exit on fast devices
  const [minTimePassed, setMinTimePassed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setMinTimePassed(true), 5000);
    return () => clearTimeout(t);
  }, []);

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
  const [detailTask,     setDetailTask]     = useState<TimedTask | null>(null);
  const [workoutTask,    setWorkoutTask]    = useState<TimedTask | null>(null);
  const [nutritionTask,  setNutritionTask]  = useState<TimedTask | null>(null);
  const [recoveryTask,   setRecoveryTask]   = useState<TimedTask | null>(null);
  const [habitTask,      setHabitTask]      = useState<TimedTask | null>(null);

  // profile/auth
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<TabKey>("Home");
  // "settings" or "schedule" overlays — shown in place of tab content, tab bar stays visible
  const [overlay, setOverlay] = useState<"settings" | "schedule" | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [generatedPlan, setGeneratedPlan] = useState<GeneratedDailyPlan | null>(null);

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

  // Program Brain — multi-day plan structure (foundation layer)
  const [programPlan, setProgramPlan] = useState<ProgramPlan | null>(null);

  // Current program day — single source of truth, recalculated whenever the plan changes
  const currentDayIndex = useMemo(() => {
    const idx = getCurrentProgramDayIndex(programPlan);
    if (__DEV__ && programPlan) {
      console.log(
        `[program] generatedDate=${programPlan.generatedDate}`,
        `today=${new Date().toISOString().slice(0, 10)}`,
        `dayIndex=${idx}`,
        `days available=[${programPlan.days.map((d) => d.dayIndex).join(",")}]`,
      );
    }
    return idx;
  }, [programPlan]);

  // task feedback — tracks high-priority task outcomes for the current day
  const [taskFeedback, setTaskFeedback] = useState<TaskFeedbackMap>({});

  // Task display pipeline — all three state dependencies (tasks, gamePlan, taskFeedback)
  // must be declared ABOVE this block. Babel transpiles `const` → `var`, so any state
  // referenced before its useState() line is hoisted as `undefined`, causing crashes.
  const visibleTasks    = useMemo(() => adaptTasksForPlan(tasks, gamePlan),                   [tasks, gamePlan]);
  const rebalancedTasks = useMemo(() => rebalanceTasks(visibleTasks, taskFeedback, gamePlan), [visibleTasks, taskFeedback, gamePlan]);
  const score           = useMemo(() => calcScore(rebalancedTasks),                           [rebalancedTasks]);
  // Index-level done count — needed for predictive insights without entering Today() scope
  const todayDoneCount  = useMemo(() => rebalancedTasks.filter((t) => t.done).length,         [rebalancedTasks]);

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

  // Cumulative behavior patterns — updated on every task toggle, persisted across sessions
  const [behaviorPatterns, setBehaviorPatterns] = useState<BehaviorPatterns>(emptyPatterns());

  // Transient reinforcement message shown after a task toggle (auto-clears after 3s)
  const [completionMsg, setCompletionMsg] = useState<string | null>(null);
  const completionMsgTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adaptive Day Engine — local overlay on top of the AI plan
  const [adaptedTasks,         setAdaptedTasks]         = useState<TimedTask[] | null>(null);
  const [adaptBanner,          setAdaptBanner]           = useState<AdaptResult | null>(null);
  const adaptBannerTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // In-day rebalance — silent background compression (lower priority than adaptedTasks)
  const [inDayRebalancedTasks, setInDayRebalancedTasks] = useState<TimedTask[] | null>(null);
  // System nudge — one-line message shown when the system silently adjusts the plan
  const [systemNudge,          setSystemNudge]           = useState<string | null>(null);
  const systemNudgeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Schedule-aware plan note — shown after plan generation if blocks exist
  const [schedulePlanNote, setSchedulePlanNote] = useState<string | null>(null);

  // Friction removal — inactivity nudge on Today tab
  const [showStartNudge, setShowStartNudge] = useState(false);
  const inactivityTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Command system — plan lock + auto-dismissing confirmation banner
  const [planLocked,     setPlanLocked]     = useState(false);
  const [commandBanner,  setCommandBanner]  = useState<string | null>(null);
  const commandBannerTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-Pilot: per-session flags — each condition fires at most once per session
  const [hasMiddayAdjusted,   setHasMiddayAdjusted]   = useState(false);
  const [hasWorkoutRecovered, setHasWorkoutRecovered] = useState(false);
  const [hasDayRecovered,     setHasDayRecovered]     = useState(false);

  // Save The Day — dismissed by user or auto-cleared when a task is completed
  const [saveTheDayDismissed, setSaveTheDayDismissed] = useState(false);

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

  // Load persisted data once on mount
  useEffect(() => {
    (async () => {
      try {
        const [profileRaw, blocksRaw, tasksRaw, chatRaw, motivationDateRaw, streakRaw, recoveryRaw, historyRaw, feedbackRaw, patternsRaw, programPlanRaw, generatedPlanRaw, aiPlanRaw] = await Promise.all([
          AsyncStorage.getItem(STORE.profile),
          AsyncStorage.getItem(STORE.blocks),
          AsyncStorage.getItem(STORE.tasks),
          AsyncStorage.getItem(STORE.chat),
          AsyncStorage.getItem(STORE.motivationDate),
          AsyncStorage.getItem(STORE.streak),
          AsyncStorage.getItem(STORE.recovery),
          AsyncStorage.getItem(STORE.history),
          AsyncStorage.getItem(STORE.feedback),
          AsyncStorage.getItem(STORE.patterns),
          AsyncStorage.getItem(STORE.programPlan),
          AsyncStorage.getItem(STORE.generatedPlan),
          AsyncStorage.getItem(STORE.aiPlan),
        ]);
        if (profileRaw) {
          // Normalize before storing in state — handles old flat or partial shapes
          // from AsyncStorage without crashing downstream plan generation.
          const rawParsed  = JSON.parse(profileRaw);
          const normalized = normalizeProfileForPlanning(rawParsed);
          if (normalized) {
            setProfile(normalized);
            setAuthed(true);
          } else {
            // Profile exists but is too incomplete to use — treat as unauthenticated
            console.warn("[storage] Profile loaded but missing required fields — treating as unauthenticated");
          }

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
        if (patternsRaw) setBehaviorPatterns(JSON.parse(patternsRaw) as BehaviorPatterns);
        if (programPlanRaw) setProgramPlan(JSON.parse(programPlanRaw) as ProgramPlan);
        if (aiPlanRaw) {
          // Prefer the directly-stored AIPlan from the local Aira bridge path.
          setAiPlan(JSON.parse(aiPlanRaw) as AIPlan);
        } else if (generatedPlanRaw) {
          // Backward compat: restore from old GeneratedDailyPlan format.
          const gp = JSON.parse(generatedPlanRaw) as GeneratedDailyPlan;
          setGeneratedPlan(gp);
          setAiPlan(synthesizeAIPlan(gp));
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
    exercises?: AIWorkoutExercise[];
  }): TimedTask => ({
    id:        t.id,
    timeMin:   parseTimeToMinutes(t.timeText) ?? 480, // default 8 AM if parse fails
    timeText:  t.timeText,
    title:     t.title,
    kind:      t.kind     as TaskKind,
    priority:  t.priority as TaskPriority,
    done:      t.done,
    // Carry AI exercises into the task so WorkoutDetailModal can render them
    ...(t.exercises && t.exercises.length > 0 ? { exercises: t.exercises } : {}),
  });

  /**
   * Legacy server fetch — kept for backward compatibility only.
   *
   * Since Phase 7, plan generation runs entirely through the local Aira Intelligence
   * bridge (generateLocalAiraPlan). Plans are never POSTed to the server, so this
   * GET will return 404 for all users going forward and acts as a no-op.
   *
   * Execution order at startup:
   *   1. Local AsyncStorage restore (dc:ai_plan / dc:tasks) — runs on mount.
   *   2. Supabase user data load — runs in the auth useEffect.
   *   3. THIS CALL — runs last, after both of the above.
   *
   * If the server somehow did return a plan (e.g. a manually-inserted row), it would
   * overwrite the locally-restored Aira plan. This does NOT happen in practice.
   *
   * Do not remove until the server planner route is formally deprecated.
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
  const generateAIPlan = async (
    conditionOverride?: RecoveryData,
    gamePlanOverride?: GamePlan | null,
  ) => {
    if (!authUser || !profile) return;

    // Normalize before any nested access — guards against old AsyncStorage shapes
    const safeProfile = normalizeProfileForPlanning(profile);
    if (!safeProfile) {
      console.warn("[planner] generateAIPlan: profile missing required fields (sleep times), skipping");
      setAiPlanError("Profile incomplete — please update your sleep schedule in Settings.");
      return;
    }

    const cond = conditionOverride ?? recovery;
    setAiPlanLoading(true);
    setAiPlanError(null);
    setSchedulePlanNote(null); // clear previous note while regenerating
    console.log("[planner] generateAIPlan (local intelligence) start");
    try {
      // ── Local Aira Intelligence System ──────────────────────────────────────
      // Replaces the old POST /api/planner/generate server call.
      // Synchronous + deterministic — no network I/O, no randomness.
      // NOTE: set DEV_MOCK_ENABLED = false to test this path in development.
      const { aiPlan: newAiPlan, tasks: newTasks } = generateLocalAiraPlan(safeProfile, cond ?? undefined);

      setAiPlan(newAiPlan);
      AsyncStorage.setItem(STORE.aiPlan, JSON.stringify(newAiPlan)).catch(console.warn);
      setSchedulePlanNote(getScheduleNote(blocks));
      // New local plan supersedes any local rule-based adaptation
      setAdaptedTasks(null);
      setAdaptBanner(null);
      setInDayRebalancedTasks(null);
      setSystemNudge(null);

      // Register as a single-day program; preserve forward-adjusted future days
      const today = new Date().toISOString().slice(0, 10);
      const day0: ProgramDay = { dayIndex: 0, tasks: newTasks };
      setTasks(newTasks);
      setProgramPlan((prev) => {
        const preserved = prev && prev.generatedDate === today
          ? prev.days.filter((d) => d.dayIndex !== 0)
          : [];
        return {
          generatedDate: today,
          days: [day0, ...preserved].sort((a, b) => a.dayIndex - b.dayIndex),
        };
      });

      console.log("[planner] generateAIPlan (local) success — tasks:", newTasks.length);
    } catch (err) {
      console.error("[planner] generateAIPlan (local) error:", err);
      if (err instanceof AiraIntelligenceError) {
        setAiPlanError(`Plan generation failed (${err.code}) — try again.`);
      } else {
        setAiPlanError("Plan generation failed — please try again.");
      }
    } finally {
      setAiPlanLoading(false);
    }
  };

  // Derived pattern insights — requires at least a few data points to avoid noise
  const patternInsights = useMemo(() => {
    const { kindDone, kindUndone, workoutSlots } = behaviorPatterns;

    // Preferred workout time: slot with the most completions (min 2 to be meaningful)
    const slotEntries = [
      { slot: "morning"   as const, count: workoutSlots.morning },
      { slot: "afternoon" as const, count: workoutSlots.afternoon },
      { slot: "evening"   as const, count: workoutSlots.evening },
    ];
    const topSlot = [...slotEntries].sort((a, b) => b.count - a.count)[0];
    const preferredWorkoutTime = topSlot.count >= 2 ? topSlot.slot : null;

    // Most unreliable kind: highest uncheck count (proxy for skipping), min 2
    let mostSkippedKind: TaskKind | null = null;
    let highestUndone = 1;
    for (const [k, u] of Object.entries(kindUndone) as [TaskKind, number][]) {
      if ((u ?? 0) > highestUndone) { highestUndone = u ?? 0; mostSkippedKind = k; }
    }

    const totalDone = Object.values(kindDone).reduce((s, v) => s + (v ?? 0), 0);
    const hasData = totalDone >= 3;

    return { preferredWorkoutTime, mostSkippedKind, hasData };
  }, [behaviorPatterns]);

  // ─── UserMemory — long-term intelligence derived from persisted inputs ────────
  //
  // All three inputs (history, taskFeedback, patternInsights) are already persisted,
  // so this computed value survives app restarts without its own storage entry.
  const userMemory = useMemo((): UserMemory => {
    // Consistency score: rolling 7-day average task completion rate
    const recentDays = history.slice(-7);
    const consistencyScore = recentDays.length > 0
      ? Math.round(
          recentDays.reduce((sum, d) =>
            sum + (d.tasksTotal > 0 ? d.tasksDone / d.tasksTotal : 0), 0
          ) / recentDays.length * 100
        )
      : 0;

    // Today's missed workout timeMin (used for "last missed" context)
    const missedFeedback = Object.values(taskFeedback).find(
      (e) => e.kind === "Workout" && !e.completed
    );
    const missedTask = missedFeedback
      ? tasks.find((t) => t.id === missedFeedback.taskId)
      : null;

    return {
      preferredWorkoutTime:  patternInsights.preferredWorkoutTime,
      mostSkippedCategory:   patternInsights.mostSkippedKind,
      consistencyScore,
      lastMissedWorkoutTime: missedTask?.timeMin ?? null,
    };
  }, [history, taskFeedback, tasks, patternInsights]); // eslint-disable-line react-hooks/exhaustive-deps

  // Human-readable coaching line for Today screen (null = no pattern detected yet)
  const patternCoachingLine: string | null = (() => {
    if (!patternInsights.hasData && userMemory.consistencyScore === 0) return null;
    if (patternInsights.preferredWorkoutTime)
      return `You complete workouts most consistently in the ${patternInsights.preferredWorkoutTime} — front-load today's training.`;
    if (patternInsights.mostSkippedKind === "Workout")
      return "Workouts are your most-missed task — keep the workout short and do it first.";
    if (patternInsights.mostSkippedKind === "Nutrition")
      return "Nutrition tasks often slip — simplify: prep one clean meal and build from there.";
    if (patternInsights.mostSkippedKind)
      return `${patternInsights.mostSkippedKind} tasks tend to get skipped — make today's one non-negotiable.`;
    if (userMemory.consistencyScore >= 80)
      return `You've completed ${userMemory.consistencyScore}% of tasks over the last 7 days — keep the momentum going.`;
    if (userMemory.consistencyScore > 0)
      return `Your 7-day completion rate is ${userMemory.consistencyScore}% — focus on finishing what you start today.`;
    return null;
  })();

  // Current coaching mode — single source of truth for tone across chat, UI, and banners
  const coachMode = useMemo((): CoachMode => getCoachMode({
    todayDoneCount,
    rebalancedTaskCount: rebalancedTasks.length,
    liveStreak,
    gamePlan,
    energyLevel:         recovery.energyLevel,
    adaptTrigger:        adaptBanner?.trigger ?? null,
    hasWorkoutRecovered,
    hasMiddayAdjusted,
    hasDayRecovered,
  }), [todayDoneCount, rebalancedTasks.length, liveStreak, gamePlan, recovery.energyLevel, adaptBanner, hasWorkoutRecovered, hasMiddayAdjusted, hasDayRecovered]); // eslint-disable-line react-hooks/exhaustive-deps

  // Structured hint for the planner AI (injected into the API request)
  const patternHintsForAI: string | null = (() => {
    const hints: string[] = [];
    if (patternInsights.preferredWorkoutTime === "morning")
      hints.push("User consistently completes workouts in the morning — schedule Workout tasks before noon.");
    else if (patternInsights.preferredWorkoutTime === "afternoon")
      hints.push("User tends to complete workouts in the afternoon — schedule Workout tasks between noon and 5 PM.");
    else if (patternInsights.preferredWorkoutTime === "evening")
      hints.push("User tends to complete workouts in the evening — schedule Workout tasks after 5 PM.");

    if (patternInsights.mostSkippedKind === "Workout")
      hints.push("User frequently skips Workout tasks — reduce intensity, keep the workout under 30 min, schedule it early.");
    else if (patternInsights.mostSkippedKind === "Nutrition")
      hints.push("User frequently skips Nutrition tasks — reduce to 1–2 meal tasks and keep them simple.");
    else if (patternInsights.mostSkippedKind)
      hints.push(`User frequently skips ${patternInsights.mostSkippedKind} tasks — deprioritize or simplify them.`);

    if (userMemory.consistencyScore >= 80)
      hints.push(`User has a high 7-day consistency score (${userMemory.consistencyScore}%) — full plan is appropriate.`);
    else if (userMemory.consistencyScore > 0 && userMemory.consistencyScore < 60)
      hints.push(`User has a low 7-day consistency score (${userMemory.consistencyScore}%) — keep the plan short and achievable.`);

    return hints.length > 0 ? hints.join(" ") : null;
  })();

  // Predictive insights — proactive coaching before failure happens (max 2, ordered by urgency)
  const predictiveInsights = useMemo((): PredictiveInsight[] => {
    const insights: PredictiveInsight[] = [];
    const nowHour = new Date().getHours();

    // 1. Streak protection — most urgent, time-sensitive
    if (liveStreak > 0 && todayDoneCount === 0 && nowHour >= 12 && nowHour < 21) {
      insights.push({
        key:     "streak_risk",
        label:   "STREAK PROTECTION",
        message: `Don't break your ${liveStreak}-day streak — one small win keeps it alive.`,
        action:  { label: "Get a reset nudge", trigger: "low_completion" },
      });
    }

    // 2. Skip risk — if the user's most-skipped kind has an undone task today
    if (patternInsights.hasData && patternInsights.mostSkippedKind && insights.length < 2) {
      const atRisk = rebalancedTasks.find(
        (t) => t.kind === patternInsights.mostSkippedKind && !t.done
      );
      if (atRisk) {
        const kind = patternInsights.mostSkippedKind;
        const msg  = kind === "Nutrition"
          ? "You tend to skip Nutrition tasks — let's simplify today. One clean meal counts."
          : kind === "Workout"
          ? "You tend to skip Workout tasks — address it early before the window closes."
          : `You tend to skip ${kind} tasks — tackle it first before it slips.`;
        insights.push({
          key:    "skip_risk",
          label:  "SKIP RISK",
          message: msg,
          action: kind === "Workout"
            ? { label: "Adjust workout", trigger: "missed_workout" }
            : undefined,
        });
      }
    }

    // 3. Timing optimization — workout scheduled at non-preferred time
    if (patternInsights.hasData && patternInsights.preferredWorkoutTime && insights.length < 2) {
      const workout = rebalancedTasks.find((t) => t.kind === "Workout" && !t.done);
      if (workout) {
        const scheduledSlot = workout.timeMin < 720 ? "morning"
          : workout.timeMin < 1020 ? "afternoon"
          : "evening";
        if (scheduledSlot !== patternInsights.preferredWorkoutTime) {
          insights.push({
            key:    "timing",
            label:  "TIMING",
            message: `You're more consistent with workouts in the ${patternInsights.preferredWorkoutTime} — consider moving this earlier.`,
          });
        }
      }
    }

    return insights;
  }, [patternInsights, liveStreak, todayDoneCount, rebalancedTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Real-time next best action — recomputed on task change, time change, plan adaptation, or mode change
  const nextBestAction = useMemo((): NextAction | null => {
    const now = new Date();
    return getNextBestAction({
      tasks:     rebalancedTasks,
      coachMode,
      nowMin:    now.getHours() * 60 + now.getMinutes(),
    });
  }, [rebalancedTasks, coachMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Daily win condition — what must happen for today to count as a success
  const winCondition = useMemo((): WinCondition | null => getWinCondition({
    tasks:        rebalancedTasks,
    coachMode,
    gamePlan,
    adaptTrigger: adaptBanner?.trigger ?? null,
  }), [rebalancedTasks, coachMode, gamePlan, adaptBanner]); // eslint-disable-line react-hooks/exhaustive-deps

  // End-of-day evaluation — computed live; shown after 8 PM or when all tasks are done
  const dayEvaluation = useMemo((): DayEvaluation | null => {
    const nowHour = new Date().getHours();
    const tasksDone = rebalancedTasks.filter((t) => t.done).length;
    // Only evaluate if it's evening OR the user has completed everything
    if (nowHour < 20 && tasksDone < rebalancedTasks.length) return null;
    if (!rebalancedTasks.length) return null;
    return evaluateDay({
      tasks:            rebalancedTasks,
      winCondition,
      consistencyScore: userMemory.consistencyScore,
      coachMode,
    });
  }, [rebalancedTasks, winCondition, userMemory.consistencyScore, coachMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tomorrow prep — only surfaces alongside the day evaluation
  const tomorrowPrep = useMemo((): TomorrowPrep | null => getTomorrowPrep({
    dayEvaluation,
    tasks:            rebalancedTasks,
    coachMode,
    consistencyScore: userMemory.consistencyScore,
  }), [dayEvaluation, rebalancedTasks, coachMode, userMemory.consistencyScore]); // eslint-disable-line react-hooks/exhaustive-deps

  // Weekly momentum — multi-day signal from stored history + consistency score
  const weeklyMomentum = useMemo((): WeeklyMomentum | null => getWeeklyMomentum({
    history,
    consistencyScore: userMemory.consistencyScore,
    currentStreak:    liveStreak,
  }), [history, userMemory.consistencyScore, liveStreak]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save The Day — real-time streak protection signal
  const saveTheDay = useMemo((): SaveTheDay => {
    const now = new Date();
    return getSaveTheDayAction({
      tasks:          rebalancedTasks,
      nowMin:         now.getHours() * 60 + now.getMinutes(),
      liveStreak,
      todayDoneCount,
      planLocked,
      dismissed:      saveTheDayDismissed,
    });
  }, [rebalancedTasks, liveStreak, todayDoneCount, planLocked, saveTheDayDismissed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-dismiss Save The Day when the user completes a task
  React.useEffect(() => {
    if (saveTheDayDismissed && todayDoneCount > 0) {
      setSaveTheDayDismissed(false); // reset so it can fire again if needed
    }
  }, [todayDoneCount, saveTheDayDismissed]);

  // Energy state — derived from check-in + recent miss trend
  const energyState = useMemo((): EnergyState => {
    const recentMissCount = history.slice(-3).filter(
      (d) => d.evalStatus === "MISS" || (!d.evalStatus && d.score > 0 && d.score < 40)
    ).length;
    return deriveEnergyState({
      energyLevel:     recovery.energyLevel,
      soreness:        recovery.soreness     ?? null,
      motivationLevel: recovery.motivationLevel ?? null,
      recentMissCount,
      adaptTrigger:    adaptBanner?.trigger ?? null,
    });
  }, [recovery, history, adaptBanner]); // eslint-disable-line react-hooks/exhaustive-deps

  // Energy adaptation — modifies task order/content based on energy state
  // Only applies when no manual adaptation is already active (respect user overrides)
  const energyAdaptation = useMemo((): EnergyAdaptation => {
    // Don't layer on top of an existing manual/auto-pilot adaptation
    if (adaptedTasks !== null) return { modifiedTasks: rebalancedTasks };
    if (energyState === "MEDIUM")  return { modifiedTasks: rebalancedTasks };
    return adaptPlanToEnergy(rebalancedTasks, energyState);
  }, [rebalancedTasks, energyState, adaptedTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Readiness state — start-of-day interpretation of check-in + energy signals
  const readinessState = useMemo((): ReadinessState | null => getReadinessState({
    gamePlan,
    energyState,
    energyLevel: recovery.energyLevel,
    soreness:    recovery.soreness ?? null,
  }), [gamePlan, energyState, recovery.energyLevel, recovery.soreness]); // eslint-disable-line react-hooks/exhaustive-deps

  // Program Brain — forward adjustment: apply today's outcomes to upcoming program days.
  // Fires once when dayEvaluation first appears (evening or all tasks done).
  // Uses a ref to prevent re-firing in the same session after the update is applied.
  const programAdjustFiredRef = React.useRef<string>("");
  React.useEffect(() => {
    if (!dayEvaluation) return; // evaluation not ready yet
    const todayStr = new Date().toISOString().slice(0, 10);
    if (programAdjustFiredRef.current === todayStr) return; // already adjusted today in this session
    programAdjustFiredRef.current = todayStr;

    const missedWorkoutTask       = rebalancedTasks.find((t) => t.kind === "Workout" && !t.done);
    const missedHighPriorityTasks = rebalancedTasks.filter(
      (t) => !t.done && (t.priority ?? "medium") === "high"
    );
    const signals: ProgramSignals = {
      missedWorkout:           !!missedWorkoutTask,
      missedWorkoutTask,
      missedHighPriorityTasks,
      lowEnergy:               energyState === "LOW",
      highCompletion:          dayEvaluation.status === "WIN",
      recoveryModeTriggered:   gamePlan?.readiness === "Recover" || adaptBanner?.trigger === "low_energy",
      dayMissed:               dayEvaluation.status === "MISS",
    };

    const hasAnySignal =
      signals.missedHighPriorityTasks.length > 0 ||
      signals.lowEnergy ||
      signals.dayMissed ||
      signals.recoveryModeTriggered;

    setProgramPlan((prev) => prev ? updateFutureProgramDays(prev, currentDayIndex, signals) : prev);

    // Surface a brief nudge so the user understands why tomorrow changed
    if (hasAnySignal) {
      if (signals.missedHighPriorityTasks.length > 0) {
        showSystemNudge("Carried unfinished priorities to tomorrow.");
      } else if (signals.dayMissed) {
        showSystemNudge("Simplified tomorrow to help you reset.");
      } else if (signals.lowEnergy) {
        showSystemNudge("Lightened tomorrow based on today's energy.");
      } else if (signals.recoveryModeTriggered) {
        showSystemNudge("Adjusted tomorrow for recovery.");
      }
    }
  }, [dayEvaluation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared context object — single source of truth passed into ChatScreen
  const userContext = useMemo(() => {
    const doneCount  = rebalancedTasks.filter((t) => t.done).length;
    const totalCount = rebalancedTasks.length;
    const highLeft   = rebalancedTasks.filter((t) => !t.done && (t.priority ?? "medium") === "high");
    const parts: string[] = [
      `Goal: ${profile?.goals?.goalLabel ?? "not set"}`,
      `Streak: ${liveStreak} day${liveStreak !== 1 ? "s" : ""}`,
      `Score: ${score}/100`,
      `Tasks: ${doneCount}/${totalCount} done`,
      ...(highLeft.length ? [`High-priority remaining: ${highLeft.map((t) => t.title).join(", ")}`] : []),
      ...(recovery.energyLevel ? [`Energy: ${recovery.energyLevel}`] : []),
      ...(gamePlan ? [`Readiness: ${gamePlan.readiness}, mode: ${gamePlan.timeMode}`] : []),
      ...(aiPlan?.summary ? [`Plan: ${aiPlan.summary}`] : []),
      ...(patternInsights.preferredWorkoutTime
        ? [`Preferred workout time: ${patternInsights.preferredWorkoutTime}`] : []),
      ...(patternInsights.mostSkippedKind
        ? [`Often skips: ${patternInsights.mostSkippedKind}`] : []),
      ...(userMemory.consistencyScore > 0
        ? [`Consistency: ${userMemory.consistencyScore}%`] : []),
    ];
    return parts.join(" | ");
  }, [rebalancedTasks, score, liveStreak, profile, recovery, gamePlan, aiPlan, patternInsights, userMemory]);

  // Serialised memory string passed to the chat API (and to ChatScreen as a prop)
  const memoryContext = useMemo((): string => {
    const parts: string[] = [];
    if (userMemory.preferredWorkoutTime)
      parts.push(`User is most consistent with workouts in the ${userMemory.preferredWorkoutTime}.`);
    if (userMemory.mostSkippedCategory)
      parts.push(`User often skips ${userMemory.mostSkippedCategory} tasks.`);
    if (userMemory.consistencyScore > 0)
      parts.push(`Consistency score: ${userMemory.consistencyScore}% (7-day rolling average).`);
    return parts.join(" ");
  }, [userMemory]);

  // Adaptive Day Engine — apply a rule-based adaptation to the current task list
  const triggerAdaptation = React.useCallback((trigger: AdaptTrigger) => {
    const source = adaptedTasks ?? rebalancedTasks; // layer on top of any existing adaptation
    const result = adaptTodayPlan(source, trigger);
    if (trigger !== "low_completion") setAdaptedTasks(result.tasks);
    if (adaptBannerTimerRef.current) clearTimeout(adaptBannerTimerRef.current);
    setAdaptBanner(result);
    // Low-completion message auto-clears; others persist until dismissed or plan reloads
    if (trigger === "low_completion") {
      adaptBannerTimerRef.current = setTimeout(() => setAdaptBanner(null), 6000);
    }
  }, [adaptedTasks, rebalancedTasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-dismiss banner — surfaces after any command triggers, clears after 3.5s
  const showCommandBanner = React.useCallback((msg: string) => {
    if (commandBannerTimerRef.current) clearTimeout(commandBannerTimerRef.current);
    setCommandBanner(msg);
    commandBannerTimerRef.current = setTimeout(() => setCommandBanner(null), 3500);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const nudgeFadeAnim = React.useRef(new Animated.Value(0)).current;

  // Fade nudge in when it appears, let state removal handle hiding
  useEffect(() => {
    if (systemNudge !== null) {
      nudgeFadeAnim.setValue(0);
      Animated.timing(nudgeFadeAnim, { toValue: 1, duration: 280, useNativeDriver: true }).start();
    }
  }, [systemNudge]); // eslint-disable-line react-hooks/exhaustive-deps

  // System nudge — shown when the system silently adjusts the plan, auto-dismisses after 5s
  const showSystemNudge = React.useCallback((msg: string) => {
    if (systemNudgeTimerRef.current) clearTimeout(systemNudgeTimerRef.current);
    setSystemNudge(msg);
    systemNudgeTimerRef.current = setTimeout(() => setSystemNudge(null), 5000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Chat → plan action bridge — handles both legacy strings and CommandType values
  const handlePlanAction = (action: string) => {
    // When plan is locked, only LOCK_PLAN itself can unlock
    if (planLocked && action !== "LOCK_PLAN") {
      showCommandBanner("Plan is locked — unlock it first.");
      setTab("Home");
      return;
    }

    switch (action) {
      case "LESS_TIME":
      case "less_time": {
        triggerAdaptation("less_time");
        showCommandBanner("Plan adjusted for limited time.");
        const override: RecoveryData = { ...recovery, timeAvailable: "minimal" };
        const newGp = generateGamePlan(override);
        setRecovery(override);
        setGamePlan(newGp);
        generateAIPlan(override, newGp); // deeper AI adaptation in background
        break;
      }
      case "MISSED_WORKOUT":
      case "missed_workout": {
        triggerAdaptation("missed_workout");
        showCommandBanner("Workout re-prioritized.");
        break;
      }
      case "LOW_ENERGY": {
        triggerAdaptation("low_energy");
        showCommandBanner("Low energy mode activated.");
        break;
      }
      case "SHIFT_LATER": {
        triggerAdaptation("shift_later");
        showCommandBanner("Plan shifted later.");
        break;
      }
      case "LOCK_PLAN": {
        setPlanLocked((prev) => {
          const next = !prev;
          showCommandBanner(next ? "Plan locked in — no adjustments." : "Plan unlocked.");
          return next;
        });
        setTab("Home");
        return; // early return — setTab already called
      }
      case "adjust":
      default: {
        generateAIPlan();
        showCommandBanner("Rebuilding your plan…");
        break;
      }
    }

    setTab("Home");
  };

  /**
   * Legacy server task sync — kept for backward compatibility only.
   *
   * Since Phase 7, tasks are generated locally by the Aira bridge. Task IDs follow
   * the deterministic format `{engine}-{kind}-{index}` (e.g. "planner-workout-0").
   * The server has no record of these IDs, so the PATCH will fail with 404 or 500
   * and is caught silently. The local optimistic update (done in toggleTaskById
   * before this runs) is the real source of truth — dc:tasks auto-saves the result.
   *
   * Do not remove until the server planner route is formally deprecated.
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

  // Startup sequence — runs once when auth is ready and local AsyncStorage has loaded.
  //
  // Order of operations (all three steps complete before the spinner clears):
  //   1. Local AsyncStorage restore (mount useEffect) — dc:ai_plan, dc:tasks, dc:profile,
  //      etc. are read and set into state before this effect ever fires.
  //   2. Supabase user data (Step 1 below) — profile, blocks, streak, manual tasks
  //      fetched from the server and merged into state.
  //   3. fetchTodayAIPlan (Step 2 below) — legacy server fetch. Returns 404 for all
  //      Aira-generated plans and acts as a no-op. Does NOT override the Aira plan
  //      restored in step 1 in practice. See fetchTodayAIPlan comment for details.
  //
  // The loading spinner covers steps 2 + 3 so users never see an empty-state flash.
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

      // Step 2 — Legacy server plan fetch. 404 no-op for all Aira-generated plans.
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
    if (authUser) getAccessToken().then((t) => { if (t) saveUserData(authUser.id, t, { profile }); }).catch(console.warn);
  }, [profile, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save blocks whenever they change (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.blocks, JSON.stringify(blocks)).catch(console.warn);
    if (authUser) getAccessToken().then((t) => { if (t) saveUserData(authUser.id, t, { blocks }); }).catch(console.warn);
  }, [blocks, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save tasks whenever they change (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.tasks, JSON.stringify(tasks)).catch(console.warn);
    if (authUser) getAccessToken().then((t) => { if (t) saveUserData(authUser.id, t, { tasks }); }).catch(console.warn);
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
    if (authUser) getAccessToken().then((t) => { if (t) saveUserData(authUser.id, t, { streak }); }).catch(console.warn);
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

  // Save behavior patterns whenever they change (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.patterns, JSON.stringify(behaviorPatterns)).catch(console.warn);
  }, [behaviorPatterns, loaded]);

  // Save programPlan whenever it changes (after initial load)
  useEffect(() => {
    if (!loaded || !programPlan) return;
    AsyncStorage.setItem(STORE.programPlan, JSON.stringify(programPlan)).catch(console.warn);
  }, [programPlan, loaded]);

  // Upsert today's score + evaluation status into history whenever score or evaluation changes
  useEffect(() => {
    if (!loaded) return;
    const todayStr = new Date().toISOString().slice(0, 10);
    if (historyLastScoreRef.current === score && historyLastDateRef.current === todayStr) return;
    historyLastScoreRef.current = score;
    historyLastDateRef.current  = todayStr;
    setHistory((prev) => {
      const without = prev.filter((d) => d.date !== todayStr);
      const entry: DayLog = {
        date: todayStr,
        score,
        tasksTotal: tasks.length,
        tasksDone:  tasks.filter((t) => t.done).length,
        ...(dayEvaluation ? { evalStatus: dayEvaluation.status } : {}),
      };
      return [...without, entry]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-30);
    });
  }, [score, dayEvaluation, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save history whenever it changes (after initial load)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORE.history, JSON.stringify(history)).catch(console.warn);
  }, [history, loaded]);

  // Inactivity nudge — show "Start here" after 12s of no completions on Today tab
  useEffect(() => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    if (tab === "Home" && overlay === null && todayDoneCount === 0 && rebalancedTasks.length > 0) {
      inactivityTimerRef.current = setTimeout(() => setShowStartNudge(true), 12000);
    } else {
      setShowStartNudge(false);
    }
    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, [tab, todayDoneCount, rebalancedTasks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Auto-Pilot: proactive adaptation ────────────────────────────────────────
  //
  // Evaluates three trigger conditions whenever the Today tab is active.
  // At most one trigger fires per evaluation; each flag ensures it fires once per session.
  // The interval re-checks every 2 min so conditions are caught even without user interaction.
  //
  // Fires at most once per flag, in priority order: MIDDAY → WORKOUT → DAY_RECOVERY.
  useEffect(() => {
    if (tab !== "Home" || planLocked || !loaded) return;

    const evaluate = () => {
      // Latest snapshot — read inside evaluate() to avoid stale closure issues
      // (the effect re-runs when any dep changes, so deps are fresh on each run)
      const source    = adaptedTasks ?? rebalancedTasks;
      const doneCount = source.filter((t) => t.done).length;
      if (!source.length) return;

      const nowHour = new Date().getHours();
      const nowMin  = nowHour * 60 + new Date().getMinutes();

      // IN-DAY REBALANCE — silent background compression; runs on every evaluate() tick.
      // Operates on base rebalancedTasks (not adaptedTasks) so it doesn't layer on top
      // of an explicit big-adaptation. adaptedTasks takes priority in effectiveTasks.
      if (!adaptedTasks) {
        const inDay = rebalanceCurrentDay(rebalancedTasks, doneCount, nowMin);
        setInDayRebalancedTasks(inDay); // null clears a previous compression
      }

      // 1. MIDDAY_ADJUST — no completions after noon
      if (!hasMiddayAdjusted && doneCount === 0 && nowHour >= 12) {
        setHasMiddayAdjusted(true);
        const result = adaptTodayPlan(source, "less_time");
        setAdaptedTasks(result.tasks);
        setAdaptBanner(result);
        showCommandBanner(AUTO_PILOT_BANNERS.MIDDAY_ADJUST[coachMode]);
        setMessages((prev) =>
          prev.length === 0 ? prev : [...prev, {
            role: "assistant" as const,
            content: coachMode === "PUSH"
              ? "You haven't started. I've cut the plan to essentials — pick one and go now."
              : "Let's refocus — I've adjusted your plan so you can still win today. What's the one thing you can execute right now?",
          }]
        );
        return;
      }

      // 2. MISSED_WORKOUT_AUTO — workout is 90+ min past its scheduled slot
      if (!hasWorkoutRecovered) {
        const workout = source.find((t) => t.kind === "Workout" && !t.done);
        if (workout && nowMin > workout.timeMin + 90) {
          setHasWorkoutRecovered(true);
          const result = adaptTodayPlan(source, "missed_workout");
          setAdaptedTasks(result.tasks);
          setAdaptBanner(result);
          showCommandBanner(AUTO_PILOT_BANNERS.MISSED_WORKOUT_AUTO[coachMode]);
          setMessages((prev) =>
            prev.length === 0 ? prev : [...prev, {
              role: "assistant" as const,
              content: coachMode === "PUSH"
                ? "Workout window is gone. I've re-prioritized it — 20 minutes, right now. No more waiting."
                : "Your workout window passed — I've moved it up. A 20-minute session still counts. Go when you're ready.",
            }]
          );
          return;
        }
      }

      // 3. DAY_RECOVERY — 3+ tasks undone after 6 PM
      if (!hasDayRecovered && nowHour >= 18) {
        const undone = source.filter((t) => !t.done);
        if (undone.length >= 3) {
          setHasDayRecovered(true);
          const result = adaptTodayPlan(source, "less_time");
          setAdaptedTasks(result.tasks);
          setAdaptBanner(result);
          showCommandBanner(AUTO_PILOT_BANNERS.DAY_RECOVERY[coachMode]);
          setMessages((prev) =>
            prev.length === 0 ? prev : [...prev, {
              role: "assistant" as const,
              content: coachMode === "PUSH"
                ? "Evening. Three tasks still open. I've stripped the plan — hit the essentials and close the day."
                : "Evening check-in — I've simplified the plan. Hit the essentials and close the day strong.",
            }]
          );
        }
      }
    };

    evaluate(); // immediate check when deps change
    const id = setInterval(evaluate, 2 * 60_000); // re-check every 2 min
    return () => clearInterval(id);
  }, [tab, todayDoneCount, rebalancedTasks, adaptedTasks, planLocked, loaded, coachMode, hasMiddayAdjusted, hasWorkoutRecovered, hasDayRecovered]); // eslint-disable-line react-hooks/exhaustive-deps

  // System nudge — fire once when in-day rebalance activates (null → non-null transition)
  const prevInDayRebalancedRef = React.useRef<TimedTask[] | null>(null);
  useEffect(() => {
    if (inDayRebalancedTasks !== null && prevInDayRebalancedRef.current === null) {
      showSystemNudge("Refocused your day on what matters most.");
    }
    prevInDayRebalancedRef.current = inDayRebalancedTasks;
  }, [inDayRebalancedTasks]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const wakeMin  = parseTimeToMinutes(p.sleep.wakeTime);
    const sleepMin = parseTimeToMinutes(p.sleep.sleepTime);

    if (wakeMin == null || sleepMin == null) {
      Alert.alert("Time format issue", "Enter wake/sleep like '7:00 AM' or '23:00'.");
      return;
    }

    const duration = sleepDurationMins(p.sleep.sleepTime, p.sleep.wakeTime);
    if (duration == null || duration < 60) {
      Alert.alert("Sleep time issue", "Sleep window must be at least 1 hour.");
      return;
    }

    // Pass overnight-adjusted sleepMin so buildTodaysPlan gets a positive dayLen
    const adjustedSleepMin = sleepMin <= wakeMin ? sleepMin + 1440 : sleepMin;
    const plan = buildTodaysPlan({ wakeMin, sleepMin: adjustedSleepMin, blocks: schedule, profile: p });
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
  // Keep Splash mounted until its own fade-out completes — no hard cut.
  // `ready` signals the Splash to start its exit animation; `onFinish` unmounts it.
  if (!splashDone) {
    return (
      <Splash
        ready={authChecked && loaded && minTimePassed}
        onFinish={() => setSplashDone(true)}
      />
    );
  }

  // No session → show sign in / sign up.
  if (!authUser) return <AuthScreen onSuccess={setAuthUser} />;

  // ---------- Onboarding ----------
  if (!authed) {
    return (
      <OnboardingFlow
        onComplete={(result) => {
          setProfile(result);
          setAuthed(true);
          setTab("Home");
          // Use the same Aira Intelligence bridge as generateAIPlan (regeneration path).
          // Onboarding profile is always fully-formed — no normalisation needed, but
          // normalizeProfileForPlanning guards against edge cases in old stored shapes.
          const safeResult = normalizeProfileForPlanning(result) ?? result;
          try {
            const { aiPlan: newAiPlan, tasks: newTasks } = generateLocalAiraPlan(safeResult);
            setAiPlan(newAiPlan);
            setTasks(newTasks);
            scheduleFromTasks(newTasks);
            AsyncStorage.setItem(STORE.aiPlan, JSON.stringify(newAiPlan)).catch(console.warn);
            // programPlan and tasks auto-persist via their useEffect watchers
            const today = new Date().toISOString().slice(0, 10);
            setProgramPlan({ generatedDate: today, days: [{ dayIndex: 0, tasks: newTasks }] });
            console.log("[onboarding] generateLocalAiraPlan success — tasks:", newTasks.length);
          } catch (err) {
            console.error("[onboarding] generateLocalAiraPlan error:", err);
            // Fallback: rule-based plan so Today screen is not empty after onboarding
            generatePlanFromProfileAndSchedule(result, []);
            const gp = generateDailyPlan(safeResult);
            setGeneratedPlan(gp);
            setAiPlan(synthesizeAIPlan(gp));
            AsyncStorage.setItem(STORE.generatedPlan, JSON.stringify(gp)).catch(console.warn);
          }
        }}
      />
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

      // Dismiss inactivity nudge on first interaction
      if (showStartNudge) setShowStartNudge(false);

      // Streak reinforcement message — shown briefly after each toggle
      if (completionMsgTimerRef.current) clearTimeout(completionMsgTimerRef.current);
      if (willBeCompleted) {
        const prevDone = tasks.filter((t) => t.done).length;
        const newDone  = prevDone + 1;
        const total    = tasks.length;
        let msg: string;
        if (newDone === total) {
          msg = "You showed up today. This is who you are.";
        } else if (newDone === 1 && liveStreak > 0) {
          msg = "Streak alive.";
        } else if (newDone === 1) {
          msg = "This is what disciplined people do.";
        } else if (newDone === 2) {
          msg = liveStreak >= 5 ? "You're becoming consistent." : "You're building momentum.";
        } else if (newDone === 3) {
          msg = "This is part of your identity now.";
        } else {
          msg = "This is how streaks are built.";
        }
        setCompletionMsg(msg);
        completionMsgTimerRef.current = setTimeout(() => setCompletionMsg(null), 3500);
      } else {
        setCompletionMsg(null);
      }

      // Update cumulative behavior patterns for every task (not just high-priority)
      if (task) {
        const slot = task.timeMin < 720 ? "morning" : task.timeMin < 1020 ? "afternoon" : "evening";
        setBehaviorPatterns((prev) => {
          const kindDone    = { ...prev.kindDone };
          const kindUndone  = { ...prev.kindUndone };
          const workoutSlots = { ...prev.workoutSlots };
          if (willBeCompleted) {
            kindDone[task.kind] = (kindDone[task.kind] ?? 0) + 1;
            if (task.kind === "Workout") workoutSlots[slot]++;
          } else {
            kindUndone[task.kind] = (kindUndone[task.kind] ?? 0) + 1;
            if (task.kind === "Workout") workoutSlots[slot] = Math.max(0, (workoutSlots[slot] ?? 0) - 1);
          }
          return { kindDone, kindUndone, workoutSlots };
        });
      }

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
    // Task priority: mock > manual adaptation > in-day rebalance > energy adaptation > base rebalanced
    const effectiveTasks = isMockActive ? DEV_MOCK_TASKS : (adaptedTasks ?? inDayRebalancedTasks ?? energyAdaptation.modifiedTasks);
    const effectiveScore = isMockActive ? calcScore(DEV_MOCK_TASKS) : score;

    const doneCount    = effectiveTasks.filter((t) => t.done).length;
    const totalCount   = effectiveTasks.length;
    const allDone      = totalCount > 0 && doneCount === totalCount;
    const nextTaskId   = effectiveTasks.find((t) => !t.done)?.id ?? null;
    const dateStr    = new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });

    // ── Loading — skeleton cards instead of spinner ────────────────────────────
    if (aiPlanLoading) {
      return (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
          scrollEnabled={false}
        >
          {/* Header skeleton */}
          <View style={{ paddingBottom: 24 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ gap: 6 }}>
                <Text style={{ color: "#ffffff", fontSize: 28, fontWeight: "700", letterSpacing: -0.5 }}>Today</Text>
                <View style={{ height: 10, width: 160, borderRadius: 5, backgroundColor: "rgba(255,255,255,0.04)" }} />
              </View>
              <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: "#0c0c18", borderWidth: 1, borderColor: "#1c1c2e" }} />
            </View>
          </View>
          {/* Score ring skeleton */}
          <View style={{ alignItems: "center", marginBottom: 28 }}>
            <View style={{
              width: 140, height: 140, borderRadius: 70,
              borderWidth: 10, borderColor: "rgba(255,255,255,0.04)",
              alignItems: "center", justifyContent: "center",
            }}>
              <View style={{ height: 36, width: 56, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.05)" }} />
            </View>
          </View>
          {/* Today's focus skeleton */}
          <SkeletonCard height={66} radius={16} />
          <View style={{ marginBottom: 16 }} />
          {/* Task row skeletons */}
          <View style={{ marginBottom: 4 }}>
            <View style={{ height: 10, width: 80, borderRadius: 5, backgroundColor: "rgba(255,255,255,0.04)", marginBottom: 12 }} />
            <SkeletonTaskRow />
            <SkeletonTaskRow />
            <SkeletonTaskRow />
            <SkeletonTaskRow />
          </View>
          {/* Building label — subtle, at the bottom */}
          <View style={{ alignItems: "center", marginTop: 16, gap: 4 }}>
            <Text style={{ color: "#282840", fontSize: 11, fontWeight: "600", letterSpacing: 0.4 }}>Building your plan…</Text>
          </View>
        </ScrollView>
      );
    }

    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      >

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <View style={{ paddingBottom: 24 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ gap: 3 }}>
              <Text style={{ color: "#ffffff", fontSize: 28, fontWeight: "700", letterSpacing: -0.5 }}>Today</Text>
              <Text style={{ color: "#34344a", fontSize: 11, fontWeight: "500", letterSpacing: 0.3 }}>
                {dateStr}{profile?.profile?.firstName ? `  ·  ${new Date().getHours() < 12 ? "Morning" : new Date().getHours() < 17 ? "Afternoon" : "Evening"}, ${profile.profile?.firstName}` : ""}
              </Text>
            </View>
            <Pressable onPress={() => setOverlay("settings")} style={{ padding: 8, marginRight: -4 }}>
              <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: "#0c0c18", borderWidth: 1, borderColor: "#1c1c2e", alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: "#404058", fontSize: 14 }}>⊕</Text>
              </View>
            </Pressable>
          </View>
          {isMockActive && (
            <View style={{ marginTop: 10, backgroundColor: "#1a1000", borderWidth: 1, borderColor: "#3a2800", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, alignSelf: "flex-start" }}>
              <Text style={{ color: "#8a6400", fontSize: 10, fontWeight: "800", letterSpacing: 0.8 }}>DEV · MOCK DATA</Text>
            </View>
          )}
        </View>

        {/* ── Command banner — auto-dismisses after 3.5s ─────────────────────── */}
        {commandBanner && (
          <View style={{
            backgroundColor: "#060610",
            borderWidth: 1,
            borderColor: planLocked ? ACCENT + "60" : "#2a2a50",
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 10,
            marginBottom: 10,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
          }}>
            <View style={{
              width: 6, height: 6, borderRadius: 3,
              backgroundColor: planLocked ? ACCENT : ACCENT + "80",
              shadowColor: ACCENT, shadowOpacity: planLocked ? 0.5 : 0.2,
              shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
            }} />
            <Text style={{ flex: 1, color: "#9898c8", fontSize: 12, fontWeight: "700", lineHeight: 17 }}>
              {commandBanner}
            </Text>
            {planLocked && (
              <View style={{ backgroundColor: ACCENT + "18", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ color: ACCENT + "cc", fontSize: 9, fontWeight: "900", letterSpacing: 0.8 }}>LOCKED</Text>
              </View>
            )}
          </View>
        )}

        {/* ── Plan locked indicator (persistent when no command banner) ─────── */}
        {planLocked && !commandBanner && (
          <Pressable
            onPress={() => handlePlanAction("LOCK_PLAN")}
            style={{
              backgroundColor: "#07070f",
              borderWidth: 1,
              borderColor: ACCENT + "35",
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 8,
              marginBottom: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: ACCENT + "60" }} />
            <Text style={{ flex: 1, color: "#6060a0", fontSize: 11, fontWeight: "700" }}>Plan locked — tap to unlock</Text>
            <Text style={{ color: ACCENT + "50", fontSize: 10, fontWeight: "900", letterSpacing: 0.6 }}>LOCKED</Text>
          </Pressable>
        )}

        {/* ── Energy adaptation notice — shown when plan was silently modified ── */}
        {energyAdaptation.message && adaptedTasks === null && !commandBanner && !adaptBanner && (
          <View style={{
            backgroundColor: energyState === "HIGH" ? "#06100a" : "#100a06",
            borderWidth: 1,
            borderColor: energyState === "HIGH" ? "#4CAF5030" : "#FF980030",
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 10,
            marginBottom: 10,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
          }}>
            <Text style={{ fontSize: 12, lineHeight: 1 }}>
              {energyState === "HIGH" ? "⚡" : "↓"}
            </Text>
            <Text style={{
              flex: 1,
              color: energyState === "HIGH" ? "#4CAF5099" : "#FF980099",
              fontSize: 12,
              fontWeight: "700",
              lineHeight: 17,
            }}>
              {energyAdaptation.message}
            </Text>
          </View>
        )}

        {/* ── System nudge — subtle one-line signal when plan silently adjusts ── */}
        {systemNudge && !adaptBanner && !commandBanner && !(energyAdaptation.message && adaptedTasks === null) && (
          <Animated.View style={{ opacity: nudgeFadeAnim, marginBottom: 10 }}>
            <Pressable
              onPress={() => setSystemNudge(null)}
              style={{
                backgroundColor: "#08080f",
                borderWidth: 1,
                borderColor: "#2a2a50",
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 9,
                flexDirection: "row",
                alignItems: "center",
                gap: 9,
              }}
            >
              <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: "#5050a0" }} />
              <Text style={{ flex: 1, color: "#6868a8", fontSize: 12, fontWeight: "600", lineHeight: 17 }}>
                {systemNudge}
              </Text>
              <Text style={{ color: "#303050", fontSize: 11, fontWeight: "700" }}>✕</Text>
            </Pressable>
          </Animated.View>
        )}

        {/* ── Adaptive Day Engine banner ──────────────────────────────────────── */}
        {adaptBanner && (
          <Pressable
            onPress={() => {
              setAdaptBanner(null);
              if (adaptBanner.trigger !== "low_completion") setAdaptedTasks(null);
            }}
            style={{
              backgroundColor: "#09091a",
              borderWidth: 1,
              borderColor: ACCENT + "45",
              borderRadius: 14,
              paddingHorizontal: 16,
              paddingVertical: 12,
              marginBottom: 14,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              shadowColor: ACCENT,
              shadowOpacity: 0.2,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 4 },
              elevation: 5,
            }}
          >
            <View style={{
              width: 6, height: 6, borderRadius: 3,
              backgroundColor: ACCENT,
              shadowColor: ACCENT, shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
            }} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ color: ACCENT + "cc", fontSize: 9, fontWeight: "900", letterSpacing: 1.4 }}>PLAN ADJUSTED</Text>
              <Text style={{ color: "#9898c0", fontSize: 12, fontWeight: "600", lineHeight: 18 }}>
                {adaptBanner.message}
              </Text>
            </View>
            <Text style={{ color: "#404060", fontSize: 12, fontWeight: "700" }}>✕</Text>
          </Pressable>
        )}

        {/* ── SAVE YOUR DAY — streak protection banner ────────────────────────── */}
        {saveTheDay.trigger && (
          <Pressable
            onPress={() => {
              // Tapping navigates to the task's detail modal
              if (saveTheDay.taskId) {
                const task = effectiveTasks.find((t) => t.id === saveTheDay.taskId);
                if (task) {
                  if (task.kind === "Workout")        setWorkoutTask(task);
                  else if (task.kind === "Nutrition") setNutritionTask(task);
                  else if (task.kind === "Recovery")  setRecoveryTask(task);
                  else if (task.kind === "Habit")     setHabitTask(task);
                  else                                setDetailTask(task);
                }
              }
            }}
            style={({ pressed }) => ({
              backgroundColor: pressed ? "#100810" : "#0c0610",
              borderWidth: 1.5,
              borderColor: "#FF525260",
              borderRadius: 16,
              padding: 18,
              marginBottom: 14,
              gap: 8,
              shadowColor: "#FF5252",
              shadowOpacity: pressed ? 0.1 : 0.28,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 5 },
              elevation: 7,
            })}
          >
            {/* Header */}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                <View style={{
                  width: 7, height: 7, borderRadius: 3.5,
                  backgroundColor: "#FF5252",
                  shadowColor: "#FF5252", shadowOpacity: 0.7, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
                }} />
                <Text style={{ color: "#FF5252cc", fontSize: 9, fontWeight: "900", letterSpacing: 1.8 }}>SAVE YOUR DAY</Text>
              </View>
              <Pressable
                onPress={(e) => { e.stopPropagation(); setSaveTheDayDismissed(true); }}
                hitSlop={10}
              >
                <Text style={{ color: "#404058", fontSize: 14, fontWeight: "700" }}>✕</Text>
              </Pressable>
            </View>

            {/* Action — the one thing to do */}
            <Text style={{
              color:       "#f0d0d0",
              fontSize:    16,
              fontWeight:  "800",
              lineHeight:  23,
              letterSpacing: -0.3,
            }}>
              {saveTheDay.action}
            </Text>

            {/* Reason */}
            <Text style={{
              color:      "#805858",
              fontSize:   12,
              fontWeight: "600",
              lineHeight: 18,
            }}>
              {saveTheDay.reason}
            </Text>
          </Pressable>
        )}

        {/* ── Score ring ──────────────────────────────────────────────────────── */}
        <View style={{
          alignItems: "center",
          paddingTop: 32, paddingBottom: 44,
          marginHorizontal: -16, paddingHorizontal: 16,
          backgroundColor: "#03030a",
        }}>
          <CircularProgressRing score={effectiveScore} />

          {/* Streak row */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 20 }}>
            {liveStreak > 0 ? (
              <>
                <Text style={{ fontSize: 13 }}>🔥</Text>
                <Text style={{ color: "#d0d0e8", fontSize: 13, fontWeight: "600", letterSpacing: -0.1 }}>
                  Locked In · Day {liveStreak}
                </Text>
              </>
            ) : (
              <Text style={{ color: "#2e2e48", fontSize: 12, fontWeight: "500", letterSpacing: 0.3 }}>
                Start your streak today
              </Text>
            )}
          </View>

          {/* Task progress subtext */}
          <Text style={{ color: "#2a2a44", fontSize: 11, fontWeight: "500", marginTop: 6, letterSpacing: 0.3 }}>
            {totalCount > 0
              ? allDone
                ? `${totalCount}/${totalCount} complete ✓`
                : `${doneCount} of ${totalCount} tasks done`
              : "No plan yet — tap check-in to begin"}
          </Text>

          {/* Streak reinforcement message — appears briefly after task toggle */}
          {completionMsg && (
            <Text style={{
              color:         completionMsg.startsWith("You showed up") ? "#66bb6a" : "#7B61FF",
              fontSize:      12,
              fontWeight:    "700",
              marginTop:     10,
              letterSpacing: 0.2,
              textShadowColor:  completionMsg.startsWith("You showed up") ? "#66bb6a44" : "#7B61FF44",
              textShadowRadius: 8,
              textShadowOffset: { width: 0, height: 0 },
            }}>
              {completionMsg}
            </Text>
          )}
        </View>

        {/* ── Streak risk banner — shows late in the day if streak is endangered ── */}
        {liveStreak > 0 && doneCount === 0 && new Date().getHours() >= 19 && (
          <View style={{
            backgroundColor: "#0d0608",
            borderWidth: 1,
            borderColor: "#ff4d4d30",
            borderRadius: 14,
            paddingHorizontal: 16,
            paddingVertical: 12,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
          }}>
            <View style={{
              width: 6, height: 6, borderRadius: 3,
              backgroundColor: "#ff4d4d",
              shadowColor: "#ff4d4d", shadowOpacity: 0.6, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
            }} />
            <Text style={{ color: "#cc5555", fontSize: 12, fontWeight: "700", flex: 1 }}>
              Your streak is at risk — get one task done.
            </Text>
          </View>
        )}

        {/* ── Adaptive triggers — passive suggestions (user taps to activate) ─── */}
        {/* Low completion at midday */}
        {totalCount > 0 && doneCount === 0 && new Date().getHours() >= 12 && !allDone && !adaptBanner && (
          <Pressable
            onPress={() => triggerAdaptation("low_completion")}
            style={{
              backgroundColor: "#09090f",
              borderWidth: 1,
              borderColor: "#2a2a3e",
              borderRadius: 14,
              paddingHorizontal: 16,
              paddingVertical: 13,
              marginBottom: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
            }}
          >
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ color: "#606080", fontSize: 9, fontWeight: "900", letterSpacing: 1.4 }}>MIDDAY CHECK</Text>
              <Text style={{ color: "#7878a0", fontSize: 12, fontWeight: "600" }}>Nothing done yet — tap to get a reset nudge.</Text>
            </View>
            <Text style={{ color: "#404060", fontSize: 10, fontWeight: "700" }}>→</Text>
          </Pressable>
        )}

        {/* Missed workout window */}
        {(() => {
          const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
          const missedWorkout = effectiveTasks.find(
            (t) => t.kind === "Workout" && !t.done && t.timeMin + 90 < nowMin
          );
          if (!missedWorkout || adaptBanner?.trigger === "missed_workout") return null;
          return (
            <Pressable
              onPress={() => triggerAdaptation("missed_workout")}
              style={{
                backgroundColor: "#09090f",
                borderWidth: 1,
                borderColor: "#2a2a3e",
                borderRadius: 14,
                paddingHorizontal: 16,
                paddingVertical: 13,
                marginBottom: 10,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
              }}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: "#606080", fontSize: 9, fontWeight: "900", letterSpacing: 1.4 }}>WORKOUT WINDOW PASSED</Text>
                <Text style={{ color: "#7878a0", fontSize: 12, fontWeight: "600" }}>Tap to move it up — 30 min still counts.</Text>
              </View>
              <Text style={{ color: "#404060", fontSize: 10, fontWeight: "700" }}>→</Text>
            </Pressable>
          );
        })()}

        {/* ── End-of-day identity card — shown when all tasks complete ──────────── */}
        {allDone && totalCount > 0 && (
          <View style={{
            backgroundColor: "#060e08",
            borderWidth: 1,
            borderColor: "#66bb6a40",
            borderRadius: 18,
            paddingHorizontal: 22,
            paddingVertical: 20,
            gap: 10,
            shadowColor: "#66bb6a",
            shadowOpacity: 0.22,
            shadowRadius: 28,
            shadowOffset: { width: 0, height: 4 },
            elevation: 6,
          }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
              <View style={{
                width: 6, height: 6, borderRadius: 3,
                backgroundColor: "#66bb6a",
                shadowColor: "#66bb6a", shadowOpacity: 0.6, shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
              }} />
              <Text style={{ color: "#66bb6acc", fontSize: 9, fontWeight: "900", letterSpacing: 1.8 }}>
                DAY COMPLETE
              </Text>
            </View>
            <Text style={{ color: "#a8e8a8", fontSize: 16, fontWeight: "800", lineHeight: 23, letterSpacing: -0.3 }}>
              You showed up today.
            </Text>
            <Text style={{ color: "#3d6640", fontSize: 12, fontWeight: "600", lineHeight: 18 }}>
              {getIdentityLabel(liveStreak).label} · Stay consistent. Show up tomorrow.
            </Text>
          </View>
        )}

        {/* ── Schedule context note — shown when plan was built around real blocks ── */}
        {schedulePlanNote && aiPlan && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: "#3a3a58" }} />
            <Text style={{ color: "#3a3a58", fontSize: 11, fontWeight: "600", letterSpacing: 0.2 }}>
              {schedulePlanNote}
            </Text>
          </View>
        )}

        {/* ── Game Plan strip ─────────────────────────────────────────────────── */}
        {gamePlan ? (
          <Pressable
            onPress={() => setShowMotivation(true)}
            style={({ pressed }) => ({
              overflow: "hidden",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.07)",
              borderRadius: 16,
              marginBottom: 16,
              shadowColor: gamePlan.color,
              shadowOpacity: 0.08,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 4 },
              elevation: 4,
              opacity:   pressed ? 0.88 : 1,
              transform: [{ scale: pressed ? 0.988 : 1 }],
            })}
          >
            <View style={{ padding: 16, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(255,255,255,0.03)" }}>
            <View style={{ flex: 1, gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={{ color: "#2e2e48", fontSize: 9, fontWeight: "900", letterSpacing: 1.4 }}>
                  GAME PLAN
                </Text>
                <View style={{ backgroundColor: gamePlan.color + "18", borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ color: gamePlan.color + "dd", fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>
                    {gamePlan.readiness.toUpperCase()}
                  </Text>
                </View>
              </View>
              <Text style={{ color: "#b0b0cc", fontSize: 13, lineHeight: 21, fontWeight: "500", letterSpacing: 0 }} numberOfLines={2}>
                {gamePlan.message}
              </Text>
              {readinessState && (
                <View style={{
                  flexDirection: "row", alignItems: "center", gap: 6,
                  paddingTop: 8,
                  borderTopWidth: 1,
                  borderTopColor: "#1a1a2c",
                  marginTop: 4,
                }}>
                  <View style={{
                    width: 5, height: 5, borderRadius: 2.5,
                    backgroundColor:
                      readinessState.readiness === "PUSH"    ? "#66bb6a" :
                      readinessState.readiness === "RECOVER" ? "#FF9800" :
                      ACCENT,
                  }} />
                  <Text style={{
                    color:
                      readinessState.readiness === "PUSH"    ? "#66bb6a99" :
                      readinessState.readiness === "RECOVER" ? "#FF980099" :
                      ACCENT + "99",
                    fontSize:    10,
                    fontWeight:  "700",
                    letterSpacing: 0.4,
                    flex: 1,
                  }}>
                    {readinessState.readiness === "PUSH"    ? "Push day — " :
                     readinessState.readiness === "RECOVER" ? "Recover day — " :
                     "Build day — "}
                    {readinessState.reason}
                  </Text>
                </View>
              )}
            </View>
            <Text style={{ color: ACCENT + "55", fontSize: 18 }}>›</Text>
            </View>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => setShowMotivation(true)}
            style={{
              backgroundColor: ACCENT + "0c",
              borderWidth: 1,
              borderColor: ACCENT + "35",
              borderRadius: 16,
              padding: 16,
              marginBottom: 16,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              shadowColor: ACCENT,
              shadowOpacity: 0.1,
              shadowRadius: 14,
              shadowOffset: { width: 0, height: 0 },
              elevation: 4,
            }}
          >
            <View style={{ gap: 5 }}>
              <Text style={{ color: ACCENT, fontSize: 13, fontWeight: "800", letterSpacing: -0.2 }}>
                Lock in your plan for today.
              </Text>
              <Text style={{ color: ACCENT + "90", fontSize: 11, fontWeight: "600" }}>
                Tap to start check-in →
              </Text>
            </View>
            <Text style={{ color: ACCENT, fontSize: 20, fontWeight: "800" }}>›</Text>
          </Pressable>
        )}

        {/* ── Error state ─────────────────────────────────────────────────────── */}
        {aiPlanError && (
          <View style={{
            backgroundColor: "#100808",
            borderWidth: 1,
            borderColor: "#2a1010",
            borderRadius: 16,
            padding: 18,
            marginBottom: 16,
            gap: 10,
          }}>
            <Text style={{ color: "#ff5252", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 }}>PLAN ERROR</Text>
            <Text style={{ color: "#996060", fontSize: 13, lineHeight: 19 }}>{aiPlanError}</Text>
            <Pressable onPress={() => generateAIPlan()}>
              <Text style={{ color: ACCENT, fontSize: 13, fontWeight: "700" }}>Try again →</Text>
            </Pressable>
          </View>
        )}

        {/* ── Plan exists ─────────────────────────────────────────────────────── */}
        {effectivePlan && !aiPlanError && (
          <>
            {/* ── Intelligence header ───────────────────────────────────────────
                Three tiers of information pulled from the Aira-generated plan:
                  1. disciplineTarget — primary daily focus (large, bold)
                  2. summary          — why today's plan is structured this way
                  3. Confidence line  — subtle static reminder that the plan is personalised
            */}
            <View style={{
              backgroundColor: "rgba(255,255,255,0.04)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.06)",
              borderLeftWidth: 3,
              borderLeftColor: ACCENT + "70",
              borderRadius: 16,
              paddingVertical: 16,
              paddingHorizontal: 16,
              marginBottom: 20,
              gap: 10,
              shadowColor: ACCENT,
              shadowOpacity: 0.06,
              shadowRadius: 20,
              shadowOffset: { width: 0, height: 6 },
              elevation: 4,
            }}>
              {/* Label */}
              <Text style={{ color: "#32324e", fontSize: 9, fontWeight: "900", letterSpacing: 1.6 }}>TODAY&apos;S FOCUS</Text>

              {/* Primary — discipline target (large, bold) */}
              <Text style={{ color: "#dcdcf4", fontSize: 17, lineHeight: 25, fontWeight: "700", letterSpacing: -0.4 }}>
                {effectivePlan.disciplineTarget}
              </Text>

              {/* Secondary — Aira plan summary (what & why) */}
              {effectivePlan.summary ? (
                <Text style={{ color: "#8888a8", fontSize: 13, lineHeight: 20, fontWeight: "500", letterSpacing: 0 }}>
                  {effectivePlan.summary}
                </Text>
              ) : null}

              {/* Divider */}
              <View style={{ height: 1, backgroundColor: "rgba(255,255,255,0.04)", marginTop: 2 }} />

              {/* Confidence line — subtle, low-opacity */}
              <Text style={{ color: "#34344e", fontSize: 11, lineHeight: 17, fontWeight: "500", letterSpacing: 0.1 }}>
                Personalised to your goals, schedule, and recovery.
              </Text>
            </View>
          </>
        )}

        {/* ── NEXT MOVE card — real-time decision engine ───────────────────────── */}
        {nextBestAction && !allDone && (
          <Pressable
            onPress={() => {
              if (!nextBestAction.taskId) return;
              const task = effectiveTasks.find((t) => t.id === nextBestAction.taskId);
              if (!task) return;
              if (task.kind === "Workout")        setWorkoutTask(task);
              else if (task.kind === "Nutrition") setNutritionTask(task);
              else if (task.kind === "Recovery")  setRecoveryTask(task);
              else if (task.kind === "Habit")     setHabitTask(task);
              else                                setDetailTask(task);
            }}
            style={({ pressed }) => ({
              backgroundColor: "rgba(255,255,255,0.04)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.07)",
              borderRadius: 16,
              padding: 16,
              marginBottom: 16,
              gap: 6,
              shadowColor: "#000",
              shadowOpacity: 0.18,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 6 },
              elevation: 5,
              opacity:   pressed ? 0.88 : 1,
              transform: [{ scale: pressed ? 0.985 : 1 }],
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ color: ACCENT + "aa", fontSize: 9, fontWeight: "900", letterSpacing: 1.6 }}>NEXT MOVE</Text>
              <Text style={{ color: ACCENT + "44", fontSize: 11, fontWeight: "700" }}>→</Text>
            </View>
            <Text style={{ color: "#dcdcf0", fontSize: 14, fontWeight: "600", letterSpacing: -0.2, lineHeight: 22 }}>
              {nextBestAction.label}
            </Text>
            <Text style={{ color: "#4a4a70", fontSize: 12, fontWeight: "500", lineHeight: 20 }}>
              {nextBestAction.reason}
            </Text>
          </Pressable>
        )}

        {/* ── WIN CONDITION — daily success framework ──────────────────────────── */}
        {winCondition && !allDone && (
          <View style={{
            backgroundColor: "#070710",
            borderWidth: 1,
            borderColor: "#131326",
            borderRadius: 16,
            padding: 16,
            marginBottom: 16,
            gap: 10,
            shadowColor: "#000",
            shadowOpacity: 0.25,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 2 },
            elevation: 3,
          }}>
            <Text style={{ color: "#30304e", fontSize: 9, fontWeight: "900", letterSpacing: 1.6 }}>WIN CONDITION</Text>

            {/* Primary — must happen */}
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
              <View style={{
                width: 6, height: 6, borderRadius: 3,
                backgroundColor: "#4CAF5080",
                marginTop: 6,
                flexShrink: 0,
              }} />
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={{ color: "#383858", fontSize: 9, fontWeight: "800", letterSpacing: 0.8 }}>MUST DO</Text>
                <Text style={{ color: "#c0c0dc", fontSize: 14, fontWeight: "700", lineHeight: 20, letterSpacing: -0.1 }}>
                  {winCondition.primary}
                </Text>
              </View>
            </View>

            {/* Secondary — key outcome */}
            {winCondition.secondary && (
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
                <View style={{
                  width: 6, height: 6, borderRadius: 3,
                  backgroundColor: ACCENT + "60",
                  marginTop: 6,
                  flexShrink: 0,
                }} />
                <View style={{ flex: 1, gap: 1 }}>
                  <Text style={{ color: "#383858", fontSize: 9, fontWeight: "800", letterSpacing: 0.8 }}>KEY OUTCOME</Text>
                  <Text style={{ color: "#9898b8", fontSize: 13, fontWeight: "500", lineHeight: 19 }}>
                    {winCondition.secondary}
                  </Text>
                </View>
              </View>
            )}

            {/* Flex — nice to have */}
            {winCondition.flex && winCondition.flex.length > 0 && (
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingTop: 2 }}>
                <View style={{
                  width: 6, height: 6, borderRadius: 3,
                  backgroundColor: "#2c2c48",
                  marginTop: 6,
                  flexShrink: 0,
                }} />
                <Text style={{ color: "#404060", fontSize: 12, fontWeight: "500", lineHeight: 18, flex: 1 }}>
                  If time allows: {winCondition.flex.join(", ")}.
                </Text>
              </View>
            )}
          </View>
        )}

        {/* ── Why this plan — schedule/context rationale ──────────────────────── */}
        {(() => {
          if (!effectivePlan) return null;
          const rationale = buildPlanRationale(effectiveTasks, blocks, gamePlan, patternInsights);
          if (!rationale) return null;
          return (
            <View style={{
              flexDirection: "row",
              alignItems:    "flex-start",
              gap:           10,
              marginBottom:  16,
            }}>
              <View style={{
                width: 2, alignSelf: "stretch",
                backgroundColor: ACCENT + "28",
                borderRadius: 1,
              }} />
              <Text style={{
                color:      "#484868",
                fontSize:   12,
                fontWeight: "500",
                lineHeight: 18,
                flex:       1,
                fontStyle:  "italic",
              }}>
                {rationale}
              </Text>
            </View>
          );
        })()}

        {/* ── Aira Insight — predictive coaching before failure happens ────────── */}
        {predictiveInsights.length > 0 && effectivePlan && (
          <View style={{ gap: 6, marginBottom: 16 }}>
            {predictiveInsights.map((insight) => {
              const isUrgent   = insight.key === "streak_risk";
              const modeColor  = COACH_MODE_META[coachMode].color;
              const accentColor = isUrgent ? "#FF5252" : modeColor;
              return (
                <View
                  key={insight.key}
                  style={{
                    backgroundColor: isUrgent ? "#0c070a" : "#07070f",
                    borderWidth: 1,
                    borderColor: accentColor + "1c",
                    borderRadius: 14,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    gap: 5,
                  }}
                >
                  <Text style={{
                    color: accentColor + "60",
                    fontSize: 9,
                    fontWeight: "900",
                    letterSpacing: 1.4,
                  }}>
                    AIRA · {insight.label}
                  </Text>
                  <Text style={{ color: "#707088", fontSize: 12, fontWeight: "500", lineHeight: 18 }}>
                    {insight.message}
                  </Text>
                  {insight.action && (
                    <Pressable
                      onPress={() => triggerAdaptation(insight.action!.trigger)}
                      style={{ marginTop: 2, alignSelf: "flex-start" }}
                    >
                      <Text style={{
                        color: accentColor + "cc",
                        fontSize: 11,
                        fontWeight: "700",
                        letterSpacing: 0.2,
                      }}>
                        {insight.action.label} →
                      </Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        )}

        {/* ── Task list ───────────────────────────────────────────────────────── */}
        {totalCount > 0 ? (
          <View style={{ gap: 14, marginBottom: 44 }}>
            {/* Section header */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <Text style={{ color: "#34345e", fontSize: 9, fontWeight: "700", letterSpacing: 1.8 }}>
                TASKS
              </Text>
              {pausedCount > 0 && (
                <Text style={{ color: "#2e2e48", fontSize: 10, fontWeight: "600", letterSpacing: 0.2 }}>
                  {pausedCount} paused
                </Text>
              )}
            </View>

            {(() => {
              // ── Day-section grouping ─────────────────────────────────────────
              // Only show MORNING / AFTERNOON / EVENING headers when tasks span
              // at least two periods — keeps single-period days uncluttered.
              const NOON = 12 * 60;
              const EVE  = 17 * 60;
              const periods = [
                effectiveTasks.some((t) => t.timeMin < NOON),
                effectiveTasks.some((t) => t.timeMin >= NOON && t.timeMin < EVE),
                effectiveTasks.some((t) => t.timeMin >= EVE),
              ];
              const multiPeriod = periods.filter(Boolean).length > 1;

              const sections = multiPeriod
                ? [
                    { key: "morning",   label: "MORNING",   tasks: effectiveTasks.filter((t) => t.timeMin < NOON) },
                    { key: "afternoon", label: "AFTERNOON", tasks: effectiveTasks.filter((t) => t.timeMin >= NOON && t.timeMin < EVE) },
                    { key: "evening",   label: "EVENING",   tasks: effectiveTasks.filter((t) => t.timeMin >= EVE) },
                  ].filter((s) => s.tasks.length > 0)
                : [{ key: "all", label: null, tasks: effectiveTasks }];

              // ── Per-task renderer (preserves isNext / quick-complete logic) ──
              const renderTask = (task: TimedTask) => {
                const isNext = task.id === nextTaskId;
                const taskRow = (
                  <TaskRow
                    task={task}
                    isNext={isNext}
                    onToggle={() => toggleTask(task.id)}
                    onDetail={() => {
                      if (task.kind === "Workout")        setWorkoutTask(task);
                      else if (task.kind === "Nutrition") setNutritionTask(task);
                      else if (task.kind === "Recovery")  setRecoveryTask(task);
                      else if (task.kind === "Habit")     setHabitTask(task);
                      else setDetailTask(task);
                    }}
                  />
                );
                if (!isNext) return <React.Fragment key={task.id}>{taskRow}</React.Fragment>;
                return (
                  <View key={task.id}>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                      <Text style={{ color: ACCENT + "99", fontSize: 9, fontWeight: "900", letterSpacing: 1.4 }}>
                        {showStartNudge ? "→ START HERE NOW" : "START HERE"}
                      </Text>
                      {showStartNudge && (
                        <Text style={{ color: ACCENT + "55", fontSize: 9, fontWeight: "700", letterSpacing: 0.8 }}>
                          tap to complete ↓
                        </Text>
                      )}
                    </View>
                    {taskRow}
                    {/* Quick-complete strip — 1-tap completion for the next task */}
                    <Pressable
                      onPress={() => toggleTask(task.id)}
                      style={({ pressed }) => ({
                        marginTop: 6,
                        backgroundColor: ACCENT + "0e",
                        borderWidth: 1,
                        borderColor: ACCENT + "28",
                        borderRadius: 14,
                        paddingVertical: 11,
                        alignItems: "center",
                        flexDirection: "row",
                        justifyContent: "center",
                        gap: 8,
                        opacity:   pressed ? 0.78 : 1,
                        transform: [{ scale: pressed ? 0.97 : 1 }],
                      })}
                    >
                      <View style={{
                        width: 14, height: 14, borderRadius: 7,
                        borderWidth: 1.5, borderColor: ACCENT + "80",
                        alignItems: "center", justifyContent: "center",
                      }} />
                      <Text style={{ color: ACCENT + "e0", fontSize: 12, fontWeight: "800", letterSpacing: 0.3 }}>
                        Mark complete
                      </Text>
                    </Pressable>
                  </View>
                );
              };

              // ── Render sections ──────────────────────────────────────────────
              return sections.map(({ key, label, tasks: sectionTasks }, si) => (
                <View key={key} style={si > 0 ? { marginTop: 12 } : undefined}>
                  {label && (
                    <View style={{
                      flexDirection: "row", alignItems: "center", gap: 10,
                      marginBottom: 10, marginTop: si === 0 ? 0 : 14,
                    }}>
                      <Text style={{ color: "#2a2a44", fontSize: 9, fontWeight: "700", letterSpacing: 1.6 }}>
                        {label}
                      </Text>
                      <View style={{ flex: 1, height: 1, backgroundColor: "#0e0e1c" }} />
                    </View>
                  )}
                  <View style={{ gap: 12 }}>
                    {sectionTasks.map(renderTask)}
                  </View>
                </View>
              ));
            })()}

          </View>
        ) : (
          /* ── Empty state ──────────────────────────────────────────────────── */
          <View style={{ alignItems: "center", paddingTop: 52, paddingBottom: 52, gap: 18 }}>
            <View style={{
              width: 60,
              height: 60,
              borderRadius: 30,
              borderWidth: 1,
              borderColor: ACCENT + "30",
              backgroundColor: ACCENT + "08",
              alignItems: "center",
              justifyContent: "center",
              shadowColor: ACCENT,
              shadowOpacity: 0.1,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: 0 },
            }}>
              <Text style={{ color: ACCENT + "70", fontSize: 24 }}>◎</Text>
            </View>
            <View style={{ alignItems: "center", gap: 6 }}>
              <Text style={{ color: "#d0d0d8", fontSize: 16, fontWeight: "700", letterSpacing: -0.2 }}>
                {effectivePlan
                  ? "Let's build momentum."
                  : gamePlan ? "Ready to build your plan." : "Set your direction first."}
              </Text>
              <Text style={{ color: "#505060", fontSize: 13, textAlign: "center", lineHeight: 21, maxWidth: 240 }}>
                {effectivePlan
                  ? "Aira is preparing your plan. Stay consistent."
                  : gamePlan
                    ? "Check-in complete. Generate your plan to start executing."
                    : "Complete your daily check-in, then generate a plan."}
              </Text>
            </View>
            {gamePlan ? (
              <Pressable
                onPress={aiPlanLoading ? undefined : () => generateAIPlan()}
                style={({ pressed }) => ({
                  marginTop: 4,
                  borderRadius: 14,
                  overflow: "hidden",
                  shadowColor: "#7B61FF",
                  shadowOpacity: aiPlanLoading ? 0.25 : pressed ? 0.65 : 0.5,
                  shadowRadius: 20,
                  shadowOffset: { width: 0, height: 6 },
                  elevation: 8,
                  opacity: aiPlanLoading ? 0.7 : pressed ? 0.92 : 1,
                  transform: [{ scale: aiPlanLoading ? 1 : pressed ? 0.97 : 1 }],
                })}
              >
                <LinearGradient
                  colors={["#5e7fff", "#7B61FF", "#a855f7"]}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={{ paddingVertical: 15, paddingHorizontal: 32, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }}
                >
                  {aiPlanLoading
                    ? <ActivityIndicator color="rgba(255,255,255,0.7)" size="small" />
                    : null}
                  <Text style={{ color: aiPlanLoading ? "rgba(255,255,255,0.6)" : "#fff", fontSize: 14, fontWeight: "800", letterSpacing: 0.2 }}>
                    {aiPlanLoading ? "Building…" : "Generate today's plan"}
                  </Text>
                </LinearGradient>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => setShowMotivation(true)}
                style={{
                  marginTop: 4,
                  backgroundColor: "#0e0e1c",
                  borderWidth: 1,
                  borderColor: ACCENT + "40",
                  borderRadius: 14,
                  paddingVertical: 15,
                  paddingHorizontal: 32,
                  shadowColor: ACCENT,
                  shadowOpacity: 0.15,
                  shadowRadius: 10,
                  shadowOffset: { width: 0, height: 3 },
                  elevation: 4,
                }}
              >
                <Text style={{ color: ACCENT, fontSize: 14, fontWeight: "800", letterSpacing: 0.2 }}>Start check-in</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* ── Coaching note + fallback ────────────────────────────────────────── */}
        {effectivePlan && (
          <View style={{ gap: 12, marginTop: 8 }}>
            {/* Coaching note card — border + label tinted to coach mode */}
            {(() => {
              const modeMeta = COACH_MODE_META[coachMode];
              return (
                <View style={{
                  backgroundColor: "rgba(255,255,255,0.04)",
                  borderWidth: 1,
                  borderColor: "rgba(255,255,255,0.06)",
                  borderRadius: 16,
                  padding: 16,
                  gap: 8,
                  shadowColor: "#000",
                  shadowOpacity: 0.18,
                  shadowRadius: 16,
                  shadowOffset: { width: 0, height: 6 },
                  elevation: 4,
                }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <Text style={{ color: "#303060", fontSize: 9, fontWeight: "900", letterSpacing: 1.6 }}>AIRA</Text>
                    <View style={{
                      backgroundColor: modeMeta.color + "14",
                      borderRadius: 6,
                      paddingHorizontal: 7,
                      paddingVertical: 2,
                    }}>
                      <Text style={{ color: modeMeta.color + "cc", fontSize: 8, fontWeight: "900", letterSpacing: 0.8 }}>
                        {modeMeta.label}
                      </Text>
                    </View>
                  </View>
                  <Text style={{ color: "#8888a8", fontSize: 13, lineHeight: 21, fontWeight: "500", letterSpacing: 0 }}>{effectivePlan.coachingNote}</Text>
                </View>
              );
            })()}

            {/* Pattern coaching card — only shown when Aira has learned something */}
            {patternCoachingLine && (
              <View style={{
                backgroundColor: "#06060d",
                borderWidth: 1,
                borderColor: ACCENT + "22",
                borderRadius: 16,
                padding: 18,
                gap: 6,
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={{ color: ACCENT + "55", fontSize: 9, fontWeight: "900", letterSpacing: 1.4 }}>AIRA LEARNS</Text>
                  {userMemory.consistencyScore > 0 && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <View style={{
                        width: 28,
                        height: 4,
                        borderRadius: 2,
                        backgroundColor: "#1a1a30",
                        overflow: "hidden",
                      }}>
                        <View style={{
                          width: `${userMemory.consistencyScore}%`,
                          height: "100%",
                          backgroundColor: userMemory.consistencyScore >= 70 ? "#4CAF50" : userMemory.consistencyScore >= 40 ? ACCENT : "#FF5252",
                          borderRadius: 2,
                        }} />
                      </View>
                      <Text style={{
                        color: userMemory.consistencyScore >= 70 ? "#4CAF5099" : userMemory.consistencyScore >= 40 ? ACCENT + "88" : "#FF525299",
                        fontSize: 9,
                        fontWeight: "800",
                        letterSpacing: 0.6,
                      }}>{userMemory.consistencyScore}%</Text>
                    </View>
                  )}
                </View>
                <Text style={{ color: "#8888aa", fontSize: 13, lineHeight: 20, fontWeight: "500" }}>{patternCoachingLine}</Text>
              </View>
            )}

            {/* Fallback card */}
            <View style={{
              backgroundColor: "#050508",
              borderWidth: 1,
              borderColor: "#0e0e1c",
              borderLeftWidth: 2,
              borderLeftColor: "#242440",
              borderRadius: 14,
              paddingVertical: 12,
              paddingHorizontal: 14,
              gap: 5,
            }}>
              <Text style={{ color: "#28283e", fontSize: 9, fontWeight: "900", letterSpacing: 1.6 }}>FALLBACK</Text>
              <Text style={{ color: "#505068", fontSize: 12, lineHeight: 19, fontStyle: "italic" }}>{effectivePlan.fallbackPlan}</Text>
            </View>

            {/* DAY REVIEW card — visible after 8 PM or when all tasks are done */}
            {dayEvaluation && (() => {
              const statusMeta: Record<DayEvalStatus, { color: string; label: string; icon: string }> = {
                WIN:     { color: "#4CAF50", label: "WIN",     icon: "◆" },
                PARTIAL: { color: "#FFB300", label: "PARTIAL", icon: "◈" },
                MISS:    { color: "#FF5252", label: "MISS",    icon: "◇" },
              };
              const meta = statusMeta[dayEvaluation.status];
              return (
                <View style={{
                  backgroundColor: "#060610",
                  borderWidth: 1.5,
                  borderColor: meta.color + "40",
                  borderRadius: 16,
                  padding: 18,
                  gap: 10,
                  shadowColor: meta.color,
                  shadowOpacity: 0.08,
                  shadowRadius: 16,
                  shadowOffset: { width: 0, height: 0 },
                }}>
                  {/* Header */}
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <Text style={{ color: "#505070", fontSize: 9, fontWeight: "900", letterSpacing: 1.6 }}>DAY REVIEW</Text>
                    <View style={{
                      flexDirection: "row", alignItems: "center", gap: 5,
                      backgroundColor: meta.color + "16",
                      borderRadius: 6,
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                    }}>
                      <Text style={{ color: meta.color, fontSize: 9, fontWeight: "900" }}>{meta.icon}</Text>
                      <Text style={{ color: meta.color + "cc", fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>{meta.label}</Text>
                    </View>
                  </View>

                  {/* Evaluation message */}
                  <Text style={{
                    color: dayEvaluation.status === "WIN" ? "#d0e8d0" : dayEvaluation.status === "PARTIAL" ? "#d8c880" : "#c88888",
                    fontSize: 14,
                    fontWeight: "700",
                    lineHeight: 21,
                    letterSpacing: -0.1,
                  }}>
                    {dayEvaluation.message}
                  </Text>

                  {/* Tomorrow focus */}
                  {dayEvaluation.focusTomorrow && (
                    <View style={{
                      flexDirection: "row", alignItems: "flex-start", gap: 8,
                      borderTopWidth: 1,
                      borderTopColor: "#1a1a2c",
                      paddingTop: 10,
                    }}>
                      <Text style={{ color: ACCENT + "60", fontSize: 11, fontWeight: "700", marginTop: 1 }}>→</Text>
                      <View style={{ flex: 1, gap: 1 }}>
                        <Text style={{ color: "#404060", fontSize: 9, fontWeight: "800", letterSpacing: 0.8 }}>TOMORROW</Text>
                        <Text style={{ color: "#7878a8", fontSize: 12, fontWeight: "600", lineHeight: 18 }}>
                          {dayEvaluation.focusTomorrow}
                        </Text>
                      </View>
                    </View>
                  )}
                </View>
              );
            })()}

            {/* TOMORROW STARTS WITH card — surfaces alongside day evaluation */}
            {tomorrowPrep && (
              <View style={{
                backgroundColor: "#07070e",
                borderWidth: 1,
                borderColor: ACCENT + "30",
                borderRadius: 16,
                padding: 18,
                gap: 8,
              }}>
                <Text style={{ color: ACCENT + "70", fontSize: 9, fontWeight: "900", letterSpacing: 1.6 }}>TOMORROW STARTS WITH</Text>

                {/* Primary focus */}
                <Text style={{
                  color:       "#c8c8e8",
                  fontSize:    14,
                  fontWeight:  "800",
                  lineHeight:  21,
                  letterSpacing: -0.2,
                }}>
                  {tomorrowPrep.primaryFocus}
                </Text>

                {/* Prep action */}
                {tomorrowPrep.prepAction && (
                  <View style={{
                    flexDirection: "row",
                    alignItems:    "flex-start",
                    gap:           8,
                    paddingTop:    2,
                  }}>
                    <Text style={{ color: "#4CAF5080", fontSize: 11, fontWeight: "700", marginTop: 1 }}>✓</Text>
                    <Text style={{
                      flex:       1,
                      color:      "#606080",
                      fontSize:   12,
                      fontWeight: "600",
                      lineHeight: 18,
                    }}>
                      {tomorrowPrep.prepAction}
                    </Text>
                  </View>
                )}

                {/* Carry-over reason */}
                {tomorrowPrep.carryOverReason && (
                  <Text style={{
                    color:      "#3c3c58",
                    fontSize:   11,
                    fontWeight: "500",
                    lineHeight: 17,
                    fontStyle:  "italic",
                    marginTop:  2,
                  }}>
                    {tomorrowPrep.carryOverReason}
                  </Text>
                )}
              </View>
            )}

          </View>
        )}

        {/* ── Generate prompt — no plan yet but game plan exists ─────────────── */}
        {!effectivePlan && !aiPlanError && totalCount === 0 && gamePlan && (
          <View style={{ marginTop: 8 }} />
        )}

        {/* ── No AI plan but has local tasks — show generate nudge ────────────── */}
        {!effectivePlan && !aiPlanError && totalCount > 0 && (
          <Pressable
            onPress={aiPlanLoading ? undefined : () => generateAIPlan()}
            style={({ pressed }) => ({
              marginTop: 8,
              backgroundColor: ACCENT + "14",
              borderWidth: 1,
              borderColor: ACCENT + "40",
              borderRadius: 16,
              padding: 18,
              alignItems: "center",
              gap: 3,
              shadowColor: ACCENT,
              shadowOpacity: 0.12,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 3 },
              elevation: 3,
              opacity: aiPlanLoading ? 0.5 : pressed ? 0.82 : 1,
              transform: [{ scale: aiPlanLoading ? 1 : pressed ? 0.985 : 1 }],
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {aiPlanLoading && <ActivityIndicator color={ACCENT} size="small" />}
              <Text style={{ color: aiPlanLoading ? ACCENT + "70" : ACCENT, fontSize: 13, fontWeight: "800" }}>
                {aiPlanLoading ? "Building…" : "Generate AI plan →"}
              </Text>
            </View>
            <Text style={{ color: ACCENT + "80", fontSize: 11, fontWeight: "500" }}>Replaces the local plan with a personalised one</Text>
          </Pressable>
        )}

        {/* ── Refine My Day — regenerate button when plan exists ──────────────── */}
        {effectivePlan && !isMockActive && totalCount > 0 && (
          <Pressable
            onPress={aiPlanLoading ? undefined : () => generateAIPlan()}
            style={({ pressed }) => ({
              marginTop: 16,
              backgroundColor: aiPlanLoading ? "#080810" : "#0d0d1e",
              borderWidth: 1,
              borderColor: aiPlanLoading ? ACCENT + "20" : ACCENT + "30",
              borderRadius: 16,
              paddingVertical: 14,
              paddingHorizontal: 20,
              alignItems: "center",
              gap: 5,
              opacity: aiPlanLoading ? 0.65 : pressed ? 0.88 : 1,
              transform: [{ scale: aiPlanLoading ? 1 : pressed ? 0.985 : 1 }],
              shadowColor: ACCENT,
              shadowOpacity: aiPlanLoading ? 0 : 0.08,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
              elevation: 3,
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {aiPlanLoading && <ActivityIndicator color={ACCENT + "80"} size="small" />}
              <Text style={{
                color:         aiPlanLoading ? ACCENT + "50" : ACCENT + "cc",
                fontSize:      13,
                fontWeight:    "800",
                letterSpacing: 0.2,
              }}>
                {aiPlanLoading ? "Refining…" : "Refine My Day"}
              </Text>
            </View>
            <Text style={{ color: "#262640", fontSize: 11, fontWeight: "500", letterSpacing: 0.1 }}>
              Adjusts your plan based on your current state
            </Text>
          </Pressable>
        )}

        {/* ── Hub previews ───────────────────────────────────────────────────── */}
        <View style={{ marginTop: 20, gap: 14 }}>

          {/* Schedule preview — horizontal timeline */}
          <View>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <Text style={{ color: "#2a2a44", fontSize: 9, fontWeight: "700", letterSpacing: 1.8 }}>SCHEDULE</Text>
              <Pressable onPress={() => setOverlay("schedule")} hitSlop={8}>
                <Text style={{ color: "#303050", fontSize: 11, fontWeight: "700", letterSpacing: 0.2 }}>Manage →</Text>
              </Pressable>
            </View>
            {blocks.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -2 }}>
                <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 2, paddingBottom: 4 }}>
                  {blocks.map((b) => {
                    const accentColor = (() => {
                      if (b.type === "Work")    return ACCENT;
                      if (b.type === "School")  return "#42a5f5";
                      if (b.type === "Kids")    return "#66bb6a";
                      if (b.type === "Commute") return "#ffa040";
                      return "#7B61FF";
                    })();
                    // Very faint Aira tint per type — purely atmospheric
                    const gradColors: [string, string, string] = (() => {
                      if (b.type === "Work")    return ["#00D1FF07", "#7B61FF0a", "#7B61FF05"];
                      if (b.type === "School")  return ["#00D1FF07", "#42a5f50a", "#42a5f505"];
                      if (b.type === "Kids")    return ["#4CAF5007", "#00D1FF09", "#4CAF5004"];
                      if (b.type === "Commute") return ["#ffa04009", "#FF3D9A07", "#ffa04004"];
                      return ["#7B61FF07", "#FF3D9A08", "#7B61FF04"];
                    })();
                    return (
                      <LinearGradient
                        key={b.id}
                        colors={gradColors}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={{
                          borderWidth:     1,
                          borderColor:     "rgba(255,255,255,0.07)",
                          borderLeftWidth: 3,
                          borderLeftColor: accentColor + "90",
                          borderRadius:    14,
                          paddingVertical: 13,
                          paddingHorizontal: 14,
                          minWidth:        128,
                          gap:             5,
                          shadowColor:     "#000",
                          shadowOpacity:   0.18,
                          shadowRadius:    16,
                          shadowOffset:    { width: 0, height: 6 },
                          elevation:       3,
                        }}
                      >
                        <Text style={{ color: "#cccce0", fontSize: 12, fontWeight: "800", letterSpacing: -0.1 }} numberOfLines={1}>
                          {b.title}
                        </Text>
                        <Text style={{ color: accentColor + "70", fontSize: 10, fontWeight: "700", letterSpacing: 0.2 }}>
                          {b.startText} – {b.endText}
                        </Text>
                      </LinearGradient>
                    );
                  })}
                </View>
              </ScrollView>
            ) : (
              <Pressable
                onPress={() => setOverlay("schedule")}
                style={{
                  backgroundColor: "#06060e",
                  borderWidth: 1,
                  borderColor: "#111120",
                  borderRadius: 12,
                  paddingVertical: 16,
                  alignItems: "center",
                }}
              >
                <Text style={{ color: "#252540", fontSize: 12, fontWeight: "700" }}>Add schedule blocks →</Text>
              </Pressable>
            )}
          </View>

          {/* Nutrition + Recovery — side by side */}
          <View style={{ flexDirection: "row", gap: 10 }}>

            {/* Nutrition preview */}
            {(() => {
              const nutritionTasks = effectiveTasks.filter((t) => t.kind === "Nutrition");
              const nutritionDone  = nutritionTasks.filter((t) => t.done).length;
              const hasNutrition   = nutritionTasks.length > 0;
              return (
                <Pressable
                  onPress={() => {
                    const first = nutritionTasks.find((t) => !t.done) ?? nutritionTasks[0];
                    if (first) setNutritionTask(first);
                    // no-op when no tasks — card still gives visual feedback via press style
                  }}
                  style={({ pressed }) => ({
                    flex: 1,
                    backgroundColor: "rgba(255,255,255,0.04)",
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.06)",
                    borderLeftWidth: 3,
                    borderLeftColor: hasNutrition ? "#4CAF5060" : "#4CAF5025",
                    borderRadius: 14,
                    padding: 14,
                    gap: 4,
                    shadowColor: "#000",
                    shadowOpacity: 0.18,
                    shadowRadius: 16,
                    shadowOffset: { width: 0, height: 6 },
                    elevation: 3,
                    opacity:   pressed && hasNutrition ? 0.82 : 1,
                    transform: [{ scale: pressed && hasNutrition ? 0.985 : 1 }],
                  })}
                >
                  <Text style={{ color: "#243d30", fontSize: 9, fontWeight: "700", letterSpacing: 1.8 }}>NUTRITION</Text>
                  <Text style={{ color: hasNutrition ? "#b0b0c8" : "#303048", fontSize: 13, fontWeight: "600", marginTop: 3, letterSpacing: -0.1 }}>
                    {hasNutrition
                      ? `${nutritionDone}/${nutritionTasks.length} tracked`
                      : effectivePlan ? "No meals planned" : "Awaiting plan"}
                  </Text>
                  <Text style={{ color: "#2a3830", fontSize: 10, fontWeight: "600" }} numberOfLines={1}>
                    {hasNutrition
                      ? (nutritionTasks.find((t) => !t.done)?.title ?? "All done ✓")
                      : effectivePlan ? "Plan has no meals" : "—"}
                  </Text>
                </Pressable>
              );
            })()}

            {/* Recovery preview */}
            <Pressable
              onPress={() => setShowMotivation(true)}
              style={({ pressed }) => ({
                flex: 1,
                backgroundColor: "rgba(255,255,255,0.04)",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.06)",
                borderLeftWidth: 3,
                borderLeftColor: ACCENT + "55",
                borderRadius: 14,
                padding: 14,
                gap: 4,
                shadowColor: "#000",
                shadowOpacity: 0.18,
                shadowRadius: 16,
                shadowOffset: { width: 0, height: 6 },
                elevation: 3,
                opacity:   pressed ? 0.82 : 1,
                transform: [{ scale: pressed ? 0.985 : 1 }],
              })}
            >
              <Text style={{ color: "#26243e", fontSize: 9, fontWeight: "700", letterSpacing: 1.8 }}>RECOVERY</Text>
              <Text style={{ color: "#b0b0c8", fontSize: 13, fontWeight: "600", marginTop: 3, letterSpacing: -0.1 }}>
                {gamePlan ? gamePlan.readiness : "Not set"}
              </Text>
              <Text style={{ color: "#282840", fontSize: 10, fontWeight: "600" }} numberOfLines={1}>
                {recovery.energyLevel ? `Energy: ${recovery.energyLevel}` : "Tap to check in"}
              </Text>
            </Pressable>

          </View>

        </View>

      </ScrollView>
    );
  };

  const Schedule = () => {
    // Kept local so typing doesn't re-render Index and dismiss the keyboard
    const [blockTitle, setBlockTitle] = useState("");
    const [blockType, setBlockType] = useState<BlockType>("Work");
    const [blockStart, setBlockStart] = useState("9:00 AM");
    const [blockEnd, setBlockEnd] = useState("5:00 PM");

    const TYPE_DEFAULTS: Record<BlockType, { start: string; end: string }> = {
      Work:    { start: "9:00 AM",  end: "5:00 PM"  },
      School:  { start: "8:00 AM",  end: "3:00 PM"  },
      Kids:    { start: "3:00 PM",  end: "6:00 PM"  },
      Commute: { start: "8:00 AM",  end: "9:00 AM"  },
      Other:   { start: "10:00 AM", end: "11:00 AM" },
    };

    const TYPE_COLORS: Record<BlockType, string> = {
      Work:    ACCENT,
      School:  "#42a5f5",
      Kids:    "#66bb6a",
      Commute: "#ffa040",
      Other:   "#9e9e9e",
    };

    const typeButtons: BlockType[] = ["Work", "School", "Kids", "Commute", "Other"];

    const selectType = (t: BlockType) => {
      setBlockType(t);
      setBlockStart(TYPE_DEFAULTS[t].start);
      setBlockEnd(TYPE_DEFAULTS[t].end);
    };

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
      setBlockStart(TYPE_DEFAULTS[blockType].start);
      setBlockEnd(TYPE_DEFAULTS[blockType].end);
    };

    const removeBlock = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));

    const activeColor = TYPE_COLORS[blockType];

    const LABEL_PLACEHOLDER: Record<BlockType, string> = {
      Work:    "e.g., Morning shift",
      School:  "e.g., Classes",
      Kids:    "e.g., School pickup",
      Commute: "e.g., Train to work",
      Other:   "e.g., Appointment",
    };

    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

        {/* ── Header ────────────────────────────────────────────────────────── */}
        <View style={{ paddingBottom: 22 }}>
          <Text style={{ color: "#ffffff", fontSize: 32, fontWeight: "800", letterSpacing: -0.8 }}>Schedule</Text>
          <Text style={{ color: "#4a4a5a", fontSize: 12, fontWeight: "600", marginTop: 4, letterSpacing: 0.3 }}>
            Your fixed commitments
          </Text>
          <Text style={{ color: "#383850", fontSize: 12, marginTop: 10, lineHeight: 18, fontWeight: "500" }}>
            Aira builds around your real life. Add any fixed commitments — your plan slots around them automatically.
          </Text>
        </View>

        {/* ── Add block form ─────────────────────────────────────────────────── */}
        <View style={{
          backgroundColor: "#0b0b16",
          borderWidth: 1,
          borderColor: activeColor + "30",
          borderRadius: 18,
          padding: 18,
          marginBottom: 16,
          gap: 16,
        }}>
          <Text style={{ color: "#505078", fontSize: 9, fontWeight: "900", letterSpacing: 1.5 }}>ADD A BLOCK</Text>

          {/* Type pills — colored active state */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
            {typeButtons.map((t) => {
              const active = blockType === t;
              const color  = TYPE_COLORS[t];
              return (
                <Pressable
                  key={t}
                  onPress={() => selectType(t)}
                  style={{
                    backgroundColor: active ? color + "18" : "#0e0e1a",
                    borderWidth:     1,
                    borderColor:     active ? color + "60" : "#1e1e2e",
                    borderRadius:    999,
                    paddingVertical: 8,
                    paddingHorizontal: 14,
                  }}
                >
                  <Text style={{
                    color:      active ? color : "#404060",
                    fontWeight: "800",
                    fontSize:   12,
                    letterSpacing: 0.2,
                  }}>
                    {t}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Label */}
          <View style={{ gap: 6 }}>
            <Text style={{ color: "#383858", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 }}>LABEL (OPTIONAL)</Text>
            <TextInput
              value={blockTitle}
              onChangeText={setBlockTitle}
              placeholder={LABEL_PLACEHOLDER[blockType]}
              placeholderTextColor="#252535"
              style={{
                backgroundColor: "#080810",
                borderWidth:      1,
                borderColor:      "#18182a",
                borderRadius:     12,
                padding:          12,
                color:            "#e0e0f0",
                fontSize:         14,
              }}
            />
          </View>

          {/* Time range */}
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={{ color: "#383858", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 }}>START</Text>
              <TextInput
                value={blockStart}
                onChangeText={setBlockStart}
                placeholder="9:00 AM"
                placeholderTextColor="#252535"
                style={{
                  backgroundColor: "#080810",
                  borderWidth:      1,
                  borderColor:      "#18182a",
                  borderRadius:     12,
                  padding:          12,
                  color:            "#d8d8f0",
                  fontSize:         14,
                  fontWeight:       "700",
                }}
              />
            </View>
            <Text style={{ color: "#252535", fontSize: 16, fontWeight: "700", paddingBottom: 12 }}>→</Text>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={{ color: "#383858", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 }}>END</Text>
              <TextInput
                value={blockEnd}
                onChangeText={setBlockEnd}
                placeholder="5:00 PM"
                placeholderTextColor="#252535"
                style={{
                  backgroundColor: "#080810",
                  borderWidth:      1,
                  borderColor:      "#18182a",
                  borderRadius:     12,
                  padding:          12,
                  color:            "#d8d8f0",
                  fontSize:         14,
                  fontWeight:       "700",
                }}
              />
            </View>
          </View>

          {/* Save */}
          <Pressable
            onPress={addBlock}
            style={{
              backgroundColor: activeColor + "18",
              borderWidth:      1,
              borderColor:      activeColor + "50",
              borderRadius:     12,
              paddingVertical:  13,
              alignItems:       "center",
            }}
          >
            <Text style={{ color: activeColor, fontWeight: "800", fontSize: 14, letterSpacing: 0.2 }}>
              Save block
            </Text>
          </Pressable>
        </View>

        {/* ── Block list ─────────────────────────────────────────────────────── */}
        {blocks.length > 0 ? (
          <View style={{ gap: 8, marginBottom: 16 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <Text style={{ color: "#5a5a88", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 }}>
                YOUR BLOCKS
              </Text>
              <Text style={{ color: "#282840", fontSize: 10, fontWeight: "600" }}>
                {blocks.length} window{blocks.length !== 1 ? "s" : ""} committed
              </Text>
            </View>

            {blocks.map((block) => {
              const color = TYPE_COLORS[block.type as BlockType] ?? "#555";
              return (
                <View
                  key={block.id}
                  style={{
                    backgroundColor: "#0b0b14",
                    borderWidth:      1,
                    borderColor:      "#1a1a28",
                    borderRadius:     14,
                    flexDirection:    "row",
                    overflow:         "hidden",
                  }}
                >
                  {/* Type accent bar */}
                  <View style={{ width: 4, backgroundColor: color + "70" }} />

                  {/* Content */}
                  <View style={{ flex: 1, paddingVertical: 13, paddingLeft: 13, paddingRight: 4, gap: 5 }}>
                    <Text style={{ color: "#d8d8f0", fontWeight: "800", fontSize: 14, letterSpacing: -0.2 }}>
                      {block.title}
                    </Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <View style={{
                        backgroundColor: color + "15",
                        borderRadius:     4,
                        paddingHorizontal: 6,
                        paddingVertical:   2,
                      }}>
                        <Text style={{ color: color + "b0", fontSize: 9, fontWeight: "900", letterSpacing: 0.8 }}>
                          {block.type.toUpperCase()}
                        </Text>
                      </View>
                      <Text style={{ color: "#3a3a58", fontSize: 11, fontWeight: "700" }}>
                        {block.startText} – {block.endText}
                      </Text>
                    </View>
                  </View>

                  {/* Delete */}
                  <Pressable
                    onPress={() => removeBlock(block.id)}
                    hitSlop={{ top: 14, bottom: 14, left: 8, right: 4 }}
                    style={{ justifyContent: "center", paddingHorizontal: 16 }}
                  >
                    <Text style={{ color: "#2a2a3e", fontSize: 15, fontWeight: "700" }}>✕</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        ) : (
          <View style={{
            backgroundColor: "#08080f",
            borderWidth:      1,
            borderColor:      "#111120",
            borderRadius:     14,
            paddingVertical:  24,
            paddingHorizontal: 20,
            alignItems:       "center",
            gap:              6,
            marginBottom:     16,
          }}>
            <Text style={{ color: "#252538", fontSize: 13, fontWeight: "700", textAlign: "center" }}>
              No blocks yet
            </Text>
            <Text style={{ color: "#1e1e2e", fontSize: 12, textAlign: "center", lineHeight: 18 }}>
              Add your first commitment and Aira will build your day around it.
            </Text>
          </View>
        )}

        {/* ── Plan connection CTA ─────────────────────────────────────────────── */}
        <Pressable
          onPress={() => {
            if (gamePlan) generateAIPlan();
            setOverlay(null);
          }}
          style={{
            backgroundColor: gamePlan ? ACCENT + "12" : "#080810",
            borderWidth:      1,
            borderColor:      gamePlan ? ACCENT + "38" : "#141422",
            borderRadius:     16,
            padding:          18,
            gap:              6,
            ...(gamePlan ? {
              shadowColor:   ACCENT,
              shadowOpacity: 0.1,
              shadowRadius:  14,
              shadowOffset:  { width: 0, height: 0 },
            } : {}),
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{
              color:        gamePlan ? ACCENT + "b0" : "#282840",
              fontSize:     9,
              fontWeight:   "900",
              letterSpacing: 1.4,
            }}>
              {gamePlan ? "READY TO BUILD" : "CHECK IN FIRST"}
            </Text>
            <Text style={{ color: gamePlan ? ACCENT + "60" : "#1e1e30", fontSize: 16, fontWeight: "700" }}>›</Text>
          </View>
          <Text style={{ color: gamePlan ? "#b0b0d0" : "#30304a", fontSize: 13, fontWeight: "700", lineHeight: 20 }}>
            {gamePlan
              ? `Generate your plan — Aira will build around your ${blocks.length > 0 ? `${blocks.length} committed block${blocks.length !== 1 ? "s" : ""}` : "day"}.`
              : "Complete your check-in on Today, then your schedule feeds directly into the plan."}
          </Text>
        </Pressable>

      </ScrollView>
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
          <Text style={styles.sub2}>{profile?.goals?.goalLabel ?? "Your goal"}</Text>

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

          {/* Weekly Momentum card */}
          {weeklyMomentum && (() => {
            const momentumMeta: Record<WeeklyMomentumStatus, { color: string; icon: string }> = {
              STRONG:   { color: "#4CAF50", icon: "▲" },
              BUILDING: { color: ACCENT,    icon: "◆" },
              SLIPPING: { color: "#FF5252", icon: "▼" },
            };
            const meta = momentumMeta[weeklyMomentum.status];
            return (
              <View style={{
                backgroundColor: "#070710",
                borderWidth: 1,
                borderColor: meta.color + "35",
                borderRadius: 16,
                padding: 18,
                gap: 10,
                shadowColor: meta.color,
                shadowOpacity: 0.06,
                shadowRadius: 14,
                shadowOffset: { width: 0, height: 0 },
              }}>
                {/* Header row */}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={{ color: "#505070", fontSize: 9, fontWeight: "900", letterSpacing: 1.6 }}>WEEKLY MOMENTUM</Text>
                  <View style={{
                    flexDirection: "row", alignItems: "center", gap: 5,
                    backgroundColor: meta.color + "18",
                    borderRadius: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                  }}>
                    <Text style={{ color: meta.color, fontSize: 9, fontWeight: "900" }}>{meta.icon}</Text>
                    <Text style={{ color: meta.color + "cc", fontSize: 9, fontWeight: "900", letterSpacing: 1 }}>
                      {weeklyMomentum.status}
                    </Text>
                  </View>
                </View>

                {/* Summary */}
                <Text style={{
                  color:       weeklyMomentum.status === "STRONG" ? "#c8e8c8" : weeklyMomentum.status === "SLIPPING" ? "#e8c8c8" : "#c8c8e8",
                  fontSize:    14,
                  fontWeight:  "700",
                  lineHeight:  21,
                  letterSpacing: -0.1,
                }}>
                  {weeklyMomentum.summary}
                </Text>

                {/* Focus directive */}
                <View style={{
                  flexDirection: "row", alignItems: "flex-start", gap: 8,
                  borderTopWidth: 1, borderTopColor: "#1a1a2c", paddingTop: 10,
                }}>
                  <Text style={{ color: meta.color + "60", fontSize: 11, fontWeight: "700", marginTop: 1 }}>→</Text>
                  <Text style={{ flex: 1, color: "#7070a0", fontSize: 12, fontWeight: "600", lineHeight: 18 }}>
                    {weeklyMomentum.focus}
                  </Text>
                </View>
              </View>
            );
          })()}

          {/* Today's performance */}
          <Card>
            <View style={styles.rowBetween}>
              <Text style={styles.label}>Today&apos;s performance</Text>
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
                  <Text style={styles.label}>Today&apos;s check-in</Text>
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
              <Text style={styles.label}>Today&apos;s insight</Text>
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
              name: profile?.profile?.firstName ?? "You",
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
    const [editName, setEditName] = useState(profile?.profile?.firstName ?? "");
    const [editGoal, setEditGoal] = useState(profile?.goals?.goalLabel ?? "");
    const [editWake, setEditWake] = useState(profile?.sleep?.wakeTime ?? "7:00 AM");
    const [editSleep, setEditSleep] = useState(profile?.sleep?.sleepTime ?? "11:00 PM");

    const saveProfile = () => {
      const base = profile!;
      const updatedProfile  = { ...base.profile, firstName: editName.trim() };
      const updatedGoals    = { ...base.goals,   goalLabel:  editGoal.trim() };
      const updatedSleep    = { ...base.sleep,   wakeTime:   editWake.trim(), sleepTime: editSleep.trim() };

      if (!updatedProfile.firstName) {
        Alert.alert("Name required", "Please enter your name.");
        return;
      }

      const sleepDur = sleepDurationMins(updatedSleep.sleepTime, updatedSleep.wakeTime);
      if (sleepDur == null) {
        Alert.alert("Time format issue", "Enter wake/sleep like '7:00 AM' or '11:30 PM'.");
        return;
      }
      if (sleepDur < 60) {
        Alert.alert("Sleep time issue", "Sleep window must be at least 1 hour.");
        return;
      }

      const { dataConfidenceScore, optionalFieldsSkipped } = computeProfileMeta({
        profile:  updatedProfile,
        goals:    updatedGoals,
        schedule: base.schedule,
      });

      const updated: Profile = {
        ...base,
        profile:  updatedProfile,
        goals:    updatedGoals,
        sleep:    updatedSleep,
        meta: {
          ...base.meta,
          lastUpdatedAt:        new Date().toISOString(),
          dataConfidenceScore,
          optionalFieldsSkipped,
        },
      };

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
                To enable, open your phone&apos;s Settings → Notifications → Expo Go and turn them on.
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
        {/* Overlays — Settings and Schedule accessed from Home, not from tab bar */}
        {overlay === "settings" && <Settings />}
        {overlay === "schedule" && <Schedule />}
        {/* Tab content — hidden when overlay is active */}
        {overlay === null && tab === "Home" && Today()}
        {overlay === null && tab === "Coach" && (
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
            bestStreak={streak.bestStreak}
            score={score}
            gamePlan={gamePlan}
            userContext={userContext}
            predictiveInsights={predictiveInsights}
            nextBestAction={nextBestAction}
            winCondition={winCondition}
            dayEvaluation={dayEvaluation}
            tomorrowPrep={tomorrowPrep}
            weeklyMomentum={weeklyMomentum}
            saveTheDay={saveTheDay}
            readinessState={readinessState}
            coachMode={coachMode}
            memoryContext={memoryContext}
            onPlanAction={handlePlanAction}
          />
        )}
        {overlay === null && tab === "Progress" && <Progress />}
      </View>
      <View style={styles.tabBar}>
        {/* Home */}
        <Pressable
          onPress={() => { setTab("Home"); setOverlay(null); }}
          style={({ pressed }) => [
            styles.tabBtn,
            tab === "Home" && overlay === null && styles.tabBtnActive,
            { opacity: pressed ? 0.72 : 1, transform: [{ scale: pressed ? 0.96 : 1 }] },
          ]}
        >
          <Text style={[styles.tabText, tab === "Home" && overlay === null && styles.tabTextActive]}>Home</Text>
        </Pressable>

        {/* Coach — elevated center tab */}
        <View style={{ flex: 1, alignItems: "center" }}>
          <Pressable
            onPress={() => { setTab("Coach"); setOverlay(null); }}
            style={({ pressed }) => ({
              marginTop:  -22,
              alignItems: "center",
              opacity:    pressed ? 0.85 : 1,
              transform:  [{ scale: pressed ? 0.95 : 1 }],
            })}
          >
            {/* Outer glow bloom — wide soft halo */}
            <View style={{
              position:      "absolute",
              top:           -6, left: -10, right: -10, bottom: -6,
              borderRadius:  26,
              shadowColor:   "#7B63FF",
              shadowOpacity: tab === "Coach" && overlay === null ? 0.72 : 0.36,
              shadowRadius:  tab === "Coach" && overlay === null ? 28 : 16,
              shadowOffset:  { width: 0, height: 4 },
              elevation:     12,
            }} />
            <LinearGradient
              colors={["#4f8ef7", "#7B63FF", "#c063e8"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{
                borderRadius:    18,
                paddingVertical: 11,
                paddingHorizontal: 24,
                alignItems:      "center",
                opacity:         tab === "Coach" && overlay === null ? 1 : 0.55,
              }}
            >
              <Text style={{ color: "#ffffff", fontWeight: "900", fontSize: 12, letterSpacing: 0.3 }}>Coach</Text>
            </LinearGradient>
          </Pressable>
        </View>

        {/* Progress */}
        <Pressable
          onPress={() => { setTab("Progress"); setOverlay(null); }}
          style={({ pressed }) => [
            styles.tabBtn,
            tab === "Progress" && overlay === null && styles.tabBtnActive,
            { opacity: pressed ? 0.72 : 1, transform: [{ scale: pressed ? 0.96 : 1 }] },
          ]}
        >
          <Text style={[styles.tabText, tab === "Progress" && overlay === null && styles.tabTextActive]}>Progress</Text>
        </Pressable>
      </View>

      {/* ---------- Workout detail modal ---------- */}
      <WorkoutDetailModal
        task={workoutTask}
        taskDone={tasks.find((t) => t.id === workoutTask?.id)?.done ?? false}
        visible={workoutTask !== null}
        onClose={() => setWorkoutTask(null)}
        onCompleteTask={(id) => toggleTaskById(id)}
        workoutPlan={generatedPlan?.workout}
      />

      {/* ---------- Nutrition detail modal ---------- */}
      <NutritionDetailModal
        task={nutritionTask}
        taskDone={tasks.find((t) => t.id === nutritionTask?.id)?.done ?? false}
        visible={nutritionTask !== null}
        onClose={() => setNutritionTask(null)}
        onCompleteTask={(id) => { toggleTaskById(id); }}
        nutritionPlan={generatedPlan?.nutrition}
      />

      {/* ---------- Recovery detail modal ---------- */}
      <RecoveryDetailModal
        task={recoveryTask}
        taskDone={tasks.find((t) => t.id === recoveryTask?.id)?.done ?? false}
        visible={recoveryTask !== null}
        onClose={() => setRecoveryTask(null)}
        onCompleteTask={(id) => { toggleTaskById(id); }}
        recoveryPlan={generatedPlan?.recovery}
      />

      {/* ---------- Habit detail modal ---------- */}
      <HabitDetailModal
        task={habitTask}
        taskDone={tasks.find((t) => t.id === habitTask?.id)?.done ?? false}
        visible={habitTask !== null}
        onClose={() => setHabitTask(null)}
        onToggle={(id) => { toggleTaskById(id); }}
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
                <Text style={styles.bodyMuted}>Good morning, {profile?.profile?.firstName ?? "Coach"}. 5 questions.</Text>
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
                    const newGamePlan = generateGamePlan(newRecovery);
                    setRecovery(newRecovery);
                    setGamePlan(newGamePlan);
                    setShowMotivation(false);
                    generateAIPlan(newRecovery, newGamePlan);
                    setTab("Home");
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