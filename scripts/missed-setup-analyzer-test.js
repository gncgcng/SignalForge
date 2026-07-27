import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildWhyNoSignalReport,
  detectFailedBreakoutMomentumExhaustion
} from "../src/modules/signals/missedSetupAnalyzer.js";

function buildFailedBreakoutCandles() {
  const candles = [];
  for (let index = 0; index < 33; index += 1) {
    const base = 100 + (index % 4);
    candles.push({
      time: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      open: base,
      high: 105,
      low: base - 1.2,
      close: base + 0.4,
      volume: 100
    });
  }
  candles.push({ time: "2026-01-01T00:33:00.000Z", open: 104.8, high: 107.2, low: 104.5, close: 106.4, volume: 135 });
  candles.push({ time: "2026-01-01T00:34:00.000Z", open: 106.3, high: 106.8, low: 105.2, close: 105.7, volume: 110 });
  candles.push({ time: "2026-01-01T00:35:00.000Z", open: 105.6, high: 106.1, low: 104.4, close: 104.7, volume: 92 });
  candles.push({ time: "2026-01-01T00:36:00.000Z", open: 104.6, high: 104.9, low: 103.2, close: 103.6, volume: 88 });
  candles.push({ time: "2026-01-01T00:37:00.000Z", open: 103.4, high: 103.8, low: 101.4, close: 101.9, volume: 82 });
  candles.push({ time: "2026-01-01T00:38:00.000Z", open: 101.8, high: 102.1, low: 100.4, close: 100.9, volume: 79 });
  candles.push({ time: "2026-01-01T00:39:00.000Z", open: 100.8, high: 101.1, low: 99.8, close: 100.1, volume: 76 });
  return candles;
}

const failedBreakout = detectFailedBreakoutMomentumExhaustion(buildFailedBreakoutCandles(), {
  symbol: "BTCUSD",
  timeframe: "15m"
});
assert.equal(failedBreakout.attemptedStrategy, "Failed breakout / momentum exhaustion");
assert.equal(failedBreakout.direction, "short");
assert.match(failedBreakout.reason, /failed breakout|moved too far/i);
assert.ok(failedBreakout.blockers.some((item) => /quality gate/i.test(item)));
assert.notEqual(failedBreakout.status, "ready");

const report = buildWhyNoSignalReport({
  symbol: "BTCUSD",
  timeframe: "1h",
  marketData: { candles: buildFailedBreakoutCandles() },
  analysis: {
    rejectionReasons: ["poor RR", "weak confirmation"],
    rejectionReasonCodes: ["poor_rr", "weak_confirmation"],
    candidates: [{
      direction: "long",
      setupType: "Breakout retest",
      qualityScore: 64,
      rejectionReasons: ["Breakout retest did not actually retest the broken level."],
      confirmations: [
        { name: "RSI", passed: true },
        { name: "Volume", passed: false, reason: "Volume confirmation is missing." }
      ]
    }]
  },
  readiness: {
    ready: false,
    entryQuality: "fair",
    readinessScore: 58,
    reasons: ["Price is too far from ideal entry."]
  },
  qualityGate: {
    passed: false,
    version: "quality-gate-v2",
    status: "poor_entry_quality",
    reasonCode: "poor_entry_quality",
    reason: "Entry is late after the breakout candle."
  },
  qualityBlocked: true,
  admin: true
});

assert.equal(report.available, true);
assert.match(report.summary, /No setup found because/i);
assert.ok(report.reasons.some((item) => item.code === "poor_rr"));
assert.ok(report.reasons.some((item) => item.code === "quarantined_timeframe"));
assert.ok(report.possibleSetups.some((item) => item.attemptedStrategy === "Failed breakout / momentum exhaustion"));
assert.ok(report.possibleSetups.every((item) => item.status !== "ready"));
assert.equal(report.admin.finalDecision, "poor_entry_quality");
assert.equal(report.admin.telegramDecision, "blocked_not_alertable");

const service = readFileSync("src/modules/signals/signalService.js", "utf8");
const controller = readFileSync("src/modules/signals/signalController.js", "utf8");
const missedService = readFileSync("src/modules/signals/missedSetupService.js", "utf8");
const html = readFileSync("public/index.html", "utf8");
const app = readFileSync("public/app.js", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const migration = readFileSync("migrations/057_missed_setup_examples.sql", "utf8");

assert.match(service, /buildWhyNoSignalReport/);
assert.match(service, /whyNoSignal/);
assert.match(controller, /\/api\/signals\/missed-setup\/analyze/);
assert.match(controller, /\/api\/signals\/missed-setup\/examples/);
assert.match(missedService, /assertAdmin/);
assert.match(missedService, /missedSetupExampleLimit = 1000/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS missed_setup_examples/);
assert.match(migration, /candles_snapshot jsonb/);
assert.match(html, /why-no-signal-panel/);
assert.match(html, /Analyze missed setup/);
assert.match(html, /Save example/);
assert.match(app, /renderWhyNoSignalPanel/);
assert.match(app, /missed-setup\/analyze/);
assert.match(app, /missed-setup\/examples/);
assert.match(css, /why-no-signal-panel/);
assert.match(css, /overflow-x: hidden/);

console.log("Missed setup analyzer tests passed.");
