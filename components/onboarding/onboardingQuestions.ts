/**
 * components/onboarding/onboardingQuestions.ts
 *
 * Centralized question configuration for the Aira onboarding system.
 *
 * Every question, option, label, subtext, and input type is defined here.
 * OnboardingFlow.tsx renders from this config — it does not hardcode any
 * display text or option arrays.
 *
 * To change wording, add a new option, or re-describe a field:
 *   edit this file only — no UI code to touch.
 *
 * Exports:
 *   Q           — question definitions keyed by fieldKey
 *   STEP_CONFIG — per-step title, subtitle, and domain label
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type InputType =
  | "text"
  | "number"
  | "number_grid"
  | "chips"        // single-select compact pill row
  | "cards"        // single-select full-width option cards with desc
  | "time";        // free-text time entry (e.g. "6:00 AM")

export type QuestionOption = {
  value:  string;
  label:  string;
  desc?:  string;
};

/**
 * Declarative condition for showing a question.
 * Evaluated in OnboardingFlow via isVisible().
 *
 * notEquals — show when state[field] !== value  (most common: hide for one goal)
 * equals    — show only when state[field] === value  (use for "only if X is selected")
 */
export type QuestionCondition =
  | { field: string; notEquals: string }
  | { field: string; equals:    string };

export type OnboardingQuestion = {
  fieldKey:       string;
  question:       string;
  subtext:        string;
  inputType:      InputType;
  options?:       QuestionOption[];
  numberOptions?: number[];           // only for inputType "number_grid"
  required:       boolean;
  domain: "profile" | "goals" | "training" | "nutrition" | "recovery" | "sleep" | "schedule";
  /** Goal-aware subtext — overrides `subtext` when primaryGoal matches the key */
  subtextByGoal?: Record<string, string>;
  /** When set, hides this question unless the condition is satisfied */
  condition?:     QuestionCondition;
};

export type OnboardingStepConfig = {
  title:    string;
  subtitle: string;
  /**
   * Short uppercase coaching label rendered above the step counter.
   * Gives the user a sense of progress and context — e.g. "YOUR NORTH STAR".
   */
  progressLabel?:  string;
  /** Goal-aware subtitle overrides — used by Step 5 (Nutrition) */
  subtitleByGoal?: Record<string, string>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Step configuration
// ─────────────────────────────────────────────────────────────────────────────

export const STEP_CONFIG: Record<number, OnboardingStepConfig> = {
  1: {
    title:    "Let's start with you.",
    subtitle: "Your physical profile shapes every workout and recovery recommendation.",
  },
  2: {
    progressLabel: "TRAINING FOUNDATION",
    title:    "Your training setup.",
    subtitle: "We build every session around your actual environment — no assumptions made.",
  },
  3: {
    progressLabel: "TRAINING PREFERENCE",
    title:    "How do you like to train?",
    subtitle: "Pick what resonates — not what sounds most impressive. This shapes every program we generate.",
  },
  4: {
    progressLabel: "YOUR NORTH STAR",
    title:    "What are you working toward?",
    subtitle: "Being specific here means better programming from day one.",
  },
  5: {
    progressLabel: "FUEL STRATEGY",
    title:    "How you fuel.",
    subtitle: "Nutrition is half the result. We'll match your plan to your real lifestyle.",
    subtitleByGoal: {
      lose_fat:            "For fat loss, food timing and protein targets matter as much as calories.",
      build_muscle:        "For muscle building, you need a surplus. We'll factor in your prep capacity.",
      get_stronger:        "Strength training runs on fuel. Consistent intake beats perfect macros.",
      improve_athleticism: "Performance nutrition is about recovery as much as energy.",
      stay_consistent:     "Simple, sustainable eating beats complicated plans. Let's keep it realistic.",
    },
  },
  6: {
    progressLabel: "FOOD SAFETY",
    title:    "Any food allergies?",
    subtitle: "We'll use this to keep your nutrition plan safe and remove anything you can't eat.",
  },
  7: {
    progressLabel: "RECOVERY BASELINE",
    title:    "Your recovery baseline.",
    subtitle: "Recovery determines how hard we push you. No wrong answers — this calibrates your daily intensity.",
  },
  8: {
    progressLabel: "FINAL STEP",
    title:    "Your day, your rules.",
    subtitle: "Aira plans around your schedule — not the other way around.",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Question definitions
// ─────────────────────────────────────────────────────────────────────────────

export const Q = {

  // ── Profile ───────────────────────────────────────────────────────────────

  firstName: {
    fieldKey:  "firstName",
    question:  "What should we call you?",
    subtext:   "Personalises your daily coaching, check-ins, and messages.",
    inputType: "text" as InputType,
    required:  true,
    domain:    "profile",
  },

  age: {
    fieldKey:  "age",
    question:  "How old are you?",
    subtext:   "Age helps us calibrate intensity, recovery time, and hormonal context.",
    inputType: "number" as InputType,
    required:  false,
    domain:    "profile",
  },

  gender: {
    fieldKey:  "gender",
    question:  "Which best describes you?",
    subtext:   "Hormonal context shapes recovery rates, intensity targets, and calorie recommendations.",
    inputType: "chips" as InputType,
    options: [
      { value: "male",   label: "Male" },
      { value: "female", label: "Female" },
      { value: "other",  label: "Other" },
    ],
    required: false,
    domain:   "profile",
  },

  height: {
    fieldKey:  "height",
    question:  "What's your height?",
    subtext:   "Helps us set accurate calorie and body composition targets.",
    inputType: "text" as InputType,
    required:  false,
    domain:    "profile",
  },

  weight: {
    fieldKey:  "weight",
    question:  "What's your current weight?",
    subtext:   "Your starting point. We'll track changes over time.",
    inputType: "text" as InputType,
    required:  false,
    domain:    "profile",
  },

  // ── Goals ─────────────────────────────────────────────────────────────────

  primaryGoal: {
    fieldKey:  "primaryGoal",
    question:  "What's your main goal right now?",
    subtext:   "This is the north star for every plan we build.",
    inputType: "cards" as InputType,
    options: [
      { value: "lose_fat",            label: "Lose fat and lean out",           desc: "Burn body fat, improve conditioning" },
      { value: "build_muscle",        label: "Build muscle and size",           desc: "Pack on mass, increase definition" },
      { value: "get_stronger",        label: "Get stronger",                    desc: "Increase power in the big compound lifts" },
      { value: "improve_athleticism", label: "Improve athleticism",             desc: "Speed, agility, and conditioning" },
      { value: "stay_consistent",     label: "Build consistency and discipline", desc: "Lock in the habit and make it stick" },
    ],
    required: true,
    domain:   "goals",
  },

  goalUrgency: {
    fieldKey:  "goalUrgency",
    question:  "How fast do you want to push toward this goal?",
    subtext:   "Sets the intensity and pacing of your program.",
    inputType: "cards" as InputType,
    options: [
      { value: "gradual",    label: "Gradual",     desc: "Low pressure, long game — sustainable momentum over time" },
      { value: "steady",     label: "Steady",      desc: "Consistent effort with measurable progress every few months" },
      { value: "aggressive", label: "Aggressive",  desc: "Maximum intensity — full structure, every day counts from day one" },
    ],
    required:  false,
    domain:    "goals",
    // Urgency framing doesn't apply to habit-building — the goal is consistency, not pace.
    condition: { field: "primaryGoal", notEquals: "stay_consistent" },
  },

  goalNotes: {
    fieldKey:  "goalNotes",
    question:  "Anything else you want to work on?",
    subtext:   "Secondary goals help us add variety without losing focus.",
    subtextByGoal: {
      lose_fat:            "Think: strength retention, energy levels, conditioning — useful context during a cut.",
      build_muscle:        "Adding a strength or athletic secondary goal keeps your training well-rounded.",
      get_stronger:        "Strength-first works best with a clear hierarchy. What else matters on the way up?",
      improve_athleticism: "Any specific sport, movement skill, or performance target we should prioritise?",
      stay_consistent:     "Building the habit is the goal. What would make showing up feel worth it?",
    },
    inputType: "text" as InputType,
    required:  false,
    domain:    "goals",
  },

  // ── Training ──────────────────────────────────────────────────────────────

  gymAccess: {
    fieldKey:  "gymAccess",
    question:  "Where will you be doing most of your training?",
    subtext:   "We'll program exercises and load progressions around your actual setup.",
    subtextByGoal: {
      lose_fat:            "For fat loss, we'll layer in conditioning work — space and cardio options matter.",
      build_muscle:        "For muscle building, load progression is the key variable. Full access gives us the most to work with.",
      get_stronger:        "Strength is built around barbells. Full gym access opens up the full programming toolkit.",
      improve_athleticism: "Athletic training needs space, speed work, and ideally an open floor.",
    },
    inputType: "cards" as InputType,
    options: [
      { value: "full_gym",          label: "Full gym",            desc: "Barbells, machines, cables — full weight room access" },
      { value: "limited_equipment", label: "Home or limited setup", desc: "Dumbbells, bands, pull-up bar, or similar" },
      { value: "bodyweight_only",   label: "No equipment",        desc: "Bodyweight only — home, park, or travel" },
    ],
    required: true,
    domain:   "training",
  },

  experienceLevel: {
    fieldKey:  "experienceLevel",
    question:  "Where are you with training right now?",
    subtext:   "Honest input here avoids programs that are too easy or too aggressive.",
    inputType: "cards" as InputType,
    options: [
      { value: "beginner",     label: "Just getting started",  desc: "Less than a year of consistent training" },
      { value: "intermediate", label: "Some experience",       desc: "1–3 years, comfortable with the basics" },
      { value: "advanced",     label: "Experienced",           desc: "3+ years, confident with technique and programming" },
    ],
    required: true,
    domain:   "training",
  },

  trainingDaysPerWeek: {
    fieldKey:     "trainingDaysPerWeek",
    question:     "How many days can you realistically train most weeks?",
    subtext:      "We'll build a program you can actually maintain — not just survive.",
    subtextByGoal: {
      lose_fat:            "More sessions increases caloric output — but only if recovery keeps up.",
      build_muscle:        "Muscle grows between sessions, not during them. Pick a number you'll actually hit.",
      get_stronger:        "Strength responds to frequency. 3–4 focused days per week is the proven range.",
      improve_athleticism: "Athletic development needs varied stimulus — 4–5 days gives us room to build it.",
    },
    inputType:    "number_grid" as InputType,
    numberOptions: [2, 3, 4, 5, 6, 7],
    required:     true,
    domain:       "training",
  },

  sessionDuration: {
    fieldKey:  "sessionDuration",
    question:  "How much time can you usually give each workout?",
    subtext:   "We'll fit the right volume into the time you actually have.",
    subtextByGoal: {
      lose_fat:     "Longer sessions burn more — but consistency beats duration every time.",
      build_muscle: "45–60 minutes covers a full hypertrophy session. Beyond that, intensity tends to drop.",
      get_stronger: "Strength sessions need warmup time and heavy work. Build in at least 60 minutes.",
    },
    inputType: "chips" as InputType,
    options: [
      { value: "20min",  label: "20 min" },
      { value: "30min",  label: "30 min" },
      { value: "45min",  label: "45 min" },
      { value: "60min",  label: "1 hour" },
      { value: "90min+", label: "90 min+" },
    ],
    required: false,
    domain:   "training",
  },

  injuries: {
    fieldKey:  "injuries",
    question:  "Do you have any injuries or limitations we should build around?",
    subtext:   "We'll avoid movements that aggravate them and suggest alternatives.",
    inputType: "text" as InputType,
    required:  false,
    domain:    "training",
  },

  trainingStyle: {
    fieldKey:  "trainingStyle",
    question:  "What kind of training do you enjoy most?",
    subtext:   "You'll train harder and more consistently when the style fits you.",
    inputType: "cards" as InputType,
    options: [
      { value: "athlete",         label: "Athlete",         desc: "Performance-first — speed, power, conditioning" },
      { value: "muscle",          label: "Muscle building",  desc: "Hypertrophy focus — size, definition, volume" },
      { value: "strength",        label: "Strength",        desc: "Get stronger in the big compound lifts" },
      { value: "fat_loss",        label: "Fat loss",        desc: "High-output training with a caloric deficit emphasis" },
      { value: "general_fitness", label: "General fitness", desc: "All-round health, energy, and longevity" },
      { value: "calisthenics",    label: "Calisthenics",    desc: "Bodyweight mastery — rings, bars, movement skills" },
    ],
    required: true,
    domain:   "training",
  },

  // ── Nutrition ─────────────────────────────────────────────────────────────

  dietaryStyle: {
    fieldKey:  "dietaryStyle",
    question:  "How do you usually like to eat?",
    subtext:   "We'll recommend meals and foods that actually fit your lifestyle.",
    inputType: "chips" as InputType,
    options: [
      { value: "everything",  label: "No restrictions" },
      { value: "vegetarian",  label: "Vegetarian" },
      { value: "vegan",       label: "Vegan" },
      { value: "pescatarian", label: "Pescatarian" },
      { value: "keto",        label: "Keto / Low-carb" },
      { value: "gluten_free", label: "Gluten-free" },
    ],
    required: true,
    domain:   "nutrition",
  },

  nutritionGoal: {
    fieldKey:  "nutritionGoal",
    question:  "What should your nutrition plan help with most?",
    subtext:   "You set a training goal — this makes sure your food strategy matches it. They don't have to be identical.",
    inputType: "cards" as InputType,
    options: [
      { value: "fat_loss",    label: "Lose body fat",           desc: "Caloric deficit with high protein emphasis" },
      { value: "muscle_gain", label: "Build muscle",            desc: "Caloric surplus, maximise muscle growth" },
      { value: "maintenance", label: "Maintain current weight", desc: "Optimise quality and performance at maintenance" },
      { value: "performance", label: "Fuel performance",        desc: "Maximise energy, output, and recovery" },
    ],
    required: true,
    domain:   "nutrition",
  },

  mealPrepLevel: {
    fieldKey:  "mealPrepLevel",
    question:  "How hands-on do you want to be with food prep?",
    subtext:   "We'll suggest meals and strategies that match your actual capacity.",
    inputType: "cards" as InputType,
    options: [
      { value: "minimal",   label: "Minimal",   desc: "Simple meals, 20 minutes or less" },
      { value: "moderate",  label: "Some prep", desc: "A bit of weekend batch cooking" },
      { value: "full_prep", label: "Full prep", desc: "Plan ahead and cook in bulk" },
    ],
    required: true,
    domain:   "nutrition",
  },

  // ── Food allergies (BIG 9) ────────────────────────────────────────────────

  foodAllergies: {
    fieldKey:  "foodAllergies",
    question:  "Select any allergens that apply.",
    subtext:   "Selecting 'None' means no restrictions. We'll flag and avoid anything you mark.",
    inputType: "chips" as InputType,
    options: [
      { value: "none",      label: "None" },
      { value: "peanuts",   label: "Peanuts" },
      { value: "tree_nuts", label: "Tree nuts" },
      { value: "dairy",     label: "Dairy" },
      { value: "eggs",      label: "Eggs" },
      { value: "wheat",     label: "Wheat" },
      { value: "soy",       label: "Soy" },
      { value: "fish",      label: "Fish" },
      { value: "shellfish", label: "Shellfish" },
      { value: "sesame",    label: "Sesame" },
    ],
    required: false,
    domain:   "nutrition",
  },

  allergyNotes: {
    fieldKey:  "allergyNotes",
    question:  "Anything else? (optional)",
    subtext:   "Other intolerances, sensitivities, or specific foods to avoid.",
    inputType: "text" as InputType,
    required:  false,
    domain:    "nutrition",
  },

  // ── Recovery ──────────────────────────────────────────────────────────────

  sleepQuality: {
    fieldKey:  "sleepQuality",
    question:  "How well are you sleeping right now?",
    subtext:   "Sleep quality is the single biggest driver of recovery and adaptation.",
    inputType: "cards" as InputType,
    options: [
      { value: "poor",  label: "Poor",  desc: "Under 6 hours, or frequently disrupted" },
      { value: "fair",  label: "Fair",  desc: "6–7 hours, inconsistent quality" },
      { value: "good",  label: "Good",  desc: "7–8 hours, mostly solid" },
      { value: "great", label: "Great", desc: "8+ hours — wake up ready to go" },
    ],
    required: true,
    domain:   "recovery",
  },

  stressLevel: {
    fieldKey:  "stressLevel",
    question:  "How stressed are you on most days?",
    subtext:   "High stress limits recovery. We factor this into your training load.",
    inputType: "chips" as InputType,
    options: [
      { value: "low",       label: "Low" },
      { value: "moderate",  label: "Moderate" },
      { value: "high",      label: "High" },
      { value: "very_high", label: "Very high" },
    ],
    required: true,
    domain:   "recovery",
  },

  energyBaseline: {
    fieldKey:  "energyBaseline",
    question:  "How is your energy on a typical day?",
    subtext:   "This shapes workout timing and intensity across your week.",
    inputType: "chips" as InputType,
    options: [
      { value: "low",      label: "Low — running on empty" },
      { value: "moderate", label: "Up and down" },
      { value: "high",     label: "Solid to high" },
    ],
    required: true,
    domain:   "recovery",
  },

  // ── Sleep ─────────────────────────────────────────────────────────────────

  wakeTime: {
    fieldKey:  "wakeTime",
    question:  "What time do you usually wake up?",
    subtext:   "Your day starts here — every task and habit gets planned around this time.",
    inputType: "time" as InputType,
    required:  true,
    domain:    "sleep",
  },

  sleepTime: {
    fieldKey:  "sleepTime",
    question:  "What time do you usually go to bed?",
    subtext:   "Wind-down tasks and recovery protocol get scheduled before this.",
    inputType: "time" as InputType,
    required:  true,
    domain:    "sleep",
  },

  // ── Schedule ──────────────────────────────────────────────────────────────

  preferredWorkoutTime: {
    fieldKey:  "preferredWorkoutTime",
    question:  "When is training usually easiest to fit into your day?",
    subtext:   "We'll schedule your workout when your energy and schedule align.",
    inputType: "chips" as InputType,
    options: [
      { value: "early_morning", label: "Before 7 AM" },
      { value: "morning",       label: "7–10 AM" },
      { value: "afternoon",     label: "12–5 PM" },
      { value: "evening",       label: "5–8 PM" },
      { value: "night",         label: "After 8 PM" },
    ],
    required: false,
    domain:   "schedule",
  },

  scheduleConsistency: {
    fieldKey:  "scheduleConsistency",
    question:  "How predictable is your week?",
    subtext:   "Predictable weeks get fixed programs. Variable ones get adaptive ones.",
    inputType: "cards" as InputType,
    options: [
      { value: "very_consistent",     label: "Mostly consistent",    desc: "Schedule rarely changes week to week" },
      { value: "somewhat_consistent", label: "Changes week to week", desc: "Some days are predictable, some aren't" },
      { value: "inconsistent",        label: "Varies a lot",         desc: "No two weeks look the same" },
    ],
    required: false,
    domain:   "schedule",
  },

} satisfies Record<string, OnboardingQuestion>;
