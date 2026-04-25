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

// ─────────────────────────────────────────────────────────────────────────────
// Schedule context helpers — compute free windows from the user's saved blocks
// ─────────────────────────────────────────────────────────────────────────────

type ParsedBlock = { title: string; type: string; startMin: number; endMin: number };

function parseBlockTime(t: string): number | null {
  const upper = t.trim().toUpperCase();
  const hasPM = upper.includes("PM");
  const hasAM = upper.includes("AM");
  const clean = upper.replace(/[AP]M/, "").trim();
  const parts = clean.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  let [h, m = 0] = parts;
  if (hasPM && h !== 12) h += 12;
  if (hasAM && h === 12) h = 0;
  return h * 60 + m;
}

function fmtBlockTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const suf = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suf}` : `${h12}:${String(m).padStart(2, "0")}${suf}`;
}

/**
 * Builds a compact schedule context string for the AI prompt.
 * Lists busy blocks and detected free windows so the model can
 * slot tasks only into available time.
 */
function buildScheduleContext(
  blocks: PlannerInputData["schedule"]["blocks"],
  profile: PlannerInputData["profile"]
): string {
  if (!blocks.length) return "";

  // Parse and validate all blocks
  const parsed: ParsedBlock[] = blocks
    .map((b) => ({
      title:    b.title,
      type:     b.type,
      startMin: parseBlockTime(b.start) ?? -1,
      endMin:   parseBlockTime(b.end)   ?? -1,
    }))
    .filter((b) => b.startMin >= 0 && b.endMin > b.startMin)
    .sort((a, b) => a.startMin - b.startMin);

  if (!parsed.length) return "";

  // Anchor free windows to the user's wake/sleep times (fall back to 6AM/10PM)
  const WAKE  = parseBlockTime(profile.wake)  ?? 6  * 60;
  const SLEEP = parseBlockTime(profile.sleep) ?? 22 * 60;

  const busyStr = parsed
    .map((b) => `${b.title} (${fmtBlockTime(b.startMin)}–${fmtBlockTime(b.endMin)})`)
    .join(", ");

  // Collect gaps > 30 min as free windows
  const freeWindows: string[] = [];

  if (parsed[0].startMin - WAKE > 30)
    freeWindows.push(`${fmtBlockTime(WAKE)}–${fmtBlockTime(parsed[0].startMin)}`);

  for (let i = 0; i < parsed.length - 1; i++) {
    const gap = parsed[i + 1].startMin - parsed[i].endMin;
    if (gap > 30)
      freeWindows.push(`${fmtBlockTime(parsed[i].endMin)}–${fmtBlockTime(parsed[i + 1].startMin)}`);
  }

  const last = parsed[parsed.length - 1];
  if (SLEEP - last.endMin > 30)
    freeWindows.push(`${fmtBlockTime(last.endMin)}–${fmtBlockTime(SLEEP)}`);

  // Load classification
  const totalBusy = parsed.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const dayLen    = Math.max(1, SLEEP - WAKE);
  const busyRatio = totalBusy / dayLen;
  const load      = busyRatio > 0.6 ? "heavy" : busyRatio > 0.3 ? "moderate" : "light";

  let ctx = `Busy blocks: ${busyStr}.`;
  if (freeWindows.length)
    ctx += ` Free windows: ${freeWindows.join(", ")}.`;
  ctx += ` Schedule load: ${load}.`;

  return ctx;
}

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

  const schedCtx = buildScheduleContext(schedule.blocks, profile);

  const blockLines = schedule.blocks.length
    ? schedule.blocks
        .map((b) => `  · ${b.title} (${b.type}): ${b.start}–${b.end}`)
        .join("\n")
    : "  · None — schedule is fully open.";

  const gp = context.gamePlan;
  const gamePlanSection = gp
    ? `- Readiness: ${gp.readiness}\n- Mode: ${gp.timeMode}\n- Directive: "${gp.message}"`
    : "- Not set — infer readiness from condition data.";

  // Format training days display
  const trainingDaysStr = profile.trainingDaysPerWeek != null
    ? `${profile.trainingDaysPerWeek} days/week`
    : profile.workoutFrequency ?? "not specified";

  // Equipment — prefer new gymAccess label, fall back to legacy equipment
  const gymStr =
    profile.gymAccess === "full_gym"          ? "Full gym (barbells, machines, cables)" :
    profile.gymAccess === "limited_equipment" ? "Limited equipment (dumbbells, bands, pull-up bar)" :
    profile.gymAccess === "bodyweight_only"   ? "Bodyweight only — no equipment" :
    profile.equipment === "none"              ? "Bodyweight only — no equipment" :
    profile.equipment === "minimal"           ? "Minimal equipment" :
    profile.equipment === "full_gym"          ? "Full gym access" :
    "not specified";

  // Training style label
  const styleStr =
    profile.primaryTrainingStyle === "athlete"         ? "Athlete (speed, power, conditioning)" :
    profile.primaryTrainingStyle === "muscle"          ? "Muscle building (hypertrophy)" :
    profile.primaryTrainingStyle === "strength"        ? "Strength (compound lifts, powerlifting)" :
    profile.primaryTrainingStyle === "fat_loss"        ? "Fat loss (high output, deficit)" :
    profile.primaryTrainingStyle === "general_fitness" ? "General fitness (health, longevity)" :
    profile.primaryTrainingStyle === "calisthenics"    ? "Calisthenics (bodyweight mastery)" :
    "not specified";

  // Goal type label
  const goalTypeStr =
    profile.goalType === "lose_fat"            ? "Lose fat and get lean" :
    profile.goalType === "build_muscle"        ? "Build muscle and size" :
    profile.goalType === "get_stronger"        ? "Get stronger" :
    profile.goalType === "improve_athleticism" ? "Improve athleticism and performance" :
    profile.goalType === "stay_consistent"     ? "Build discipline and stay consistent" :
    profile.goal;

  // Body composition direction
  const bfdStr =
    (profile.bodyFatDirection ?? (
      profile.goalType === "lose_fat"     ? "lose_fat" :
      profile.goalType === "build_muscle" ? "build_lean" : "maintain"
    ));

  return `
You are Aira's automated program planner. Generate a structured, personalized 3-day plan.

## Athlete profile
- Name: ${profile.name}
- Age: ${profile.age ?? "not specified"} | Gender: ${profile.gender ?? "not specified"}
- Height: ${profile.height ?? "not specified"} | Weight: ${profile.weight ?? "not specified"}
- Goal: ${goalTypeStr}
${profile.goalNotes ? `- Goal notes: ${profile.goalNotes}` : ""}
- Body composition direction: ${bfdStr}
- Training style: ${styleStr}
- Experience level: ${profile.experienceLevel ?? "not specified"}
- Equipment / gym access: ${gymStr}
- Training days per week: ${trainingDaysStr}
- Wake: ${profile.wake} | Sleep: ${profile.sleep}

## Program design constraints (derived from profile — HARD RULES)
- Equipment is absolute — never prescribe barbell work without full gym access; never suggest gym machines for bodyweight-only profiles
- Match exercise selection to training style: athlete → conditioning circuits; muscle → isolation + compound hypertrophy; strength → heavy compound movements; fat_loss → metabolic and superset-style; calisthenics → progressions (push-up → archer → planche path)
- Match volume to experience: beginner → 3–4 working sets per exercise, 2–3 exercises/session; intermediate → 4–5 sets, 4–5 exercises; advanced → 5–6 sets, compound periodisation
- Match training days: ${trainingDaysStr} → plan workout days and rest/recovery days across the 3-day window accordingly
- Body composition direction: ${bfdStr} → lose_fat: caloric deficit emphasis, conditioning circuits, shorter rest; build_lean: progressive overload, compound lifts, slight surplus meals; maintain: balanced volume and nutrition

## Today's condition (day 0 only)
- Energy: ${condition.energyLevel ?? "not specified"}
- Soreness: ${condition.soreness ?? "not specified"}
- Motivation: ${condition.motivationLevel ?? "not specified"}
- Time available: ${condition.timeAvailable ?? "not specified"}
- Focus area: ${condition.focusArea ?? "not specified"}

## Game plan (day 0 only)
${gamePlanSection}

## Fixed schedule blocks — NEVER place tasks during these windows (applies to all days)
${blockLines}
${schedCtx ? `\n## Schedule analysis\n${schedCtx}` : ""}

## Behavior data
- Current streak: ${behavior.streak} day${behavior.streak !== 1 ? "s" : ""}
- Score so far today: ${behavior.score}/100
${behavior.patternHints ? `\n## Learned behavior patterns (apply these when scheduling)\n${behavior.patternHints}` : ""}

## Day-level planning rules (apply to EVERY day)
1. Adapt day 0 intensity to readiness + timeMode exactly as specified above
2. Schedule blocks are IMMOVABLE — all task timeTexts must fall inside free windows only
3. If schedule load is "heavy" (60%+ blocked): max 5 tasks, prioritize ruthlessly
4. If schedule load is "light" (open day): aim for 7–9 tasks, more volume and depth
5. Place high-priority tasks (especially Workout) in the EARLIEST available free window
6. Equipment is a hard constraint — never suggest gym work if equipment is 'none' or 'minimal'
7. High priority = must not be skipped; Medium = important but flexible; Low = nice-to-have
8. Each task needs a specific timeText inside a free window and a one-sentence rationale

## Workout exercise generation rules (REQUIRED for all Workout tasks)
Every Workout task MUST include an "exercises" array. Rules:
- 3–6 exercises per session (no more, no less)
- sets: 2–5 per exercise (number, not a range)
- reps: string format — use a range for hypertrophy/strength ("6-8", "8-12"), a fixed number for conditioning ("15"), or "AMRAP" for circuits
- rest: required — "60s" for conditioning, "90s" for hypertrophy, "2 min" for strength/heavy compounds
- notes: one coaching cue per exercise (form point, intensity note, or modifier)
- Exercise selection by training style:
  · athlete     → power cleans, box jumps, sprint intervals, pull-ups, carries
  · muscle      → bench press, dumbbell rows, Romanian deadlift, cable curls, lateral raises
  · strength    → squat, deadlift, bench press, overhead press, barbell row (heavy compound priority)
  · fat_loss    → supersets, kettlebell swings, burpees, dumbbell circuits, HIIT-style pairings
  · general_fitness → push-ups, goblet squat, dumbbell press, lunges, plank
  · calisthenics → push-up progressions, pull-up progressions, dips, L-sit, pistol squat, ring rows
- Equipment constraint (ABSOLUTE — override all else):
  · full_gym → barbells, machines, cables, dumbbells all permitted
  · limited_equipment → dumbbells and bodyweight only — NO barbells, NO machines, NO cables
  · bodyweight_only → bodyweight ONLY — NO weights of any kind
- Volume by experience:
  · beginner     → 3 sets per exercise, stay at lower end of rep range
  · intermediate → 3–4 sets, mid-range reps
  · advanced     → 4–5 sets, full range including heavy low-rep work
- Day variation (CRITICAL): exercises and set/rep schemes must differ across the 3 days — never repeat the same exercise on consecutive days

## Multi-day variation rules (critical — DO NOT generate identical days)
- Day 0: follow today's game plan and condition exactly
- Day 1: lighter or complementary — if day 0 is high intensity, day 1 should be lighter (mobility, nutrition focus, or moderate effort); never stack heavy workouts back-to-back
- Day 2: second effort or balanced — complete a logical 3-day arc (e.g. Push → Recovery → Build, or Strength → Mobility → Strength)
- DO NOT copy task titles or structures between days — each day must be distinct
- Workout titles must differ (e.g. "Upper Body Strength" vs "Lower Body + Core" vs "Full Body Circuit")
- Hydration and Sleep tasks may repeat — they are daily anchors
- All days share the same schedule constraints; apply the same block/free-window rules to each

${multiDayOutputFormatBlock()}
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
Schema (all fields required unless marked optional):

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
      "kind":      "Workout | Nutrition | Hydration | Mobility | Recovery | Habit | Sleep — EXACTLY one, case-sensitive",
      "priority":  "high|medium|low",
      "rationale": "why this task at this time — one sentence",
      "exercises": [
        {
          "name":  "Exercise name",
          "sets":  3,
          "reps":  "10-12",
          "rest":  "60s",
          "notes": "One coaching cue"
        }
      ]
    }
  ]
}

IMPORTANT: Include "exercises" ONLY on Workout tasks (3–6 entries). Omit for all other task kinds.`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-day output format — used by Standard prompt (3-day program)
// ─────────────────────────────────────────────────────────────────────────────

function multiDayOutputFormatBlock(): string {
  return `
## Output
Return ONLY valid JSON — no markdown, no code blocks, no text before or after.
Schema (all fields required unless marked optional):

{
  "summary":          "1–2 sentence overview of the 3-day program approach",
  "coachingNote":     "one direct coaching directive for today (day 0)",
  "disciplineTarget": "the single most important thing to execute today — one sentence",
  "fallbackPlan":     "minimum viable execution if today falls apart — one sentence",
  "days": [
    {
      "dayIndex": 0,
      "purpose":  "brief label — e.g. 'Upper body strength', 'Primary effort'",
      "tasks": [
        {
          "id":        "d0_task_1",
          "timeText":  "7:00 AM",
          "title":     "specific task name — a real action, not a category",
          "kind":      "Workout | Nutrition | Hydration | Mobility | Recovery | Habit | Sleep — EXACTLY one, case-sensitive",
          "priority":  "high|medium|low",
          "rationale": "why this task at this time — one sentence",
          "exercises": [
            {
              "name":  "Exercise name (specific movement)",
              "sets":  4,
              "reps":  "6-8",
              "rest":  "90s",
              "notes": "One coaching cue — form point or intensity note"
            }
          ]
        }
      ]
    },
    {
      "dayIndex": 1,
      "purpose":  "e.g. 'Lower body', 'Active recovery', 'Nutrition focus'",
      "tasks": [ ... ]
    },
    {
      "dayIndex": 2,
      "purpose":  "e.g. 'Full body', 'Second effort', 'Balanced day'",
      "tasks": [ ... ]
    }
  ]
}

CRITICAL RULES FOR exercises FIELD:
- Include "exercises" ONLY on tasks where kind === "Workout"
- Every Workout task MUST have an "exercises" array with 3–6 entries
- Non-Workout tasks must NOT include "exercises"
- sets must be a number (integer), reps must be a string, rest must be a string ending in "s" or "min"`.trim();
}
