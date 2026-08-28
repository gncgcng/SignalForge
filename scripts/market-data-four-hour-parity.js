import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { aggregateHourlyCandlesToFourHours } from "../src/modules/market-data/candleIntegrity.js";

const dataFolder = resolve(argument("--data-folder") || "C:\\Users\\monge\\Documents\\SignalForgeData");
const symbols = ["btc", "eth", "sol"];
const reports = [];

for (const symbol of symbols) {
  const path = join(dataFolder, `${symbol}-historical-manifest.json`);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const hourly = normalizeManifestCandles(manifest.candles?.["1h"] || []);
  const storedFourHour = normalizeManifestCandles(manifest.candles?.["4h"] || []);
  const afterLastBucket = (hourly.at(-1)?.time + 8 * 3600) * 1000;
  const aggregated = aggregateHourlyCandlesToFourHours(hourly, {
    completedOnly: true,
    nowMs: afterLastBucket
  });
  const storedByTime = new Map(storedFourHour.map((candle) => [candle.time, candle]));
  const overlapping = aggregated.filter((candle) => storedByTime.has(candle.time));
  const mismatches = [];
  for (const candle of overlapping) {
    const stored = storedByTime.get(candle.time);
    const differences = ["open", "high", "low", "close", "volume"]
      .filter((field) => !nearlyEqual(candle[field], stored[field]));
    if (differences.length) {
      mismatches.push({ time: new Date(candle.time * 1000).toISOString(), fields: differences });
    }
  }
  reports.push({
    symbol: String(manifest.symbol || symbol).toUpperCase(),
    provider: manifest.provider || null,
    sourceFrom: manifest.source?.from || null,
    sourceTo: manifest.source?.to || null,
    hourlyCandles: hourly.length,
    storedFourHourCandles: storedFourHour.length,
    reconstructedFourHourCandles: aggregated.length,
    overlappingCandles: overlapping.length,
    boundaryViolations: aggregated.filter((candle) => candle.time % 14400 !== 0).length,
    ohlcvMismatches: mismatches.length,
    mismatchExamples: mismatches.slice(0, 5)
  });
}

const report = {
  methodology: "Reconstruct UTC-aligned 4h OHLCV from each genuine manifest's 1h Coinbase candles and compare by timestamp with its stored 14,400-second 4h series.",
  reports,
  totals: {
    overlappingCandles: reports.reduce((sum, item) => sum + item.overlappingCandles, 0),
    boundaryViolations: reports.reduce((sum, item) => sum + item.boundaryViolations, 0),
    ohlcvMismatches: reports.reduce((sum, item) => sum + item.ohlcvMismatches, 0)
  }
};
console.log(JSON.stringify(report, null, 2));
if (report.totals.boundaryViolations > 0 || report.totals.ohlcvMismatches > 0) process.exitCode = 1;

function normalizeManifestCandles(candles) {
  return candles.map((item) => ({
    time: Number.isFinite(Number(item.time))
      ? Number(item.time)
      : new Date(item.timestamp).getTime() / 1000,
    open: Number(item.open),
    high: Number(item.high),
    low: Number(item.low),
    close: Number(item.close),
    volume: Number(item.volume)
  })).filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite));
}

function nearlyEqual(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-10;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

