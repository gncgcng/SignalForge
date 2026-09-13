import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  CROSS_STRATEGY_LIST,
  CROSS_STRATEGY_WATCH_STARTED_AT,
  CROSS_STRATEGY_WATCH_VERSION
} from "../src/modules/signals/crossStrategyWatchDiagnostics.js";

const TERMINAL_STATUSES = new Set(["Hit TP", "Hit SL", "Expired"]);

export function parseCrossStrategyWatchArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--output"].includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  return { output: values.output ? resolve(values.output) : null };
}

export function buildCrossStrategyWatchReport(rows, options = {}) {
  if (!Array.isArray(rows)) throw new Error("Cross-strategy watch rows must be an array.");
  const asOf = validDate(options.asOf) || new Date();
  const observations = deduplicate(rows.map(normalizeRow).filter(isStudyObservation));

  const strategiesSeen = new Set(observations.map((row) => row.strategy));
  const allStrategies = [...CROSS_STRATEGY_LIST, ...[...strategiesSeen].filter((name) => !CROSS_STRATEGY_LIST.includes(name))];

  const shadowAffected = observations.filter((row) => row.adaptiveShadow.wouldHaveChangedOutcome);
  const shadowUnaffected = observations.filter((row) => !row.adaptiveShadow.wouldHaveChangedOutcome);

  return {
    reportType: "cross_strategy_watch",
    version: CROSS_STRATEGY_WATCH_VERSION,
    studyStartedAt: CROSS_STRATEGY_WATCH_STARTED_AT,
    reportAsOf: asOf.toISOString(),
    observationalOnly: true,
    productionDecisionInput: false,
    totals: summarize(observations),
    byStrategy: allStrategies.map((strategy) => ({
      strategy,
      ...summarize(observations.filter((row) => row.strategy === strategy))
    })),
    adaptiveShadow: {
      shadowAffected: summarize(shadowAffected),
      shadowUnaffected: summarize(shadowUnaffected),
      semantics: "shadowAffected = observations where the disabled adaptive-adjustment logic would have moved qualityScore across the strategy's minimumQuality boundary, i.e. would have suppressed a signal that actually fired."
    },
    safety: {
      canonicalOutcomeSource: "generated_signals status, realized_r, and outcome_evaluated_at",
      backfillsPreStudySignals: false,
      changesProductionSignal: false,
      changesTelegram: false,
      changesCredits: false,
      changesOutcome: false,
      reEnablesAdaptiveAdjustment: false
    }
  };
}

export async function queryCrossStrategyWatchRows(client) {
  const result = await client.query(`
    SELECT id, signal_id, setup_key, pair, timeframe, strategy, direction, status,
      entry, stop_loss, take_profit, risk_reward, confidence, setup_quality_score,
      valid_until, realized_r, outcome_evaluated_at, hit_tp_at, hit_sl_at, expired_at,
      source, created_at, full_analysis
    FROM generated_signals
    WHERE created_at >= $1::timestamptz
      AND full_analysis #>> '{indicators,crossStrategyWatchDiagnostics,version}' = $2
    ORDER BY created_at ASC, id ASC
  `, [CROSS_STRATEGY_WATCH_STARTED_AT, CROSS_STRATEGY_WATCH_VERSION]);
  return result.rows;
}

export async function runCrossStrategyWatchReport(options = {}, environment = process.env) {
  const connectionString = String(environment.DATABASE_URL || environment.DATABASE_PUBLIC_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for the read-only cross-strategy watch report.");
  const client = new Client({ connectionString, options: "-c default_transaction_read_only=on" });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const rows = await queryCrossStrategyWatchRows(client);
    const report = buildCrossStrategyWatchReport(rows, options);
    await client.query("ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

function normalizeRow(row) {
  const fullAnalysis = parseJson(row?.full_analysis ?? row?.fullAnalysis) || {};
  const diagnostic = fullAnalysis?.indicators?.crossStrategyWatchDiagnostics || row?.crossStrategyWatchDiagnostics || null;
  const createdAt = validDate(row?.created_at ?? row?.createdAt);
  const generatedAt = validDate(diagnostic?.generatedAt) || createdAt;
  const outcomeAt = validDate(row?.outcome_evaluated_at ?? row?.outcomeEvaluatedAt) ||
    validDate(row?.hit_tp_at ?? row?.hitTpAt) || validDate(row?.hit_sl_at ?? row?.hitSlAt) ||
    validDate(row?.expired_at ?? row?.expiredAt);
  return {
    id: row?.id || null,
    signalId: row?.signal_id ?? row?.signalId ?? null,
    setupKey: row?.setup_key ?? row?.setupKey ?? null,
    strategy: String(row?.strategy ?? diagnostic?.strategy ?? "unknown"),
    status: String(row?.status || "Active"),
    realizedR: finiteOrNull(row?.realized_r ?? row?.realizedR),
    generatedAt,
    outcomeAt,
    diagnostic,
    adaptiveShadow: diagnostic?.adaptiveShadow || { wouldHaveChangedOutcome: false, wouldHaveAdjusted: false, shadowAdjustment: 0, shadowFactorsApplied: [] }
  };
}

function isStudyObservation(row) {
  return Boolean(
    row.diagnostic?.version === CROSS_STRATEGY_WATCH_VERSION &&
    row.generatedAt &&
    row.generatedAt.toISOString() >= CROSS_STRATEGY_WATCH_STARTED_AT
  );
}

function summarize(rows) {
  const tp = rows.filter((row) => row.status === "Hit TP").length;
  const sl = rows.filter((row) => row.status === "Hit SL").length;
  const expired = rows.filter((row) => row.status === "Expired").length;
  const active = rows.filter((row) => !TERMINAL_STATUSES.has(row.status)).length;
  const terminal = tp + sl + expired;
  const decided = tp + sl;
  const measured = rows.filter((row) => TERMINAL_STATUSES.has(row.status) && Number.isFinite(row.realizedR));
  const netR = round(measured.reduce((sum, row) => sum + row.realizedR, 0));
  return {
    generated: rows.length,
    terminal,
    decided,
    active,
    tp,
    sl,
    expired,
    winRate: decided ? round((tp / decided) * 100) : null,
    netR,
    expectancyR: measured.length ? round(netR / measured.length) : null,
    terminalMissingRealizedR: terminal - measured.length,
    sampleMaturity: {
      decided,
      label: sampleLabel(decided),
      formalReviewEligible: decided >= 30
    }
  };
}

export function sampleLabel(decided) {
  if (decided < 10) return "INSUFFICIENT";
  if (decided < 20) return "VERY EARLY";
  if (decided < 30) return "EARLY EVIDENCE";
  return "ELIGIBLE FOR FORMAL REVIEW";
}

function deduplicate(rows) {
  const selected = new Map();
  for (const row of rows) {
    const key = String(row.setupKey || row.signalId || row.id || "").toLowerCase();
    if (!key) continue;
    const existing = selected.get(key);
    if (!existing || outcomePriority(row) > outcomePriority(existing)) selected.set(key, row);
  }
  return [...selected.values()];
}

function outcomePriority(row) {
  return TERMINAL_STATUSES.has(row.status) ? 2 : 1;
}

function parseJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

async function main() {
  const options = parseCrossStrategyWatchArguments(process.argv.slice(2));
  const report = await runCrossStrategyWatchReport(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, output, "utf8");
    console.log(`Cross-strategy watch report written to ${options.output}`);
  } else {
    process.stdout.write(output);
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Cross-strategy watch report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
