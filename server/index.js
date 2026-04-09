import cors from "cors";
import crypto from "crypto";
import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json());

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment (.env)");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory sessions (fine for dev). Later you’ll move this to a DB.
const sessions = new Map(); // sessionId -> [{role, content}, ...]

// ---------- Planner storage (in-memory, scoped per userId:date) ----------
// dailyPlans:  planId   → DailyPlan record
// dailyTasks:  taskId   → DailyTask record
// userDayPlan: `${userId}:${date}` → planId   (one plan per user per day)
const dailyPlans  = new Map();
const dailyTasks  = new Map();
const userDayPlan = new Map();

// ---------- Planner validation ----------

const AITaskOutputSchema = z.object({
  id:        z.string().min(1).max(50),
  timeText:  z.string().min(1).max(20),
  title:     z.string().min(1).max(200),
  kind:      z.enum(["Workout","Nutrition","Hydration","Mobility","Recovery","Habit","Sleep"]),
  priority:  z.enum(["high","medium","low"]),
  rationale: z.string().min(1).max(400),
});

const AIPlannerOutputSchema = z.object({
  summary:          z.string().min(1).max(600),
  coachingNote:     z.string().min(1).max(600),
  disciplineTarget: z.string().min(1).max(300),
  fallbackPlan:     z.string().min(1).max(300),
  tasks:            z.array(AITaskOutputSchema).min(1).max(15),
});

// ---------- Planner helpers ----------

/** Strip HTML tags and trim. Prevents XSS in stored strings. */
function sanitize(str, maxLen = 500) {
  return String(str ?? "").replace(/<[^>]*>/g, "").trim().slice(0, maxLen);
}

/**
 * Normalize AI-returned task kind to the exact enum value.
 * The AI occasionally returns case variants or synonyms (e.g. "meal", "workout", "stretch").
 * This mapping converts near-matches before Zod validation so valid plans aren't rejected.
 */
function normalizeTaskKind(raw) {
  if (typeof raw !== "string") return raw;
  const s = raw.trim();
  const lower = s.toLowerCase();
  const exact = ["Workout","Nutrition","Hydration","Mobility","Recovery","Habit","Sleep"];
  if (exact.includes(s)) return s;
  if (lower === "workout" || lower === "exercise" || lower === "training" || lower === "gym" || lower === "weightlifting" || lower === "lifting") return "Workout";
  if (lower === "nutrition" || lower === "meal" || lower === "meals" || lower === "eating" || lower === "food" || lower === "diet" || lower === "breakfast" || lower === "lunch" || lower === "dinner") return "Nutrition";
  if (lower === "hydration" || lower === "water" || lower === "drinking" || lower === "fluids" || lower === "drink") return "Hydration";
  if (lower === "mobility" || lower === "stretching" || lower === "stretch" || lower === "flexibility" || lower === "yoga" || lower === "foam rolling") return "Mobility";
  if (lower === "recovery" || lower === "rest" || lower === "foam roll" || lower === "breathwork" || lower === "walk" || lower === "walking" || lower === "active recovery") return "Recovery";
  if (lower === "habit" || lower === "routine" || lower === "daily habit" || lower === "mindset" || lower === "journaling" || lower === "meditation") return "Habit";
  if (lower === "sleep" || lower === "bedtime" || lower === "wind-down" || lower === "wind down" || lower === "sleep prep" || lower === "night routine") return "Sleep";
  return s; // let Zod catch truly unknown values
}

/**
 * Build the planner system prompt from structured input.
 * This is the single place to evolve planner intelligence.
 */
function buildPlannerSystemPrompt({ profile, schedule, condition, behavior, context }) {
  const blockLines = schedule?.blocks?.length
    ? schedule.blocks.map((b) => `  · ${b.title} (${b.type}): ${b.start}–${b.end}`).join("\n")
    : "  · None — schedule is fully open.";

  const gp = context?.gamePlan;

  return `
You are Aira’s automated daily planner. Generate a structured, personalized daily plan for this user.

## User profile
- Name: ${profile?.name || "User"}
- Goal: ${profile?.goal || "Build discipline"}
- Wake: ${profile?.wake || "not set"} | Sleep: ${profile?.sleep || "not set"}
- Starting physique: ${profile?.startingPoint || "not specified"}
- Target physique: ${profile?.targetGoal || "not specified"}
- Body composition direction: ${profile?.bodyFatDirection || "not specified"}
- Experience level: ${profile?.experienceLevel || "not specified"}
- Equipment: ${profile?.equipment || "not specified"}
- Training frequency: ${profile?.workoutFrequency || "not specified"}
- Daily training window: ${profile?.dailyTrainingTime || "not specified"}

## Today’s condition
- Energy: ${condition?.energyLevel || "not specified"}
- Soreness: ${condition?.soreness || "not specified"}
- Motivation: ${condition?.motivationLevel || "not specified"}
- Time available: ${condition?.timeAvailable || "not specified"}
- Focus area: ${condition?.focusArea || "not specified"}

## Today’s game plan
${gp
  ? `- Readiness: ${gp.readiness}\n- Mode: ${gp.timeMode}\n- Directive: "${gp.message}"`
  : "- Not set — use condition data to infer readiness."}

## Fixed schedule blocks (build tasks around these)
${blockLines}

## Behavior data
- Current streak: ${behavior?.streak ?? 0} day${(behavior?.streak ?? 0) !== 1 ? "s" : ""}
- Score so far today: ${behavior?.score ?? 0}/100

## Planning rules
1. Adapt intensity to readiness and timeMode:
   - Push + Full: full-intensity workout, all meals, hydration, recovery
   - Maintain + Condensed: solid workout, main meals, skip supplementary tasks
   - Recover + any: no workout, prioritize mobility, sleep prep, nutrition
   - Any + Minimal: one high-priority task only; everything else is low
2. Treat schedule blocks as unmovable — schedule tasks only in open windows
3. Equipment is a hard constraint — never prescribe barbell/gym work if equipment is ‘none’ or ‘minimal’
4. Spread tasks realistically between wake and sleep times
5. High priority = must not be skipped regardless of how the day goes
6. Limit to 5–9 tasks — a focused plan beats a bloated one
7. Each task must have a specific, realistic timeText (e.g. "7:00 AM") and a one-sentence rationale

## Output
Return ONLY valid JSON — no markdown, no code blocks, no text before or after the JSON object.
Schema:

{
  "summary": "1–2 sentence overview of today’s approach",
  "coachingNote": "one direct coaching directive for today, tied to readiness and condition",
  "disciplineTarget": "the single most important thing to execute — one sentence",
  "fallbackPlan": "minimum viable execution if the day falls apart — one sentence",
  "tasks": [
    {
      "id": "task_1",
      "timeText": "7:00 AM",
      "title": "specific task name — not a category, a real action",
      "kind": "Workout | Nutrition | Hydration | Mobility | Recovery | Habit | Sleep — use EXACTLY one of these values, case-sensitive, no synonyms or variants allowed",
      "priority": "high|medium|low",
      "rationale": "why this task at this time — one sentence"
    }
  ]
}
`.trim();
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/coach/reset", (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) sessions.delete(sessionId);
  res.json({ ok: true });
});

app.post("/api/coach", async (req, res) => {
  try {
    const {
      message,
      sessionId: incomingSessionId,
      name             = "User",
      goal             = "Build discipline",
      wake             = "",
      sleep            = "",
      startingPoint    = "",
      targetGoal       = "",
      bodyFatDirection = "",
      experienceLevel  = "",
      equipment        = "",
      workoutFrequency = "",
      dailyTrainingTime = "",
      checkIn          = {},
      scheduleBlocks   = [],
      recoveryStatus   = "",
      tasksToday       = [],
      streak           = 0,
      score            = 0,
      gamePlan         = null,
    } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Missing message" });
    }

    const sessionId = incomingSessionId || crypto.randomUUID();

    // Pull existing conversation history (or start new)
    const history = sessions.get(sessionId) || [];

    const taskLines = tasksToday.length
      ? tasksToday
          .map((t) => `  ${t.done ? "✓" : "·"} [${(t.priority ?? "medium").toUpperCase()}] ${t.time} — ${t.title} (${t.kind})`)
          .join("\n")
      : "  No plan generated yet.";

    const checkInSection = checkIn.isToday
      ? `- Energy level: ${checkIn.energyLevel || "not specified"}
- Body / soreness: ${checkIn.soreness || "not specified"}
- Motivation level: ${checkIn.motivationLevel || "not specified"}
- Time available: ${checkIn.timeAvailable === "minimal" ? "under 30 min" : checkIn.timeAvailable === "moderate" ? "about 1 hour" : checkIn.timeAvailable === "full" ? "2+ hours" : "not specified"}
- Focus area chosen: ${checkIn.focusArea || "not specified"}`
      : "- Not checked in yet today.";

    const blocksSection = scheduleBlocks.length
      ? scheduleBlocks.map((b) => `  · ${b}`).join("\n")
      : "  · No blocks set — schedule is fully open.";

    const gamePlanSection = gamePlan
      ? `- Readiness: ${gamePlan.readiness}
- Session mode: ${gamePlan.timeMode} (${gamePlan.timeMode === "Minimal" ? "under 30 min available" : gamePlan.timeMode === "Condensed" ? "about 1 hour available" : "2+ hours available"})
- Today’s directive: "${gamePlan.message}"`
      : "- Check-in not completed — no game plan yet.";

    const system = `
You are "Aira" — a performance coach. Your job is execution, not planning.

## User profile
- Name: ${name}
- Primary goal: ${goal}
- Starting physique: ${startingPoint || "not specified"}
- Target physique: ${targetGoal || "not specified"}
- Body composition direction: ${bodyFatDirection || "not specified"}
- Wake time: ${wake || "not specified"}
- Sleep time: ${sleep || "not specified"}

## Training profile
- Experience level: ${experienceLevel || "not specified"}
- Available equipment: ${equipment || "not specified"}
- Preferred workout frequency: ${workoutFrequency || "not specified"}
- Daily training time: ${dailyTrainingTime || "not specified"}

## Daily check-in
${checkInSection}

## Today’s game plan
${gamePlanSection}

## Schedule constraints
${blocksSection}

## Recovery
- Recovery status: ${recoveryStatus || "not calculated"}

## Today’s plan (score: ${score}/100 | streak: ${streak} day${streak !== 1 ? "s" : ""})
${taskLines}

## How to use the Game Plan
The Game Plan is the authoritative coaching directive for today. Every response must reinforce or operationalise it — never contradict it.
- Readiness sets the intensity ceiling: Push = maximum effort, Maintain = clean execution, Recover = protect the body above all else.
- TimeMode sets the session constraint: Full = no restrictions, Condensed = ~1 hour window, Minimal = one priority only.
- The directive message is your anchor. Build on it. Reference it. Do not ignore it.

When no Game Plan exists, acknowledge it briefly and redirect the user to complete the check-in.

## Directive mode — starter prompts
When the user sends any of the following (or close variants), enter directive mode immediately.
Directive mode rules: no preamble, no questions, no schedule generation, no restatement of what they said.
Just coaching.

"Build my day" or "Plan my day"
→ Do NOT generate a time-blocked schedule. The plan already exists.
  Name the 2–3 tasks from today’s plan that matter most given the current readiness and timeMode.
  State them as direct orders. Name each task exactly as it appears in the plan. One short rationale per task tied to the game plan.
  Close with one sentence: the single non-negotiable for today.

"What should I do today?" or "Where do I start?"
→ Name the single highest-priority undone task. Tell them exactly how to start it right now — specific action, not category.
  If Minimal mode: stop there. Otherwise name what to do second.

"Adjust my workout"
→ Prescribe the specific change based on today’s readiness. Be concrete — reduce load, cut sets, swap an exercise.
  For Recover readiness with soreness: scale to mobility only and say so directly.
  For Recover readiness without soreness: keep movement, reduce intensity.
  Never remove the workout entirely unless readiness is Recover AND soreness is flagged.

"Help me stay disciplined"
→ Identify the specific friction point from check-in data (low motivation, low energy, time pressure, soreness).
  Give one concrete action to take in the next 10 minutes. Not a list — a move.
  Tie it to their streak if it is above zero.

## Response style
- Lead with the answer. Never with a question or preamble.
- Short sentences. No filler. No "Great question!" or "Of course!"
- Name tasks from the plan explicitly — never speak in abstractions.
- Look at ✓ (done) vs · (not done) tasks — address only what still needs to happen.
- For Recover readiness: lead with what to scale back, then what to do instead.
- For Minimal timeMode: one priority, one action. Stop there.
- Equipment is a hard constraint — never suggest barbell work to someone without gym access.
- Use the user’s name at most once per conversation.

## Asking questions
Give guidance first, always. Only ask a question if you genuinely cannot provide useful direction without the answer.
If you must ask: one question, at the end, after the guidance. Never more than one.
`.trim();

    const messages = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: message.trim() },
    ];

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() || "No response.";

    // Save back into session history (keep it from growing forever)
    const newHistory = [
      ...history,
      { role: "user", content: message.trim() },
      { role: "assistant", content: reply },
    ].slice(-20); // keep last 20 messages

    sessions.set(sessionId, newHistory);

    return res.json({ reply, sessionId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Server error",
      details: String(err?.message || err),
    });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/planner/generate
// Generate a new daily plan for the user via the AI planner.
// Validates AI output before storing anything — never persists raw AI text.
// ─────────────────────────────────────────────────────────────
app.post("/api/planner/generate", async (req, res) => {
  // Route-level safety net — every exit path from this handler must return JSON.
  // Do NOT use status 502 here: Render's reverse proxy intercepts 502 from the
  // backend and replaces the response body with its own HTML error page, which
  // the client cannot parse as JSON. Use 500 for all internal failures.
  try {
    console.log("[planner/generate] route hit");

    const { userId, profile, schedule, condition, behavior, context } = req.body || {};

    console.log("[planner/generate] payload check — userId present:", !!userId, "profile present:", !!profile);

    if (!userId)  return res.status(400).json({ error: "Missing userId" });
    if (!profile) return res.status(400).json({ error: "Missing profile" });

    const date = context?.date ?? new Date().toISOString().slice(0, 10);
    console.log(`[planner/generate] userId=${String(userId).slice(0, 8)}… date=${date} energy=${condition?.energyLevel ?? "?"} readiness=${context?.gamePlan?.readiness ?? "none"} scheduleBlocks=${schedule?.blocks?.length ?? 0}`);

    const systemPrompt = buildPlannerSystemPrompt({ profile, schedule, condition, behavior, context });
    console.log("[planner/generate] system prompt built, length:", systemPrompt.length);

    // Call AI with JSON mode enforced
    console.log("[planner/generate] calling OpenAI gpt-4o-mini...");
    let completion;
    try {
      completion = await client.chat.completions.create({
        model:           "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: "Generate today's plan." },
        ],
        temperature:     0.5,
        response_format: { type: "json_object" },
      });
    } catch (aiErr) {
      console.error("[planner/generate] OpenAI API call failed:", aiErr?.message ?? aiErr, "status:", aiErr?.status);
      return res.status(500).json({ error: "AI call failed — please try again.", details: String(aiErr?.message ?? aiErr) });
    }

    const rawText = completion.choices?.[0]?.message?.content?.trim() ?? "{}";
    console.log(`[planner/generate] AI responded, rawText length: ${rawText.length}`);

    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch {
      console.error("[planner/generate] AI returned malformed JSON. First 200 chars:", rawText.slice(0, 200));
      return res.status(500).json({ error: "AI returned malformed JSON — please try again." });
    }

    // Log raw task kinds before normalization
    if (raw && Array.isArray(raw.tasks)) {
      const rawKinds = raw.tasks.map((t) => t?.kind ?? "(missing)");
      console.log("[planner/generate] raw task kinds from AI:", JSON.stringify(rawKinds));

      // Normalize task kinds — AI occasionally returns variants (e.g. "meal", "stretch")
      raw.tasks = raw.tasks.map((t) => ({ ...t, kind: normalizeTaskKind(t.kind) }));

      const normalizedKinds = raw.tasks.map((t) => t?.kind ?? "(missing)");
      console.log("[planner/generate] normalized task kinds:", JSON.stringify(normalizedKinds));
    } else {
      console.warn("[planner/generate] raw.tasks is missing or not an array — raw keys:", Object.keys(raw ?? {}));
    }

    // Validate AI output before touching storage — raw AI text never enters the store
    const parsed = AIPlannerOutputSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      console.error("[planner/generate] schema validation failed:", detail);
      // Use 500, NOT 502 — Render replaces 502 response bodies with its own HTML error page
      return res.status(500).json({ error: "AI output failed validation — please try again.", details: detail });
    }
    const validated = parsed.data;
    console.log(`[planner/generate] schema validation passed — ${validated.tasks.length} tasks, kinds: ${JSON.stringify(validated.tasks.map((t) => t.kind))}`);

    // Build the plan record
    const planId = crypto.randomUUID();
    const plan = {
      id:               planId,
      userId,
      date,
      summary:          sanitize(validated.summary),
      coachingNote:     sanitize(validated.coachingNote),
      disciplineTarget: sanitize(validated.disciplineTarget),
      fallbackPlan:     sanitize(validated.fallbackPlan),
      generatedAt:      new Date().toISOString(),
    };

    // Build task records — assign stable IDs, enforce field types, sanitize text
    const tasks = validated.tasks.map((t, i) => ({
      id:          `${planId}_t${i}`,
      planId,
      userId,
      date,
      timeText:    sanitize(t.timeText, 20),
      title:       sanitize(t.title, 200),
      kind:        t.kind,
      priority:    t.priority,
      rationale:   sanitize(t.rationale, 300),
      done:        false,
      completedAt: null,
    }));

    // Remove the previous plan for this user:date (idempotent regeneration)
    const prevPlanId = userDayPlan.get(`${userId}:${date}`);
    if (prevPlanId) {
      for (const [tid, task] of dailyTasks.entries()) {
        if (task.planId === prevPlanId) dailyTasks.delete(tid);
      }
      dailyPlans.delete(prevPlanId);
      console.log(`[planner/generate] replaced previous planId=${prevPlanId}`);
    }

    // Persist to in-memory store
    dailyPlans.set(planId, plan);
    for (const task of tasks) dailyTasks.set(task.id, task);
    userDayPlan.set(`${userId}:${date}`, planId);

    console.log(`[planner/generate] success — planId=${planId} tasks=${tasks.length}`);
    return res.status(201).json({ plan, tasks });
  } catch (err) {
    // Catch anything that escaped the inner try blocks
    console.error("[planner/generate] unhandled error:", err?.message ?? err, err?.stack ?? "");
    // Guard against double-send (e.g. if res was already partially committed)
    if (!res.headersSent) {
      return res.status(500).json({ error: "Unexpected server error — please try again.", details: String(err?.message ?? err) });
    }
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/planner/today?userId=…&date=YYYY-MM-DD
// Fetch the stored plan for this user and date. 404 if none exists.
// ─────────────────────────────────────────────────────────────
app.get("/api/planner/today", (req, res) => {
  const { userId, date } = req.query;

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const d      = date ?? new Date().toISOString().slice(0, 10);
  const planId = userDayPlan.get(`${userId}:${d}`);
  if (!planId) return res.status(404).json({ notFound: true });

  const plan = dailyPlans.get(planId);
  if (!plan) return res.status(404).json({ notFound: true });

  // Only return tasks belonging to this plan (cross-plan safety)
  const tasks = [...dailyTasks.values()].filter((t) => t.planId === planId);

  return res.json({ plan, tasks });
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/planner/task/:taskId/complete
// Toggle task completion. Enforces userId ownership — no cross-user writes.
// ─────────────────────────────────────────────────────────────
app.patch("/api/planner/task/:taskId/complete", (req, res) => {
  const { taskId }     = req.params;
  const { userId, done } = req.body || {};

  if (!userId)              return res.status(400).json({ error: "Missing userId" });
  if (typeof done !== "boolean") return res.status(400).json({ error: "done must be a boolean" });

  const task = dailyTasks.get(taskId);
  if (!task)                return res.status(404).json({ error: "Task not found" });
  if (task.userId !== userId) return res.status(403).json({ error: "Forbidden" });

  const updated = {
    ...task,
    done,
    completedAt: done ? new Date().toISOString() : null,
  };
  dailyTasks.set(taskId, updated);

  return res.json({ task: updated });
});

// ─────────────────────────────────────────────────────────────
// Global error handler — 4-argument signature required by Express.
// Catches any error forwarded via next(err) or unhandled async throws
// in Express 5. Always returns JSON — never HTML.
// Must be registered BEFORE the 404 catch-all.
// ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[server] unhandled error:", err?.message ?? err, err?.stack ?? "");
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error", details: String(err?.message ?? err) });
});

// ─────────────────────────────────────────────────────────────
// Catch-all 404 — always returns JSON so the client can parse it.
// Must be registered after all routes and the error handler.
// ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
});

const port = process.env.PORT || 3001;
app.listen(port, "0.0.0.0", () => {
  console.log(`[server] listening on port ${port}`);
  console.log("[server] routes registered:");
  console.log("  GET  /health");
  console.log("  POST /api/coach/reset");
  console.log("  POST /api/coach");
  console.log("  POST /api/planner/generate");
  console.log("  GET  /api/planner/today");
  console.log("  PATCH /api/planner/task/:taskId/complete");
});