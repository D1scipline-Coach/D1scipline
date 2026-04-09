/**
 * server/planner/promptBuilder.ts
 *
 * Builds the AI planner system prompt from validated PlannerInputData.
 *
 * This is the single place to evolve planner intelligence:
 *   - Extend planning rules without touching route logic
 *   - Swap in a different prompt per PlannerMode (adaptive agent routing)
 *   - Add memory context as a parameter without changing callers
 *
 * Future: buildPlannerPrompt(input, options: { mode, memory, agentOverride })
 */

import type { PlannerInputData } from "../../shared/planner/schemas.js";
import { PlannerMode } from "../../shared/planner/types.js";

/**
 * Returns the system prompt for the given planner input.
 * Extension point: route to a specialised prompt builder per mode.
 */
export function buildPlannerPrompt(
  input: PlannerInputData,
  mode: PlannerMode = PlannerMode.Standard
): string {
  switch (mode) {
    case PlannerMode.Recovery:
      return buildRecoveryPrompt(input);
    case PlannerMode.Nutrition:
      return buildNutritionPrompt(input);
    case PlannerMode.Minimal:
      return buildMinimalPrompt(input);
    default:
      return buildStandardPrompt(input);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Standard planner prompt (used for Push and Maintain days)
// ─────────────────────────────────────────────────────────────────────────────

function buildStandardPrompt(input: PlannerInputData): string {
  const { profile, schedule, condition, behavior, context } = input;

  const blockLines = schedule.blocks.length
    ? schedule.blocks
        .map((b) => `  · ${b.title} (${b.type}): ${b.start}–${b.end}`)
        .join("\n")
    : "  · None — schedule is fully open.";

  const gp = context.gamePlan;
  const gamePlanSection = gp
    ? `- Readiness: ${gp.readiness}\n- Mode: ${gp.timeMode}\n- Directive: "${gp.message}"`
    : "- Not set — infer readiness from condition data.";

  return `
You are Aira's automated daily planner. Generate a structured, personalized daily plan.

## User profile
- Name: ${profile.name}
- Goal: ${profile.goal}
- Wake: ${profile.wake} | Sleep: ${profile.sleep}
- Starting physique: ${profile.startingPoint ?? "not specified"}
- Target physique: ${profile.targetGoal ?? "not specified"}
- Body composition direction: ${profile.bodyFatDirection ?? "not specified"}
- Experience level: ${profile.experienceLevel ?? "not specified"}
- Equipment: ${profile.equipment ?? "not specified"}
- Training frequency: ${profile.workoutFrequency ?? "not specified"}
- Daily training window: ${profile.dailyTrainingTime ?? "not specified"}

## Today's condition
- Energy: ${condition.energyLevel ?? "not specified"}
- Soreness: ${condition.soreness ?? "not specified"}
- Motivation: ${condition.motivationLevel ?? "not specified"}
- Time available: ${condition.timeAvailable ?? "not specified"}
- Focus area: ${condition.focusArea ?? "not specified"}

## Game plan
${gamePlanSection}

## Fixed schedule blocks — build tasks around these, never overlap them
${blockLines}

## Behavior data
- Current streak: ${behavior.streak} day${behavior.streak !== 1 ? "s" : ""}
- Score so far today: ${behavior.score}/100

## Planning rules
1. Adapt intensity to readiness + timeMode:
   - Push + Full: full-intensity workout, all meals, hydration, recovery tasks
   - Maintain + Condensed: solid workout, main meals, skip supplementary tasks
   - Recover + any: no workout, prioritize mobility, sleep prep, nutrition
   - Any + Minimal: exactly ONE high-priority task; everything else is low
2. Treat schedule blocks as unmovable — tasks slot only into open windows
3. Equipment is a hard constraint — never suggest gym work if equipment is 'none' or 'minimal'
4. Spread tasks realistically between wake and sleep times
5. High priority = must not be skipped; Medium = important but flexible; Low = nice-to-have
6. Limit to 5–9 tasks — a focused plan beats a bloated one
7. Each task needs a specific timeText (e.g. "7:00 AM") and a one-sentence rationale

${outputFormatBlock()}
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Specialised prompts — future agent routing targets
// ─────────────────────────────────────────────────────────────────────────────

function buildRecoveryPrompt(input: PlannerInputData): string {
  const { profile, condition } = input;
  return `
You are Aira's recovery day planner. The user's body needs rest and repair.

## User profile
- Name: ${profile.name} | Equipment: ${profile.equipment ?? "not specified"}
- Soreness: ${condition.soreness ?? "not specified"}
- Energy: ${condition.energyLevel ?? "not specified"}

## Recovery planning rules
1. NO workout tasks — mobility and breathwork only
2. Prioritize: sleep prep (high), hydration (high), one mobility session (medium)
3. Nutrition tasks: one clean meal is high priority; additional meals are medium
4. Maximum 5 tasks — keep the day light
5. Every high-priority task must be achievable in under 20 minutes

${outputFormatBlock()}
`.trim();
}

function buildNutritionPrompt(input: PlannerInputData): string {
  const { profile } = input;
  return `
You are Aira's nutrition-focused daily planner. Today's emphasis is dialing in eating.

## User profile
- Name: ${profile.name}
- Goal: ${profile.goal}
- Direction: ${profile.bodyFatDirection ?? "not specified"}

## Nutrition planning rules
1. All Nutrition tasks are high priority
2. Include 3–4 meal tasks with specific times and brief rationale
3. Include at least 2 Hydration tasks
4. One light movement task (Mobility or Recovery) is acceptable — no full workout
5. Sleep prep is always high priority

${outputFormatBlock()}
`.trim();
}

function buildMinimalPrompt(input: PlannerInputData): string {
  const { profile, condition } = input;
  return `
You are Aira's minimal-day planner. The user has under 30 minutes available.

## User profile
- Name: ${profile.name}
- Equipment: ${profile.equipment ?? "not specified"}
- Energy: ${condition.energyLevel ?? "not specified"}

## Minimal planning rules
1. Exactly ONE high-priority task — the single most impactful action for today
2. All other tasks are low priority
3. Maximum 4 tasks total
4. No task over 20 minutes
5. The high-priority task must be completable in the time available

${outputFormatBlock()}
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared output format block — identical across all prompt variants
// ─────────────────────────────────────────────────────────────────────────────

function outputFormatBlock(): string {
  return `
## Output
Return ONLY valid JSON — no markdown, no code blocks, no text before or after.
Schema (all fields required):

{
  "summary":          "1–2 sentence overview of today's approach",
  "coachingNote":     "one direct coaching directive for today",
  "disciplineTarget": "the single most important thing to execute — one sentence",
  "fallbackPlan":     "minimum viable execution if the day falls apart — one sentence",
  "tasks": [
    {
      "id":        "task_1",
      "timeText":  "7:00 AM",
      "title":     "specific task name — a real action, not a category",
      "kind":      "Workout | Nutrition | Hydration | Mobility | Recovery | Habit | Sleep — use EXACTLY one of these values, case-sensitive, no synonyms or variants allowed",
      "priority":  "high|medium|low",
      "rationale": "why this task at this time — one sentence"
    }
  ]
}`.trim();
}
