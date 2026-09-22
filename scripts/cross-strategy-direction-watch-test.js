import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CROSS_STRATEGY_LIST,
  CROSS_STRATEGY_WATCH_STARTED_AT,
  CROSS_STRATEGY_WATCH_VERSION
} from "../src/modules/signals/crossStrategyWatchDiagnostics.js";
import {
  buildCrossStrategyDirectionWatchReport,
  compareDirections,
  DIRECTION_WATCH_STARTED_AT,
  DIRECTION_WATCH_VERSION,
  MINIMUM_DECIDED_PER_DIRECTION
} from "./cross-strategy-direction-watch-report.js";
import { buildCrossStrategyWatchReport } from "./cross-strategy-watch-report.js";

assert.equal(MINIMUM_DECIDED_PER_DIRECTION, 30);
assert.ok(DIRECTION_WATCH_STARTED_AT > CROSS_STRATEGY_WATCH_STARTED_AT, "the direction cohort must start inside the parent study");

// --- cohort boundaries ---

const rows = [
  // Momentum breakout: both directions clear the gate
  ...decidedRows("Momentum breakout", "long", { tp: 12, sl: 20, tpR: 2.5 }),
  ...decidedRows("Momentum breakout", "short", { tp: 5, sl: 25, tpR: 2.5 }),
  row("mb-long-expired", "Momentum breakout", "long", { status: "Expired", realizedR: 0 }),
  row("mb-short-active", "Momentum breakout", "short", { status: "Active" }),
  // Breakout retest: long clears the gate, short does not
  ...decidedRows("Breakout retest", "long", { tp: 10, sl: 20, tpR: 2 }),
  ...decidedRows("Breakout retest", "short", { tp: 3, sl: 26, tpR: 2 }),
  // parent-study signal created before the direction cohort started: excluded
  row("pre-cohort", "Momentum breakout", "short", {
    generatedAt: "2026-09-21T23:59:59.000Z",
    status: "Hit SL",
    realizedR: -1
  }),
  // signal without the parent study's diagnostic tag: excluded
  { ...row("untagged", "Momentum breakout", "long", { status: "Hit TP", realizedR: 2.5 }), full_analysis: {} },
  // duplicate setup key: terminal outcome wins, counted once
  row("dup", "Pullback bounce", "long", { status: "Active", setupKey: "shared-key" }),
  row("dup-2", "Pullback bounce", "long", { status: "Hit TP", realizedR: 2, setupKey: "shared-key" })
];

const report = buildCrossStrategyDirectionWatchReport(rows, { asOf: "2026-10-20T00:00:00.000Z" });

assert.equal(report.version, DIRECTION_WATCH_VERSION);
assert.equal(report.studyStartedAt, DIRECTION_WATCH_STARTED_AT);
assert.deepEqual(report.parentStudy, { version: CROSS_STRATEGY_WATCH_VERSION, studyStartedAt: CROSS_STRATEGY_WATCH_STARTED_AT });
assert.equal(report.productionDecisionInput, false);
assert.equal(report.maturityGate.minimumDecidedPerDirection, 30);
assert.equal(report.byStrategy.length, CROSS_STRATEGY_LIST.length);

const momentum = report.byStrategy.find((entry) => entry.strategy === "Momentum breakout");
assert.equal(momentum.long.generated, 33, "untagged row must be excluded");
assert.equal(momentum.long.decided, 32);
assert.equal(momentum.long.expired, 1);
assert.equal(momentum.short.generated, 31, "pre-cohort row must be excluded");
assert.equal(momentum.short.decided, 30);
assert.equal(momentum.short.active, 1);

// per-direction metrics reuse the parent study's definitions exactly
assert.equal(momentum.long.winRate, 37.5);
assert.equal(momentum.long.netR, 10);
assert.equal(momentum.long.expectancyR, Number((10 / 33).toFixed(6)), "expectancy divides by terminal signals, expired counted as 0R");
assert.equal(momentum.short.winRate, Number(((5 / 30) * 100).toFixed(6)));
assert.equal(momentum.short.netR, -12.5);

assert.equal(momentum.comparison.status, "ELIGIBLE FOR FORMAL REVIEW");
assert.equal(momentum.comparison.formalReviewEligible, true);
assert.equal(momentum.comparison.winRateDiffLongMinusShort, Number((37.5 - (5 / 30) * 100).toFixed(6)));
assert.equal(momentum.comparison.expectancyRDiffLongMinusShort, Number((momentum.long.expectancyR - momentum.short.expectancyR).toFixed(6)));

// --- maturity gate: one direction short of 30 withholds the comparison ---

const retest = report.byStrategy.find((entry) => entry.strategy === "Breakout retest");
assert.equal(retest.long.decided, 30);
assert.equal(retest.short.decided, 29);
assert.equal(retest.comparison.status, "WITHHELD");
assert.equal(retest.comparison.formalReviewEligible, false);
assert.equal(retest.comparison.winRateDiffLongMinusShort, null);
assert.equal(retest.comparison.expectancyRDiffLongMinusShort, null);
assert.match(retest.comparison.reason, /short 29\/30 decided \(EARLY EVIDENCE\)/);
assert.doesNotMatch(retest.comparison.reason, /long/, "only the direction below the gate is named");

const pullback = report.byStrategy.find((entry) => entry.strategy === "Pullback bounce");
assert.equal(pullback.long.generated, 1, "duplicate setup key is counted once");
assert.equal(pullback.long.tp, 1);
assert.equal(pullback.comparison.status, "WITHHELD");
assert.match(pullback.comparison.reason, /long 1\/30 decided \(INSUFFICIENT\); short 0\/30 decided \(INSUFFICIENT\)/);

const zeroVolume = report.byStrategy.find((entry) => entry.strategy === "Mean reversion");
assert.equal(zeroVolume.long.generated, 0);
assert.equal(zeroVolume.short.generated, 0);
assert.equal(zeroVolume.comparison.status, "WITHHELD");

assert.equal(report.totals.long.decided, 32 + 30 + 1);
assert.equal(report.totals.short.decided, 30 + 29);
assert.equal(report.totals.comparison.status, "ELIGIBLE FOR FORMAL REVIEW");

// gate is inclusive at exactly 30 on both sides
const atGate = compareDirections({ decided: 30, winRate: 40, expectancyR: 0.4 }, { decided: 30, winRate: 20, expectancyR: -0.3 });
assert.equal(atGate.status, "ELIGIBLE FOR FORMAL REVIEW");
assert.equal(atGate.winRateDiffLongMinusShort, 20);
assert.equal(atGate.expectancyRDiffLongMinusShort, 0.7);

// --- the parent report is unchanged by the shared exports ---

const parent = buildCrossStrategyWatchReport(rows, { asOf: "2026-10-20T00:00:00.000Z" });
assert.equal(parent.reportType, "cross_strategy_watch");
const parentMomentum = parent.byStrategy.find((entry) => entry.strategy === "Momentum breakout");
assert.equal(parentMomentum.generated, 33 + 31 + 1, "parent study still includes the pre-cohort row and ignores direction");
assert.ok(!("long" in parentMomentum) && !("comparison" in parentMomentum));

// --- source guards ---

const reportSource = await readFile(resolve("scripts/cross-strategy-direction-watch-report.js"), "utf8");
assert.match(reportSource, /BEGIN READ ONLY/);
assert.match(reportSource, /default_transaction_read_only=on/);
assert.doesNotMatch(reportSource, /\b(?:INSERT|UPDATE|DELETE)\b/);

console.log(JSON.stringify({
  version: DIRECTION_WATCH_VERSION,
  studyStartedAt: DIRECTION_WATCH_STARTED_AT,
  momentum,
  retest: retest.comparison
}, null, 2));

function decidedRows(strategy, direction, { tp, sl, tpR }) {
  const built = [];
  for (let index = 0; index < tp; index += 1) built.push(row(`${strategy}-${direction}-tp-${index}`, strategy, direction, { status: "Hit TP", realizedR: tpR }));
  for (let index = 0; index < sl; index += 1) built.push(row(`${strategy}-${direction}-sl-${index}`, strategy, direction, { status: "Hit SL", realizedR: -1 }));
  return built;
}

function row(id, strategy, direction, overrides = {}) {
  const generatedAt = overrides.generatedAt || "2026-09-25T00:00:00.000Z";
  return {
    id: `ags_${id}`,
    signal_id: `sig-${id}`,
    setup_key: overrides.setupKey || `BTC-USD:1h:${direction}:${id}`,
    pair: "BTC-USD",
    timeframe: "1h",
    strategy,
    direction,
    status: overrides.status || "Active",
    realized_r: overrides.realizedR ?? null,
    outcome_evaluated_at: overrides.status && overrides.status !== "Active" ? generatedAt : null,
    created_at: generatedAt,
    full_analysis: {
      indicators: {
        crossStrategyWatchDiagnostics: {
          version: CROSS_STRATEGY_WATCH_VERSION,
          studyStartedAt: CROSS_STRATEGY_WATCH_STARTED_AT,
          generatedAt,
          strategy,
          minimumQuality: 74,
          qualityScore: 74,
          adaptiveShadow: { wouldHaveAdjusted: false, shadowAdjustment: 0, shadowFactorsApplied: [], wouldHaveChangedOutcome: false }
        }
      }
    }
  };
}
