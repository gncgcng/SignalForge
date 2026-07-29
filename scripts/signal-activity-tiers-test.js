import assert from "node:assert/strict";
import {
  buildAdminSignalSupplySummary,
  buildSignalActivityResponse,
  toSafeReadyPreview
} from "../src/modules/signals/signalActivityService.js";

const readySignal = {
  id: "agen_1",
  signalId: "sig_1",
  setupKey: "btc-15m-long",
  pair: "BTC-USD",
  displayPair: "BTCUSD",
  provider: "coinbase-exchange",
  timeframe: "15m",
  direction: "long",
  strategy: "Breakout Retest",
  entry: 100,
  stopLoss: 95,
  takeProfit: 112,
  riskReward: 2.4,
  confidence: 82,
  calibratedConfidence: 82,
  status: "Active"
};

const watchingSignal = {
  id: "agen_watch",
  pair: "ETH-USD",
  displayPair: "ETHUSD",
  timeframe: "15m",
  direction: "short",
  strategy: "Failed Breakout",
  status: "Watching",
  confidence: 68,
  calibratedConfidence: 68,
  setupQualityScore: 74,
  entryReadinessScore: 61,
  warningReasons: ["retest confirmation missing"],
  resultReason: "Setup is forming, but retest confirmation is missing."
};

function testReadyPreviewDoesNotLeakLevels() {
  const preview = toSafeReadyPreview(readySignal);
  assert.equal(preview.tier, "ready_signal");
  assert.equal(preview.unlockEligible, true);
  assert.equal(preview.creditCost, 1);
  assert.equal(Object.hasOwn(preview, "entry"), false);
  assert.equal(Object.hasOwn(preview, "stopLoss"), false);
  assert.equal(Object.hasOwn(preview, "takeProfit"), false);
}

function testFeedShowsWatchingWhenNoReadySignals() {
  const activity = buildSignalActivityResponse({
    readySignals: [],
    watchingSignals: [watchingSignal],
    candidates: [
      {
        id: "cand_1",
        symbol: "BTC-USD",
        displayPair: "BTCUSD",
        timeframe: "15m",
        direction: "long",
        setupType: "Support Bounce",
        setupQualityScore: 72,
        readinessScore: 58,
        confidenceEstimate: 66,
        reasonsForWatching: ["Volume confirmation is missing."],
        nextConditions: ["Waiting for volume to rise above recent average."]
      }
    ],
    marketBrief: {
      mainReasons: ["Market is choppy"],
      weakestPairs: [{ symbol: "XRP-USD", timeframe: "5m", reason: "5m is in testing mode because recent performance was weak." }],
      strongestPairs: [{ symbol: "SOL-USD", summary: "Relative trend strength is improving." }],
      watchingCount: 2,
      avoidCount: 1,
      readySignalCount: 0
    }
  });
  assert.equal(activity.summary.readySignals, 0);
  assert.equal(activity.summary.watchingSetups, 2);
  assert.match(activity.summary.message, /No ready signals/);
  assert.equal(activity.watchingSetups.every((item) => item.creditCost === 0), true);
  assert.equal(activity.avoidTrades.every((item) => item.creditCost === 0), true);
  assert.equal(activity.credits.marketBrief, 0);
  assert.match(activity.whyNoSignal.summary, /waiting/i);
}

function testNormalUsersOnlyGetTopFiveWatchingSetups() {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    id: `cand_${index}`,
    symbol: `TEST${index}-USD`,
    displayPair: `TEST${index}USD`,
    timeframe: "15m",
    direction: "long",
    setupType: "Trend Continuation",
    setupQualityScore: 80 - index,
    readinessScore: 70 - index,
    confidenceEstimate: 65 - index,
    reasonsForWatching: ["Waiting for confirmation."]
  }));
  const userFeed = buildSignalActivityResponse({ candidates, user: { isAdmin: false } });
  const adminFeed = buildSignalActivityResponse({ candidates, user: { isAdmin: true } });
  assert.equal(userFeed.watchingSetups.length, 5);
  assert.equal(adminFeed.watchingSetups.length, 8);
}

function testAdminSupplyWarningAndCounts() {
  const supply = buildAdminSignalSupplySummary({
    generated: {
      candidates_24h: 120,
      candidates_7d: 420,
      ready_24h: 0,
      ready_7d: 14,
      quality_gate_passed_24h: 9,
      quality_gate_passed_7d: 52,
      valid_ready_candidates_24h: 1,
      ready_15m_24h: 3,
      ready_1h_24h: 1,
      ready_4h_24h: 1,
      blocked_5m_24h: 12,
      watching_24h: 28,
      avoid_24h: 9,
      admin_only_24h: 4,
      rejected_24h: 11,
      blocked_24h: 68,
      ready_48h: 0
    },
    telegram: {
      ready_alerts_24h: 0,
      watching_alerts_24h: 0,
      telegram_blocked_24h: 42
    },
    blockReasons: [{ reason: "blocked_low_confidence", status: "blocked_low_confidence", count: 24 }],
    readyNotSent: [{
      signal_id: "sig_missing_delivery",
      display_pair: "ETHUSD",
      timeframe: "1h",
      direction: "long",
      confidence: 67,
      telegram_status: "telegram_blocked_config",
      telegram_block_reason: "Telegram bot token is not configured."
    }]
  });
  assert.equal(supply.counts.candidates, 120);
  assert.equal(supply.counts.qualityGatePassed, 9);
  assert.equal(supply.counts.validReadyCandidates, 1);
  assert.equal(supply.counts.promotedReadySignals, 0);
  assert.equal(supply.counts.promotedReadySignals7d, 14);
  assert.equal(supply.counts.ready15m, 3);
  assert.equal(supply.counts.blocked5m, 12);
  assert.equal(supply.counts.watching, 28);
  assert.equal(supply.counts.avoidTrade, 9);
  assert.match(supply.warning, /No ready signals in 48 hours/);
  assert.equal(supply.telegram.watchingEnabled, false);
  assert.match(supply.topReasonReadySignalsNotProduced, /confidence threshold/i);
  assert.equal(supply.readySignalsNotSent[0].telegramDecision, "telegram_blocked_config");
  assert.match(supply.readySignalsNotSent[0].reason, /bot token/i);
}

testReadyPreviewDoesNotLeakLevels();
testFeedShowsWatchingWhenNoReadySignals();
testNormalUsersOnlyGetTopFiveWatchingSetups();
testAdminSupplyWarningAndCounts();

console.log("signal activity tiers tests passed");
