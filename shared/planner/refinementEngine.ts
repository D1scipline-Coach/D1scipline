/**
 * shared/planner/refinementEngine.ts
 *
 * Adaptive profile refinement system.
 *
 * Identifies missing or weak profile data and generates prioritised,
 * time-gated prompts to improve plan quality over time.
 *
 * Public API:
 *   deriveRefinementSignals(profile)     — classify gaps by severity tier
 *   prioritizeRefinementSignals(signals) — ordered prompt list, max 5
 *   shouldShowRefinementPrompt(context)  — daily cooldown gate
 *
 * Design constraints:
 *   - Pure functions only (no side effects, no async)
 *   - All inputs treated as potentially undefined (defensive)
 *   - No render coupling — safe to call from any context
 *   - Never throws — all checks are wrapped defensively
 */

import type { AiraUserProfile } from "../types/profile";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RefinementSignals = {
  /**
   * High-priority: structural gaps that directly degrade plan output.
   * These fields are gate-enforced in onboarding, so missingCore is almost
   * always empty for current users. Guards against legacy or corrupted data.
   */
  missingCore: string[];
  /**
   * Medium-priority: genuinely optional fields the user may have skipped.
   * Filling these improves timing, nutrition, and goal alignment.
   */
  missingOptional: string[];
  /**
   * Low-priority: enrichment data that would deepen personalisation.
   * Includes allergy confirmation, schedule patterns, and future integrations.
   */
  weakSignals: string[];
};

export type RefinementContext = {
  /** ISO 8601 — when the last prompt was shown. Undefined = never shown. */
  lastShownAt?: string;
  /**
   * Count of meaningful user interactions (plan completions, task checks,
   * manual app opens). Used to avoid prompting very new users.
   */
  userInteractionCount?: number;
  /** ISO 8601 — when the current plan was generated. Avoids prompting right after a fresh plan. */
  planGeneratedAt?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** 24-hour cooldown between prompt surfaces */
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Suppress prompts until the user has completed at least this many interactions */
const MIN_INTERACTIONS = 3;

/** Don't prompt within this many ms of a plan being freshly generated (1 hour) */
const FRESH_PLAN_GRACE_MS = 60 * 60 * 1000;

/** Maximum prompts returned by prioritizeRefinementSignals */
const MAX_PROMPTS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Part 1 — Signal derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify profile gaps into three severity tiers.
 *
 * Signal keys (not prompt strings) are returned — this keeps derivation
 * separate from presentation and allows callers to filter/inspect signals
 * before deciding what to surface.
 *
 * Never throws. All property accesses are guarded.
 */
export function deriveRefinementSignals(profile: AiraUserProfile): RefinementSignals {
  const missingCore:     string[] = [];
  const missingOptional: string[] = [];
  const weakSignals:     string[] = [];

  const skipped = profile.meta?.optionalFieldsSkipped ?? [];

  // ── Core (high priority) ─────────────────────────────────────────────────
  // Gate-enforced in onboarding — should never be absent for current users.
  // These checks defend against legacy profiles and data corruption only.

  if (!profile.goals?.primaryGoal) {
    missingCore.push("goal");
  }
  if (!profile.training?.daysPerWeek || profile.training.daysPerWeek < 2) {
    missingCore.push("trainingDays");
  }
  if (!profile.training?.sessionDuration) {
    missingCore.push("sessionDuration");
  }

  // ── Optional (medium priority) ───────────────────────────────────────────
  // Genuinely optional — user may have skipped these fields.

  if (!profile.schedule?.preferredWorkoutTime) {
    missingOptional.push("preferredWorkoutTime");
  }
  // dietaryStyle and nutritionGoal are gate-enforced in v2+ onboarding.
  // Only flag for legacy profiles where the field is literally absent.
  if (!profile.nutrition?.dietaryStyle) {
    missingOptional.push("dietaryStyle");
  }
  if (!profile.nutrition?.nutritionGoal) {
    missingOptional.push("nutritionGoal");
  }

  // ── Weak signals (low priority) ──────────────────────────────────────────
  // Data is present but thin — enrichment would meaningfully improve output.

  // Allergy info: empty array may mean "no restrictions" (intentional) or
  // "never asked". Flag when empty AND no notes are present.
  const hasAllergyData =
    (profile.nutrition?.allergies?.length ?? 0) > 0 ||
    Boolean(profile.nutrition?.allergyNotes);
  if (!hasAllergyData) {
    weakSignals.push("noAllergyInfo");
  }

  // Schedule consistency absent → plan cannot choose fixed vs. adaptive structure
  if (!profile.schedule?.scheduleConsistency ||
      skipped.includes("schedule.scheduleConsistency")) {
    weakSignals.push("noScheduleConsistency");
  }

  // Injury info absent → plan cannot protect movement quality
  if (!profile.training?.injuries) {
    weakSignals.push("noInjuryInfo");
  }

  // Enhanced recovery data: wearable HRV/RHR better than self-report
  const hasEnhancedRecovery =
    Boolean(profile.future?.wearables?.hasDevice) ||
    profile.future?.recovery?.hrv != null ||
    profile.future?.recovery?.restingHeartRate != null;
  if (!hasEnhancedRecovery) {
    weakSignals.push("noEnhancedRecovery");
  }

  // Body scan: improves calorie and body-comp accuracy
  const hasBodyScan =
    profile.future?.bodyScan?.bodyFat != null ||
    profile.future?.bodyScan?.muscleMass != null;
  if (!hasBodyScan) {
    weakSignals.push("noBodyScan");
  }

  // Calendar: enables plan-around-commitments scheduling
  if (!profile.future?.schedule?.calendarConnected) {
    weakSignals.push("noCalendar");
  }

  return { missingCore, missingOptional, weakSignals };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt map — signal key → actionable user-facing prompt string
// ─────────────────────────────────────────────────────────────────────────────

const PROMPT_MAP: Record<string, string> = {
  // Core
  "goal":
    "Tell Aira your primary goal to unlock a fully personalised plan.",
  "trainingDays":
    "Set your training days per week — this is the foundation of your weekly structure.",
  "sessionDuration":
    "Set your session length so Aira can design workouts that fit your available time.",

  // Optional
  "preferredWorkoutTime":
    "Add your preferred workout window so Aira can schedule training at the right time of day for you.",
  "dietaryStyle":
    "Set your dietary style so Aira can personalise your nutrition recommendations.",
  "nutritionGoal":
    "Set your nutrition goal so Aira can align your meals with your training.",

  // Weak
  "noAllergyInfo":
    "Confirm any food allergies or restrictions so Aira can personalise your meal suggestions safely.",
  "noScheduleConsistency":
    "Tell Aira how consistent your daily schedule is — this determines whether your plan uses fixed or flexible timing.",
  "noInjuryInfo":
    "Add any injuries or limitations so Aira can protect your joints and modify movements accordingly.",
  "noEnhancedRecovery":
    "Connect a wearable device so Aira can use your real recovery and HRV data.",
  "noBodyScan":
    "Upload a body scan to improve calorie and body composition accuracy.",
  "noCalendar":
    "Link your calendar so Aira can plan around your actual commitments.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Part 2 — Priority system
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten RefinementSignals into an ordered list of actionable prompt strings.
 *
 * Priority order: core → optional → weak
 * Cap: MAX_PROMPTS (5) total.
 * Signals without a matching prompt string are silently skipped.
 */
export function prioritizeRefinementSignals(signals: RefinementSignals): string[] {
  const prompts: string[] = [];

  // Helper: resolve a signal key to a prompt, skip if unrecognised
  const add = (key: string): void => {
    if (prompts.length >= MAX_PROMPTS) return;
    const text = PROMPT_MAP[key];
    if (text && !prompts.includes(text)) {
      prompts.push(text);
    }
  };

  // 1. Core — always surfaces first (data-integrity gate)
  for (const key of signals.missingCore)     add(key);
  // 2. Optional — medium value, fills after core
  for (const key of signals.missingOptional) add(key);
  // 3. Weak — enrichment only; fills remaining slots up to cap
  for (const key of signals.weakSignals)     add(key);

  return prompts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 4 — Timing gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether a refinement prompt should be shown right now.
 *
 * Returns false (suppress) when:
 *   - The cooldown period has not elapsed since the last prompt
 *   - The user has not yet had enough meaningful interactions
 *   - A plan was just generated (grace period: 1 hour)
 *
 * Never throws. Dates that fail to parse are treated as "never shown".
 */
export function shouldShowRefinementPrompt(context: RefinementContext): boolean {
  const now = Date.now();

  // Gate 1 — cooldown: no more than once per day
  if (context.lastShownAt) {
    const lastMs = safeParseDate(context.lastShownAt);
    if (lastMs !== null && now - lastMs < COOLDOWN_MS) {
      return false;
    }
  }

  // Gate 2 — minimum interactions: let new users settle in first
  const interactions = context.userInteractionCount ?? 0;
  if (interactions < MIN_INTERACTIONS) {
    return false;
  }

  // Gate 3 — fresh plan grace: plan just generated, let user focus on it
  if (context.planGeneratedAt) {
    const planMs = safeParseDate(context.planGeneratedAt);
    if (planMs !== null && now - planMs < FRESH_PLAN_GRACE_MS) {
      return false;
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/** Parse an ISO date string to a Unix timestamp in ms. Returns null on failure. */
function safeParseDate(iso: string): number | null {
  try {
    const ms = new Date(iso).getTime();
    return isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}
