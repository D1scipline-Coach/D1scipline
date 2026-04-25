/**
 * server/planner/routes.ts
 *
 * Express route handlers for all four Aira Planner endpoints.
 * Each handler follows the same pipeline:
 *
 *   1. Validate request body/params with Zod (returns 400 on failure)
 *   2. Call AI (generate/regenerate only)
 *   3. Parse AI JSON (returns 502 on malformed JSON)
 *   4. Validate AI output with AIPlannerOutputSchema (returns 502 on schema failure)
 *   5. Transform into DailyPlan + DailyTask records (sanitized, stable IDs)
 *   6. Persist to store
 *   7. Return typed response
 *
 * Raw AI output never passes step 4. The client always receives validated,
 * server-assigned records — never model text directly.
 */

import crypto from "crypto";
import type { Router, Request, Response } from "express";
import type OpenAI from "openai";
import { ZodError } from "zod";

import {
  PlannerInputSchema,
  RegeneratePlanInputSchema,
  AIPlannerOutputSchema,
  MultiDayAIPlannerOutputSchema,
  CompleteTaskBodySchema,
  type PlannerInputData,
  type AIProgramDayData,
} from "../../shared/planner/schemas.js";
import {
  PlannerMode,
  RegenerateReason,
  type DailyPlan,
  type DailyTask,
  type TaskKind,
  type TaskPriority,
} from "../../shared/planner/types.js";
import {
  ErrorCode,
  type ApiError,
  type GeneratePlanResponse,
  type FetchPlanResponse,
  type CompleteTaskResponse,
  type RegeneratePlanResponse,
} from "../../shared/planner/contracts.js";
import { buildPlannerPrompt } from "./promptBuilder.js";
import { replacePlan, getPlan, getPlanIdForUserDate, getTasksByPlan, getTask, updateTask } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize AI-returned task kind to the exact enum value.
 * The AI occasionally returns case variants or synonyms (e.g. "meal", "workout", "stretch").
 * This mapping converts near-matches before Zod validation so valid plans aren't rejected.
 */
function normalizeTaskKind(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const s = raw.trim();
  const lower = s.toLowerCase();
  const exact = ["Workout","Nutrition","Hydration","Mobility","Recovery","Habit","Sleep"];
  if (exact.includes(s)) return s;
  if (lower === "workout" || lower === "exercise" || lower === "training" || lower === "gym" || lower === "weightlifting" || lower === "lifting") return "Workout";
  if (lower === "nutrition" || lower === "meal" || lower === "meals" || lower === "eating" || lower === "food" || lower === "diet" || lower === "breakfast" || lower === "lunch" || lower === "dinner") return "Nutrition";
  if (lower === "hydration" || lower === "water" || lower === "drinking" || lower === "fluids" || lower === "drink") return "Hydration";
  if (lower === "mobility" || lower === "stretching" || lower === "stretch" || lower === "flexibility" || lower === "yoga" || lower === "foam rolling") return "Mobility";
  if (lower === "recovery" || lower === "rest" || lower === "foam roll" || lower === "breathwork" || lower === "walk" || lower === "walking" || lower === "active recovery") return "Recovery";
  if (lower === "habit" || lower === "routine" || lower === "daily habit" || lower === "mindset" || lower === "journaling" || lower === "meditation") return "Habit";
  if (lower === "sleep" || lower === "bedtime" || lower === "wind-down" || lower === "wind down" || lower === "sleep prep" || lower === "night routine") return "Sleep";
  return s; // let Zod catch truly unknown values
}

/** Strip HTML and enforce max length. Applies to all AI-sourced strings. */
function sanitize(value: unknown, maxLen = 500): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, maxLen);
}

function apiError(res: Response, status: number, code: ErrorCode, message: string, details?: string): Response {
  const body: ApiError = { error: message, code, ...(details ? { details } : {}) };
  return res.status(status).json(body);
}

function formatZodError(err: ZodError): string {
  return err.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Time-slot assignment — post-process AI tasks to fix busy-block conflicts
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "9:00 AM" / "14:30" → minutes since midnight. Returns null on failure. */
function parseMin(t: string): number | null {
  const upper = t.trim().toUpperCase();
  const hasPM = upper.includes("PM");
  const hasAM = upper.includes("AM");
  const clean = upper.replace(/[AP]M/, "").trim();
  const parts = clean.split(":").map(Number);
  if (parts.some(isNaN) || !parts.length) return null;
  let [h, m = 0] = parts;
  if (hasPM && h !== 12) h += 12;
  if (hasAM && h === 12) h = 0;
  return h * 60 + m;
}

/** Format minutes since midnight as "9:00 AM" — matches AI output format. */
function fmtTaskTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const suf = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${suf}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Window scoring — priority-aware slot selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a candidate slot start within a free window.
 * Higher = better placement for this task kind.
 *
 * Workout  : strongly prefers morning + large windows; penalises late-night.
 * Hydration: prefers small leftover windows (doesn't waste prime morning time).
 * Others   : mildly prefer earlier, moderately sized windows.
 */
function scoreSlot(
  slotStart:  number, // candidate start (minutes since midnight)
  windowSize: number, // total size of the containing free window
  kind:       string,
  dayLen:     number, // sleep − wake
  sleep:      number
): number {
  const timeScore = dayLen > 0 ? (sleep - slotStart) / dayLen : 0.5; // 1.0 at dawn → 0.0 at sleep
  const sizeScore = Math.min(windowSize / 120, 1.0);                  // capped at 2-hr window

  switch (kind) {
    case "Workout": {
      const morningBonus     = slotStart < 12 * 60 ? 0.5  : 0;  // before noon
      const lateNightPenalty = slotStart >= 20 * 60 ? -0.8 : 0; // after 8 PM
      const bufferBonus      = windowSize >= 75     ? 0.3  : 0;  // fits workout + 30 min
      return timeScore * 0.5 + sizeScore * 0.3 + morningBonus + bufferBonus + lateNightPenalty;
    }
    case "Hydration":
      // Small task: prefer using up small leftover gaps rather than wasting prime windows
      return (1 - sizeScore) * 0.5 + timeScore * 0.1;
    default:
      // Nutrition, Mobility, Recovery, Habit: mildly earlier + moderately sized
      return timeScore * 0.4 + sizeScore * 0.2;
  }
}

/**
 * Find the highest-scoring valid start minute across all free windows.
 *
 * For each window: tries to start at `preferred` (AI-intended time) clamped
 * to the window, then falls back to window start. Advances past already-placed
 * tasks with a GAP-minute buffer. Scores each candidate and returns the best.
 *
 * Returns null if no window can accommodate the task.
 */
function findBestSlot(
  preferred: number,
  duration:  number,
  kind:      string,
  free:      Array<{ s: number; e: number }>,
  placed:    Array<{ s: number; e: number }>,
  gap:       number,
  wake:      number,
  sleep:     number
): number | null {
  const dayLen = Math.max(1, sleep - wake);
  let bestMin:   number | null = null;
  let bestScore: number = -Infinity;

  for (const w of free) {
    // Attempt two starting points: at or after the AI's preferred time, then window start
    const candidates = [Math.max(preferred, w.s), w.s];

    for (const start of candidates) {
      if (start + duration > w.e) continue;

      // Advance past any placed tasks that would overlap (with GAP padding)
      let slot = start;
      let advanced = true;
      while (advanced) {
        advanced = false;
        for (const p of placed) {
          if (slot < p.e + gap && slot + duration > p.s) {
            slot = p.e + gap;
            advanced = true;
          }
        }
      }

      if (slot + duration > w.e) continue; // can't fit after staggering

      const score = scoreSlot(slot, w.e - w.s, kind, dayLen, sleep);
      if (score > bestScore) {
        bestScore = score;
        bestMin   = slot;
      }
      break; // only score the earliest valid slot per window
    }
  }

  return bestMin;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post-process AI-generated tasks to ensure every task falls inside a free
 * window and is placed in the best available slot for its kind.
 *
 * Processing order: high-priority tasks first, Sleep always last.
 *
 * Per-task strategy:
 *   Workout tasks      → always run best-window selection (even if AI time is valid)
 *                         so workouts consistently land in the strongest slot.
 *   All other tasks    → keep AI time when already conflict-free; run best-window
 *                         selection only when the AI time falls inside a busy block.
 *   Sleep tasks        → never moved (kept at AI-assigned time).
 *   No valid slot found → fall back to AI time (plan stays coherent).
 */
function assignTimeslots(
  aiOutput: ReturnType<typeof AIPlannerOutputSchema.parse>,
  input:    PlannerInputData
): ReturnType<typeof AIPlannerOutputSchema.parse> {
  // Fast path: no schedule blocks → no conflicts and no reordering needed
  if (!input.schedule.blocks.length) return aiOutput;

  const WAKE  = parseMin(input.profile.wake)  ?? 6  * 60;
  const SLEEP = parseMin(input.profile.sleep) ?? 22 * 60;

  // Parse and validate busy blocks
  const busy = input.schedule.blocks
    .map((b) => ({ s: parseMin(b.start) ?? -1, e: parseMin(b.end) ?? -1 }))
    .filter((b) => b.s >= 0 && b.e > b.s)
    .sort((a, b) => a.s - b.s);

  if (!busy.length) return aiOutput;

  // Build free windows (gaps > 15 min, anchored to user's wake/sleep)
  const free: Array<{ s: number; e: number }> = [];
  let cur = WAKE;
  for (const b of busy) {
    if (b.s - cur > 15) free.push({ s: cur, e: b.s });
    cur = Math.max(cur, b.e);
  }
  if (SLEEP - cur > 15) free.push({ s: cur, e: SLEEP });

  if (!free.length) return aiOutput; // entire day blocked — keep AI plan as-is

  // Estimated task durations (minutes)
  const DUR: Record<string, number> = {
    Workout: 45, Nutrition: 20, Hydration: 5,
    Mobility: 15, Recovery: 20, Habit: 10, Sleep: 0,
  };
  const GAP = 5; // minimum spacing between adjacent tasks (minutes)

  // Process order: high-priority tasks first, Sleep always last
  const PRIO: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const ordered = aiOutput.tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      if (a.t.kind === "Sleep") return 1;
      if (b.t.kind === "Sleep") return -1;
      const pd = (PRIO[a.t.priority] ?? 1) - (PRIO[b.t.priority] ?? 1);
      if (pd !== 0) return pd;
      return (parseMin(a.t.timeText) ?? WAKE) - (parseMin(b.t.timeText) ?? WAKE);
    });

  const placed:    Array<{ s: number; e: number }> = [];
  const overrides  = new Map<number, string>(); // task index → corrected timeText

  for (const { t, i } of ordered) {
    if (t.kind === "Sleep") continue; // Sleep tasks always stay at AI time

    const dur = DUR[t.kind] ?? 15;
    const ai  = parseMin(t.timeText) ?? WAKE + 60;

    const inFree  = free.some((w) => ai >= w.s && ai + dur <= w.e);
    const noClash = !placed.some((p) => ai < p.e + GAP && ai + dur > p.s);

    // Non-Workout tasks that are already conflict-free: keep at AI time.
    // Workout tasks always go through best-window selection.
    if (t.kind !== "Workout" && inFree && noClash) {
      placed.push({ s: ai, e: ai + dur });
      continue;
    }

    // Find the best available slot using window scoring
    const best = findBestSlot(ai, dur, t.kind, free, placed, GAP, WAKE, SLEEP);

    if (best !== null) {
      if (best !== ai) overrides.set(i, fmtTaskTime(best));
      placed.push({ s: best, e: best + dur });
    } else {
      // No valid slot found — keep original AI time (plan stays coherent)
      placed.push({ s: ai, e: ai + dur });
    }
  }

  if (!overrides.size) return aiOutput; // nothing changed

  return {
    ...aiOutput,
    tasks: aiOutput.tasks.map((t, i) => {
      const newTime = overrides.get(i);
      return newTime ? { ...t, timeText: newTime } : t;
    }),
  };
}

/**
 * Derive PlannerMode from the validated input.
 * Extension point: add additional conditions (memory signals, explicit mode field).
 */
function selectPlannerMode(input: PlannerInputData): PlannerMode {
  const gp = input.context.gamePlan;
  if (!gp) return PlannerMode.Standard;
  if (gp.readiness === "Recover")                 return PlannerMode.Recovery;
  if (gp.timeMode  === "Minimal")                 return PlannerMode.Minimal;
  if (input.condition.focusArea === "nutrition")  return PlannerMode.Nutrition;
  return PlannerMode.Standard;
}

// Internal normalized AI output — always has `days`, regardless of single- or multi-day format
type NormalizedAIOutput = {
  summary:          string;
  coachingNote:     string;
  disciplineTarget: string;
  fallbackPlan:     string;
  days:             AIProgramDayData[];
};

/**
 * Core AI call + validation pipeline.
 *
 * Handles two AI output formats:
 *   Multi-day  { summary, ..., days: [{ dayIndex, tasks }] }  ← Standard prompt
 *   Single-day { summary, ..., tasks: [...] }                  ← Recovery/Minimal/Nutrition prompts
 *
 * Always returns NormalizedAIOutput with a `days` array (min 1 day).
 * Single-day responses are wrapped as days[{ dayIndex: 0, tasks }].
 */
async function callAIPlanner(
  client: OpenAI,
  input:  PlannerInputData,
  mode:   PlannerMode
): Promise<NormalizedAIOutput> {
  const systemPrompt = buildPlannerPrompt(input, mode);

  const completion = await client.chat.completions.create({
    model:           "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: "Generate the plan." },
    ],
    temperature:     0.5,
    response_format: { type: "json_object" },
  });

  const rawText = completion.choices?.[0]?.message?.content?.trim() ?? "{}";

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    throw new Error("__BAD_JSON__");
  }

  // Normalize task kinds in all days AND in the flat tasks array (covers both formats)
  if (rawJson && typeof rawJson === "object") {
    const json = rawJson as Record<string, unknown>;

    // Multi-day format: normalize tasks inside each day
    if (Array.isArray(json.days)) {
      json.days = json.days.map((day: unknown) => {
        if (!day || typeof day !== "object") return day;
        const d = { ...(day as Record<string, unknown>) };
        if (Array.isArray(d.tasks)) {
          d.tasks = (d.tasks as unknown[]).map((t) =>
            t && typeof t === "object"
              ? { ...(t as object), kind: normalizeTaskKind((t as Record<string, unknown>).kind) }
              : t
          );
        }
        return d;
      });
    }

    // Single-day format fallback: normalize flat tasks array
    if (Array.isArray(json.tasks)) {
      json.tasks = (json.tasks as unknown[]).map((t) =>
        t && typeof t === "object"
          ? { ...(t as object), kind: normalizeTaskKind((t as Record<string, unknown>).kind) }
          : t
      );
    }
  }

  // Try multi-day format first (Standard prompt)
  const isMultiDay = rawJson && typeof rawJson === "object" &&
    Array.isArray((rawJson as Record<string, unknown>).days);

  if (isMultiDay) {
    // Validate strictly — if the AI returned days, it must conform to the multi-day schema
    const parsed = MultiDayAIPlannerOutputSchema.parse(rawJson); // throws ZodError on violation
    return parsed;
  }

  // Fall back to single-day format (Recovery / Minimal / Nutrition prompts)
  const single = AIPlannerOutputSchema.parse(rawJson); // throws ZodError on violation
  return {
    summary:          single.summary,
    coachingNote:     single.coachingNote,
    disciplineTarget: single.disciplineTarget,
    fallbackPlan:     single.fallbackPlan,
    days:             [{ dayIndex: 0, tasks: single.tasks }],
  };
}

/**
 * Transform validated AI output into DailyPlan + DailyTask records.
 * Assigns server-controlled IDs — AI-supplied IDs are discarded.
 */
function buildRecords(
  input:     PlannerInputData,
  aiOutput:  ReturnType<typeof AIPlannerOutputSchema.parse>,
  mode:      PlannerMode,
  options:   { previousPlanId?: string; regenerateReason?: RegenerateReason } = {}
): { plan: DailyPlan; tasks: DailyTask[] } {
  const planId = crypto.randomUUID();
  const date   = input.context.date;

  const plan: DailyPlan = {
    id:               planId,
    userId:           input.userId,
    date,
    summary:          sanitize(aiOutput.summary),
    coachingNote:     sanitize(aiOutput.coachingNote),
    disciplineTarget: sanitize(aiOutput.disciplineTarget),
    fallbackPlan:     sanitize(aiOutput.fallbackPlan),
    generatedAt:      new Date().toISOString(),
    mode,
    ...(options.previousPlanId  ? { previousPlanId: options.previousPlanId }   : {}),
    ...(options.regenerateReason ? { regenerateReason: options.regenerateReason } : {}),
  };

  const tasks: DailyTask[] = aiOutput.tasks.map((t, i) => ({
    id:          `${planId}_t${i}`,
    planId,
    userId:      input.userId,
    date,
    timeText:    sanitize(t.timeText, 20),
    title:       sanitize(t.title, 200),
    kind:        t.kind as TaskKind,
    priority:    t.priority as TaskPriority,
    rationale:   sanitize(t.rationale, 400),
    done:        false,
    completedAt: null,
  }));

  return { plan, tasks };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerPlannerRoutes(router: Router, client: OpenAI): void {

  // ── POST /api/planner/generate ─────────────────────────────────────────────
  router.post("/generate", async (req: Request, res: Response) => {
    const parsed = PlannerInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, ErrorCode.ValidationFailed, "Invalid request", formatZodError(parsed.error));
    }

    const input = parsed.data;
    const mode  = selectPlannerMode(input);

    let normalized: NormalizedAIOutput;
    try {
      normalized = await callAIPlanner(client, input, mode);
    } catch (err) {
      if (err instanceof ZodError) {
        return apiError(res, 502, ErrorCode.AIOutputInvalid, "AI output failed schema validation", formatZodError(err));
      }
      if (err instanceof Error && err.message === "__BAD_JSON__") {
        return apiError(res, 502, ErrorCode.AIOutputInvalid, "AI returned malformed JSON — please try again.");
      }
      throw err; // bubble to global error handler
    }

    // Post-process: run timeslot assignment per day (same schedule applies to all days)
    const processedDays = normalized.days.map((day) => {
      const singleDayShape = {
        summary: normalized.summary, coachingNote: normalized.coachingNote,
        disciplineTarget: normalized.disciplineTarget, fallbackPlan: normalized.fallbackPlan,
        tasks: day.tasks,
      } as ReturnType<typeof AIPlannerOutputSchema.parse>;
      const adjusted = assignTimeslots(singleDayShape, input);
      return { dayIndex: day.dayIndex, purpose: day.purpose, tasks: adjusted.tasks };
    });

    // Day 0 → existing DailyPlan + DailyTask records (backward-compatible store format)
    const day0 = processedDays.find((d) => d.dayIndex === 0) ?? processedDays[0];
    const day0Shape = {
      summary: normalized.summary, coachingNote: normalized.coachingNote,
      disciplineTarget: normalized.disciplineTarget, fallbackPlan: normalized.fallbackPlan,
      tasks: day0.tasks,
    } as ReturnType<typeof AIPlannerOutputSchema.parse>;
    const { plan, tasks } = buildRecords(input, day0Shape, mode);
    replacePlan(input.userId, input.context.date, plan, tasks);

    // Include all days in response so the client can populate programPlan
    const body = { plan, tasks, days: processedDays };
    return res.status(201).json(body);
  });

  // ── GET /api/planner/:userId/:date ─────────────────────────────────────────
  router.get("/:userId/:date", (req: Request, res: Response) => {
    const { userId, date } = req.params as { userId: string; date: string };

    if (!userId || !date) {
      return apiError(res, 400, ErrorCode.MissingInput, "Missing userId or date");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return apiError(res, 400, ErrorCode.ValidationFailed, "date must be YYYY-MM-DD");
    }

    const planId = getPlanIdForUserDate(userId, date);
    if (!planId) return res.status(404).json({ notFound: true });

    const plan = getPlan(planId);
    if (!plan) return res.status(404).json({ notFound: true });

    // Ownership check — defensive guard against store inconsistency
    if (plan.userId !== userId) {
      return apiError(res, 403, ErrorCode.Forbidden, "Forbidden");
    }

    const tasks = getTasksByPlan(planId);
    const body: FetchPlanResponse = { plan, tasks };
    return res.json(body);
  });

  // ── PATCH /api/planner/task/:taskId/complete ───────────────────────────────
  router.patch("/task/:taskId/complete", (req: Request, res: Response) => {
    const { taskId } = req.params as { taskId: string };

    const parsed = CompleteTaskBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, ErrorCode.ValidationFailed, "Invalid request body", formatZodError(parsed.error));
    }

    const { userId, done } = parsed.data;

    const task = getTask(taskId);
    if (!task) {
      return apiError(res, 404, ErrorCode.NotFound, "Task not found");
    }
    if (task.userId !== userId) {
      return apiError(res, 403, ErrorCode.Forbidden, "Forbidden");
    }

    const updated = updateTask(taskId, {
      done,
      completedAt: done ? new Date().toISOString() : null,
    });

    const body: CompleteTaskResponse = { task: updated! };
    return res.json(body);
  });

  // ── POST /api/planner/regenerate ───────────────────────────────────────────
  router.post("/regenerate", async (req: Request, res: Response) => {
    const parsed = RegeneratePlanInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, ErrorCode.ValidationFailed, "Invalid request", formatZodError(parsed.error));
    }

    const { regenerateReason, ...plannerInput } = parsed.data;
    const mode = selectPlannerMode(plannerInput);

    // Capture the previous plan ID before overwriting
    const previousPlanId = getPlanIdForUserDate(plannerInput.userId, plannerInput.context.date);

    let normalized: NormalizedAIOutput;
    try {
      normalized = await callAIPlanner(client, plannerInput, mode);
    } catch (err) {
      if (err instanceof ZodError) {
        return apiError(res, 502, ErrorCode.AIOutputInvalid, "AI output failed schema validation", formatZodError(err));
      }
      if (err instanceof Error && err.message === "__BAD_JSON__") {
        return apiError(res, 502, ErrorCode.AIOutputInvalid, "AI returned malformed JSON — please try again.");
      }
      throw err;
    }

    // Post-process: run timeslot assignment per day
    const processedDays = normalized.days.map((day) => {
      const singleDayShape = {
        summary: normalized.summary, coachingNote: normalized.coachingNote,
        disciplineTarget: normalized.disciplineTarget, fallbackPlan: normalized.fallbackPlan,
        tasks: day.tasks,
      } as ReturnType<typeof AIPlannerOutputSchema.parse>;
      const adjusted = assignTimeslots(singleDayShape, plannerInput);
      return { dayIndex: day.dayIndex, purpose: day.purpose, tasks: adjusted.tasks };
    });

    const day0 = processedDays.find((d) => d.dayIndex === 0) ?? processedDays[0];
    const day0Shape = {
      summary: normalized.summary, coachingNote: normalized.coachingNote,
      disciplineTarget: normalized.disciplineTarget, fallbackPlan: normalized.fallbackPlan,
      tasks: day0.tasks,
    } as ReturnType<typeof AIPlannerOutputSchema.parse>;
    const { plan, tasks } = buildRecords(plannerInput, day0Shape, mode, {
      previousPlanId,
      regenerateReason: regenerateReason as RegenerateReason | undefined,
    });

    replacePlan(plannerInput.userId, plannerInput.context.date, plan, tasks);

    const body = {
      plan, tasks, days: processedDays,
      reason:   (regenerateReason as RegenerateReason) ?? null,
      previous: previousPlanId ? { planId: previousPlanId } : undefined,
    };
    return res.status(201).json(body);
  });
}
