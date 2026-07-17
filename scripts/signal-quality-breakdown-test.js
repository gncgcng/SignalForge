import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSignalQuality,
  toLockedSignalQuality,
  withSignalQuality
} from "../src/modules/signals/signalQualityService.js";

const signal = {
  symbol: "BTC-USD",
  timeframe: "15m",
  direction: "long",
  entryPrice: 100,
  stopLoss: 98,
  takeProfit: 104.6,
  riskRewardRatio: 2.3,
  confidenceScore: 84,
  qualityScore: 86,
  entryQuality: "fair",
  confluenceScore: 35,
  alignmentBadge: "Countertrend",
  confluence: { confidenceAdjustment: -5 },
  confirmations: [
    { name: "Trend", passed: true, detail: "EMA structure is aligned with the signal direction." },
    { name: "RSI", passed: true, detail: "RSI supports momentum without excessive extension." },
    { name: "Volume", passed: false, detail: "Volume is near average and did not strongly confirm." },
    { name: "ATR", passed: true, detail: "ATR is inside the tradable volatility range." },
    { name: "Support", passed: true, detail: "Price is holding above recent support." }
  ],
  indicators: { entryQuality: "fair", learningSampleSize: 0 },
  learningInsight: { sampleSize: 0, adjustment: 0 }
};

const quality = buildSignalQuality(signal);
assert.equal(Object.keys(quality.categories).length, 11);
assert.equal(quality.categories.trendAlignment.status, "good");
assert.equal(quality.categories.volumeConfirmation.status, "failed");
assert.equal(quality.categories.entryTiming.status, "fair");
assert.equal(quality.categories.riskReward.status, "good");
assert.equal(quality.categories.higherTimeframe.status, "weak");
assert.equal(quality.categories.learningHistory.status, "limited");
assert.match(quality.categories.marketStructure.reason, /Not enough data/);
assert.equal(quality.categories.patternContext.status, "missing");
assert.ok(quality.strengths.some((reason) => reason.includes("EMA")));
assert.ok(quality.risks.some((reason) => reason.includes("Volume")));
assert.match(quality.confidenceExplanation, /not a guarantee or probability of profit/i);
assert.ok(quality.debug.categories.every((item) => Object.hasOwn(item, "ruleSource") && Object.hasOwn(item, "confidenceImpact")));
assert.ok(quality.debug.penaltiesApplied.length > 0);
assert.ok(quality.debug.confidenceCapsApplied.length > 0);

const enriched = withSignalQuality(signal);
assert.deepEqual(enriched.signalQuality, enriched.indicators.signalQuality);
const locked = toLockedSignalQuality(enriched.signalQuality);
assert.deepEqual(Object.keys(locked).sort(), ["mainReason", "overall"]);
assert.doesNotMatch(JSON.stringify(locked), /entryPrice|stopLoss|takeProfit|categories|debug/);

const app = readFileSync("public/app.js", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const service = readFileSync("src/modules/signals/signalService.js", "utf8");
const repository = readFileSync("src/db/repositories.js", "utf8");

assert.match(app, /function renderSignalQuality/);
assert.match(app, /<h4>Signal Quality<\/h4>/);
assert.match(app, /function renderLockedSignalQuality/);
assert.match(app, /data-locked-quality-summary/);
assert.match(app, /Why confidence is high/);
assert.match(app, /Risk factors/);
assert.match(app, /Not enough data/);
assert.match(app, /Confidence reflects rule alignment and setup quality\. It is not a guarantee or probability of profit\./);
assert.doesNotMatch(app.slice(app.indexOf("function renderLockedSignalQuality"), app.indexOf("function renderSignalQuality")), /entryPrice|stopLoss|takeProfit/);
const unlockReveal = app.slice(app.indexOf("function renderUnlockReveal"), app.indexOf("function closeUnlockReveal"));
assert.ok(unlockReveal.indexOf("renderSignalQuality(signal, { compact: true })") > unlockReveal.indexOf("unlock-critical-levels"));
assert.match(app, /function renderAdminSignalQualityDebug/);
assert.match(repository, /signalQualityDebug: signalQuality\?\.debug/);
assert.match(repository, /s\.validation_passed, s\.indicators, COALESCE/);
assert.match(service, /function toUserSignal[\s\S]*debug: undefined/);
assert.match(service, /signalQuality: toLockedSignalQuality/);
assert.match(service, /indicators: \{ \.\.\.\(signal\.indicators \|\| \{\}\), signalQuality: undefined \}/);
assert.match(css, /\.signal-quality-card/);
assert.match(css, /\.quality-chip\.strong/);
assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.signal-quality-card/);
assert.match(css, /overflow-wrap: anywhere/);

console.log("Signal quality breakdown tests passed.");
