import { readFileSync } from "node:fs";

const {
  applyLearningAdjustment,
  buildLearningEvent,
  buildPostMortemTags,
  buildSignalSnapshot,
  calculateLearningAdjustment
} = await import("../src/modules/signals/signalLearningService.js");

const migration = readFileSync(
  new URL("../migrations/029_signal_learning_engine.sql", import.meta.url),
  "utf8"
);
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const signalService = readFileSync(new URL("../src/modules/signals/signalService.js", import.meta.url), "utf8");
const outcomeService = readFileSync(new URL("../src/modules/signals/signalOutcomeService.js", import.meta.url), "utf8");
const adminController = readFileSync(new URL("../src/modules/admin/analyticsController.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const baseSignal = {
  id: "sig_test",
  userId: "usr_test",
  symbol: "BTC-USD",
  timeframe: "1h",
  direction: "long",
  setupType: "Pullback bounce",
  entryPrice: 100,
  stopLoss: 95,
  takeProfit: 110,
  riskRewardRatio: 2,
  confidenceScore: 94,
  validationScore: 92,
  generatedAt: "2026-07-09T00:00:00.000Z",
  confirmations: [
    { name: "Trend", passed: true, detail: "Trend aligned." },
    { name: "Volume", passed: false, detail: "Volume was weak." }
  ],
  indicators: {
    regime: "Trend Up",
    volatilityLevel: "Normal",
    session: "New York",
    atr14: 2,
    rsi14: 61,
    adx14: 24,
    ema20: 101,
    ema50: 98,
    volumeMa20: 1000,
    vwapAligned: true,
    volumeProfileAligned: true,
    correlationConflict: false,
    alignmentBadge: "Full Alignment",
    analystStrengths: ["Trend alignment"],
    analystWeaknesses: ["Volume lagged"]
  }
};

const snapshot = buildSignalSnapshot(baseSignal, {
  source: "coinbase-exchange",
  pair: { displaySymbol: "BTCUSD", provider: "coinbase-exchange" },
  candles: [{ time: 1783099436, open: 99, high: 101, low: 98, close: 100, volume: 1200 }]
});
const tpEvent = buildLearningEvent({
  ...baseSignal,
  status: "Hit TP",
  resolvedAt: "2026-07-09T04:00:00.000Z"
});
const slTags = buildPostMortemTags({
  ...baseSignal,
  status: "Hit SL",
  indicators: { ...baseSignal.indicators, correlationConflict: true, rsi14: 72 }
});
const expiredTags = buildPostMortemTags({
  ...baseSignal,
  status: "Expired",
  indicators: { ...baseSignal.indicators, volatilityLevel: "Low Volatility", atrRatio: 0.0005 }
});
const belowSampleAdjustment = calculateLearningAdjustment({
  strategy: { sampleSize: 19, winRate: 90, avgR: 2 },
  marketTimeframe: { sampleSize: 9, winRate: 90, avgR: 2 }
});
const eligibleAdjustment = calculateLearningAdjustment({
  strategy: { sampleSize: 20, winRate: 60, avgR: 0.5 },
  marketTimeframe: { sampleSize: 10, winRate: 57, avgR: 0.3 }
});
const capped = applyLearningAdjustment(
  { ...baseSignal, confidenceScore: 98 },
  {
    strategy: { sampleSize: 20, winRate: 80, avgR: 2 },
    marketTimeframe: { sampleSize: 10, winRate: 80, avgR: 2 }
  }
);

const result = {
  migrationCreatesSnapshotAndLearningTables: [
    "signal_snapshots",
    "signal_learning_events",
    "strategy_learning_stats",
    "factor_learning_stats",
    "market_timeframe_learning_stats"
  ].every((name) => migration.includes(name)),
  immutableSnapshotShape: snapshot.pair === "BTC-USD" &&
    snapshot.displayPair === "BTCUSD" &&
    snapshot.latestCandle.close === 100 &&
    snapshot.checklist.length === 2,
  tpPostMortemCreatesLearningEvent: tpEvent.outcome === "Hit TP" &&
    tpEvent.netR === 2 &&
    tpEvent.postMortemTags.includes("confirmed_trend"),
  slPostMortemCreatesFailureTags: slTags.includes("correlation_conflict") &&
    slTags.includes("rsi_too_extended"),
  expiredPostMortemCreatesExpirationTags: expiredTags.includes("low_volatility") &&
    expiredTags.includes("no_momentum_follow_through"),
  minimumSampleSizesEnforced: belowSampleAdjustment === 0 && eligibleAdjustment > 0,
  learningCannotPushConfidenceAbove99: capped.confidenceScore === 99,
  learningCannotOverrideValidation: signalService.indexOf("validateSignalForPublication") <
    signalService.indexOf("applyLearningToValidatedSignal"),
  postMortemHookedToOutcomeTracker: outcomeService.includes("runSignalPostMortem") &&
    outcomeService.includes("recordSignalLearningEvent"),
  snapshotStoredOnUnlock: signalService.includes("recordLearningSnapshot") &&
    repositories.includes("saveSignalSnapshot"),
  adminLearningDashboardAdminOnly: adminController.includes("isAdminUser") &&
    adminController.includes("getAdminLearningDashboard") &&
    html.includes("Learning Dashboard"),
  userFacingLearningInsightSafe: app.includes("Historical learning insight") &&
    app.includes("Educational context only") &&
    !app.includes("learning.userId") &&
    !app.includes("learning.email")
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}
