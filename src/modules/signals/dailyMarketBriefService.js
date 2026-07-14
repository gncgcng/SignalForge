import { createId } from "../../shared/ids.js";
import {
  findLatestMarketBrief,
  listRecentMarketBriefObservations,
  saveLatestMarketBrief,
  upsertMarketBriefObservations
} from "./marketBriefRepository.js";

const conditionLabels = new Set([
  "Bullish momentum", "Bearish momentum", "Mixed", "Range-bound", "Choppy",
  "Low volatility", "High volatility", "No clean direction", "Data unavailable"
]);

export function buildMarketBriefObservation({
  symbol,
  timeframe,
  marketData,
  result,
  readiness = null,
  candidate = null,
  avoidTrade = null,
  resultType = null,
  observedAt = new Date()
}) {
  const regime = marketData?.regime || result?.signal?.regime || {};
  const analysis = result?.analysis || {};
  const analysisCandidates = analysis.candidates || [];
  const bestAnalysis = [...analysisCandidates].sort((a, b) => Number(b.qualityScore || 0) - Number(a.qualityScore || 0))[0];
  const signal = result?.signal || null;
  const confirmations = signal?.confirmations || bestAnalysis?.confirmations || [];
  const qualityScore = finiteScore(
    signal?.qualityScore ?? candidate?.setupQualityScore ?? bestAnalysis?.qualityScore
  );
  const status = resultType || (result?.valid
    ? readiness?.ready ? "ready_signal" : "watching_setup"
    : "avoid_trade");
  const reasons = status === "ready_signal" ? [] : unique([
    ...(avoidTrade?.reasons || []),
    ...(analysis.rejectionReasons || []),
    ...(readiness?.reasons || [])
  ].map(humanizeBriefReason)).slice(0, 4);
  const setupType = signal?.setupType || candidate?.setupType || bestAnalysis?.setupType || null;
  const metrics = regime.metrics || {};
  const volumeConfirmation = confirmations.find((item) => String(item.name).toLowerCase() === "volume");
  const observation = {
    symbol,
    displaySymbol: displaySymbol(symbol),
    assetClass: marketData?.pair?.assetClass || marketData?.pair?.category || "Unknown",
    timeframe,
    resultType: status,
    regime: regime.label || "Unknown",
    volatilityLevel: regime.volatilityLevel || "Unknown",
    trendDirection: inferTrendDirection(regime, metrics),
    qualityScore,
    readinessScore: finiteScore(readiness?.readinessScore ?? candidate?.entryReadinessScore),
    setupType,
    reasons,
    volumeConfirmed: volumeConfirmation ? Boolean(volumeConfirmation.passed) : null,
    adx: finiteNumber(metrics.adx14),
    rsi: finiteNumber(metrics.rsi14),
    atrRatio: finiteNumber(metrics.atrRatio),
    observedAt: new Date(observedAt).toISOString()
  };
  return { ...observation, summary: summarizePairObservation(observation) };
}

export function buildDailyMarketBrief({
  observations = [],
  scanSummary = null,
  scannerSnapshotId = createId("scan"),
  generatedAt = new Date()
} = {}) {
  const clean = observations.filter((item) => item?.symbol && item?.timeframe);
  if (!clean.length) {
    return {
      id: createId("brief"),
      generatedAt: new Date(generatedAt).toISOString(),
      marketCondition: "Data unavailable",
      strongestPairs: [],
      weakestPairs: [],
      watchingCount: 0,
      avoidCount: 0,
      readySignalCount: 0,
      mainReasons: ["SignalForge needs fresh market data to generate a brief."],
      pairSummaries: [],
      watchingBreakdown: [],
      scannerSnapshotId,
      pairsScanned: 0,
      available: false
    };
  }

  const latest = dedupeObservations(clean);
  const pairSummaries = choosePairSummaries(latest);
  const strongestPairs = [...pairSummaries]
    .sort((a, b) => b.strengthScore - a.strengthScore)
    .slice(0, 3)
    .map(toPublicPairSummary);
  const weakestPairs = [...pairSummaries]
    .sort((a, b) => b.weaknessScore - a.weaknessScore)
    .slice(0, 3)
    .map(toPublicPairSummary);
  const watchingCount = scanSummary?.watching ?? latest.filter((item) => item.resultType === "watching_setup").length;
  const avoidCount = scanSummary?.avoidTrade ?? latest.filter((item) => item.resultType === "avoid_trade").length;
  const readySignalCount = scanSummary?.ready ?? latest.filter((item) => item.resultType === "ready_signal").length;

  return {
    id: createId("brief"),
    generatedAt: new Date(generatedAt).toISOString(),
    marketCondition: classifyMarketCondition(latest),
    strongestPairs,
    weakestPairs,
    watchingCount,
    avoidCount,
    readySignalCount,
    mainReasons: topReasons(latest),
    pairSummaries: pairSummaries.map(toPublicPairSummary),
    watchingBreakdown: summarizeWatchingSetups(latest),
    scannerSnapshotId,
    pairsScanned: new Set(latest.map((item) => item.symbol)).size,
    available: true
  };
}

export async function refreshDailyMarketBrief({ observations = [], scanSummary = null, scannerSnapshotId = null } = {}) {
  const snapshotId = scannerSnapshotId || createId("scan");
  const cryptoObservations = observations.filter(isCryptoObservation);
  if (observations.length && !cryptoObservations.length) return findLatestMarketBrief();
  if (cryptoObservations.length) await upsertMarketBriefObservations(cryptoObservations, snapshotId);
  const recent = await listRecentMarketBriefObservations(24);
  if (!recent.length) return findLatestMarketBrief();
  const cryptoOnlySummary = cryptoObservations.length === observations.length ? scanSummary : null;
  const brief = buildDailyMarketBrief({ observations: recent, scanSummary: cryptoOnlySummary, scannerSnapshotId: snapshotId });
  const saved = await saveLatestMarketBrief(brief);
  console.info(`[market-brief] generated snapshot=${snapshotId} condition=${brief.marketCondition} pairs=${brief.pairsScanned}`);
  return saved;
}

export async function getLatestDailyMarketBrief() {
  return findLatestMarketBrief();
}

function classifyMarketCondition(observations) {
  const total = observations.length;
  const count = (predicate) => observations.filter(predicate).length;
  const highVolatility = count((item) => item.volatilityLevel === "High");
  const lowVolatility = count((item) => item.volatilityLevel === "Low");
  const range = count((item) => item.regime === "Range");
  const up = count((item) => item.trendDirection === "up");
  const down = count((item) => item.trendDirection === "down");
  const avoid = count((item) => item.resultType === "avoid_trade");

  let label = "No clean direction";
  if (highVolatility / total >= 0.4) label = "High volatility";
  else if (lowVolatility / total >= 0.5) label = "Low volatility";
  else if (range / total >= 0.6 && avoid / total >= 0.5) label = "Choppy";
  else if (range / total >= 0.5) label = "Range-bound";
  else if (up / total >= 0.5 && down / total < 0.25) label = "Bullish momentum";
  else if (down / total >= 0.5 && up / total < 0.25) label = "Bearish momentum";
  else if (up / total >= 0.2 && down / total >= 0.2) label = "Mixed";
  return conditionLabels.has(label) ? label : "No clean direction";
}

function choosePairSummaries(observations) {
  const bySymbol = new Map();
  for (const observation of observations) {
    const existing = bySymbol.get(observation.symbol);
    if (!existing || observationPriority(observation) > observationPriority(existing)) {
      bySymbol.set(observation.symbol, observation);
    }
  }
  return [...bySymbol.values()].map((item) => ({
    ...item,
    strengthScore: strengthScore(item),
    weaknessScore: weaknessScore(item)
  }));
}

function summarizePairObservation(item) {
  const condition = friendlyRegime(item.regime, item.volatilityLevel);
  if (item.resultType === "ready_signal") {
    return `${condition}. A ${friendlySetup(item.setupType)} passed the active scanner rules.`;
  }
  if (item.resultType === "watching_setup") {
    const missing = item.reasons[0] || "entry confirmation is still incomplete";
    return `Watching a possible ${friendlySetup(item.setupType)}; ${lowerFirst(trimSentence(missing))}.`;
  }
  const reason = item.reasons[0];
  return reason ? `${condition}. ${trimSentence(reason)}.` : `${condition}. No clean setup is ready yet.`;
}

function strengthScore(item) {
  const directional = ["up", "down"].includes(item.trendDirection) ? 16 : 0;
  const status = item.resultType === "ready_signal" ? 14 : item.resultType === "watching_setup" ? 7 : 0;
  const adx = Math.min(20, Math.max(0, Number(item.adx || 0) - 15));
  const penalty = ["Range", "Low Volatility"].includes(item.regime) ? 12 : 0;
  return Number(item.qualityScore || 0) + directional + status + adx - penalty;
}

function weaknessScore(item) {
  const avoid = item.resultType === "avoid_trade" ? 25 : 0;
  const choppy = item.regime === "Range" ? 18 : 0;
  const volatility = ["High", "Low"].includes(item.volatilityLevel) ? 10 : 0;
  return 100 - Number(item.qualityScore || 0) + avoid + choppy + volatility;
}

function topReasons(observations) {
  const counts = new Map();
  for (const reason of observations.flatMap((item) => item.reasons || [])) {
    const clean = trimSentence(reason);
    counts.set(clean, (counts.get(clean) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason]) => reason);
}

function summarizeWatchingSetups(observations) {
  const counts = new Map();
  for (const item of observations.filter((entry) => entry.resultType === "watching_setup")) {
    const label = friendlySetup(item.setupType);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([setupType, count]) => ({ setupType, count }));
}

function dedupeObservations(observations) {
  const latest = new Map();
  for (const item of observations) {
    const key = `${item.symbol}:${item.timeframe}`;
    const existing = latest.get(key);
    if (!existing || new Date(item.observedAt).getTime() > new Date(existing.observedAt).getTime()) latest.set(key, item);
  }
  return [...latest.values()];
}

function observationPriority(item) {
  const status = { ready_signal: 50, watching_setup: 40, avoid_trade: 30, rejected_setup: 10 }[item.resultType] || 0;
  const timeframe = { "1h": 8, "4h": 7, "15m": 6, "5m": 5, "1m": 4 }[item.timeframe] || 0;
  return status + timeframe + Number(item.qualityScore || 0) / 10;
}

function toPublicPairSummary(item) {
  return {
    symbol: item.symbol,
    displaySymbol: item.displaySymbol || displaySymbol(item.symbol),
    timeframe: item.timeframe,
    condition: friendlyRegime(item.regime, item.volatilityLevel),
    summary: item.summary,
    status: item.resultType,
    setupType: item.setupType || null
  };
}

function inferTrendDirection(regime, metrics) {
  if (regime.label === "Trend Up") return "up";
  if (regime.label === "Trend Down") return "down";
  if (regime.label === "Breakout") return Number(metrics.ema20) >= Number(metrics.ema50) ? "up" : "down";
  return "mixed";
}

function friendlyRegime(regime, volatility) {
  if (volatility === "High") return "High volatility";
  if (volatility === "Low") return "Low volatility";
  if (regime === "Trend Up") return "Stronger upward momentum";
  if (regime === "Trend Down") return "Stronger downward momentum";
  if (regime === "Breakout") return "Breakout conditions developing";
  if (regime === "Range") return "Range-bound";
  return "Mixed conditions";
}

function friendlySetup(value) {
  return String(value || "setup").replace(/[_-]+/g, " ").toLowerCase();
}

function isCryptoObservation(observation) {
  return String(observation?.assetClass || "").toLowerCase() === "crypto" ||
    /^[A-Z0-9]+-USD$/i.test(String(observation?.symbol || ""));
}

function humanizeBriefReason(value) {
  const text = String(value || "").replace(/[_-]+/g, " ").trim();
  const lower = text.toLowerCase();
  if (/poor rr|risk.?reward/.test(lower)) return "Risk/reward is weak across the current structure";
  if (/volume/.test(lower)) return "Volume confirmation is missing";
  if (/trend conflict|confluence|higher timeframe/.test(lower)) return "Higher-timeframe direction is conflicting";
  if (/low volatility|atr/.test(lower)) return "Volatility is not in a clean tradable range";
  if (/resistance/.test(lower)) return "Price is too close to resistance";
  if (/support/.test(lower)) return "Price is too close to support";
  if (/strategy not matched|weak confirmation/.test(lower)) return "No strategy has enough confirmation yet";
  return text || "Scanner confirmations are incomplete";
}

function displaySymbol(symbol) { return String(symbol || "").toUpperCase().replace(/[-/]/g, ""); }
function unique(values) { return [...new Set(values.filter(Boolean).map(trimSentence))]; }
function trimSentence(value) { return String(value || "").trim().replace(/[.]+$/, ""); }
function lowerFirst(value) { return value ? value[0].toLowerCase() + value.slice(1) : value; }
function finiteScore(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0; }
function finiteNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
