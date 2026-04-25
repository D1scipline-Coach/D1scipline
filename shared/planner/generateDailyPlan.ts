/**
 * shared/planner/generateDailyPlan.ts
 *
 * Deterministic daily plan generator for the Aira coaching system.
 *
 *   generateDailyPlan(profile: AiraUserProfile): GeneratedDailyPlan
 *
 * All logic is deterministic — same profile always produces the same plan.
 * No randomness. No external calls. No async.
 *
 * Architecture:
 *   generateDailyPlan
 *     ├─ generateWorkout    ← training.* adjusted by recovery state
 *     ├─ generateNutrition  ← nutrition.* + goals.primaryGoal + profile weight
 *     ├─ generateRecovery   ← recovery.* (readiness tier drives everything)
 *     └─ generateSchedule   ← sleep.* + schedule.* + workout timing
 *
 * NOTE: GeneratedDailyPlan is the client-side rich output type.
 * It is DISTINCT from the server-stored DailyPlan record (shared/planner/types.ts).
 *   GeneratedDailyPlan — structured data for local UI, AI context, and plan display
 *   DailyPlan          — server record: userId, date, planId, DB shape
 *
 * Imported by:
 *   import { generateDailyPlan } from "../shared/planner/generateDailyPlan";
 *   import type { GeneratedDailyPlan } from "../shared/planner/generateDailyPlan";
 */

import type {
  AiraUserProfile,
  GoalKind,
  GymAccess,
  TrainingStyle,
  ExperienceLevel,
  SessionDuration,
  DietaryStyle,
  NutritionGoalKind,
  MealPrepLevel,
  SleepQuality,
  StressLevel,
  EnergyLevel,
  ScheduleConsistency,
  PreferredWorkoutTime,
} from "../types/profile";
import {
  deriveRefinementSignals,
  prioritizeRefinementSignals,
} from "./refinementEngine";

// ─────────────────────────────────────────────────────────────────────────────
// Output types
// ─────────────────────────────────────────────────────────────────────────────

export type IntensityLevel   = "low" | "moderate" | "high" | "max";
export type VolumeLevel      = "low" | "moderate" | "high";
export type ScheduleStrategy = "fixed" | "adaptive";
/**
 * How much the engine trusts its own recommendations, derived from
 * profile.meta.dataConfidenceScore (0–100).
 *   high:   80–100 — all optional fields filled; strong personalization
 *   medium: 50–79  — most fields filled; good baseline
 *   low:    0–49   — many optional fields missing; conservative defaults applied
 */
export type ConfidenceLevel = "low" | "medium" | "high";

/**
 * Raw signal inputs extracted from AiraUserProfile.
 * The canonical view of "what we know about this user" before any decisions are made.
 */
export type PlanSignals = {
  goal:                 GoalKind;
  experience:           ExperienceLevel;
  trainingDays:         number;
  sessionDuration:      SessionDuration;
  sleepQuality:         SleepQuality;
  stressLevel:          StressLevel;
  energyBaseline:       EnergyLevel;
  scheduleConsistency:  ScheduleConsistency | undefined;
  preferredWorkoutTime: PreferredWorkoutTime | undefined;
  dietaryStyle:         DietaryStyle;
  nutritionGoal:        NutritionGoalKind;
};

/**
 * Structured decisions derived from PlanSignals.
 * Each field is an explicit, explainable choice — not scattered across generators.
 * Returned in meta.decisions so callers can inspect every decision.
 */
export type PlanDecisions = {
  /** Overall session intensity — goal → recovery → experience priority chain. */
  intensity:         IntensityLevel;
  /** Exercise count modifier — driven by session duration + experience level. */
  volume:            VolumeLevel;
  /** Direct mapping from trainingDaysPerWeek. */
  frequency:         number;
  /** One-line coaching label for the day. */
  focus:             string;
  /** How strongly to emphasise recovery protocols today. */
  recoveryPriority:  VolumeLevel;
  /** fixed = honour preferred time; adaptive = flexibility note added for inconsistent schedulers. */
  scheduleStrategy:  ScheduleStrategy;
  /** Human-readable nutrition intent string. */
  nutritionStrategy: string;
};

/**
 * Human coaching-style explanation of every key plan decision.
 * Exposed in meta.explanation for the UI to surface to the user.
 * Each field is a standalone paragraph — not dependent on reading the others.
 */
export type PlanExplanation = {
  /** 1–2 sentence coaching summary of the entire day. */
  summary:          string;
  /** Why intensity was set to this level, in plain language. */
  intensityReason:  string;
  /** Why recovery is or isn't a priority today. */
  recoveryReason:   string;
  /** Why the schedule is fixed or flexible today. */
  scheduleReason:   string;
  /** What food is doing for this user today, tied directly to their goal. */
  nutritionReason:  string;
  /** What the day's theme means in practice. */
  focusReason:      string;
  /**
   * How confident Aira is in this plan, expressed as a coaching note.
   * Tells the user whether the plan is fully personalised or working from defaults.
   */
  confidenceNote:   string;
};

/**
 * Personalization metadata — confidence score, level, and actionable prompts to
 * fill data gaps. Surfaces in meta.personalization.
 */
export type PlanPersonalization = {
  confidenceLevel:    ConfidenceLevel;
  confidenceScore:    number;           // 0–100, mirrors profile.meta.dataConfidenceScore
  refinementPrompts:  string[];         // actionable asks for the user; empty if high confidence
};

export type WorkoutSplit =
  | "full_body"
  | "upper_body"
  | "lower_body"
  | "push"
  | "pull"
  | "push_pull_legs"
  | "athletic_circuit"
  | "hiit"
  | "bodyweight_circuit"
  | "strength_compound"
  | "active_recovery";

/** A single exercise within a session. */
export type ExerciseEntry = {
  name:   string;
  sets:   number;
  reps:   string;   // "8–10", "AMRAP", "30s", "max"
  rest:   string;   // "60s", "90s", "2 min"
  notes?: string;
};

export type WorkoutPlan = {
  split:         WorkoutSplit;
  durationMins:  number;
  intensityLevel: IntensityLevel;
  warmupMins:    number;
  cooldownMins:  number;
  exercises:     ExerciseEntry[];
  /** Human-readable session focus — e.g. "Compound strength — squat, deadlift, press" */
  focus:         string;
  notes?:        string;   // e.g. "Reduce loads ~20% — high-stress week"
};

/** Per-macro daily targets. */
export type MacroTarget = {
  protein:  number;   // grams
  carbs:    number;   // grams
  fats:     number;   // grams
  calories: number;
};

export type MealEntry = {
  name:        string;   // "Breakfast", "Pre-workout", "Lunch"
  description: string;   // "3 eggs, oats with berries, black coffee"
  focus:       string;   // "High protein, complex carbs"
  timing?:     string;   // Relative timing hint, e.g. "Within 30 min of waking"
};

export type NutritionPlan = {
  caloricStrategy: "deficit" | "maintenance" | "surplus";
  dailyTarget:     MacroTarget;
  hydrationLiters: number;
  meals:           MealEntry[];
  supplements:     string[];    // ["Creatine 5g with water", "Vitamin D 2000IU"]
  keyPrinciple:    string;      // "High protein, moderate caloric deficit"
};

export type RecoveryProtocol = {
  name:         string;   // "Diaphragmatic breathing"
  durationMins: number;
  description:  string;
};

/** Readiness tier — mirrors PlannerReadiness enum values for future integration. */
export type ReadinessTier = "Push" | "Maintain" | "Recover";

export type RecoveryPlan = {
  readinessTier:   ReadinessTier;
  intensityBudget: IntensityLevel;    // max intensity the plan will assign today
  sleepTargetHrs:  number;
  windDownMins:    number;            // buffer before sleepTime
  morningProtocols: RecoveryProtocol[];
  eveningProtocols: RecoveryProtocol[];
  stressFlag:      boolean;           // true when stressLevel is high or very_high
  notes?:          string;
};

/** A single block in the day's schedule. */
export type ScheduledBlock = {
  label:        string;   // "Morning workout", "Post-workout meal"
  timeText:     string;   // "7:00 AM"
  durationMins: number;
  kind:         "Workout" | "Nutrition" | "Hydration" | "Mobility" | "Recovery" | "Sleep" | "Habit";
};

export type SchedulePlan = {
  workoutTimeText:  string;         // resolved from preferredWorkoutTime + wakeTime
  windDownTimeText: string;         // sleepTime minus windDownMins
  blocks:           ScheduledBlock[];
};

/**
 * The complete generated plan for one day.
 * This is the client-side structured output — not the server-stored DailyPlan record.
 */
export type GeneratedDailyPlan = {
  workout:   WorkoutPlan;
  nutrition: NutritionPlan;
  recovery:  RecoveryPlan;
  schedule:  SchedulePlan;
  meta: {
    generatedAt:     string;           // ISO 8601
    /** One-line coaching label for the day — e.g. "Recovery optimization day" */
    focus:           string;
    /** Structured decision object — every key choice the engine made, inspectable by callers. */
    decisions:       PlanDecisions;
    /** Human coaching-style explanation of every key decision, ready to surface in UI. */
    explanation:     PlanExplanation;
    /** Confidence + refinement prompts — how well Aira knows this user, and what would help. */
    personalization: PlanPersonalization;
    reasoning:       string[];         // full decision trace for debugging / AI context
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Time utilities — self-contained, no app/index.tsx dependency
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "6:00 AM", "22:30", "6:30PM", etc. → minutes since midnight. Returns 480 (8 AM) on failure. */
function parseTime(input: string): number {
  const raw = input.trim().toUpperCase();
  const hasAm = raw.includes("AM");
  const hasPm = raw.includes("PM");
  let cleaned = raw.replace(/[^0-9:]/g, "");

  if (!cleaned.includes(":")) {
    cleaned = cleaned.length <= 2 ? `${cleaned}:00` : `${cleaned.slice(0, 2)}:${cleaned.slice(2)}`;
  }

  const parts = cleaned.split(":");
  if (parts.length !== 2) return 480;

  let h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!isFinite(h) || !isFinite(m) || m < 0 || m > 59) return 480;

  if (hasAm || hasPm) {
    if (h < 1 || h > 12) return 480;
    if (hasAm && h === 12) h = 0;
    if (hasPm && h !== 12) h += 12;
  } else {
    if (h < 0 || h > 23) return 480;
  }

  return h * 60 + m;
}

/** Convert minutes-since-midnight → "7:00 AM" display string. */
function minutesToTime(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

/** Add (or subtract) minutes to a time string. */
function offsetTime(timeText: string, offsetMins: number): string {
  return minutesToTime(parseTime(timeText) + offsetMins);
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal extraction & decision engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the canonical signal set from a full AiraUserProfile.
 * Pure transformation — no reasoning, no side effects.
 */
export function extractSignals(profile: AiraUserProfile): PlanSignals {
  return {
    goal:                 profile.goals.primaryGoal,
    experience:           profile.training.experience,
    trainingDays:         profile.training.daysPerWeek,
    sessionDuration:      profile.training.sessionDuration,
    sleepQuality:         profile.recovery.sleepQuality,
    stressLevel:          profile.recovery.stressLevel,
    energyBaseline:       profile.recovery.energyBaseline,
    scheduleConsistency:  profile.schedule.scheduleConsistency,
    preferredWorkoutTime: profile.schedule.preferredWorkoutTime,
    dietaryStyle:         profile.nutrition.dietaryStyle,
    nutritionGoal:        profile.nutrition.nutritionGoal,
  };
}

// ── Confidence system ──────────────────────────────────────────────────────

/**
 * Map dataConfidenceScore → ConfidenceLevel.
 * high:   80–100 — strong personalization; allow assertive recommendations
 * medium: 50–79  — solid baseline; plan is reliable, more detail would sharpen it
 * low:    0–49   — many optional fields missing; apply conservative defaults
 */
export function deriveConfidenceLevel(profile: AiraUserProfile): ConfidenceLevel {
  const score = profile.meta.dataConfidenceScore;
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
}

/**
 * Generate specific, actionable prompts for whichever optional fields are missing.
 * Delegates to the refinement engine — signal derivation and prioritisation are
 * handled there, keeping this function as a thin adapter.
 * Returns at most 5 prompts, ordered by impact on plan quality.
 */
function generateRefinementPrompts(profile: AiraUserProfile): string[] {
  const signals = deriveRefinementSignals(profile);
  return prioritizeRefinementSignals(signals);
}

// ── Volume decision ────────────────────────────────────────────────────────
// Driven by session duration (primary) and experience (modifier).
// Short sessions → low (time-constrained); long + experienced → high.
function deriveVolume(signals: PlanSignals): VolumeLevel {
  const short      = signals.sessionDuration === "20min" || signals.sessionDuration === "30min";
  const long       = signals.sessionDuration === "60min" || signals.sessionDuration === "90min+";
  const experienced = signals.experience === "intermediate" || signals.experience === "advanced";

  if (short)              return "low";
  if (long && experienced) return "high";
  return "moderate";
}

// ── Recovery priority decision ─────────────────────────────────────────────
// Any single depleting signal → high priority; all-green signals → low.
function deriveRecoveryPriority(signals: PlanSignals): VolumeLevel {
  const poorSleep  = signals.sleepQuality === "poor" || signals.sleepQuality === "fair";
  const highStress = signals.stressLevel === "high" || signals.stressLevel === "very_high";
  if (poorSleep || highStress) return "high";
  if (signals.sleepQuality === "good" && signals.stressLevel === "low") return "low";
  return "moderate";
}

// ── Schedule strategy decision ─────────────────────────────────────────────
// Inconsistent schedulers get the adaptive strategy (coaching note, not hard reschedule).
function deriveScheduleStrategy(signals: PlanSignals): ScheduleStrategy {
  return signals.scheduleConsistency === "inconsistent" ? "adaptive" : "fixed";
}

// ── Nutrition strategy decision ────────────────────────────────────────────
function deriveNutritionStrategy(signals: PlanSignals): string {
  switch (signals.nutritionGoal) {
    case "fat_loss":    return "Caloric deficit with high protein — preserve muscle while losing fat";
    case "muscle_gain": return "Controlled caloric surplus with high protein — maximise muscle growth";
    case "performance": return "Performance-focused fueling — high carbs, adequate protein, balanced recovery";
    case "maintenance": return "Maintenance calories, quality-first — optimise energy and body composition";
  }
}

/**
 * Derive a structured PlanDecisions object from a full profile.
 *
 * Called once per generateDailyPlan invocation before any generator runs.
 * All generators receive the decisions object so they never re-derive the same signal.
 *
 * Accepts an optional pre-computed `signals` argument so the caller can pass
 * signals that were already extracted — avoiding a second `extractSignals` call.
 * When omitted, signals are derived internally (safe for direct callers).
 *
 * Decision priority:
 *   Intensity:        goal → combined recovery → individual recovery → experience
 *   Volume:           sessionDuration → experience
 *   RecoveryPriority: any depleting signal → HIGH; all-green → LOW
 *   ScheduleStrategy: scheduleConsistency → ADAPTIVE if inconsistent, else FIXED
 *   NutritionStrategy: nutritionGoal → mapped to human-readable strategy
 *   Focus:            worst-case recovery → recovery tier → goal
 */
export function derivePlanDecisions(
  profile:           AiraUserProfile,
  reasoning:         string[],
  precomputedSignals?: PlanSignals,
): PlanDecisions {
  // Use caller-supplied signals when available to avoid duplicate extraction.
  const signals         = precomputedSignals ?? extractSignals(profile);
  const confidenceLevel = deriveConfidenceLevel(profile);

  // Intensity — full priority chain (goal → recovery → experience)
  // deriveIntensity pushes its own human reasoning entries
  let intensity = deriveIntensity(profile, reasoning);

  let volume           = deriveVolume(signals);
  const recoveryPriority  = deriveRecoveryPriority(signals);
  const scheduleStrategy  = deriveScheduleStrategy(signals);
  const nutritionStrategy = deriveNutritionStrategy(signals);

  // ── Confidence-based safety cap ───────────────────────────────────────────
  // When the profile is incomplete we don't know enough to justify aggressive
  // recommendations. Cap intensity and volume at "moderate" so we never push
  // hard on data we don't actually have (e.g. unknown weight, age, injuries).
  if (confidenceLevel === "low") {
    if (intensity === "high" || intensity === "max") {
      intensity = "moderate";
      reasoning.push(
        "Profile confidence is low — intensity capped at moderate until Aira learns more about you. " +
        "As you fill in more details, the plan will sharpen and can be more assertive."
      );
    }
    if (volume === "high") {
      volume = "moderate";
      reasoning.push(
        "Volume kept at moderate due to incomplete profile data — safer to start conservative and increase once Aira has more context."
      );
    }
  }

  // Focus needs readiness tier — reuse computeReadinessTier (deterministic, cheap)
  const tier  = computeReadinessTier(signals.sleepQuality, signals.stressLevel, signals.energyBaseline);
  const focus = derivePlanFocus(profile, tier);

  reasoning.push(
    `Decision engine → intensity: ${intensity} | volume: ${volume} | frequency: ${signals.trainingDays}d/week | ` +
    `recoveryPriority: ${recoveryPriority} | scheduleStrategy: ${scheduleStrategy} | confidence: ${confidenceLevel}.`
  );

  return {
    intensity,
    volume,
    frequency:  signals.trainingDays,
    focus,
    recoveryPriority,
    scheduleStrategy,
    nutritionStrategy,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Explanation layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate human, coaching-style explanations for every key plan decision.
 *
 * Pure function — takes signals and decisions, returns explanations.
 * No side effects. Deterministic.
 *
 * Each field is self-contained: the UI can show any subset without context from the others.
 */
export function generatePlanExplanation(
  signals:         PlanSignals,
  decisions:       PlanDecisions,
  confidenceLevel: ConfidenceLevel,
): PlanExplanation {

  // ── Intensity reason ────────────────────────────────────────────────────
  const poorSleep   = signals.sleepQuality === "poor" || signals.sleepQuality === "fair";
  const highStress  = signals.stressLevel  === "high" || signals.stressLevel  === "very_high";
  const lowEnergy   = signals.energyBaseline === "low";

  let intensityReason: string;
  if (decisions.intensity === "low") {
    if (poorSleep && highStress) {
      intensityReason =
        "Your body is carrying two simultaneous recovery debts — poor sleep and high stress — " +
        "and that combination taxes your nervous system harder than either does alone. " +
        "Pushing hard through this state doesn't build fitness; it deepens the hole you're already in. " +
        "Today's session stays light so your body can absorb the work instead of just surviving it.";
    } else if (signals.stressLevel === "very_high") {
      intensityReason =
        "Stress at this level means your cortisol is already elevated and your nervous system is running hot. " +
        "A hard training session would add to that systemic load, not subtract from it. " +
        "Keeping intensity low today is the smart move — you'll come back stronger when the stress subsides.";
    } else {
      intensityReason =
        "Your recovery signals are indicating that today isn't a day for peak output. " +
        "Light, deliberate training on compromised days is what keeps you training consistently " +
        "— it's the difference between a streaky athlete and a durable one.";
    }
  } else if (decisions.intensity === "moderate") {
    if (poorSleep || highStress || lowEnergy) {
      intensityReason =
        "You're not fully recovered, but you're not in the red either. " +
        "Moderate intensity means working at 70–80% — enough stimulus to drive adaptation, " +
        "not so much that you dig into a recovery deficit you can't fill by tomorrow. " +
        "This is disciplined training, not a compromise.";
    } else if (signals.experience === "beginner") {
      intensityReason =
        "As a beginner, technique and nervous system adaptation matter more than intensity right now. " +
        "Your body is still learning the movement patterns — overloading before those are solid " +
        "is the single fastest way to plateau or get hurt. Moderate effort with sharp form compounds faster.";
    } else {
      intensityReason =
        "Today's conditions support a solid working session. Moderate intensity means every set " +
        "is meaningful — you're training with intent, not just going through the motions, " +
        "but not burning matches you'll need later in the week either.";
    }
  } else {
    // high or max
    intensityReason =
      "Your recovery signals are green across the board. Sleep was solid, stress is manageable, " +
      "energy is there. Days like this are the ones where real progress gets locked in — " +
      "when readiness is high, effort that would wreck you on a bad day instead drives adaptation. " +
      "Don't leave today's opportunity on the table.";
  }

  // ── Recovery reason ─────────────────────────────────────────────────────
  let recoveryReason: string;
  if (decisions.recoveryPriority === "high") {
    if (poorSleep && highStress) {
      recoveryReason =
        "Both your sleep and stress signals are flagged — your body is in active recovery debt. " +
        "The protocols in today's plan (breathing work, foam rolling, screen cutoff) aren't optional extras; " +
        "they directly counteract cortisol elevation and improve sleep architecture tonight. " +
        "Treat them like training sets — they're part of the programme.";
    } else if (poorSleep) {
      recoveryReason =
        "Sleep is where your body repairs from training, consolidates skill, and resets hormones. " +
        "Last night's sleep was below par, which means tonight's has to count. " +
        "The wind-down and evening protocols are designed to give you the best shot at a quality recovery window.";
    } else {
      recoveryReason =
        "Elevated stress is suppressing your recovery capacity even if you feel fine on the surface. " +
        "The breathing protocols specifically target cortisol reduction — ten minutes of deliberate " +
        "breathwork before bed is one of the most evidence-backed tools for improving sleep quality under stress.";
    }
  } else if (decisions.recoveryPriority === "low") {
    recoveryReason =
      "Your recovery baseline is solid — sleep, stress, and energy are all pointing in the right direction. " +
      "The morning and evening protocols are maintenance today, not rescue. " +
      "Keep doing what you're doing; this is what a body primed to adapt looks like.";
  } else {
    recoveryReason =
      "Nothing is alarming in your recovery signals, but there's room to sharpen your baseline. " +
      "The protocols today support consistency — a short morning mobility routine and an evening " +
      "wind-down compound over time into meaningfully better recovery quality.";
  }

  // ── Schedule reason ──────────────────────────────────────────────────────
  let scheduleReason: string;
  if (decisions.scheduleStrategy === "adaptive") {
    scheduleReason =
      "Your schedule tends to vary, so today's plan gives you a target time rather than a hard commitment. " +
      "The goal is completing the session — not hitting an exact start time. " +
      "If your day shifts by two hours, move the workout with it. " +
      "The only bad outcome is skipping because the timing wasn't perfect.";
  } else {
    scheduleReason =
      "Your workout is anchored to your preferred training window. " +
      "Training at a consistent time each day gradually synchronises your body's internal clock — " +
      "over weeks, you'll notice you start feeling primed to train before you even begin. " +
      "Protect this time slot the way you'd protect any other important appointment.";
  }

  // ── Nutrition reason ─────────────────────────────────────────────────────
  let nutritionReason: string;
  switch (signals.nutritionGoal) {
    case "fat_loss":
      nutritionReason =
        "Food is your primary fat-loss lever today — not the workout. " +
        "The session preserves muscle and elevates metabolism; the caloric deficit is what actually " +
        "moves body composition. Nail your protein target first — it's the line between " +
        "losing fat and losing muscle — then let the rest of your calories fill in around it.";
      break;
    case "muscle_gain":
      nutritionReason =
        "You're in a building phase, which means eating enough is part of training. " +
        "A caloric surplus gives your body the raw material to lay down new tissue after today's session. " +
        "Don't undereat on training days — the muscle you're trying to build literally can't " +
        "be constructed without a surplus. Hit your protein number and don't be afraid of the food.";
      break;
    case "performance":
      nutritionReason =
        "Carbohydrates are the fuel for high-output work, and today's plan front-loads energy " +
        "around your training window to maximise output and speed up recovery. " +
        "Think of pre-workout carbs as filling the tank before a long drive — " +
        "starting depleted costs you more than the food ever would.";
      break;
    case "maintenance":
      nutritionReason =
        "Maintenance eating is a skill most people underestimate. " +
        "Matching intake to expenditure keeps body composition stable while you build fitness — " +
        "no fat gain, no muscle loss. Keep protein high and let the rest flex with your day. " +
        "Consistency here is more valuable than precision.";
      break;
  }

  // ── Focus reason ─────────────────────────────────────────────────────────
  let focusReason: string;
  switch (decisions.focus) {
    case "Recovery optimization day":
      focusReason =
        "The theme today is restoration, not output. Your sleep and stress signals indicate your " +
        "body is carrying a recovery load — today's plan is designed to pay that debt down, not add to it. " +
        "Light movement, breathing protocols, and quality sleep tonight will have you performing " +
        "better in the next session than pushing through today ever would.";
      break;
    case "Active recovery day":
      focusReason =
        "Active recovery isn't a rest day — it's targeted light movement that keeps blood flowing " +
        "to worked muscles, reinforces healthy movement patterns, and maintains the training habit " +
        "without adding load. Think of it as maintenance work on the engine between hard sessions.";
      break;
    case "High-volume muscle building day":
      focusReason =
        "High volume means more total sets and more time under tension — the primary mechanical " +
        "signals for muscle growth. You're in a good recovery state, which means your body can absorb " +
        "this stimulus and actually build from it. Bring your concentration to every rep, " +
        "not just the last one in each set.";
      break;
    case "Max-strength execution day":
      focusReason =
        "Strength is a skill, and today is a skill day. The focus isn't on discomfort or fatigue " +
        "— it's on technical quality under load. Full rest between sets, sharp form on every rep, " +
        "and weights that are genuinely challenging. Rushed strength training is ineffective strength training.";
      break;
    case "High-intensity calorie burn day":
      focusReason =
        "You're in the right recovery state to work hard today. Training density — doing more work " +
        "in less time — creates the metabolic conditions that support fat loss long after the session ends. " +
        "Shortened rest periods are a feature, not a punishment: keep moving, stay focused.";
      break;
    case "Athletic performance day":
      focusReason =
        "Athletic training targets the qualities pure gym work misses — coordination, speed, " +
        "reactive power, and movement efficiency. Today's session builds the physical capacity " +
        "to perform, not just look strong. Quality of movement is the metric, not load lifted.";
      break;
    case "Consistent calorie deficit day":
      focusReason =
        "Fat loss happens in the kitchen more than the gym, and today's focus reinforces that. " +
        "The training supports the deficit by preserving muscle — the nutrition plan is where " +
        "the real work happens. One consistent day like this, multiplied across weeks, is the entire formula.";
      break;
    case "Progressive volume day":
      focusReason =
        "Progressive volume means slightly more total work than the last comparable session. " +
        "The adaptation signal for muscle growth is progressive overload — more sets, more reps, " +
        "or more load over time. Today's plan nudges that variable forward. Small but consistent.";
      break;
    case "Strength skill day":
      focusReason =
        "Strength skill days are about reinforcing the neuromuscular patterns behind the lifts. " +
        "Not maximal effort — controlled, deliberate reps that build the movement economy " +
        "you'll cash in on heavier days. Think practice, not performance.";
      break;
    case "Show up and execute day":
      focusReason =
        "The most powerful training habit isn't any specific programme — it's showing up consistently. " +
        "Today's plan is intentionally completable so the habit of training stays intact. " +
        "Consistency compounds. Do the session, check the box, come back tomorrow.";
      break;
    case "Movement quality day":
      focusReason =
        "Movement quality training develops the coordination, mobility, and body control that " +
        "underpins every other physical quality. Today's session prioritises how you move " +
        "over how much you lift. The athletic ceiling you can reach is determined by movement quality first.";
      break;
    default:
      focusReason =
        `Today's plan is built around your current state and your goal. ` +
        `"${decisions.focus}" means every element — workout intensity, nutrition, recovery protocols — ` +
        `is calibrated to that theme. Execute it as written.`;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  let summary: string;
  const goalLabel =
    signals.goal === "lose_fat"            ? "fat loss" :
    signals.goal === "build_muscle"        ? "building muscle" :
    signals.goal === "get_stronger"        ? "getting stronger" :
    signals.goal === "improve_athleticism" ? "athletic performance" :
                                             "consistency";

  if (decisions.intensity === "low" && decisions.recoveryPriority === "high") {
    summary =
      "Today is a recovery-first day — your body is signalling that it needs restoration more than output. " +
      "Light movement and deliberate recovery protocols are the training today.";
  } else if (decisions.intensity === "high" && decisions.recoveryPriority === "low") {
    summary =
      `You're primed for a high-output session. Recovery is solid, energy is there, and your ${goalLabel} goal ` +
      `calls for effort on days like this. Make this session count.`;
  } else if (decisions.scheduleStrategy === "adaptive") {
    summary =
      `Today's plan is built around your ${goalLabel} goal with flexibility built in. ` +
      `Hit the session whenever your day allows — completion matters more than timing.`;
  } else {
    summary =
      `Today calls for steady, quality work in service of your ${goalLabel} goal. ` +
      `Consistent execution at this level — session after session — is where real progress lives.`;
  }

  // ── Confidence note ──────────────────────────────────────────────────────
  let confidenceNote: string;
  if (confidenceLevel === "high") {
    confidenceNote =
      "Your profile gives Aira enough detail to make this plan specific to your goals, body, and routine. " +
      "Every recommendation here is calibrated to what you've told us — this is your plan, not a generic template.";
  } else if (confidenceLevel === "medium") {
    confidenceNote =
      "Your current profile gives us a solid starting point. The plan is well-matched to your goals and recovery state, " +
      "and adding a few more details — like your preferred workout time or body metrics — will sharpen the recommendations further.";
  } else {
    confidenceNote =
      "Based on what we know so far, today's plan starts conservatively while Aira learns more about you. " +
      "The core recommendations are sound, but filling in the missing profile details will unlock more specific, " +
      "personalised guidance. Check the suggestions below to see what would help most.";
  }

  return {
    summary,
    intensityReason,
    recoveryReason,
    scheduleReason,
    nutritionReason,
    focusReason,
    confidenceNote,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exercise bank
//
// 3 access levels × 6 training styles = 18 curated exercise lists.
// Each list assumes INTERMEDIATE experience. Experience scaling is applied in
// generateWorkout() after lookup.
//
// All sets/reps are realistic defaults for the given style and duration.
// ─────────────────────────────────────────────────────────────────────────────

type ExerciseLookup = Record<GymAccess, Record<TrainingStyle, ExerciseEntry[]>>;

const EXERCISE_BANK: ExerciseLookup = {

  full_gym: {
    strength: [
      { name: "Back squat",         sets: 4, reps: "5",       rest: "3 min" },
      { name: "Deadlift",           sets: 3, reps: "5",       rest: "3 min" },
      { name: "Bench press",        sets: 4, reps: "5",       rest: "2 min" },
      { name: "Barbell row",        sets: 3, reps: "6",       rest: "2 min" },
      { name: "Overhead press",     sets: 3, reps: "5",       rest: "2 min" },
      { name: "Pull-up",            sets: 3, reps: "max",     rest: "2 min" },
    ],
    muscle: [
      { name: "Incline barbell press",  sets: 4, reps: "8–10",  rest: "90s" },
      { name: "Cable row",              sets: 4, reps: "10–12", rest: "90s" },
      { name: "Leg press",              sets: 4, reps: "10–12", rest: "90s" },
      { name: "Romanian deadlift",      sets: 3, reps: "10",    rest: "90s" },
      { name: "Lateral raise",          sets: 3, reps: "12–15", rest: "60s" },
      { name: "Cable bicep curl",       sets: 3, reps: "12–15", rest: "60s" },
    ],
    athlete: [
      { name: "Power clean",        sets: 4, reps: "3",       rest: "2 min", notes: "Explosive — reset each rep" },
      { name: "Front squat",        sets: 3, reps: "5",       rest: "2 min" },
      { name: "Box jump",           sets: 4, reps: "5",       rest: "90s",   notes: "Full reset before each jump" },
      { name: "Weighted pull-up",   sets: 3, reps: "5–6",     rest: "2 min" },
      { name: "Push press",         sets: 3, reps: "5",       rest: "2 min" },
    ],
    fat_loss: [
      { name: "Barbell squat",      sets: 4, reps: "12",      rest: "60s" },
      { name: "Barbell row",        sets: 4, reps: "12",      rest: "60s" },
      { name: "Dumbbell press",     sets: 3, reps: "12",      rest: "60s" },
      { name: "Romanian deadlift",  sets: 3, reps: "12",      rest: "60s" },
      { name: "Cable face pull",    sets: 3, reps: "15",      rest: "45s" },
    ],
    general_fitness: [
      { name: "Goblet squat",          sets: 3, reps: "10–12", rest: "90s" },
      { name: "Dumbbell bench press",  sets: 3, reps: "10–12", rest: "90s" },
      { name: "Seated cable row",      sets: 3, reps: "10–12", rest: "90s" },
      { name: "Romanian deadlift",     sets: 3, reps: "10",    rest: "90s" },
      { name: "Overhead press",        sets: 3, reps: "10–12", rest: "90s" },
      { name: "Plank",                 sets: 3, reps: "30s",   rest: "45s" },
    ],
    calisthenics: [
      { name: "Weighted pull-up",   sets: 4, reps: "5–6",     rest: "2 min" },
      { name: "Weighted dip",       sets: 4, reps: "6–8",     rest: "2 min" },
      { name: "Pistol squat",       sets: 3, reps: "5 each",  rest: "2 min" },
      { name: "Hanging leg raise",  sets: 3, reps: "10–12",   rest: "60s" },
      { name: "Push-up variation",  sets: 3, reps: "max",     rest: "90s",   notes: "Archer, diamond, or ring push-up" },
    ],
  },

  limited_equipment: {
    strength: [
      { name: "Goblet squat",          sets: 4, reps: "8–10",  rest: "2 min" },
      { name: "Dumbbell Romanian deadlift", sets: 4, reps: "8–10", rest: "2 min" },
      { name: "Dumbbell bench press",  sets: 4, reps: "8–10",  rest: "90s" },
      { name: "Dumbbell row",          sets: 4, reps: "8–10",  rest: "90s" },
      { name: "Dumbbell overhead press", sets: 3, reps: "8–10", rest: "90s" },
    ],
    muscle: [
      { name: "Incline dumbbell press",     sets: 4, reps: "10–12", rest: "90s" },
      { name: "Dumbbell row",               sets: 4, reps: "10–12", rest: "90s" },
      { name: "Dumbbell Romanian deadlift", sets: 3, reps: "12",    rest: "90s" },
      { name: "Lateral raise",              sets: 3, reps: "12–15", rest: "60s" },
      { name: "Dumbbell bicep curl",        sets: 3, reps: "12–15", rest: "60s" },
      { name: "Overhead tricep extension",  sets: 3, reps: "12–15", rest: "60s" },
    ],
    athlete: [
      { name: "Dumbbell snatch",    sets: 4, reps: "5 each",  rest: "90s",  notes: "Hip-hinge drive — lock out overhead" },
      { name: "Jump squat",         sets: 4, reps: "6",       rest: "90s" },
      { name: "Push-up",            sets: 3, reps: "max",     rest: "60s" },
      { name: "Dumbbell row",       sets: 3, reps: "8 each",  rest: "60s" },
      { name: "Lateral bound",      sets: 3, reps: "8 each",  rest: "60s",  notes: "Land softly, absorb force" },
    ],
    fat_loss: [
      { name: "Dumbbell squat to press", sets: 4, reps: "12",      rest: "45s", notes: "No rest between squat and press" },
      { name: "Renegade row",            sets: 3, reps: "8 each",  rest: "60s" },
      { name: "Jump squat",              sets: 3, reps: "15",      rest: "45s" },
      { name: "Dumbbell swing",          sets: 4, reps: "15",      rest: "45s" },
      { name: "Mountain climber",        sets: 3, reps: "30s",     rest: "30s" },
    ],
    general_fitness: [
      { name: "Dumbbell squat",      sets: 3, reps: "12",      rest: "90s" },
      { name: "Push-up",             sets: 3, reps: "max",     rest: "90s" },
      { name: "Dumbbell row",        sets: 3, reps: "12 each", rest: "90s" },
      { name: "Dumbbell RDL",        sets: 3, reps: "12",      rest: "90s" },
      { name: "Dumbbell OHP",        sets: 3, reps: "12",      rest: "90s" },
      { name: "Plank",               sets: 3, reps: "30s",     rest: "45s" },
    ],
    calisthenics: [
      { name: "Archer push-up",         sets: 4, reps: "6–8 each",  rest: "90s" },
      { name: "Pull-up",                sets: 4, reps: "max",        rest: "2 min" },
      { name: "Bulgarian split squat",  sets: 3, reps: "8–10 each", rest: "90s" },
      { name: "Dip",                    sets: 3, reps: "max",        rest: "90s" },
      { name: "L-sit hold",             sets: 3, reps: "10s",        rest: "60s",  notes: "Build to 15s" },
    ],
  },

  bodyweight_only: {
    strength: [
      { name: "Pistol squat progression", sets: 4, reps: "5–8 each", rest: "2 min", notes: "Use chair assist if needed" },
      { name: "Pull-up",                  sets: 4, reps: "max",       rest: "2 min" },
      { name: "Pike push-up",             sets: 3, reps: "8–12",      rest: "90s" },
      { name: "Dip (parallel bars)",      sets: 3, reps: "max",       rest: "90s" },
      { name: "Nordic hamstring curl",    sets: 3, reps: "5–8",       rest: "2 min", notes: "Slow eccentric" },
    ],
    muscle: [
      { name: "Push-up variation",   sets: 4, reps: "max",       rest: "90s",  notes: "Decline, wide, or close-grip" },
      { name: "Pull-up",             sets: 4, reps: "max",       rest: "2 min" },
      { name: "Dip",                 sets: 3, reps: "max",       rest: "90s" },
      { name: "Bodyweight squat",    sets: 3, reps: "25–30",     rest: "60s" },
      { name: "Inverted row",        sets: 3, reps: "max",       rest: "90s" },
    ],
    athlete: [
      { name: "Broad jump",          sets: 4, reps: "5",         rest: "90s",  notes: "Max distance, stick landing" },
      { name: "Pull-up",             sets: 3, reps: "max",       rest: "90s" },
      { name: "Push-up",             sets: 3, reps: "max",       rest: "60s" },
      { name: "Jump squat",          sets: 4, reps: "10",        rest: "60s" },
      { name: "Burpee",              sets: 3, reps: "8",         rest: "60s" },
    ],
    fat_loss: [
      { name: "Burpee",              sets: 4, reps: "10",        rest: "30s" },
      { name: "Jump squat",          sets: 4, reps: "15",        rest: "30s" },
      { name: "Push-up",             sets: 3, reps: "max",       rest: "30s" },
      { name: "Mountain climber",    sets: 3, reps: "30s",       rest: "30s" },
      { name: "Plank jack",          sets: 3, reps: "30s",       rest: "30s" },
    ],
    general_fitness: [
      { name: "Bodyweight squat",        sets: 3, reps: "15",        rest: "60s" },
      { name: "Push-up",                 sets: 3, reps: "max",       rest: "60s" },
      { name: "Pull-up / inverted row",  sets: 3, reps: "max",       rest: "90s" },
      { name: "Reverse lunge",           sets: 3, reps: "10 each",   rest: "60s" },
      { name: "Plank",                   sets: 3, reps: "30s",       rest: "45s" },
    ],
    calisthenics: [
      { name: "Planche push-up progression", sets: 4, reps: "5–8",       rest: "2 min", notes: "Tuck or straddle progression" },
      { name: "Front lever row",             sets: 3, reps: "5–6",        rest: "2 min" },
      { name: "Pull-up",                     sets: 4, reps: "max",        rest: "2 min" },
      { name: "L-sit",                       sets: 3, reps: "15–20s",     rest: "90s" },
      { name: "Pistol squat",                sets: 3, reps: "5–8 each",   rest: "2 min" },
    ],
  },
};

// How many exercises to include based on session duration
const EXERCISE_COUNT_BY_DURATION: Record<SessionDuration, number> = {
  "20min":  3,
  "30min":  4,
  "45min":  5,
  "60min":  6,
  "90min+": 8,   // bank capped at 6 — generator adds extra sets instead
};

// Duration in minutes for each SessionDuration value
const DURATION_MINS: Record<SessionDuration, number> = {
  "20min":  20,
  "30min":  30,
  "45min":  45,
  "60min":  60,
  "90min+": 90,
};

// Focus label per split
const SPLIT_FOCUS: Record<WorkoutSplit, string> = {
  full_body:          "Full-body compound movements",
  upper_body:         "Upper body — push and pull patterns",
  lower_body:         "Lower body — squat and hinge patterns",
  push:               "Push — chest, shoulders, triceps",
  pull:               "Pull — back and biceps",
  push_pull_legs:     "Push/pull/legs rotation",
  athletic_circuit:   "Athletic circuit — power, speed, conditioning",
  hiit:               "High-intensity intervals — max output, short rest",
  bodyweight_circuit: "Bodyweight circuit — skill and strength",
  strength_compound:  "Compound strength — squat, deadlift, press",
  active_recovery:    "Active recovery — mobility and light movement",
};

// ─────────────────────────────────────────────────────────────────────────────
// Workout generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cross-domain intensity derivation.
 * Priority chain: goal signals → combined recovery signals → individual recovery signals → experience level.
 */
function deriveIntensity(
  profile: AiraUserProfile,
  reasoning: string[],
): IntensityLevel {
  const { sleepQuality, stressLevel, energyBaseline } = profile.recovery;
  const goal = profile.goals.primaryGoal;

  // Base intensity from training style
  const styleIntensity: Record<TrainingStyle, IntensityLevel> = {
    athlete:         "high",
    muscle:          "moderate",
    strength:        "high",
    fat_loss:        "high",
    general_fitness: "moderate",
    calisthenics:    "high",
  };
  let intensity: IntensityLevel = styleIntensity[profile.training.trainingStyle];

  const TIERS: IntensityLevel[] = ["low", "moderate", "high", "max"];
  function capAt(cap: IntensityLevel) {
    const idx = TIERS.indexOf(intensity);
    const capIdx = TIERS.indexOf(cap);
    if (idx > capIdx) intensity = cap;
  }

  // ── GOAL PRIORITY (highest): goal can push intensity UP ──────────────────
  // build_muscle and get_stronger goals warrant higher base intensity.
  // lose_fat and improve_athleticism keep the style baseline — volume matters more.
  if ((goal === "build_muscle" || goal === "get_stronger") && intensity === "moderate") {
    intensity = "high";
    reasoning.push(
      goal === "build_muscle"
        ? "Your goal is to build muscle — intensity starts high because progressive overload is the primary driver."
        : "Your goal is to get stronger — intensity starts high because strength gains require near-maximal efforts."
    );
  }

  // ── CROSS-DOMAIN RULE: poor sleep + high stress ───────────────────────────
  // Both signals together are worse than either alone — combined suppression.
  const poorSleep   = sleepQuality === "poor" || sleepQuality === "fair";
  const highStress  = stressLevel === "high" || stressLevel === "very_high";
  if (poorSleep && highStress) {
    capAt("low");
    reasoning.push(
      "Your body is running on both low recovery sleep and high stress — that combination is a double tax on your nervous system. " +
      "Today's intensity drops to low: focus on movement quality, not output. " +
      "Pushing through this state doesn't build fitness — it digs a deeper recovery hole."
    );
    return intensity; // skip individual checks — combined rule already applied the harshest cap
  }

  // ── INDIVIDUAL RECOVERY SIGNALS ───────────────────────────────────────────
  if (sleepQuality === "poor") {
    capAt("moderate");
    reasoning.push(
      "You're running on poor sleep — intensity is capped at moderate. " +
      "Sleep is when the body repairs from training; without it, hard effort produces poor output and raises injury risk."
    );
  } else if (sleepQuality === "fair") {
    capAt("moderate");
    reasoning.push(
      "Sleep quality was fair, not great — intensity stays at moderate to respect your reduced adaptation window. " +
      "A solid night's sleep before tomorrow will allow a harder session."
    );
  }

  if (stressLevel === "very_high") {
    capAt("low");
    reasoning.push(
      "Stress is very high right now — your cortisol is already elevated, and adding a hard training session on top " +
      "compounds total systemic load. Today stays light so training supports recovery instead of fighting it."
    );
  } else if (stressLevel === "high") {
    capAt("moderate");
    reasoning.push(
      "Background stress is high, which limits how well you'll adapt from hard training. " +
      "Intensity is capped at moderate — this is disciplined, not soft."
    );
  }

  if (energyBaseline === "low") {
    capAt("moderate");
    reasoning.push(
      "Your baseline energy is low — this is your body telling you something. " +
      "Today's session stays at moderate intensity: you'll still train, but without pushing into a deficit you'll struggle to recover from."
    );
  }

  // ── EXPERIENCE LEVEL (lowest priority) ───────────────────────────────────
  if (profile.training.experience === "beginner") {
    capAt("moderate");
    reasoning.push(
      "Beginner training blocks prioritise technique and nervous system adaptation over intensity. " +
      "Moderate effort with strict form is more valuable right now than going heavy."
    );
  }

  return intensity;
}

function determineWorkoutSplit(
  trainingStyle: TrainingStyle,
  daysPerWeek: number,
  gymAccess: GymAccess,
): WorkoutSplit {
  // Bodyweight-only defaults to circuits regardless of other factors
  if (gymAccess === "bodyweight_only") {
    if (trainingStyle === "calisthenics") return "bodyweight_circuit";
    if (trainingStyle === "fat_loss")     return "hiit";
    return "full_body";
  }

  if (trainingStyle === "athlete")   return "athletic_circuit";
  if (trainingStyle === "fat_loss")  return daysPerWeek >= 4 ? "hiit" : "full_body";
  if (trainingStyle === "calisthenics") return "bodyweight_circuit";

  if (trainingStyle === "strength") {
    if (daysPerWeek <= 3) return "full_body";
    if (daysPerWeek === 4) return "upper_body";   // upper/lower rotation
    return "push";                                // PPL rotation
  }

  if (trainingStyle === "muscle") {
    if (daysPerWeek <= 3) return "full_body";
    if (daysPerWeek === 4) return "push";         // push/pull rotation
    return "push";                                // PPL rotation
  }

  // general_fitness
  return "full_body";
}

/** Apply experience-level scaling to a set of exercises. */
function scaleForExperience(
  exercises: ExerciseEntry[],
  experience: ExperienceLevel,
  reasoning: string[],
): ExerciseEntry[] {
  if (experience === "beginner") {
    reasoning.push("Exercise selection simplified for beginner — fewer exercises, reduced sets, longer rest for form focus.");
    return exercises.map((e) => ({
      ...e,
      sets:  Math.max(2, e.sets - 1),
      rest:  addRestBuffer(e.rest, 30),
      notes: e.notes ? `${e.notes} — prioritise form over load` : "Prioritise form over load",
    }));
  }

  if (experience === "advanced") {
    reasoning.push("Advanced training block — sets increased on compound movements; progressive overload principles apply.");
    return exercises.map((e) => ({
      ...e,
      sets: isCompound(e.name) ? e.sets + 1 : e.sets,
    }));
  }

  return exercises; // intermediate: no modification
}

/** Heuristic: does the exercise name match a compound pattern? */
function isCompound(name: string): boolean {
  const COMPOUNDS = ["squat", "deadlift", "press", "row", "clean", "snatch", "pull-up", "dip"];
  const lower = name.toLowerCase();
  return COMPOUNDS.some((c) => lower.includes(c));
}

/**
 * Apply goal-priority modifications to a finalised exercise list.
 *
 * Priority: goal > recovery > experienceLevel (already applied in deriveIntensity and scaleForExperience).
 * This function handles the goal layer — shaping volume, rest, and notes to match what the user is
 * actually trying to achieve, not just their training style preference.
 *
 * Rules:
 *   lose_fat / stay_consistent → shorter rest, higher-rep range, consistency cue
 *   build_muscle               → add a set on compound movements, progressive overload note
 *   get_stronger               → lower rep target on compounds, longer rest, max-effort cue
 *   improve_athleticism        → add explosive execution cue on compound/power movements
 *   stay_consistent            → reduce volume slightly, keep it completable
 */
function applyGoalModifiers(
  exercises:  ExerciseEntry[],
  goal:       AiraUserProfile["goals"]["primaryGoal"],
  intensity:  IntensityLevel,
  reasoning:  string[],
): ExerciseEntry[] {
  // Goals that just need a note rather than structural changes
  if (goal === "improve_athleticism") {
    reasoning.push(
      "Athleticism goal — compound movements get an explosive execution cue to reinforce power development."
    );
    return exercises.map((e) =>
      isCompound(e.name)
        ? { ...e, notes: e.notes ? `${e.notes}; drive through explosively` : "Focus on explosive drive — quality over load" }
        : e
    );
  }

  if (goal === "stay_consistent") {
    reasoning.push(
      "Consistency is the priority — volume is kept completable so you build the habit of showing up, not the habit of skipping because it was too hard."
    );
    // Trim one set from each exercise to keep it finishable
    return exercises.map((e) => ({ ...e, sets: Math.max(2, e.sets - 1) }));
  }

  if (goal === "lose_fat") {
    if (intensity !== "low") {
      reasoning.push(
        "Fat loss goal — rest periods shortened and rep ranges kept in the 12–15 zone. " +
        "Higher training density burns more calories and builds the metabolic conditioning that supports a deficit."
      );
      return exercises.map((e) => ({
        ...e,
        rest:  shortenRest(e.rest),
        notes: e.notes
          ? `${e.notes}; keep rest tight`
          : "Keep rest tight — density is the fat-loss tool here",
      }));
    }
    // At low intensity (recovery day), don't shorten rest
    return exercises;
  }

  if (goal === "build_muscle") {
    reasoning.push(
      "Muscle building goal — sets increased on compound movements. " +
      "Progressive overload is the stimulus; the extra set on the big lifts is where adaptation happens."
    );
    return exercises.map((e) =>
      isCompound(e.name) ? { ...e, sets: e.sets + 1 } : e
    );
  }

  if (goal === "get_stronger") {
    reasoning.push(
      "Strength goal — rest periods extended on compound lifts to allow full nervous system recovery between sets. " +
      "Strength is a skill: each set should be as clean and as heavy as the last."
    );
    return exercises.map((e) =>
      isCompound(e.name)
        ? { ...e, rest: extendRest(e.rest), notes: e.notes ? `${e.notes}; full recovery before next set` : "Full recovery between sets — quality reps only" }
        : e
    );
  }

  return exercises; // no modifier
}

/** Shorten a rest string by ~30 seconds — used for fat loss density. */
function shortenRest(rest: string): string {
  const secMatch = rest.match(/^(\d+)s$/);
  if (secMatch) return `${Math.max(30, parseInt(secMatch[1], 10) - 30)}s`;
  const minMatch = rest.match(/^(\d+)\s*min$/);
  if (minMatch) return `${Math.max(30, parseInt(minMatch[1], 10) * 60 - 30)}s`;
  return rest;
}

/** Extend a rest string by ~30 seconds — used for strength density. */
function extendRest(rest: string): string {
  const secMatch = rest.match(/^(\d+)s$/);
  if (secMatch) return `${parseInt(secMatch[1], 10) + 30}s`;
  const minMatch = rest.match(/^(\d+)\s*min$/);
  if (minMatch) return `${parseInt(minMatch[1], 10)} min 30s`;
  return rest;
}

/** Add buffer seconds to a rest string like "90s" or "2 min". */
function addRestBuffer(rest: string, seconds: number): string {
  const secMatch = rest.match(/^(\d+)s$/);
  if (secMatch) return `${parseInt(secMatch[1], 10) + seconds}s`;
  const minMatch = rest.match(/^(\d+)\s*min$/);
  if (minMatch) return `${parseInt(minMatch[1], 10) * 60 + seconds}s`;
  return rest;
}

export function generateWorkout(
  profile:   AiraUserProfile,
  decisions: PlanDecisions,
  reasoning: string[],
): WorkoutPlan {
  const { training, recovery } = profile;
  const goal = profile.goals.primaryGoal;

  // Intensity and volume come from decisions — already computed and reasoned about
  const intensity    = decisions.intensity;
  const split        = determineWorkoutSplit(training.trainingStyle, training.daysPerWeek, training.gymAccess);
  const durationMins = DURATION_MINS[training.sessionDuration];

  // Volume decision adjusts exercise count up or down one from the duration baseline
  const baseCount  = EXERCISE_COUNT_BY_DURATION[training.sessionDuration];
  const volumeAdj  = decisions.volume === "low" ? -1 : decisions.volume === "high" ? 1 : 0;
  const exerciseCount = Math.min(
    Math.max(2, baseCount + volumeAdj),
    EXERCISE_BANK[training.gymAccess][training.trainingStyle].length,
  );

  reasoning.push(
    `Training split: ${split} — ${training.trainingStyle} style, ${training.daysPerWeek} days/week, ${training.gymAccess.replace(/_/g, " ")}.`
  );
  reasoning.push(
    `Session duration: ${durationMins} min — ${exerciseCount} exercises (volume: ${decisions.volume}${volumeAdj !== 0 ? `, ${volumeAdj > 0 ? "+" : ""}${volumeAdj} from baseline` : ""}).`
  );

  // 2. Experience scaling (lower priority than goal)
  const baseExercises = EXERCISE_BANK[training.gymAccess][training.trainingStyle].slice(0, exerciseCount);
  const scaledExercises = scaleForExperience(baseExercises, training.experience, reasoning);

  // 3. Goal modifiers applied last (highest conceptual priority — shapes the "why")
  const exercises = applyGoalModifiers(scaledExercises, goal, intensity, reasoning);

  // ── Workout-level notes ───────────────────────────────────────────────────
  let notes: string | undefined;
  if (intensity === "low") {
    notes = "Keep all loads light today — the goal is quality movement, not output. Your body needs this session, not a hard one.";
  } else if (intensity === "moderate") {
    if (recovery.stressLevel === "high" || recovery.stressLevel === "very_high") {
      notes = "Work at 70–75% of max effort — one rep in the tank on every set. Your recovery system is already working hard.";
    } else if (recovery.sleepQuality === "fair" || recovery.sleepQuality === "poor") {
      notes = "Solid session — 70–80% effort. Your sleep wasn't ideal, so leave something in reserve.";
    }
  } else if (intensity === "high" && goal === "build_muscle") {
    notes = "Push the working sets — progressive overload is the stimulus. If the last set doesn't challenge you, add weight next time.";
  } else if (intensity === "high" && goal === "get_stronger") {
    notes = "This is a quality day — every rep should be technically sharp. Don't rush the rest periods.";
  }

  const warmupMins   = durationMins <= 30 ? 5 : intensity === "high" || intensity === "max" ? 10 : 7;
  const cooldownMins = durationMins <= 30 ? 3 : 5;

  return {
    split,
    durationMins,
    intensityLevel: intensity,
    warmupMins,
    cooldownMins,
    exercises,
    focus: SPLIT_FOCUS[split],
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Nutrition generator
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a weight string like "185lb", "180lbs", "82kg", "82" into kilograms. */
function parseWeightKg(weightStr: string | undefined, gender: string | undefined): number {
  if (!weightStr) {
    return gender === "female" ? 65 : gender === "male" ? 80 : 72;
  }
  const lower = weightStr.toLowerCase().replace(/\s/g, "");
  const num   = parseFloat(lower);
  if (!isFinite(num)) return 72;
  if (lower.includes("lb")) return Math.round(num * 0.4536);
  return num; // assume kg
}

function estimateCalories(profile: AiraUserProfile): number {
  const base =
    profile.profile.gender === "female" ? 1900 :
    profile.profile.gender === "male"   ? 2400 : 2150;

  const activityBonus =
    profile.training.daysPerWeek >= 6 ? 500 :
    profile.training.daysPerWeek >= 4 ? 350 :
    profile.training.daysPerWeek >= 2 ? 200 : 100;

  const goalAdj: Record<NutritionGoalKind, number> = {
    fat_loss:    -400,
    muscle_gain: +400,
    maintenance:    0,
    performance: +250,
  };

  return base + activityBonus + goalAdj[profile.nutrition.nutritionGoal];
}

function estimateMacros(profile: AiraUserProfile, calories: number): MacroTarget {
  const weightKg = parseWeightKg(profile.profile.weight, profile.profile.gender);

  const proteinMultiplier: Record<NutritionGoalKind, number> = {
    fat_loss:    2.2,
    muscle_gain: 2.2,
    maintenance: 1.8,
    performance: 2.0,
  };

  const protein  = Math.round(weightKg * proteinMultiplier[profile.nutrition.nutritionGoal]);
  const proteinCals = protein * 4;

  // Keto: very low carb, high fat
  if (profile.nutrition.dietaryStyle === "keto") {
    const fats  = Math.round((calories * 0.70) / 9);
    const carbs = Math.round((calories - proteinCals - fats * 9) / 4);
    return { protein, carbs: Math.max(20, carbs), fats, calories };
  }

  // Fat loss: lower carbs, moderate fat
  if (profile.nutrition.nutritionGoal === "fat_loss") {
    const fats  = Math.round((calories * 0.28) / 9);
    const carbs = Math.round((calories - proteinCals - fats * 9) / 4);
    return { protein, carbs: Math.max(50, carbs), fats, calories };
  }

  // Performance / muscle gain: higher carbs
  const fats  = Math.round((calories * 0.25) / 9);
  const carbs = Math.round((calories - proteinCals - fats * 9) / 4);
  return { protein, carbs: Math.max(80, carbs), fats, calories };
}

/** Build meal list based on mealPrepLevel and dietary style. Returns concrete meal descriptions. */
function buildMeals(
  mealPrepLevel: MealPrepLevel,
  nutritionGoal: NutritionGoalKind,
  dietaryStyle: DietaryStyle,
): MealEntry[] {
  // Protein source mapping by dietary style
  const protein1 = (
    dietaryStyle === "vegan"       ? "tempeh or firm tofu" :
    dietaryStyle === "vegetarian"  ? "eggs or Greek yoghurt" :
    dietaryStyle === "pescatarian" ? "canned salmon or tuna" :
    "chicken breast or lean turkey"
  );
  const protein2 = (
    dietaryStyle === "vegan"       ? "edamame or black beans" :
    dietaryStyle === "vegetarian"  ? "cottage cheese or lentils" :
    dietaryStyle === "pescatarian" ? "shrimp or white fish" :
    "lean beef or eggs"
  );
  const breakfastProtein = (
    dietaryStyle === "vegan"      ? "tofu scramble with nutritional yeast" :
    dietaryStyle === "keto"       ? "3 eggs, bacon, avocado" :
    "3–4 eggs scrambled"
  );

  const carbSource = (
    dietaryStyle === "keto"  ? "spinach and mushrooms (no grain)" :
    nutritionGoal === "fat_loss" ? "oats or sweet potato (small portion)" :
    "oats or whole-grain bread"
  );

  const baseMeals: MealEntry[] = [
    {
      name:    "Breakfast",
      description: `${breakfastProtein}, ${carbSource}, black coffee or green tea`,
      focus:   "High protein, controlled carbs to start",
      timing:  "Within 60 min of waking",
    },
    {
      name:    "Lunch",
      description: `200g ${protein1}, 150g brown rice or quinoa, large salad with olive oil`,
      focus:   nutritionGoal === "fat_loss" ? "Protein + fibre — largest meal of the day" : "Balanced protein + carbs for sustained energy",
      timing:  "Midday",
    },
    {
      name:    "Dinner",
      description: `200g ${protein2}, roasted vegetables, ${nutritionGoal === "fat_loss" ? "small serving of sweet potato" : "serving of pasta or rice"}`,
      focus:   "Protein and micronutrients — lighter on carbs than lunch",
      timing:  "3–4 hrs before bed",
    },
  ];

  if (mealPrepLevel === "minimal") {
    return baseMeals; // 3 simple meals
  }

  const snack1: MealEntry = {
    name:    "Pre-workout snack",
    description: dietaryStyle === "keto"
      ? "Handful of nuts and a hard-boiled egg"
      : "Banana and 1 tbsp peanut butter",
    focus:   "Quick carbs + fat for sustained energy",
    timing:  "30–60 min before training",
  };

  if (mealPrepLevel === "moderate") {
    return [...baseMeals, snack1]; // 3 meals + 1 snack
  }

  // full_prep: 3 meals + 2 snacks
  const snack2: MealEntry = {
    name:    "Post-workout shake",
    description: dietaryStyle === "vegan"
      ? "Plant protein shake (30g protein) with oat milk and frozen berries"
      : "Whey protein shake (30g protein) with 250ml milk or water",
    focus:   "Fast protein to initiate muscle protein synthesis",
    timing:  "Within 30 min of finishing training",
  };

  return [...baseMeals, snack1, snack2];
}

function buildSupplements(profile: AiraUserProfile): string[] {
  const supps: string[] = [];

  if (profile.nutrition.nutritionGoal === "muscle_gain" || profile.training.trainingStyle === "strength") {
    supps.push("Creatine monohydrate — 5g with water (any time)");
  }

  if (profile.nutrition.nutritionGoal === "performance") {
    supps.push("Caffeine — 100–200mg, 30 min pre-workout");
  }

  if (profile.recovery.sleepQuality === "poor" || profile.recovery.sleepQuality === "fair") {
    supps.push("Magnesium glycinate — 300mg, 30 min before bed");
  }

  if (profile.profile.gender === "female") {
    supps.push("Iron — check with GP; common deficiency in active women");
  }

  supps.push("Vitamin D3 + K2 — 2000IU D3 daily with a meal containing fat");

  return supps;
}

export function generateNutrition(
  profile:   AiraUserProfile,
  decisions: PlanDecisions,
  reasoning: string[],
): NutritionPlan {
  const { nutrition, goals } = profile;

  // Log the nutrition strategy decision early so it leads the nutrition reasoning block
  reasoning.push(`Nutrition strategy: ${decisions.nutritionStrategy}.`);

  const strategy: "deficit" | "maintenance" | "surplus" =
    nutrition.nutritionGoal === "fat_loss"    ? "deficit"     :
    nutrition.nutritionGoal === "muscle_gain" ? "surplus"     :
    nutrition.nutritionGoal === "maintenance" ? "maintenance" : "maintenance"; // performance → maintenance+

  const calories     = estimateCalories(profile);
  const macros       = estimateMacros(profile, calories);
  const meals        = buildMeals(nutrition.mealPrepLevel, nutrition.nutritionGoal, nutrition.dietaryStyle);
  const supplements  = buildSupplements(profile);

  // Hydration: base + activity + deficit bonus
  const hydration =
    2.5 +
    (profile.training.daysPerWeek >= 4 ? 0.5 : 0.3) +
    (nutrition.nutritionGoal === "fat_loss" ? 0.3 : 0);

  const keyPrinciple =
    strategy === "deficit"     ? `High protein (${macros.protein}g), moderate caloric deficit — preserve muscle while losing fat` :
    strategy === "surplus"     ? `High protein (${macros.protein}g), controlled surplus — maximise muscle growth, minimise fat gain` :
    nutrition.nutritionGoal === "performance" ? `High carbs, performance-focused — fuel output and recovery` :
                                 `Maintenance calories, quality-first — optimise energy and body composition`;

  // Human reasoning — specific to the goal, not just technical labels
  if (goals.primaryGoal === "lose_fat") {
    reasoning.push(
      `Nutrition is in a caloric deficit (~${calories} kcal) — this is the primary fat loss lever. ` +
      `Protein stays high at ${macros.protein}g to preserve the muscle you've built. ` +
      "Consistency here matters more than perfection on any single day."
    );
  } else if (goals.primaryGoal === "build_muscle") {
    reasoning.push(
      `Nutrition is in a controlled surplus (~${calories} kcal) — muscle can't be built without adequate energy. ` +
      `${macros.protein}g protein provides the raw material; the surplus provides the fuel for growth. ` +
      "Hit the protein number before anything else."
    );
  } else if (goals.primaryGoal === "get_stronger") {
    reasoning.push(
      `Maintenance-plus calories (~${calories} kcal) support strength adaptation without unnecessary fat gain. ` +
      `${macros.protein}g protein fuels repair of the connective tissue and muscle stressed by heavy loading.`
    );
  } else {
    reasoning.push(
      `Nutrition strategy: ${strategy} (~${calories} kcal) — aligned with your ${goals.primaryGoal.replace(/_/g, " ")} goal. ` +
      `${macros.protein}g protein, ${macros.carbs}g carbs, ${macros.fats}g fat.`
    );
  }

  reasoning.push(
    `${meals.length} meals planned — ${
      nutrition.mealPrepLevel === "minimal"  ? "simple and quick to prepare, no pre-planning needed" :
      nutrition.mealPrepLevel === "moderate" ? "moderate prep with a pre-workout snack added" :
                                               "full day mapped with pre- and post-workout nutrition windows"
    }.`
  );

  if (nutrition.dietaryStyle !== "everything") {
    reasoning.push(`Dietary style (${nutrition.dietaryStyle}) applied — protein sources adjusted to match your preferences.`);
  }

  return {
    caloricStrategy: strategy,
    dailyTarget:     macros,
    hydrationLiters: Math.round(hydration * 10) / 10,
    meals,
    supplements,
    keyPrinciple,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a readiness tier from the three recovery metrics.
 *
 * Scoring:
 *   sleepQuality:  poor=0  fair=1  good=2  great=3
 *   stressLevel:   very_high=-2  high=-1  moderate=0  low=+1
 *   energyBaseline: low=-1  moderate=0  high=+1
 *
 *   Total range: -3 (worst) to +5 (best)
 *   Push:    4–5  (great conditions — go hard)
 *   Maintain: 1–3  (average — steady effort)
 *   Recover: ≤0   (depleted — back off)
 */
export function computeReadinessTier(
  sleepQuality:    SleepQuality,
  stressLevel:     StressLevel,
  energyBaseline:  EnergyLevel,
): ReadinessTier {
  const sleepScore:  Record<SleepQuality, number> = { poor: 0, fair: 1, good: 2, great: 3 };
  const stressScore: Record<StressLevel, number>  = { very_high: -2, high: -1, moderate: 0, low: 1 };
  const energyScore: Record<EnergyLevel, number>  = { low: -1, moderate: 0, high: 1 };

  const total =
    sleepScore[sleepQuality] +
    stressScore[stressLevel] +
    energyScore[energyBaseline];

  if (total >= 4) return "Push";
  if (total <= 0) return "Recover";
  return "Maintain";
}

export function generateRecovery(
  profile:   AiraUserProfile,
  decisions: PlanDecisions,
  reasoning: string[],
): RecoveryPlan {
  const { recovery } = profile;
  const tier = computeReadinessTier(recovery.sleepQuality, recovery.stressLevel, recovery.energyBaseline);

  // Emphasise recovery when the decision engine flagged it as high priority
  if (decisions.recoveryPriority === "high") {
    reasoning.push(
      "Recovery priority is HIGH — your body is flagging at least one depleting signal (poor sleep or elevated stress). " +
      "The recovery protocols in today's plan are non-optional: skipping them when depleted is the fastest route to stalled progress and injury."
    );
  }

  // Human-readable readiness explanation
  const tierExplanation =
    tier === "Push"
      ? `Your recovery signals are all green — good sleep, manageable stress, solid energy. ` +
        `This is a day to push: higher intensity, higher volume, and full commitment to the session.`
      : tier === "Recover"
      ? `Your recovery scores are low (sleep: ${recovery.sleepQuality}, stress: ${recovery.stressLevel}, energy: ${recovery.energyBaseline}). ` +
        `Today's plan is built around restoration — light movement, not intensity. ` +
        `The best thing you can do for tomorrow is treat today as a recovery investment.`
      : `You're in the middle tier — not fully recovered, not depleted. ` +
        `Today calls for steady effort: execute the plan at 70–80%, protect your sleep tonight, and push tomorrow.`;
  reasoning.push(tierExplanation);

  const intensityBudget: IntensityLevel =
    tier === "Push"     ? "high" :
    tier === "Maintain" ? "moderate" : "low";

  const sleepTargetHrs =
    tier === "Recover" ? 9 :
    tier === "Maintain" ? 8 : 7.5;

  const windDownMins =
    tier === "Recover" ? 60 :
    tier === "Maintain" ? 45 : 30;

  const stressFlag = recovery.stressLevel === "high" || recovery.stressLevel === "very_high";

  if (stressFlag) {
    reasoning.push(
      "Stress is elevated — the evening protocol prioritises cortisol reduction through breathing work before sleep. " +
      "High cortisol at bedtime is one of the most common reasons for poor sleep quality."
    );
  }

  if (recovery.sleepQuality === "poor") {
    reasoning.push(
      "Last night's sleep was poor — wind-down is extended to 60 minutes and tonight's target is 9 hours. " +
      "One bad night doesn't derail progress, but two in a row will."
    );
  }

  // Morning protocols
  const morningProtocols: RecoveryProtocol[] = [
    {
      name:         "Morning hydration",
      durationMins: 2,
      description:  "500ml water immediately on waking — rehydrates overnight deficit and activates digestion.",
    },
  ];

  if (tier !== "Push") {
    morningProtocols.push({
      name:         "Diaphragmatic breathing",
      durationMins: 5,
      description:  "5 min box breathing (4s inhale, 4s hold, 4s exhale, 4s hold) — activates parasympathetic recovery.",
    });
  }

  morningProtocols.push({
    name:         "Light mobility",
    durationMins: tier === "Recover" ? 10 : 5,
    description:  tier === "Recover"
      ? "10 min full-body mobility — hip circles, thoracic rotation, shoulder circles. No load."
      : "5 min joint priming — hip flexor stretch, shoulder roll, ankle circles.",
  });

  // Evening protocols
  const eveningProtocols: RecoveryProtocol[] = [];

  if (stressFlag || tier === "Recover") {
    eveningProtocols.push({
      name:         "Stress-deload breathing",
      durationMins: 10,
      description:  "10 min 4-7-8 breathing or guided body scan — cortisol reduction before sleep.",
    });
  }

  eveningProtocols.push({
    name:         "Foam rolling",
    durationMins: tier === "Recover" ? 15 : 10,
    description:  tier === "Recover"
      ? "15 min full-body foam roll — quads, hamstrings, lats, thoracic spine, calves."
      : "10 min targeted foam roll — focus on muscles trained today.",
  });

  eveningProtocols.push({
    name:         "Screen cutoff",
    durationMins: 0,
    description:  `No screens from ${windDownMins} min before bed — blue light suppresses melatonin onset.`,
  });

  let notes: string | undefined;
  if (tier === "Recover") {
    notes = "Recovery day — skip heavy training if scheduled. A short walk or yoga session is the ceiling for today.";
  } else if (tier === "Maintain" && stressFlag) {
    notes = "High stress load — treat today as maintenance even if energy feels adequate. Protecting recovery wins long-term.";
  }

  return {
    readinessTier: tier,
    intensityBudget,
    sleepTargetHrs,
    windDownMins,
    morningProtocols,
    eveningProtocols,
    stressFlag,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan focus derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a single human-readable label that summarises the day's coaching priority.
 *
 * Priority: combined recovery state → goal → readiness tier.
 *
 * Used in meta.focus and synthesiseAIPlan (disciplineTarget in the Today screen).
 */
function derivePlanFocus(
  profile:  AiraUserProfile,
  tier:     ReadinessTier,
): string {
  const goal = profile.goals.primaryGoal;
  const { sleepQuality, stressLevel } = profile.recovery;
  const poorSleep  = sleepQuality === "poor" || sleepQuality === "fair";
  const highStress = stressLevel === "high" || stressLevel === "very_high";

  // Worst-case combined state overrides everything
  if (poorSleep && highStress) return "Recovery optimization day";
  if (tier === "Recover")      return "Active recovery day";

  if (tier === "Push") {
    if (goal === "build_muscle")        return "High-volume muscle building day";
    if (goal === "get_stronger")        return "Max-strength execution day";
    if (goal === "lose_fat")            return "High-intensity calorie burn day";
    if (goal === "improve_athleticism") return "Athletic performance day";
    return "Full effort execution day";
  }

  // Maintain tier — goal shapes the day's priority
  if (goal === "lose_fat")            return "Consistent calorie deficit day";
  if (goal === "build_muscle")        return "Progressive volume day";
  if (goal === "get_stronger")        return "Strength skill day";
  if (goal === "stay_consistent")     return "Show up and execute day";
  if (goal === "improve_athleticism") return "Movement quality day";
  return "Steady execution day";
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule generator
// ─────────────────────────────────────────────────────────────────────────────

/** Map preferredWorkoutTime → offset from wakeTime in minutes. */
function workoutOffsetMins(
  preference: string | undefined,
  wakeMin: number,
): number {
  // Returns absolute minutes-since-midnight, not an offset
  switch (preference) {
    case "early_morning": return wakeMin + 30;                  // 30 min after waking
    case "morning":       return wakeMin + 90;                  // 90 min after waking
    case "afternoon":     return 13 * 60;                       // 1:00 PM
    case "evening":       return 18 * 60;                       // 6:00 PM
    case "night":         return 20 * 60;                       // 8:00 PM
    default:              return wakeMin + 90;                  // default: morning
  }
}

export function generateSchedule(
  profile:      AiraUserProfile,
  workoutPlan:  WorkoutPlan,
  recoveryPlan: RecoveryPlan,
  decisions:    PlanDecisions,
  reasoning:    string[],
): SchedulePlan {
  const wakeMin  = parseTime(profile.sleep.wakeTime);
  const sleepMin = parseTime(profile.sleep.sleepTime);

  // Handle overnight sleepTime (e.g. wake 6 AM, sleep 11 PM)
  const adjustedSleepMin = sleepMin < wakeMin ? sleepMin + 1440 : sleepMin;

  const workoutMin    = workoutOffsetMins(profile.schedule.preferredWorkoutTime, wakeMin);
  const windDownStart = adjustedSleepMin - recoveryPlan.windDownMins;

  const workoutTimeText  = minutesToTime(workoutMin);
  const windDownTimeText = minutesToTime(windDownStart);

  reasoning.push(`Workout scheduled at ${workoutTimeText} — based on preferredWorkoutTime "${profile.schedule.preferredWorkoutTime ?? "morning (default)"}."`);
  reasoning.push(`Wind-down starts at ${windDownTimeText} — ${recoveryPlan.windDownMins} min buffer before ${profile.sleep.sleepTime} bedtime.`);

  if (decisions.scheduleStrategy === "adaptive") {
    reasoning.push(
      "Schedule strategy: adaptive — your schedule consistency is irregular, so today's times are targets, not rules. " +
      "Completing the session matters far more than hitting the exact start time. " +
      "If your day shifts, move the workout — don't skip it."
    );
  }

  const blocks: ScheduledBlock[] = [];

  // Wake ritual
  blocks.push({
    label:        "Morning hydration + mobility",
    timeText:     minutesToTime(wakeMin + 10),
    durationMins: 12,
    kind:         "Mobility",
  });

  // Workout
  blocks.push({
    label:        `${workoutPlan.split.replace(/_/g, " ")} — ${workoutPlan.durationMins} min`,
    timeText:     workoutTimeText,
    durationMins: workoutPlan.durationMins,
    kind:         "Workout",
  });

  // Post-workout nutrition (within 30–45 min of workout end)
  const postWorkoutMin = workoutMin + workoutPlan.durationMins + 20;
  blocks.push({
    label:        "Post-workout meal",
    timeText:     minutesToTime(postWorkoutMin),
    durationMins: 20,
    kind:         "Nutrition",
  });

  // Midday hydration
  const midMin = Math.round((wakeMin + adjustedSleepMin) / 2);
  if (midMin > postWorkoutMin + 60 && midMin < windDownStart - 60) {
    blocks.push({
      label:        "Midday hydration check",
      timeText:     minutesToTime(midMin),
      durationMins: 5,
      kind:         "Hydration",
    });
  }

  // Evening recovery
  blocks.push({
    label:        "Foam rolling + mobility",
    timeText:     minutesToTime(windDownStart - 20),
    durationMins: recoveryPlan.readinessTier === "Recover" ? 15 : 10,
    kind:         "Recovery",
  });

  // Wind-down
  blocks.push({
    label:        "Wind-down — screens off",
    timeText:     windDownTimeText,
    durationMins: recoveryPlan.windDownMins,
    kind:         "Sleep",
  });

  // Sort by time (handles overnight correctly since we adjusted sleepMin)
  blocks.sort((a, b) => parseTime(a.timeText) - parseTime(b.timeText));

  return {
    workoutTimeText,
    windDownTimeText,
    blocks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a complete daily plan from an AiraUserProfile.
 *
 * Deterministic: same profile → same plan, always.
 * All reasoning decisions are captured in meta.reasoning.
 *
 * Signal flow (single pass, no duplication):
 *   extractSignals       → PlanSignals          (profile read: once)
 *   derivePlanDecisions  → PlanDecisions         (consumes signals)
 *   generatePlanExplanation → PlanExplanation    (consumes same signals + decisions)
 *   generateRefinementPrompts → string[]         (consumes profile via engine)
 *   domain generators    → WorkoutPlan, etc.     (consume decisions, not signals directly)
 *
 * Consistency guarantee:
 *   The same `signals` object drives decisions, explanation, and generator inputs.
 *   If low sleep → decisions.recoveryPriority = "high" → explanation.recoveryReason
 *   reflects this → refinement engine surfaces "noEnhancedRecovery" — no contradiction
 *   is possible because all three read from the identical signal source.
 *
 * @param profile — AiraUserProfile from onboarding or normalizeProfileForPlanning.
 * @returns       — GeneratedDailyPlan; throws are caught and re-thrown with context.
 */
export function generateDailyPlan(profile: AiraUserProfile): GeneratedDailyPlan {
  // Safety: surface a useful error rather than a cryptic undefined-access crash
  // if somehow called with a malformed profile.
  try {
    return _generateDailyPlan(profile);
  } catch (err) {
    throw new Error(
      `[generateDailyPlan] Failed to generate plan for profile "${profile?.profile?.firstName ?? "unknown"}": ${String(err)}`
    );
  }
}

function _generateDailyPlan(profile: AiraUserProfile): GeneratedDailyPlan {
  const reasoning: string[] = [];

  // ── Phase 1: Signal extraction — single source of truth ─────────────────
  // extractSignals is called exactly once. The result is threaded into every
  // subsequent phase so no subsystem re-reads profile fields independently.
  const signals = extractSignals(profile);

  // ── Phase 2: Decision engine ─────────────────────────────────────────────
  // derivePlanDecisions receives pre-computed signals — no second extraction.
  // Includes confidence-based safety caps for incomplete profiles.
  const decisions       = derivePlanDecisions(profile, reasoning, signals);
  const confidenceLevel = deriveConfidenceLevel(profile);

  // ── Phase 3: Explanation + personalization (pure, no reasoning side-effects) ─
  // Same `signals` used here — decisions, explanation, and refinement are all
  // reading from the same snapshot of the user's state.
  const explanation     = generatePlanExplanation(signals, decisions, confidenceLevel);
  const personalization: PlanPersonalization = {
    confidenceLevel,
    confidenceScore:   profile.meta?.dataConfidenceScore ?? 0,
    refinementPrompts: generateRefinementPrompts(profile),
  };

  // ── Phase 4: Domain generators (decisions-aware) ─────────────────────────
  // Generators consume `decisions`, not raw signals — they never re-derive
  // anything already computed in Phase 2.
  const recovery  = generateRecovery(profile, decisions, reasoning);
  const workout   = generateWorkout(profile, decisions, reasoning);
  const nutrition = generateNutrition(profile, decisions, reasoning);
  const schedule  = generateSchedule(profile, workout, recovery, decisions, reasoning);

  reasoning.push(`Day focus: "${decisions.focus}"`);

  return {
    workout,
    nutrition,
    recovery,
    schedule,
    meta: {
      generatedAt:  new Date().toISOString(),
      focus:        decisions.focus,
      decisions,
      explanation,
      personalization,
      reasoning,
    },
  };
}
