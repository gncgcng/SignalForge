import { query } from "../../db/client.js";
import { createId } from "../../shared/ids.js";
import { isAdminUser } from "../auth/authService.js";
import { getMultiTimeframeMarketData } from "../market-data/multiTimeframeService.js";
import { scanMarketSetupDetailed } from "./signalService.js";

const missedSetupExampleLimit = 1000;

export async function analyzeMissedSetup(user, { symbol, timeframe } = {}) {
  assertAdmin(user);
  const cleanSymbol = clean(symbol, 32).toUpperCase();
  const cleanTimeframe = clean(timeframe, 8);
  if (!cleanSymbol || !cleanTimeframe) {
    const error = new Error("Symbol and timeframe are required.");
    error.statusCode = 400;
    throw error;
  }

  const detailed = await scanMarketSetupDetailed(
    user,
    { symbol: cleanSymbol, timeframe: cleanTimeframe },
    null,
    { source: "admin_missed_setup_analysis", generatedBy: user.id }
  );

  return {
    ok: true,
    symbol: cleanSymbol,
    timeframe: cleanTimeframe,
    hasReadySignal: Boolean(detailed.publicResult?.valid),
    readySignal: detailed.publicResult?.setup || null,
    resultType: detailed.publicResult?.resultType || "no_setup",
    whyNoSignal: detailed.publicResult?.whyNoSignal || null,
    analysis: {
      message: detailed.publicResult?.analysis?.message || null,
      rejectionSummary: detailed.publicResult?.analysis?.rejectionSummary || null,
      rejectionReasons: detailed.publicResult?.analysis?.rejectionReasons || [],
      rejectionReasonCodes: detailed.publicResult?.analysis?.rejectionReasonCodes || [],
      detectedPatterns: detailed.publicResult?.analysis?.detectedPatterns || []
    },
    adminDebug: detailed.publicResult?.whyNoSignal?.admin || null
  };
}

export async function saveMissedSetupExample(user, payload = {}) {
  assertAdmin(user);
  const classification = clean(payload.classification || payload.outcome || "unsure", 32).toLowerCase();
  if (!["good", "bad", "unsure", "good_missed_setup", "bad_missed_setup"].includes(classification)) {
    const error = new Error("Classification must be good, bad, or unsure.");
    error.statusCode = 400;
    throw error;
  }

  const symbol = clean(payload.symbol, 32).toUpperCase();
  const timeframe = clean(payload.timeframe, 8);
  if (!symbol || !timeframe) {
    const error = new Error("Symbol and timeframe are required.");
    error.statusCode = 400;
    throw error;
  }

  const marketData = await getMultiTimeframeMarketData(symbol, timeframe).catch(() => null);
  const candleSnapshot = (marketData?.candles || []).slice(-80).map((candle) => ({
    time: candle.time,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume || 0)
  }));
  const analyzerSnapshot = payload.analyzerSnapshot && typeof payload.analyzerSnapshot === "object"
    ? payload.analyzerSnapshot
    : {};

  const id = createId("missed");
  await query(`
    INSERT INTO missed_setup_examples (
      id, user_id, pair, timeframe, direction, attempted_strategy, classification,
      reason, admin_note, candles_snapshot, indicators_snapshot, analyzer_snapshot
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `, [
    id,
    user.id,
    symbol,
    timeframe,
    clean(payload.direction, 16).toLowerCase() || null,
    clean(payload.attemptedStrategy || payload.strategy, 120) || null,
    normalizeClassification(classification),
    clean(payload.reason, 500) || null,
    clean(payload.adminNote, 1200) || null,
    JSON.stringify(candleSnapshot),
    JSON.stringify(payload.indicatorsSnapshot || {}),
    JSON.stringify(analyzerSnapshot)
  ]);

  await trimMissedSetupExamples();
  return { ok: true, id };
}

async function trimMissedSetupExamples() {
  await query(`
    DELETE FROM missed_setup_examples
    WHERE id IN (
      SELECT id FROM missed_setup_examples
      ORDER BY created_at DESC
      OFFSET $1
    )
  `, [missedSetupExampleLimit]);
}

function normalizeClassification(value) {
  if (value === "good") return "good_missed_setup";
  if (value === "bad") return "bad_missed_setup";
  return value;
}

function assertAdmin(user) {
  if (!isAdminUser(user)) {
    const error = new Error("Admin access required.");
    error.statusCode = 403;
    throw error;
  }
}

function clean(value, max = 255) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
