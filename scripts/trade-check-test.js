import assert from "node:assert/strict";
import { computeFeeCost } from "../public/feeCost.js";
import {
  OWN_SETUP,
  checkTrade,
  prefillFromParams,
  recordFor,
  trackRecordOptions,
  tradeCheckPrefill,
  tradeCheckPrefillParams
} from "../public/tradeCheck.js";
import { loadTrackRecords } from "../src/modules/track-records/trackRecordService.js";

const trackRecords = loadTrackRecords();
const results = {};
const check = (name, fn) => { fn(); results[name] = true; };
const close = (actual, expected, digits = 10) => assert.equal(Number(actual.toFixed(digits)), expected);
const BASE = { accountSize: 10000, riskPercent: 1, feePerSidePct: 0.6, slippagePerSidePct: 0.05 };

check("1. long: entry 100, stop 99, target 102, 0.60% + 0.05%, $10,000 at 1%", () => {
  const result = checkTrade({ ...BASE, direction: "long", entry: 100, stop: 99, target: 102 });
  assert.equal(result.ok, true);
  close(result.stopDistance, 1); // d
  close(result.costPerUnit, 1.2935); // k = 100 x 0.0065 + 99 x 0.0065
  close(result.costR, 1.2935); // C = k / d
  close(result.targetR, 2); // T
  close(result.netWinR, 0.7065); // T - C
  close(result.netLossR, -2.2935); // -(1 + C)
  close(result.breakEvenWinRate, 0.7645); // (1 + C) / (T + 1) = 2.2935 / 3
  assert.equal(result.units.toFixed(2), "43.60"); // 100 / 2.2935
  assert.equal(Math.round(result.notional), 4360);
  close(result.units * (result.stopDistance + result.costPerUnit), 100); // a stop-out loses exactly the risk amount
  assert.equal(result.leverageWarning, null);
  assert.equal(result.sentences.costs, "Fees and slippage cost 1.29R on every trade, win or lose.");
  assert.equal(result.sentences.breakEven, "With these costs you need to win 76% of the time to break even.");
  assert.equal(result.sentences.size, "Risking $100 (1% of $10,000): buy 43.6 units ($4,360). A stop-out loses about $100 including costs.");
  // The /research calculator stays simplified (both legs at entry): 1.30R for the same trade.
  assert.equal(computeFeeCost({ entry: 100, stop: 99, feePerSidePct: 0.6, slippagePerSidePct: 0.05 }).costR.toFixed(2), "1.30");
});

check("2. short: the mirror image gives the same numbers", () => {
  // Mirror of the long: the short enters where the long's stop was and stops where the long entered.
  const long = checkTrade({ ...BASE, direction: "long", entry: 100, stop: 99, target: 102 });
  const short = checkTrade({ ...BASE, direction: "short", entry: 99, stop: 100, target: 97 });
  assert.equal(short.ok, true);
  for (const key of ["stopDistance", "costPerUnit", "costR", "targetR", "netWinR", "netLossR", "breakEvenWinRate", "units"]) {
    close(short[key], Number(long[key].toFixed(10)));
  }
  close(short.notional, Number((short.units * 99).toFixed(10))); // notional uses the short's own entry
  assert.match(short.sentences.size, /: sell 43\.6 units \(\$4,317\)\./);
  // Same prices as the long, opposite direction: costs follow the actual prices (stop leg at 101).
  const sameEntry = checkTrade({ ...BASE, direction: "short", entry: 100, stop: 101, target: 98 });
  close(sameEntry.costPerUnit, 1.3065);
  close(sameEntry.targetR, 2);
});

check("3. leverage: a tight stop pushes the size past the account", () => {
  const result = checkTrade({ ...BASE, direction: "long", entry: 100, stop: 99.9, target: 100.2, feePerSidePct: 0.1, slippagePerSidePct: 0 });
  assert.equal(result.ok, true);
  const multiple = result.notional / 10000;
  assert.ok(multiple > 1);
  assert.equal(result.leverageWarning, `This size needs ${multiple.toFixed(1)}× leverage. A move against you can be liquidated before your stop.`);
  assert.equal(multiple.toFixed(1), "3.3"); // units = 100 / (0.1 + 0.1999) = 333.4, notional $33,344
});

check("4. track record: a long with a record matches; own setup and shorts get none", () => {
  const momentum = trackRecords.records.find((record) => record.key === "momentum breakout|long|15m");
  const matched = checkTrade({ ...BASE, direction: "long", entry: 100, stop: 99, target: 102, setupType: "Momentum breakout", timeframe: "15m" }, { trackRecords });
  assert.equal(matched.record.key, "momentum breakout|long|15m");
  assert.equal(matched.record.n, momentum.n);
  assert.equal(matched.sentences.breakEven,
    `With these costs you need to win 76% of the time to break even. Momentum breakout · 15m has historically won ${Math.round(momentum.winRate)}% (${momentum.n.toLocaleString("en-US")} past cases).`);
  const own = checkTrade({ ...BASE, direction: "long", entry: 100, stop: 99, target: 102, setupType: OWN_SETUP, timeframe: "15m" }, { trackRecords });
  assert.equal(own.record, null);
  assert.equal(own.sentences.breakEven, "With these costs you need to win 76% of the time to break even.");
  const short = checkTrade({ ...BASE, direction: "short", entry: 99, stop: 100, target: 97, setupType: "Momentum breakout", timeframe: "15m" }, { trackRecords });
  assert.equal(short.record, null);
  assert.ok(!/historically/.test(short.sentences.breakEven));
  assert.equal(recordFor({ direction: "long", setupType: "Momentum breakout", timeframe: "" }, trackRecords), null, "no timeframe, no record");
  const options = trackRecordOptions(trackRecords);
  assert.ok(options.setupTypes.includes("Momentum breakout"));
  assert.deepEqual(options.timeframes, ["5m", "15m", "1h", "4h"]);
});

check("5. prefill: a card's levels map exactly into the form", () => {
  const card = { id: "sig_1", symbol: "BTC-USD", timeframe: "15m", direction: "long", setupType: "Momentum breakout", entryPrice: 62000, stopLoss: 61380, takeProfit: 63240 };
  assert.deepEqual(tradeCheckPrefill(card), {
    direction: "long", entry: "62000", stop: "61380", target: "63240", targetMode: "price",
    setupType: "Momentum breakout", timeframe: "15m", symbol: "BTC-USD"
  });
  const roundTrip = prefillFromParams(new URLSearchParams(tradeCheckPrefillParams(card).toString()));
  assert.deepEqual(roundTrip, tradeCheckPrefill(card));
  const fromCard = checkTrade({ ...BASE, ...roundTrip }, { trackRecords });
  assert.equal(fromCard.ok, true);
  assert.equal(fromCard.record.key, "momentum breakout|long|15m");
  assert.match(fromCard.sentences.size, / BTC \(/);
  assert.equal(tradeCheckPrefill({ ...card, direction: "short" }), null, "shorts get no button");
  assert.equal(tradeCheckPrefillParams({ ...card, direction: "short" }), null);
  assert.equal(tradeCheckPrefill({ ...card, entryPrice: null }), null, "no levels, no button");
});

check("6. every validation case gives a message, never NaN", () => {
  const cases = [
    [{ direction: "long", entry: 100, stop: 101, target: 102 }, "For a long trade, the stop must be below the entry price."],
    [{ direction: "short", entry: 100, stop: 99, target: 98 }, "For a short trade, the stop must be above the entry price."],
    [{ direction: "long", entry: 100, stop: 99, target: 99.5 }, "For a long trade, the target must be above the entry price."],
    [{ direction: "short", entry: 100, stop: 101, target: 100.5 }, "For a short trade, the target must be below the entry price."],
    [{ direction: "long", entry: 100, stop: 100, target: 102 }, "The stop can't be at the entry price: there would be no risk to measure."],
    [{ direction: "long", entry: 0, stop: 99, target: 102 }, "Entry and stop prices must be above zero."],
    [{ direction: "long", entry: 100, stop: -1, target: 102 }, "Entry and stop prices must be above zero."],
    [{ direction: "long", entry: 100, stop: 99, target: 0 }, "The target price must be above zero."],
    [{ direction: "long", entry: 100, stop: 99, targetMode: "r", targetR: 0 }, "The target must be above 0R."],
    [{ direction: "long", entry: 100, stop: 99, target: 102, accountSize: 0 }, "Account size must be above zero."],
    [{ direction: "long", entry: 100, stop: 99, target: 102, accountSize: -5 }, "Account size must be above zero."],
    [{ direction: "long", entry: 100, stop: 99, target: 102, riskPercent: 0 }, "Risk per trade must be above 0%."],
    [{ direction: "long", entry: 100, stop: 99, target: 102, riskPercent: 101 }, "Risk per trade can't be above 100% of the account."],
    [{ direction: "long", entry: 100, stop: 99, target: 102, feePerSidePct: -0.1 }, "Fees and slippage can't be negative."],
    [{ direction: "long", entry: "", stop: 99, target: 102 }, "Enter an entry price and a stop price."],
    [{ direction: "long", entry: 100, stop: 99, target: "" }, "Enter a target price."],
    [{ direction: "long", entry: 100, stop: 99, target: 102, accountSize: "" }, "Enter your account size."],
    [{ direction: "", entry: 100, stop: 99, target: 102 }, "Choose long or short."]
  ];
  for (const [input, message] of cases) {
    const result = checkTrade({ ...BASE, ...input });
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(result.message, message, JSON.stringify(input));
    assert.ok(!/NaN|Infinity|undefined/.test(JSON.stringify(result)));
  }
  // Target as an R multiple works too.
  const byR = checkTrade({ ...BASE, direction: "long", entry: 100, stop: 99, targetMode: "r", targetR: 2 });
  close(byR.target, 102);
  close(byR.breakEvenWinRate, 0.7645);
});

console.log(JSON.stringify(results, null, 2));
