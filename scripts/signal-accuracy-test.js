import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateMarketDataSetup } from "../src/modules/signals/signalGenerator.js";

const candles = Array.from({ length: 90 }, (_, index) => {
  const center = 100 + Math.sin(index * 1.7) * 0.18;
  const open = center + (index % 2 ? 0.04 : -0.04);
  const close = center + (index % 2 ? -0.04 : 0.04);
  return {
    time: 1_700_000_000 + index * 3600,
    open,
    high: Math.max(open, close) + 0.12,
    low: Math.min(open, close) - 0.12,
    close,
    volume: 1000 + (index % 4) * 15
  };
});

const result = generateMarketDataSetup({
  pair: { symbol: "BTC-USD", assetClass: "Crypto" },
  source: "fixture",
  volumeAvailable: true,
  candles
}, "1h");

assert.equal(result.valid, false, "A choppy low-efficiency market should return no trade.");
assert.ok(
  result.analysis.candidates.some((candidate) => {
    return candidate.regime === "Range" ||
      candidate.rejectionReasons.some((reason) => reason.toLowerCase().includes("range"));
  }),
  "No-trade analysis should explain the range regime."
);

const source = readFileSync(
  new URL("../src/modules/signals/signalGenerator.js", import.meta.url),
  "utf8"
);
for (const setupType of [
  "Trend continuation",
  "Pullback bounce",
  "Breakout retest",
  "Reversal"
]) {
  assert.ok(source.includes(`"${setupType}"`), `Missing setup type ${setupType}.`);
}
assert.ok(source.includes("const minimumRiskReward = 1.8"));
assert.ok(source.includes("qualityScore"));

console.log(JSON.stringify({
  valid: result.valid,
  regimes: result.analysis.candidates.map((candidate) => candidate.regime),
  qualityScores: result.analysis.candidates.map((candidate) => candidate.qualityScore),
  setupTypesCovered: 4
}, null, 2));
