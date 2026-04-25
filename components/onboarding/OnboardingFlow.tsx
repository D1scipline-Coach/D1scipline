/**
 * components/onboarding/OnboardingFlow.tsx
 *
 * Full 7-step onboarding flow — self-contained, independent of app/index.tsx.
 * Manages all field state internally; calls onComplete(profile) on finish.
 *
 * Steps:
 *   1 — Identity & Body
 *   2 — Training Setup
 *   3 — Training Style
 *   4 — Goals
 *   5 — Nutrition
 *   6 — Recovery & Baseline
 *   7 — Schedule
 *
 * Architecture notes:
 *   • Option arrays and Screen are module-level to prevent re-creation on render.
 *   • Screen is NOT a closure — it takes `step` as a prop so React can reconcile
 *     it stably across state changes (prevents TextInput focus loss on keystroke).
 */

import { LinearGradient } from "expo-linear-gradient";
import React, { useEffect, useRef, useState } from "react";
import { Q, STEP_CONFIG, type QuestionCondition } from "./onboardingQuestions";
import {
  type AiraUserProfile,
  computeProfileMeta,
  type Gender,
  type GymAccess,
  type TrainingStyle,
  type ExperienceLevel,
  type SessionDuration,
  type GoalKind,
  type GoalUrgency,
  type DietaryStyle,
  type NutritionGoalKind,
  type MealPrepLevel,
  type SleepQuality,
  type StressLevel,
  type EnergyLevel,
  type PreferredWorkoutTime,
  type ScheduleConsistency,
} from "../../shared/types/profile";
import {
  Animated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { buildPlanPreview, type PlanPreview } from "../../shared/planner/previewPlan";

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens
// ─────────────────────────────────────────────────────────────────────────────

const ACCENT      = "#6C63FF";
const ACCENT_GLOW = "#7B6BFF";
const TOTAL       = 8;

// Progress bar fill width — full screen width minus horizontal padding (24 each side)
const BAR_TOTAL_WIDTH = Dimensions.get("window").width - 48;

// Deterministic per-step message shown below the progress bar.
// Communicates what Aira is "thinking about" as the user progresses.
const STEP_MESSAGES: Record<number, string> = {
  1: "Building your performance profile…",
  2: "Structuring your training program…",
  3: "Optimizing your training style…",
  4: "Calibrating your goals…",
  5: "Designing your nutrition plan…",
  6: "Checking for dietary restrictions…",
  7: "Analyzing your recovery patterns…",
  8: "Finalizing your daily structure…",
};

// ─────────────────────────────────────────────────────────────────────────────
// Mapping constants — mirrors index.tsx derivation logic
// ─────────────────────────────────────────────────────────────────────────────

const GOAL_TYPE_LABELS: Record<string, string> = {
  lose_fat:            "Lose fat and get lean",
  build_muscle:        "Build muscle and size",
  get_stronger:        "Get stronger and more powerful",
  improve_athleticism: "Improve athleticism and performance",
  stay_consistent:     "Build discipline and stay consistent",
};

const TRAINING_STYLE_TO_TARGET: Record<string, string> = {
  athlete:         "athletic_strong",
  muscle:          "model_build",
  strength:        "athletic_strong",
  fat_loss:        "shredded",
  general_fitness: "lean_defined",
  calisthenics:    "lean_defined",
};

const GOAL_TYPE_TO_BFD: Record<string, string> = {
  lose_fat:            "lose_fat",
  build_muscle:        "build_lean",
  get_stronger:        "maintain",
  improve_athleticism: "maintain",
  stay_consistent:     "maintain",
};

const GYM_ACCESS_TO_EQUIPMENT: Record<string, string> = {
  full_gym:          "full_gym",
  limited_equipment: "minimal",
  bodyweight_only:   "none",
};

function daysToFrequency(d: number): string {
  if (d <= 2) return "2x";
  if (d === 3) return "3x";
  if (d === 4) return "4x";
  return "5x";
}

const EXP_TO_DURATION: Record<string, string> = {
  beginner:     "30min",
  intermediate: "45min",
  advanced:     "60min",
};

// ─────────────────────────────────────────────────────────────────────────────
// Config-driven helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns false when a question's condition is not satisfied, hiding the
 * question from the UI. `state` is a flat snapshot of current selections.
 * Add entries to `state` for any new condition fields.
 */
function isVisible(
  condition: QuestionCondition | undefined,
  state: Record<string, string | number | null>,
): boolean {
  if (!condition) return true;
  if ("notEquals" in condition) return state[condition.field] !== condition.notEquals;
  return state[condition.field] === condition.equals;
}

/**
 * Returns goal-aware subtext when the user's primaryGoal matches a key in
 * `subtextByGoal`, otherwise falls back to the question's base subtext.
 */
function getSubtext(
  q: { subtext: string; subtextByGoal?: Record<string, string> },
  goalType: string,
): string {
  return q.subtextByGoal?.[goalType] ?? q.subtext;
}

// AiraUserProfile is the canonical nested type — re-exported for callers
// that import from this module.
export type { AiraUserProfile };

type Props = {
  onComplete: (profile: AiraUserProfile) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Question config and step config are imported from onboardingQuestions.ts.
// All option arrays, question wording, subtexts, and step titles live there.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Smooth animated progress bar.
 * progressAnim is a 0–1 Animated.Value; it is interpolated to a pixel fill width.
 * useNativeDriver:false is required because `width` is a layout prop.
 */
function ProgressBar({
  progressAnim,
  stepMessage,
}: {
  progressAnim: Animated.Value;
  stepMessage:  string;
}) {
  const fillWidth = progressAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: [0, BAR_TOTAL_WIDTH],
    extrapolate: "clamp",
  });
  return (
    <View style={pb.wrap}>
      <View style={pb.track}>
        <Animated.View style={[pb.fill, { width: fillWidth }]}>
          <LinearGradient
            colors={[ACCENT_GLOW, "#a855f7"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFillObject}
          />
        </Animated.View>
      </View>
      <Text style={pb.message}>{stepMessage}</Text>
    </View>
  );
}

function StepHeader({
  step,
  title,
  subtitle,
  progressLabel,
}: {
  step:           number;
  title:          string;
  subtitle:       string;
  progressLabel?: string;
}) {
  return (
    <View style={hdr.wrap}>
      {progressLabel ? <Text style={hdr.progressLabel}>{progressLabel}</Text> : null}
      <Text style={hdr.counter}>Step {step} of {TOTAL}</Text>
      <Text style={hdr.title}>{title}</Text>
      <Text style={hdr.subtitle}>{subtitle}</Text>
    </View>
  );
}

function SectionLabel({ children, optional }: { children: string; optional?: boolean }) {
  return (
    <Text style={sec.label}>
      {children}
      {optional ? <Text style={sec.opt}> — optional</Text> : null}
    </Text>
  );
}

/** Renders the explanatory subtext beneath a section label — may be goal-aware. */
function SectionSubtext({ children }: { children: string }) {
  return <Text style={sub.text}>{children}</Text>;
}

function OptionCard({
  label,
  desc,
  selected,
  onSelect,
}: {
  label: string;
  desc?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Pressable onPress={onSelect} style={[oc.card, selected && oc.selected]}>
      <View style={oc.row}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[oc.label, selected && oc.labelSel]}>{label}</Text>
          {desc ? <Text style={[oc.desc, selected && oc.descSel]}>{desc}</Text> : null}
        </View>
        <View style={[oc.indicator, selected && oc.indicatorSel]}>
          {selected ? <View style={oc.indicatorDot} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

function ChipGrid({
  options,
  value,
  onSelect,
}: {
  options: { value: string; label: string }[];
  value: string;
  onSelect: (v: string) => void;
}) {
  return (
    <View style={cg.wrap}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onSelect(o.value)}
          style={[cg.chip, value === o.value && cg.chipActive]}
        >
          <Text style={[cg.text, value === o.value && cg.textActive]}>
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function NumberGrid({
  options,
  value,
  onSelect,
}: {
  options: number[];
  value: number | null;
  onSelect: (v: number) => void;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 8, marginBottom: 20 }}>
      {options.map((n) => (
        <Pressable
          key={n}
          onPress={() => onSelect(n)}
          style={[ng.cell, value === n && ng.cellActive]}
        >
          <Text style={[ng.text, value === n && ng.textActive]}>{n}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Multi-select chip grid — used for BIG 9 allergen selection.
 * `values` is the current selection set. `onToggle` is called with the tapped value;
 * the parent handles "None" mutual-exclusion logic.
 * Styling intentionally matches ChipGrid for visual consistency.
 */
function MultiChipGrid({
  options,
  values,
  onToggle,
}: {
  options:  { value: string; label: string }[];
  values:   string[];
  onToggle: (v: string) => void;
}) {
  return (
    <View style={cg.wrap}>
      {options.map((o) => {
        const active = values.includes(o.value);
        return (
          <Pressable
            key={o.value}
            onPress={() => onToggle(o.value)}
            style={[cg.chip, active && cg.chipActive]}
          >
            <Text style={[cg.text, active && cg.textActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function OInput(props: React.ComponentProps<typeof TextInput> & { mb?: number }) {
  const { mb = 16, style, ...rest } = props;
  return (
    <TextInput
      {...rest}
      placeholderTextColor="#454560"
      style={[inp.field, { marginBottom: mb }, style]}
    />
  );
}

function NextButton({
  title,
  onPress,
  disabled,
  gradient,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  gradient?: boolean;
}) {
  const isGradient = gradient && !disabled;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[btn.wrap, disabled ? btn.wrapDisabled : !isGradient ? btn.wrapEnabled : undefined]}
    >
      {isGradient && (
        <LinearGradient
          colors={[ACCENT_GLOW, "#4a3fc4"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFillObject}
        />
      )}
      <Text style={[btn.text, disabled && btn.textDisabled]}>{title}</Text>
    </Pressable>
  );
}

function BackLink({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={back.wrap}>
      <Text style={back.text}>← Back</Text>
    </Pressable>
  );
}

/**
 * Inline micro-confirmation that fades in after a key input.
 * opacity uses useNativeDriver:true — safe because it is the only animated prop here.
 * Renders nothing when text is empty so it takes no layout space.
 */
function FeedbackNote({
  text,
  anim,
}: {
  text: string;
  anim: Animated.Value;
}) {
  if (!text) return null;
  return (
    <Animated.Text style={[fb.note, { opacity: anim }]}>
      {text}
    </Animated.Text>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Completion screen helpers — pure, module-level, no side effects.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One-sentence summary shown beneath the completion headline.
 * High-confidence profiles get a goal-specific line.
 * Medium/low profiles get a generic calibration message.
 */
function buildCompletionSubtext(profile: AiraUserProfile): string {
  const score = profile.meta.dataConfidenceScore;
  const goal  = profile.goals.primaryGoal;
  if (score >= 80) {
    const lines: Record<string, string> = {
      build_muscle:        "Highly personalized for muscle growth and strength gains.",
      lose_fat:            "Calibrated for fat loss while protecting lean muscle.",
      get_stronger:        "Engineered for strength development and peak output.",
      improve_athleticism: "Optimized for athletic performance and movement quality.",
      stay_consistent:     "Structured for consistency and lasting habit formation.",
    };
    return lines[goal] ?? "Built around your goals, recovery, and daily schedule.";
  }
  if (score >= 50) {
    return "Solid starting point — your plan sharpens as Aira learns more about you.";
  }
  return "Conservative baseline set — it refines as you fill in more details.";
}

// ─────────────────────────────────────────────────────────────────────────────
// Completion screen
//
// Replaces the step flow after handleFinish builds the result profile.
// Manages its own entrance animation sequence — 4 sections staggered 180 ms apart.
// All animated props are opacity + translateY — useNativeDriver:true throughout.
// Calls onContinue (→ onComplete) only when the user taps "Start My Day".
// ─────────────────────────────────────────────────────────────────────────────

function CompletionScreen({
  profile,
  preview,
  onContinue,
}: {
  profile:    AiraUserProfile;
  preview:    PlanPreview;
  onContinue: () => void;
}) {
  const titleAnim      = useRef(new Animated.Value(0)).current;
  const snapshotAnim   = useRef(new Animated.Value(0)).current;
  const confidenceAnim = useRef(new Animated.Value(0)).current;
  const buttonAnim     = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.stagger(180, [
      Animated.spring(titleAnim,      { toValue: 1, useNativeDriver: true, tension: 55, friction: 7 }),
      Animated.spring(snapshotAnim,   { toValue: 1, useNativeDriver: true, tension: 55, friction: 7 }),
      Animated.spring(confidenceAnim, { toValue: 1, useNativeDriver: true, tension: 55, friction: 7 }),
      Animated.spring(buttonAnim,     { toValue: 1, useNativeDriver: true, tension: 55, friction: 7 }),
    ]).start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const confScore = profile.meta.dataConfidenceScore;
  const confLabel = confScore >= 80 ? "HIGH" : confScore >= 50 ? "GOOD" : "BUILDING";
  const confNote  =
    confScore >= 80 ? "Highly personalized to you" :
    confScore >= 50 ? "Solid starting point" :
                      "We'll refine this as we learn more";

  const subtext = buildCompletionSubtext(profile);

  // Shared rise-up interpolation for each animated section
  const riseUp = (anim: Animated.Value) =>
    anim.interpolate({ inputRange: [0, 1], outputRange: [18, 0] });

  return (
    <SafeAreaView style={cs.screen}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        contentContainerStyle={cs.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Headline */}
        <Animated.View style={[cs.titleBlock, { opacity: titleAnim, transform: [{ translateY: riseUp(titleAnim) }] }]}>
          <Text style={cs.superLabel}>AIRA</Text>
          <Text style={cs.headline}>Your plan{"\n"}is ready.</Text>
          <Text style={cs.subtext}>{subtext}</Text>
        </Animated.View>

        {/* Plan snapshot */}
        <Animated.View style={[cs.snapshotCard, { opacity: snapshotAnim, transform: [{ translateY: riseUp(snapshotAnim) }] }]}>
          <LinearGradient
            colors={["rgba(108,99,255,0.07)", "rgba(50,35,120,0.13)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFillObject}
          />
          <Text style={cs.snapshotHeading}>TODAY&apos;S PLAN</Text>
          <View style={cs.snapshotDivider} />

          <View style={cs.snapshotRow}>
            <View style={cs.snapshotField}>
              <Text style={cs.snapshotLabel}>FOCUS</Text>
              <Text style={cs.snapshotValue}>{preview.focus}</Text>
            </View>
          </View>

          <View style={[cs.snapshotRow, { marginTop: 12 }]}>
            <View style={cs.snapshotField}>
              <Text style={cs.snapshotLabel}>WORKOUT</Text>
              <Text style={cs.snapshotValue}>{preview.workoutLabel}</Text>
            </View>
            {preview.calorieTarget !== null && (
              <View style={cs.snapshotField}>
                <Text style={cs.snapshotLabel}>DAILY CALORIES</Text>
                <Text style={cs.snapshotValue}>~{preview.calorieTarget.toLocaleString()} kcal</Text>
              </View>
            )}
          </View>
        </Animated.View>

        {/* Confidence */}
        <Animated.View style={[cs.confCard, { opacity: confidenceAnim, transform: [{ translateY: riseUp(confidenceAnim) }] }]}>
          <View style={cs.confRow}>
            <Text style={cs.confTitle}>PLAN CONFIDENCE</Text>
            <View style={cs.confBadge}>
              <Text style={cs.confBadgeText}>{confLabel}</Text>
            </View>
          </View>
          <Text style={cs.confNote}>{confNote}</Text>
        </Animated.View>

        {/* CTA */}
        <Animated.View style={[cs.ctaWrap, { opacity: buttonAnim, transform: [{ translateY: riseUp(buttonAnim) }] }]}>
          <Pressable onPress={onContinue} style={cs.ctaBtn}>
            <LinearGradient
              colors={[ACCENT_GLOW, "#4a3fc4"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFillObject}
            />
            <Text style={cs.ctaText}>Start My Day →</Text>
          </Pressable>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Live plan preview card
//
// Renders focus label, workout type, and calorie target derived from whatever
// onboarding fields have been filled so far. Shown on steps 4–7.
//
// Module-level for the same reason as Screen — stable identity across re-renders.
// anim drives opacity only (useNativeDriver:true — native safe).
// ─────────────────────────────────────────────────────────────────────────────

function PlanPreviewCard({
  preview,
  anim,
}: {
  preview: PlanPreview;
  anim:    Animated.Value;
}) {
  return (
    <Animated.View style={[pv.card, { opacity: anim }]}>
      <LinearGradient
        colors={["rgba(108,99,255,0.05)", "rgba(50,35,120,0.10)"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />
      <Text style={pv.label}>YOUR PLAN PREVIEW</Text>
      <Text style={pv.focus}>{preview.focus}</Text>
      <View style={pv.divider} />
      <View style={pv.row}>
        <View style={pv.field}>
          <Text style={pv.fieldLabel}>WORKOUT</Text>
          <Text style={pv.fieldValue}>{preview.workoutLabel}</Text>
        </View>
        {preview.calorieTarget !== null && (
          <View style={pv.field}>
            <Text style={pv.fieldLabel}>DAILY CALORIES</Text>
            <Text style={pv.fieldValue}>~{preview.calorieTarget.toLocaleString()} kcal</Text>
          </View>
        )}
      </View>
    </Animated.View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen wrapper — module-level so React reconciles it stably across re-renders.
// Defined OUTSIDE OnboardingFlow to prevent full child remounts on state change.
// If Screen were defined inside the component body, its reference would change
// on every render, causing TextInput focus loss on every keystroke.
// ─────────────────────────────────────────────────────────────────────────────

function Screen({
  progressAnim,
  stepMessage,
  children,
}: {
  progressAnim: Animated.Value;
  stepMessage:  string;
  children:     React.ReactNode;
}) {
  return (
    <SafeAreaView style={s.screen}>
      <StatusBar barStyle="light-content" />
      <ProgressBar progressAnim={progressAnim} stepMessage={stepMessage} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function OnboardingFlow({ onComplete }: Props) {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8>(1);

  // Used by auto-advance on single-select steps (Step 3).
  // Stored in a ref so timeouts can be cleared on unmount.
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => { if (advanceTimer.current) clearTimeout(advanceTimer.current); };
  }, []);

  // ── Identity & Body ──────────────────────────────────────────────────────
  const [name,   setName]   = useState("");
  const [age,    setAge]    = useState("");
  const [gender, setGender] = useState<"male" | "female" | "other" | "">("");
  const [height, setHeight] = useState("");
  const [weight, setWeight] = useState("");

  // ── Training Setup ───────────────────────────────────────────────────────
  const [gymAccess,           setGymAccess]           = useState("");
  const [experienceLevel,     setExperienceLevel]     = useState("");
  const [trainingDaysPerWeek, setTrainingDaysPerWeek] = useState<number | null>(null);
  const [dailyTrainingTime,   setDailyTrainingTime]   = useState("");
  const [injuries,            setInjuries]            = useState("");

  // ── Training Style ───────────────────────────────────────────────────────
  const [primaryTrainingStyle, setPrimaryTrainingStyle] = useState("");

  // ── Goals ────────────────────────────────────────────────────────────────
  const [goalType,    setGoalType]    = useState("");
  const [goalUrgency, setGoalUrgency] = useState("");
  const [goalNotes,   setGoalNotes]   = useState("");

  // ── Nutrition ────────────────────────────────────────────────────────────
  const [dietaryStyle,  setDietaryStyle]  = useState("");
  const [nutritionGoal, setNutritionGoal] = useState("");
  const [mealPrepLevel, setMealPrepLevel] = useState("");

  // ── Recovery ────────────────────────────────────────────────────────────
  const [sleepQuality,   setSleepQuality]   = useState("");
  const [stressLevel,    setStressLevel]    = useState("");
  const [energyBaseline, setEnergyBaseline] = useState("");

  // ── Food allergies ───────────────────────────────────────────────────────
  // foodAllergies: selected allergen values. ["none"] = no restrictions. [] = not yet answered.
  // Filtered to remove "none" pseudo-value before storing on the profile.
  const [foodAllergies, setFoodAllergies] = useState<string[]>([]);
  const [allergyNotes,  setAllergyNotes]  = useState("");

  // ── Schedule ────────────────────────────────────────────────────────────
  const [wake,                 setWake]                 = useState("6:00 AM");
  const [sleep,                setSleep]                = useState("11:00 PM");
  const [preferredWorkoutTime, setPreferredWorkoutTime] = useState("");
  const [scheduleConsistency,  setScheduleConsistency]  = useState("");

  // ── Progress animation ───────────────────────────────────────────────────
  // progressAnim is a 0–1 value; ProgressBar interpolates it to pixel fill width.
  // useNativeDriver:false because it drives a layout `width` prop.
  const progressAnim = useRef(new Animated.Value(1 / TOTAL)).current;

  // ── Micro-feedback ───────────────────────────────────────────────────────
  // One shared text + opacity anim — only one confirmation visible at a time.
  // feedbackAnim uses useNativeDriver:true (opacity only — native-safe).
  const feedbackAnim = useRef(new Animated.Value(0)).current;
  const [feedbackText, setFeedbackText] = React.useState("");

  // ── Live plan preview ─────────────────────────────────────────────────────
  // previewAnim starts at 0; fades to 1 when meaningful data arrives (step 4+).
  // previewShown tracks whether the card has appeared — drives fade-in vs refresh.
  // previewTimer holds the debounce handle — cleared on each re-trigger.
  const [previewPlan, setPreviewPlan]   = React.useState<PlanPreview>(() => buildPlanPreview({}));
  const previewAnim   = useRef(new Animated.Value(0)).current;
  const previewShown  = useRef(false);
  const previewTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Completion screen ────────────────────────────────────────────────────
  // Set by handleFinish once the full result profile is built.
  // While non-null, CompletionScreen renders instead of the step flow.
  // onComplete(result) is deferred until the user taps "Start My Day".
  const [completionData, setCompletionData] = React.useState<AiraUserProfile | null>(null);

  const showFeedback = (text: string) => {
    setFeedbackText(text);
    feedbackAnim.setValue(0);
    Animated.timing(feedbackAnim, {
      toValue:         1,
      duration:        220,
      easing:          Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  };

  // ── Step navigation with progress animation ──────────────────────────────
  const goStep = (s: typeof step) => {
    // Clear feedback when moving between steps
    setFeedbackText("");
    feedbackAnim.setValue(0);
    Animated.timing(progressAnim, {
      toValue:         s / TOTAL,
      duration:        380,
      easing:          Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    setStep(s);
  };

  // ── Debounced plan preview updates ───────────────────────────────────────
  // Fires 150 ms after any key onboarding field changes.
  // Reads all relevant state once inside the timeout — no stale-closure risk.
  // Deps list is exhaustive for the fields that feed buildPlanPreview.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      const next = buildPlanPreview({
        goalType:       goalType             ? goalType             as GoalKind         : undefined,
        trainingStyle:  primaryTrainingStyle ? primaryTrainingStyle as TrainingStyle    : undefined,
        gymAccess:      gymAccess            ? gymAccess            as GymAccess        : undefined,
        daysPerWeek:    trainingDaysPerWeek  ?? undefined,
        sleepQuality:   sleepQuality         ? sleepQuality         as SleepQuality     : undefined,
        stressLevel:    stressLevel          ? stressLevel          as StressLevel      : undefined,
        energyBaseline: energyBaseline       ? energyBaseline       as EnergyLevel      : undefined,
        nutritionGoal:  nutritionGoal        ? nutritionGoal        as NutritionGoalKind : undefined,
        gender:         gender               ? gender               as Gender           : undefined,
      });
      setPreviewPlan(next);
      if (!previewShown.current && next.focus !== "Building your plan…") {
        // First meaningful data — fade in from 0
        previewShown.current = true;
        Animated.timing(previewAnim, {
          toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true,
        }).start();
      } else if (previewShown.current) {
        // Subsequent update — brief dip to signal refresh, then return to 1
        Animated.sequence([
          Animated.timing(previewAnim, { toValue: 0.5, duration: 90,  useNativeDriver: true }),
          Animated.timing(previewAnim, { toValue: 1,   duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        ]).start();
      }
    }, 150);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [goalType, primaryTrainingStyle, gymAccess, trainingDaysPerWeek, sleepQuality, stressLevel, energyBaseline, nutritionGoal, gender]);

  // ── Completion handler ───────────────────────────────────────────────────
  const handleFinish = () => {
    const now = new Date().toISOString();

    // ── Derived values (computed from gate-enforced source fields) ────────
    const derivedEquipment  = (GYM_ACCESS_TO_EQUIPMENT[gymAccess]             ?? "none")        as AiraUserProfile["derived"]["equipment"];
    const derivedBFD        = (GOAL_TYPE_TO_BFD[goalType]                     ?? "maintain")    as AiraUserProfile["derived"]["bodyFatDirection"];
    const derivedTargetGoal =  TRAINING_STYLE_TO_TARGET[primaryTrainingStyle]  ?? "lean_defined";
    const derivedFrequency  = (trainingDaysPerWeek != null ? daysToFrequency(trainingDaysPerWeek) : "3x") as AiraUserProfile["derived"]["workoutFrequency"];
    // sessionDuration: prefer explicit pick, fall back to experience-level default, then "45min"
    const resolvedDuration  = (dailyTrainingTime || EXP_TO_DURATION[experienceLevel] || "45min") as SessionDuration;

    // ── Capture raw optional values before applying smart defaults ────────
    // These are passed to computeProfileMeta so the confidence score honestly
    // reflects what the user actually provided, not what was defaulted.
    const rawUrgency              = goalUrgency        ? goalUrgency        as GoalUrgency         : undefined;
    const rawPreferredWorkoutTime = preferredWorkoutTime ? preferredWorkoutTime as PreferredWorkoutTime : undefined;
    const rawScheduleConsistency  = scheduleConsistency  ? scheduleConsistency  as ScheduleConsistency  : undefined;

    // ── Build sub-objects ─────────────────────────────────────────────────
    // Gate-enforced fields are cast directly — UX gates guarantee non-empty valid values.
    const profileData: AiraUserProfile["profile"] = {
      firstName: name.trim(),
      age:       age    || undefined,
      gender:    gender  ? gender as Gender  : undefined,
      height:    height || undefined,
      weight:    weight || undefined,
    };
    // Smart defaults applied to optional AI-context fields left blank:
    //   goalUrgency     → "steady"               (middle tier — avoids null context in planner)
    //   scheduleConsistency → "somewhat_consistent" (most realistic default)
    // Defaults applied AFTER meta computation below so they don't inflate confidence score.
    const trainingData: AiraUserProfile["training"] = {
      gymAccess:       gymAccess          as GymAccess,         // required — Step 2 gate
      trainingStyle:   primaryTrainingStyle as TrainingStyle,   // required — Step 3 gate
      experience:      experienceLevel    as ExperienceLevel,   // required — Step 2 gate
      daysPerWeek:     trainingDaysPerWeek!,                    // required — Step 2 gate (non-null)
      sessionDuration: resolvedDuration,                        // required — resolved with fallback
      injuries:        injuries.trim() || undefined,
    };
    const nutritionData: AiraUserProfile["nutrition"] = {
      dietaryStyle:  dietaryStyle  as DietaryStyle,        // required — Step 5 gate
      nutritionGoal: nutritionGoal as NutritionGoalKind,   // required — Step 5 gate
      mealPrepLevel: mealPrepLevel as MealPrepLevel,        // required — Step 5 gate
      // "none" is a UI pseudo-value meaning "no restrictions" — strip before storing
      allergies:    foodAllergies.filter(v => v !== "none"),
      allergyNotes: allergyNotes.trim() || undefined,
    };
    const recoveryData: AiraUserProfile["recovery"] = {
      sleepQuality:    sleepQuality    as SleepQuality,    // required — Step 6 gate
      stressLevel:     stressLevel     as StressLevel,     // required — Step 6 gate
      energyBaseline:  energyBaseline  as EnergyLevel,     // required — Step 6 gate
    };
    const sleepData: AiraUserProfile["sleep"] = {
      wakeTime:  wake.trim() || "6:00 AM",
      sleepTime: sleep.trim() || "11:00 PM",
    };

    // ── Compute data confidence (genuinely optional fields only) ──────────
    // Uses raw values — not the defaulted ones — for an honest score.
    const { dataConfidenceScore, optionalFieldsSkipped } = computeProfileMeta({
      profile: profileData,
      goals: {
        primaryGoal: goalType as GoalKind,
        goalLabel:   GOAL_TYPE_LABELS[goalType] ?? goalType,
        urgency:     rawUrgency,
        notes:       goalNotes.trim() || undefined,
      },
      schedule: {
        preferredWorkoutTime: rawPreferredWorkoutTime,
        scheduleConsistency:  rawScheduleConsistency,
      },
    });

    // ── Apply smart defaults (post-meta) ──────────────────────────────────
    const goalsData: AiraUserProfile["goals"] = {
      primaryGoal: goalType as GoalKind,
      goalLabel:   GOAL_TYPE_LABELS[goalType] ?? goalType,
      urgency:     rawUrgency ?? "steady",            // smart default
      notes:       goalNotes.trim() || undefined,
    };
    const scheduleData: AiraUserProfile["schedule"] = {
      preferredWorkoutTime: rawPreferredWorkoutTime,
      scheduleConsistency:  rawScheduleConsistency ?? "somewhat_consistent", // smart default
    };

    const result: AiraUserProfile = {
      profile:   profileData,
      goals:     goalsData,
      training:  trainingData,
      nutrition: nutritionData,
      recovery:  recoveryData,
      sleep:     sleepData,
      schedule:  scheduleData,
      derived: {
        equipment:        derivedEquipment,
        bodyFatDirection: derivedBFD,
        targetGoal:       derivedTargetGoal,
        workoutFrequency: derivedFrequency,
        derivedAt:        now,
      },
      meta: {
        onboardingVersion:     2,
        completedAt:           now,
        lastUpdatedAt:         now,
        dataConfidenceScore,
        optionalFieldsSkipped,
      },
    };

    // Show completion screen before handing off — deferred until "Start My Day" tap.
    setCompletionData(result);
  };

  // ── Completion screen gate ───────────────────────────────────────────────
  // handleFinish sets completionData once the profile is fully built.
  // CompletionScreen manages its own entrance animations and calls onComplete
  // when the user taps "Start My Day", preventing any navigation race.
  if (completionData) {
    return (
      <CompletionScreen
        profile={completionData}
        preview={previewPlan}
        onContinue={() => onComplete(completionData)}
      />
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1 — Identity & Body
  // ─────────────────────────────────────────────────────────────────────────

  if (step === 1) {
    const canAdvance = name.trim().length >= 2 && age.trim() !== "" && gender !== "" && height.trim() !== "" && weight.trim() !== "";
    return (
      <Screen progressAnim={progressAnim} stepMessage={STEP_MESSAGES[step]}>
        {/* Welcome callout — establishes Aira's purpose before data entry begins */}
        <View style={wl.card}>
          <Text style={wl.label}>AIRA</Text>
          <Text style={wl.heading}>Your personal performance coach.</Text>
          <Text style={wl.body}>
            Answer 7 short questions and Aira builds a daily plan around your body, your goals, and your actual life.
          </Text>
        </View>

        <StepHeader
          step={1}
          title={STEP_CONFIG[1].title}
          subtitle={STEP_CONFIG[1].subtitle}
          progressLabel={STEP_CONFIG[1].progressLabel}
        />

        <SectionLabel>{Q.firstName.question}</SectionLabel>
        <SectionSubtext>{Q.firstName.subtext}</SectionSubtext>
        <OInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Nate"
          returnKeyType="next"
          autoCapitalize="words"
        />

        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <SectionLabel>{Q.age.question}</SectionLabel>
            <SectionSubtext>{Q.age.subtext}</SectionSubtext>
            <OInput
              value={age}
              onChangeText={setAge}
              placeholder="Age"
              keyboardType="number-pad"
              returnKeyType="done"
              mb={0}
            />
          </View>
          <View style={{ flex: 1 }}>
            <SectionLabel>{Q.gender.question}</SectionLabel>
            <View style={s.genderRow}>
              {(["male", "female", "other"] as const).map((g) => (
                <Pressable
                  key={g}
                  onPress={() => setGender(g)}
                  style={[s.genderBtn, gender === g && s.genderBtnActive]}
                >
                  <Text style={[s.genderText, gender === g && s.genderTextActive]}>
                    {g === "male" ? "M" : g === "female" ? "F" : "—"}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>

        <View style={{ height: 16 }} />

        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <SectionLabel>{Q.height.question}</SectionLabel>
            <SectionSubtext>{Q.height.subtext}</SectionSubtext>
            <OInput value={height} onChangeText={setHeight} placeholder={`6'1" / 185cm`} mb={0} />
          </View>
          <View style={{ flex: 1 }}>
            <SectionLabel>{Q.weight.question}</SectionLabel>
            <SectionSubtext>{Q.weight.subtext}</SectionSubtext>
            <OInput value={weight} onChangeText={setWeight} placeholder="Weight (lbs or kg)" mb={0} />
          </View>
        </View>

        <View style={{ height: 28 }} />
        <NextButton title="Continue" disabled={!canAdvance} onPress={() => goStep(2)} />
        <Text style={s.footnote}>We&apos;ll ask for notification permission after setup.</Text>
      </Screen>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2 — Training Setup
  // ─────────────────────────────────────────────────────────────────────────

  if (step === 2) {
    const canAdvance = gymAccess !== "" && experienceLevel !== "" && trainingDaysPerWeek !== null;
    return (
      <Screen progressAnim={progressAnim} stepMessage={STEP_MESSAGES[step]}>
        <StepHeader
          step={2}
          title={STEP_CONFIG[2].title}
          subtitle={STEP_CONFIG[2].subtitle}
          progressLabel={STEP_CONFIG[2].progressLabel}
        />

        <SectionLabel>{Q.gymAccess.question}</SectionLabel>
        <SectionSubtext>{getSubtext(Q.gymAccess, goalType)}</SectionSubtext>
        <View style={{ gap: 8, marginBottom: 20 }}>
          {Q.gymAccess.options!.map((o) => (
            <OptionCard
              key={o.value}
              label={o.label}
              desc={o.desc}
              selected={gymAccess === o.value}
              onSelect={() => setGymAccess(o.value)}
            />
          ))}
        </View>

        <SectionLabel>{Q.experienceLevel.question}</SectionLabel>
        <SectionSubtext>{Q.experienceLevel.subtext}</SectionSubtext>
        <View style={{ gap: 8, marginBottom: 20 }}>
          {Q.experienceLevel.options!.map((o) => (
            <OptionCard
              key={o.value}
              label={o.label}
              desc={o.desc}
              selected={experienceLevel === o.value}
              onSelect={() => setExperienceLevel(o.value)}
            />
          ))}
        </View>

        <SectionLabel>{Q.trainingDaysPerWeek.question}</SectionLabel>
        <SectionSubtext>{getSubtext(Q.trainingDaysPerWeek, goalType)}</SectionSubtext>
        <NumberGrid
          options={Q.trainingDaysPerWeek.numberOptions!}
          value={trainingDaysPerWeek}
          onSelect={(v) => { setTrainingDaysPerWeek(v); showFeedback("Structuring your weekly training split"); }}
        />
        <FeedbackNote text={feedbackText} anim={feedbackAnim} />

        <SectionLabel optional>{Q.sessionDuration.question}</SectionLabel>
        <SectionSubtext>{getSubtext(Q.sessionDuration, goalType)}</SectionSubtext>
        <ChipGrid options={Q.sessionDuration.options!} value={dailyTrainingTime} onSelect={setDailyTrainingTime} />

        <SectionLabel optional>{Q.injuries.question}</SectionLabel>
        <SectionSubtext>{Q.injuries.subtext}</SectionSubtext>
        <OInput
          value={injuries}
          onChangeText={setInjuries}
          placeholder={gymAccess === "limited_equipment"
            ? "e.g. dumbbells, pull-up bar — and any limitations…"
            : "e.g. lower back sensitivity, left knee…"}
          multiline
          style={{ minHeight: 64, textAlignVertical: "top" }}
          mb={28}
        />

        <NextButton title="Continue" disabled={!canAdvance} onPress={() => goStep(3)} />
        <BackLink onPress={() => goStep(1)} />
      </Screen>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3 — Training Style
  // ─────────────────────────────────────────────────────────────────────────

  if (step === 3) {
    return (
      <Screen progressAnim={progressAnim} stepMessage={STEP_MESSAGES[step]}>
        <StepHeader
          step={3}
          title={STEP_CONFIG[3].title}
          subtitle={STEP_CONFIG[3].subtitle}
          progressLabel={STEP_CONFIG[3].progressLabel}
        />

        <SectionLabel>{Q.trainingStyle.question}</SectionLabel>
        <SectionSubtext>{Q.trainingStyle.subtext}</SectionSubtext>
        <View style={{ gap: 8, marginBottom: 28 }}>
          {Q.trainingStyle.options!.map((o) => (
            <OptionCard
              key={o.value}
              label={o.label}
              desc={o.desc}
              selected={primaryTrainingStyle === o.value}
              onSelect={() => {
                setPrimaryTrainingStyle(o.value);
                // Auto-advance: single-select step — brief visual confirmation then proceed.
                if (advanceTimer.current) clearTimeout(advanceTimer.current);
                advanceTimer.current = setTimeout(() => goStep(4), 300);
              }}
            />
          ))}
        </View>

        <NextButton title="Continue" disabled={primaryTrainingStyle === ""} onPress={() => goStep(4)} />
        <BackLink onPress={() => goStep(2)} />
      </Screen>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4 — Goals
  // ─────────────────────────────────────────────────────────────────────────

  if (step === 4) {
    return (
      <Screen progressAnim={progressAnim} stepMessage={STEP_MESSAGES[step]}>
        <StepHeader
          step={4}
          title={STEP_CONFIG[4].title}
          subtitle={STEP_CONFIG[4].subtitle}
          progressLabel={STEP_CONFIG[4].progressLabel}
        />

        <SectionLabel>{Q.primaryGoal.question}</SectionLabel>
        <SectionSubtext>{Q.primaryGoal.subtext}</SectionSubtext>
        <View style={{ gap: 8, marginBottom: 20 }}>
          {Q.primaryGoal.options!.map((o) => (
            <OptionCard
              key={o.value}
              label={o.label}
              desc={o.desc}
              selected={goalType === o.value}
              onSelect={() => {
                setGoalType(o.value);
                showFeedback(`Got it — optimizing for ${GOAL_TYPE_LABELS[o.value] ?? o.label}`);
              }}
            />
          ))}
        </View>
        <FeedbackNote text={feedbackText} anim={feedbackAnim} />

        {/* Conditional: hidden for stay_consistent — urgency framing doesn't apply to habit-building */}
        {isVisible(Q.goalUrgency.condition, { primaryGoal: goalType }) && (
          <>
            <SectionLabel optional>{Q.goalUrgency.question}</SectionLabel>
            <SectionSubtext>{Q.goalUrgency.subtext}</SectionSubtext>
            <View style={{ gap: 8, marginBottom: 20 }}>
              {Q.goalUrgency.options!.map((o) => (
                <OptionCard
                  key={o.value}
                  label={o.label}
                  desc={o.desc}
                  selected={goalUrgency === o.value}
                  onSelect={() => setGoalUrgency(o.value)}
                />
              ))}
            </View>
          </>
        )}

        <SectionLabel optional>{Q.goalNotes.question}</SectionLabel>
        <SectionSubtext>{getSubtext(Q.goalNotes, goalType)}</SectionSubtext>
        <OInput
          value={goalNotes}
          onChangeText={setGoalNotes}
          placeholder="e.g. wedding in 4 months, first powerlifting meet…"
          multiline
          style={{ minHeight: 64, textAlignVertical: "top" }}
          mb={28}
        />

        <PlanPreviewCard preview={previewPlan} anim={previewAnim} />
        <NextButton title="Continue" disabled={goalType === ""} onPress={() => goStep(5)} />
        <BackLink onPress={() => goStep(3)} />
      </Screen>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 5 — Nutrition
  // Subtitle is goal-aware: uses subtitleByGoal lookup from STEP_CONFIG.
  // ─────────────────────────────────────────────────────────────────────────

  if (step === 5) {
    const canAdvance = dietaryStyle !== "" && nutritionGoal !== "" && mealPrepLevel !== "";
    const nutritionSubtitle =
      (STEP_CONFIG[5].subtitleByGoal?.[goalType]) ?? STEP_CONFIG[5].subtitle;
    return (
      <Screen progressAnim={progressAnim} stepMessage={STEP_MESSAGES[step]}>
        <StepHeader
          step={5}
          title={STEP_CONFIG[5].title}
          subtitle={nutritionSubtitle}
          progressLabel={STEP_CONFIG[5].progressLabel}
        />

        <SectionLabel>{Q.dietaryStyle.question}</SectionLabel>
        <SectionSubtext>{Q.dietaryStyle.subtext}</SectionSubtext>
        <ChipGrid options={Q.dietaryStyle.options!} value={dietaryStyle} onSelect={setDietaryStyle} />

        <SectionLabel>{Q.nutritionGoal.question}</SectionLabel>
        <SectionSubtext>{Q.nutritionGoal.subtext}</SectionSubtext>
        <View style={{ gap: 8, marginBottom: 20 }}>
          {Q.nutritionGoal.options!.map((o) => (
            <OptionCard
              key={o.value}
              label={o.label}
              desc={o.desc}
              selected={nutritionGoal === o.value}
              onSelect={() => setNutritionGoal(o.value)}
            />
          ))}
        </View>

        <SectionLabel>{Q.mealPrepLevel.question}</SectionLabel>
        <SectionSubtext>{Q.mealPrepLevel.subtext}</SectionSubtext>
        <View style={{ gap: 8, marginBottom: 28 }}>
          {Q.mealPrepLevel.options!.map((o) => (
            <OptionCard
              key={o.value}
              label={o.label}
              desc={o.desc}
              selected={mealPrepLevel === o.value}
              onSelect={() => setMealPrepLevel(o.value)}
            />
          ))}
        </View>

        <PlanPreviewCard preview={previewPlan} anim={previewAnim} />
        <NextButton title="Continue" disabled={!canAdvance} onPress={() => goStep(6)} />
        <BackLink onPress={() => goStep(4)} />
      </Screen>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 6 — Food Allergies (BIG 9)
  // ─────────────────────────────────────────────────────────────────────────

  if (step === 6) {
    // Toggle handler — "none" and allergens are mutually exclusive
    const handleAllergyToggle = (v: string) => {
      setFoodAllergies((prev) => {
        if (v === "none") {
          // "None" clears all other selections and sets itself
          return prev.includes("none") ? [] : ["none"];
        }
        // Any allergen deselects "none"
        const withoutNone = prev.filter(x => x !== "none");
        return withoutNone.includes(v)
          ? withoutNone.filter(x => x !== v)     // deselect
          : [...withoutNone, v];                   // select
      });
      const isNone = v === "none";
      showFeedback(isNone ? "Perfect — no restrictions" : "Got it — we'll avoid these in your plan");
    };

    return (
      <Screen progressAnim={progressAnim} stepMessage={STEP_MESSAGES[step]}>
        <StepHeader
          step={6}
          title={STEP_CONFIG[6].title}
          subtitle={STEP_CONFIG[6].subtitle}
          progressLabel={STEP_CONFIG[6].progressLabel}
        />

        <SectionLabel optional>{Q.foodAllergies.question}</SectionLabel>
        <SectionSubtext>{Q.foodAllergies.subtext}</SectionSubtext>
        <MultiChipGrid
          options={Q.foodAllergies.options!}
          values={foodAllergies}
          onToggle={handleAllergyToggle}
        />
        <FeedbackNote text={feedbackText} anim={feedbackAnim} />

        <SectionLabel optional>{Q.allergyNotes.question}</SectionLabel>
        <SectionSubtext>{Q.allergyNotes.subtext}</SectionSubtext>
        <OInput
          value={allergyNotes}
          onChangeText={setAllergyNotes}
          placeholder="e.g. lactose intolerant, avoid shellfish…"
          multiline
          style={{ minHeight: 56, textAlignVertical: "top" }}
          mb={28}
        />

        <NextButton title="Continue" onPress={() => goStep(7)} />
        <BackLink onPress={() => goStep(5)} />
      </Screen>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 7 — Recovery & Baseline
  // ─────────────────────────────────────────────────────────────────────────

  if (step === 7) {
    const canAdvance = sleepQuality !== "" && stressLevel !== "" && energyBaseline !== "";
    return (
      <Screen progressAnim={progressAnim} stepMessage={STEP_MESSAGES[step]}>
        <StepHeader
          step={7}
          title={STEP_CONFIG[7].title}
          subtitle={STEP_CONFIG[7].subtitle}
          progressLabel={STEP_CONFIG[7].progressLabel}
        />

        <SectionLabel>{Q.sleepQuality.question}</SectionLabel>
        <SectionSubtext>{Q.sleepQuality.subtext}</SectionSubtext>
        <View style={{ gap: 8, marginBottom: 20 }}>
          {Q.sleepQuality.options!.map((o) => (
            <OptionCard
              key={o.value}
              label={o.label}
              desc={o.desc}
              selected={sleepQuality === o.value}
              onSelect={() => {
                setSleepQuality(o.value);
                showFeedback("Recovery baseline captured");
              }}
            />
          ))}
        </View>
        <FeedbackNote text={feedbackText} anim={feedbackAnim} />

        <SectionLabel>{Q.stressLevel.question}</SectionLabel>
        <SectionSubtext>{Q.stressLevel.subtext}</SectionSubtext>
        <ChipGrid options={Q.stressLevel.options!} value={stressLevel} onSelect={setStressLevel} />

        <SectionLabel>{Q.energyBaseline.question}</SectionLabel>
        <SectionSubtext>{Q.energyBaseline.subtext}</SectionSubtext>
        <ChipGrid options={Q.energyBaseline.options!} value={energyBaseline} onSelect={setEnergyBaseline} />

        <View style={{ height: 8 }} />
        <PlanPreviewCard preview={previewPlan} anim={previewAnim} />
        <NextButton title="Continue" disabled={!canAdvance} onPress={() => goStep(8)} />
        <BackLink onPress={() => goStep(6)} />
      </Screen>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 8 — Schedule
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <Screen progressAnim={progressAnim} stepMessage={STEP_MESSAGES[step]}>
      <StepHeader
        step={8}
        title={STEP_CONFIG[8].title}
        subtitle={STEP_CONFIG[8].subtitle}
        progressLabel={STEP_CONFIG[8].progressLabel}
      />

      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <SectionLabel>{Q.wakeTime.question}</SectionLabel>
          <SectionSubtext>{Q.wakeTime.subtext}</SectionSubtext>
          <OInput
            value={wake}
            onChangeText={setWake}
            placeholder="6:00 AM"
            autoCorrect={false}
            autoCapitalize="characters"
            mb={0}
          />
        </View>
        <View style={{ flex: 1 }}>
          <SectionLabel>{Q.sleepTime.question}</SectionLabel>
          <SectionSubtext>{Q.sleepTime.subtext}</SectionSubtext>
          <OInput
            value={sleep}
            onChangeText={setSleep}
            placeholder="11:00 PM"
            autoCorrect={false}
            autoCapitalize="characters"
            mb={0}
          />
        </View>
      </View>

      <View style={{ height: 20 }} />

      <SectionLabel optional>{Q.preferredWorkoutTime.question}</SectionLabel>
      <SectionSubtext>{Q.preferredWorkoutTime.subtext}</SectionSubtext>
      <ChipGrid
        options={Q.preferredWorkoutTime.options!}
        value={preferredWorkoutTime}
        onSelect={(v) => { setPreferredWorkoutTime(v); showFeedback("Perfect — we'll build around your daily schedule"); }}
      />
      <FeedbackNote text={feedbackText} anim={feedbackAnim} />

      <SectionLabel optional>{Q.scheduleConsistency.question}</SectionLabel>
      <SectionSubtext>{Q.scheduleConsistency.subtext}</SectionSubtext>
      <View style={{ gap: 8, marginBottom: 28 }}>
        {Q.scheduleConsistency.options!.map((o) => (
          <OptionCard
            key={o.value}
            label={o.label}
            desc={o.desc}
            selected={scheduleConsistency === o.value}
            onSelect={() => setScheduleConsistency(o.value)}
          />
        ))}
      </View>

      <PlanPreviewCard preview={previewPlan} anim={previewAnim} />
      <NextButton
        title="Build my program →"
        disabled={wake.trim() === "" || sleep.trim() === ""}
        onPress={handleFinish}
        gradient
      />
      <BackLink onPress={() => goStep(7)} />
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent" },
  scroll: { padding: 24, paddingBottom: 52 },
  row:    { flexDirection: "row", gap: 12 },
  genderRow: { flexDirection: "row", gap: 6 },
  genderBtn: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  genderBtnActive: {
    backgroundColor: "rgba(108,99,255,0.18)",
    borderColor: ACCENT,
  },
  genderText:       { color: "#666", fontWeight: "700", fontSize: 13 },
  genderTextActive: { color: "#fff" },
  footnote: { color: "#3a3a52", fontSize: 12, textAlign: "center", marginTop: 14, lineHeight: 16 },
});

// Welcome callout — Step 1 intro card
const wl = StyleSheet.create({
  card: {
    backgroundColor: "rgba(108,99,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(108,99,255,0.18)",
    borderRadius: 16,
    padding: 18,
    marginBottom: 28,
  },
  label:   { color: ACCENT, fontSize: 10, fontWeight: "800", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 },
  heading: { color: "#fff", fontSize: 16, fontWeight: "700", marginBottom: 6 },
  body:    { color: "#7070a0", fontSize: 13, lineHeight: 19 },
});

// Smooth animated progress bar
const pb = StyleSheet.create({
  wrap:    { paddingHorizontal: 24, paddingTop: 4, paddingBottom: 16 },
  track:   { width: BAR_TOTAL_WIDTH, height: 3, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 2, overflow: "hidden" },
  fill:    { height: "100%", borderRadius: 2, overflow: "hidden" },
  message: { color: ACCENT, fontSize: 10, fontWeight: "700", letterSpacing: 1.5, textTransform: "uppercase", marginTop: 8 },
});

// Micro-feedback note (fades in under relevant inputs)
const fb = StyleSheet.create({
  note: { color: `${ACCENT}cc`, fontSize: 12, fontWeight: "600", marginBottom: 16, lineHeight: 17 },
});

// Step header
const hdr = StyleSheet.create({
  wrap:          { marginBottom: 28 },
  progressLabel: { color: ACCENT, fontSize: 10, fontWeight: "800", letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 },
  counter:       { color: "#505070", fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 },
  title:         { color: "#fff", fontSize: 28, fontWeight: "800", letterSpacing: -0.5, marginBottom: 6 },
  subtitle:      { color: "#7a7a9a", fontSize: 14, lineHeight: 21 },
});

// Section label + subtext
const sec = StyleSheet.create({
  label: { color: "#d0d0e8", fontSize: 13, fontWeight: "700", letterSpacing: 0.2, marginBottom: 4 },
  opt:   { color: "#454565", fontWeight: "400" },
});

// Section subtext (explanatory context beneath the question label)
const sub = StyleSheet.create({
  text: { color: "#505070", fontSize: 12, lineHeight: 17, marginBottom: 10 },
});

// Option card
const oc = StyleSheet.create({
  card: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    borderRadius: 14,
    padding: 16,
  },
  selected: {
    backgroundColor: "rgba(108,99,255,0.14)",
    borderColor: ACCENT,
  },
  row:          { flexDirection: "row", alignItems: "center", gap: 12 },
  label:        { color: "#888", fontWeight: "700", fontSize: 14 },
  labelSel:     { color: "#fff" },
  desc:         { color: "#3e3e58", fontSize: 12, lineHeight: 17, marginTop: 3 },
  descSel:      { color: "rgba(255,255,255,0.4)" },
  indicator:    { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.10)", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  indicatorSel: { borderColor: ACCENT, backgroundColor: "rgba(108,99,255,0.3)" },
  indicatorDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: ACCENT },
});

// Chip grid
const cg = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  chip: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  chipActive: {
    backgroundColor: "rgba(108,99,255,0.2)",
    borderColor: ACCENT,
  },
  text:       { color: "#555", fontSize: 13, fontWeight: "600" },
  textActive: { color: "#fff" },
});

// Number grid
const ng = StyleSheet.create({
  cell: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  cellActive: {
    backgroundColor: "rgba(108,99,255,0.2)",
    borderColor: ACCENT,
  },
  text:       { color: "#555", fontWeight: "800", fontSize: 15 },
  textActive: { color: "#fff" },
});

// Text input
const inp = StyleSheet.create({
  field: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    borderRadius: 12,
    padding: 14,
    color: "#fff",
    fontSize: 15,
  },
});

// Next button
const btn = StyleSheet.create({
  wrap:         { borderRadius: 14, overflow: "hidden", marginBottom: 4, paddingVertical: 16, alignItems: "center", justifyContent: "center" },
  wrapEnabled:  { backgroundColor: ACCENT },
  wrapDisabled: { backgroundColor: "rgba(255,255,255,0.05)" },
  text:         { color: "#fff", fontWeight: "800", fontSize: 15, letterSpacing: 0.2 },
  textDisabled: { color: "rgba(255,255,255,0.2)" },
});

// Back link
const back = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: 14 },
  text: { color: "#3a3a55", fontSize: 13, fontWeight: "600" },
});

// Completion screen
const cs = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0a0a14" },
  scroll: { padding: 28, paddingTop: 52, paddingBottom: 60 },

  titleBlock: { marginBottom: 28 },
  superLabel: {
    color: ACCENT,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 2.5,
    textTransform: "uppercase",
    marginBottom: 14,
  },
  headline: {
    color: "#fff",
    fontSize: 42,
    fontWeight: "800",
    letterSpacing: -1.5,
    lineHeight: 48,
    marginBottom: 14,
  },
  subtext: {
    color: "#7070a0",
    fontSize: 15,
    lineHeight: 23,
  },

  snapshotCard: {
    borderWidth: 1,
    borderColor: "rgba(108,99,255,0.28)",
    borderRadius: 18,
    padding: 18,
    marginBottom: 14,
    overflow: "hidden",
    shadowColor: "#6C63FF",
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  snapshotHeading: {
    color: ACCENT,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  snapshotDivider: {
    height: 1,
    backgroundColor: "rgba(108,99,255,0.14)",
    marginBottom: 14,
  },
  snapshotRow: { flexDirection: "row", gap: 16 },
  snapshotField: { flex: 1 },
  snapshotLabel: {
    color: "#45456a",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  snapshotValue: {
    color: "#c8c8e8",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
  },

  confCard: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    borderRadius: 14,
    padding: 14,
    marginBottom: 32,
  },
  confRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  confTitle: {
    color: "#45456a",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  confBadge: {
    backgroundColor: "rgba(108,99,255,0.2)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  confBadgeText: {
    color: ACCENT_GLOW,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
  },
  confNote: {
    color: "#7070a0",
    fontSize: 13,
    lineHeight: 19,
  },

  ctaWrap: { width: "100%" },
  ctaBtn: {
    borderRadius: 14,
    overflow: "hidden",
    paddingVertical: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 0.2,
  },
});

// Live plan preview card
// overflow:hidden clips the LinearGradient fill to the border radius.
// Shadow is static (not animated) — only the Animated.View's opacity is driven.
const pv = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: "rgba(108,99,255,0.25)",
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    overflow: "hidden",
    shadowColor: "#6C63FF",
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  label: {
    color: ACCENT,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  focus: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: -0.2,
    lineHeight: 21,
    marginBottom: 12,
  },
  divider: {
    height: 1,
    backgroundColor: "rgba(108,99,255,0.14)",
    marginBottom: 10,
  },
  row: {
    flexDirection: "row",
    gap: 16,
  },
  field: {
    flex: 1,
  },
  fieldLabel: {
    color: "#45456a",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: 3,
  },
  fieldValue: {
    color: "#b0b0d0",
    fontSize: 13,
    fontWeight: "600",
  },
});
