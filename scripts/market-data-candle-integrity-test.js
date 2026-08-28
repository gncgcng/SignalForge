import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  aggregateHourlyCandlesToFourHours,
  inspectCandleIntervals,
  normalizeCanonicalCandles,
  selectCompletedCandles,
  timeframeDurationSeconds
} from "../src/modules/market-data/candleIntegrity.js";

const nowMs = Date.parse("2026-08-27T10:30:00.000Z");
const boundaryMs = Date.parse("2026-08-27T12:00:00.000Z");
const hourStart = Date.parse("2026-08-27T00:00:00.000Z") / 1000;

assert.equal(timeframeDurationSeconds["4h"], 14400, "4h must mean 14,400 seconds.");
assert.equal(Object.values(timeframeDurationSeconds).includes(21600), false, "No supported timeframe may use 21,600-second semantics.");

const componentHours = Array.from({ length: 12 }, (_, index) => candle(hourStart + index * 3600, 100 + index));
const aggregated = aggregateHourlyCandlesToFourHours(componentHours, { nowMs: boundaryMs, completedOnly: true });
assert.deepEqual(aggregated.map((item) => new Date(item.time * 1000).getUTCHours()), [0, 4, 8]);
assert.deepEqual(aggregated[0], {
  time: hourStart,
  open: 100,
  high: 104,
  low: 99,
  close: 103.5,
  volume: 408
});

const partialAt1030 = aggregateHourlyCandlesToFourHours(componentHours, { nowMs, completedOnly: true });
assert.deepEqual(partialAt1030.map((item) => new Date(item.time * 1000).getUTCHours()), [0, 4]);
const visualAt1030 = aggregateHourlyCandlesToFourHours(componentHours, { nowMs, completedOnly: false });
assert.equal(new Date(visualAt1030.at(-1).time * 1000).getUTCHours(), 4, "A visual 4h series must not fabricate a partial synthetic bucket.");

for (const [timeframe, duration] of Object.entries(timeframeDurationSeconds)) {
  const start = Math.floor(nowMs / 1000 / duration) * duration;
  const source = [candle(start - duration, 100), candle(start, 101)];
  const selected = selectCompletedCandles(source, timeframe, { nowMs });
  assert.equal(selected.at(-1).time, start - duration, `${timeframe} must exclude its forming bucket.`);
  const boundarySelected = selectCompletedCandles(source, timeframe, { nowMs: (start + duration) * 1000 });
  assert.equal(boundarySelected.at(-1).time, start, `${timeframe} must accept a candle exactly at its close boundary.`);
}

const missingHour = componentHours.filter((item) => item.time !== hourStart + 6 * 3600);
assert.equal(
  aggregateHourlyCandlesToFourHours(missingHour, { nowMs: boundaryMs, completedOnly: true }).some((item) => item.time === hourStart + 4 * 3600),
  false,
  "A missing component hour must prevent the affected 4h candle from being fabricated."
);

const disorderedDuplicates = [componentHours[2], componentHours[0], componentHours[1], componentHours[1]];
const canonical = normalizeCanonicalCandles(disorderedDuplicates);
assert.deepEqual(canonical.map((item) => item.time), [hourStart, hourStart + 3600, hourStart + 7200]);
const gapInspection = inspectCandleIntervals([componentHours[0], componentHours[2]], "1h");
assert.equal(gapInspection.missingIntervalCount, 1, "Missing provider intervals must be reported explicitly.");

const requests = [];
globalThis.fetch = async (input) => {
  const url = new URL(input);
  const granularity = Number(url.searchParams.get("granularity"));
  requests.push({
    symbol: decodeURIComponent(url.pathname.split("/products/")[1].split("/candles")[0]),
    granularity,
    start: url.searchParams.get("start"),
    end: url.searchParams.get("end")
  });
  const start = Math.ceil(new Date(url.searchParams.get("start")).getTime() / 1000 / granularity) * granularity;
  const end = Math.floor(new Date(url.searchParams.get("end")).getTime() / 1000 / granularity) * granularity;
  const rows = [];
  for (let time = start; time <= end; time += granularity) {
    const base = 100 + (time % 100000) / 100000;
    rows.push([time, base - 1, base + 1, base, base + 0.25, 10]);
  }
  rows.reverse();
  if (rows.length > 20) rows.push(rows[10]);
  return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
};

const { getCandlesFromCoinbase } = await import("../src/modules/market-data/coinbaseMarketDataProvider.js");
const completed15m = await getCandlesFromCoinbase("INTEGRITY15-USD", "15m", { completedOnly: true, nowMs });
assert.equal(completed15m.candles.length, 120, "Removing a forming 15m candle must not reduce the requested completed count.");
assert.ok(completed15m.candles.every((item) => item.time + 900 <= Math.floor(nowMs / 1000)));

const completed4h = await getCandlesFromCoinbase("INTEGRITY4H-USD", "4h", { completedOnly: true, nowMs });
assert.equal(completed4h.candles.length, 120, "1h pagination must preserve 120 completed 4h candles.");
assert.ok(completed4h.candles.every((item) => item.time % 14400 === 0));
assert.ok(completed4h.candles.every((item) => item.time + 14400 <= Math.floor(nowMs / 1000)));
assert.equal(requests.filter((item) => item.symbol === "INTEGRITY4H-USD").every((item) => item.granularity === 3600), true);
assert.equal(requests.some((item) => item.granularity === 21600), false, "Coinbase must never receive a 21,600-second request for 4h.");
assert.ok(requests.filter((item) => item.symbol === "INTEGRITY4H-USD").length > 1, "4h history must page within Coinbase limits.");

const visual4h = await getCandlesFromCoinbase("INTEGRITY4H-USD", "4h", { completedOnly: false, nowMs });
assert.equal(visual4h.candleContract, "live_visual");
assert.equal(new Date(visual4h.candles.at(-1).time * 1000).getUTCHours(), 4);

const signalServiceSource = read("src/modules/signals/signalService.js");
const autoScanSource = read("src/modules/alerts/autoScanService.js");
const multiTimeframeSource = read("src/modules/market-data/multiTimeframeService.js");
const providerSource = read("src/modules/market-data/coinbaseMarketDataProvider.js");
assert.match(signalServiceSource, /scanMarketSetupDetailed/);
assert.match(autoScanSource, /scanMarketSetupDetailed/);
assert.match(multiTimeframeSource, /getStrategyOhlcv\(symbol, timeframe\)/);
assert.doesNotMatch(providerSource, /"4h"\s*:\s*21600/);

const report = {
  fourHourSemanticSeconds: timeframeDurationSeconds["4h"],
  fourHourProviderGranularities: [...new Set(requests.filter((item) => item.symbol === "INTEGRITY4H-USD").map((item) => item.granularity))],
  completed15mCount: completed15m.candles.length,
  completed4hCount: completed4h.candles.length,
  fourHourPages: requests.filter((item) => item.symbol === "INTEGRITY4H-USD").length,
  latestCompleted4h: new Date(completed4h.candles.at(-1).time * 1000).toISOString(),
  latestVisual4h: new Date(visual4h.candles.at(-1).time * 1000).toISOString(),
  missingIntervalsReported: gapInspection.missingIntervalCount,
  strategyContract: "manual and watcher both enter scanMarketSetupDetailed -> getMultiTimeframeMarketData -> getStrategyOhlcv"
};
console.log(JSON.stringify(report, null, 2));

function candle(time, open) {
  return { time, open, high: open + 1, low: open - 1, close: open + 0.5, volume: open + 0.5 };
}

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

