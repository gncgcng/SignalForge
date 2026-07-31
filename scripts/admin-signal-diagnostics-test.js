import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  attachAdminSignalReferences,
  buildAdminSignalDiagnostics
} from "../src/modules/admin-signals/adminSignalDiagnosticService.js";

const base = {
  id: "generated-1",
  signalId: "signal-1",
  pair: "BTCUSD",
  displayPair: "BTCUSD",
  timeframe: "15m",
  direction: "long",
  strategy: "Breakout retest",
  entry: 100,
  stopLoss: 96,
  takeProfit: 108,
  riskReward: 2,
  confidence: 82,
  source: "auto_crypto_watcher",
  status: "Active",
  finalDecision: "ready_signal",
  finalDecisionLabel: "Ready Signal",
  primaryDecisionReason: "all_signal_requirements_passed",
  decisionVersion: "signal_decision_v1",
  decisionCreatedAt: "2026-07-31T12:00:00.000Z",
  userVisibility: "User-ready",
  qualityGateStatus: "passed",
  qualityGateReason: null,
  qualityGateDetails: {
    version: "quality_gate_v2",
    status: "passed",
    checks: [
      { stage: "entry_quality", passed: true, explanation: "Entry is acceptable." },
      { stage: "stop_loss_quality", passed: true, explanation: "Stop is structural." }
    ]
  },
  diagnosticAvailability: { rawConfidenceRecorded: true, calibratedConfidenceRecorded: true },
  confidenceCalibration: {
    version: "confidence_calibration_v2",
    rawSetupScore: 88,
    strategyMatchScore: 84,
    status: "insufficient_data",
    historicalCalibrationAdjustment: -6,
    confidenceCap: 82,
    finalCalibratedConfidence: 82,
    calibrationReason: "Historical sample is insufficient, so only a small uncertainty adjustment was applied.",
    historicalGroupUsed: {
      groupType: "pair_timeframe_strategy_direction",
      groupValue: "BTCUSD:15m:breakout_retest:long",
      pair: "BTCUSD",
      timeframe: "15m",
      strategy: "Breakout retest",
      direction: "long",
      closedSignals: 8,
      winRate: 37.5,
      estimatedExpectancy: 0.12
    }
  },
  fullAnalysis: {
    indicators: {
      qualityGateV2: { version: "quality_gate_v2", status: "passed", passed: true },
      generatedQualityGate: { version: "generated_quality_v2", passed: true }
    },
    stopValidation: {
      originalStopLoss: 98.8,
      originalFailureReason: "stop_inside_noise",
      repairAttempted: true,
      repairSucceeded: true,
      repairSource: "recent_swing",
      repairedStopLoss: 96,
      atrBufferUsed: 0.2,
      originalStopDistance: 1.2,
      repairedStopDistance: 4,
      repairedRiskReward: 2,
      finalResult: "passed"
    },
    takeProfitValidation: {
      originalTakeProfit: 112,
      originalFailureReason: "tp_too_far_for_timeframe",
      repairAttempted: true,
      repairSucceeded: true,
      repairSource: "nearest_resistance",
      repairedTakeProfit: 108,
      nearestOpposingStructure: 108.3,
      atrMoveRequired: 2,
      originalRiskReward: 3,
      repairedRiskReward: 2,
      finalResult: "passed"
    }
  },
  telegramStatus: "telegram_blocked_user_preference",
  telegramBlockReason: "telegram_blocked_user_confidence_preference",
  telegramBlockDetails: {
    finalCalibratedConfidence: 82,
    globalAlertThreshold: 65,
    userAlertThreshold: 90,
    effectiveAlertThreshold: 90,
    preferenceCheckPassed: false
  },
  telegramDecisions: []
};

const before = structuredClone(base);
const diagnostics = buildAdminSignalDiagnostics(base);

assert.equal(diagnostics.summary.finalDecision, "ready_signal");
assert.equal(diagnostics.summary.primaryReasonCode, "all_signal_requirements_passed");
assert.equal(diagnostics.summary.creditEligible, true);
assert.deepEqual(diagnostics.timeline.map((item) => item.key), diagnostics.timelineOrder);
assert.equal(diagnostics.confidence.rawConfidence, 88);
assert.equal(diagnostics.confidence.strategyMatchScore, 84);
assert.equal(diagnostics.confidence.historicalGroup.sampleSize, 8);
assert.equal(diagnostics.stopLoss.repairSucceeded, true);
assert.equal(diagnostics.stopLoss.repairedStop, 96);
assert.equal(diagnostics.takeProfit.repairSucceeded, true);
assert.equal(diagnostics.takeProfit.repairedTarget, 108);
assert.equal(diagnostics.telegram.effectiveThreshold, 90);
assert.match(diagnostics.telegram.reason, /82.*90/);
assert.deepEqual(base, before, "Admin diagnostics must not mutate signal records or promotion outcomes.");

const failedStop = buildAdminSignalDiagnostics({
  ...base,
  finalDecision: "blocked",
  primaryDecisionReason: "invalid_stop_loss",
  fullAnalysis: {
    ...base.fullAnalysis,
    stopValidation: {
      originalStopLoss: 99,
      originalFailureReason: "stop_inside_noise",
      repairAttempted: true,
      repairSucceeded: false,
      repairFailureReason: "no_structural_stop_available",
      finalResult: "failed"
    }
  }
});
assert.equal(failedStop.stopLoss.finalResult, "failed");
assert.equal(failedStop.stopLoss.finalReason, "no_structural_stop_available");

const duplicateSignal = buildAdminSignalDiagnostics({
  ...base,
  finalDecision: "blocked",
  primaryDecisionReason: "duplicate_blocked",
  status: "Duplicate blocked",
  qualityGateStatus: "passed",
  fullAnalysis: {
    ...base.fullAnalysis,
    indicators: {
      ...base.fullAnalysis.indicators,
      generatedQualityGate: {
        type: "duplicate",
        details: {
          matchedSignalId: "signal-prior",
          priorSignalStatus: "Active",
          matchedPair: "BTCUSD",
          matchedTimeframe: "15m",
          matchedDirection: "long",
          matchedStrategy: "Breakout retest",
          entryDistancePercent: 0.14,
          entryDistanceAtr: 0.22,
          timeDifferenceMinutes: 38,
          matchType: "direct_duplicate",
          exactRule: "same_pair_timeframe_direction_strategy_entry_and_structure",
          selectedSignal: "existing"
        }
      }
    }
  }
});
assert.equal(duplicateSignal.duplicate.result, "blocked");
assert.match(duplicateSignal.qualityGate.laterBlockExplanation, /later blocked by duplicate protection/i);
const linked = attachAdminSignalReferences(duplicateSignal, { "signal-prior": "generated-prior" });
assert.equal(linked.duplicate.relatedGeneratedSignalId, "generated-prior");

const cooldownSignal = buildAdminSignalDiagnostics({
  ...base,
  finalDecision: "blocked",
  primaryDecisionReason: "cooldown_blocked",
  status: "Cooldown blocked",
  fullAnalysis: {
    ...base.fullAnalysis,
    indicators: {
      ...base.fullAnalysis.indicators,
      generatedQualityGate: {
        type: "cooldown",
        details: {
          matchedSignalId: "signal-loss",
          previousOutcome: "Hit SL",
          previousSignalPromoted: true,
          previousTelegramSent: true,
          previousPair: "BTCUSD",
          previousTimeframe: "15m",
          previousDirection: "long",
          previousStrategy: "Breakout retest",
          cooldownStartedAt: "2026-07-31T10:00:00.000Z",
          cooldownExpiresAt: "2026-07-31T16:00:00.000Z",
          remainingDurationLabel: "2h 18m",
          structureSimilarity: "same_breakout_level",
          exactMatchingRule: "same_pair_timeframe_direction_strategy_structure"
        }
      }
    }
  }
});
assert.equal(cooldownSignal.cooldown.priorSignalId, "signal-loss");
assert.equal(cooldownSignal.cooldown.priorUserReady, true);
const linkedCooldown = attachAdminSignalReferences(cooldownSignal, { "signal-loss": "generated-loss" });
assert.equal(linkedCooldown.cooldown.relatedGeneratedSignalId, "generated-loss");

const legacy = buildAdminSignalDiagnostics({
  signalId: "legacy-1",
  pair: "ETHUSD",
  timeframe: "15m",
  direction: "short",
  strategy: "Legacy setup",
  source: "legacy_unlocked_signal",
  status: "Hit SL",
  confidence: 95,
  diagnosticAvailability: { rawConfidenceRecorded: false, calibratedConfidenceRecorded: false },
  fullAnalysis: {}
});
assert.equal(legacy.legacy, true);
assert.equal(legacy.summary.finalDecision, null);
assert.equal(legacy.summary.creditEligible, null);
assert.equal(legacy.confidence.rawConfidence, null);
assert.equal(legacy.confidence.finalCalibratedConfidence, null);
assert.match(legacy.stopLoss.unavailableReason, /Data unavailable/);
assert.equal(legacy.telegram.status, "legacy_unavailable");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const controller = read("src/modules/admin-signals/generatedSignalController.js");
const service = read("src/modules/admin-signals/generatedSignalService.js");
const diagnosticService = read("src/modules/admin-signals/adminSignalDiagnosticService.js");
const repository = read("src/modules/admin-signals/generatedSignalRepository.js");
const app = read("public/app.js");
const html = read("public/index.html");

assert.match(controller, /if \(!isAdminUser\(req\.user\)\)/, "Admin diagnostic API must remain admin-only.");
assert.match(service, /buildAdminSignalDiagnostics/, "Admin detail API should attach the derived audit model.");
assert.doesNotMatch(diagnosticService, /applyFinalSignalDecision|evaluateGeneratedSignalTelegramDecision|enqueueTelegram|sendTelegram/, "The diagnostic builder must not run promotion or delivery decisions.");
assert.match(repository, /filters\.finalDecision/);
assert.match(repository, /filters\.telegramResult/);
assert.match(html, /name="stopRepair"/);
assert.match(html, /name="takeProfitRepair"/);
assert.match(app, /Decision timeline/);
assert.match(app, /Data unavailable for this decision version|Legacy \/ unavailable/);

console.log(JSON.stringify({
  finalDecision: diagnostics.summary.finalDecision,
  timelineSteps: diagnostics.timeline.length,
  stopRepair: diagnostics.stopLoss.finalResult,
  targetRepair: diagnostics.takeProfit.finalResult,
  duplicateLink: linked.duplicate.relatedGeneratedSignalId,
  legacyConfidence: legacy.confidence.finalCalibratedConfidence,
  outcomesUnchanged: true
}, null, 2));
