import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calculateVwapContext } from "../src/modules/market-data/advancedMarketStructureService.js";
import {
  VWAP_INTERACTION_TOLERANCE_ATR,
  VWAP_MIN_BODY_TO_RANGE,
  VWAP_MIN_CLOSE_BEYOND_ATR,
  VWAP_MIN_DIRECTIONAL_CLOSE_LOCATION,
  VWAP_PRIOR_DISPLACEMENT_MIN_ATR,
  classifySetupType,
  evaluateVwapReclaimRejectionSetup
} from "../src/modules/signals/signalGenerator.js";

const generatorSource = await readFile(new URL("../src/modules/signals/signalGenerator.js", import.meta.url), "utf8");
const structureSource = await readFile(new URL("../src/modules/market-data/advancedMarketStructureService.js", import.meta.url), "utf8");

assert.equal(VWAP_PRIOR_DISPLACEMENT_MIN_ATR, 0.15);
assert.equal(VWAP_INTERACTION_TOLERANCE_ATR, 0.15);
assert.equal(VWAP_MIN_CLOSE_BEYOND_ATR, 0.1);
assert.equal(VWAP_MIN_BODY_TO_RANGE, 0.5);
assert.equal(VWAP_MIN_DIRECTIONAL_CLOSE_LOCATION, 0.65);

const exactVwapCandles = [
  candle(Date.UTC(2026, 7, 27, 10), { open: 10, high: 11, low: 9, close: 10, volume: 1 }),
  candle(Date.UTC(2026, 7, 27, 11), { open: 20, high: 21, low: 19, close: 20, volume: 3 })
];
const exactContext = calculateVwapContext(exactVwapCandles);
assert.equal(exactContext.session.value, 17.5, "session VWAP must use HLC3 weighted by volume");
assert.equal(exactContext.previousVwap, 10);
assert.equal(exactContext.session.id, "2026-08-27");
assert.equal(exactContext.sameSession, true);

const sameSessionExtended = calculateVwapContext([
  ...exactVwapCandles,
  candle(Date.UTC(2026, 7, 27, 12), { open: 20, high: 22, low: 19, close: 21, volume: 2 })
]);
assert.equal(sameSessionExtended.session.anchorTime, exactVwapCandles[0].time);
assert.equal(sameSessionExtended.sameSession, true);

const resetCandles = [
  candle(Date.UTC(2026, 7, 27, 22), { open: 100.2, high: 100.4, low: 100, close: 100.2, volume: 100 }),
  candle(Date.UTC(2026, 7, 27, 23), { open: 100.1, high: 100.3, low: 99.9, close: 100, volume: 100 }),
  candle(Date.UTC(2026, 7, 28, 0), { open: 100, high: 100.2, low: 99.8, close: 100.1, volume: 100 })
];
const oldResetEvent = oldVwapEvent(resetCandles);
const resetContext = calculateVwapContext(resetCandles);
assert.equal(oldResetEvent, "Reclaim", "characterization: the old calculation could fabricate a reclaim at UTC reset");
assert.equal(resetContext.session.id, "2026-08-28");
assert.equal(resetContext.previousSessionId, "2026-08-27");
assert.equal(resetContext.sameSession, false);
assert.equal(resetContext.event, "None");
assert.equal(resetContext.session.anchorTime, resetCandles.at(-1).time);

const validLong = vwapFixture();
const validShort = mirrorFixture(validLong);
assert.equal(classify(validLong), "VWAP reclaim/rejection");
assert.equal(classify(validShort), "VWAP reclaim/rejection");
assert.equal(evidence(validLong).qualified, true);
assert.equal(evidence(validShort).qualified, true);

const tinyOscillation = vwapFixture({ previousClose: 99.8 });
assert.equal(oldVwapClassifies(tinyOscillation), true);
assert.ok(evidence(tinyOscillation).priorDistanceFromVwapAtr < VWAP_PRIOR_DISPLACEMENT_MIN_ATR);
assert.notEqual(classify(tinyOscillation), "VWAP reclaim/rejection");

const gappedAcross = vwapFixture({ latestOpen: 100.5, latestLow: 100.4, latestHigh: 101.3, latestClose: 101.2 });
assert.equal(oldVwapClassifies(gappedAcross), true);
assert.ok(evidence(gappedAcross).interactionDistanceAtr > VWAP_INTERACTION_TOLERANCE_ATR);
assert.notEqual(classify(gappedAcross), "VWAP reclaim/rejection");

const barelyAcross = vwapFixture({ latestOpen: 99.7, latestLow: 99.6, latestHigh: 100.25, latestClose: 100.1 });
assert.equal(oldVwapClassifies(barelyAcross), true);
assert.ok(evidence(barelyAcross).closeBeyondVwapAtr < VWAP_MIN_CLOSE_BEYOND_ATR);
assert.notEqual(classify(barelyAcross), "VWAP reclaim/rejection");

const weakWick = vwapFixture({ latestOpen: 99.95, latestLow: 99.5, latestHigh: 101.8, latestClose: 100.35 });
assert.equal(oldVwapClassifies(weakWick), true);
assert.ok(evidence(weakWick).bodyToRangeRatio < VWAP_MIN_BODY_TO_RANGE);
assert.ok(evidence(weakWick).directionalCloseLocation < VWAP_MIN_DIRECTIONAL_CLOSE_LOCATION);
assert.notEqual(classify(weakWick), "VWAP reclaim/rejection");

const wrongDirection = vwapFixture({ latestOpen: 100.8, latestLow: 99.6, latestHigh: 100.9, latestClose: 100.6 });
assert.equal(evidence(wrongDirection).qualified, false);
assert.notEqual(classify(wrongDirection), "VWAP reclaim/rejection");

const crossSession = vwapFixture({ sameSession: false, event: "Reclaim" });
assert.equal(oldVwapClassifies(crossSession), true);
assert.equal(evidence(crossSession).sameSession, false);
assert.notEqual(classify(crossSession), "VWAP reclaim/rejection");

const stale = vwapFixture({ event: "None" });
assert.equal(evidence(stale).qualified, false);
assert.notEqual(classify(stale), "VWAP reclaim/rejection");

const wrongSide = vwapFixture({ latestOpen: 99.5, latestLow: 99.3, latestHigh: 100.1, latestClose: 99.9, event: "None" });
assert.equal(evidence(wrongSide).acceptedNewSide, false);
assert.notEqual(classify(wrongSide), "VWAP reclaim/rejection");

const momentum = momentumFixture();
assert.equal(classify(momentum), "Momentum breakout");
assert.notEqual(classify(momentum), "VWAP reclaim/rejection");

const meanReversion = meanReversionFixture();
assert.equal(classify(meanReversion), "Mean reversion");

const trendContinuation = trendContinuationFixture();
assert.equal(classify(trendContinuation), "Trend continuation");

const longEvidence = evidence(validLong);
const shortEvidence = evidence(validShort);
assertApprox(longEvidence.priorDistanceFromVwapAtr, shortEvidence.priorDistanceFromVwapAtr);
assertApprox(longEvidence.interactionDistanceAtr, shortEvidence.interactionDistanceAtr);
assertApprox(longEvidence.closeBeyondVwapAtr, shortEvidence.closeBeyondVwapAtr);
assertApprox(longEvidence.bodyToRangeRatio, shortEvidence.bodyToRangeRatio);
assertApprox(longEvidence.directionalCloseLocation, shortEvidence.directionalCloseLocation);
assert.equal(longEvidence.invalidationLevel + shortEvidence.invalidationLevel, 200);

assert.match(structureSource, /sameSession && previous\.close <= priorVwap/);
assert.match(generatorSource, /setupType === "VWAP reclaim\/rejection"[\s\S]*?evaluateVwapReclaimRejectionSetup/);
const riskCall = generatorSource.match(/buildDynamicRiskPlan\(\{[\s\S]*?\}\);/)?.[0] || "";
assert.doesNotMatch(riskCall, /strategyEvidence/, "VWAP evidence must remain diagnostic and must not feed the risk engine");

console.log(JSON.stringify({
  calculation: {
    price: "(high + low + close) / 3",
    weighting: "volume",
    reset: "UTC calendar day",
    exactVwap: exactContext.session.value
  },
  oldRule: {
    previousIndex: -2,
    currentIndex: -1,
    priorCloseVersusPriorSessionVwap: true,
    currentCloseVersusCurrentSessionVwap: true,
    directionalCandle: true,
    sameSessionRequired: false,
    displacementOrAcceptanceRequired: false
  },
  newRule: {
    sameUtcSession: true,
    priorDisplacementAtr: VWAP_PRIOR_DISPLACEMENT_MIN_ATR,
    interactionToleranceAtr: VWAP_INTERACTION_TOLERANCE_ATR,
    closeBeyondVwapAtr: VWAP_MIN_CLOSE_BEYOND_ATR,
    bodyToRangeRatio: VWAP_MIN_BODY_TO_RANGE,
    directionalCloseLocation: VWAP_MIN_DIRECTIONAL_CLOSE_LOCATION,
    triggerIndex: -1
  },
  resetCharacterization: { oldEvent: oldResetEvent, newEvent: resetContext.event },
  mirrored: true,
  evidence: longEvidence
}, null, 2));

function vwapFixture(options = {}) {
  const start = Date.UTC(2026, 7, 27, 8) / 1000;
  const candles = Array.from({ length: 30 }, (_, index) => ({
    time: start + index * 900,
    open: 99.8,
    high: index === 10 ? 105 : 100.2,
    low: index === 12 ? 95 : 99.4,
    close: 99.8,
    volume: 100
  }));
  candles[28] = { ...candles[28], open: 99.7, high: 99.9, low: 99.4, close: options.previousClose ?? 99.6 };
  candles[29] = {
    ...candles[29],
    open: options.latestOpen ?? 99.7,
    high: options.latestHigh ?? 100.8,
    low: options.latestLow ?? 99.6,
    close: options.latestClose ?? 100.6,
    volume: 120
  };
  return {
    direction: "long",
    candles,
    ema20: 101,
    ema50: 102,
    rsi14: 55,
    atr14: 2,
    volumeMa20: 100,
    nearestSupport: { price: 95 },
    nearestResistance: { price: 110 },
    supportStrength: 3,
    resistanceStrength: 3,
    regimeLabel: "High Volatility",
    trendStrength: 0.35,
    advancedStructure: {
      vwap: {
        event: options.event ?? "Reclaim",
        session: { id: "2026-08-27", value: 100, anchorTime: start },
        previousSessionId: options.sameSession === false ? "2026-08-26" : "2026-08-27",
        previousVwap: 100,
        sameSession: options.sameSession !== false
      }
    }
  };
}

function momentumFixture() {
  const fixture = vwapFixture({ event: "None", latestOpen: 104.8, latestLow: 104.6, latestHigh: 107, latestClose: 106.4 });
  fixture.ema20 = 102;
  fixture.ema50 = 100;
  fixture.candles[28].close = 104.5;
  fixture.candles[29].volume = 150;
  fixture.regimeLabel = "Breakout";
  return fixture;
}

function meanReversionFixture() {
  const fixture = vwapFixture({ event: "None", previousClose: 100, latestOpen: 97, latestHigh: 98.6, latestLow: 96.4, latestClose: 98.2 });
  fixture.ema20 = 100;
  fixture.ema50 = 99;
  fixture.rsi14 = 46;
  fixture.nearestSupport = { price: 96 };
  fixture.regimeLabel = "High Volatility";
  return fixture;
}

function trendContinuationFixture() {
  const fixture = vwapFixture({ event: "None", previousClose: 103.5, latestOpen: 103.45, latestLow: 103.35, latestHigh: 105.45, latestClose: 105.2 });
  fixture.ema20 = 101;
  fixture.ema50 = 99;
  fixture.regimeLabel = "Trend Up";
  fixture.trendStrength = 0.78;
  fixture.candles[25].high = 106;
  fixture.candles[27] = { ...fixture.candles[27], open: 103.25, high: 103.7, low: 103.1, close: 103.4 };
  fixture.candles[28] = { ...fixture.candles[28], open: 103.4, high: 103.8, low: 103.2, close: 103.5 };
  return fixture;
}

function evidence(fixture) {
  return evaluateVwapReclaimRejectionSetup(
    fixture.direction,
    fixture.candles,
    indicators(fixture),
    fixture.advancedStructure
  );
}

function classify(fixture) {
  return classifySetupType(
    fixture.direction,
    fixture.candles,
    indicators(fixture),
    {
      nearestSupport: fixture.nearestSupport,
      nearestResistance: fixture.nearestResistance,
      supportStrength: fixture.supportStrength,
      resistanceStrength: fixture.resistanceStrength
    },
    { label: fixture.regimeLabel, trendStrength: fixture.trendStrength },
    null,
    fixture.advancedStructure,
    null
  );
}

function indicators(fixture) {
  return {
    ema20: fixture.ema20,
    ema50: fixture.ema50,
    rsi14: fixture.rsi14,
    atr14: fixture.atr14,
    volumeMa20: fixture.volumeMa20
  };
}

function oldVwapClassifies(fixture) {
  const event = fixture.advancedStructure?.vwap?.event;
  const directional = fixture.direction === "long"
    ? fixture.candles.at(-1).close > fixture.candles.at(-1).open
    : fixture.candles.at(-1).close < fixture.candles.at(-1).open;
  return directional && (fixture.direction === "long" ? event === "Reclaim" : event === "Rejection");
}

function oldVwapEvent(candles) {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const latestDay = utcDay(latest.time);
  const sessionVwap = weightedVwap(candles.filter((item) => utcDay(item.time) === latestDay));
  const priorVwap = weightedVwap(candles.filter((item) => item.time <= previous.time && utcDay(item.time) === utcDay(previous.time)));
  return previous.close <= priorVwap && latest.close > sessionVwap
    ? "Reclaim"
    : previous.close >= priorVwap && latest.close < sessionVwap
      ? "Rejection"
      : "None";
}

function weightedVwap(candles) {
  const total = candles.reduce((result, item) => {
    result.volume += item.volume;
    result.priceVolume += ((item.high + item.low + item.close) / 3) * item.volume;
    return result;
  }, { volume: 0, priceVolume: 0 });
  return total.priceVolume / total.volume;
}

function utcDay(time) {
  return new Date(Number(time) * 1000).toISOString().slice(0, 10);
}

function candle(timeMs, values) {
  return { time: timeMs / 1000, ...values };
}

function mirrorFixture(fixture, pivot = 100) {
  const mirror = (value) => pivot * 2 - Number(value);
  return {
    ...fixture,
    direction: "short",
    candles: fixture.candles.map((item) => ({
      ...item,
      open: mirror(item.open),
      high: mirror(item.low),
      low: mirror(item.high),
      close: mirror(item.close)
    })),
    ema20: mirror(fixture.ema20),
    ema50: mirror(fixture.ema50),
    rsi14: 100 - fixture.rsi14,
    nearestSupport: fixture.nearestResistance ? { ...fixture.nearestResistance, price: mirror(fixture.nearestResistance.price) } : null,
    nearestResistance: fixture.nearestSupport ? { ...fixture.nearestSupport, price: mirror(fixture.nearestSupport.price) } : null,
    supportStrength: fixture.resistanceStrength,
    resistanceStrength: fixture.supportStrength,
    advancedStructure: {
      vwap: {
        ...fixture.advancedStructure.vwap,
        event: "Rejection",
        session: { ...fixture.advancedStructure.vwap.session, value: mirror(fixture.advancedStructure.vwap.session.value) },
        previousVwap: mirror(fixture.advancedStructure.vwap.previousVwap)
      }
    }
  };
}

function assertApprox(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);
}
