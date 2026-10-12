import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_SETUPS_KEY,
  LABELS,
  MIN_CASES,
  feeInR,
  monthBlockBootstrap,
  summarizeRecord,
  trackRecordLabel
} from "./research/track-records/stats.js";
import { exportTrackRecords, parseExportArguments } from "./research/export-track-records.js";
import {
  NO_TRACK_RECORD,
  buildTrackRecordView,
  formatR,
  indexTrackRecords,
  renderTrackRecordBlock,
  sortTrackRecords,
  trackRecordKey
} from "../public/trackRecords.js";
import { loadTrackRecords, parseTrackRecordsFile } from "../src/modules/track-records/trackRecordService.js";

const results = {};
const check = (name, fn) => { fn(); results[name] = true; };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- label rules: one fixture per branch, exact boundaries ----------
check("labels: every branch and boundary", () => {
  const range = (low, high) => ({ low, high });
  assert.equal(MIN_CASES, 30);
  // 1. fewer than 30 cases wins over everything, including a clearly negative range
  assert.equal(trackRecordLabel({ n: 29, avgR95: range(-0.5, -0.2) }), LABELS.notEnoughHistory);
  assert.equal(trackRecordLabel({ n: 0, avgR95: null }), LABELS.notEnoughHistory);
  // 2. n = 30 is enough; upper bound below zero
  assert.equal(trackRecordLabel({ n: 30, avgR95: range(-0.5, -0.0001) }), LABELS.lostMoney);
  // upper bound exactly 0 is not "< 0"
  assert.equal(trackRecordLabel({ n: 30, avgR95: range(-0.5, 0) }), LABELS.noClearEdge);
  // 3. lower bound above zero
  assert.equal(trackRecordLabel({ n: 30, avgR95: range(0.0001, 0.4) }), LABELS.madeMoney);
  // lower bound exactly 0 is not "> 0"
  assert.equal(trackRecordLabel({ n: 30, avgR95: range(0, 0.4) }), LABELS.noClearEdge);
  // 4. straddling zero, or no interval at all
  assert.equal(trackRecordLabel({ n: 500, avgR95: range(-0.1, 0.1) }), LABELS.noClearEdge);
  assert.equal(trackRecordLabel({ n: 500, avgR95: null }), LABELS.noClearEdge);
});

// ---------- fee conversion ----------
check("fees: 0.20% round trip on a 2% stop is 0.10R", () => {
  assert.equal(Number(feeInR({ entryPrice: 100, stopLoss: 98 }, 0.002).toFixed(10)), 0.1);
  assert.equal(Number(feeInR({ entryPrice: 50, stopLoss: 51 }, 0.002).toFixed(10)), 0.1); // a short's stop above entry
  assert.equal(Number(feeInR({ entryPrice: 100, stopLoss: 98 }, 0.012).toFixed(10)), 0.6);
  assert.equal(feeInR({ entryPrice: 100, stopLoss: 100 }, 0.002), null);
});

// ---------- export: harness-output fixture -> JSON shape and values ----------
const DAY = 86400000;
let counter = 0;
function signal({ symbol = "BTC-USD", timeframe = "1h", direction = "long", strategy = "Momentum breakout", at, status, rr = 2 }) {
  counter += 1;
  const createdAtMs = Date.parse(at);
  return {
    setupKey: `${symbol}:${timeframe}:${direction}:${createdAtMs / 1000}:${counter}`,
    symbol, timeframe, direction, strategy, createdAtMs,
    entryPrice: 100, stopLoss: direction === "long" ? 98 : 102, takeProfit: direction === "long" ? 104 : 96, riskReward: rr,
    outcome: { status, realizedR: status === "Hit TP" ? rr : status === "Hit SL" ? -1 : 0 }
  };
}
// Momentum breakout / long / 1h: 3 TP, 2 SL, 1 expired, all with a 2% stop and planned 2R, across two months and two
// years (one of them in the research hold-out).
const cell = [
  signal({ at: "2025-03-02T10:00:00Z", status: "Hit TP" }),
  signal({ at: "2025-03-09T10:00:00Z", status: "Hit SL" }),
  signal({ at: "2025-03-16T10:00:00Z", status: "Hit TP" }),
  signal({ at: "2026-08-01T10:00:00Z", status: "Hit TP" }),
  signal({ at: "2026-08-08T10:00:00Z", status: "Hit SL" }),
  signal({ at: "2026-08-15T10:00:00Z", status: "Expired" })
];
const excluded = [
  signal({ direction: "short", at: "2025-03-03T10:00:00Z", status: "Hit TP" }), // shorts never published
  signal({ symbol: "DELISTED-USD", at: "2025-03-03T10:00:00Z", status: "Hit TP" }), // outside the verdict universe
  signal({ timeframe: "1m", at: "2025-03-03T10:00:00Z", status: "Hit TP" }), // timeframe not emitted
  { ...signal({ at: "2025-03-04T10:00:00Z", status: "Hit SL" }), setupKey: "blocked-by-cooldown" } // not accepted
];
const fiveMinute = signal({ timeframe: "5m", strategy: "Breakout retest", at: "2025-04-01T10:00:00Z", status: "Hit SL" });
const allSignals = [...cell, ...excluded, fiveMinute];
const accepted = allSignals.filter((record) => record.setupKey !== "blocked-by-cooldown").map((record) => record.setupKey);
const fixtureRun = {
  signals: allSignals,
  variants: { variants: { V1: { label: "longs only", accepted } } },
  universe: { pairs: ["BTC-USD", "ETH-USD"] },
  fidelity: {
    recall: 0.9286, precision: 0.875, pass: true,
    gate: { window: { from: "2026-09-14T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z", timeframes: ["5m", "15m", "1h", "4h"] }, live: 56, matched: 52 },
    primaryPrecisionTest: { window: { from: "2026-09-14T00:00:00.000Z", to: "2026-09-28T15:00:00.000Z", timeframes: ["15m"] }, replayWithLiveScanEvidence: 24, matched: 21 },
    perTimeframeAccurateEvidence: { "1h": { live: 8, matched: 8, recall: 1 } }
  },
  verdicts: { generatedAt: "2026-10-11T20:43:14.520Z", fiveMinuteFidelity: { verified: false }, run: { phase1Signals: 19461 } }
};
const exportOptions = parseExportArguments([
  "--run", "fixture", "--variant", "V1", "--variant-reason", "shorts blocked", "--harness-commit", "2100547",
  "--generated-at", "2026-10-12T00:00:00Z"
]);
const exported = exportTrackRecords(fixtureRun, exportOptions);

check("export: shape, metadata and filtering", () => {
  assert.equal(exported.schema, "signalforge.track-records");
  assert.equal(exported.version, 1);
  assert.equal(exported.generated_at, "2026-10-12T00:00:00.000Z");
  assert.equal(exported.harness.commit, "2100547");
  assert.deepEqual(exported.variant, { id: "V1", label: "longs only", reason: "shorts blocked" });
  assert.deepEqual(exported.pairs, ["BTC-USD", "ETH-USD"]);
  assert.deepEqual(exported.timeframes, ["5m", "15m", "1h", "4h"]);
  assert.deepEqual(exported.approximateTimeframes, ["5m"]);
  assert.deepEqual(exported.period, { from: "2025-03-02", to: "2026-08-15", holdoutIncluded: true, note: exported.period.note });
  assert.equal(exported.fees.headlineRoundTrip, 0.002);
  assert.equal(exported.fees.retailRoundTrip, 0.012);
  assert.equal(exported.fees.retailAvailable, true);
  assert.equal(exported.fidelity.recall, 92.9);
  assert.equal(exported.fidelity.precision, 87.5);
  assert.deepEqual(exported.fidelity.recallCounts, { liveSignals: 56, matched: 52 });
  assert.equal(exported.fidelity.fiveMinutePrecisionVerified, false);
  assert.equal(exported.counts.resolvedSetups, 7, "6 in the 1h cell + 1 approximate 5m; shorts, other pairs, 1m and blocked excluded");
  assert.deepEqual(exported.records.map((record) => record.key), [
    ALL_SETUPS_KEY,
    "breakout retest|long|5m",
    "momentum breakout|long|1h"
  ]);
  assert.ok(exported.records.every((record) => record.direction !== "short"));
  assert.equal(exported.records[1].approximate, true);
  // No per-trade rows: every record is a summary.
  assert.ok(exported.records.every((record) => !("members" in record) && !("records" in record) && !("setupKey" in record)));
});

check("export: values for a hand-computed record", () => {
  const record = exported.records.find((item) => item.key === "momentum breakout|long|1h");
  assert.equal(record.n, 5);
  assert.equal(record.tp, 3);
  assert.equal(record.sl, 2);
  assert.equal(record.expired, 1);
  assert.equal(record.winRate, 60);
  assert.equal(record.avgPlannedR, 2);
  assert.equal(record.breakEvenWinRate, 33.3);
  // gross (2 + 2 + 2 - 1 - 1 + 0) / 6; headline fee 0.10R each; retail 0.60R each
  assert.equal(record.grossAvgR, 0.667);
  assert.equal(record.avgR, 0.567); // (3 x 1.9 - 2 x 1.1 - 0.1) / 6
  assert.equal(record.retailAvgR, 0.067); // (3 x 1.4 - 2 x 1.6 - 0.6) / 6
  assert.equal(record.avgR95.months, 2);
  assert.deepEqual(record.byYear, [
    { year: 2025, n: 3, expired: 0, avgR: 0.9 }, // (1.9 - 1.1 + 1.9) / 3
    { year: 2026, n: 2, expired: 1, avgR: 0.233 } // (1.9 - 1.1 - 0.1) / 3
  ]);
  assert.equal(record.label, LABELS.notEnoughHistory, "5 cases < 30");
  assert.deepEqual(exported.labelCounts, {
    [LABELS.notEnoughHistory]: 2, [LABELS.lostMoney]: 0, [LABELS.madeMoney]: 0, [LABELS.noClearEdge]: 0
  });
});

check("export: deterministic for a fixed bootstrap seed", () => {
  const again = exportTrackRecords(fixtureRun, exportOptions);
  assert.equal(JSON.stringify(again), JSON.stringify(exported));
  // Months with different sums, so the resampled means actually vary with the seed.
  const rows = Array.from({ length: 120 }, (_, index) => ({ month: `2025-${String((index % 12) + 1).padStart(2, "0")}`, r: (index % 12) - 6 + (index % 5) * 0.1 }));
  assert.deepEqual(monthBlockBootstrap(rows, { samples: 2000, seed: 7 }), monthBlockBootstrap(rows, { samples: 2000, seed: 7 }));
  assert.notDeepEqual(monthBlockBootstrap(rows, { samples: 2000, seed: 7 }), monthBlockBootstrap(rows, { samples: 2000, seed: 8 }));
  assert.equal(monthBlockBootstrap([{ month: "2025-01", r: 1 }], { samples: 10, seed: 1 }), null, "one month cannot be resampled");
});

check("export: a large clearly losing record is labelled as lost money", () => {
  const losing = Array.from({ length: 60 }, (_, index) => signal({
    at: `2025-${String((index % 12) + 1).padStart(2, "0")}-05T10:00:00Z`,
    status: index % 5 === 0 ? "Hit TP" : "Hit SL",
    rr: 2
  }));
  const summary = summarizeRecord(losing);
  assert.equal(summary.n, 60);
  assert.ok(summary.avgR95.high < 0);
  assert.equal(summary.label, LABELS.lostMoney);
});

// ---------- card mapping ----------
check("cards: known key, unknown key, short key", () => {
  const file = { available: true, fees: exported.fees, records: exported.records };
  const index = indexTrackRecords(file);
  const known = buildTrackRecordView(file, { setupType: "Momentum breakout", direction: "long", timeframe: "1h" }, index);
  assert.equal(known.render, true);
  assert.equal(known.matched, true);
  assert.equal(known.heading, "Track record: not enough history yet");
  assert.equal(known.casesLine, "5 past cases · won 60% (break-even needs 33%) · average +0.57R per trade after fees");
  assert.equal(known.retailLine, "At typical retail fees (1.20% round trip): +0.07R");
  assert.equal(known.tone, "neutral");
  const knownHtml = renderTrackRecordBlock(known, escapeHtml);
  assert.match(knownHtml, /data-track-record-key="momentum breakout\|long\|1h"/);
  assert.match(knownHtml, /href="#track-records">How we measure this</);

  const unknown = buildTrackRecordView(file, { setupType: "Range bounce", direction: "long", timeframe: "4h" }, index);
  assert.deepEqual(unknown, { render: true, matched: false, tone: "neutral", label: NO_TRACK_RECORD });
  assert.match(renderTrackRecordBlock(unknown, escapeHtml), /No track record yet/);

  const short = buildTrackRecordView(file, { setupType: "Momentum breakout", direction: "short", timeframe: "1h" }, index);
  assert.deepEqual(short, { render: false });
  assert.equal(renderTrackRecordBlock(short, escapeHtml), "");

  const approximate = buildTrackRecordView(file, { setupType: "Breakout retest", direction: "long", timeframe: "5m" }, index);
  assert.match(renderTrackRecordBlock(approximate, escapeHtml), /Approximate/);

  // Colour: green only for "Has made money historically".
  const tones = Object.fromEntries(Object.values(LABELS).map((label) =>
    [label, buildTrackRecordView({ available: true, records: [{ ...exported.records[2], label }] }, { setupType: "Momentum breakout", direction: "long", timeframe: "1h" }).tone]));
  assert.deepEqual(tones, {
    [LABELS.notEnoughHistory]: "neutral",
    [LABELS.lostMoney]: "loss",
    [LABELS.madeMoney]: "gain",
    [LABELS.noClearEdge]: "neutral"
  });

  // Retail line falls back when stop distances were not available.
  const noRetail = buildTrackRecordView({ available: true, fees: { retailAvailable: false }, records: exported.records }, { setupType: "Momentum breakout", direction: "long", timeframe: "1h" });
  assert.equal(noRetail.retailLine, "Higher fees make these results worse.");

  // Before the file loads, or when it is unavailable, nothing matches.
  assert.equal(buildTrackRecordView({ available: false }, { setupType: "Momentum breakout", direction: "long", timeframe: "1h" }).label, NO_TRACK_RECORD);
  assert.equal(trackRecordKey(" Momentum Breakout ", "LONG", "1H"), "momentum breakout|long|1h");
  assert.equal(formatR(-0.214), "−0.21R");
  assert.equal(formatR(0.0001), "0.00R");
});

check("table: All setups stays first for every sort", () => {
  const rows = [
    { key: "a", n: 10, winRate: 50, avgR: -0.2 },
    { key: ALL_SETUPS_KEY, n: 5, winRate: 10, avgR: -0.9 },
    { key: "b", n: 30, winRate: 20, avgR: 0.1 }
  ];
  assert.deepEqual(sortTrackRecords(rows, "n", "desc").map((row) => row.key), [ALL_SETUPS_KEY, "b", "a"]);
  assert.deepEqual(sortTrackRecords(rows, "winRate", "desc").map((row) => row.key), [ALL_SETUPS_KEY, "a", "b"]);
  assert.deepEqual(sortTrackRecords(rows, "avgR", "asc").map((row) => row.key), [ALL_SETUPS_KEY, "a", "b"]);
});

// ---------- server loader ----------
check("server: loads a valid file and survives a missing or wrong one", () => {
  const dir = mkdtempSync(join(tmpdir(), "track-records-"));
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify(exported));
  assert.equal(loadTrackRecords(good).available, true);
  assert.equal(loadTrackRecords(join(dir, "missing.json")).available, false);
  assert.throws(() => parseTrackRecordsFile(JSON.stringify({ ...exported, version: 2 })), /schema/);
});

console.log(JSON.stringify(results, null, 2));
