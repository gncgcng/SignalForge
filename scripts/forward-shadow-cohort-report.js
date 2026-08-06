import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const FORWARD_OUTCOME_R_VERSION = "terminal_v1_tp_rr_sl_minus1_expired_zero";
export const FORWARD_COHORT_MIN_CONFIDENCE = 80;
export const FORWARD_COHORT_MAX_CONFIDENCE = 84;

const terminalStatuses = new Set(["Hit TP", "Hit SL", "Expired"]);
const canonicalSources = new Set(["manual_scan", "auto_crypto_watcher", "telegram_alert", "candidate_promotion"]);
const excludedSources = new Set(["backtest_shadow", "admin_test"]);
const nonProductionMarker = /(^|[:/_-])(test|fixture|replay|backtest)(?=$|[:/_-])/i;

export function parseForwardShadowArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--from", "--to", "--output"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (!values.from) throw new Error("--from <ISO timestamp> is required.");
  const from = requireIsoTimestamp(values.from, "--from");
  const to = values.to ? requireIsoTimestamp(values.to, "--to") : null;
  if (to && to.getTime() < from.getTime()) throw new Error("--to must be at or after --from.");
  return {
    from: from.toISOString(),
    to: to?.toISOString() || null,
    output: values.output ? resolve(values.output) : null
  };
}

export function buildForwardShadowCohortReport(rows, options) {
  const from = requireIsoTimestamp(options?.from, "from");
  const to = options?.to ? requireIsoTimestamp(options.to, "to") : null;
  if (to && to.getTime() < from.getTime()) throw new Error("Cohort end must be at or after cohort start.");
  if (!Array.isArray(rows)) throw new Error("Forward-shadow rows must be an array.");

  const matching = deduplicateRows(rows.filter((row) => isForwardCohortRow(row, from, to)));
  const active = matching.filter((row) => row.status === "Active");
  const terminal = matching.filter((row) => terminalStatuses.has(row.status));
  const evaluated = terminal.filter(hasCompleteForwardMetrics);
  const missingMetrics = terminal.filter((row) => !hasCompleteForwardMetrics(row));
  const otherIncomplete = matching.filter((row) => row.status !== "Active" && !terminalStatuses.has(row.status));
  const tp = evaluated.filter((row) => row.status === "Hit TP").length;
  const sl = evaluated.filter((row) => row.status === "Hit SL").length;
  const expired = evaluated.filter((row) => row.status === "Expired").length;
  const totalRealizedR = round(evaluated.reduce((sum, row) => sum + Number(row.realized_r), 0));
  const expectancyR = evaluated.length ? round(totalRealizedR / evaluated.length) : null;
  const resolvedTrades = tp + sl;
  const winRate = resolvedTrades ? round((tp / resolvedTrades) * 100) : null;
  const evaluatedCoverage = {
    symbols: coverage(evaluated, "pair"),
    timeframes: coverage(evaluated, "timeframe"),
    strategies: coverage(evaluated, "strategy"),
    directions: coverage(evaluated, "direction")
  };
  const targetChecks = {
    evaluatedSignals: { required: 30, actual: evaluated.length, passed: evaluated.length >= 30 },
    symbols: { required: 2, actual: evaluatedCoverage.symbols.length, passed: evaluatedCoverage.symbols.length >= 2 },
    timeframes: { required: 2, actual: evaluatedCoverage.timeframes.length, passed: evaluatedCoverage.timeframes.length >= 2 }
  };
  const targetMet = Object.values(targetChecks).every((check) => check.passed);

  return {
    reportType: "forward_shadow_confidence_80_84",
    outcomeRVersion: FORWARD_OUTCOME_R_VERSION,
    cohort: { from: from.toISOString(), to: to?.toISOString() || null, confidenceMinimum: 80, confidenceMaximum: 84 },
    totals: {
      matchingSignals: matching.length,
      activeIncompleteSignals: active.length,
      otherIncompleteSignals: otherIncomplete.length,
      evaluatedSignals: evaluated.length,
      missingMetricRecords: missingMetrics.length,
      tp,
      sl,
      expired,
      totalRealizedR,
      expectancyR,
      winRatePercent: winRate,
      winRateDenominator: resolvedTrades
    },
    coverage: evaluatedCoverage,
    matchingCoverage: {
      symbols: coverage(matching, "pair"),
      timeframes: coverage(matching, "timeframe"),
      strategies: coverage(matching, "strategy"),
      directions: coverage(matching, "direction")
    },
    signalIdentifiers: matching.map(signalIdentifier),
    evaluatedSignalIdentifiers: evaluated.map(signalIdentifier),
    activeIncompleteSignalIdentifiers: active.map(signalIdentifier),
    missingMetricRecords: missingMetrics.map((row) => ({
      ...signalIdentifier(row),
      status: row.status,
      missing: missingMetricFields(row)
    })),
    forwardObservationTarget: {
      met: targetMet,
      checks: targetChecks,
      conclusion: targetMet
        ? "The pre-registered forward observation sample target is met; this remains historical observation, not a production rule."
        : "The pre-registered forward observation sample target is not yet met."
    },
    costs: {
      feesRecorded: false,
      spreadRecorded: false,
      slippageRecorded: false,
      statement: "Fees, spread, and slippage are not recorded by this cohort report and are not included in realized R."
    },
    liveRecommendation: null,
    safetyStatement: "This report must not recommend or apply a live block, filter, confidence change, risk change, or Telegram change."
  };
}

export async function queryForwardShadowRows(client, { from, to }) {
  const result = await client.query(`
    SELECT id, signal_id, dedupe_key, setup_key, pair, timeframe, strategy, direction,
      confidence, calibrated_confidence, source, source_history, generated_by, status,
      risk_reward, realized_r, outcome_evaluated_at, outcome_r_version, created_at, updated_at
    FROM generated_signals
    WHERE created_at >= $1::timestamptz
      AND ($2::timestamptz IS NULL OR created_at <= $2::timestamptz)
      AND COALESCE(calibrated_confidence, confidence) BETWEEN $3 AND $4
      AND source = ANY($5::text[])
    ORDER BY created_at ASC, id ASC
  `, [from, to, FORWARD_COHORT_MIN_CONFIDENCE, FORWARD_COHORT_MAX_CONFIDENCE, [...canonicalSources]]);
  return result.rows;
}

export async function runForwardShadowCohortReport(options, environment = process.env) {
  const connectionString = String(environment.DATABASE_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for the read-only forward-shadow cohort report.");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const rows = await queryForwardShadowRows(client, options);
    const report = buildForwardShadowCohortReport(rows, options);
    await client.query("ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const options = parseForwardShadowArguments(process.argv.slice(2));
  const report = await runForwardShadowCohortReport(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, output, "utf8");
    console.log(`Forward-shadow cohort report written to ${options.output}`);
  } else {
    process.stdout.write(output);
  }
}

function isForwardCohortRow(row, from, to) {
  const createdAt = new Date(row?.created_at ?? row?.createdAt);
  if (!Number.isFinite(createdAt.getTime()) || createdAt < from || to && createdAt > to) return false;
  const confidence = Number(row?.calibrated_confidence ?? row?.calibratedConfidence ?? row?.confidence);
  if (!Number.isFinite(confidence) || confidence < FORWARD_COHORT_MIN_CONFIDENCE || confidence > FORWARD_COHORT_MAX_CONFIDENCE) return false;
  const source = String(row?.source || "");
  if (!canonicalSources.has(source)) return false;
  const history = parseSourceHistory(row?.source_history ?? row?.sourceHistory);
  if (history.some((item) => excludedSources.has(item))) return false;
  return ![row?.generated_by, row?.generatedBy, row?.signal_id, row?.signalId, row?.setup_key, row?.setupKey, row?.id]
    .filter(Boolean)
    .some((value) => nonProductionMarker.test(String(value)));
}

function deduplicateRows(rows) {
  const selected = new Map();
  for (const row of rows) {
    const key = canonicalIdentity(row);
    const existing = selected.get(key);
    if (!existing || rowPriority(row) > rowPriority(existing)) selected.set(key, row);
  }
  return [...selected.values()].sort((left, right) =>
    new Date(left.created_at ?? left.createdAt) - new Date(right.created_at ?? right.createdAt) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function canonicalIdentity(row) {
  return String(row?.setup_key || row?.setupKey || row?.signal_id || row?.signalId || row?.dedupe_key || row?.dedupeKey || row?.id || "").trim().toLowerCase();
}

function rowPriority(row) {
  const complete = hasCompleteForwardMetrics(row) ? 3 : terminalStatuses.has(row?.status) ? 2 : 1;
  const updated = new Date(row?.updated_at ?? row?.updatedAt ?? 0).getTime();
  return complete * 1e15 + (Number.isFinite(updated) ? updated : 0);
}

function hasCompleteForwardMetrics(row) {
  return terminalStatuses.has(row?.status) &&
    row?.outcome_r_version === FORWARD_OUTCOME_R_VERSION &&
    Number.isFinite(Number(row?.realized_r)) &&
    row?.realized_r !== null && row?.realized_r !== "" &&
    row?.outcome_evaluated_at != null && row?.outcome_evaluated_at !== "" &&
    Number.isFinite(new Date(row.outcome_evaluated_at).getTime());
}

function missingMetricFields(row) {
  const missing = [];
  if (row?.realized_r === null || row?.realized_r === undefined || row?.realized_r === "" || !Number.isFinite(Number(row.realized_r))) missing.push("realized_r");
  if (row?.outcome_evaluated_at == null || row?.outcome_evaluated_at === "" || !Number.isFinite(new Date(row.outcome_evaluated_at).getTime())) missing.push("outcome_evaluated_at");
  if (row?.outcome_r_version !== FORWARD_OUTCOME_R_VERSION) missing.push("outcome_r_version");
  return missing;
}

function coverage(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = String(row?.[key] || "unknown");
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function signalIdentifier(row) {
  return {
    id: row?.id || null,
    signalId: row?.signal_id ?? row?.signalId ?? null,
    setupKey: row?.setup_key ?? row?.setupKey ?? null
  };
}

function parseSourceHistory(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error(`${label} must be an ISO timestamp.`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} must be an ISO timestamp.`);
  return timestamp;
}

function round(value) {
  return Number(Number(value).toFixed(6));
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Forward-shadow cohort report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
