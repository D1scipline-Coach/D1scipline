/**
 * server/index.ts
 *
 * Aira API server. Two route groups:
 *   /api/coach    — conversational coaching (session-based, existing)
 *   /api/planner  — AI daily planner (schema-validated, modular)
 *
 * The planner routes live in server/planner/routes.ts.
 * All planner logic (AI calls, validation, storage) is isolated there.
 */

import cors          from "cors";
import crypto        from "crypto";
import "dotenv/config";
import express       from "express";
import OpenAI        from "openai";
import { registerPlannerRoutes } from "./planner/routes.js";

const app = express();
app.use(cors());
app.use(express.json());

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment (.env)");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// Chat sessions (in-memory, dev only)
// ─────────────────────────────────────────────────────────────────────────────

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
const sessions = new Map<string, ChatMessage[]>(); // sessionId → history

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/coach/reset
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/coach/reset", (req, res) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  if (sessionId) sessions.delete(sessionId);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/coach
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/coach", async (req, res) => {
  try {
    const {
      message,
      sessionId: incomingSessionId,
      name              = "User",
      goal              = "Build discipline",
      wake              = "",
      sleep             = "",
      startingPoint     = "",
      targetGoal        = "",
      bodyFatDirection  = "",
      experienceLevel   = "",
      equipment         = "",
      workoutFrequency  = "",
      dailyTrainingTime = "",
      checkIn           = {} as Record<string, unknown>,
      scheduleBlocks    = [] as string[],
      recoveryStatus    = "",
      tasksToday        = [] as { done: boolean; priority?: string; time: string; title: string; kind: string }[],
      streak            = 0,
      score             = 0,
      gamePlan          = null as { readiness: string; timeMode: string; message: string } | null,
      coachMode         = "BUILD" as "PUSH" | "BUILD" | "RECOVERY",
      memoryContext     = "" as string,
    } = (req.body ?? {}) as Record<string, unknown>;

    if (!message || !(message as string).trim()) {
      return res.status(400).json({ error: "Missing message" });
    }

    const sessionId = (incomingSessionId as string | undefined) || crypto.randomUUID();
    const history: ChatMessage[] = sessions.get(sessionId) ?? [];

    const taskLines = (tasksToday as typeof tasksToday).length
      ? (tasksToday as typeof tasksToday)
          .map((t) => `  ${t.done ? "✓" : "·"} [${(t.priority ?? "medium").toUpperCase()}] ${t.time} — ${t.title} (${t.kind})`)
          .join("\n")
      : "  No plan generated yet.";

    const ci = checkIn as Record<string, unknown>;
    const checkInSection = ci.isToday
      ? `- Energy level: ${ci.energyLevel || "not specified"}
- Body / soreness: ${ci.soreness || "not specified"}
- Motivation level: ${ci.motivationLevel || "not specified"}
- Time available: ${ci.timeAvailable === "minimal" ? "under 30 min" : ci.timeAvailable === "moderate" ? "about 1 hour" : ci.timeAvailable === "full" ? "2+ hours" : "not specified"}
- Focus area chosen: ${ci.focusArea || "not specified"}`
      : "- Not checked in yet today.";

    const blocksSection = (scheduleBlocks as string[]).length
      ? (scheduleBlocks as string[]).map((b) => `  · ${b}`).join("\n")
      : "  · No blocks set — schedule is fully open.";

    const gp = gamePlan as typeof gamePlan;
    const gamePlanSection = gp
      ? `- Readiness: ${gp.readiness}
- Session mode: ${gp.timeMode} (${gp.timeMode === "Minimal" ? "under 30 min available" : gp.timeMode === "Condensed" ? "about 1 hour available" : "2+ hours available"})
- Today's directive: "${gp.message}"`
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

## Today's game plan
${gamePlanSection}

## Schedule constraints
${blocksSection}

## Recovery
- Recovery status: ${recoveryStatus || "not calculated"}

## Today's plan (score: ${score}/100 | streak: ${streak} day${(streak as number) !== 1 ? "s" : ""})
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
  Name the 2–3 tasks from today's plan that matter most given the current readiness and timeMode.
  State them as direct orders. Name each task exactly as it appears in the plan. One short rationale per task tied to the game plan.
  Close with one sentence: the single non-negotiable for today.

"What should I do today?" or "Where do I start?"
→ Name the single highest-priority undone task. Tell them exactly how to start it right now — specific action, not category.
  If Minimal mode: stop there. Otherwise name what to do second.

"Adjust my workout"
→ Prescribe the specific change based on today's readiness. Be concrete — reduce load, cut sets, swap an exercise.
  For Recover readiness with soreness: scale to mobility only and say so directly.
  For Recover readiness without soreness: keep movement, reduce intensity.
  Never remove the workout entirely unless readiness is Recover AND soreness is flagged.

"Help me stay disciplined"
→ Identify the specific friction point from check-in data (low motivation, low energy, time pressure, soreness).
  Give one concrete action to take in the next 10 minutes. Not a list — a move.
  Tie it to their streak if it is above zero.

${(memoryContext as string).trim() ? `## Long-term memory\n${(memoryContext as string).trim()}\n\nUse this to personalise tone examples: reference the preferred workout time when anchoring the user to their best window; flag the most-skipped category as something to watch; frame the consistency score honestly — celebrate if high, acknowledge the gap if low.\n` : ""}## Coach tone — ${coachMode as string} MODE
${
  (coachMode as string) === "PUSH"
    ? `The user is falling behind or at risk. Be direct and challenging.
- No softening. No "it's okay". Lead with urgency.
- Short imperative sentences. "Do this now." "Get up." "Move."
- Reference their streak if at risk — make skipping feel costly.
- Name the exact task they need to do next. No abstractions.
- 2–3 sentences maximum unless they ask for more.`
    : (coachMode as string) === "RECOVERY"
    ? `The user is under stress, low energy, or in a recovery state. Be calm and simplifying.
- Lead with simplicity: "One thing at a time." Remove pressure.
- Focus on what's achievable, not what was missed.
- Do not mention missed tasks critically — redirect instead.
- Soften intensity without lowering standards: "lighter" not "easier".
- 2–3 calm sentences. Never match urgency that isn't there.`
    : `Normal execution day. Be structured and encouraging.
- Acknowledge progress if it exists. Frame next steps as momentum.
- Stay concrete — name actual tasks from the plan.
- 2–4 sentences. Don't over-explain or pad the response.`
}

## Response style
- Lead with the answer. Never with a question or preamble.
- Short sentences. No filler. No "Great question!" or "Of course!"
- Name tasks from the plan explicitly — never speak in abstractions.
- Look at ✓ (done) vs · (not done) tasks — address only what still needs to happen.
- For Recover readiness: lead with what to scale back, then what to do instead.
- For Minimal timeMode: one priority, one action. Stop there.
- Equipment is a hard constraint — never suggest barbell work to someone without gym access.
- Use the user's name at most once per conversation.

## Asking questions
Give guidance first, always. Only ask a question if you genuinely cannot provide useful direction without the answer.
If you must ask: one question, at the end, after the guidance. Never more than one.
`.trim();

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: (message as string).trim() },
    ];

    const completion = await client.chat.completions.create({
      model:       "gpt-4o-mini",
      messages,
      temperature: 0.7,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() ?? "No response.";

    const newHistory: ChatMessage[] = [
      ...history,
      { role: "user",      content: (message as string).trim() },
      { role: "assistant", content: reply },
    ].slice(-20);

    sessions.set(sessionId, newHistory);
    return res.json({ reply, sessionId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error:   "Server error",
      details: String((err as Error)?.message ?? err),
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Planner routes — mounted under /api/planner
// All route handlers live in server/planner/routes.ts
// ─────────────────────────────────────────────────────────────────────────────

const plannerRouter = express.Router();
registerPlannerRoutes(plannerRouter, client);
app.use("/api/planner", plannerRouter);

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

const port = process.env.PORT ?? 3001;
app.listen(port, "0.0.0.0", () => {
  console.log("API listening on:");
  console.log(`- http://localhost:${port}`);
});
