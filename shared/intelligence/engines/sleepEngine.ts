/**
 * shared/intelligence/engines/sleepEngine.ts
 *
 * Sleep Engine — Phase 3 (hardened)
 *
 * Intelligence model:
 *   3-tier output (optimal / adjusted / fallback) driven by SleepDataPacket.
 *   Tier determines scheduling precision, sleep target specificity, and wearable context depth.
 *
 *   optimal  — canRun + confidenceScore ≥ 76: precise bedtime/wind-down schedule,
 *              recovery-tier calibrated sleep target, wearable flag surfaced
 *   adjusted — canRun + confidenceScore < 76: timing present but some context missing,
 *              conservative target, caveats where data is partial
 *   fallback — !canRun: generic 8h / 30 min wind-down hygiene guidance only;
 *              avoids pretending precise timing data is known
 *
 * ─── Packet consumption ────────────────────────────────────────────────────────
 *   packet.canRun              → gates normal vs fallback path
 *   packet.confidenceScore     → tier selection + mapped to ConfidenceLevel
 *   packet.signals             → wakeTime, sleepTime (replaces profile.sleep.* access),
 *                                sleepQuality, stressLevel
 *   packet.decisions           → recoveryPriority drives sleep target framing
 *   packet.profileSnapshot     → hasWearableData flag for observability note
 *   packet.missingCriticalData → surfaced in warnings[] and fallback recommendations[]
 *
 * ─── normalizedInput role (backward compat) ───────────────────────────────────
 *   Not used in Phase 3 computation — retained for API consistency with other engines.
 *   Can be removed in Phase 4 cleanup.
 *
 * ─── Recovery output dependency ──────────────────────────────────────────────
 *   Reads recoveryOutput.plan.windDownMins and sleepTargetHrs — the only permitted
 *   inter-engine dependency. Sleep → Recovery direction only (never reversed).
 *
 * PLANNER OWNERSHIP RULE:
 *   Never sets scheduledTime. Planner Engine resolves all task times.
 */

import type {
  NormalizedIntelligenceInput,
  SleepEngineOutput,
  SleepDataPacket,
  EngineOutputStatus,
  EngineFormattedOutput,
  IntelligenceTask,
  IntelligencePriority,
  IntelligenceTaskStatus,
  AdaptationEffect,
  RecoveryEngineOutput,
} from "../types";
import { buildTaskId, ENGINE_PHASE_VERSION } from "../constants";
import type { ConfidenceLevel } from "../../planner/generateDailyPlan";
import { TaskKind } from "../../planner/types";

// ─────────────────────────────────────────────────────────────────────────────
// Time utilities (self-contained — not exported from generateDailyPlan)
// ─────────────────────────────────────────────────────────────────────────────

function parseTimeMins(input: string): number {
  const raw   = input.trim().toUpperCase();
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

function minsToTimeText(totalMins: number): string {
  const m    = ((totalMins % 1440) + 1440) % 1440;
  const h24  = Math.floor(m / 60);
  const min  = m % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12  = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

// Safe defaults — used in fallback when timing data is absent
const FALLBACK_SLEEP_TARGET_HRS = 8;
const FALLBACK_WIND_DOWN_MINS   = 30;

// ─────────────────────────────────────────────────────────────────────────────
// Status helpers
// ─────────────────────────────────────────────────────────────────────────────

function deriveStatus(canRun: boolean, confidenceScore: number): EngineOutputStatus {
  if (!canRun)               return "fallback";
  if (confidenceScore >= 76) return "optimal";
  return "adjusted";
}

function mapConfidence(confidenceScore: number): ConfidenceLevel {
  if (confidenceScore >= 76) return "high";
  if (confidenceScore >= 51) return "medium";
  return "low";
}

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning — explains WHY this sleep schedule was produced
// ─────────────────────────────────────────────────────────────────────────────

function buildReasoning(
  packet:         SleepDataPacket,
  recoveryOutput: RecoveryEngineOutput,
  sleepTargetHrs: number,
  windDownMins:   number,
  windDownTimeText: string,
  bedtimeText:    string,
  status:         EngineOutputStatus,
): string[] {
  const { signals, decisions, profileSnapshot, confidenceScore } = packet;

  if (status === "fallback") {
    const blockers = packet.missingCriticalData.map((f) => f.label).join(", ");
    return [
      `Fallback mode active — critical sleep data absent: ${blockers || "unspecified fields"}.`,
      `Generic targets used: ${FALLBACK_SLEEP_TARGET_HRS}h sleep / ${FALLBACK_WIND_DOWN_MINS} min wind-down.`,
      "Personalised scheduling unavailable until wake time and sleep time are added to your profile.",
    ];
  }

  const r: string[] = [];

  // ── Sleep target derivation ──────────────────────────────────────────────
  const tierLabel = recoveryOutput.readinessTier;
  const priorityNote =
    decisions.recoveryPriority === "high"
      ? "recovery priority is high — extended sleep target"
      : decisions.recoveryPriority === "low"
      ? "recovery priority is low — standard sleep target"
      : "recovery priority is moderate — standard sleep target";
  r.push(
    `Sleep target: ${sleepTargetHrs}h — derived from readiness tier (${tierLabel}) and ${priorityNote}. ` +
    `Sleep quality: ${signals.sleepQuality}, stress: ${signals.stressLevel}.`
  );

  // ── Wind-down timing ─────────────────────────────────────────────────────
  r.push(
    `Wind-down: ${windDownMins} min — begins at ${windDownTimeText}, before ${bedtimeText} bedtime. ` +
    `${recoveryOutput.stressFlag
      ? "Extended wind-down prescribed due to elevated stress — cortisol management required."
      : "Standard wind-down duration based on stress level."}`
  );

  // ── Schedule ─────────────────────────────────────────────────────────────
  r.push(
    `Schedule: wake ${signals.wakeTime} → bedtime ${bedtimeText} ` +
    `(wind-down from ${windDownTimeText}).`
  );

  // ── Wearable context ─────────────────────────────────────────────────────
  r.push(
    profileSnapshot.hasWearableData
      ? "Wearable device connected — sleep quality data will be available for future readiness calibration."
      : "No wearable connected — sleep duration and quality are self-reported until a device is added."
  );

  if (status === "adjusted") {
    r.push(
      `Output is conservative (confidenceScore: ${confidenceScore}) — ` +
      "some sleep parameters are estimated from partial profile data."
    );
  }

  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Warnings — data quality alerts
// ─────────────────────────────────────────────────────────────────────────────

function buildWarnings(
  packet:         SleepDataPacket,
  recoveryOutput: RecoveryEngineOutput,
): string[] | undefined {
  const { profileSnapshot, missingCriticalData } = packet;
  const w: string[] = [];

  for (const item of missingCriticalData) {
    w.push(
      `${item.label} missing — ` +
      (item.recommendation ?? "complete your sleep profile to enable personalised scheduling") + "."
    );
  }

  if (!profileSnapshot.hasWearableData) {
    w.push(
      "No wearable device detected — sleep quality and duration tracking relies on manual input. " +
      "Adding a wearable will provide objective sleep data for more accurate readiness scoring."
    );
  }

  // Stress-specific warning when not already in recommendations
  if (recoveryOutput.stressFlag) {
    w.push(
      "Stress is elevated — consistent wind-down timing is critical tonight. " +
      "Irregular sleep timing under stress compounds cortisol dysregulation."
    );
  }

  return w.length > 0 ? w : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiered recommendations
// ─────────────────────────────────────────────────────────────────────────────

function buildRecommendations(
  packet:          SleepDataPacket,
  recoveryOutput:  RecoveryEngineOutput,
  sleepTargetHrs:  number,
  windDownMins:    number,
  windDownTimeText: string,
  bedtimeText:     string,
  confidence:      ConfidenceLevel,
  canRun:          boolean,
): string[] {
  if (!canRun) {
    const recs: string[] = [
      "Add your wake time and sleep time to your profile to unlock personalised sleep scheduling.",
    ];
    for (const item of packet.missingCriticalData) {
      recs.push(item.recommendation ?? `Add your ${item.label} to enable personalised sleep scheduling.`);
    }
    return recs;
  }

  switch (confidence) {
    case "high":
      // Precise, specific — exact times, decisive framing
      return [
        `Start wind-down at ${windDownTimeText} — ${windDownMins} min of screens-off, dim lights ` +
        `before ${bedtimeText} bedtime. Melatonin onset requires consistent pre-sleep cues.`,
        `Target ${sleepTargetHrs}h sleep — this is your readiness-tier-calibrated target for tonight ` +
        `(${recoveryOutput.readinessTier}).`,
        recoveryOutput.readinessTier === "Recover"
          ? "Readiness is low — maximising sleep tonight is the single highest-impact recovery action."
          : recoveryOutput.stressFlag
          ? "Stress is elevated — hitting your wind-down start time is as important as hitting bedtime."
          : "Sleep is where training adaptation happens — protect it with the same priority as your workouts.",
      ];

    case "medium":
      // Semi-personalised — some caveats
      return [
        `Aim to begin winding down around ${windDownTimeText} and be in bed by ${bedtimeText}. ` +
        "Some sleep parameters are estimated — track how you feel on wake to calibrate over time.",
        `Target approximately ${sleepTargetHrs}h sleep based on your current recovery signals.`,
        "Adding HRV or wearable data will improve sleep target accuracy and readiness scoring.",
      ];

    case "low":
    default:
      // Generic — explicit uncertainty, direct to missing data
      return [
        `Aim for ${sleepTargetHrs}h sleep and begin a wind-down routine ${windDownMins} min before bed. ` +
        "These are general targets — personalised scheduling requires complete profile data.",
        "Complete your sleep profile (wake time, sleep time) to unlock specific sleep scheduling.",
      ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task builder
// ─────────────────────────────────────────────────────────────────────────────

function buildSleepTasks(
  packet:           SleepDataPacket,
  recoveryOutput:   RecoveryEngineOutput,
  sleepTargetHrs:   number,
  windDownMins:     number,
  windDownTimeText: string,
  bedtimeText:      string,
  status:           EngineOutputStatus,
  confidenceScore:  number,
): IntelligenceTask[] {
  return [
    {
      id:               buildTaskId("sleep", TaskKind.Sleep, 0),
      title:            `Wind-down — ${windDownMins} min`,
      description:
        `${windDownMins}-minute wind-down before ${bedtimeText} — screens off, dim lights, ` +
        "low stimulation. Melatonin onset requires consistent pre-sleep cues.",
      category:         "sleep",
      kind:             TaskKind.Habit,
      priority:         recoveryOutput.stressFlag ? "high" : "medium",
      estimatedMinutes: windDownMins,
      sourceEngine:     "sleep",
      isRequired:       true,
      completionType:   "check",
      metadata: {
        tags:              ["sleep", "wind-down", "habit"],
        windDownMins,
        windDownTimeText,
        status,
        confidenceScore,
        completenessScore: packet.completenessScore,
      },
    },
    {
      id:               buildTaskId("sleep", TaskKind.Sleep, 1),
      title:            `Sleep — ${sleepTargetHrs}h target`,
      description:
        `${sleepTargetHrs}h sleep target based on readiness tier (${recoveryOutput.readinessTier}). ` +
        "Sleep is where training adaptation occurs — it is not recovery from work, it is the work.",
      category:         "sleep",
      kind:             TaskKind.Sleep,
      priority:         recoveryOutput.readinessTier === "Recover" ? "critical" : "high",
      estimatedMinutes: sleepTargetHrs * 60,
      sourceEngine:     "sleep",
      isRequired:       true,
      // passive = system-tracked; no user-initiated completion action.
      // Phase 4 wearable integration will supply the objective signal.
      completionType:   "passive",
      metadata: {
        tags:              ["sleep", `${sleepTargetHrs}h`, recoveryOutput.readinessTier.toLowerCase()],
        sleepTargetHrs,
        readinessTier:     recoveryOutput.readinessTier,
        status,
        confidenceScore,
        completenessScore: packet.completenessScore,
      },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// User-facing formatter — presentation layer only; no logic changes
// ─────────────────────────────────────────────────────────────────────────────

function mapConfidenceLabel(confidence: ConfidenceLevel): string {
  if (confidence === "high")   return "High confidence";
  if (confidence === "medium") return "Moderate confidence";
  return "Low confidence";
}

function formatSleepOutput(
  packet:           SleepDataPacket,
  recoveryOutput:   RecoveryEngineOutput,
  sleepTargetHrs:   number,
  windDownMins:     number,
  windDownTimeText: string,
  bedtimeText:      string,
  status:           EngineOutputStatus,
  confidence:       ConfidenceLevel,
  warnings:         string[] | undefined,
): EngineFormattedOutput {
  let summary: string;
  let planSteps: string[];
  let reasoning: string[];

  if (status === "fallback") {
    summary = `Your sleep plan is limited today — some scheduling information is missing. Aim for ${sleepTargetHrs} hours of sleep with a ${windDownMins}-minute wind-down.`;
    planSteps = [
      `Begin a ${windDownMins}-minute wind-down before bed — screens off, dim lights.`,
      `Aim for ${sleepTargetHrs} hours of sleep.`,
      "Add your wake time and sleep time to your profile for a personalised schedule.",
    ];
    reasoning = [
      "Wake time or sleep time is missing from your profile.",
      "Generic sleep targets are in use until your schedule is set.",
    ];
  } else if (status === "adjusted") {
    summary = `Aim to be in bed by approximately ${bedtimeText} with a ${windDownMins}-minute wind-down. Some details are estimated.`;
    planSteps = [
      `Start wind-down around ${windDownTimeText} — screens off, dim lights (${windDownMins} min).`,
      `Target ${sleepTargetHrs} hours of sleep — in bed by ${bedtimeText}.`,
      "Adding more recovery data will sharpen your sleep target.",
    ];
    reasoning = [
      `Sleep target: ${sleepTargetHrs}h — based on your readiness and recovery signals.`,
      "Some sleep parameters are estimated from partial profile data.",
    ];
  } else {
    // optimal
    const urgencyLine =
      recoveryOutput.readinessTier === "Recover"
        ? "Your readiness is low — maximising sleep tonight is your highest-impact recovery action."
        : recoveryOutput.stressFlag
        ? "Stress is elevated — hitting your wind-down start time is as important as bedtime."
        : "Protect your sleep with the same priority as your workouts.";
    summary = `${sleepTargetHrs}h sleep target tonight. Wind-down starts at ${windDownTimeText}, bedtime ${bedtimeText}.`;
    planSteps = [
      `Start wind-down at ${windDownTimeText} — screens off, dim lights, low stimulation (${windDownMins} min).`,
      `Be in bed by ${bedtimeText} — target ${sleepTargetHrs} hours of sleep.`,
      urgencyLine,
    ];
    reasoning = [
      `Sleep target: ${sleepTargetHrs}h — calibrated to readiness tier (${recoveryOutput.readinessTier}).`,
      `Wind-down: ${windDownMins} min before bed — ${recoveryOutput.stressFlag ? "extended due to elevated stress" : "standard duration"}.`,
    ];
  }

  const shortWarnings = warnings?.map((w) => {
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
  packet:         SleepDataPacket,
  recoveryOutput: RecoveryEngineOutput,
  confidence:     ConfidenceLevel,
  notes:          string[],
): SleepEngineOutput {
  const { missingCriticalData } = packet;
  const sleepTargetHrs   = FALLBACK_SLEEP_TARGET_HRS;
  const windDownMins     = FALLBACK_WIND_DOWN_MINS;
  const windDownTimeText = "—";
  const bedtimeText      = "—";
  const status: EngineOutputStatus = "fallback";

  notes.push(
    `[sleep] status: fallback | confidenceScore: ${packet.confidenceScore} | ` +
    `missing: ${missingCriticalData.map((f) => f.field).join(", ") || "none listed"}. ` +
    `Generic defaults: ${sleepTargetHrs}h / ${windDownMins} min.`
  );

  const fallbackTasks: IntelligenceTask[] = [
    {
      id:               buildTaskId("sleep", TaskKind.Habit, 0),
      title:            `Wind-down — ${windDownMins} min`,
      description:
        `Aim for a ${windDownMins}-minute wind-down before bed — screens off, dim lights. ` +
        "Add your sleep schedule to your profile for a personalised time.",
      category:         "sleep",
      kind:             TaskKind.Habit,
      priority:         "medium",
      estimatedMinutes: windDownMins,
      sourceEngine:     "sleep",
      isRequired:       false,
      completionType:   "check",
      metadata: {
        tags:              ["sleep", "wind-down", "fallback"],
        fallback:          true,
        confidenceScore:   packet.confidenceScore,
        completenessScore: packet.completenessScore,
      },
    },
    {
      id:               buildTaskId("sleep", TaskKind.Sleep, 1),
      title:            `Sleep — ${sleepTargetHrs}h target`,
      description:
        `General guidance: aim for ${sleepTargetHrs} hours of sleep. ` +
        "Add your sleep schedule to your profile for a readiness-calibrated target.",
      category:         "sleep",
      kind:             TaskKind.Sleep,
      priority:         "high",
      estimatedMinutes: sleepTargetHrs * 60,
      sourceEngine:     "sleep",
      isRequired:       true,
      completionType:   "passive",
      metadata: {
        tags:              ["sleep", `${sleepTargetHrs}h`, "fallback"],
        fallback:          true,
        sleepTargetHrs,
        confidenceScore:   packet.confidenceScore,
        completenessScore: packet.completenessScore,
      },
    },
  ];

  const warnings = buildWarnings(packet, recoveryOutput);

  return {
    engine:           "sleep",
    sleepTargetHrs,
    windDownMins,
    windDownTimeText,
    bedtimeText,
    confidence,
    status,
    reasoning:        buildReasoning(packet, recoveryOutput, sleepTargetHrs, windDownMins, windDownTimeText, bedtimeText, status),
    recommendations:  buildRecommendations(packet, recoveryOutput, sleepTargetHrs, windDownMins, windDownTimeText, bedtimeText, confidence, false),
    warnings,
    engineVersion:    ENGINE_PHASE_VERSION,
    tasks:            fallbackTasks,
    notes,
    formatted:        formatSleepOutput(packet, recoveryOutput, sleepTargetHrs, windDownMins, windDownTimeText, bedtimeText, status, confidence, warnings),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main engine function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the Sleep Engine.
 *
 * Primary input: SleepDataPacket (Phase 3).
 * Secondary input: NormalizedIntelligenceInput (retained for API consistency; not used in Phase 3 logic).
 * Tertiary input: RecoveryEngineOutput (windDownMins, sleepTargetHrs, stressFlag, readinessTier).
 *
 * Deterministic. Never throws. Never mutates inputs. Never sets scheduledTime.
 */
export function runSleepEngine(
  packet:           SleepDataPacket,
  normalizedInput:  NormalizedIntelligenceInput,
  recoveryOutput:   RecoveryEngineOutput,
  adaptationEffect: AdaptationEffect = {},
): SleepEngineOutput {
  const { canRun, confidenceScore, signals } = packet;

  // normalizedInput is retained for API consistency with other Phase 3 engines.
  // It is not used in Phase 3 sleep logic — all data comes from packet.signals
  // and recoveryOutput. Can be removed in Phase 4 cleanup.
  void normalizedInput;

  const notes: string[] = [];
  const status     = deriveStatus(canRun, confidenceScore);
  const confidence = mapConfidence(confidenceScore);

  // ── canRun gate ────────────────────────────────────────────────────────────
  if (!canRun) {
    return buildFallbackOutput(packet, recoveryOutput, confidence, notes);
  }

  // ── Resolve times from packet signals ─────────────────────────────────────
  // signals.wakeTime / sleepTime replace profile.sleep.* — Phase 3 packet-first.
  // sleepTargetHrs is a `let` so Phase 5 adaptation can increase it before tasks are built.
  let sleepTargetHrs = recoveryOutput.plan.sleepTargetHrs;
  const windDownMins = recoveryOutput.plan.windDownMins;

  // ── Phase 5: Apply sleep target increase BEFORE building tasks ─────────────
  // Incrementing here ensures tasks, reasoning, and formatted output all reflect
  // the higher target. windDownMins and bedtimeText are unaffected (they derive
  // from signals.sleepTime and recoveryOutput.plan.windDownMins, not this value).
  if (adaptationEffect.sleep?.increaseSleepTarget) {
    sleepTargetHrs = parseFloat((sleepTargetHrs + 0.5).toFixed(1));
  }

  const sleepMin         = parseTimeMins(signals.sleepTime);
  const wakeMin          = parseTimeMins(signals.wakeTime);
  const adjustedSleepMin = sleepMin < wakeMin ? sleepMin + 1440 : sleepMin;

  const windDownStart    = adjustedSleepMin - windDownMins;
  const windDownTimeText = minsToTimeText(windDownStart);
  const bedtimeText      = signals.sleepTime;

  let tasks             = buildSleepTasks(packet, recoveryOutput, sleepTargetHrs, windDownMins, windDownTimeText, bedtimeText, status, confidenceScore);
  const reasoning       = buildReasoning(packet, recoveryOutput, sleepTargetHrs, windDownMins, windDownTimeText, bedtimeText, status);
  const recommendations = buildRecommendations(packet, recoveryOutput, sleepTargetHrs, windDownMins, windDownTimeText, bedtimeText, confidence, true);
  const warnings        = buildWarnings(packet, recoveryOutput);

  // ── Phase 5: adaptation-driven structural changes ──────────────────────────
  if (adaptationEffect.sleep) {
    const se = adaptationEffect.sleep;

    if (se.enforceWindDown) {
      // Elevate wind-down task priority to "high" — not just a text note
      tasks = tasks.map((t): IntelligenceTask =>
        t.kind === TaskKind.Habit  // wind-down task
          ? {
              ...t,
              priority: "high" as IntelligencePriority,
              status:   "adjusted" as IntelligenceTaskStatus,
              metadata: {
                ...t.metadata,
                enginePriority: (t.metadata?.enginePriority as IntelligencePriority | undefined) ?? t.priority,
                adaptationNote: "Wind-down prioritized — recent sleep consistency signals active.",
              },
            }
          : t
      );
      reasoning.push(
        "Wind-down compliance enforced — recent sleep quality signals indicate inconsistency. " +
        "Protecting tonight's wind-down is the single highest-leverage sleep action."
      );
      recommendations.push(
        `Start wind-down at ${windDownTimeText} — poor sleep patterns make this non-negotiable tonight.`
      );
      notes.push("[sleep-adaptation] Wind-down task priority elevated to high.");
    }

    if (se.increaseSleepTarget) {
      // sleepTargetHrs was already incremented before buildSleepTasks — tasks reflect the new target.
      // Add reasoning and recommendation to explain the change.
      reasoning.push(
        `Sleep target increased to ${sleepTargetHrs}h — ` +
        "adaptation signals indicate sleep quality needs improvement."
      );
      recommendations.push(
        `Sleep target extended to ${sleepTargetHrs}h tonight (+30 min) — ` +
        "recent patterns suggest more sleep is the highest-leverage recovery action."
      );
      notes.push(`[sleep-adaptation] sleepTargetHrs increased to ${sleepTargetHrs}h.`);
    }
  }

  notes.push(
    `[sleep] status: ${status} | target: ${sleepTargetHrs}h | wind-down: ${windDownMins} min | ` +
    `starts: ${windDownTimeText} | bedtime: ${bedtimeText} | confidenceScore: ${confidenceScore}.`
  );

  return {
    engine:           "sleep",
    sleepTargetHrs,
    windDownMins,
    windDownTimeText,
    bedtimeText,
    confidence,
    status,
    reasoning,
    recommendations,
    warnings,
    engineVersion:    ENGINE_PHASE_VERSION,
    tasks,
    notes,
    formatted:        formatSleepOutput(packet, recoveryOutput, sleepTargetHrs, windDownMins, windDownTimeText, bedtimeText, status, confidence, warnings),
  };
}
