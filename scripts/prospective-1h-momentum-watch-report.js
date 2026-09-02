import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  MOMENTUM_1H_WATCH_STARTED_AT,
  MOMENTUM_1H_WATCH_VERSION
} from "../src/modules/signals/momentum1hWatchDiagnostics.js";

const TERMINAL_STATUSES = new Set(["Hit TP", "Hit SL", "Expired"]);
const DECIDED_STATUSES = new Set(["Hit TP", "Hit SL"]);
const DEFAULT_TIMEZONE = "America/Tijuana";
const MATURITY_HOURS = Object.freeze([24, 48, 72]);
const CONDITION_FIELDS = Object.freeze([
  "atr",
  "relativeVolume",
  "adx",
  "trendStrength",
  "ema20DistanceAtr",
  "ema50DistanceAtr",
  "breakoutDistanceAtr",
  "threeBarExpansionAtr"
]);

export function parseProspective1hMomentumArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--output", "--timezone"].includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  return {
    output: values.output ? resolve(values.output) : null,
    timezone: validTimezone(values.timezone) ? values.timezone : DEFAULT_TIMEZONE
  };
}

export function buildProspective1hMomentumWatchReport(rows, options = {}) {
  if (!Array.isArray(rows)) throw new Error("Prospective 1h Momentum rows must be an array.");
  const timezone = validTimezone(options.timezone) ? options.timezone : DEFAULT_TIMEZONE;
  const asOf = validDate(options.asOf) || new Date();
  const observations = deduplicate(rows.map(normalizeRow).filter(isStudyObservation));
  const preFixPass = observations.filter((row) => row.preFix.deterministic && row.preFix.wouldPass);
  const preFixReject = observations.filter((row) => row.preFix.deterministic && !row.preFix.wouldPass);
  const preFixUnavailable = observations.filter((row) => !row.preFix.deterministic);
  const production = summarize(observations);

  return {
    reportType: "prospective_1h_momentum_watch",
    version: MOMENTUM_1H_WATCH_VERSION,
    studyStartedAt: MOMENTUM_1H_WATCH_STARTED_AT,
    reportAsOf: asOf.toISOString(),
    timezone,
    observationalOnly: true,
    productionDecisionInput: false,
    production,
    preFixPass: summarize(preFixPass),
    preFixReject: summarize(preFixReject),
    preFixUnavailable: summarize(preFixUnavailable),
    preFixRejectReasons: countBy(preFixReject, (row) => row.preFix.reason),
    shadowDisabled: {
      generatedTradesSkipped: observations.length,
      avoidedWins: production.tp,
      avoidedLosses: production.sl,
      avoidedExpired: production.expired,
      unresolvedSkipped: production.active,
      productionNetR: production.netR,
      disabledNetR: 0,
      netRDifference: round(-production.netR),
      unresolvedTradesAreNotTerminalZeroes: true
    },
    sampleMaturity: {
      decided: production.decided,
      label: sampleLabel(production.decided),
      formalReviewEligible: production.decided >= 30,
      automaticDisableRecommendation: false
    },
    maturity: {
      ...Object.fromEntries(MATURITY_HOURS.map((hours) => [`at${hours}Hours`, maturitySummary(observations, asOf, hours)])),
      fullValidityWindow: fullValiditySummary(observations, asOf)
    },
    bySymbol: groupedSummary(observations, (row) => row.symbol),
    generationHour: {
      utc: countBy(observations, (row) => hourLabel(row.generatedAt, "UTC")),
      local: countBy(observations, (row) => hourLabel(row.generatedAt, timezone)),
      sessionMeaningInferred: false
    },
    marketConditions: {
      overallMedians: conditionMedians(observations),
      tpMedians: conditionMedians(observations.filter((row) => row.status === "Hit TP")),
      slMedians: conditionMedians(observations.filter((row) => row.status === "Hit SL")),
      fieldsNotRecordedRemainNull: true
    },
    safety: {
      canonicalOutcomeSource: "generated_signals status, realized_r, and outcome_evaluated_at",
      backfillsPreStudySignals: false,
      changesProductionSignal: false,
      changesTelegram: false,
      changesCredits: false,
      changesOutcome: false,
      optimizesCandleRangeThreshold: false
    }
  };
}

export async function queryProspective1hMomentumWatchRows(client) {
  const result = await client.query(`
    SELECT id, signal_id, setup_key, pair, timeframe, strategy, direction, status,
      entry, stop_loss, take_profit, risk_reward, confidence, setup_quality_score,
      entry_readiness_score, valid_until, realized_r, outcome_evaluated_at,
      hit_tp_at, hit_sl_at, expired_at, source, created_at, full_analysis
    FROM generated_signals
    WHERE strategy = 'Momentum breakout'
      AND timeframe = '1h'
      AND created_at >= $1::timestamptz
      AND full_analysis #>> '{indicators,momentum1hWatchDiagnostics,version}' = $2
    ORDER BY created_at ASC, id ASC
  `, [MOMENTUM_1H_WATCH_STARTED_AT, MOMENTUM_1H_WATCH_VERSION]);
  return result.rows;
}

export async function runProspective1hMomentumWatchReport(options = {}, environment = process.env) {
  const connectionString = String(environment.DATABASE_URL || environment.DATABASE_PUBLIC_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for the read-only prospective 1h Momentum report.");
  const client = new Client({ connectionString, options: "-c default_transaction_read_only=on" });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const rows = await queryProspective1hMomentumWatchRows(client);
    const report = buildProspective1hMomentumWatchReport(rows, options);
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
  const diagnostic = fullAnalysis?.indicators?.momentum1hWatchDiagnostics || row?.momentum1hWatchDiagnostics || null;
  const createdAt = validDate(row?.created_at ?? row?.createdAt);
  const generatedAt = validDate(diagnostic?.generatedAt) || createdAt;
  const outcomeAt = validDate(row?.outcome_evaluated_at ?? row?.outcomeEvaluatedAt) ||
    validDate(row?.hit_tp_at ?? row?.hitTpAt) || validDate(row?.hit_sl_at ?? row?.hitSlAt) ||
    validDate(row?.expired_at ?? row?.expiredAt);
  return {
    id: row?.id || null,
    signalId: row?.signal_id ?? row?.signalId ?? null,
    setupKey: row?.setup_key ?? row?.setupKey ?? null,
    symbol: String(row?.pair ?? row?.symbol ?? diagnostic?.symbol ?? "unknown"),
    timeframe: String(row?.timeframe ?? diagnostic?.timeframe ?? "unknown"),
    strategy: String(row?.strategy ?? diagnostic?.strategy ?? "unknown"),
    direction: String(row?.direction ?? diagnostic?.direction ?? "unknown"),
    status: String(row?.status || "Active"),
    realizedR: finiteOrNull(row?.realized_r ?? row?.realizedR),
    createdAt,
    generatedAt,
    outcomeAt,
    validUntil: validDate(row?.valid_until ?? row?.validUntil),
    diagnostic,
    preFix: {
      deterministic: diagnostic?.preFixCounterfactual?.deterministic === true,
      wouldPass: diagnostic?.preFixCounterfactual?.wouldPreFixMomentumPass === true,
      reason: diagnostic?.preFixCounterfactual?.reason || "OTHER"
    },
    conditions: diagnostic?.marketConditionSnapshot || {}
  };
}

function isStudyObservation(row) {
  return Boolean(
    row.diagnostic?.version === MOMENTUM_1H_WATCH_VERSION &&
    row.strategy === "Momentum breakout" &&
    row.timeframe === "1h" &&
    row.generatedAt &&
    row.generatedAt.toISOString() >= MOMENTUM_1H_WATCH_STARTED_AT
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
    terminalMissingRealizedR: terminal - measured.length
  };
}

function maturitySummary(rows, asOf, hours) {
  const cutoffMs = hours * 60 * 60 * 1000;
  const eligible = rows.filter((row) => row.generatedAt && asOf - row.generatedAt >= cutoffMs);
  const observedByHorizon = eligible.map((row) => {
    if (!row.outcomeAt || row.outcomeAt - row.generatedAt > cutoffMs) return { ...row, status: "Active", realizedR: null };
    return row;
  });
  return { hours, eligibleGenerated: eligible.length, ...summarize(observedByHorizon) };
}

function fullValiditySummary(rows, asOf) {
  const eligible = rows.filter((row) => row.validUntil && asOf >= row.validUntil);
  return { eligibleGenerated: eligible.length, ...summarize(eligible) };
}

function groupedSummary(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) || "unavailable");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([value, items]) => ({ value, ...summarize(items) }))
    .sort((left, right) => right.generated - left.generated || left.value.localeCompare(right.value));
}

function conditionMedians(rows) {
  return Object.fromEntries(CONDITION_FIELDS.map((field) => [field, median(rows
    .map((row) => finiteOrNull(row.conditions?.[field]))
    .filter(Number.isFinite))]));
}

export function sampleLabel(decided) {
  if (decided < 10) return "INSUFFICIENT";
  if (decided < 20) return "VERY EARLY";
  if (decided < 30) return "EARLY EVIDENCE";
  return "ELIGIBLE FOR FORMAL REVIEW";
}

function countBy(rows, keyFn) {
  return Object.fromEntries([...rows.reduce((map, row) => {
    const key = String(keyFn(row) ?? "unavailable");
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function hourLabel(date, timezone) {
  if (!date) return "unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23"
  }).format(date);
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

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
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

function validTimezone(value) {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
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
  const options = parseProspective1hMomentumArguments(process.argv.slice(2));
  const report = await runProspective1hMomentumWatchReport(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, output, "utf8");
    console.log(`Prospective 1h Momentum report written to ${options.output}`);
  } else {
    process.stdout.write(output);
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Prospective 1h Momentum report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
