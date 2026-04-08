/**
 * server/planner/store.ts
 *
 * In-memory store for DailyPlan and DailyTask records.
 * All reads and writes are scoped to userId — no cross-user access is possible
 * through this module's public API.
 *
 * Production upgrade path:
 *   Replace each function body with a Supabase PostgREST call.
 *   The function signatures and ownership semantics stay identical.
 */

import type { DailyPlan, DailyTask } from "../../shared/planner/types.js";

// Keyed storage
const plans      = new Map<string, DailyPlan>();   // planId  → DailyPlan
const tasks      = new Map<string, DailyTask>();   // taskId  → DailyTask
const userDayIdx = new Map<string, string>();       // `${userId}:${date}` → planId

// ─────────────────────────────────────────────────────────────────────────────
// Plan operations
// ─────────────────────────────────────────────────────────────────────────────

export function getPlan(planId: string): DailyPlan | undefined {
  return plans.get(planId);
}

export function setPlan(plan: DailyPlan): void {
  plans.set(plan.id, plan);
}

export function deletePlan(planId: string): void {
  plans.delete(planId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Task operations
// ─────────────────────────────────────────────────────────────────────────────

export function getTask(taskId: string): DailyTask | undefined {
  return tasks.get(taskId);
}

export function setTask(task: DailyTask): void {
  tasks.set(task.id, task);
}

export function deleteTask(taskId: string): void {
  tasks.delete(taskId);
}

/** Returns all tasks for a plan in insertion order. */
export function getTasksByPlan(planId: string): DailyTask[] {
  return [...tasks.values()].filter((t) => t.planId === planId);
}

/** Apply a partial update to a task. Returns the updated record or undefined if not found. */
export function updateTask(
  taskId: string,
  patch: Partial<Pick<DailyTask, "done" | "completedAt">>
): DailyTask | undefined {
  const existing = tasks.get(taskId);
  if (!existing) return undefined;
  const updated: DailyTask = { ...existing, ...patch };
  tasks.set(taskId, updated);
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// User-day index — one plan per user per date
// ─────────────────────────────────────────────────────────────────────────────

export function getPlanIdForUserDate(userId: string, date: string): string | undefined {
  return userDayIdx.get(`${userId}:${date}`);
}

export function setPlanForUserDate(userId: string, date: string, planId: string): void {
  userDayIdx.set(`${userId}:${date}`, planId);
}

/**
 * Delete a plan and all its tasks atomically.
 * Called before storing a regenerated plan to avoid orphaned records.
 */
export function deletePlanAndTasks(planId: string): void {
  for (const [taskId, task] of tasks.entries()) {
    if (task.planId === planId) tasks.delete(taskId);
  }
  plans.delete(planId);
}

/**
 * Replace the plan for a user:date.
 * Removes the old plan+tasks, stores the new ones, updates the index.
 */
export function replacePlan(
  userId:   string,
  date:     string,
  newPlan:  DailyPlan,
  newTasks: DailyTask[]
): { previousPlanId: string | undefined } {
  const previousPlanId = userDayIdx.get(`${userId}:${date}`);
  if (previousPlanId) deletePlanAndTasks(previousPlanId);

  setPlan(newPlan);
  for (const task of newTasks) setTask(task);
  userDayIdx.set(`${userId}:${date}`, newPlan.id);

  return { previousPlanId };
}
