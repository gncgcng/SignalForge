import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SCANNER_RESULT_TYPES,
  buildAvoidTradeResult,
  classifyScannerResult
} from "../src/modules/signals/avoidTradeService.js";
import { summarizeScanBatch } from "../src/modules/signals/signalService.js";

const root = new URL("../", import.meta.url);
const app = readFileSync(new URL("public/app.js", root), "utf8");
const html = readFileSync(new URL("public/index.html", root), "utf8");
const css = readFileSync(new URL("public/styles.css", root), "utf8");
const controller = readFileSync(new URL("src/modules/signals/signalController.js", root), "utf8");
const service = readFileSync(new URL("src/modules/signals/signalService.js", root), "utf8");
const candidateRepository = readFileSync(new URL("src/modules/signals/setupCandidateRepository.js", root), "utf8");
const migration = readFileSync(new URL("migrations/038_avoid_trade_learning.sql", root), "utf8");

const avoid = buildAvoidTradeResult({
  symbol: "BTC-USD",
  timeframe: "15m",
  analysis: {
    rejectionReasonCodes: ["poor_rr", "failed_volume_filter", "trend_conflict"],
    rejectionReasons: ["Risk/reward is below minimum.", "Volume confirmation is missing."]
  },
  now: new Date("2026-07-13T12:00:00.000Z")
});

assert.equal(avoid.resultType, "avoid_trade");
assert.equal(avoid.symbol, "BTC-USD");
assert.match(avoid.reason, /risk\/reward/i);
assert.ok(avoid.reasons.some((reason) => /volume/i.test(reason)));
assert.ok(avoid.improvements.length > 0);
for (const forbidden of ["entryPrice", "entry", "stopLoss", "takeProfit", "riskRewardRatio", "setupKey"]) {
  assert.equal(Object.hasOwn(avoid, forbidden), false, `avoid result must not expose ${forbidden}`);
}
assert.doesNotMatch(JSON.stringify(avoid), /LOW_VOL_FAIL|FAILED_VOLUME_FILTER/);

assert.equal(classifyScannerResult({ valid: true }), SCANNER_RESULT_TYPES.READY);
assert.equal(classifyScannerResult({ valid: false, candidate: { status: "watching" } }), SCANNER_RESULT_TYPES.WATCHING);
assert.equal(classifyScannerResult({ valid: false, candidate: { status: "expired" } }), SCANNER_RESULT_TYPES.EXPIRED);
assert.equal(classifyScannerResult({
  valid: false,
  providerError: true,
  analysis: { rejectionReasonCodes: ["provider_unavailable"] }
}), SCANNER_RESULT_TYPES.REJECTED);
assert.equal(classifyScannerResult({
  valid: false,
  providerError: true,
  analysis: { rejectionReasonCodes: ["stale_data"] }
}), SCANNER_RESULT_TYPES.AVOID);

const summary = summarizeScanBatch(
  [
    { valid: true, resultType: "ready_signal" },
    { valid: false, resultType: "watching_setup" },
    { valid: false, resultType: "avoid_trade" },
    { valid: false, resultType: "rejected_setup" },
    { valid: false, resultType: "expired_setup" }
  ],
  [{ id: "ready" }],
  [{ id: "watch", status: "watching" }, { id: "expired", status: "expired" }],
  { topReasons: [{ reason: "Risk/reward is below minimum.", count: 1 }], topCodes: [] },
  [avoid]
);
assert.deepEqual(
  { ready: summary.ready, watching: summary.watching, avoid: summary.avoidTrade, rejected: summary.rejected, expired: summary.expired },
  { ready: 1, watching: 1, avoid: 1, rejected: 1, expired: 1 }
);

assert.match(html, /Markets to Avoid Right Now/);
assert.match(html, /scan-summary-avoid/);
assert.match(html, /SignalForge filters out weak setups instead of forcing trades/);
assert.match(app, /state\.avoidTrades/);
assert.match(app, /slice\(0, 3\)/);
assert.match(app, /No credits used/);
assert.doesNotMatch(app.slice(app.indexOf("function renderAvoidTrades"), app.indexOf("async function loadPaperPortfolio")), /Unlock Signal|entryPrice|stopLoss|takeProfit/);
assert.match(css, /\.avoid-trade-grid/);
assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.avoid-trade-columns \{ grid-template-columns: 1fr; \}/);

assert.match(controller, /enqueueMatchingTelegramNotifications\([\s\S]*?result\.fullSetups/);
assert.doesNotMatch(controller, /enqueueMatchingTelegramNotifications\([\s\S]*?result\.avoidTrades/);
assert.match(service, /recordDiscoveryUsage\([\s\S]*?allowedSetups\.length/);
assert.match(service, /recordAvoidTradeLearningEvent/);
assert.match(candidateRepository, /markRelatedAvoidTradesPromoted/);
assert.match(candidateRepository, /would_have_failed = true/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS avoid_trade_learning_events/);
assert.match(migration, /event_key text NOT NULL UNIQUE/);
assert.match(migration, /became_good_signal boolean/);
assert.match(html, /candidate-quality-avoid-reasons/);

console.log("Avoid Trade result, UI, learning, credit, Telegram, admin, and mobile tests passed.");
