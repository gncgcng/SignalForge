import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applyValidationToSignal,
  validateSignalPipeline,
  validationNoSetupAnalysis
} from "../src/modules/signals/signalValidationService.js";

const baseSignal = {
  id: "sig_test",
  setupKey: "BTC-USD:1h:long:1800000000",
  symbol: "BTC-USD",
  timeframe: "1h",
  direction: "long",
  entryPrice: 100,
  stopLoss: 98,
  takeProfit: 104,
  riskRewardRatio: 2,
  confidenceScore: 84,
  qualityScore: 82,
  setupType: "Trend continuation",
  confirmations: [
    { name: "Trend", passed: true },
    { name: "RSI", passed: true },
    { name: "ATR", passed: true },
    { name: "Volume", passed: true },
    { name: "Support", passed: true },
    { name: "Resistance room", passed: true }
  ],
  indicators: {
    atr14: 2,
    validationScore: 100
  },
  newsRisk: {
    blockSignal: false
  }
};

const baseMarketData = {
  pair: {
    symbol: "BTC-USD",
    category: "Crypto",
    assetClass: "Crypto",
    status: "active"
  },
  candles: [
    { time: 1800000000, open: 99, high: 101, low: 98.5, close: 100, volume: 1200 }
  ],
  marketStatus: {
    code: "LIVE",
    label: "Live",
    stale: false
  },
  volumeAvailable: true,
  regime: {
    label: "Trend Up",
    atrPass: true
  }
};

async function validate(signal = {}, marketData = {}, context = {}) {
  return validateSignalPipeline(
    { ...baseSignal, ...signal },
    {
      marketData: {
        ...baseMarketData,
        ...marketData,
        pair: { ...baseMarketData.pair, ...(marketData.pair || {}) }
      },
      recordRejection: false,
      ...context
    }
  );
}

function hasStage(result, stage) {
  return result.rejectedReasons.some((item) => item.stage === stage);
}

const valid = await validate();
assert.equal(valid.passed, true, "valid baseline signal should pass");
assert.equal(valid.confidenceBand, "Strong");

const applied = applyValidationToSignal(baseSignal, valid);
assert.equal(applied.validationPassed, true);
assert.equal(applied.indicators.validationPassed, true);
assert.equal(applied.validationScore, valid.validationScore);

const stale = await validate({}, {
  marketStatus: { code: "DELAYED", stale: true }
});
assert.equal(stale.passed, false);
assert.ok(hasStage(stale, "market_data"));

const providerUnavailable = await validate({}, {
  marketStatus: { code: "PROVIDER_ISSUE", stale: true }
});
assert.equal(providerUnavailable.passed, false);
assert.ok(hasStage(providerUnavailable, "market_data"));

const missingOhlc = await validate({}, {
  candles: [{ time: 1800000000, open: 99, high: null, low: 98, close: 100, volume: 100 }]
});
assert.equal(missingOhlc.passed, false);
assert.ok(hasStage(missingOhlc, "market_data"));

const noAtr = await validate({ indicators: { atr14: null } });
assert.equal(noAtr.passed, false);
assert.ok(hasStage(noAtr, "market_data"));

const badVolume = await validate({}, {
  candles: [{ time: 1800000000, open: 99, high: 101, low: 98, close: 100, volume: 0 }]
});
assert.equal(badVolume.passed, false);
assert.ok(hasStage(badVolume, "market_data"));

const commodityWithoutVolume = await validate(
  { symbol: "XAU/USD", setupKey: "XAU/USD:1h:long:1800000000" },
  {
    pair: { symbol: "XAU/USD", category: "Commodities", assetClass: "Commodity", status: "active" },
    candles: [{ time: 1800000000, open: 99, high: 101, low: 98, close: 100, volume: 0 }],
    volumeAvailable: false
  }
);
assert.equal(commodityWithoutVolume.passed, true, "commodities should not require volume");

const badLongPrices = await validate({ takeProfit: 99 });
assert.equal(badLongPrices.passed, false);
assert.ok(hasStage(badLongPrices, "price"));

const badShortPrices = await validate({
  direction: "short",
  entryPrice: 100,
  stopLoss: 98,
  takeProfit: 102
});
assert.equal(badShortPrices.passed, false);
assert.ok(hasStage(badShortPrices, "price"));

const lowRr = await validate({ riskRewardRatio: 1.2 });
assert.equal(lowRr.passed, false);
assert.ok(hasStage(lowRr, "risk_reward"));

const movedAway = await validate({}, {
  candles: [{ time: 1800000000, open: 100, high: 102, low: 99, close: 101, volume: 1200 }]
});
assert.equal(movedAway.passed, false);
assert.ok(hasStage(movedAway, "current_price"));

const crossedTarget = await validate({}, {
  candles: [{ time: 1800000000, open: 103, high: 105, low: 102, close: 104.2, volume: 1200 }]
});
assert.equal(crossedTarget.passed, false);
assert.ok(hasStage(crossedTarget, "current_price"));

const weakConfidence = await validate({ confidenceScore: 69 });
assert.equal(weakConfidence.passed, false);
assert.ok(hasStage(weakConfidence, "confidence"));

const impossibleConfidence = await validate({ confidenceScore: 100 });
assert.equal(impossibleConfidence.passed, false);
assert.ok(hasStage(impossibleConfidence, "confidence"));

const unknownStrategy = await validate({ setupType: "Magic setup" });
assert.equal(unknownStrategy.passed, false);
assert.ok(hasStage(unknownStrategy, "strategy"));

const duplicate = await validate({}, {}, {
  userId: "usr_test",
  findActiveDuplicateSignal: async () => ({ id: "sig_existing" })
});
assert.equal(duplicate.passed, false);
assert.ok(hasStage(duplicate, "duplicate"));

const marketClosed = await validate(
  { symbol: "XAU/USD", setupKey: "XAU/USD:1h:long:1800000000" },
  {
    pair: { symbol: "XAU/USD", category: "Commodities", assetClass: "Commodity", status: "active" },
    marketStatus: { code: "CLOSED", stale: false },
    volumeAvailable: false
  }
);
assert.equal(marketClosed.passed, false);
assert.ok(hasStage(marketClosed, "session"));

const newsBlocked = await validate({ newsRisk: { blockSignal: true } });
assert.equal(newsBlocked.passed, false);
assert.ok(hasStage(newsBlocked, "session"));

const lowVolatility = await validate({}, {
  regime: { label: "Low Volatility", atrPass: false }
});
assert.equal(lowVolatility.passed, false);
assert.ok(hasStage(lowVolatility, "session"));

const impossible = await validate({ entryPrice: Number.NaN });
assert.equal(impossible.passed, false);
assert.ok(hasStage(impossible, "sanity"));

const zeroStop = await validate({ stopLoss: 100 });
assert.equal(zeroStop.passed, false);
assert.ok(hasStage(zeroStop, "sanity"));

const noSetup = validationNoSetupAnalysis(baseSignal, lowRr);
assert.equal(noSetup.validationPassed, false);
assert.ok(noSetup.rejectedReasons.length);

const signalService = fs.readFileSync("src/modules/signals/signalService.js", "utf8");
const notificationService = fs.readFileSync("src/modules/notifications/notificationService.js", "utf8");
const controller = fs.readFileSync("src/modules/signals/signalController.js", "utf8");
const repositories = fs.readFileSync("src/db/repositories.js", "utf8");
const migration = fs.readFileSync("migrations/027_signal_validation_pipeline.sql", "utf8");
const html = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

assert.ok(signalService.includes("validateSignalPipeline"), "signal service must call validation pipeline");
assert.ok(signalService.includes("validationNoSetupAnalysis"), "failed validation must become diagnostics only");
assert.ok(signalService.includes("applyValidationToSignal"), "passed validation must annotate signals");
assert.ok(signalService.includes('source: "scanner"'), "scanner path must be validated");
assert.ok(signalService.includes('source: "unlock"'), "unlock path must be revalidated");
assert.ok(signalService.includes('source: "telegram_unlock"'), "telegram unlock path must be revalidated");
assert.ok(notificationService.includes("telegramPreferenceMatchesSetup"), "telegram still filters setups before queueing");
assert.ok(controller.includes("enqueueMatchingTelegramNotifications"), "scan all telegram queue must use validated fullSetups");
assert.ok(repositories.includes("findActiveDuplicateSignal"), "duplicate validation repository lookup missing");
assert.ok(repositories.includes("recordSignalValidationRejection"), "validation rejection persistence missing");
assert.ok(repositories.includes("getSignalValidationDashboard"), "validation admin metrics missing");
assert.ok(migration.includes("signal_validation_rejections"), "validation rejection migration missing");
assert.ok(migration.includes("validation_score"), "saved signal validation score migration missing");
assert.ok(html.includes("Validation Dashboard"), "admin validation dashboard missing");
assert.ok(app.includes("renderValidationDashboard"), "admin validation renderer missing");

console.log("Signal validation pipeline tests passed.");
