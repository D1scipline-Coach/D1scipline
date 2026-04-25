/**
 * shared/intelligence/engines/workoutEngine.ts
 *
 * Workout Engine — Phase 3 (hardened)
 *
 * Intelligence model:
 *   Produces 3-tier output (optimal / adjusted / fallback) driven entirely by the
 *   WorkoutDataPacket. Tier determines specificity, aggressiveness, and personalization
 *   depth of reasoning, recommendations, and warnings.
 *
 *   optimal  — canRun + confidenceScore ≥ 76: fully personalised, aggressive programming
 *   adjusted — canRun + confidenceScore < 76: conservative, semi-personalised
 *   fallback — !canRun: generic light-movement, explicit blockers listed
 *
 * ─── Packet consumption ────────────────────────────────────────────────────────
 *   packet.canRun              → gates normal vs fallback path
 *   packet.degradedMode        → same as !canRun; never checked separately
 *   packet.confidenceScore     → tier selection + mapped to ConfidenceLevel
 *   packet.signals.readinessTier → replaces computeReadinessTier() call (pre-computed)
 *   packet.decisions           → primary driver of intensity/volume/focus reasoning
 *   packet.profileSnapshot     → injury status, gym access, recovery state
 *   packet.missingCriticalData → surfaced in warnings[] and fallback recommendations[]
 *
 * ─── normalizedInput role (backward compat) ───────────────────────────────────
 *   Still used to pass AiraUserProfile + PlanDecisions to generateWorkout().
 *   generateWorkout() requires the full type — packet.profileSnapshot + packet.decisions
 *   are domain-scoped subsets that do not satisfy it in Phase 3.
 *   Phase 4: replace generateWorkout() delegation with native engine logic; remove
 *   normalizedInput dependency from this engine entirely.
 *
 * PLANNER OWNERSHIP RULE:
 *   Never sets scheduledTime. Planner Engine resolves all task times.
 */

import type {
  NormalizedIntelligenceInput,
  WorkoutEngineOutput,
  WorkoutDataPacket,
  EngineOutputStatus,
  EngineFormattedOutput,
  IntelligenceTask,
  IntelligencePriority,
  IntelligenceTaskStatus,
  AdaptationEffect,
} from "../types";
import { buildTaskId, ENGINE_PHASE_VERSION } from "../constants";
import { generateWorkout } from "../../planner/generateDailyPlan";
import type { ConfidenceLevel, ReadinessTier, WorkoutPlan } from "../../planner/generateDailyPlan";
import { TaskKind } from "../../planner/types";

// ─────────────────────────────────────────────────────────────────────────────
// Status helpers — local to this engine
// ─────────────────────────────────────────────────────────────────────────────

function deriveStatus(canRun: boolean, confidenceScore: number): EngineOutputStatus {
  if (!canRun)              return "fallback";
  if (confidenceScore >= 76) return "optimal";
  return "adjusted";
}

function mapConfidence(confidenceScore: number): ConfidenceLevel {
  if (confidenceScore >= 76) return "high";
  if (confidenceScore >= 51) return "medium";
  return "low";
}

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning — explains WHY the session was prescribed
// ─────────────────────────────────────────────────────────────────────────────

function buildReasoning(
  packet:       WorkoutDataPacket,
  plan:         WorkoutPlan,
  readinessTier: ReadinessTier,
  status:       EngineOutputStatus,
): string[] {
  const { signals, decisions, profileSnapshot, confidenceScore } = packet;

  if (status === "fallback") {
    const blockers = packet.missingCriticalData.map((f) => f.label).join(", ");
    return [
      `Fallback mode active — critical training data absent: ${blockers || "unspecified fields"}.`,
      "Light movement prescribed as a safe, profile-neutral default.",
      "Personalised programming is unavailable until the listed fields are completed.",
    ];
  }

  const r: string[] = [];

  // ── Intensity reasoning ──────────────────────────────────────────────────
  const tierDesc =
    readinessTier === "Push"
      ? "Push — all recovery signals support full training load"
      : readinessTier === "Maintain"
      ? "Maintain — moderate effort appropriate; recovery is partial"
      : "Recover — recovery state overrides training load; intensity is reduced";
  r.push(
    `Intensity: ${decisions.intensity} — readiness tier is ${tierDesc}. ` +
    `(sleep: ${profileSnapshot.recoveryState.sleepQuality}, ` +
    `stress: ${profileSnapshot.recoveryState.stressLevel}, ` +
    `energy: ${profileSnapshot.recoveryState.energyBaseline})`
  );

  // ── Volume reasoning ─────────────────────────────────────────────────────
  r.push(
    `Volume: ${decisions.volume} — ${signals.trainingDays} sessions/week ` +
    `at ${signals.experience} experience level; ` +
    `${signals.sessionDuration} session duration.`
  );

  // ── Focus reasoning ──────────────────────────────────────────────────────
  r.push(
    `Focus: ${decisions.focus} — goal "${signals.goal}" drives split selection and exercise programming.`
  );

  // ── Session plan ─────────────────────────────────────────────────────────
  r.push(
    `Session: ${plan.split.replace(/_/g, " ")} | ${plan.durationMins} min | ` +
    `${plan.exercises.length} exercises | ` +
    `${plan.warmupMins} min warm-up + ${plan.cooldownMins} min cool-down.`
  );

  if (status === "adjusted") {
    r.push(
      `Output is conservative (confidenceScore: ${confidenceScore}) — ` +
      "some training parameters are estimated from partial profile data."
    );
  }

  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Warnings — data quality alerts (only when issues exist)
// ─────────────────────────────────────────────────────────────────────────────

function buildWarnings(packet: WorkoutDataPacket): string[] | undefined {
  const w: string[] = [];

  for (const item of packet.missingCriticalData) {
    w.push(
      `${item.label} missing — ` +
      (item.recommendation ?? "complete your training profile to improve workout accuracy") + "."
    );
  }

  if (!packet.profileSnapshot.injuries) {
    w.push(
      "Injury history not recorded — exercise substitutions for movement restrictions cannot be applied. " +
      "Add injury details to your profile if you have active restrictions."
    );
  }

  return w.length > 0 ? w : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiered recommendations — specificity scales with confidence
// ─────────────────────────────────────────────────────────────────────────────

function buildRecommendations(
  packet:    WorkoutDataPacket,
  plan:      WorkoutPlan,
  readinessTier: ReadinessTier,
  confidence: ConfidenceLevel,
  canRun:    boolean,
): string[] {
  const { decisions } = packet;

  if (!canRun) {
    const recs: string[] = [
      "Complete the training section of your profile to unlock a personalised workout programme.",
    ];
    for (const item of packet.missingCriticalData) {
      recs.push(item.recommendation ?? `Add your ${item.label} to enable targeted workout programming.`);
    }
    return recs;
  }

  const split = plan.split.replace(/_/g, " ");

  switch (confidence) {
    case "high":
      // Specific, aggressive — full prescription, no hedging
      return [
        `Execute your ${split} session at ${plan.intensityLevel} intensity — ` +
        `all recovery signals support full effort today (readiness: ${readinessTier}).`,
        decisions.intensity === "low" || readinessTier === "Recover"
          ? "Intensity is intentionally reduced — honour the lower load; adaptation happens during recovery."
          : `Push to your working sets with intent. Track loads for next session's progressive overload.`,
        plan.exercises.length > 0
          ? `${plan.exercises.length} exercises programmed — complete them in listed order for optimal stimulus.`
          : "Follow the prescribed session structure without skipping compound movements.",
      ];

    case "medium":
      // Semi-personalised — some caveats, encourage completion
      return [
        `Complete your ${split} session at ${plan.intensityLevel} effort. ` +
        "Some profile parameters are estimated — auto-regulate and back off if recovery feels lower than expected.",
        "Adding the missing training data to your profile will sharpen volume and intensity prescriptions significantly.",
      ];

    case "low":
    default:
      // Generic, explicit uncertainty — direct user to missing data
      return [
        `This ${split} session is based on limited profile data. ` +
        "Treat intensity and volume as conservative upper bounds — reduce load if anything feels excessive.",
        "Your training plan will improve substantially once your profile is complete. " +
        "The current output uses safe defaults across all parameters.",
      ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// User-facing formatter — presentation layer only; no logic changes
// ─────────────────────────────────────────────────────────────────────────────

function mapConfidenceLabel(confidence: ConfidenceLevel): string {
  if (confidence === "high")   return "High confidence";
  if (confidence === "medium") return "Moderate confidence";
  return "Low confidence";
}

function formatWorkoutOutput(
  packet:        WorkoutDataPacket,
  plan:          WorkoutPlan,
  readinessTier: ReadinessTier,
  status:        EngineOutputStatus,
  confidence:    ConfidenceLevel,
  warnings:      string[] | undefined,
): EngineFormattedOutput {
  const split = plan.split.replace(/_/g, " ");

  let summary: string;
  let planSteps: string[];
  let reasoning: string[];

  if (status === "fallback") {
    summary = "Your workout plan is limited today — some key training information is missing. A light movement session is recommended.";
    planSteps = [
      "Complete 20 minutes of light movement.",
      "Finish setting up your training profile to unlock a personalised workout.",
    ];
    reasoning = [
      "Key training details are missing from your profile.",
      "A safe, generic session has been prescribed until your profile is complete.",
    ];
  } else if (status === "adjusted") {
    summary = `You have a ${split} session today. Some details are estimated — auto-regulate based on how you feel.`;
    planSteps = [
      `Complete your ${split} session (${plan.durationMins} min).`,
      `Train at ${plan.intensityLevel} intensity — back off if recovery feels lower than expected.`,
      plan.exercises.length > 0
        ? `${plan.exercises.length} exercises programmed — follow the listed order.`
        : "Follow the prescribed session structure.",
    ];
    reasoning = [
      `Your readiness is ${readinessTier} — moderate effort is appropriate.`,
      "Some training parameters are estimated from partial profile data.",
    ];
  } else {
    // optimal
    const tierLine =
      readinessTier === "Push"
        ? "Your recovery is strong — you're ready to train hard today."
        : readinessTier === "Maintain"
        ? "Your recovery is moderate — a standard training session is appropriate."
        : "Your body needs recovery — intensity is reduced today.";
    summary = `${tierLine} ${split} session prescribed (${plan.durationMins} min).`;
    planSteps = [
      `Complete your ${split} session at ${plan.intensityLevel} intensity (${plan.durationMins} min).`,
      plan.exercises.length > 0
        ? `${plan.exercises.length} exercises — complete them in listed order for best results.`
        : "Follow the prescribed session structure without skipping compound movements.",
      readinessTier === "Recover"
        ? "Honour the reduced load — recovery is today's priority."
        : "Track your weights so you can push progressive overload next session.",
    ];
    reasoning = [
      `Readiness: ${readinessTier} — based on your sleep, stress, and energy signals.`,
      `Session: ${split} | ${plan.durationMins} min | ${plan.exercises.length} exercises.`,
    ];
  }

  const shortWarnings = warnings?.map((w) => {
    // Trim to first sentence for UI display
    const firstSentence = w.split(" — ")[0];
    return firstSentence.length < w.length ? `${firstSentence}.` : w;
  });

  return {
    summary,
    plan:       planSteps,
    reasoning,
    warnings:   shortWarnings,
    confidence: mapConfidenceLabel(confidence),
    status,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback builder — canRun === false
// ─────────────────────────────────────────────────────────────────────────────

function buildFallbackOutput(
  packet:          WorkoutDataPacket,
  normalizedInput: NormalizedIntelligenceInput,
  confidence:      ConfidenceLevel,
  notes:           string[],
): WorkoutEngineOutput {
  const { profile, decisions } = normalizedInput;

  // Call generator to satisfy the plan: WorkoutPlan field in the output contract.
  // It uses safe defaults when profile fields are absent.
  const generatorReasoning: string[] = [];
  const plan = generateWorkout(profile, decisions, generatorReasoning);
  notes.push(...generatorReasoning);

  notes.push(
    `[workout] status: fallback | confidenceScore: ${packet.confidenceScore} | ` +
    `missing: ${packet.missingCriticalData.map((f) => f.field).join(", ") || "none listed"}.`
  );

  const fallbackTask: IntelligenceTask = {
    id:               buildTaskId("workout", TaskKind.Mobility, 0),
    title:            "Light movement — 20 min",
    description:
      "Your workout profile is incomplete. A gentle movement session keeps you active " +
      "and ready to train once your profile is updated.",
    category:         "workout",
    kind:             TaskKind.Mobility,
    priority:         "medium",
    estimatedMinutes: 20,
    sourceEngine:     "workout",
    isRequired:       false,
    completionType:   "check",
    metadata: {
      tags:              ["light", "mobility", "fallback"],
      fallback:          true,
      confidenceScore:   packet.confidenceScore,
      completenessScore: packet.completenessScore,
    },
  };

  const status: EngineOutputStatus = "fallback";
  const warnings = buildWarnings(packet);

  return {
    engine:          "workout",
    readinessTier:   packet.signals.readinessTier,
    split:           plan.split,
    durationMins:    20,
    intensityLevel:  "low",
    confidence,
    status,
    reasoning:       buildReasoning(packet, plan, packet.signals.readinessTier, status),
    recommendations: buildRecommendations(packet, plan, packet.signals.readinessTier, confidence, false),
    warnings,
    engineVersion:   ENGINE_PHASE_VERSION,
    tasks:           [fallbackTask],
    plan,
    notes,
    formatted:       formatWorkoutOutput(packet, plan, packet.signals.readinessTier, status, confidence, warnings),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main engine function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the Workout Engine.
 *
 * Primary input: WorkoutDataPacket (Phase 3).
 * Secondary input: NormalizedIntelligenceInput (backward-compat adapter for generateWorkout()).
 *
 * Deterministic. Never throws. Never mutates inputs. Never sets scheduledTime.
 */
export function runWorkoutEngine(
  packet:           WorkoutDataPacket,
  normalizedInput:  NormalizedIntelligenceInput,
  adaptationEffect: AdaptationEffect = {},
): WorkoutEngineOutput {
  const { canRun, confidenceScore, signals, decisions: packetDecisions, profileSnapshot } = packet;
  const { profile, decisions } = normalizedInput;
  const notes: string[] = [];

  const status     = deriveStatus(canRun, confidenceScore);
  const confidence = mapConfidence(confidenceScore);

  // ── canRun gate ────────────────────────────────────────────────────────────
  if (!canRun) {
    return buildFallbackOutput(packet, normalizedInput, confidence, notes);
  }

  // ── Delegate to generator (Phase 3 backward-compat adapter) ───────────────
  // generateWorkout() requires full AiraUserProfile + PlanDecisions from normalizedInput.
  // Phase 4 will replace this with native logic consuming packet.profileSnapshot + packet.decisions.
  const generatorReasoning: string[] = [];
  const plan = generateWorkout(profile, decisions, generatorReasoning);
  notes.push(...generatorReasoning);

  // ── Readiness tier — from packet signals (pre-computed, no re-derivation) ──
  const readinessTier = signals.readinessTier;

  // ── Task — one workout session ─────────────────────────────────────────────
  const task: IntelligenceTask = {
    id:               buildTaskId("workout", TaskKind.Workout, 0),
    title:            `${plan.split.replace(/_/g, " ")} — ${plan.durationMins} min`,
    description:      plan.focus,
    category:         "workout",
    kind:             TaskKind.Workout,
    priority:         packetDecisions.intensity === "low" ? "medium" : "high",
    estimatedMinutes: plan.durationMins,
    sourceEngine:     "workout",
    isRequired:       true,
    completionType:   "check",
    metadata: {
      tags:              [plan.split, plan.intensityLevel, `${plan.exercises.length} exercises`],
      split:             plan.split,
      intensityLevel:    plan.intensityLevel,
      exerciseCount:     plan.exercises.length,
      warmupMins:        plan.warmupMins,
      cooldownMins:      plan.cooldownMins,
      readinessTier,
      status,
      confidenceScore,
      completenessScore: packet.completenessScore,
    },
  };

  const reasoning       = buildReasoning(packet, plan, readinessTier, status);
  const recommendations = buildRecommendations(packet, plan, readinessTier, confidence, true);
  const warnings        = buildWarnings(packet);

  // ── Phase 5: adaptation-driven structural changes ─────────────────────────
  // Volume and intensity reductions are applied HERE (engine level).
  // Cross-domain priority changes (e.g. capPriority) are handled by the
  // Planner's applyAdaptationToTasks and are additive on top of these.
  let adaptedPlan = plan;
  let adaptedTask = task;

  if (adaptationEffect.workout?.reduceVolume) {
    const originalCount = plan.exercises.length;
    const reducedCount  = Math.max(1, Math.floor(originalCount * 0.67));
    if (reducedCount < originalCount) {
      adaptedPlan = { ...plan, exercises: plan.exercises.slice(0, reducedCount) };
      adaptedTask = {
        ...adaptedTask,
        title:    `${plan.split.replace(/_/g, " ")} — ${plan.durationMins} min (reduced volume)`,
        metadata: {
          ...adaptedTask.metadata,
          exerciseCount:  reducedCount,
          adaptationNote: `Volume reduced: ${originalCount} → ${reducedCount} exercises (recovery signal active).`,
        },
      };
      reasoning.push(
        `Volume reduced to ${reducedCount} exercises (from ${originalCount}) — ` +
        "recent feedback indicates recovery pressure. Honour the lighter load today."
      );
      notes.push(`[workout-adaptation] Exercise count: ${originalCount} → ${reducedCount}.`);
    }
  }

  if (adaptationEffect.workout?.reduceIntensity) {
    const originalPriority = adaptedTask.priority as IntelligencePriority;
    if (originalPriority !== "critical" && originalPriority === "high") {
      adaptedTask = {
        ...adaptedTask,
        priority: "medium" as IntelligencePriority,
        status:   "adjusted" as IntelligenceTaskStatus,
        metadata: {
          ...adaptedTask.metadata,
          enginePriority: (adaptedTask.metadata?.enginePriority as IntelligencePriority | undefined) ?? originalPriority,
          adaptationNote: "Intensity reduced — task priority capped at medium (adaptation signal).",
        },
      };
      adaptedPlan = { ...adaptedPlan, intensityLevel: "moderate" };
      reasoning.push(
        "Intensity cap applied — workout priority reduced to medium. " +
        "Auto-regulate effort today; recovery signals indicate a lower load is appropriate."
      );
      notes.push(`[workout-adaptation] Intensity capped; task priority: ${originalPriority} → medium.`);
    }
  }

  if (adaptationEffect.workout?.capPriority) {
    // Planner will enforce the cap cross-domain; log it here for traceability.
    notes.push(
      `[workout-adaptation] Priority cap "${adaptationEffect.workout.capPriority}" will additionally be enforced by the planner.`
    );
  }

  notes.push(
    `[workout] status: ${status} | split: ${adaptedPlan.split} | intensity: ${adaptedPlan.intensityLevel} | ` +
    `duration: ${adaptedPlan.durationMins} min | exercises: ${adaptedPlan.exercises.length} | ` +
    `readiness: ${readinessTier} | confidenceScore: ${confidenceScore}.`
  );

  return {
    engine:          "workout",
    readinessTier,
    split:           adaptedPlan.split,
    durationMins:    adaptedPlan.durationMins,
    intensityLevel:  adaptedPlan.intensityLevel,
    confidence,
    status,
    reasoning,
    recommendations,
    warnings,
    engineVersion:   ENGINE_PHASE_VERSION,
    tasks:           [adaptedTask],
    plan:            adaptedPlan,
    notes,
    formatted:       formatWorkoutOutput(packet, adaptedPlan, readinessTier, status, confidence, warnings),
  };
}
