/**
 * shared/planner/contracts.ts
 *
 * Endpoint request/response contracts for the Aira Daily Planner API.
 *
 * Every endpoint follows a consistent envelope:
 *   Success → typed payload
 *   Error   → ApiError with a machine-readable ErrorCode
 *
 * The client uses isApiError() and isNotFound() to narrow response types
 * before accessing payload fields.
 *
 * Endpoint summary:
 *   POST   /api/planner/generate              → GeneratePlanResponse
 *   GET    /api/planner/:userId/:date         → FetchPlanResponse | NotFoundResponse
 *   PATCH  /api/planner/task/:taskId/complete → CompleteTaskResponse
 *   POST   /api/planner/regenerate            → RegeneratePlanResponse
 */

import type { DailyPlan, DailyTask, RegenerateReason } from "./types.js";
import type { RegeneratePlanInputData } from "./schemas.js";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planner/generate
//
// Body: PlannerInputData (validated by PlannerInputSchema)
// ─────────────────────────────────────────────────────────────────────────────

export interface GeneratePlanResponse {
  plan:  DailyPlan;
  tasks: DailyTask[];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/planner/:userId/:date
//
// Path params: userId (UUID), date (YYYY-MM-DD)
// Returns the stored plan for that user+date, or NotFoundResponse.
// ─────────────────────────────────────────────────────────────────────────────

export interface FetchPlanResponse {
  plan:  DailyPlan;
  tasks: DailyTask[];
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/planner/task/:taskId/complete
//
// Body: CompleteTaskBodyData (validated by CompleteTaskBodySchema)
// Enforces userId ownership — 403 if task.userId !== body.userId.
// ─────────────────────────────────────────────────────────────────────────────

export interface CompleteTaskResponse {
  task: DailyTask;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/planner/regenerate
//
// Re-generates the plan for the given userId + context.date using fresh input.
// Replaces the existing plan for that user:date; old plan is referenced via
// `previous.planId` in the response for audit/undo purposes.
//
// Body: RegeneratePlanInputData (PlannerInput + optional regenerateReason)
// ─────────────────────────────────────────────────────────────────────────────

export interface RegeneratePlanResponse {
  plan:      DailyPlan;
  tasks:     DailyTask[];
  /** The reason provided by the client, echoed back for confirmation. */
  reason:    RegenerateReason | null;
  /** Reference to the plan that was replaced. */
  previous?: { planId: string };
}

// Re-export for convenience so callers can import body type from contracts
export type { RegeneratePlanInputData };

// ─────────────────────────────────────────────────────────────────────────────
// Shared error envelope
// ─────────────────────────────────────────────────────────────────────────────

export enum ErrorCode {
  MissingInput     = "MISSING_INPUT",
  ValidationFailed = "VALIDATION_FAILED",
  AIOutputInvalid  = "AI_OUTPUT_INVALID",
  NotFound         = "NOT_FOUND",
  Forbidden        = "FORBIDDEN",
  ServerError      = "SERVER_ERROR",
}

export interface ApiError {
  error:    string;        // Human-readable message
  code:     ErrorCode;     // Machine-readable code for client branching
  details?: string;        // Optional debug context (omit in production)
}

export interface NotFoundResponse {
  notFound: true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type guards — narrow fetch responses before accessing payload fields
// ─────────────────────────────────────────────────────────────────────────────

export function isApiError(v: unknown): v is ApiError {
  return (
    typeof v === "object" &&
    v !== null &&
    "error" in v &&
    typeof (v as Record<string, unknown>).error === "string"
  );
}

export function isNotFound(v: unknown): v is NotFoundResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).notFound === true
  );
}

export function isPlanResponse(
  v: unknown
): v is FetchPlanResponse | GeneratePlanResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    "plan" in v &&
    "tasks" in v
  );
}
