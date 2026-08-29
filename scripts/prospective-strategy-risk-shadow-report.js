import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  evaluateStrategyRiskShadowOutcomes,
  STRATEGY_RISK_SHADOW_STARTED_AT,
  STRATEGY_RISK_SHADOW_VERSION
} from "../src/modules/signals/strategyRiskShadowDiagnostics.js";

const TERMINAL = new Set(["Hit TP", "Hit SL", "Expired"]);
const STRATEGIES = Object.freeze([
  "Momentum breakout",
  "Breakout retest",
  "Liquidity sweep reversal",
  "VWAP reclaim/rejection",
  "Multi-timeframe continuation",
  "Pullback bounce",
  "Support/resistance retest",
  "Trend continuation",
  "Range bounce",
  "Mean reversion"
]);

export function parseProspectiveRiskShadowArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--from", "--to", "--output"].includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  const from = values.from ? requireTimestamp(values.from, "--from") : STRATEGY_RISK_SHADOW_STARTED_AT;
  const to = values.to ? requireTimestamp(values.to, "--to") : null;
  if (to && new Date(to) < new Date(from)) throw new Error("--to must be at or after --from.");
  return { from, to, output: values.output ? resolve(values.output) : null };
}

export async function evaluateProspectiveStrategyRiskRows(rows, loadCandles) {
  if (!Array.isArray(rows)) throw new Error("Prospective strategy-risk rows must be an array.");
  if (typeof loadCandles !== "function") throw new Error("A read-only candle loader is required.");
  const cache = new Map();
  const observations = [];
  for (const row of rows) {
    const normalized = normalizeRow(row);
    if (!normalized) continue;
    const key = `${normalized.symbol}:${normalized.timeframe}:${normalized.createdAt}:${normalized.validUntil}`;
    let candles = cache.get(key);
    if (!candles) {
      try {
        candles = await loadCandles(normalized);
      } catch (error) {
        candles = { error: error?.message || String(error), candles: [] };
      }
      cache.set(key, candles);
    }
    const candleList = Array.isArray(candles) ? candles : candles?.candles || [];
    observations.push({
      ...normalized,
      candleError: Array.isArray(candles) ? null : candles?.error || null,
      shadowOutcome: evaluateStrategyRiskShadowOutcomes({
        diagnostics: normalized.diagnostics,
        candles: candleList,
        validUntil: normalized.validUntil,
        productionOutcome: normalized.status
      })
    });
  }
  return observations;
}

export function buildProspectiveStrategyRiskShadowReport(observations) {
  if (!Array.isArray(observations)) throw new Error("Prospective strategy-risk observations must be an array.");
  const selected = deduplicate(observations.filter((row) => (
    row?.diagnostics?.version === STRATEGY_RISK_SHADOW_VERSION &&
    new Date(row.diagnostics.generatedAt) >= new Date(STRATEGY_RISK_SHADOW_STARTED_AT)
  )));
  return {
    reportType: "prospective_strategy_risk_shadow",
    version: STRATEGY_RISK_SHADOW_VERSION,
    studyStartedAt: STRATEGY_RISK_SHADOW_STARTED_AT,
    generatedAt: new Date().toISOString(),
    observationalOnly: true,
    totals: summarize(selected),
    byStrategy: Object.fromEntries(STRATEGIES.map((strategy) => [
      strategy,
      summarize(selected.filter((row) => row.strategy === strategy))
    ])),
    safety: {
      productionPlanAuthoritative: true,
      databaseWrites: false,
      canonicalOutcomeWrites: false,
      recommendation: null
    }
  };
}

export async function queryProspectiveStrategyRiskRows(client, { from, to = null }) {
  const result = await client.query(`
    SELECT id, signal_id, setup_key, pair, timeframe, strategy, direction, status,
      entry, stop_loss, take_profit, risk_reward, confidence, realized_r,
      outcome_evaluated_at, hit_tp_at, hit_sl_at, expired_at,
      source, created_at, valid_until, full_analysis
    FROM generated_signals
    WHERE full_analysis #>> '{indicators,strategyRiskShadowDiagnostics,version}' = $1
      AND created_at >= $2::timestamptz
      AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz)
    ORDER BY created_at ASC, id ASC
  `, [STRATEGY_RISK_SHADOW_VERSION, from, to]);
  return result.rows;
}

export async function runProspectiveStrategyRiskShadowReport(options, environment = process.env, dependencies = {}) {
  const connectionString = String(environment.DATABASE_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for the read-only strategy-risk shadow report.");
  const client = dependencies.client || new Client({ connectionString });
  const ownsClient = !dependencies.client;
  if (ownsClient) await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const rows = await queryProspectiveStrategyRiskRows(client, options);
    const observations = await evaluateProspectiveStrategyRiskRows(
      rows,
      dependencies.loadCandles || loadCompletedHistoricalCandles
    );
    const report = buildProspectiveStrategyRiskShadowReport(observations);
    await client.query("ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (ownsClient) await client.end();
  }
}

async function loadCompletedHistoricalCandles(observation) {
  const [{ getReadOnlySignalReviewMarketData }, { selectCompletedCandles }] = await Promise.all([
    import("../src/modules/market-data/marketDataService.js"),
    import("../src/modules/market-data/candleIntegrity.js")
  ]);
  const marketData = await getReadOnlySignalReviewMarketData(observation.symbol, observation.timeframe, {
    from: observation.createdAt,
    to: observation.validUntil
  });
  return selectCompletedCandles(marketData.candles || [], observation.timeframe);
}

function summarize(rows) {
  const terminal = rows.filter((row) => TERMINAL.has(row.status));
  const open = rows.length - terminal.length;
  const production = outcomeSummary(terminal, (row) => row.status, (row) => row.realizedR);
  const modelB = outcomeSummary(
    terminal.filter((row) => row.diagnostics.invalidationStatus === "USABLE"),
    (row) => row.shadowOutcome?.shadowOriginalTpOutcome,
    (row, status) => realizedShadowR(status, row.diagnostics.shadowPlan?.modelB?.riskReward)
  );
  const modelC = outcomeSummary(
    terminal.filter((row) => row.diagnostics.invalidationStatus === "USABLE"),
    (row) => row.shadowOutcome?.shadowSameRTargetOutcome,
    (row, status) => realizedShadowR(status, row.diagnostics.shadowPlan?.modelC?.riskReward)
  );
  return {
    generated: rows.length,
    terminal: terminal.length,
    open,
    production,
    modelB,
    modelC,
    naturalInvalidations: terminal.filter((row) => row.shadowOutcome?.postInvalidation?.occurred).length,
    postInvalidationRecoveriesToTp: terminal.filter((row) => (
      row.shadowOutcome?.postInvalidation?.occurred &&
      row.shadowOutcome.postInvalidation.laterProductionPathOutcome === "Hit TP"
    )).length,
    immediateShadowStopHits: terminal.filter((row) => (
      row.shadowOutcome?.immediateShadowStopTouch &&
      row.shadowOutcome.immediateShadowStopTouch !== "not_touched"
    )).length,
    shadowRrFailures: rows.filter((row) => row.diagnostics.shadowPlan?.modelB?.wouldPassRR === false).length,
    sameCandleAmbiguities: terminal.filter((row) => row.shadowOutcome?.sameCandleAmbiguity).length,
    outcomeCoverageUnavailable: terminal.filter((row) => row.candleError || !row.shadowOutcome?.outcomeCoverageComplete).length,
    sampleSufficiency: sampleLabel(terminal.length)
  };
}

function outcomeSummary(rows, statusSelector, realizedSelector) {
  const measured = [];
  const statuses = rows.map((row) => {
    const status = statusSelector(row);
    const realized = realizedSelector(row, status);
    if (Number.isFinite(realized)) measured.push(realized);
    return status;
  });
  const netR = round(measured.reduce((sum, value) => sum + value, 0));
  return {
    evaluated: rows.length,
    tp: statuses.filter((status) => status === "Hit TP").length,
    sl: statuses.filter((status) => status === "Hit SL").length,
    expired: statuses.filter((status) => status === "Expired").length,
    unavailable: statuses.filter((status) => !TERMINAL.has(status)).length,
    netR,
    expectancyR: measured.length ? round(netR / measured.length) : null
  };
}

function realizedShadowR(status, winnerR) {
  if (status === "Hit TP") return finiteOrNull(winnerR);
  if (status === "Hit SL") return -1;
  if (status === "Expired") return 0;
  return null;
}

function sampleLabel(terminal) {
  if (terminal < 10) return "INSUFFICIENT";
  if (terminal < 30) return "EARLY EVIDENCE";
  return "ELIGIBLE FOR FORMAL REVIEW";
}

function normalizeRow(row) {
  const fullAnalysis = parseJson(row?.full_analysis ?? row?.fullAnalysis) || {};
  const diagnostics = fullAnalysis.indicators?.strategyRiskShadowDiagnostics || null;
  if (!diagnostics || diagnostics.version !== STRATEGY_RISK_SHADOW_VERSION) return null;
  return {
    id: row.id || null,
    signalId: row.signal_id ?? row.signalId ?? null,
    setupKey: row.setup_key ?? row.setupKey ?? null,
    symbol: String(row.pair ?? row.symbol ?? diagnostics.symbol ?? "unknown"),
    timeframe: String(row.timeframe ?? diagnostics.timeframe ?? "unknown"),
    strategy: String(row.strategy ?? diagnostics.strategy ?? "unknown"),
    direction: String(row.direction ?? diagnostics.direction ?? "unknown"),
    status: String(row.status || "Active"),
    realizedR: finiteOrNull(row.realized_r ?? row.realizedR),
    createdAt: row.created_at ?? row.createdAt ?? diagnostics.generatedAt,
    validUntil: row.valid_until ?? row.validUntil ?? null,
    diagnostics
  };
}

function deduplicate(rows) {
  const selected = new Map();
  for (const row of rows) {
    const key = String(row.setupKey || row.signalId || row.id || "").toLowerCase();
    if (!key) continue;
    const current = selected.get(key);
    if (!current || (TERMINAL.has(row.status) && !TERMINAL.has(current.status))) selected.set(key, row);
  }
  return [...selected.values()];
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

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function requireTimestamp(value, label) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} must be a valid timestamp.`);
  return timestamp.toISOString();
}

async function main() {
  const options = parseProspectiveRiskShadowArguments(process.argv.slice(2));
  const report = await runProspectiveStrategyRiskShadowReport(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, output, "utf8");
    console.log(`Prospective strategy-risk shadow report written to ${options.output}`);
  } else {
    process.stdout.write(output);
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Prospective strategy-risk shadow report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
