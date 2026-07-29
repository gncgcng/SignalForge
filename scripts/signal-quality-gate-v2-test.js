import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifySignalMistakeLabels,
  evaluateSignalQualityGateV2,
  repairUnrealisticTakeProfit,
  summarizeUserFacingGateReason
} from "../src/modules/signals/signalQualityGateV2Service.js";

const baseMarket = {
  volumeAvailable: true,
  regime: { label: "trending up", metrics: { atr14: 2 } },
  candles: [{ open: 100, high: 101, low: 99, close: 100.5, volume: 1200 }],
  levels: { support: 96, resistance: 112 }
};

const baseSignal = {
  id: "sig_quality_v2",
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  setupType: "Breakout Retest",
  entryPrice: 100,
  stopLoss: 97,
  takeProfit: 107,
  riskRewardRatio: 2.33,
  confidenceScore: 82,
  qualityScore: 82,
  readinessScore: 85,
  entryQuality: "good",
  alignmentBadge: "Full Alignment",
  marketStructure: { retestConfirmed: true, stopStructural: true },
  indicators: {
    atr14: 2,
    volumeConfirmed: true,
    regime: "trending up",
    support: 96,
    resistance: 112,
    qualityGatePassed: true
  },
  confirmations: [
    { name: "Retest", passed: true, detail: "Broken level retested and held." },
    { name: "Volume", passed: true, detail: "Volume expanded on confirmation." },
    { name: "Structure", passed: true, detail: "Breakout structure is clear." }
  ]
};

assert.equal(evaluateSignalQualityGateV2(baseSignal, { marketData: baseMarket }).passed, true, "clean setup should pass v2 gate");

const weakRetest = evaluateSignalQualityGateV2({
  ...baseSignal,
  marketStructure: { stopStructural: true },
  confirmations: baseSignal.confirmations.filter((item) => item.name !== "Retest")
}, { marketData: baseMarket });
assert.equal(weakRetest.passed, false);
assert.equal(weakRetest.status, "weak_strategy_match");
assert.equal(weakRetest.reasonCode, "breakout_without_retest");

const momentumRange = evaluateSignalQualityGateV2({
  ...baseSignal,
  setupType: "Momentum Breakout",
  indicators: { ...baseSignal.indicators, regime: "range-bound choppy" }
}, { marketData: { ...baseMarket, regime: { label: "range-bound choppy", metrics: { atr14: 2 } } } });
assert.equal(momentumRange.status, "bad_market_regime", "momentum breakout should be blocked in range-bound conditions");

assert.equal(evaluateSignalQualityGateV2({ ...baseSignal, entryQuality: "fair" }, { marketData: baseMarket }).reasonCode, "late_entry");
assert.equal(evaluateSignalQualityGateV2({ ...baseSignal, stopLoss: 101 }, { marketData: baseMarket }).status, "invalid_stop_loss");
assert.equal(evaluateSignalQualityGateV2({ ...baseSignal, takeProfit: 130 }, { marketData: baseMarket }).reasonCode, "tp_too_far_for_timeframe");
const repairedTarget = repairUnrealisticTakeProfit({ ...baseSignal, takeProfit: 130, riskRewardRatio: 10 }, baseMarket);
assert.equal(repairedTarget.indicators.takeProfitRecalculated, true);
assert.ok(repairedTarget.takeProfit < 112, "recalculated long target should sit before nearby resistance");
assert.ok(repairedTarget.riskRewardRatio >= 1.5, "recalculated target must retain minimum R/R");
assert.equal(evaluateSignalQualityGateV2(repairedTarget, { marketData: baseMarket }).passed, true);
assert.equal(
  repairUnrealisticTakeProfit({ ...baseSignal, takeProfit: 130, stopLoss: 99.5 }, baseMarket).takeProfit,
  130,
  "target repair must not hide another invalid quality condition"
);
assert.equal(evaluateSignalQualityGateV2({ ...baseSignal, riskRewardRatio: 1.2 }, { marketData: baseMarket }).status, "weak_risk_reward");

const htfConflict = evaluateSignalQualityGateV2({
  ...baseSignal,
  setupType: "Trend Continuation",
  alignmentBadge: "Countertrend"
}, { marketData: baseMarket });
assert.equal(htfConflict.reasonCode, "higher_timeframe_conflict");

const loserLike = evaluateSignalQualityGateV2(baseSignal, {
  marketData: baseMarket,
  historicalSimilarity: { similarityToWinners: 0.44, similarityToLosers: 0.72, nearestLosingExamples: [{ id: "loss_1" }] }
});
assert.equal(loserLike.status, "similar_to_past_losers");
assert.equal(loserLike.nearestLosingExamples.length, 1);

const winnerLike = evaluateSignalQualityGateV2(baseSignal, {
  marketData: baseMarket,
  historicalSimilarity: { similarityToWinners: 0.78, similarityToLosers: 0.42, nearestWinningExamples: [{ id: "win_1" }] }
});
assert.equal(winnerLike.passed, true, "winner similarity can support but should not bypass validation failures");
assert.equal(evaluateSignalQualityGateV2({ ...baseSignal, stopLoss: 100 }, {
  marketData: baseMarket,
  historicalSimilarity: { similarityToWinners: 0.9, similarityToLosers: 0.1 }
}).passed, false, "winner similarity must not bypass stop validation");

const repeatedMistake = evaluateSignalQualityGateV2(baseSignal, {
  marketData: baseMarket,
  repeatedMistakes: { false_breakout: 3 }
});
assert.equal(repeatedMistake.reasonCode, "repeated_mistake_pattern");

const mistakes = classifySignalMistakeLabels({
  ...baseSignal,
  status: "Hit SL",
  indicators: {
    ...baseSignal.indicators,
    qualityGateV2: {
      checks: [
        { passed: false, reasonCode: "entry_chasing_after_move" },
        { passed: false, reasonCode: "weak_breakout_volume" }
      ]
    }
  }
});
assert.ok(mistakes.includes("entered_too_late"));
assert.ok(mistakes.includes("weak_volume"));
assert.ok(mistakes.includes("false_breakout"));

assert.match(summarizeUserFacingGateReason(momentumRange), /No clean signal yet/);
assert.doesNotMatch(summarizeUserFacingGateReason(momentumRange), /momentum_breakout_in_range|raw|json/i);

const gateService = readFileSync("src/modules/signals/generatedSignalQualityGate.js", "utf8");
const telegramDiagnostics = readFileSync("src/modules/notifications/telegramAlertDiagnosticsService.js", "utf8");
const repository = readFileSync("src/modules/signals/signalQualityGateRepository.js", "utf8");
const generatedService = readFileSync("src/modules/admin-signals/generatedSignalService.js", "utf8");
const generatedRepository = readFileSync("src/modules/admin-signals/generatedSignalRepository.js", "utf8");
const generatedController = readFileSync("src/modules/admin-signals/generatedSignalController.js", "utf8");
const autoScanService = readFileSync("src/modules/alerts/autoScanService.js", "utf8");
const signalService = readFileSync("src/modules/signals/signalService.js", "utf8");
const publicApp = readFileSync("public/app.js", "utf8");
const migration = readFileSync("migrations/055_signal_quality_gate_v2.sql", "utf8");
const dedupeMigration = readFileSync("migrations/056_signal_quality_gate_diagnostics_dedupe.sql", "utf8");

assert.match(gateService, /evaluateSignalQualityGateV2/);
assert.match(gateService, /qualityGatePassed: false/);
assert.match(telegramDiagnostics, /qualityGatePassed !== true/);
assert.match(telegramDiagnostics, /Signal Quality Gate blocked Telegram alert/);
assert.match(telegramDiagnostics, /evaluateGeneratedSignalTelegramDecision/);
assert.match(telegramDiagnostics, /telegram_blocked_low_confidence/);
assert.match(telegramDiagnostics, /telegram_blocked_quarantined_timeframe/);
assert.match(telegramDiagnostics, /telegram_blocked_failed_quality_gate/);
assert.match(repository, /quality_gate_reason_stats/);
assert.match(repository, /OFFSET \$1/);
assert.match(repository, /ON CONFLICT \(dedupe_key\)/);
assert.match(repository, /event_count = signal_quality_gate_results\.event_count \+ 1/);
assert.match(repository, /blockedBeforeUsers/);
assert.match(repository, /quarantined_timeframe/);
assert.doesNotMatch(repository, /reason: item\.reason,\s*strategy/s);
assert.match(generatedService, /qualityGate/);
assert.match(generatedService, /ensureGeneratedSignalQualityGate/);
assert.match(generatedService, /recordGeneratedSignalTelegramDecision/);
assert.match(generatedService, /evaluateGeneratedSignalTelegramDecision/);
assert.match(generatedRepository, /qualityGateDisplayStatus/);
assert.match(generatedRepository, /userVisibility/);
assert.match(generatedRepository, /telegramDecisionLabel/);
assert.match(generatedController, /\/api\/admin\/signals\/quality-gate/);
assert.match(autoScanService, /trackQualityGateRunDecision/);
assert.match(autoScanService, /logQualityGateRunSummary\("auto_crypto_watcher"/);
assert.match(autoScanService, /\[telegram-alerts\] checked=/);
assert.match(signalService, /qualityGateDecision/);
assert.match(signalService, /\[quality-gate\] source=\$\{source\}/);
assert.match(publicApp, /Signal Quality Gate v2/);
assert.match(publicApp, /admin-signal-quality-gate/);
assert.match(publicApp, /loadAdminSignalQualityGate/);
assert.match(publicApp, /Recent rejected setups/);
assert.match(publicApp, /Blocked before users see them/);
assert.match(publicApp, /Quality Gate/);
assert.match(publicApp, /Telegram status: Not evaluated/);
assert.match(publicApp, /admin-detail-section/);
assert.match(migration, /signal_quality_gate_results/);
assert.match(migration, /quality_gate_reason_stats/);
assert.match(dedupeMigration, /dedupe_key/);
assert.match(dedupeMigration, /event_count/);
assert.match(dedupeMigration, /idx_signal_quality_gate_results_dedupe/);

console.log("Signal Quality Gate v2 tests passed.");
