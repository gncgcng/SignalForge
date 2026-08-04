process.env.TELEGRAM_BOT_TOKEN = "signal-pipeline-regression-token";
process.env.TELEGRAM_MAX_ATTEMPTS = "1";
process.env.CRYPTO_WATCHER_ENABLED = "false";
process.env.AUTO_SCAN_ENABLED = "false";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getGeneratedTransportRow,
  getTelegramQueueRows,
  resetDatabaseTransport,
  setTelegramSettings
} from "./test-support/signal-pipeline-db-transport.mock.js";

const qualityGateModule = await import("../src/modules/signals/generatedSignalQualityGate.js");
const calibrationModule = await import("../src/modules/signals/signalConfidenceCalibrationService.js");
const signalGeneratorModule = await import("../src/modules/signals/signalGenerator.js");
const signalQualityModule = await import("../src/modules/signals/signalQualityService.js");
const riskModule = await import("../src/modules/risk/riskEngineService.js");
const generatedRepositoryModule = await import("../src/modules/admin-signals/generatedSignalRepository.js");
const notificationModule = await import("../src/modules/notifications/notificationService.js");
const notificationQueueModule = await import("../src/modules/notifications/notificationQueue.js");
await import("../src/modules/signals/signalService.js");
await import("../src/modules/alerts/autoScanService.js");

const signalServiceSource = source("../src/modules/signals/signalService.js");
const autoScanSource = source("../src/modules/alerts/autoScanService.js");
const qualityGateSource = source("../src/modules/signals/generatedSignalQualityGate.js");
const results = [];
const confirmedFailures = [];
const passingProtections = [];
const characterizationFindings = [];
const limitations = [
  "scanMarketSetupDetailed and runAutoCryptoAlertScan could not be executed end-to-end without replacing internal candidate/repository modules. The production modules were imported unchanged; repeated private orchestration stages are checked statically and their real calibration function is characterized at runtime."
];

const riskCharacterization = characterizeRiskEngine();
const generatorCharacterization = characterizeGeneratorFixture();
const generatedFixture = generatorCharacterization.validResult;
const traceSignal = generatedFixture?.signal || buildRiskDerivedSignal(riskCharacterization.plans[0]);
if (!generatedFixture) {
  limitations.push("The real generator executed against 80 deterministic candle fixtures but produced no ready setup. This is generator execution only, not end-to-end production-pipeline coverage; downstream calibration characterization uses levels returned by the real Dynamic Risk Engine.");
}
characterize("real generator execution", {
  attempts: generatorCharacterization.attempts,
  readySetupFound: Boolean(generatedFixture),
  lastNoSetupMessage: generatorCharacterization.lastNoSetup?.analysis?.message || null
});

await runtime("signalQualityService accepts the real generated/risk-derived signal", () => {
  const quality = signalQualityModule.withSignalQuality(traceSignal);
  assert.ok(quality.signalQuality && typeof quality.signalQuality === "object");
});

await runtime("5m is not automatically quarantined", () => {
  assert.notEqual(qualityGateModule.getTimeframeQualityPolicy("5m").status, "quarantined");
});
await runtime("1h is not automatically quarantined", () => {
  assert.notEqual(qualityGateModule.getTimeframeQualityPolicy("1h").status, "quarantined");
});
await runtime("15m is not automatically capped at 88", () => {
  assert.notEqual(qualityGateModule.getTimeframeQualityPolicy("15m").confidenceCap, 88);
});
await runtime("4h is not automatically placed on a watchlist", () => {
  assert.notEqual(qualityGateModule.getTimeframeQualityPolicy("4h").status, "watchlist");
});
await runtime("explicit admin active group status overrides automatic quarantine", () => {
  const status = calibrationModule.calculateGroupStatus({
    totalSignals: 45,
    closedSignals: 35,
    hitTp: 4,
    hitSl: 31,
    winRate: 11.4,
    breakEvenWinRate: 33.3,
    estimatedExpectancy: -0.78,
    expiredRate: 18,
    confidenceGap: 78
  }, {
    status: "active",
    penalty_override: null,
    confidence_cap_override: null
  });
  assert.equal(status.status, "active", `automatic status won: ${status.status}`);
  assert.equal(status.adminControlled, true, "explicit active override was not marked admin-controlled");
});
await staticCheck("timeframe quarantine comes only from an explicit saved admin setting", () => {
  expectSourceNotToMatch(qualityGateSource, /"5m":\s*\{\s*status:\s*"quarantined"/, "hardcoded 5m quarantine found");
  expectSourceNotToMatch(qualityGateSource, /"1h":\s*\{\s*status:\s*"quarantined"/, "hardcoded 1h quarantine found");
});

const raw83 = calibrationModule.applyCalibrationContext(calibrationSignal(83), { noHistory: true, groups: [] });
const raw88 = calibrationModule.applyCalibrationContext(calibrationSignal(88), { noHistory: true, groups: [] });
const belowFloor = calibrationModule.applyCalibrationContext(calibrationSignal(88), {
  noHistory: false,
  groups: [
    penalizedGroup("strategy:breakout-retest", "strategy", -20, 35),
    penalizedGroup("pair_timeframe:BTC-USD:15m", "pair_timeframe", -20, 35),
    penalizedGroup("recent_strategy:breakout-retest", "recent_strategy", -20, 12)
  ]
});
const diagnosticQuarantine = calibrationModule.applyCalibrationContext(calibrationSignal(88), {
  noHistory: false,
  groups: [{
    ...penalizedGroup("strategy:quarantined", "strategy", -15, 35),
    status: "quarantined",
    confidenceCap: 68
  }]
});
characterize("no-history confidence cap", {
  rawSetupScore: raw88.confidenceCalibration.rawSetupScore,
  finalConfidence: raw88.confidenceScore,
  status: raw88.confidenceCalibration.status,
  blocked: raw88.confidenceCalibration.blocked,
  historyUnavailableRecorded: raw88.confidenceCalibration.caps.some((item) => /no generated-signal history/i.test(item.reason))
});
characterize("hardcoded confidence floor", {
  rawSetupScore: belowFloor.confidenceCalibration.rawSetupScore,
  calculatedPenalty: belowFloor.confidenceCalibration.totalPenalty,
  uncappedArithmeticResult: 88 + belowFloor.confidenceCalibration.totalPenalty,
  finalConfidence: belowFloor.confidenceScore,
  sourceContainsMathMax50: /Math\.max\(50\s*,/.test(source("../src/modules/signals/signalConfidenceCalibrationService.js"))
});
await runtime("raw confidence 83 does not become invented 50", () => {
  assert.notEqual(raw83.confidenceScore, 50);
  assert.notEqual(raw83.confidenceScore, 0);
});
await runtime("raw confidence 88 does not become invented 50", () => {
  assert.notEqual(raw88.confidenceScore, 50);
  assert.notEqual(raw88.confidenceScore, 0);
});
for (const malformed of [null, undefined, Number.NaN]) {
  await runtime(`malformed historical value ${String(malformed)} does not become confidence 0 or 50`, () => {
    const calibrated = calibrationModule.applyCalibrationContext(calibrationSignal(86), {
      noHistory: true,
      groups: [{
        groupKey: "strategy:malformed",
        groupType: "strategy",
        closedSignals: 0,
        winRate: malformed,
        breakEvenWinRate: malformed,
        estimatedExpectancy: malformed,
        expiredRate: malformed,
        status: "active"
      }]
    });
    assert.ok(Number.isFinite(calibrated.confidenceScore));
    assert.notEqual(calibrated.confidenceScore, 0);
    assert.notEqual(calibrated.confidenceScore, 50);
  });
  await runtime(`malformed raw confidence ${String(malformed)} does not become confidence 0 or 50`, () => {
    const calibrated = calibrationModule.applyCalibrationContext(calibrationSignal(malformed), {
      noHistory: true,
      groups: []
    });
    assert.equal(calibrated.confidenceScore, null);
    assert.equal(calibrated.calibratedConfidence, null);
    assert.notEqual(calibrated.confidenceScore, 0);
    assert.notEqual(calibrated.confidenceScore, 50);
    assert.equal(calibrated.confidenceCalibration.status, "calibration_error");
    assert.equal(calibrated.confidenceCalibration.blocked, true);
    assert.equal(calibrated.confidenceCalibration.technicalError, true);
    assert.equal(calibrated.confidenceCalibration.errorCode, "invalid_raw_confidence");
    assert.equal(calibrationModule.isSignalBlockedByCalibration(calibrated), true);
    assert.equal(notificationModule.telegramPreferenceMatchesSetup({
      enabled: true,
      favoriteMarketsOnly: false,
      timeframes: ["15m"],
      direction: "both",
      minimumConfidence: 0
    }, new Set(), {
      ...telegramSignal(90, "ready_signal"),
      ...calibrated,
      resultType: "ready_signal",
      validationPassed: true,
      status: "Active"
    }), false);
  });
}
await runtime("no-history payload explicitly records unavailable history", () => {
  assert.ok(raw88.confidenceCalibration.caps.some((item) => /no generated-signal history/i.test(item.reason)));
});
await runtime("no-history is not treated as a technical error", () => {
  assert.notEqual(raw88.confidenceCalibration.status, "calibration_error");
});
await runtime("no-history calibration does not block the setup", () => {
  assert.equal(raw88.confidenceCalibration.blocked, false);
});
await runtime("diagnostic-only no-history calibration preserves original live confidence", () => {
  assert.equal(raw88.confidenceCalibration.rawSetupScore, 88);
  assert.equal(raw88.confidenceScore, 88, `raw 88 became final ${raw88.confidenceScore}`);
});
await runtime("historical penalties do not invent a fixed confidence floor of 50", () => {
  assert.notEqual(
    belowFloor.confidenceScore,
    50,
    `raw 88 with ${belowFloor.confidenceCalibration.totalPenalty} points was forced to 50`
  );
});
await runtime("historical quarantine remains diagnostic while live calibration stays active", () => {
  assert.equal(diagnosticQuarantine.confidenceScore, 88);
  assert.equal(diagnosticQuarantine.confidenceCalibration.finalConfidence, 88);
  assert.equal(diagnosticQuarantine.confidenceCalibration.status, "active");
  assert.equal(diagnosticQuarantine.confidenceCalibration.diagnosticStatus, "quarantined");
  assert.equal(diagnosticQuarantine.confidenceCalibration.mode, "diagnostic_only");
  assert.equal(diagnosticQuarantine.confidenceCalibration.blocked, false);
});
await runtime("signal quality does not downgrade a diagnostic-only historical quarantine", () => {
  const qualitySignal = signalQualityModule.withSignalQuality(diagnosticQuarantine);
  assert.equal(qualitySignal.signalQuality.score, 88);
  assert.equal(qualitySignal.signalQuality.overall, "strong");
  assert.notEqual(qualitySignal.signalQuality.label, "Quarantined");
  assert.notEqual(qualitySignal.signalQuality.label, "Reduced confidence");
  assert.notEqual(qualitySignal.signalQuality.label, "Under calibration");
  assert.equal(qualitySignal.signalQuality.calibrationStatus, "active");
  assert.equal(qualitySignal.signalQuality.historicalCalibrationStatus, "quarantined");
});

resetDatabaseTransport();
const manualCalibration = await calibrationModule.applyConfidenceCalibration({
  ...traceSignal,
  confidenceScore: 88,
  generationSource: "manual_scan",
  indicators: { ...(traceSignal.indicators || {}), generationSource: "manual_scan" }
});
const autoCalibration = await calibrationModule.applyConfidenceCalibration({
  ...traceSignal,
  confidenceScore: 88,
  generationSource: "auto_crypto_watcher",
  indicators: { ...(traceSignal.indicators || {}), generationSource: "auto_crypto_watcher" }
});
await runtime("manual and automatic contexts produce the same final confidence for the same fixture", () => {
  assert.equal(manualCalibration.confidenceScore, autoCalibration.confidenceScore);
});
const firstCalibrationPass = calibrationModule.applyCalibrationContext(calibrationSignal(88), {
  noHistory: true,
  groups: []
});
const secondCalibrationPass = calibrationModule.applyCalibrationContext({
  ...firstCalibrationPass,
  generationSource: "candidate_promotion",
  indicators: {
    ...(firstCalibrationPass.indicators || {}),
    generationSource: "candidate_promotion",
    confidenceCalibration: undefined,
    confidenceCalibrationApplied: undefined
  }
}, {
  noHistory: true,
  groups: []
});
characterize("real repeated calibration pass", {
  firstInput: 88,
  firstOutput: firstCalibrationPass.confidenceScore,
  secondInput: firstCalibrationPass.confidenceScore,
  secondOutput: secondCalibrationPass.confidenceScore,
  secondRawSetupScore: secondCalibrationPass.confidenceCalibration.rawSetupScore
});
const calibrationStages = {
  normalSignalGeneration: /applyLearningToValidatedSignal/.test(signalServiceSource) && /applyConfidenceCalibration/.test(signalServiceSource),
  candidatePromotion: /generationSource:\s*"candidate_promotion"/.test(signalServiceSource),
  telegramAlert: /generationSource:\s*"telegram_alert"/.test(autoScanSource)
};
characterize("production calibration stages found by static source audit", calibrationStages);
await staticCheck("candidate promotion does not recalibrate a calibrated setup", () => {
  expectSourceNotToMatch(
    signalServiceSource,
    /generationSource:\s*"candidate_promotion"[\s\S]{0,500}applyConfidenceCalibration|applyConfidenceCalibration\([\s\S]{0,500}generationSource:\s*"candidate_promotion"/,
    "candidate_promotion invokes applyConfidenceCalibration"
  );
});
await staticCheck("Telegram eligibility does not recalibrate a calibrated setup", () => {
  expectSourceNotToMatch(
    autoScanSource,
    /async function calibrateTelegramAlertSetup[\s\S]*applyConfidenceCalibration/,
    "calibrateTelegramAlertSetup invokes applyConfidenceCalibration"
  );
});
await staticCheck("one raw setup has no manual, candidate-promotion, and telegram-alert calibration chain", () => {
  const stages = [
    /applyLearningToValidatedSignal/.test(signalServiceSource),
    /generationSource:\s*"candidate_promotion"/.test(signalServiceSource),
    /generationSource:\s*"telegram_alert"/.test(autoScanSource)
  ].filter(Boolean).length;
  assert.ok(stages <= 1, `observed ${stages} calibration stages`);
});

const blockedByGate = qualityGateModule.applyGeneratedSignalQualityBlock({
  ...traceSignal,
  resultType: "ready_signal",
  validationPassed: true,
  status: "Active"
}, {
  passed: false,
  type: "timeframe",
  status: "Quarantined timeframe",
  reason: "Regression fixture Quality Gate rejection"
});
await runtime("Quality Gate rejection does not retain validationPassed true", () => {
  assert.notEqual(blockedByGate.validationPassed, true);
});
await runtime("record cannot remain ready and blocked simultaneously", () => {
  assert.ok(!(blockedByGate.resultType === "ready_signal" && blockedByGate.indicators?.generatedQualityBlocked));
});
await runtime("Quality Gate pass is not blocked by that same gate", () => {
  const passed = qualityGateModule.applyGeneratedSignalQualityBlock({
    ...traceSignal,
    resultType: "ready_signal",
    validationPassed: true,
    status: "Active"
  }, { passed: true });
  assert.equal(passed.indicators?.generatedQualityBlocked, undefined);
  assertReadySignalCoherence(passed);
});

await exerciseGeneratedSignalUpsert();
await exerciseTelegramBoundary();

await runtime("risk-engine characterization values remain finite", () => {
  assert.ok(riskCharacterization.plans.every((item) =>
    [item.stopAtr, item.targetAtr, item.riskRewardRatio].every(Number.isFinite)
  ));
});

printReport();
if (confirmedFailures.length) process.exitCode = 1;

async function exerciseGeneratedSignalUpsert() {
  resetDatabaseTransport();
  const first = repositorySignal({
    source: "manual_scan",
    status: "Active",
    confidence: 83,
    entry: 100,
    stop: 98,
    target: 104,
    rr: 2,
    validUntil: "2030-01-01T01:00:00.000Z",
    reasoning: "old analysis"
  });
  const second = repositorySignal({
    source: "candidate_promotion",
    status: "Hit SL",
    confidence: 91,
    entry: 101,
    stop: 97,
    target: 109,
    rr: 2.5,
    validUntil: "2030-01-02T01:00:00.000Z",
    reasoning: "candidate analysis"
  });
  const third = repositorySignal({
    source: "telegram_alert",
    status: "Active",
    confidence: 95,
    entry: 102,
    stop: 96,
    target: 114,
    rr: 2,
    validUntil: "2030-01-03T01:00:00.000Z",
    reasoning: "telegram analysis"
  });
  await generatedRepositoryModule.upsertGeneratedSignal(first.signal, first.context);
  await generatedRepositoryModule.upsertGeneratedSignal(second.signal, second.context);
  const updated = await generatedRepositoryModule.upsertGeneratedSignal(third.signal, third.context);
  const stored = getGeneratedTransportRow(generatedRepositoryModule.buildGeneratedSignalKey(second.signal));

  await runtime("duplicate generated save preserves the original snapshot identity", () => {
    assert.equal(updated.source, "manual_scan");
    assert.equal(updated.status, "Active");
    assert.equal(updated.entry, 100);
    assert.equal(updated.stopLoss, 98);
    assert.equal(updated.takeProfit, 104);
    assert.equal(updated.riskReward, 2);
    assert.equal(String(updated.validUntil), first.signal.validUntil);
  });
  await runtime("duplicate generated save extends source history", () => {
    assert.deepEqual(new Set(updated.sourceHistory), new Set(["manual_scan", "candidate_promotion", "telegram_alert"]));
  });
  await runtime("duplicate candidate or alert save cannot overwrite original confidence and calibration", () => {
    assert.equal(updated.confidence, 83);
    assert.equal(updated.calibratedConfidence, 83);
    assert.equal(updated.confidenceCalibration.marker, "new-83");
    assert.equal(updated.fullAnalysis.reasoning, "old analysis");
  });
  await runtime("generated upsert cannot create a mixed old-snapshot/new-calibration record", () => {
    const originalSnapshotKept = stored.source === "manual_scan" && stored.status === "Active" && Number(stored.entry) === 100 && Number(stored.stop_loss) === 98 && Number(stored.take_profit) === 104;
    const laterDiagnosticsApplied = Number(stored.confidence) !== 83 || stored.confidence_calibration?.marker !== "new-83" || stored.full_analysis?.reasoning !== "old analysis";
    assert.ok(!(originalSnapshotKept && laterDiagnosticsApplied), "stored row combines the original trade snapshot with later confidence/calibration/analysis");
  });

  const terminal = await generatedRepositoryModule.updateGeneratedSignalStatus(updated.id, "Hit SL", {
    resolvedAt: "2030-01-01T02:00:00.000Z",
    reason: "regression terminal transition"
  });
  await runtime("terminal status transition is handled separately from recalibration upsert", () => {
    assert.equal(terminal.status, "Hit SL");
    assert.equal(terminal.confidence, Number(stored.confidence), "status transition unexpectedly rewrote stored confidence");
    assert.equal(terminal.entry, 100);
  });
}

async function exerciseTelegramBoundary() {
  resetDatabaseTransport();
  setTelegramSettings("usr_regression");
  const settings = {
    enabled: true,
    favoriteMarketsOnly: false,
    timeframes: ["15m"],
    direction: "both",
    minimumConfidence: 90
  };
  const ready89 = telegramSignal(89, "ready_signal");
  const ready90 = telegramSignal(90, "ready_signal");

  await runtime("user threshold 90 rejects final confidence 89", () => {
    assert.equal(notificationModule.telegramPreferenceMatchesSetup(settings, new Set(), ready89), false);
  });
  await runtime("user threshold 90 permits final confidence 90 when ready", () => {
    assert.equal(notificationModule.telegramPreferenceMatchesSetup(settings, new Set(), ready90), true);
  });
  await runtime("lower global threshold cannot override user threshold 90", () => {
    assert.equal(notificationModule.telegramPreferenceMatchesSetup(settings, new Set(), ready89), false);
  });
  const ineligible = [
    ["non-ready result type", { ...ready90, resultType: "watching_setup" }],
    ["failed validation", { ...ready90, validationPassed: false }],
    ["non-active status", { ...ready90, status: "Blocked" }],
    ["Quality Gate block", { ...ready90, generatedQualityBlocked: true, indicators: { ...(ready90.indicators || {}), generatedQualityBlocked: true } }],
    ["calibration block", { ...ready90, confidenceCalibration: { blocked: true } }],
    ["expired signal", { ...ready90, validUntil: new Date(Date.now() - 60_000).toISOString() }]
  ];
  for (const [reason, fixture] of ineligible) {
    await runtime(`Telegram eligibility rejects ${reason}`, () => {
      assert.equal(notificationModule.telegramPreferenceMatchesSetup(settings, new Set(), fixture), false);
    });
  }

  const queued = await notificationModule.enqueueMatchingTelegramNotifications({ id: "usr_regression" }, [ready89, ready90]);
  await runtime("queued notification is not reported as sent", () => {
    assert.equal(queued.length, 1);
    assert.equal(getTelegramQueueRows()[0].status, "queued");
    assert.equal(getTelegramQueueRows()[0].sent_at, null);
  });

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  await notificationQueueModule.processTelegramQueue();
  await runtime("successful Telegram HTTP response becomes sent", () => {
    assert.equal(getTelegramQueueRows()[0].status, "sent");
    assert.ok(getTelegramQueueRows()[0].sent_at);
  });

  resetDatabaseTransport();
  setTelegramSettings("usr_regression");
  await notificationModule.enqueueMatchingTelegramNotifications({ id: "usr_regression" }, [ready90]);
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, description: "fixture delivery failed" }), {
    status: 500,
    headers: { "content-type": "application/json" }
  });
  await notificationQueueModule.processTelegramQueue();
  await runtime("failed Telegram delivery is not reported as sent", () => {
    const row = getTelegramQueueRows()[0];
    assert.equal(row.status, "failed");
    assert.equal(row.sent_at, null);
    assert.match(row.last_error, /fixture delivery failed/);
  });
}

function characterizeRiskEngine() {
  const cases = [
    {
      strategy: "Trend continuation",
      timeframe: "15m",
      input: {
        direction: "long",
        entry: 100,
        atr: 2,
        regime: { label: "Trend Up", trendStrength: 0.8 },
        setupType: "Trend continuation",
        qualityScore: 92,
        protectiveLevel: { price: 93.4 },
        opposingLevel: null
      }
    },
    {
      strategy: "Breakout retest",
      timeframe: "1h",
      input: {
        direction: "short",
        entry: 100,
        atr: 2,
        regime: { label: "Breakout", trendStrength: 0.7 },
        setupType: "Breakout retest",
        qualityScore: 90,
        protectiveLevel: { price: 103 },
        opposingLevel: null
      }
    },
    {
      strategy: "Range bounce",
      timeframe: "4h",
      input: {
        direction: "long",
        entry: 100,
        atr: 2,
        regime: { label: "Range", trendStrength: 0.2 },
        setupType: "Range bounce",
        qualityScore: 88,
        protectiveLevel: null,
        opposingLevel: null
      }
    }
  ];
  const plans = cases.map((item) => {
    const plan = riskModule.buildDynamicRiskPlan(item.input);
    return {
      strategy: item.strategy,
      timeframe: item.timeframe,
      direction: item.input.direction,
      entry: item.input.entry,
      stopLoss: plan.stopLoss,
      takeProfit: plan.takeProfit,
      stopAtr: Math.abs(item.input.entry - plan.stopLoss) / item.input.atr,
      targetAtr: Math.abs(plan.takeProfit - item.input.entry) / item.input.atr,
      riskRewardRatio: plan.riskRewardRatio
    };
  });
  return {
    plans,
    maximumStopAtr: Math.max(...plans.map((item) => item.stopAtr)),
    maximumTargetAtr: Math.max(...plans.map((item) => item.targetAtr)),
    producesStopAbove3_5Atr: plans.some((item) => item.stopAtr > 3.5),
    producesTargetNearOrAbove9Atr: plans.some((item) => item.targetAtr >= 9),
    producesFiniteButExtremeLevels: plans.some((item) =>
      [item.entry, item.stopLoss, item.takeProfit].every(Number.isFinite) &&
      (item.stopAtr > 3.5 || item.targetAtr >= 9)
    )
  };
}

function characterizeGeneratorFixture() {
  let attempts = 0;
  let lastNoSetup = null;
  for (const step of [0.02, 0.03, 0.04, 0.05, 0.07]) {
    for (const amplitude of [0.3, 0.5, 0.8, 1.1]) {
      for (const phase of [0, 0.8, 1.6, 2.4]) {
        attempts += 1;
        const result = signalGeneratorModule.generateMarketDataSetup({
          pair: { symbol: "BTC-USD", assetClass: "Crypto" },
          source: "regression-candle-fixture",
          volumeAvailable: true,
          candles: trendCandles(step, amplitude, phase),
          confluence: { lowerTimeframe: "15m", higherTimeframes: [] },
          intelligence: null,
          correlation: null,
          advancedStructure: null
        }, "15m");
        if (result.valid) return { attempts, validResult: result, lastNoSetup };
        lastNoSetup = result;
      }
    }
  }
  return { attempts, validResult: null, lastNoSetup };
}

function trendCandles(step, amplitude, phase) {
  const interval = 900;
  const end = Math.floor(Date.now() / 1000 / interval) * interval;
  return Array.from({ length: 120 }, (_, index) => {
    const close = 100 + index * step + Math.sin(index * 0.45 + phase) * amplitude;
    const previous = 100 + Math.max(0, index - 1) * step + Math.sin(Math.max(0, index - 1) * 0.45 + phase) * amplitude;
    const open = previous;
    return {
      time: end - (119 - index) * interval,
      open,
      high: Math.max(open, close) + 0.22,
      low: Math.min(open, close) - 0.22,
      close,
      volume: index === 119 ? 1800 : 1000 + (index % 8) * 25
    };
  });
}

function buildRiskDerivedSignal(plan) {
  return {
    id: "sig_risk_derived",
    setupKey: "BTC-USD:15m:long:regression",
    symbol: "BTC-USD",
    timeframe: "15m",
    direction: plan.direction,
    setupType: plan.strategy,
    entryPrice: plan.entry,
    stopLoss: plan.stopLoss,
    takeProfit: plan.takeProfit,
    riskRewardRatio: plan.riskRewardRatio,
    confidenceScore: 88,
    qualityScore: 90,
    readinessScore: 95,
    validationPassed: true,
    status: "Active",
    validUntil: "2030-01-01T01:00:00.000Z",
    confirmations: [],
    indicators: { atr14: 2, readinessScore: 95, regime: "Trend Up" }
  };
}

function calibrationSignal(confidence) {
  return {
    ...traceSignal,
    confidenceScore: confidence,
    rawSetupScore: confidence,
    riskRewardRatio: 2.2,
    timeframe: "15m",
    alignmentBadge: "Full Alignment",
    confluenceScore: 90,
    entryQuality: "excellent",
    indicators: { ...(traceSignal.indicators || {}), readinessScore: 95, regime: "Trend Up", confluenceScore: 90 },
    confirmations: [{ name: "Volume", passed: true }]
  };
}

function repositorySignal({ source: signalSource, status, confidence, entry, stop, target, rr, validUntil, reasoning }) {
  return {
    context: { source: signalSource, generatedBy: "regression-test" },
    signal: {
      ...traceSignal,
      id: "sig_upsert_regression",
      setupKey: "BTC-USD:15m:long:upsert-regression",
      symbol: "BTC-USD",
      timeframe: "15m",
      direction: "long",
      setupType: "Breakout retest",
      entryPrice: entry,
      stopLoss: stop,
      takeProfit: target,
      riskRewardRatio: rr,
      confidenceScore: confidence,
      rawSetupScore: confidence,
      status,
      validUntil,
      validationPassed: status === "Active",
      reasoning,
      generatedAt: "2030-01-01T00:00:00.000Z",
      confidenceCalibration: {
        version: "regression-v1",
        originalConfidence: confidence,
        rawSetupScore: confidence,
        calibratedConfidence: confidence,
        finalConfidence: confidence,
        marker: `new-${confidence}`
      }
    }
  };
}

function telegramSignal(confidence, resultType) {
  return {
    ...traceSignal,
    id: `sig_tg_${confidence}_${resultType}`,
    setupKey: `BTC-USD:15m:long:${confidence}:${resultType}`,
    symbol: "BTC-USD",
    timeframe: "15m",
    direction: "long",
    setupType: "Breakout retest",
    confidenceScore: confidence,
    resultType,
    validationPassed: true,
    status: "Active",
    generatedQualityBlocked: false,
    confidenceCalibration: { blocked: false },
    indicators: {
      ...(traceSignal.indicators || {}),
      generatedQualityBlocked: false,
      confidenceCalibration: { blocked: false }
    },
    validUntil: new Date(Date.now() + 3600000).toISOString()
  };
}

function penalizedGroup(groupKey, groupType, penalty, closedSignals) {
  return {
    groupKey,
    groupType,
    groupValue: groupKey.split(":").slice(1).join(":"),
    totalSignals: closedSignals,
    closedSignals,
    hitTp: 2,
    hitSl: Math.max(0, closedSignals - 2),
    winRate: 5,
    breakEvenWinRate: 33,
    belowBreakEven: true,
    estimatedExpectancy: -0.8,
    expiredRate: 0,
    averageRiskReward: 2,
    averageConfidence: 88,
    confidenceGap: 83,
    status: "reduced_confidence",
    penalty,
    confidenceCap: 68,
    confidenceCapLift: 0
  };
}

function assertReadySignalCoherence(signal) {
  assert.equal(signal.resultType, "ready_signal");
  assert.notEqual(signal.validationPassed, false);
  assert.equal(signal.status, "Active");
  assert.notEqual(signal.generatedQualityBlocked, true);
  assert.notEqual(signal.indicators?.generatedQualityBlocked, true);
  assert.notEqual(signal.confidenceCalibration?.blocked, true);
  assert.notEqual(signal.indicators?.confidenceCalibration?.blocked, true);
}

async function runtime(name, test) {
  return runInvariant("runtime", name, test);
}

async function staticCheck(name, test) {
  return runInvariant("static", name, test);
}

async function runInvariant(kind, name, test) {
  try {
    await test();
    const result = { kind, name, passed: true };
    results.push(result);
    passingProtections.push(result);
  } catch (error) {
    const failure = { kind, name, passed: false, error: error.message };
    results.push(failure);
    confirmedFailures.push(failure);
  }
}

function characterize(name, details) {
  characterizationFindings.push({ name, details });
}

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function expectSourceNotToMatch(text, pattern, message) {
  if (pattern.test(text)) throw new Error(message);
}

function printReport() {
  console.log("\nSignalForge signal pipeline regression report");
  console.log("=============================================");
  console.log("\nConfirmed production invariant failures");
  if (!confirmedFailures.length) console.log("- None");
  for (const result of confirmedFailures) {
    console.log(`FAIL [${result.kind}] ${result.name}\n  ${result.error}`);
  }

  console.log("\nCharacterization findings");
  characterize("risk engine", riskCharacterization);
  for (const finding of characterizationFindings) {
    console.log(`- ${finding.name}: ${JSON.stringify(finding.details)}`);
  }

  console.log("\nTest limitations");
  for (const limitation of limitations) console.log(`- ${limitation}`);

  console.log("\nPassing protections");
  if (!passingProtections.length) console.log("- None");
  for (const result of passingProtections) {
    console.log(`PASS [${result.kind}] ${result.name}`);
  }

  console.log(`\nSummary: passed=${passingProtections.length} failed=${confirmedFailures.length} characterizations=${characterizationFindings.length} limitations=${limitations.length}`);
}
