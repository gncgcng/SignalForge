import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSignalReview,
  findOutcomeCandleTime,
  getSignalReview
} from "../src/modules/signal-review/signalReviewService.js";
import {
  addPaperDrawingPoint,
  candleAtPaperChartCoordinate,
  deletePaperDrawing,
  getSignalReviewLevels,
  priceAtPaperChartCoordinate
} from "../public/paperChartUtils.js";

const app = read("public/app.js");
const controller = read("src/modules/paper-trading/paperTradingController.js");
const paperService = read("src/modules/paper-trading/paperTradingService.js");
const repository = read("src/modules/signal-review/signalReviewRepository.js");
const reviewService = read("src/modules/signal-review/signalReviewService.js");
const serviceWorker = read("public/service-worker.js");
const baseSignal = {
  id: "agen-1",
  signalId: "saved-1",
  setupKey: "btc-15m-long-1",
  symbol: "BTC-USD",
  displaySymbol: "BTCUSD",
  provider: "coinbase-exchange",
  timeframe: "15m",
  direction: "long",
  strategy: "Breakout retest",
  entry: 62000.125,
  stopLoss: 61500.5,
  takeProfit: 63000.75,
  riskReward: 2.002,
  confidence: 84,
  status: "Active",
  source: "manual_scan",
  createdAt: "2026-08-15T12:00:00.000Z",
  validUntil: "2026-08-15T18:00:00.000Z",
  hitTpAt: null,
  hitSlAt: null,
  expiredAt: null,
  outcomeEvaluatedAt: null,
  realizedR: null,
  resultReason: null,
  legacy: false
};
const candles = Array.from({ length: 80 }, (_, index) => ({
  time: Date.parse("2026-08-15T06:00:00.000Z") / 1000 + index * 900,
  open: 61900 + index,
  high: 62020 + index,
  low: 61850 + index,
  close: 61940 + index,
  volume: 100 + index
}));

const active = await runReview(baseSignal);
assert.equal(active.review.symbol, "BTC-USD");
assert.equal(active.review.timeframe, "15m");
assert.equal(active.review.direction, "long");
assert.equal(active.review.entry, 62000.125);
assert.equal(active.review.stopLoss, 61500.5);
assert.equal(active.review.takeProfit, 63000.75);
assert.equal(active.chart.available, true);

const fakeBrowserValues = { entry: 1, stopLoss: 2, takeProfit: 3, direction: "short", status: "Hit TP" };
const fakeIgnored = await getSignalReview({ id: "user-a" }, "agen-1", {
  findSignal: async (id) => ({ ...baseSignal, id }),
  loadMarketData: async () => ({ candles, latestPrice: candles.at(-1).close, source: "fixture" }),
  ...fakeBrowserValues
});
assert.equal(fakeIgnored.review.entry, baseSignal.entry);
assert.equal(fakeIgnored.review.direction, baseSignal.direction);
assert.equal(fakeIgnored.review.status, "Active");

const hitSlSignal = { ...baseSignal, status: "Hit SL", hitSlAt: "2026-08-15T14:15:00.000Z", realizedR: -1 };
const hitTpSignal = { ...baseSignal, status: "Hit TP", hitTpAt: "2026-08-15T14:30:00.000Z", realizedR: 2.002 };
const expiredSignal = { ...baseSignal, status: "Expired", expiredAt: "2026-08-15T18:00:00.000Z", realizedR: 0 };
assert.equal(buildSignalReview(hitSlSignal).status, "Hit SL");
assert.equal(buildSignalReview(hitSlSignal).realizedR, -1);
assert.equal(buildSignalReview(hitTpSignal).status, "Hit TP");
assert.equal(buildSignalReview(hitTpSignal).realizedR, 2.002);
assert.equal(buildSignalReview(expiredSignal).status, "Expired");
assert.equal(findOutcomeCandleTime(candles, hitTpSignal.hitTpAt, "15m"), Date.parse(hitTpSignal.hitTpAt) / 1000);

let reads = 0;
let marketReads = 0;
const failedChart = await getSignalReview({ id: "user-a" }, "agen-1", {
  findSignal: async () => { reads += 1; return baseSignal; },
  loadMarketData: async () => { marketReads += 1; throw new Error("fixture provider unavailable"); }
});
assert.equal(failedChart.review.status, "Active");
assert.equal(failedChart.chart.available, false);
assert.equal(failedChart.chart.message, "Historical chart data is unavailable for this signal.");
assert.equal(reads, 1);
assert.equal(marketReads, 1);

const autoWatcher = await runReview({ ...baseSignal, id: "agen-auto", source: "auto_crypto_watcher" });
const manualScan = await runReview({ ...baseSignal, id: "agen-manual", source: "manual_scan" });
assert.equal(autoWatcher.review.source, "auto_crypto_watcher");
assert.equal(manualScan.review.source, "manual_scan");

const dimensions = { left: 0, right: 0, top: 0, bottom: 0, width: 100, height: 100, min: 100, max: 200 };
assert.equal(priceAtPaperChartCoordinate(50, dimensions), 150);
assert.equal(candleAtPaperChartCoordinate(25, candles.slice(0, 4), dimensions).candle.time, candles[1].time);
assert.deepEqual(getSignalReviewLevels(baseSignal).map(({ type, price }) => ({ type, price })), [
  { type: "entry", price: 62000.125 },
  { type: "stop", price: 61500.5 },
  { type: "target", price: 63000.75 }
]);

const reviewSnapshot = JSON.stringify(baseSignal);
const horizontal = addPaperDrawingPoint([], {
  tool: "horizontal", id: "drawing-h", symbol: "BTC-USD", timeframe: "15m", price: 62100
});
assert.equal(horizontal.drawings[0].type, "horizontal");
const trendStart = addPaperDrawingPoint(horizontal.drawings, {
  tool: "trend", id: "unused", symbol: "BTC-USD", timeframe: "15m", time: candles[2].time, price: 61950
});
const trendEnd = addPaperDrawingPoint(trendStart.drawings, {
  tool: "trend", id: "drawing-t", symbol: "BTC-USD", timeframe: "15m", time: candles[8].time, price: 62250, pending: trendStart.pending
});
assert.equal(trendEnd.drawings[1].type, "trend");
assert.deepEqual(deletePaperDrawing(trendEnd.drawings, "drawing-h").map((item) => item.id), ["drawing-t"]);
assert.equal(JSON.stringify(baseSignal), reviewSnapshot);

assert.ok(controller.includes("/api\\/paper-trades\\/signal-review") && controller.includes("getSignalReview(req.user"));
assert.match(repository, /JOIN unlocked_signals/);
assert.match(repository, /telegram_notification_queue/);
assert.match(repository, /q\.status = 'sent'/);
assert.doesNotMatch(repository, /generated_by\s*=\s*\$2/);
assert.match(paperService, /if \(!reviewOnly\) await expirePendingPaperOrders/);
assert.match(paperService, /if \(!reviewOnly\) \{/);
assert.match(paperService, /reviewOnly \? findPaperAccount\(user\.id\) : getPaperAccount\(user\.id\)/);
assert.doesNotMatch(reviewService, /saveGeneratedSignal|updateGeneratedSignalStatus|credit|strategy.*write/i);
assert.match(app, /data-review-signal-id/);
assert.match(app, /getSignalReviewLevels\(state\.paperTrading\.signalReview\)/);
assert.match(app, /paperCrosshairPriceLabel\.textContent/);
assert.match(app, /paperCrosshairTimeLabel\.textContent/);
assert.match(app, /event\.preventDefault\(\);[\s\S]*chart\.visibleCount/);
assert.match(app, /chart\.drawings = deletePaperDrawing/);
assert.match(serviceWorker, /"\/paperChartUtils\.js"/);

console.log(JSON.stringify({
  tests: { passed: 19, failed: 0 },
  activeReview: {
    symbol: active.review.symbol,
    timeframe: active.review.timeframe,
    direction: active.review.direction,
    entry: active.review.entry,
    stopLoss: active.review.stopLoss,
    takeProfit: active.review.takeProfit
  },
  outcomes: { hitSl: -1, hitTp: 2.002, expired: true },
  security: { browserValuesIgnored: true, unlockedOrSentAuthorizationRequired: true },
  readOnly: { strategyWrites: 0, creditWrites: 0, softCandleFailure: true },
  chart: { crosshairPrice: 150, crosshairTime: candles[1].time, localDrawings: true }
}, null, 2));

async function runReview(signal) {
  return getSignalReview({ id: "user-a" }, signal.id, {
    findSignal: async () => signal,
    loadMarketData: async () => ({ candles, latestPrice: candles.at(-1).close, source: "fixture" })
  });
}

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

