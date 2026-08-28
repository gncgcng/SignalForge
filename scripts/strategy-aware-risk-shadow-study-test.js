import assert from "node:assert/strict";
import {
  buildShadowPolicies,
  buildStructuralShadowStop,
  SHADOW_BUFFER_ATR,
  simulateTrade
} from "./strategy-aware-risk-shadow-study.js";

assert.equal(SHADOW_BUFFER_ATR, 0.2);
assert.equal(buildStructuralShadowStop({ direction: "long", naturalInvalidation: 95, atr: 2 }), 94.6);
assert.equal(buildStructuralShadowStop({ direction: "short", naturalInvalidation: 105, atr: 2 }), 105.4);
assert.equal(buildStructuralShadowStop({ direction: "long", naturalInvalidation: null, atr: 2 }), null);

const longPolicies = buildShadowPolicies({
  direction: "long",
  entry: 100,
  productionTakeProfit: 110,
  shadowStop: 94.6,
  targetMultiple: 2.5
});
assert.equal(longPolicies.originalTp.riskReward, 1.851852);
assert.equal(longPolicies.originalTp.wouldRemainEligible, true);
assert.equal(longPolicies.preservedTargetMultiple.takeProfit, 113.5);
assert.equal(longPolicies.preservedTargetMultiple.riskReward, 2.5);

const capped = buildShadowPolicies({
  direction: "long",
  entry: 100,
  productionTakeProfit: 110,
  shadowStop: 94.6,
  targetMultiple: 2.5,
  opposingStructure: 109
});
assert.equal(capped.preservedTargetMultiple.takeProfit, 109);
assert.equal(capped.preservedTargetMultiple.riskReward, 1.666667);
assert.equal(capped.preservedTargetMultiple.wouldFailRR, true);

const shortPolicies = buildShadowPolicies({
  direction: "short",
  entry: 100,
  productionTakeProfit: 90,
  shadowStop: 105.4,
  targetMultiple: 2
});
assert.equal(shortPolicies.originalTp.riskReward, 1.851852);
assert.equal(shortPolicies.preservedTargetMultiple.takeProfit, 89.2);

const ambiguous = simulateTrade({
  direction: "long",
  entry: 100,
  stopLoss: 95,
  takeProfit: 105,
  riskReward: 1,
  candles: [{ time: 1, open: 100, high: 106, low: 94, close: 101 }],
  validUntil: 2
});
assert.equal(ambiguous.status, "Hit SL");
assert.equal(ambiguous.sameCandleAmbiguity, true);
assert.equal(ambiguous.realizedR, -1);

const expired = simulateTrade({
  direction: "short",
  entry: 100,
  stopLoss: 105,
  takeProfit: 90,
  riskReward: 2,
  candles: [{ time: 1, open: 100, high: 103, low: 97, close: 99 }],
  validUntil: 2
});
assert.equal(expired.status, "Expired");
assert.equal(expired.realizedR, 0);

console.log("Strategy-aware risk shadow math tests passed.");
