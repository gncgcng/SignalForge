import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const TERMINAL_STATUSES = new Set(["Hit TP", "Hit SL", "Expired"]);
const COMPARISON_FIELDS = Object.freeze([
  "latestCandleRangeAtr",
  "stopBeyondBreakoutCandleAtr",
  "ema20DistanceAtr",
  "breakoutDistanceAtr",
  "prior3BarMoveAtr",
  "volumeRatio"
]);
const RANGE_BUCKETS = Object.freeze([
  { label: "<= 0.75 ATR", minimum: Number.NEGATIVE_INFINITY, maximum: 0.75 },
  { label: "> 0.75 to 1.00 ATR", minimum: 0.75, maximum: 1 },
  { label: "> 1.00 to 1.25 ATR", minimum: 1, maximum: 1.25 },
  { label: "> 1.25 to 1.50 ATR", minimum: 1.25, maximum: 1.5 },
  { label: "> 1.50 ATR", minimum: 1.5, maximum: Number.POSITIVE_INFINITY }
]);

export function parseMomentumProspectiveArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--from", "--to", "--output"].includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  const from = values.from ? requireIsoTimestamp(values.from, "--from").toISOString() : null;
  const to = values.to ? requireIsoTimestamp(values.to, "--to").toISOString() : null;
  if (from && to && new Date(to) < new Date(from)) throw new Error("--to must be at or after --from.");
  return { from, to, output: values.output ? resolve(values.output) : null };
}

export function buildMomentumProspectiveReport(rows) {
  if (!Array.isArray(rows)) throw new Error("Momentum prospective rows must be an array.");
  const normalized = deduplicate(rows.map(normalizeRow).filter((row) => row.strategy.toLowerCase() === "momentum breakout"));
  const observations = normalized.filter((row) => row.diagnostics);
  const legacyWithoutDiagnostics = normalized.filter((row) => !row.diagnostics);
  const terminal = observations.filter((row) => TERMINAL_STATUSES.has(row.status));
  const pending = observations.filter((row) => !TERMINAL_STATUSES.has(row.status));
  const measuredTerminal = terminal.filter((row) => Number.isFinite(row.realizedR));
  const tp = terminal.filter((row) => row.status === "Hit TP");
  const sl = terminal.filter((row) => row.status === "Hit SL");
  const expired = terminal.filter((row) => row.status === "Expired");
  const netR = round(measuredTerminal.reduce((sum, row) => sum + row.realizedR, 0));
  const symbols = uniqueValues(terminal, "symbol");
  const timeframes = uniqueValues(terminal, "timeframe");

  return {
    reportType: "momentum_breakout_prospective_shadow",
    generatedAt: new Date().toISOString(),
    observationalOnly: true,
    productionThresholdRecommendation: null,
    totals: {
      observations: observations.length,
      terminalObservations: terminal.length,
      pendingObservations: pending.length,
      terminalWithRealizedR: measuredTerminal.length,
      terminalMissingRealizedR: terminal.length - measuredTerminal.length,
      tp: tp.length,
      sl: sl.length,
      expired: expired.length,
      netR,
      expectancyR: measuredTerminal.length ? round(netR / measuredTerminal.length) : null,
      legacyMomentumSignalsWithoutDiagnostics: legacyWithoutDiagnostics.length
    },
    observationWindow: timestampRange(observations, "createdAt"),
    terminalOutcomeWindow: timestampRange(terminal, "outcomeTimestamp"),
    tpVsSlMedians: Object.fromEntries(COMPARISON_FIELDS.map((field) => [field, {
      tp: median(tp.map((row) => diagnosticValue(row, field)).filter(Number.isFinite)),
      sl: median(sl.map((row) => diagnosticValue(row, field)).filter(Number.isFinite)),
      tpSample: tp.filter((row) => Number.isFinite(diagnosticValue(row, field))).length,
      slSample: sl.filter((row) => Number.isFinite(diagnosticValue(row, field))).length
    }])),
    latestCandleRangeAtrBuckets: RANGE_BUCKETS.map((bucket) => ({
      label: bucket.label,
      ...summarize(observations.filter((row) => {
        const value = diagnosticValue(row, "latestCandleRangeAtr");
        return Number.isFinite(value) && value > bucket.minimum && value <= bucket.maximum;
      }))
    })),
    bySymbol: groupSummary(observations, "symbol"),
    byTimeframe: groupSummary(observations, "timeframe"),
    byLiquidityTier: groupSummary(observations, "liquidityTier"),
    marketQualityExamples: {
      highestNearZeroRangeFraction: topExamples(observations, "nearZeroRangeFraction"),
      highestMaxRangeToMedianRange: topExamples(observations, "maxRangeToMedianRange"),
      highestMaxVolumeToMedianVolume: topExamples(observations, "maxVolumeToMedianVolume")
    },
    prospectiveStudy: {
      minimumNewTerminalObservations: 30,
      terminalObservations: terminal.length,
      minimumMet: terminal.length >= 30,
      symbols,
      timeframes,
      includesWinnersAndLosers: tp.length > 0 && sl.length > 0,
      guidance: "Do not recommend or activate a threshold before at least 30 new terminal Momentum Breakouts; prefer multiple symbols, multiple timeframes, winners, losers, and non-major markets."
    },
    safety: {
      generationTimeDiagnosticsOnly: true,
      outcomeSource: "generated_signals status, realized_r, and outcome_evaluated_at",
      mutatesSignals: false,
      activatesThresholds: false
    }
  };
}

export async function queryMomentumProspectiveRows(client, { from = null, to = null } = {}) {
  const result = await client.query(`
    SELECT id, signal_id, setup_key, pair, timeframe, strategy, direction, status,
      realized_r, outcome_evaluated_at, hit_tp_at, hit_sl_at, expired_at,
      source, created_at, full_analysis
    FROM generated_signals
    WHERE LOWER(strategy) = 'momentum breakout'
      AND ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
      AND ($2::timestamptz IS NULL OR created_at <= $2::timestamptz)
    ORDER BY created_at ASC, id ASC
  `, [from, to]);
  return result.rows;
}

export async function runMomentumProspectiveReport(options, environment = process.env) {
  const connectionString = String(environment.DATABASE_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for the read-only Momentum prospective report.");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const rows = await queryMomentumProspectiveRows(client, options);
    const report = buildMomentumProspectiveReport(rows);
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
  const options = parseMomentumProspectiveArguments(process.argv.slice(2));
  const report = await runMomentumProspectiveReport(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, output, "utf8");
    console.log(`Momentum prospective report written to ${options.output}`);
  } else {
    process.stdout.write(output);
  }
}

function normalizeRow(row) {
  const fullAnalysis = parseJson(row?.full_analysis ?? row?.fullAnalysis) || {};
  const indicators = fullAnalysis.indicators || row?.indicators || {};
  const diagnostics = indicators.momentumEntryDiagnostics || null;
  return {
    id: row?.id || null,
    signalId: row?.signal_id ?? row?.signalId ?? null,
    setupKey: row?.setup_key ?? row?.setupKey ?? null,
    symbol: String(row?.pair ?? row?.symbol ?? "unknown"),
    timeframe: String(row?.timeframe || "unknown"),
    strategy: String(row?.strategy || "Momentum breakout"),
    direction: String(row?.direction || "unknown"),
    status: String(row?.status || "unknown"),
    realizedR: finiteOrNull(row?.realized_r ?? row?.realizedR),
    outcomeTimestamp: row?.outcome_evaluated_at ?? row?.outcomeEvaluatedAt ?? row?.hit_tp_at ?? row?.hit_sl_at ?? row?.expired_at ?? null,
    source: row?.source || null,
    createdAt: row?.created_at ?? row?.createdAt ?? null,
    liquidityTier: diagnostics?.marketQuality?.liquidityTier || indicators?.liquidityTier || indicators?.sessionLiquidity || "unavailable",
    diagnostics
  };
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

function summarize(rows) {
  const terminal = rows.filter((row) => TERMINAL_STATUSES.has(row.status));
  const measured = terminal.filter((row) => Number.isFinite(row.realizedR));
  const netR = round(measured.reduce((sum, row) => sum + row.realizedR, 0));
  return {
    observations: rows.length,
    terminal: terminal.length,
    pending: rows.length - terminal.length,
    tp: terminal.filter((row) => row.status === "Hit TP").length,
    sl: terminal.filter((row) => row.status === "Hit SL").length,
    expired: terminal.filter((row) => row.status === "Expired").length,
    netR,
    expectancyR: measured.length ? round(netR / measured.length) : null
  };
}

function groupSummary(rows, key) {
  const values = new Map();
  for (const row of rows) {
    const value = String(row[key] || "unavailable");
    if (!values.has(value)) values.set(value, []);
    values.get(value).push(row);
  }
  return [...values.entries()]
    .map(([value, groupedRows]) => ({ value, ...summarize(groupedRows) }))
    .sort((left, right) => right.observations - left.observations || left.value.localeCompare(right.value));
}

function topExamples(rows, field) {
  return rows
    .map((row) => ({ row, value: diagnosticValue(row, field, true) }))
    .filter((item) => Number.isFinite(item.value))
    .sort((left, right) => right.value - left.value)
    .slice(0, 5)
    .map(({ row, value }) => ({
      id: row.id,
      signalId: row.signalId,
      setupKey: row.setupKey,
      symbol: row.symbol,
      timeframe: row.timeframe,
      status: row.status,
      outcomeTimestamp: row.outcomeTimestamp,
      value
    }));
}

function diagnosticValue(row, field, marketQuality = false) {
  return finiteOrNull(marketQuality ? row?.diagnostics?.marketQuality?.[field] : row?.diagnostics?.[field]);
}

function uniqueValues(rows, key) {
  return [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort();
}

function timestampRange(rows, key) {
  const values = rows
    .map((row) => new Date(row[key]))
    .filter((value) => Number.isFinite(value.getTime()))
    .sort((left, right) => left - right);
  return {
    from: values[0]?.toISOString() || null,
    to: values.at(-1)?.toISOString() || null
  };
}

function parseJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function requireIsoTimestamp(value, label) {
  const timestamp = new Date(value);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(timestamp.getTime())) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return timestamp;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Momentum prospective report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
