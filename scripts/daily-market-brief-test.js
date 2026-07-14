import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDailyMarketBrief,
  buildMarketBriefObservation
} from "../src/modules/signals/dailyMarketBriefService.js";

const root = new URL("../", import.meta.url);
const app = readFileSync(new URL("public/app.js", root), "utf8");
const html = readFileSync(new URL("public/index.html", root), "utf8");
const css = readFileSync(new URL("public/styles.css", root), "utf8");
const signalService = readFileSync(new URL("src/modules/signals/signalService.js", root), "utf8");
const watcher = readFileSync(new URL("src/modules/signals/setupCandidateService.js", root), "utf8");
const controller = readFileSync(new URL("src/modules/signals/signalController.js", root), "utf8");
const notificationService = readFileSync(new URL("src/modules/notifications/notificationService.js", root), "utf8");
const migration = readFileSync(new URL("migrations/039_daily_market_brief.sql", root), "utf8");

const observedAt = "2026-07-13T18:00:00.000Z";
const observations = [
  observation("SOL-USD", "1h", "ready_signal", "Trend Up", "Normal", 88, [], "Momentum breakout"),
  observation("ETH-USD", "1h", "watching_setup", "Trend Up", "Normal", 82, ["Volume confirmation is missing"], "Pullback bounce"),
  observation("BTC-USD", "1h", "avoid_trade", "Range", "Normal", 55, ["Risk/reward is weak across the current structure"]),
  observation("DOGE-USD", "15m", "avoid_trade", "Low Volatility", "Low", 50, ["Volatility is not in a clean tradable range"])
];

const brief = buildDailyMarketBrief({
  observations,
  generatedAt: observedAt,
  scannerSnapshotId: "scan_fixture"
});

assert.equal(brief.available, true);
assert.equal(brief.marketCondition, "Bullish momentum");
assert.equal(brief.strongestPairs[0].symbol, "SOL-USD");
assert.ok(brief.weakestPairs.some((item) => item.symbol === "BTC-USD"));
assert.equal(brief.watchingCount, 1);
assert.equal(brief.avoidCount, 2);
assert.equal(brief.readySignalCount, 1);
assert.equal(brief.pairsScanned, 4);
assert.equal(brief.pairSummaries.length, 4);
assert.ok(brief.mainReasons.some((reason) => /risk\/reward|volume|volatility/i.test(reason)));

const serialized = JSON.stringify(brief);
for (const forbidden of ["entryPrice", "stopLoss", "takeProfit", "entry_price", "stop_loss", "take_profit"]) {
  assert.equal(serialized.includes(forbidden), false, `brief must not reveal ${forbidden}`);
}

const generatedObservation = buildMarketBriefObservation({
  symbol: "ETH-USD",
  timeframe: "15m",
  marketData: {
    pair: { symbol: "ETH-USD", assetClass: "Crypto" },
    regime: {
      label: "Trend Up",
      volatilityLevel: "Normal",
      metrics: { ema20: 2050, ema50: 2000, adx14: 27, rsi14: 58, atrRatio: 1.1 }
    }
  },
  result: {
    valid: true,
    signal: {
      qualityScore: 81,
      setupType: "Pullback bounce",
      confirmations: [{ name: "Volume", passed: false }],
      entryPrice: 2100,
      stopLoss: 2040,
      takeProfit: 2220
    },
    analysis: {}
  },
  readiness: { ready: false, readinessScore: 72, reasons: ["Volume confirmation is missing."] },
  resultType: "watching_setup",
  observedAt
});
assert.equal(generatedObservation.assetClass, "Crypto");
assert.match(generatedObservation.summary, /Watching/i);
assert.equal(Object.hasOwn(generatedObservation, "entryPrice"), false);
assert.equal(Object.hasOwn(generatedObservation, "stopLoss"), false);
assert.equal(Object.hasOwn(generatedObservation, "takeProfit"), false);

const noCleanBrief = buildDailyMarketBrief({
  observations: observations.filter((item) => item.resultType === "avoid_trade"),
  scannerSnapshotId: "scan_no_clean"
});
assert.equal(noCleanBrief.readySignalCount, 0);
assert.ok(noCleanBrief.mainReasons.length > 0);

const unavailable = buildDailyMarketBrief({ observations: [], scannerSnapshotId: "scan_empty" });
assert.equal(unavailable.available, false);
assert.equal(unavailable.marketCondition, "Data unavailable");
assert.match(unavailable.mainReasons[0], /fresh market data/i);

assert.match(html, /Daily Market Brief/);
assert.match(html, /Market briefs are educational summaries/);
assert.match(html, /Market brief unavailable right now/);
assert.match(app, /loadMarketBrief\(\)/);
assert.match(app, /daily-brief-refresh/);
assert.match(app, /renderScanResults\(result\.setups[\s\S]*?result\.marketBrief\)/);
assert.match(signalService, /refreshMarketBriefSafely\(briefObservations, scanSummary\)/);
assert.match(watcher, /refreshDailyMarketBrief\(\{ observations: briefObservations \}\)/);
assert.match(controller, /\/api\/signals\/market-brief/);
assert.doesNotMatch(notificationService, /dailyMarketBrief|marketBrief/);
assert.match(html, /admin-market-brief/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS daily_market_briefs/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS daily_market_brief_observations/);
assert.match(css, /\.daily-market-brief/);
assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.daily-market-brief[\s\S]*?overflow-x: hidden/);

console.log("Daily Market Brief generation, refresh, privacy, admin, Telegram, and mobile tests passed.");

function observation(symbol, timeframe, resultType, regime, volatilityLevel, qualityScore, reasons, setupType = null) {
  const trendDirection = regime === "Trend Up" ? "up" : regime === "Trend Down" ? "down" : "mixed";
  return {
    symbol,
    displaySymbol: symbol.replace("-", ""),
    assetClass: "Crypto",
    timeframe,
    resultType,
    regime,
    volatilityLevel,
    trendDirection,
    qualityScore,
    readinessScore: resultType === "watching_setup" ? 72 : 0,
    setupType,
    reasons,
    volumeConfirmed: resultType === "ready_signal",
    adx: regime.startsWith("Trend") ? 28 : 15,
    rsi: trendDirection === "up" ? 58 : 50,
    atrRatio: volatilityLevel === "Low" ? 0.55 : 1.1,
    observedAt,
    summary: resultType === "ready_signal"
      ? "Stronger upward momentum. A momentum breakout passed the active scanner rules."
      : resultType === "watching_setup"
        ? "Watching a possible pullback bounce; volume confirmation is missing."
        : `${regime === "Range" ? "Range-bound" : "Low volatility"}. ${reasons[0]}.`
  };
}
