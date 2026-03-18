import cors from "cors";
import crypto from "crypto";
import "dotenv/config";
import express from "express";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment (.env)");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory sessions (fine for dev). Later you’ll move this to a DB.
const sessions = new Map(); // sessionId -> [{role, content}, ...]

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
      name = "Nate",
      goal = "Build discipline",
    } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Missing message" });
    }

    const sessionId = incomingSessionId || crypto.randomUUID();

    // Pull existing conversation history (or start new)
    const history = sessions.get(sessionId) || [];

    const system = `
You are "Discipline Coach" — an interactive coach like ChatGPT.
Your job:
- Ask 1–2 clarifying questions when needed (don’t assume).
- Give practical steps, tailored to the user’s goal.
- Keep it structured: short sections + bullets.
- Avoid generic long blog posts.
- If the user asks for a plan, give a clear plan with next actions.
User name: ${name}
Primary goal: ${goal}
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

const port = process.env.PORT || 3001;
app.listen(port, "0.0.0.0", () => {
  console.log("API listening on:");
  console.log(`- http://localhost:${port}`);
});