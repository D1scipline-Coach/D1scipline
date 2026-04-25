/**
 * shared/intelligence/data/buildIntelligenceDataFlow.ts
 *
 * Central Phase 2 data flow builder.
 *
 *   buildIntelligenceDataFlow(input) → IntelligenceDataFlowResult
 *
 * ─── Pipeline ────────────────────────────────────────────────────────────────
 *
 * Step 1  validateIntelligenceInput(input)
 *           → Collects blocking errors and non-blocking warnings.
 *           → If valid === false → returns result with valid: false immediately.
 *             (Never throws — callers must check result.valid.)
 *
 * Step 2  normalizeIntelligenceInput(input, warnings, degradedMode, generatedAt)
 *           → extractSignals()        — called ONCE here; result threaded everywhere.
 *           → derivePlanDecisions()   — called ONCE; receives pre-computed signals.
 *           → deriveConfidenceLevel() — called ONCE.
 *           → Applies safe defaults to dailyCondition.
 *
 * Step 3  analyzeProfileCompleteness(normalizedInput)
 *           → Scores each domain. Derives per-domain canRun / degradedMode flags.
 *
 * Step 4  mapSignalsToEngineInputs(normalizedInput, completeness)
 *           → Reshapes pre-computed global signals into domain-specific views.
 *           → Calls computeReadinessTier once — shared by workout + recovery views.
 *
 * Step 5  createDomainDataPackets(normalizedInput, completeness, signalMap)
 *           → Assembles five fully typed input packets — one per engine.
 *
 * Step 6  Build and return IntelligenceDataFlowResult.
 *
 * ─── Key invariants ──────────────────────────────────────────────────────────
 *
 * - extractSignals / derivePlanDecisions / deriveConfidenceLevel are called
 *   EXACTLY ONCE in normalizeIntelligenceInput. This function does not call them.
 * - The function NEVER throws. If validation fails, valid: false is returned.
 *   Callers that need a throw (e.g. generateAiraIntelligencePlan) must check
 *   result.valid and throw themselves.
 * - Timestamps: generatedAt is resolved once at the top of this function.
 *   When AiraIntelligenceInput.generatedAt is supplied, all timestamps in the
 *   result are reproducible. Otherwise, new Date() is called exactly once.
 *
 * ─── Design rules ─────────────────────────────────────────────────────────────
 * - Pure function. No side effects.
 * - Never throws.
 * - Never mutates input.
 * - No external calls, no async, no randomness.
 */

import type {
  AiraIntelligenceInput,
  IntelligenceDataFlowResult,
  DataFlowMetadata,
} from "../types";
import {
  INTELLIGENCE_SYSTEM_VERSION,
  PHASE_2_DATA_FLOW_VERSION,
} from "../constants";
import { validateIntelligenceInput }  from "../utils/validateIntelligenceInput";
import { normalizeIntelligenceInput } from "../utils/normalizeIntelligenceInput";
import { analyzeProfileCompleteness } from "./analyzeProfileCompleteness";
import { mapSignalsToEngineInputs }   from "./mapSignalsToEngineInputs";
import { createDomainDataPackets }    from "./createDomainDataPackets";

/**
 * Run the Phase 2 data flow pipeline.
 *
 * Returns a structured result — never throws.
 * Check result.valid before accessing result.normalizedInput / completeness / domainPackets.
 *
 * @param input — Raw AiraIntelligenceInput from the caller.
 * @returns     — IntelligenceDataFlowResult with full pipeline outputs on success,
 *                or valid: false with error list on validation failure.
 */
export function buildIntelligenceDataFlow(
  input: AiraIntelligenceInput,
): IntelligenceDataFlowResult {

  // ── Resolve timestamp ONCE ─────────────────────────────────────────────────
  // All runtime metadata in this result will use this single value.
  // Plan logic (signals, decisions, tasks) remains fully deterministic regardless.
  const generatedAt                   = input.generatedAt ?? new Date().toISOString();
  const deterministicTimestampProvided = input.generatedAt != null;

  // ── Step 1: Validation ─────────────────────────────────────────────────────
  const validation = validateIntelligenceInput(input);

  if (!validation.valid) {
    // Build a minimal metadata block — no normalizedInput means no per-domain data.
    const failMetadata: DataFlowMetadata = {
      builtAt:                        generatedAt,
      systemVersion:                  INTELLIGENCE_SYSTEM_VERSION,
      phase:                          PHASE_2_DATA_FLOW_VERSION,
      deterministicTimestampProvided,
      globalDegradedMode:             true,
      domainDegradedModes: {
        workout:   true,
        nutrition: true,
        recovery:  true,
        sleep:     true,
        planner:   true,
      },
    };

    return {
      valid:           false,
      normalizedInput: null,
      completeness:    null,
      domainPackets:   null,
      warnings:        validation.warnings,
      errors:          validation.errors,
      metadata:        failMetadata,
    };
  }

  const { warnings: validationWarnings, degradedMode: validationDegradedMode } = validation;

  // ── Step 2: Normalization ──────────────────────────────────────────────────
  // extractSignals, derivePlanDecisions, deriveConfidenceLevel — each ONCE.
  //
  // Dual degraded mode system — two independent concepts coexist during migration:
  //
  //   validationDegradedMode  (Phase 1)
  //     Derived from validation: true when warning count ≥ 3.
  //     Stored in NormalizedIntelligenceInput.degradedMode.
  //     Consumed by Phase 1 engines to apply conservative defaults.
  //     Reflects structural input gaps — not domain-level data coverage.
  //
  //   globalDegradedMode  (Phase 2, derived at Step 6 below)
  //     Derived from completeness: workout.degraded || nutrition.degraded ||
  //     recovery.degraded || sleep.degraded.
  //     Stored in DataFlowMetadata.globalDegradedMode.
  //     Reported in the final plan's metadata for UI / logging consumers.
  //     Reflects per-domain data coverage — not input structure.
  //
  //   The two flags can diverge intentionally. A profile with many validation
  //   warnings may have complete domain coverage, or vice versa. Phase 3 should
  //   unify these into a single coherent degradation model.
  //
  // validationDegradedMode is passed so the normalizer embeds it in
  // NormalizedIntelligenceInput.degradedMode for Phase 1 engine backward-compat.
  const normalizedInput = normalizeIntelligenceInput(
    input,
    validationWarnings,
    validationDegradedMode,
    generatedAt,
  );

  // ── Step 3: Profile completeness ───────────────────────────────────────────
  // Scores each domain independently. canRun / degradedMode are set per-domain,
  // not globally — a missing nutrition field does not degrade the workout engine.
  const completeness = analyzeProfileCompleteness(normalizedInput);

  // ── Step 4: Signal mapping ─────────────────────────────────────────────────
  // Reshapes the single pre-computed PlanSignals into domain-specific views.
  // computeReadinessTier is deterministic: called here AND inside workoutEngine /
  // recoveryEngine (via generateRecovery). All calls produce identical results
  // for the same inputs — there is no "runs once" guarantee for this helper.
  const signalMap = mapSignalsToEngineInputs(normalizedInput, completeness);

  // ── Step 5: Domain data packets ────────────────────────────────────────────
  // Each packet bundles everything one engine needs: readiness, signals,
  // decisions, and a profile snapshot. Packets are the Phase 3 migration unit.
  const domainPackets = createDomainDataPackets(normalizedInput, completeness, signalMap);

  // ── Step 6: Assemble result ────────────────────────────────────────────────

  // globalDegradedMode is derived from the four domain engines, NOT from the
  // validation flag. This is intentional:
  //   - validationDegradedMode reflects structural input warnings (e.g. many gaps).
  //   - globalDegradedMode reflects whether any domain engine will fall back to
  //     defaults — it is the OR of the four domain states.
  //   - Planner is excluded: planner degradation is always downstream of domain
  //     states and never independently triggers the global flag.
  const globalDegradedMode =
    completeness.workout.degradedMode   ||
    completeness.nutrition.degradedMode ||
    completeness.recovery.degradedMode  ||
    completeness.sleep.degradedMode;

  const metadata: DataFlowMetadata = {
    builtAt:                        generatedAt,
    systemVersion:                  INTELLIGENCE_SYSTEM_VERSION,
    phase:                          PHASE_2_DATA_FLOW_VERSION,
    deterministicTimestampProvided,
    globalDegradedMode,
    domainDegradedModes: {
      workout:   completeness.workout.degradedMode,
      nutrition: completeness.nutrition.degradedMode,
      recovery:  completeness.recovery.degradedMode,
      sleep:     completeness.sleep.degradedMode,
      planner:   completeness.planner.degradedMode,
    },
  };

  return {
    valid: true,
    normalizedInput,
    completeness,
    domainPackets,
    warnings: validationWarnings,
    errors:   [],
    metadata,
  };
}
