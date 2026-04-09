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
  CompleteTaskBodySchema,
  type PlannerInputData,
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

/**
 * Core AI call + validation pipeline.
 * Returns validated AI output or throws with a user-facing message.
 */
async function callAIPlanner(
  client: OpenAI,
  input:  PlannerInputData,
  mode:   PlannerMode
): Promise<ReturnType<typeof AIPlannerOutputSchema.parse>> {
  const systemPrompt = buildPlannerPrompt(input, mode);

  const completion = await client.chat.completions.create({
    model:           "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: "Generate today's plan." },
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

  // Normalize task kinds before validation — AI occasionally returns variants (e.g. "meal", "stretch")
  if (rawJson && typeof rawJson === "object" && Array.isArray((rawJson as Record<string, unknown>).tasks)) {
    (rawJson as Record<string, unknown>).tasks = (
      (rawJson as Record<string, unknown>).tasks as unknown[]
    ).map((t) =>
      t && typeof t === "object"
        ? { ...(t as object), kind: normalizeTaskKind((t as Record<string, unknown>).kind) }
        : t
    );
  }

  return AIPlannerOutputSchema.parse(rawJson); // throws ZodError on schema violation
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

    let aiOutput: ReturnType<typeof AIPlannerOutputSchema.parse>;
    try {
      aiOutput = await callAIPlanner(client, input, mode);
    } catch (err) {
      if (err instanceof ZodError) {
        return apiError(res, 502, ErrorCode.AIOutputInvalid, "AI output failed schema validation", formatZodError(err));
      }
      if (err instanceof Error && err.message === "__BAD_JSON__") {
        return apiError(res, 502, ErrorCode.AIOutputInvalid, "AI returned malformed JSON — please try again.");
      }
      throw err; // bubble to global error handler
    }

    const { plan, tasks } = buildRecords(input, aiOutput, mode);
    replacePlan(input.userId, input.context.date, plan, tasks);

    const body: GeneratePlanResponse = { plan, tasks };
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

    let aiOutput: ReturnType<typeof AIPlannerOutputSchema.parse>;
    try {
      aiOutput = await callAIPlanner(client, plannerInput, mode);
    } catch (err) {
      if (err instanceof ZodError) {
        return apiError(res, 502, ErrorCode.AIOutputInvalid, "AI output failed schema validation", formatZodError(err));
      }
      if (err instanceof Error && err.message === "__BAD_JSON__") {
        return apiError(res, 502, ErrorCode.AIOutputInvalid, "AI returned malformed JSON — please try again.");
      }
      throw err;
    }

    const { plan, tasks } = buildRecords(plannerInput, aiOutput, mode, {
      previousPlanId,
      regenerateReason: regenerateReason as RegenerateReason | undefined,
    });

    replacePlan(plannerInput.userId, plannerInput.context.date, plan, tasks);

    const body: RegeneratePlanResponse = {
      plan,
      tasks,
      reason:   (regenerateReason as RegenerateReason) ?? null,
      previous: previousPlanId ? { planId: previousPlanId } : undefined,
    };
    return res.status(201).json(body);
  });
}
