import assert from "node:assert/strict";
import { DEFAULTS, FEE_PRESETS, breakEvenWinRate, computeFeeCost } from "../public/feeCost.js";

const results = {};
const check = (name, fn) => { fn(); results[name] = true; };
const close = (actual, expected, digits = 10) => assert.equal(Number(actual.toFixed(digits)), expected);

check("entry 100, stop 99, fee 0.60%, slippage 0.05%", () => {
  const result = computeFeeCost({ entry: 100, stop: 99, feePerSidePct: 0.6, slippagePerSidePct: 0.05, targetR: 2 });
  assert.equal(result.ok, true);
  close(result.stopDistancePct, 1); // stop distance 1%
  close(result.roundTripPct, 1.3); // 2 x (0.60 + 0.05)
  close(result.costR, 1.3); // 1.30% / 1%
  close(result.breakEvenWithCosts, 0.7666666667);
  close(result.breakEvenWithoutCosts, 0.3333333333);
  assert.equal(result.sentence,
    "Fees and slippage cost you 1.30R on every trade, win or lose. To break even on a 2R target you'd need to win 76.7% of the time instead of 33.3%.");
});

check("break-even at T = 2, C = 1.3 is 76.7%", () => {
  assert.equal((breakEvenWinRate(2, 1.3) * 100).toFixed(1), "76.7");
  assert.equal((breakEvenWinRate(2, 0) * 100).toFixed(1), "33.3");
});

check("defaults and presets", () => {
  assert.deepEqual(DEFAULTS, { feePerSidePct: 0.6, slippagePerSidePct: 0.05, targetR: 2 });
  assert.deepEqual(FEE_PRESETS, [0.1, 0.25, 0.6]);
  const defaulted = computeFeeCost({ entry: 100, stop: 99 });
  close(defaulted.costR, 1.3);
});

check("invalid input gives a clear message, never NaN", () => {
  const cases = [
    [{ entry: 100, stop: 100 }, "The stop can't be at the entry price: there would be no risk to measure against."],
    [{ entry: 100, stop: 101 }, "For a long trade, the stop must be below the entry price."],
    [{ entry: "", stop: 99 }, "Enter an entry price and a stop price."],
    [{ entry: "abc", stop: 99 }, "Enter an entry price and a stop price."],
    [{ entry: 100, stop: 0 }, "Prices must be above zero."],
    [{ entry: 100, stop: 99, feePerSidePct: -0.1 }, "Fees and slippage can't be negative."],
    [{ entry: 100, stop: 99, feePerSidePct: "" }, "Enter a fee and a slippage per side (0 is allowed)."],
    [{ entry: 100, stop: 99, targetR: 0 }, "The target must be above 0R."]
  ];
  for (const [input, message] of cases) {
    const result = computeFeeCost(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(result.message, message);
    assert.ok(!JSON.stringify(result).includes("NaN"));
  }
});

check("costs that make break-even impossible are said plainly", () => {
  const result = computeFeeCost({ entry: 100, stop: 99.7, feePerSidePct: 0.6, slippagePerSidePct: 0.05, targetR: 2 });
  assert.equal(result.ok, true);
  assert.match(result.sentence, /could not break even/);
  assert.ok(!/NaN|Infinity/.test(result.sentence));
});

check("zero fees cost nothing", () => {
  const result = computeFeeCost({ entry: 100, stop: 98, feePerSidePct: 0, slippagePerSidePct: 0, targetR: 2 });
  close(result.costR, 0);
  close(result.breakEvenWithCosts, 0.3333333333);
});

console.log(JSON.stringify(results, null, 2));
