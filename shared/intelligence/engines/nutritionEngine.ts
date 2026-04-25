/**
 * shared/intelligence/engines/nutritionEngine.ts
 *
 * Nutrition Engine — Phase 3 (hardened)
 *
 * Intelligence model:
 *   3-tier output (optimal / adjusted / fallback) driven by NutritionDataPacket.
 *   Tier determines macro specificity, allergy-awareness depth, and meal plan confidence.
 *
 *   optimal  — canRun + confidenceScore ≥ 76: precise macro targets, allergy-aware,
 *              body-weight calibrated where available
 *   adjusted — canRun + confidenceScore < 76: estimated targets, conservative strategy,
 *              explicit caveats for missing body metrics
 *   fallback — !canRun: generic balanced guidance, no unsafe allergy assumptions
 *
 * ─── Packet consumption ────────────────────────────────────────────────────────
 *   packet.canRun              → gates normal vs fallback path
 *   packet.confidenceScore     → tier selection + mapped to ConfidenceLevel
 *   packet.signals             → goal, dietaryStyle, nutritionGoal, allergies, hasBodyWeight, hasAge
 *   packet.decisions           → nutritionStrategy drives meal framing
 *   packet.profileSnapshot     → dietary style, allergies, body metrics for recommendations
 *   packet.missingCriticalData → surfaced in warnings[] and fallback recommendations[]
 *
 * ─── normalizedInput role (backward compat) ───────────────────────────────────
 *   generateNutrition() requires full AiraUserProfile + PlanDecisions.
 *   Phase 4: replace with native logic consuming packet fields directly.
 *
 * PLANNER OWNERSHIP RULE:
 *   Never sets scheduledTime. Planner Engine resolves all task times.
 */

import type {
  NormalizedIntelligenceInput,
  NutritionEngineOutput,
  NutritionDataPacket,
  EngineOutputStatus,
  EngineFormattedOutput,
  IntelligenceTask,
  IntelligencePriority,
  IntelligenceTaskStatus,
  AdaptationEffect,
} from "../types";
import { buildTaskId, ENGINE_PHASE_VERSION } from "../constants";
import { generateNutrition } from "../../planner/generateDailyPlan";
import type { ConfidenceLevel, NutritionPlan } from "../../planner/generateDailyPlan";
import { TaskKind } from "../../planner/types";

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
// Reasoning — explains WHY this nutrition plan was produced
// ─────────────────────────────────────────────────────────────────────────────

function buildReasoning(
  packet: NutritionDataPacket,
  plan:   NutritionPlan,
  status: EngineOutputStatus,
): string[] {
  const { signals, decisions, profileSnapshot, confidenceScore } = packet;

  if (status === "fallback") {
    const blockers = packet.missingCriticalData.map((f) => f.label).join(", ");
    return [
      `Fallback mode active — critical nutrition data absent: ${blockers || "unspecified fields"}.`,
      "Generic balanced nutrition guidance provided — allergy-specific assumptions are intentionally avoided.",
      "Personalised macro targets unavailable until the listed fields are completed.",
    ];
  }

  const r: string[] = [];

  // ── Caloric strategy ─────────────────────────────────────────────────────
  const strategyReason =
    plan.caloricStrategy === "deficit"    ? `caloric deficit required for goal "${signals.goal}"`
    : plan.caloricStrategy === "surplus"  ? `caloric surplus required for goal "${signals.goal}"`
    : `caloric maintenance appropriate for goal "${signals.goal}"`;
  r.push(
    `Strategy: ${plan.caloricStrategy} — ${strategyReason}. ` +
    `Nutrition goal: ${signals.nutritionGoal}.`
  );

  // ── Macro targets ────────────────────────────────────────────────────────
  const { calories, protein, carbs, fats } = plan.dailyTarget;
  const basisNote = signals.hasBodyWeight && signals.hasAge
    ? "body weight + age — BMR-calibrated precision"
    : signals.hasBodyWeight
    ? "body weight — estimated age (add age for BMR precision)"
    : "population averages — add body weight and age for precision";
  r.push(
    `Daily targets: ${calories} kcal | ${protein}g protein | ${carbs}g carbs | ${fats}g fat. ` +
    `Calculated from ${basisNote}.`
  );

  // ── Meal structure ───────────────────────────────────────────────────────
  r.push(
    `Meal structure: ${plan.meals.length} meals — dietary style "${signals.dietaryStyle}", ` +
    `meal prep level "${profileSnapshot.mealPrepLevel}".`
  );

  // ── Hydration ────────────────────────────────────────────────────────────
  r.push(`Hydration: ${plan.hydrationLiters}L — adjusted for training load and body composition.`);

  // ── Allergy / dietary note ───────────────────────────────────────────────
  if (signals.allergies.length > 0) {
    r.push(
      `Allergy flags: ${signals.allergies.join(", ")} — meal suggestions should exclude these ingredients.`
    );
  }

  // ── Decision context ─────────────────────────────────────────────────────
  r.push(`Coaching strategy: "${decisions.nutritionStrategy}".`);

  if (status === "adjusted") {
    r.push(
      `Output is conservative (confidenceScore: ${confidenceScore}) — ` +
      "some macro targets are estimated from incomplete profile data."
    );
  }

  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Warnings — data quality alerts
// ─────────────────────────────────────────────────────────────────────────────

function buildWarnings(packet: NutritionDataPacket): string[] | undefined {
  const { signals, profileSnapshot, missingCriticalData } = packet;
  const w: string[] = [];

  for (const item of missingCriticalData) {
    w.push(
      `${item.label} missing — ` +
      (item.recommendation ?? "complete your nutrition profile to improve macro accuracy") + "."
    );
  }

  if (!signals.hasBodyWeight) {
    w.push(
      "Body weight not set — caloric targets are estimated from population averages. " +
      "Add your weight for BMR-based precision."
    );
  }

  if (!signals.hasAge) {
    w.push(
      "Age not set — BMR calculation uses population average. " +
      "Add your age to improve caloric target accuracy."
    );
  }

  if (signals.allergies.length > 0 && !profileSnapshot.allergyNotes) {
    w.push(
      "Allergy notes absent — meal descriptions cannot account for preparation cross-contamination. " +
      "Add allergy notes to your profile for safer meal guidance."
    );
  }

  return w.length > 0 ? w : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiered recommendations
// ─────────────────────────────────────────────────────────────────────────────

function buildRecommendations(
  packet:     NutritionDataPacket,
  plan:       NutritionPlan,
  confidence: ConfidenceLevel,
  canRun:     boolean,
): string[] {
  if (!canRun) {
    const recs: string[] = [
      "Complete the nutrition section of your profile to unlock personalised macro targets.",
    ];
    for (const item of packet.missingCriticalData) {
      recs.push(item.recommendation ?? `Add your ${item.label} to enable targeted nutrition planning.`);
    }
    return recs;
  }

  const { signals } = packet;
  const { calories, protein } = plan.dailyTarget;

  switch (confidence) {
    case "high":
      // Precise, specific — no hedging; body-weight calibrated targets available
      return [
        `Hit ${calories} kcal and ${protein}g protein today — ` +
        `these targets are calibrated to your body metrics and goal "${signals.goal}".`,
        plan.caloricStrategy === "deficit"
          ? "Maintain your deficit consistently — daily adherence matters more than perfection on any single meal."
          : plan.caloricStrategy === "surplus"
          ? "Hit your caloric surplus — prioritise protein at each meal to direct the surplus toward muscle."
          : "Maintenance calories mean performance and body composition are the priority — hit your protein target first.",
        signals.allergies.length > 0
          ? `Allergy profile active (${signals.allergies.join(", ")}) — verify meal ingredients before consuming.`
          : "No allergies on file — full meal variety is available.",
      ];

    case "medium":
      // Estimated targets, semi-personalised
      return [
        `Aim for approximately ${calories} kcal and ${protein}g protein. ` +
        "These targets are estimates — adding body weight and age will improve their accuracy.",
        `Follow the ${plan.caloricStrategy} strategy for goal "${signals.goal}". ` +
        "Adjust portions slightly if energy or recovery feels off.",
        "Completing your nutrition and body metrics will unlock precise, personalised targets.",
      ];

    case "low":
    default:
      // Generic guidance — explicit uncertainty
      return [
        `Use these meal suggestions as a general framework (${calories} kcal / ${protein}g protein). ` +
        "With limited profile data, treat all targets as rough estimates only.",
        "Complete your nutrition profile to access macro targets calibrated to your actual body metrics and goals.",
      ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task builder
// ─────────────────────────────────────────────────────────────────────────────

function buildNutritionTasks(
  packet:     NutritionDataPacket,
  plan:       NutritionPlan,
  status:     EngineOutputStatus,
  confidenceScore: number,
): IntelligenceTask[] {
  const tasks: IntelligenceTask[] = [];

  plan.meals.forEach((meal, i) => {
    tasks.push({
      id:               buildTaskId("nutrition", TaskKind.Nutrition, i),
      title:            meal.name,
      description:      meal.focus,
      category:         "nutrition",
      kind:             TaskKind.Nutrition,
      priority:         i === 0 ? "high" : "medium",
      estimatedMinutes: 20,
      sourceEngine:     "nutrition",
      isRequired:       true,
      completionType:   "check",
      metadata: {
        tags:              [plan.caloricStrategy, meal.focus.split(",")[0].trim()],
        status,
        confidenceScore,
        completenessScore: packet.completenessScore,
      },
    });
  });

  tasks.push({
    id:             buildTaskId("nutrition", TaskKind.Hydration, plan.meals.length),
    title:          `Hydration — ${plan.hydrationLiters}L target`,
    description:    "Consistent hydration supports performance, recovery, and cognitive function.",
    category:       "nutrition",
    kind:           TaskKind.Hydration,
    priority:       "medium",
    sourceEngine:   "nutrition",
    isRequired:     true,
    completionType: "numeric",
    metadata: {
      tags:              [`${plan.hydrationLiters}L`, "hydration"],
      hydrationLiters:   plan.hydrationLiters,
      status,
      confidenceScore,
      completenessScore: packet.completenessScore,
    },
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

function formatNutritionOutput(
  packet:     NutritionDataPacket,
  plan:       NutritionPlan,
  status:     EngineOutputStatus,
  confidence: ConfidenceLevel,
  warnings:   string[] | undefined,
): EngineFormattedOutput {
  const { signals } = packet;
  const { calories, protein } = plan.dailyTarget;

  let summary: string;
  let planSteps: string[];
  let reasoning: string[];

  if (status === "fallback") {
    summary = "Your nutrition plan is limited today — some key information is missing. General balanced eating is recommended.";
    planSteps = [
      "Focus on whole foods and balanced meals throughout the day.",
      "Stay well hydrated — aim for at least 2L of water.",
      "Complete your nutrition profile to unlock personalised macro targets.",
    ];
    reasoning = [
      "Key nutrition details are missing from your profile.",
      "Allergy-specific assumptions have been intentionally avoided.",
    ];
  } else if (status === "adjusted") {
    summary = `Estimated targets: ${calories} kcal and ${protein}g protein. Some values are approximations — adjust based on how you feel.`;
    planSteps = [
      `Aim for approximately ${calories} kcal today.`,
      `Hit ${protein}g protein — distribute across your ${plan.meals.length} meals.`,
      `Follow a ${plan.caloricStrategy} approach for goal "${signals.goal}".`,
      `Drink ${plan.hydrationLiters}L of water.`,
    ];
    reasoning = [
      `Goal: ${signals.goal} — ${plan.caloricStrategy} strategy prescribed.`,
      "Some macro targets are estimated from partial profile data.",
    ];
  } else {
    // optimal
    const strategyLine =
      plan.caloricStrategy === "deficit"
        ? `You're in a caloric deficit — consistency matters more than perfection on any single meal.`
        : plan.caloricStrategy === "surplus"
        ? `You're in a caloric surplus — prioritise protein at every meal to direct it toward muscle.`
        : `Maintenance calories — hit your protein target first, then fill the rest.`;
    summary = `${calories} kcal and ${protein}g protein today — calibrated to your body metrics and goal "${signals.goal}".`;
    planSteps = [
      `Hit ${calories} kcal across your ${plan.meals.length} meals.`,
      `Reach ${protein}g protein — your primary macro priority.`,
      strategyLine,
      `Drink ${plan.hydrationLiters}L of water.`,
      signals.allergies.length > 0
        ? `Allergens to avoid: ${signals.allergies.join(", ")}.`
        : "No allergens on file — full meal variety is available.",
    ];
    reasoning = [
      `Strategy: ${plan.caloricStrategy} — matched to your goal "${signals.goal}".`,
      `Targets calculated from ${signals.hasBodyWeight && signals.hasAge ? "your body weight and age" : signals.hasBodyWeight ? "your body weight (add age for full precision)" : "population averages"}.`,
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
 * Run the Nutrition Engine.
 *
 * Primary input: NutritionDataPacket (Phase 3).
 * Secondary input: NormalizedIntelligenceInput (backward-compat adapter for generateNutrition()).
 *
 * Deterministic. Never throws. Never mutates inputs. Never sets scheduledTime.
 */
export function runNutritionEngine(
  packet:           NutritionDataPacket,
  normalizedInput:  NormalizedIntelligenceInput,
  adaptationEffect: AdaptationEffect = {},
): NutritionEngineOutput {
  const { canRun, confidenceScore } = packet;
  const { profile, decisions } = normalizedInput;
  const notes: string[] = [];

  const status     = deriveStatus(canRun, confidenceScore);
  const confidence = mapConfidence(confidenceScore);

  // ── Delegate to generator (Phase 3 backward-compat adapter) ───────────────
  const engineReasoning: string[] = [];
  const plan = generateNutrition(profile, decisions, engineReasoning);
  notes.push(...engineReasoning);

  let tasks             = buildNutritionTasks(packet, plan, status, confidenceScore);
  const reasoning       = buildReasoning(packet, plan, status);
  const recommendations = buildRecommendations(packet, plan, confidence, canRun);
  const warnings        = buildWarnings(packet);

  // ── Phase 5: adaptation-driven structural changes ──────────────────────────
  if (adaptationEffect.nutrition) {
    const ne = adaptationEffect.nutrition;

    if (ne.increaseProteinFocus) {
      // Front-load a protein-first directive — it is the highest-leverage habit
      recommendations.unshift(
        `Protein first today — hit ${plan.dailyTarget.protein}g protein before managing total calories. ` +
        "Recent patterns indicate consistent protein intake is the highest-leverage nutrition action."
      );
      notes.push("[nutrition-adaptation] Protein-first recommendation prepended.");
    }

    if (ne.simplifyPlan) {
      // Trim to the top 2 recommendations (protein-first already prepended if active)
      // and append a focused simplification directive — fewer directives, higher compliance
      const topTwo = recommendations.slice(0, 2);
      recommendations.length = 0;
      recommendations.push(
        ...topTwo,
        "Focus on 2–3 core nutrition habits today rather than full tracking — " +
        "recent adherence patterns suggest simplification will improve consistency."
      );
      notes.push("[nutrition-adaptation] Recommendations trimmed to reduce cognitive load.");
    }

    if (ne.increaseHydrationFocus) {
      // Elevate the hydration task priority from "medium" → "high"
      tasks = tasks.map((t): IntelligenceTask =>
        t.kind === TaskKind.Hydration
          ? {
              ...t,
              priority: "high" as IntelligencePriority,
              status:   "adjusted" as IntelligenceTaskStatus,
              metadata: {
                ...t.metadata,
                enginePriority: (t.metadata?.enginePriority as IntelligencePriority | undefined) ?? t.priority,
                adaptationNote: "Hydration prioritized — recent patterns indicate consistent fluid intake needs improvement.",
              },
            }
          : t
      );
      recommendations.push(
        "Hydration is elevated to high priority today — consistent fluid intake directly supports recovery and energy."
      );
      notes.push("[nutrition-adaptation] Hydration task priority elevated to high.");
    }
  }

  notes.push(
    `[nutrition] status: ${status} | strategy: ${plan.caloricStrategy} | ` +
    `calories: ${plan.dailyTarget.calories} kcal | protein: ${plan.dailyTarget.protein}g | ` +
    `meals: ${plan.meals.length} | hydration: ${plan.hydrationLiters}L | ` +
    `confidenceScore: ${confidenceScore}.`
  );

  return {
    engine:          "nutrition",
    caloricStrategy: plan.caloricStrategy,
    confidence,
    status,
    reasoning,
    recommendations,
    warnings,
    engineVersion:   ENGINE_PHASE_VERSION,
    tasks,
    plan,
    notes,
    formatted:       formatNutritionOutput(packet, plan, status, confidence, warnings),
  };
}
