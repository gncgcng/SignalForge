process.env.CRYPTO_WATCHER_ENABLED = "false";
process.env.AUTO_SCAN_ENABLED = "false";
process.env.MARKET_VERIFICATION_ENABLED = "false";

import assert from "node:assert/strict";

const FIXED_NOW_MS = Date.UTC(2026, 1, 3, 8, 30, 0);
let currentNowMs = FIXED_NOW_MS;
const REAL_DATE = globalThis.Date;
const REAL_FETCH = globalThis.fetch;

class FixedDate extends REAL_DATE {
  constructor(...args) {
    super(...(args.length ? args : [currentNowMs]));
  }

  static now() {
    return currentNowMs;
  }
}

globalThis.Date = FixedDate;
globalThis.fetch = deterministicFetch;

try {
  const { resetReadySignalTransport, getReadySignalPersistence } = await import(
    "./test-support/ready-signal-db-transport.mock.js"
  );
  const { scanMarketSetupDetailed } = await import("../src/modules/signals/signalService.js");
  const { evaluateTelegramSignalEligibility } = await import(
    "../src/modules/notifications/notificationService.js"
  );
  const { evaluateGeneratedSignalQualityGate } = await import(
    "../src/modules/signals/generatedSignalQualityGate.js"
  );

  currentNowMs = FIXED_NOW_MS;
  const first = await runIsolatedScan();
  currentNowMs = FIXED_NOW_MS + 6 * 60 * 1000;
  const second = await runIsolatedScan();
  currentNowMs = FIXED_NOW_MS;
  const signal = first.result.fullSetup;

  assertReadyResult(first.result, FIXED_NOW_MS);
  assertReadyResult(second.result, FIXED_NOW_MS + 6 * 60 * 1000);
  assertPersistence(first.persistence, signal);
  assertDeterministic(first.result.fullSetup, second.result.fullSetup);

  const minimumConfidence = Math.max(0, Math.floor(signal.confidenceScore));
  const settings = {
    enabled: true,
    favoriteMarketsOnly: false,
    timeframes: [signal.timeframe],
    direction: signal.direction,
    minimumConfidence
  };
  const eligible = evaluateTelegramSignalEligibility(settings, new Set(), signal, FIXED_NOW_MS);
  assert.equal(eligible.eligible, true, eligible.reason);

  assert.equal(evaluateTelegramSignalEligibility({
    ...settings,
    minimumConfidence: signal.confidenceScore + 1
  }, new Set(), signal, FIXED_NOW_MS).reason, "below_user_threshold");
  assert.equal(evaluateTelegramSignalEligibility(settings, new Set(), {
    ...signal,
    resultType: "watching_setup"
  }, FIXED_NOW_MS).reason, "non_ready_result");
  assert.equal(evaluateTelegramSignalEligibility(settings, new Set(), {
    ...signal,
    status: "Blocked"
  }, FIXED_NOW_MS).reason, "inactive_status");
  assert.equal(evaluateTelegramSignalEligibility(settings, new Set(), {
    ...signal,
    validationPassed: false
  }, FIXED_NOW_MS).reason, "validation_failed");
  assert.equal(evaluateTelegramSignalEligibility(settings, new Set(), {
    ...signal,
    generatedQualityBlocked: true
  }, FIXED_NOW_MS).reason, "quality_gate_blocked");
  assert.equal(evaluateTelegramSignalEligibility(settings, new Set(), {
    ...signal,
    confidenceCalibration: { ...(signal.confidenceCalibration || {}), blocked: true }
  }, FIXED_NOW_MS).reason, "calibration_blocked");
  assert.equal(evaluateTelegramSignalEligibility(settings, new Set(), {
    ...signal,
    validUntil: new Date(FIXED_NOW_MS - 60_000).toISOString()
  }, FIXED_NOW_MS).reason, "expired");

  const firstQualityGate = await evaluateQualityGateInIsolation(first.result.fullSetup, FIXED_NOW_MS);
  const secondQualityGate = await evaluateQualityGateInIsolation(
    second.result.fullSetup,
    FIXED_NOW_MS + 6 * 60 * 1000
  );
  assert.deepEqual(secondQualityGate, firstQualityGate, "Quality Gate evaluation changed between deterministic runs");
  currentNowMs = FIXED_NOW_MS;

  console.log(JSON.stringify({
    pipeline: {
      valid: first.result.publicResult.valid,
      resultType: first.result.publicResult.resultType,
      persistenceSaves: first.persistence.generatedSaveCalls.length,
      candidateStatus: first.persistence.candidates[0]?.status || null
    },
    signal: summarizeSignal(signal),
    qualityGate: {
      passed: firstQualityGate.passed,
      stage: firstQualityGate.stage || null,
      status: firstQualityGate.status || null,
      reason: firstQualityGate.reason || null
    },
    telegram: eligible,
    deterministicSecondRun: true,
    externalBoundaries: ["Coinbase HTTP fetch", "PostgreSQL transport"]
  }, null, 2));

  async function runIsolatedScan() {
    resetReadySignalTransport();
    const result = await scanMarketSetupDetailed(
      { id: "usr_ready_e2e", role: "tester", plan: "elite" },
      { symbol: "BTC-USD", timeframe: "15m" },
      null,
      { source: "auto_crypto_watcher", generatedBy: "ready-signal-e2e" }
    );
    return { result, persistence: getReadySignalPersistence() };
  }

  async function evaluateQualityGateInIsolation(fullSetup, expectedNowMs) {
    currentNowMs = expectedNowMs;
    resetReadySignalTransport();
    const evaluation = await evaluateGeneratedSignalQualityGate(fullSetup, {
      source: "auto_crypto_watcher"
    });
    assertQualityGateEvaluation(evaluation);
    return evaluation;
  }
} finally {
  globalThis.Date = REAL_DATE;
  globalThis.fetch = REAL_FETCH;
}

function assertReadyResult(result, expectedNowMs) {
  assert.equal(result.publicResult.valid, true);
  assert.equal(result.publicResult.resultType, "ready_signal");
  assert.ok(result.fullSetup);
  const signal = result.fullSetup;
  assert.ok(String(signal.setupKey || "").trim());
  assert.equal(signal.resultType, "ready_signal");
  assert.equal(signal.validationPassed, true);
  assert.equal(signal.status, "Active");
  for (const field of ["confidenceScore", "entryPrice", "stopLoss", "takeProfit", "riskRewardRatio"]) {
    assert.ok(Number.isFinite(Number(signal[field])), `${field} is not finite`);
  }
  assert.ok(["long", "short"].includes(signal.direction));
  assert.ok(["5m", "15m", "1h", "4h"].includes(signal.timeframe));
  const validUntil = new Date(signal.validUntil).getTime();
  assert.ok(Number.isFinite(validUntil) && validUntil > expectedNowMs);
  assert.notEqual(signal.confidenceCalibration?.blocked, true);
  assert.notEqual(signal.confidenceCalibration?.technicalError, true);
  assert.notEqual(signal.generatedQualityBlocked, true);
  assert.notEqual(signal.indicators?.generatedQualityBlocked, true);
  if (signal.direction === "long") {
    assert.ok(signal.stopLoss < signal.entryPrice && signal.entryPrice < signal.takeProfit);
  } else {
    assert.ok(signal.takeProfit < signal.entryPrice && signal.entryPrice < signal.stopLoss);
  }
}

function assertQualityGateEvaluation(evaluation) {
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.status, "passed");
  assert.deepEqual(evaluation.reasons, []);
  assert.equal(evaluation.reason, undefined);
}

function assertPersistence(persistence, signal) {
  assert.equal(persistence.generatedSaveCalls.length, 2, "accepted candidate should save the original signal and its promotion source");
  assert.equal(persistence.generatedRows.length, 1, "accepted signal must map to one immutable snapshot");
  assert.equal(persistence.candidates.length, 1, "accepted setup should retain one candidate record");
  assert.equal(persistence.candidates[0].status, "promoted_to_signal");
  assert.equal(persistence.candidates[0].promoted_signal_id, signal.id);

  const [initialSave, promotionSave] = persistence.generatedSaveCalls;
  assert.equal(initialSave.params[26], "auto_crypto_watcher");
  assert.equal(promotionSave.params[26], "candidate_promotion");
  for (const index of [2, 3, 4, 7, 8, 9, 12, 13, 14, 15, 16, 18, 19, 24, 25, 32]) {
    assert.deepEqual(
      promotionSave.params[index],
      initialSave.params[index],
      `candidate promotion changed immutable generated-signal field at parameter ${index}`
    );
  }

  const row = persistence.generatedRows[0];
  assert.equal(row.status, "Active");
  assert.equal(row.setup_key, signal.setupKey);
  assert.equal(row.pair, signal.symbol);
  assert.equal(row.timeframe, signal.timeframe);
  assert.equal(row.direction, signal.direction);
  assert.equal(row.strategy, signal.setupType);
  assert.equal(Number(row.entry), signal.entryPrice);
  assert.equal(Number(row.stop_loss), signal.stopLoss);
  assert.equal(Number(row.take_profit), signal.takeProfit);
  assert.equal(Number(row.risk_reward), signal.riskRewardRatio);
  assert.equal(Number(row.confidence), signal.confidenceScore);
  assert.equal(new Date(row.valid_until).toISOString(), new Date(signal.validUntil).toISOString());
  assert.deepEqual(row.confidence_calibration, signal.confidenceCalibration || {});
  assert.equal(row.full_analysis.reasoning, signal.reasoning);
  const strategyRiskShadow = row.full_analysis.indicators?.strategyRiskShadowDiagnostics;
  assert.equal(strategyRiskShadow?.version, "strategy_risk_shadow_v1");
  assert.equal(strategyRiskShadow?.invalidationStatus, "MISSING");
  assert.equal(strategyRiskShadow?.productionPlan?.entry, signal.entryPrice);
  assert.equal(strategyRiskShadow?.productionPlan?.stopLoss, signal.stopLoss);
  assert.equal(strategyRiskShadow?.productionPlan?.takeProfit, signal.takeProfit);
  assert.equal(strategyRiskShadow?.productionPlan?.riskReward, signal.riskRewardRatio);
  assert.equal(row.source, "auto_crypto_watcher");
  assert.deepEqual(row.source_history.sort(), ["auto_crypto_watcher", "candidate_promotion"]);
}

function assertDeterministic(left, right) {
  for (const field of [
    "direction",
    "setupType",
    "confidenceScore",
    "entryPrice",
    "stopLoss",
    "takeProfit",
    "riskRewardRatio",
    "readinessScore",
    "validationPassed"
  ]) {
    assert.deepEqual(right[field], left[field], `${field} changed between deterministic runs`);
  }
}

function summarizeSignal(signal) {
  return {
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    setupType: signal.setupType,
    confidence: signal.confidenceScore,
    entry: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    riskReward: signal.riskRewardRatio,
    readiness: signal.readinessScore,
    validationPassed: signal.validationPassed,
    validUntil: signal.validUntil
  };
}

async function deterministicFetch(input) {
  const url = new URL(String(input));
  if (!url.pathname.includes("/candles")) {
    throw new Error(`Unexpected network boundary request: ${url.href}`);
  }
  const granularity = Number(url.searchParams.get("granularity"));
  const candles = buildFixedCandles(granularity, {
    start: new Date(url.searchParams.get("start")).getTime() / 1000,
    end: new Date(url.searchParams.get("end")).getTime() / 1000
  }).map((candle) => [
    candle.time,
    candle.low,
    candle.high,
    candle.open,
    candle.close,
    candle.volume
  ]).reverse();
  return new Response(JSON.stringify(candles), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function buildFixedCandles(granularity, window = {}) {
  const interval = Number.isFinite(granularity) && granularity > 0 ? granularity : 900;
  const latestTime = Math.floor(currentNowMs / 1000 / interval) * interval;
  const firstTime = Math.ceil(Number(window.start ?? latestTime - 119 * interval) / interval) * interval;
  const lastTime = Math.floor(Number(window.end ?? latestTime) / interval) * interval;
  const candles = [];
  for (let time = firstTime; time <= lastTime; time += interval) {
    const index = 120 + Math.round((time - latestTime) / interval);
    const close = 100 + index * 0.03 + Math.sin(index * 0.38 + 1.4) * 0.8;
    const previousClose = candles.at(-1)?.close ?? close - 0.03;
    const isLastCompleted = time === latestTime - interval;
    const open = isLastCompleted ? close - 0.096 : previousClose;
    const padding = 0.144;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + padding,
      low: Math.min(open, close) - padding,
      close,
      volume: isLastCompleted ? 1800 : 1000 + (Math.abs(index) % 7) * 15
    });
  }
  return candles;
}
