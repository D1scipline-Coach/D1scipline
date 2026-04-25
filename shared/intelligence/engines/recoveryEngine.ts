/**
 * shared/intelligence/engines/recoveryEngine.ts
 *
 * Recovery Engine — Phase 3 (hardened)
 *
 * Intelligence model:
 *   3-tier output (optimal / adjusted / fallback) driven by RecoveryDataPacket.
 *   Tier determines protocol specificity, urgency framing, and HRV/injury awareness depth.
 *
 *   optimal  — canRun + confidenceScore ≥ 76: fully personalised protocols,
 *              precise readiness tier, injury and HRV context applied
 *   adjusted — canRun + confidenceScore < 76: conservative protocols,
 *              readiness estimated, reduced specificity
 *   fallback — !canRun: basic sleep/rest/hydration recommendations only,
 *              no over-specific prescriptions
 *
 * ─── Packet consumption ────────────────────────────────────────────────────────
 *   packet.canRun              → gates normal vs fallback path
 *   packet.confidenceScore     → tier selection + mapped to ConfidenceLevel
 *   packet.signals             → sleepQuality, stressLevel, energyBaseline,
 *                                readinessTier (pre-computed), stressFlag
 *   packet.decisions           → recoveryPriority, intensity (training context)
 *   packet.profileSnapshot     → injuries, hasWearableHrv, hrv
 *   packet.missingCriticalData → surfaced in warnings[] and fallback recommendations[]
 *
 * ─── normalizedInput role (backward compat) ───────────────────────────────────
 *   generateRecovery() requires full AiraUserProfile + PlanDecisions.
 *   Phase 4: replace with native logic consuming packet fields directly.
 *
 * PLANNER OWNERSHIP RULE:
 *   Never sets scheduledTime. Planner Engine resolves all task times.
 */

import type {
  NormalizedIntelligenceInput,
  RecoveryEngineOutput,
  RecoveryDataPacket,
  EngineOutputStatus,
  EngineFormattedOutput,
  IntelligenceTask,
  IntelligencePriority,
  IntelligenceTaskStatus,
  AdaptationEffect,
} from "../types";
import { buildTaskId, ENGINE_PHASE_VERSION } from "../constants";
import { generateRecovery } from "../../planner/generateDailyPlan";
import type { ConfidenceLevel, RecoveryPlan, ReadinessTier } from "../../planner/generateDailyPlan";
import { TaskKind } from "../../planner/types";

// ─────────────────────────────────────────────────────────────────────────────
// Priority rank table — used for adaptation priority comparisons
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<IntelligencePriority, number> = {
  critical: 3,
  high:     2,
  medium:   1,
  low:      0,
};

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
// Reasoning — explains WHY these protocols were prescribed
// ─────────────────────────────────────────────────────────────────────────────

function buildReasoning(
  packet:        RecoveryDataPacket,
  plan:          RecoveryPlan,
  readinessTier: ReadinessTier,
  status:        EngineOutputStatus,
): string[] {
  const { signals, decisions, profileSnapshot, confidenceScore } = packet;

  if (status === "fallback") {
    const blockers = packet.missingCriticalData.map((f) => f.label).join(", ");
    return [
      `Fallback mode active — critical recovery data absent: ${blockers || "unspecified fields"}.`,
      "Basic rest and sleep guidance provided — specific protocol prescriptions require complete recovery data.",
      "Update your recovery profile to unlock personalised protocol selection.",
    ];
  }

  const r: string[] = [];

  // ── Readiness tier ───────────────────────────────────────────────────────
  const tierDesc =
    readinessTier === "Push"
      ? "Push — all recovery signals are strong; full training intensity supported"
      : readinessTier === "Maintain"
      ? "Maintain — moderate recovery; standard protocols appropriate"
      : "Recover — recovery is compromised; training load must be reduced and protocols are prioritised";
  r.push(
    `Readiness tier: ${readinessTier} — ${tierDesc}. ` +
    `(sleep: ${signals.sleepQuality}, stress: ${signals.stressLevel}, energy: ${signals.energyBaseline})`
  );

  // ── Stress context ───────────────────────────────────────────────────────
  if (signals.stressFlag) {
    r.push(
      "Stress flag active — cortisol management protocols elevated to high priority. " +
      "Breathing work and early wind-down take precedence over training volume."
    );
  }

  // ── Recovery priority from decisions ─────────────────────────────────────
  r.push(
    `Recovery priority: ${decisions.recoveryPriority} — ` +
    `training intensity context is ${decisions.intensity}; ` +
    `${decisions.recoveryPriority === "high"
      ? "recovery protocols override any additional training today"
      : "standard protocols prescribed alongside training"}.`
  );

  // ── Protocol structure ───────────────────────────────────────────────────
  r.push(
    `Protocols: ${plan.morningProtocols.length} morning + ${plan.eveningProtocols.length} evening. ` +
    `Intensity budget: ${plan.intensityBudget}.`
  );

  // ── HRV context ──────────────────────────────────────────────────────────
  if (profileSnapshot.hasWearableHrv && profileSnapshot.hrv != null) {
    r.push(
      `HRV: ${profileSnapshot.hrv} — wearable data present; readiness assessment is objective.`
    );
  } else if (profileSnapshot.hasWearableHrv) {
    r.push("Wearable HRV sensor detected — data will improve readiness precision when available.");
  } else {
    r.push("Readiness is based on subjective recovery signals (no HRV data). Connect a wearable for objective assessment.");
  }

  if (status === "adjusted") {
    r.push(
      `Output is conservative (confidenceScore: ${confidenceScore}) — ` +
      "some recovery parameters are estimated from partial profile data."
    );
  }

  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Warnings — data quality alerts
// ─────────────────────────────────────────────────────────────────────────────

function buildWarnings(packet: RecoveryDataPacket): string[] | undefined {
  const { profileSnapshot, missingCriticalData } = packet;
  const w: string[] = [];

  for (const item of missingCriticalData) {
    w.push(
      `${item.label} missing — ` +
      (item.recommendation ?? "complete your recovery profile to improve protocol accuracy") + "."
    );
  }

  if (!profileSnapshot.injuries) {
    w.push(
      "Injury history not recorded — mobility protocol modifications for active restrictions cannot be applied. " +
      "Add injury details to your profile if you have movement limitations."
    );
  }

  if (!profileSnapshot.hasWearableHrv) {
    w.push(
      "HRV data unavailable — readiness tier derived from subjective recovery signals only. " +
      "Wearable integration will provide objective daily readiness scoring."
    );
  }

  return w.length > 0 ? w : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiered recommendations
// ─────────────────────────────────────────────────────────────────────────────

function buildRecommendations(
  packet:        RecoveryDataPacket,
  plan:          RecoveryPlan,
  readinessTier: ReadinessTier,
  confidence:    ConfidenceLevel,
  canRun:        boolean,
): string[] {
  if (!canRun) {
    const recs: string[] = [
      "Complete the recovery section of your profile to unlock personalised protocol prescriptions.",
    ];
    for (const item of packet.missingCriticalData) {
      recs.push(item.recommendation ?? `Add your ${item.label} to enable targeted recovery protocols.`);
    }
    return recs;
  }

  const { signals } = packet;

  switch (confidence) {
    case "high":
      // Specific, decisive — readiness tier and protocols are fully trusted
      return [
        readinessTier === "Recover"
          ? "Readiness is low — skip additional training today. Every recovery protocol is mandatory, not optional."
          : readinessTier === "Maintain"
          ? "Standard recovery day — complete all morning and evening protocols in full."
          : "Readiness is optimal — recovery protocols today are maintenance-level; keep them brief and consistent.",
        signals.stressFlag
          ? "Cortisol is elevated — breathwork and early wind-down are non-negotiable. Start your evening protocol on time."
          : "Stress is within range — maintain your wind-down routine to protect tomorrow's readiness.",
        plan.morningProtocols.length > 0
          ? `Complete ${plan.morningProtocols.length} morning protocol${plan.morningProtocols.length > 1 ? "s" : ""} before training.`
          : "No morning protocols required — proceed directly to training.",
      ];

    case "medium":
      // Semi-personalised with some hedging
      return [
        `Your readiness tier is ${readinessTier} — ${
          readinessTier === "Recover"
            ? "recovery needs are elevated. Reduce training intensity and prioritise protocols."
            : "complete your recovery protocols and monitor how you feel before training."
        }`,
        signals.stressFlag
          ? "Stress markers are elevated — evening breathing protocols are especially important tonight."
          : "Complete morning and evening protocols as prescribed.",
        "Adding more recovery data (HRV, injury history) will sharpen protocol selection.",
      ];

    case "low":
    default:
      return [
        "Recovery protocols are based on limited data — treat them as general guidance rather than personalised prescriptions.",
        "Prioritise sleep and hydration above all other recovery protocols until your profile is complete.",
        "Complete your recovery profile to access readiness-tier-specific protocol programming.",
      ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task builder
// ─────────────────────────────────────────────────────────────────────────────

function buildRecoveryTasks(
  packet:       RecoveryDataPacket,
  plan:         RecoveryPlan,
  status:       EngineOutputStatus,
  confidenceScore: number,
): IntelligenceTask[] {
  const tasks: IntelligenceTask[] = [];

  plan.morningProtocols.forEach((protocol, i) => {
    tasks.push({
      id:               buildTaskId("recovery", TaskKind.Mobility, i),
      title:            protocol.name,
      description:      protocol.description,
      category:         "recovery",
      kind:             TaskKind.Mobility,
      priority:         plan.readinessTier === "Recover" ? "high" : "medium",
      estimatedMinutes: protocol.durationMins > 0 ? protocol.durationMins : undefined,
      sourceEngine:     "recovery",
      isRequired:       true,
      completionType:   "timer",
      metadata: {
        tags:              ["morning", "recovery", plan.readinessTier.toLowerCase()],
        timeBucket:        "morning",
        readinessTier:     plan.readinessTier,
        status,
        confidenceScore,
        completenessScore: packet.completenessScore,
      },
    });
  });

  plan.eveningProtocols.forEach((protocol, i) => {
    const isRule = protocol.durationMins === 0;
    tasks.push({
      id:               buildTaskId("recovery", isRule ? TaskKind.Habit : TaskKind.Recovery, plan.morningProtocols.length + i),
      title:            protocol.name,
      description:      protocol.description,
      category:         "recovery",
      kind:             isRule ? TaskKind.Habit : TaskKind.Recovery,
      priority:         plan.stressFlag ? "high" : "medium",
      estimatedMinutes: !isRule && protocol.durationMins > 0 ? protocol.durationMins : undefined,
      sourceEngine:     "recovery",
      isRequired:       !isRule,
      completionType:   isRule ? "check" : "timer",
      metadata: {
        tags:              ["evening", "recovery", ...(isRule ? ["rule"] : [])],
        timeBucket:        "evening",
        stressFlag:        plan.stressFlag,
        status,
        confidenceScore,
        completenessScore: packet.completenessScore,
      },
    });
  });

  return tasks;
}

// ─────────────────────────────────────────────────────────────────────────────
// User-facing formatter — presentation layer only; no logic changes
// ─────────────────────────────────────────────────────────────────────────────

function mapConfidenceLabel(confidence: ConfidenceLevel): string {
  if (confidence === "high")   return "High confidence";
  if (confidence === "medium") return "Moderate confidence";
  return "Low confidence";
}

function formatRecoveryOutput(
  packet:        RecoveryDataPacket,
  plan:          RecoveryPlan,
  readinessTier: ReadinessTier,
  status:        EngineOutputStatus,
  confidence:    ConfidenceLevel,
  warnings:      string[] | undefined,
): EngineFormattedOutput {
  const { signals } = packet;

  let summary: string;
  let planSteps: string[];
  let reasoning: string[];

  if (status === "fallback") {
    summary = "Your recovery plan is limited today — some key information is missing. Focus on sleep and rest.";
    planSteps = [
      "Prioritise sleep — aim for 8 hours.",
      "Stay hydrated throughout the day.",
      "Complete your recovery profile to unlock personalised protocols.",
    ];
    reasoning = [
      "Key recovery details are missing from your profile.",
      "Basic rest and hydration guidance provided until your profile is complete.",
    ];
  } else if (status === "adjusted") {
    const tierLine =
      readinessTier === "Recover"
        ? "Your recovery needs attention — reduce training load and complete all protocols."
        : readinessTier === "Maintain"
        ? "Your recovery is moderate — complete your protocols as prescribed."
        : "Your recovery is good — maintenance protocols apply.";
    summary = `${tierLine} ${plan.morningProtocols.length + plan.eveningProtocols.length} protocols prescribed.`;
    planSteps = [
      plan.morningProtocols.length > 0
        ? `Complete ${plan.morningProtocols.length} morning protocol${plan.morningProtocols.length > 1 ? "s" : ""} before training.`
        : "No morning protocols required today.",
      plan.eveningProtocols.length > 0
        ? `Complete ${plan.eveningProtocols.length} evening protocol${plan.eveningProtocols.length > 1 ? "s" : ""} before bed.`
        : "No evening protocols required today.",
      "Adding more recovery data will sharpen protocol selection.",
    ];
    reasoning = [
      `Readiness: ${readinessTier} — based on your sleep, stress, and energy signals.`,
      "Some recovery parameters are estimated from partial profile data.",
    ];
  } else {
    // optimal
    const tierLine =
      readinessTier === "Recover"
        ? "Your body needs recovery today — every protocol is mandatory, not optional."
        : readinessTier === "Maintain"
        ? "Standard recovery day — complete all protocols in full."
        : "Your recovery is optimal — today's protocols are maintenance-level.";
    summary = `${tierLine} (${plan.morningProtocols.length} morning, ${plan.eveningProtocols.length} evening)`;
    planSteps = [
      plan.morningProtocols.length > 0
        ? `Complete ${plan.morningProtocols.length} morning protocol${plan.morningProtocols.length > 1 ? "s" : ""} before training.`
        : "No morning protocols today — proceed to training.",
      plan.eveningProtocols.length > 0
        ? `Complete ${plan.eveningProtocols.length} evening protocol${plan.eveningProtocols.length > 1 ? "s" : ""} before bed.`
        : "No evening protocols required tonight.",
      signals.stressFlag
        ? "Stress is elevated — breathwork and early wind-down are non-negotiable."
        : "Stress is within range — maintain your routine to protect tomorrow's readiness.",
    ];
    reasoning = [
      `Readiness: ${readinessTier} — based on your sleep, stress, and energy signals.`,
      signals.stressFlag ? "Stress flag active — cortisol management protocols prioritised." : "No stress flag — standard protocols prescribed.",
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
// Main engine function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the Recovery Engine.
 *
 * Primary input: RecoveryDataPacket (Phase 3).
 * Secondary input: NormalizedIntelligenceInput (backward-compat adapter for generateRecovery()).
 *
 * Deterministic. Never throws. Never mutates inputs. Never sets scheduledTime.
 */
export function runRecoveryEngine(
  packet:           RecoveryDataPacket,
  normalizedInput:  NormalizedIntelligenceInput,
  adaptationEffect: AdaptationEffect = {},
): RecoveryEngineOutput {
  const { canRun, confidenceScore, signals } = packet;
  const { profile, decisions } = normalizedInput;
  const notes: string[] = [];

  const status     = deriveStatus(canRun, confidenceScore);
  const confidence = mapConfidence(confidenceScore);

  // ── Delegate to generator (Phase 3 backward-compat adapter) ───────────────
  const engineReasoning: string[] = [];
  const plan = generateRecovery(profile, decisions, engineReasoning);
  notes.push(...engineReasoning);

  // Read stressFlag and readinessTier from the generator's output — these match
  // packet.signals.stressFlag and packet.signals.readinessTier since both derive
  // from the same pre-computed inputs. Using plan.* here keeps the engine
  // consistent with the generator's final value while packet.signals is the
  // authoritative pre-computed source for reasoning.
  const readinessTier = plan.readinessTier;

  let tasks             = buildRecoveryTasks(packet, plan, status, confidenceScore);
  const reasoning       = buildReasoning(packet, plan, readinessTier, status);
  const recommendations = buildRecommendations(packet, plan, readinessTier, confidence, canRun);
  const warnings        = buildWarnings(packet);

  // ── Phase 5: adaptation-driven structural changes ──────────────────────────
  if (adaptationEffect.recovery) {
    const re = adaptationEffect.recovery;

    if (re.increasePriority) {
      // Elevate recovery task priorities to at least "high"
      tasks = tasks.map((t): IntelligenceTask => {
        if (PRIORITY_RANK[t.priority] < PRIORITY_RANK["high"]) {
          return {
            ...t,
            priority: "high" as IntelligencePriority,
            status:   "adjusted" as IntelligenceTaskStatus,
            metadata: {
              ...t.metadata,
              enginePriority:  (t.metadata?.enginePriority as IntelligencePriority | undefined) ?? t.priority,
              adaptationNote:  "Priority elevated — recent soreness/stress patterns indicate recovery is today's priority.",
            },
          };
        }
        return t;
      });
      reasoning.push(
        "Recovery priority elevated due to recent soreness or stress signals — " +
        "readiness signals support reducing training load and increasing protocol adherence."
      );
      recommendations.push(
        "Treat every recovery protocol as non-negotiable today — recent patterns indicate the body needs restoration before training intensity resumes."
      );
      notes.push("[recovery-adaptation] Task priorities elevated to high.");
    }

    if (re.addProtocol) {
      // Add an extra recovery task for additional protocol reinforcement
      const extraTask: IntelligenceTask = {
        id:               buildTaskId("recovery", TaskKind.Recovery, tasks.length),
        title:            "Adaptation recovery — 15 min",
        description:
          "Additional recovery session based on recent feedback patterns. " +
          "Light mobility or breathing work to reinforce recovery momentum.",
        category:         "recovery",
        kind:             TaskKind.Recovery,
        priority:         "medium",
        estimatedMinutes: 15,
        sourceEngine:     "recovery",
        isRequired:       false,
        completionType:   "timer",
        metadata: {
          tags:              ["recovery", "adaptation", "protocol"],
          timeBucket:        "evening",
          adaptationNote:    "Extra protocol added — recent feedback signals indicate recovery needs reinforcement.",
          confidenceScore,
          completenessScore: packet.completenessScore,
        },
      };
      tasks = [...tasks, extraTask];
      recommendations.push(
        "Extra recovery session added (15 min) — short mobility or breathing work " +
        "to reinforce recovery momentum based on your recent feedback patterns."
      );
      notes.push("[recovery-adaptation] Extra recovery task added to task list.");
    }
  }

  notes.push(
    `[recovery] status: ${status} | readiness: ${readinessTier} | ` +
    `intensityBudget: ${plan.intensityBudget} | stressFlag: ${signals.stressFlag} | ` +
    `morning: ${plan.morningProtocols.length} | evening: ${plan.eveningProtocols.length} | ` +
    `confidenceScore: ${confidenceScore}.`
  );

  return {
    engine:          "recovery",
    readinessTier,
    stressFlag:      plan.stressFlag,
    confidence,
    status,
    reasoning,
    recommendations,
    warnings,
    engineVersion:   ENGINE_PHASE_VERSION,
    tasks,
    plan,
    notes,
    formatted:       formatRecoveryOutput(packet, plan, readinessTier, status, confidence, warnings),
  };
}
