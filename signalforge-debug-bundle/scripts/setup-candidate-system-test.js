import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateCandidateOutcome, evaluateSetupReadiness } from "../src/modules/signals/setupCandidateService.js";
import { calculatePaperStats, normalizePaperOrder, recommendSignalPaperAction } from "../src/modules/paper-trading/paperTradingService.js";

const baseSignal = {
  id: "setup-1", setupKey: "BTC-USD:15m:long:1", symbol: "BTC-USD", timeframe: "15m",
  direction: "long", setupType: "Pullback bounce", entryPrice: 100, stopLoss: 98,
  takeProfit: 104, riskRewardRatio: 2, confidenceScore: 86, qualityScore: 82,
  alignmentBadge: "Full Alignment", confirmations: [
    { name: "Trend", passed: true }, { name: "Volume", passed: true }
  ], indicators: { atr14: 2 }
};

const market = (price, high = price + 0.4, low = price - 0.4, open = price - 0.1) => ({
  pair: { lastPrice: price, category: "Crypto" }, source: "coinbase-exchange",
  candles: [{ time: 1, open, high, low, close: price, volume: 100 }]
});

const ready = evaluateSetupReadiness(baseSignal, market(100));
assert.equal(ready.ready, true, "aligned entry should promote only after readiness passes");
assert.ok(["excellent", "good"].includes(ready.entryQuality));

const watching = evaluateSetupReadiness(baseSignal, market(101.6));
assert.equal(watching.ready, false, "promising setup away from entry must remain watching");
assert.equal(watching.entryQuality, "fair");

const noCandleConfirmation = evaluateSetupReadiness(baseSignal, market(100, 100.4, 99.6, 100.2));
assert.equal(noCandleConfirmation.ready, false, "a candidate must wait for directional candle confirmation");
assert.ok(noCandleConfirmation.reasons.includes("Candle confirmation is missing."));

const noVolume = evaluateSetupReadiness({
  ...baseSignal,
  confirmations: [{ name: "Trend", passed: true }, { name: "Volume", passed: false }]
}, market(100));
assert.equal(noVolume.ready, false, "crypto candidates must wait for volume confirmation");

const rejected = evaluateSetupReadiness({ ...baseSignal, riskRewardRatio: 1.2 }, market(100));
assert.equal(rejected.rejected, true, "poor RR must reject candidate");
assert.equal(evaluateSetupReadiness(baseSignal, market(97.5)).rejectionReason, "Setup invalidated.");

const invalidated = evaluateCandidateOutcome({
  id: "candidate", direction: "long", currentPrice: 100,
  idealEntryZone: { low: 99.8, high: 100.2 }, potentialStopLoss: 98,
  potentialTakeProfit: 104, rejectionReason: "Entry quality deteriorated."
}, [{ low: 99.9, high: 100.4 }, { low: 97.8, high: 101 }]);
assert.equal(invalidated.wouldHaveHitSl, true);
assert.equal(invalidated.wouldHaveHitTp, false);

assert.equal(recommendSignalPaperAction(baseSignal, 100.2, 2).action, "market");
assert.equal(recommendSignalPaperAction(baseSignal, 102, 2).action, "watch");
const expiringLimit = normalizePaperOrder({ symbol: "BTC-USD", timeframe: "15m", direction: "long", orderType: "limit", positionSizeUsd: 1000, limitPrice: 100, stopLoss: 98, takeProfit: 104 }, 101);
assert.ok(new Date(expiringLimit.expiresAt).getTime() > Date.now(), "pending limit needs an expiry");

const paperStats = calculatePaperStats([
  { status: "Hit TP", realizedR: 2, symbol: "BTC-USD", timeframe: "15m" },
  { status: "Hit SL", realizedR: -1, symbol: "BTC-USD", timeframe: "15m" },
  { status: "Expired unfilled", realizedR: 0, symbol: "ETH-USD", timeframe: "1h" }
]);
assert.equal(paperStats.winRate, 50, "unfilled pending orders must not affect win rate");
assert.equal(paperStats.averageR, 0.5, "unfilled pending orders must not dilute average R");
assert.equal(paperStats.totalPaperTrades, 2, "unfilled pending orders are not executed trades");

const migration = readFileSync("migrations/032_setup_candidates.sql", "utf8");
const readinessMigration = readFileSync("migrations/035_crypto_candidate_readiness.sql", "utf8");
const service = readFileSync("src/modules/signals/signalService.js", "utf8");
const watcher = readFileSync("src/modules/alerts/autoScanService.js", "utf8");
const repository = readFileSync("src/modules/signals/setupCandidateRepository.js", "utf8");
const paperRepository = readFileSync("src/db/repositories.js", "utf8");
const app = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");

assert.match(migration, /CREATE TABLE IF NOT EXISTS setup_candidates/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS candidate_learning_events/);
assert.match(readinessMigration, /almost_ready/);
assert.match(readinessMigration, /ADD COLUMN IF NOT EXISTS setup_quality_score/);
assert.match(readinessMigration, /ADD COLUMN IF NOT EXISTS entry_never_filled/);
assert.match(readinessMigration, /shadow_adjustment_applied/);
assert.match(service, /readiness\?\.ready/);
assert.match(service, /validation\?\.passed/);
assert.match(service, /markCandidatePromoted/);
assert.match(watcher, /\[crypto-watch\] scanned=/);
assert.match(watcher, /category === "Crypto"/);
assert.doesNotMatch(watcher, /category === "Commodities"/);
assert.match(repository, /ON CONFLICT \(candidate_id\) DO UPDATE/);
assert.match(repository, /entry_never_filled/);
assert.match(repository, /shadow_confidence_adjustment/);
assert.match(repository, /shadow_adjustment_applied = false/);
assert.match(repository, /if \(candidate\) await recordCandidateLearningEvent\(candidate\)/);
assert.match(repository, /status = 'expired'/);
assert.match(repository, /recordCandidateLearningEvent\(candidate\)/);
assert.match(paperRepository, /status = 'Expired unfilled'/);
assert.match(paperRepository, /Signal entry never filled in Paper Trading/);
assert.match(app, /paperOrderType\.value = closeToEntry \? "market" : "watch"/);
assert.match(app, /This entry is away from current price and may remain pending/);
assert.match(html, /Watching setups/);
assert.match(html, /Confidence reflects rule alignment, not the probability of profit/);

console.log("Setup candidate, readiness, learning, and paper-order tests passed.");
