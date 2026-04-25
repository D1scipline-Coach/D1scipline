/**
 * shared/intelligence/adaptation/analyzeUserFeedback.ts
 *
 * Analyzes UserCheckIn[] to detect recent feedback patterns.
 *
 * Rules:
 *   - Deterministic: same check-ins → same output, always.
 *   - No ML, no randomness.
 *   - Simple threshold counts — no weighted decay yet.
 *   - Caller is responsible for passing the appropriate time window.
 *   - Never throws. Empty array → all-zero summary.
 *
 * Pattern thresholds:
 *   All patterns require ≥ 2 matching check-ins to fire.
 *   This avoids reacting to single-day anomalies.
 */

import type { UserCheckIn } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// FeedbackSummary — internal type used by deriveAdaptationSignals
// ─────────────────────────────────────────────────────────────────────────────

export type FeedbackSummary = {
  checkInCount:       number;

  // Raw counts
  lowEnergyCount:     number;
  highSorenessCount:  number;  // "moderate" or "high" soreness
  highStressCount:    number;
  poorSleepCount:     number;  // "poor" or "fair" sleep quality
  lowMotivationCount: number;

  // Derived pattern flags (true when count ≥ threshold)
  hasLowEnergyPattern:     boolean;
  hasHighSorenessPattern:  boolean;
  hasHighStressPattern:    boolean;
  hasPoorSleepPattern:     boolean;
  hasLowMotivationPattern: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum occurrences before a pattern is considered actionable. */
const PATTERN_THRESHOLD = 2 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze a window of user check-ins and return a structured feedback summary.
 *
 * @param checkIns — Array of UserCheckIn records (caller provides the window).
 * @returns        — FeedbackSummary with raw counts and derived pattern flags.
 */
export function analyzeUserFeedback(checkIns: UserCheckIn[]): FeedbackSummary {
  let lowEnergyCount     = 0;
  let highSorenessCount  = 0;
  let highStressCount    = 0;
  let poorSleepCount     = 0;
  let lowMotivationCount = 0;

  for (const c of checkIns) {
    if (c.energy === "low") {
      lowEnergyCount++;
    }
    // Treat "moderate" soreness as noteworthy — not just "high"
    if (c.soreness === "moderate" || c.soreness === "high") {
      highSorenessCount++;
    }
    if (c.stress === "high") {
      highStressCount++;
    }
    // "fair" sleep is still a concern pattern over multiple days
    if (c.sleepQuality === "poor" || c.sleepQuality === "fair") {
      poorSleepCount++;
    }
    if (c.motivation === "low") {
      lowMotivationCount++;
    }
  }

  return {
    checkInCount: checkIns.length,
    lowEnergyCount,
    highSorenessCount,
    highStressCount,
    poorSleepCount,
    lowMotivationCount,
    hasLowEnergyPattern:     lowEnergyCount     >= PATTERN_THRESHOLD,
    hasHighSorenessPattern:  highSorenessCount  >= PATTERN_THRESHOLD,
    hasHighStressPattern:    highStressCount    >= PATTERN_THRESHOLD,
    hasPoorSleepPattern:     poorSleepCount     >= PATTERN_THRESHOLD,
    hasLowMotivationPattern: lowMotivationCount >= PATTERN_THRESHOLD,
  };
}
