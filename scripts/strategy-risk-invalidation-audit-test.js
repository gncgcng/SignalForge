import assert from "node:assert/strict";
import {
  auditEventOrdering,
  classifyStructuralStop,
  classifyTargetStructure,
  naturalInvalidationInventory,
  strategyInventory
} from "./strategy-risk-invalidation-audit.js";

function candle(time, { open = 100, high = 101, low = 99, close = 100 } = {}) {
  return { time, open, high, low, close, volume: 1 };
}

const longInside = classifyStructuralStop({ direction: "long", entry: 100, naturalInvalidation: 95, productionStop: 97, atr: 2 });
assert.equal(longInside.classification, "INSIDE_STRUCTURE");
assert.equal(longInside.structuralStopClearanceAtr, -1);

const longBeyond = classifyStructuralStop({ direction: "long", entry: 100, naturalInvalidation: 97, productionStop: 95, atr: 2 });
assert.equal(longBeyond.classification, "BEYOND_INVALIDATION");
assert.equal(longBeyond.structuralStopClearanceAtr, 1);

const shortInside = classifyStructuralStop({ direction: "short", entry: 100, naturalInvalidation: 105, productionStop: 103, atr: 2 });
assert.equal(shortInside.classification, "INSIDE_STRUCTURE");
assert.equal(shortInside.structuralStopClearanceAtr, -1);

const shortBeyond = classifyStructuralStop({ direction: "short", entry: 100, naturalInvalidation: 103, productionStop: 105, atr: 2 });
assert.equal(shortBeyond.classification, "BEYOND_INVALIDATION");
assert.equal(shortBeyond.structuralStopClearanceAtr, 1);

assert.equal(classifyStructuralStop({ direction: "long", entry: 100, productionStop: 97, naturalInvalidation: null, atr: 2 }).available, false);

const signal = { direction: "long", entryPrice: 100, stopLoss: 97, takeProfit: 106, atr: 2 };
const sameCandle = auditEventOrdering({ signal, naturalInvalidation: 96, candles: [candle(1, { high: 101, low: 95, close: 96 })], validUntil: 2 });
assert.equal(sameCandle.status, "Hit SL");
assert.equal(sameCandle.sameCandleAmbiguity, true);
assert.equal(sameCandle.prematureStructuralStop, false);

const tpFirst = auditEventOrdering({ signal, naturalInvalidation: 96, candles: [candle(1, { high: 106, low: 99, close: 105 })], validUntil: 2 });
assert.equal(tpFirst.status, "Hit TP");
assert.equal(tpFirst.tpBeforeInvalidation, true);

const invalidationFirst = auditEventOrdering({
  signal: { ...signal, stopLoss: 94 },
  naturalInvalidation: 96,
  candles: [candle(1, { high: 101, low: 95.5, close: 96 }), candle(2, { high: 100, low: 93, close: 94 })],
  validUntil: 3
});
assert.equal(invalidationFirst.status, "Hit SL");
assert.equal(invalidationFirst.cutoffReason, "Natural invalidation");
assert.equal(invalidationFirst.delayedStructuralExit, true);

const slFirst = auditEventOrdering({ signal, naturalInvalidation: 95, candles: [candle(1, { high: 101, low: 96.5, close: 97 })], validUntil: 2 });
assert.equal(slFirst.status, "Hit SL");
assert.equal(slFirst.prematureStructuralStop, true);

const expired = auditEventOrdering({ signal, naturalInvalidation: 95, candles: [candle(1)], validUntil: 2 });
assert.equal(expired.status, "Expired");
assert.equal(expired.prematureStructuralStop, false);

const noInvalidation = auditEventOrdering({ signal, naturalInvalidation: null, candles: [candle(1, { low: 96.5 })], validUntil: 2 });
assert.equal(noInvalidation.status, "Hit SL");
assert.equal(noInvalidation.prematureStructuralStop, false);

assert.equal(classifyTargetStructure({ direction: "long", entry: 100, takeProfit: 108, opposingStructure: 110, atr: 2 }).classification, "STRUCTURALLY_CLEAR_TARGET");
assert.equal(classifyTargetStructure({ direction: "short", entry: 100, takeProfit: 92, opposingStructure: 90, atr: 2 }).classification, "STRUCTURALLY_CLEAR_TARGET");
assert.equal(classifyTargetStructure({ direction: "long", entry: 100, takeProfit: 111, opposingStructure: 110, atr: 2 }).classification, "TARGET_BEYOND_OPPOSING_STRUCTURE");
assert.equal(classifyTargetStructure({ direction: "long", entry: 100, takeProfit: 111, opposingStructure: null, atr: 2 }).classification, "OPPOSING_STRUCTURE_UNAVAILABLE");

assert.equal(strategyInventory.length, 10);
assert.equal(Object.keys(naturalInvalidationInventory).length, 10);
assert.equal(naturalInvalidationInventory["Momentum breakout"].status, "PARTIAL");
assert.equal(naturalInvalidationInventory["Multi-timeframe continuation"].status, "MISSING");
assert.equal(Object.values(naturalInvalidationInventory).filter((item) => item.status === "USABLE").length, 8);

console.log("Strategy risk/invalidation audit math tests passed.");
