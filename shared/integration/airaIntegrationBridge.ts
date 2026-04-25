/**
 * shared/integration/airaIntegrationBridge.ts
 *
 * Maps between the Aira Intelligence System output types and the app's
 * Today-screen types (AIPlan, TimedTask).
 *
 * This file is the ONLY integration boundary. app/index.tsx imports
 * generateLocalAiraPlan and replaces the old server call with it.
 *
 * ─── Mapping contracts ────────────────────────────────────────────────────────
 *
 * AiraIntelligencePlan → AIPlan
 *   id               "local_" + plan.generatedAt  (top-level field, not plan.metadata.generatedAt)
 *   date             today's YYYY-MM-DD
 *   summary          plan.summary          (experience layer coaching summary)
 *   coachingNote     plan.priorities[0] ?? plan.confidenceExplanation ?? plan.summary
 *   disciplineTarget plan.priorities[0] ?? plan.dailyFocus ?? fallback string
 *   fallbackPlan     static fallback — degraded mode note when applicable
 *   generatedAt      plan.metadata.generatedAt
 *
 * IntelligenceTask → TimedTask
 *   id               task.id               (deterministic; same input → same IDs)
 *   title            task.title
 *   kind             task.kind cast to TaskKind
 *   done             false                 (always fresh on generation)
 *   priority         mapPriority(task.priority) — "critical" → "high"
 *   timeText         task.scheduledTime ?? ""
 *   timeMin          parseScheduledTime(task.scheduledTime) with deterministic fallback
 *   exercises        task.metadata?.exercises ?? []
 *
 * ─── scheduledTime parsing ────────────────────────────────────────────────────
 *
 * Supports: "7:00 AM", "12:30 PM", "18:00" (24h), plain hour like "9 AM".
 * When absent or unparseable: deterministic fallback spacing starting at 7:00 AM
 * (420 min) +60 min per task index so sort order is stable and predictable.
 *
 * ─── Error handling ───────────────────────────────────────────────────────────
 *
 * generateLocalAiraPlan propagates AiraIntelligenceError on VALIDATION_FAILED.
 * Callers should catch AiraIntelligenceError and surface a degraded plan or
 * user-friendly error message. The app never crashes on this error.
 */

import type { AiraUserProfile }       from "../types/profile";
import type {
  AiraIntelligencePlan,
  AiraIntelligenceInput,
  IntelligenceTask,
}                                      from "../intelligence/types";
import type { DailyConditionOverride } from "../intelligence/types";
import { generateAiraIntelligencePlan } from "../intelligence/generateAiraIntelligencePlan";
import type { AIPlan, TimedTask, TaskKind, TaskPriority } from "../types/appTypes";

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a scheduled time string to minutes since midnight.
 *
 * Supported formats:
 *   "7:00 AM" | "12:30 PM" | "18:00" | "9 AM" | "9:00AM"
 *
 * Returns null when the string cannot be parsed.
 */
function parseScheduledTime(time: string): number | null {
  const raw = time.trim().toUpperCase();
  if (!raw) return null;

  const hasAm = raw.includes("AM");
  const hasPm = raw.includes("PM");

  // Strip all non-numeric / non-colon characters to extract digits
  let cleaned = raw.replace(/[^0-9:]/g, "");

  // Handle bare hour like "9" → "9:00"
  if (!cleaned.includes(":")) {
    if (cleaned.length <= 2) cleaned = `${cleaned}:00`;
    else if (cleaned.length === 4) cleaned = `${cleaned.slice(0, 2)}:${cleaned.slice(2)}`;
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
    if (hasAm) { if (hour === 12) hour = 0; }
    else        { if (hour !== 12) hour += 12; }
  } else {
    // 24-hour format
    if (hour < 0 || hour > 23) return null;
  }

  return hour * 60 + m;
}

/**
 * Map IntelligencePriority to TaskPriority.
 * "critical" is not a valid TaskPriority in the app — collapse to "high".
 */
function mapPriority(p: IntelligenceTask["priority"]): TaskPriority {
  if (p === "critical") return "high";
  return p as TaskPriority;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported mapping functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an AiraIntelligenceInput from a fully-normalised AiraUserProfile.
 *
 * @param profile   — AiraUserProfile from onboarding / AsyncStorage (already normalised).
 * @param condition — Optional same-day condition check-in (RecoveryData partial).
 */
export function buildAiraInput(
  profile:   AiraUserProfile,
  condition?: {
    energyLevel?:     "low" | "moderate" | "high" | null;
    soreness?:        "fresh" | "mild" | "sore" | null;
    motivationLevel?: "low" | "moderate" | "high" | null;
    timeAvailable?:   "minimal" | "moderate" | "full" | null;
    focusArea?:       "workout" | "nutrition" | "consistency" | "recovery" | null;
  },
): AiraIntelligenceInput {
  const dailyCondition: DailyConditionOverride | undefined = condition
    ? {
        energyLevel:     condition.energyLevel     ?? undefined,
        soreness:        condition.soreness        ?? undefined,
        motivationLevel: condition.motivationLevel ?? undefined,
        timeAvailable:   condition.timeAvailable   ?? undefined,
        focusArea:       condition.focusArea        ?? undefined,
      }
    : undefined;

  return {
    profile,
    date:           new Date().toISOString().slice(0, 10),
    dailyCondition: dailyCondition,
  };
}

/**
 * Map an AiraIntelligencePlan to the app's AIPlan metadata shape.
 */
export function mapAiraToAIPlan(plan: AiraIntelligencePlan): AIPlan {
  const firstPriority = plan.priorities[0] ?? "";
  return {
    id:               `local_${plan.generatedAt}`,
    date:             new Date().toISOString().slice(0, 10),
    summary:          plan.summary,
    coachingNote:     firstPriority || plan.confidenceExplanation || plan.summary,
    disciplineTarget: firstPriority || plan.dailyFocus || "Complete today's core habits.",
    fallbackPlan:     plan.metadata.degradedMode
      ? "Degraded mode: minimum viable day — hydration, light movement, and sleep target."
      : "Minimum viable day: hit your workout, reach your nutrition target, and sleep 8 hours.",
    generatedAt:      plan.generatedAt,
  };
}

/**
 * Map IntelligenceTask[] to TimedTask[] sorted by timeMin ascending.
 *
 * Tasks without a parseable scheduledTime receive deterministic fallback
 * times starting at 7:00 AM (420 min) + 60 min per task index, preserving
 * the planner's sort order without introducing non-determinism.
 */
export function mapAiraToTimedTasks(plan: AiraIntelligencePlan): TimedTask[] {
  const tasks = plan.tasks;

  // First pass: parse times; assign null where scheduledTime is absent/unparseable
  const withParsedTime: Array<{ task: IntelligenceTask; timeMin: number | null }> =
    tasks.map((task) => ({
      task,
      timeMin: task.scheduledTime ? parseScheduledTime(task.scheduledTime) : null,
    }));

  // Second pass: assign deterministic fallback to tasks with null timeMin.
  // Start at 7:00 AM (420). Step by 60 min per task to preserve order.
  let fallbackCursor = 420; // 7:00 AM
  const FALLBACK_STEP = 60;

  const timedTasks: TimedTask[] = withParsedTime.map(({ task, timeMin: parsed }) => {
    let timeMin: number;
    let timeText: string;

    if (parsed !== null) {
      timeMin  = parsed;
      timeText = task.scheduledTime ?? "";
    } else {
      timeMin  = fallbackCursor;
      timeText = task.scheduledTime ?? "";
      fallbackCursor += FALLBACK_STEP;
    }

    // Safely extract exercises from metadata
    let exercises: TimedTask["exercises"];
    const rawExercises = task.metadata?.exercises;
    if (Array.isArray(rawExercises) && rawExercises.length > 0) {
      exercises = rawExercises as TimedTask["exercises"];
    }

    return {
      id:        task.id,
      timeMin,
      timeText,
      title:     task.title,
      kind:      task.kind as TaskKind,
      done:      false,
      priority:  mapPriority(task.priority),
      ...(exercises ? { exercises } : {}),
    };
  });

  // Sort ascending by timeMin — preserves the planner's ordering when times are equal
  return timedTasks.sort((a, b) => a.timeMin - b.timeMin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main integration entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a local Aira Intelligence plan from a normalised user profile.
 *
 * Replaces the old POST /api/planner/generate server call.
 * Synchronous + deterministic — no network I/O, no randomness.
 *
 * @param profile   — AiraUserProfile (must be normalised via normalizeProfileForPlanning).
 * @param condition — Optional same-day condition check-in.
 * @returns { aiPlan, tasks, rawPlan }
 *   aiPlan  — AIPlan for setAiPlan()
 *   tasks   — TimedTask[] for setTasks(), sorted by timeMin
 *   rawPlan — AiraIntelligencePlan for debugging / observability
 *
 * @throws AiraIntelligenceError when profile validation fails (VALIDATION_FAILED).
 *   Callers should catch this and surface a user-friendly error. The app never
 *   crashes on this error; it falls back to the aiPlanError state.
 *
 * NOTE: Set DEV_MOCK_ENABLED = false in app/index.tsx to test this path in
 * development. The mock short-circuits plan generation when no plan is present.
 */
export function generateLocalAiraPlan(
  profile:   AiraUserProfile,
  condition?: {
    energyLevel?:     "low" | "moderate" | "high" | null;
    soreness?:        "fresh" | "mild" | "sore" | null;
    motivationLevel?: "low" | "moderate" | "high" | null;
    timeAvailable?:   "minimal" | "moderate" | "full" | null;
    focusArea?:       "workout" | "nutrition" | "consistency" | "recovery" | null;
  },
): {
  aiPlan:  AIPlan;
  tasks:   TimedTask[];
  rawPlan: AiraIntelligencePlan;
} {
  const input   = buildAiraInput(profile, condition);
  const rawPlan = generateAiraIntelligencePlan(input);
  const aiPlan  = mapAiraToAIPlan(rawPlan);
  const tasks   = mapAiraToTimedTasks(rawPlan);

  return { aiPlan, tasks, rawPlan };
}
