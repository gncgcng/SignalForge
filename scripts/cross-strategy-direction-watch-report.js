import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  CROSS_STRATEGY_LIST,
  CROSS_STRATEGY_WATCH_STARTED_AT,
  CROSS_STRATEGY_WATCH_VERSION
} from "../src/modules/signals/crossStrategyWatchDiagnostics.js";
import {
  buildCrossStrategyWatchObservations,
  parseCrossStrategyWatchArguments,
  queryCrossStrategyWatchRows,
  sampleLabel,
  summarize
} from "./cross-strategy-watch-report.js";

export const DIRECTION_WATCH_VERSION = "cross_strategy_direction_watch_v1";
// Prospective cohort only. The long/short hypothesis came from a retrospective look at
// Momentum breakout signals created 2026-08-10 through 2026-09-21 (longs ~31% win rate,
// shorts ~15%). Starting at midnight UTC on 2026-09-22 keeps every signal that informed
// the hypothesis out of the cohort that tests it.
export const DIRECTION_WATCH_STARTED_AT = "2026-09-22T00:00:00.000Z";
export const MINIMUM_DECIDED_PER_DIRECTION = 30;
export const DIRECTIONS = Object.freeze(["long", "short"]);

export function buildCrossStrategyDirectionWatchReport(rows, options = {}) {
  if (!Array.isArray(rows)) throw new Error("Cross-strategy direction watch rows must be an array.");
  const asOf = validDate(options.asOf) || new Date();
  const observations = buildCrossStrategyWatchObservations(rows).filter(isDirectionCohortObservation);

  const strategiesSeen = new Set(observations.map((row) => row.strategy));
  const allStrategies = [...CROSS_STRATEGY_LIST, ...[...strategiesSeen].filter((name) => !CROSS_STRATEGY_LIST.includes(name))];

  return {
    reportType: "cross_strategy_direction_watch",
    version: DIRECTION_WATCH_VERSION,
    parentStudy: {
      version: CROSS_STRATEGY_WATCH_VERSION,
      studyStartedAt: CROSS_STRATEGY_WATCH_STARTED_AT
    },
    studyStartedAt: DIRECTION_WATCH_STARTED_AT,
    reportAsOf: asOf.toISOString(),
    observationalOnly: true,
    productionDecisionInput: false,
    maturityGate: {
      minimumDecidedPerDirection: MINIMUM_DECIDED_PER_DIRECTION,
      semantics: "A long-vs-short comparison is reported only when BOTH directions of a strategy have at least this many decided (Hit TP + Hit SL) signals. Below the gate, per-direction numbers are shown for monitoring but no comparison is drawn."
    },
    totals: summarizeByDirection(observations),
    byStrategy: allStrategies.map((strategy) => ({
      strategy,
      ...summarizeByDirection(observations.filter((row) => row.strategy === strategy))
    })),
    safety: {
      canonicalOutcomeSource: "generated_signals status, realized_r, and outcome_evaluated_at",
      backfillsPreStudySignals: false,
      changesProductionSignal: false,
      changesTelegram: false,
      changesCredits: false,
      changesOutcome: false,
      changesDirectionFiltering: false
    }
  };
}

export async function runCrossStrategyDirectionWatchReport(options = {}, environment = process.env) {
  const connectionString = String(environment.DATABASE_URL || environment.DATABASE_PUBLIC_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for the read-only cross-strategy direction watch report.");
  const client = new Client({ connectionString, options: "-c default_transaction_read_only=on" });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const rows = await queryCrossStrategyWatchRows(client);
    const report = buildCrossStrategyDirectionWatchReport(rows, options);
    await client.query("ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

function isDirectionCohortObservation(row) {
  return Boolean(
    DIRECTIONS.includes(row.direction) &&
    row.generatedAt &&
    row.generatedAt.toISOString() >= DIRECTION_WATCH_STARTED_AT
  );
}

function summarizeByDirection(rows) {
  const long = summarize(rows.filter((row) => row.direction === "long"));
  const short = summarize(rows.filter((row) => row.direction === "short"));
  return { long, short, comparison: compareDirections(long, short) };
}

export function compareDirections(long, short) {
  const belowGate = [["long", long], ["short", short]]
    .filter(([, summary]) => summary.decided < MINIMUM_DECIDED_PER_DIRECTION)
    .map(([direction, summary]) => `${direction} ${summary.decided}/${MINIMUM_DECIDED_PER_DIRECTION} decided (${sampleLabel(summary.decided)})`);
  if (belowGate.length) {
    return {
      status: "WITHHELD",
      formalReviewEligible: false,
      reason: `Maturity gate not met: ${belowGate.join("; ")}.`,
      winRateDiffLongMinusShort: null,
      expectancyRDiffLongMinusShort: null
    };
  }
  return {
    status: "ELIGIBLE FOR FORMAL REVIEW",
    formalReviewEligible: true,
    reason: `Both directions have at least ${MINIMUM_DECIDED_PER_DIRECTION} decided signals.`,
    winRateDiffLongMinusShort: difference(long.winRate, short.winRate),
    expectancyRDiffLongMinusShort: difference(long.expectancyR, short.expectancyR)
  };
}

function difference(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? Number((left - right).toFixed(6)) : null;
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function main() {
  const options = parseCrossStrategyWatchArguments(process.argv.slice(2));
  const report = await runCrossStrategyDirectionWatchReport(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, output, "utf8");
    console.log(`Cross-strategy direction watch report written to ${options.output}`);
  } else {
    process.stdout.write(output);
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Cross-strategy direction watch report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
