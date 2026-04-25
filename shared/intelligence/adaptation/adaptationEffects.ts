/**
 * shared/intelligence/adaptation/adaptationEffects.ts
 *
 * Signal → Effect mapping for the Phase 5 active adaptation system.
 *
 * ─── Design ──────────────────────────────────────────────────────────────────
 *
 * ADAPTATION_EFFECTS maps each signal type (from deriveAdaptationSignals) to a
 * typed AdaptationEffect describing what structural adjustments are requested.
 *
 * deriveAdaptationEffects() aggregates signals from a full AdaptationContext
 * into one merged AdaptationEffect, applying deterministic conflict resolution:
 *   - Boolean flags: any true → merged value is true.
 *   - capIntensity:  safer (lower) value wins.
 *   - capPriority:   safer (lower) value wins.
 *
 * Merge priority order for conflict resolution (most restrictive wins):
 *   recovery > sleep > workout > nutrition > planner
 *
 * ─── Rules ───────────────────────────────────────────────────────────────────
 *
 * - Deterministic: same signals → same effect, always.
 * - No randomness, no ML, no external calls.
 * - Returns empty object ({}) when context is undefined or has no signals.
 * - Never throws.
 *
 * ─── Effect scope ─────────────────────────────────────────────────────────────
 *
 * Engines consume effects for ADDITIVE text only (reasoning, recommendations).
 * Engines MUST NOT change plan values (intensityLevel, durationMins, etc.).
 * The Planner Engine owns ALL structural changes (priority caps, task removal).
 */

import type { AdaptationContext, AdaptationEffect } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Signal → Effect mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps signal types (from deriveAdaptationSignals) to their requested effects.
 *
 * Signal types come from Phase 5 Prompt #1 taxonomy:
 *   recovery: reduce_intensity_due_to_soreness, stress_management_needed, recovery_load_warning
 *   sleep:    improve_sleep_consistency, sleep_consistency_risk
 *   workout:  reduce_training_load, workout_consistency_risk, increase_training_challenge
 *   nutrition: improve_meal_consistency
 *   planner:  plan_stability_warning, simplify_daily_plan, increase_structure_support
 */
export const ADAPTATION_EFFECTS: Readonly<Record<string, AdaptationEffect>> = {

  // ── Recovery signals ────────────────────────────────────────────────────────

  reduce_intensity_due_to_soreness: {
    workout:  { reduceVolume: true, reduceIntensity: true, capPriority: "medium" },
    recovery: { increasePriority: true, addProtocol: true },
    planner:  { enforceRecoveryBias: true, capIntensity: "medium" },
  },

  stress_management_needed: {
    recovery: { increasePriority: true, addProtocol: true },
    sleep:    { enforceWindDown: true },
    planner:  { reduceTaskCount: true, enforceRecoveryBias: true },
  },

  recovery_load_warning: {
    // Recovery completion is low — simplify (don't add more protocols)
    planner: { simplifyStructure: true },
  },

  // ── Sleep signals ───────────────────────────────────────────────────────────

  improve_sleep_consistency: {
    sleep:   { enforceWindDown: true, increaseSleepTarget: true },
    workout: { reduceVolume: true },
    planner: { enforceRecoveryBias: true },
  },

  sleep_consistency_risk: {
    sleep:   { enforceWindDown: true },
    planner: { simplifyStructure: true },
  },

  // ── Workout signals ─────────────────────────────────────────────────────────

  reduce_training_load: {
    workout: { reduceVolume: true, reduceIntensity: true, capPriority: "medium" },
    planner: { reduceTaskCount: true, capIntensity: "medium" },
  },

  workout_consistency_risk: {
    workout: { reduceVolume: true },
    planner: { simplifyStructure: true, reduceTaskCount: true },
  },

  // Positive signal — no structural effects
  increase_training_challenge: {},

  // ── Nutrition signals ────────────────────────────────────────────────────────

  improve_meal_consistency: {
    nutrition: { simplifyPlan: true, increaseProteinFocus: true, increaseHydrationFocus: true },
    planner:   { simplifyStructure: true },
  },

  // ── Planner signals ──────────────────────────────────────────────────────────

  plan_stability_warning: {
    planner: { reduceTaskCount: true, simplifyStructure: true },
  },

  simplify_daily_plan: {
    planner: { reduceTaskCount: true, simplifyStructure: true },
  },

  increase_structure_support: {
    planner: { simplifyStructure: true },
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Effect derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a single merged AdaptationEffect from all signals in an adaptation context.
 *
 * Processing order within each domain (most restrictive wins for cap fields):
 *   recovery → sleep → workout → nutrition → planner
 *
 * @param context — AdaptationContext from buildAdaptationContext(), or undefined.
 * @returns       — Merged AdaptationEffect. Empty object when context is absent.
 */
export function deriveAdaptationEffects(
  context: AdaptationContext | undefined,
): AdaptationEffect {
  if (!context || context.signals.length === 0) return {};

  const merged: AdaptationEffect = {};

  for (const signal of context.signals) {
    const effect = ADAPTATION_EFFECTS[signal.type];
    if (!effect) continue;
    mergeInto(merged, effect);
  }

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Merge source effect into target, in place. Safer values win for cap fields. */
function mergeInto(target: AdaptationEffect, source: AdaptationEffect): void {
  if (source.planner) {
    target.planner ??= {};
    if (source.planner.reduceTaskCount)     target.planner.reduceTaskCount     = true;
    if (source.planner.enforceRecoveryBias) target.planner.enforceRecoveryBias = true;
    if (source.planner.simplifyStructure)   target.planner.simplifyStructure   = true;
    if (source.planner.capIntensity) {
      target.planner.capIntensity = saferCap(
        target.planner.capIntensity,
        source.planner.capIntensity,
      );
    }
  }

  if (source.workout) {
    target.workout ??= {};
    if (source.workout.reduceVolume)    target.workout.reduceVolume    = true;
    if (source.workout.reduceIntensity) target.workout.reduceIntensity = true;
    if (source.workout.capPriority) {
      target.workout.capPriority = saferCap(
        target.workout.capPriority,
        source.workout.capPriority,
      );
    }
  }

  if (source.nutrition) {
    target.nutrition ??= {};
    if (source.nutrition.simplifyPlan)           target.nutrition.simplifyPlan           = true;
    if (source.nutrition.increaseProteinFocus)   target.nutrition.increaseProteinFocus   = true;
    if (source.nutrition.increaseHydrationFocus) target.nutrition.increaseHydrationFocus = true;
  }

  if (source.recovery) {
    target.recovery ??= {};
    if (source.recovery.increasePriority) target.recovery.increasePriority = true;
    if (source.recovery.addProtocol)      target.recovery.addProtocol      = true;
  }

  if (source.sleep) {
    target.sleep ??= {};
    if (source.sleep.enforceWindDown)     target.sleep.enforceWindDown     = true;
    if (source.sleep.increaseSleepTarget) target.sleep.increaseSleepTarget = true;
  }
}

/**
 * Return the safer (more conservative) of two cap values.
 * "low" is safer than "medium". Undefined means "no cap requested".
 */
function saferCap(
  a: "low" | "medium" | undefined,
  b: "low" | "medium" | undefined,
): "low" | "medium" | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  // "low" is always safer (more conservative cap)
  return (a === "low" || b === "low") ? "low" : "medium";
}
