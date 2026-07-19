import { appConfig } from "../../config/appConfig.js";
import {
  expireStaleCandidates,
  getCandidateQualitySummary,
  listVisibleSetupCandidates,
  listCandidatesNeedingOutcome,
  markRelatedAvoidTradesPromoted,
  promoteCandidate,
  rejectCandidate,
  recordCandidateLearningEvent,
  upsertSetupCandidate
} from "./setupCandidateRepository.js";
import { getOhlcv, getPair, listScannerPairs } from "../market-data/marketDataService.js";
import { getMultiTimeframeMarketData } from "../market-data/multiTimeframeService.js";
import { generateMarketDataSetup } from "./signalGenerator.js";
import { buildMarketBriefObservation, refreshDailyMarketBrief } from "./dailyMarketBriefService.js";

const timeframeExpiryHours = { "1m": 2, "5m": 2, "15m": 6, "1h": 24, "4h": 48 };
const watcherTimeframes = ["5m", "15m", "1h", "4h"];
let marketCursor = 0;

export function evaluateSetupReadiness(signal, marketData) {
  const candles = marketData?.candles || [];
  const latest = candles.at(-1) || {};
  const currentPrice = Number(marketData?.pair?.lastPrice || latest.close);
  const entry = Number(signal?.entryPrice);
  const atr = Number(signal?.indicators?.atr14 || marketData?.indicators?.atr14 || 0);
  const rr = Number(signal?.riskRewardRatio || 0);
  const stopDistance = Math.abs(entry - Number(signal?.stopLoss));
  const distanceAtr = atr > 0 ? Math.abs(currentPrice - entry) / atr : Infinity;
  const candleRangeAtr = atr > 0 ? (Number(latest.high) - Number(latest.low)) / atr : Infinity;
  const confirmations = signal?.confirmations || [];
  const missing = confirmations.filter((item) => !item.passed).map((item) => item.name);
  const cryptoVolumeMissing = isCryptoMarket(signal, marketData) && missing.some((item) => /volume/i.test(item));
  const candleConfirmed = signal?.direction === "short"
    ? Number(latest.close) < Number(latest.open)
    : Number(latest.close) > Number(latest.open);
  const quality = clamp(Number(signal?.qualityScore || signal?.confidenceScore || 0), 0, 99);
  let readiness = 100;
  const reasons = [];

  if (!Number.isFinite(currentPrice) || !Number.isFinite(entry) || !Number.isFinite(atr) || atr <= 0) {
    return { ready: false, rejected: true, candidateScore: quality, readinessScore: 0, entryQuality: "poor", currentPrice, missingConfirmations: missing, reasons: ["Reliable price or ATR data is unavailable."], rejectionReason: "Invalid market data for entry timing." };
  }
  const invalidated = signal.direction === "long"
    ? currentPrice <= Number(signal.stopLoss)
    : currentPrice >= Number(signal.stopLoss);
  if (invalidated) {
    return { ready: false, rejected: true, candidateScore: quality, readinessScore: 0, entryQuality: "poor", currentPrice, missingConfirmations: missing, reasons: ["Setup invalidated."], rejectionReason: "Setup invalidated." };
  }
  if (distanceAtr > 0.75) { readiness -= 35; reasons.push("Price is too far from ideal entry."); }
  else if (distanceAtr > 0.25) { readiness -= 18; reasons.push("Price is outside the ideal entry zone."); }
  if (rr < 1.5) { readiness -= 50; reasons.push("Risk/reward is below minimum."); }
  else if (rr < 1.8) { readiness -= 15; reasons.push("Risk/reward is not strong enough yet."); }
  if (stopDistance < atr * 0.45) { readiness -= 25; reasons.push("Stop loss would be too tight."); }
  if (stopDistance > atr * 3) { readiness -= 20; reasons.push("Stop distance is too wide for the available target."); }
  if (candleRangeAtr > 1.8) { readiness -= 22; reasons.push("Price is overextended."); }
  if (!candleConfirmed) { readiness -= 12; reasons.push("Candle confirmation is missing."); }
  if (cryptoVolumeMissing) { readiness -= 14; reasons.push("Volume confirmation is missing."); }
  if (missing.length) readiness -= Math.min(18, missing.length * 4);
  if (signal?.alignmentBadge === "Countertrend") { readiness -= 25; reasons.push("Higher timeframe conflicts with this setup."); }
  if (signal?.newsRisk?.level === "Danger") return { ready: false, rejected: true, candidateScore: quality, readinessScore: 0, entryQuality: "poor", currentPrice, missingConfirmations: missing, reasons: ["Dangerous news lock is active."], rejectionReason: "News lock active." };

  readiness = clamp(Math.round(readiness), 0, 100);
  const entryQuality = readiness >= 90 ? "excellent" : readiness >= 80 ? "good" : readiness >= 60 ? "fair" : "poor";
  const publicReasons = reasons.length
    ? reasons
    : missing.map((item) => `${item} confirmation is missing.`);
  return {
    ready: quality >= appConfig.candidates.readyQualityThreshold && readiness >= appConfig.candidates.readyThreshold && ["excellent", "good"].includes(entryQuality) && candleConfirmed && !cryptoVolumeMissing,
    rejected: entryQuality === "poor" || rr < 1.5,
    candidateScore: quality,
    readinessScore: readiness,
    entryQuality,
    currentPrice,
    distanceAtr,
    candleConfirmed,
    idealEntryZone: { low: entry - atr * 0.25, high: entry + atr * 0.25 },
    missingConfirmations: missing,
    reasons: publicReasons.length ? publicReasons : ["Setup quality is constructive and entry conditions are aligned."],
    nextConditions: buildNextConditions(publicReasons, missing, signal.timeframe),
    rejectionReason: entryQuality === "poor" ? reasons[0] || "Entry quality is poor." : null
  };
}

export async function observeSetupCandidate(signal, marketData, readiness) {
  if (!signal || readiness.candidateScore < appConfig.candidates.candidateThreshold) return null;
  const status = readiness.ready ? "ready" : readiness.rejected ? "rejected" : readiness.readinessScore >= 70 ? "almost_ready" : "watching";
  const candidate = await upsertSetupCandidate({
    setupKey: candidateSetupKey(signal), symbol: signal.symbol,
    provider: signal.marketSource || marketData?.source || "unknown", timeframe: signal.timeframe,
    direction: signal.direction, setupType: signal.setupType || "Unknown strategy", status,
    expiresAt: new Date(Date.now() + (timeframeExpiryHours[signal.timeframe] || 12) * 3600000),
    displayPair: displayPair(signal.symbol), setupQualityScore: readiness.candidateScore,
    candidateScore: readiness.candidateScore, entryReadinessScore: readiness.readinessScore,
    readinessScore: readiness.readinessScore,
    confidenceEstimate: Math.min(confidenceCap(signal, readiness), Number(signal.confidenceScore || 0)),
    entryQuality: readiness.entryQuality, currentPrice: readiness.currentPrice,
    idealEntry: Number(signal.entryPrice), idealEntryZone: readiness.idealEntryZone,
    invalidationLevel: signal.stopLoss,
    potentialStopLoss: signal.stopLoss, potentialTakeProfit: signal.takeProfit,
    potentialRr: signal.riskRewardRatio, reasonsForWatching: readiness.reasons,
    missingConfirmations: readiness.missingConfirmations, nextConditions: readiness.nextConditions,
    rejectionReason: readiness.rejectionReason,
    promotedSignalId: null,
    metadata: {
      distanceAtr: readiness.distanceAtr,
      setupKey: signal.setupKey,
      patternContext: sanitizePatternContext(signal.patternContext)
    }
  });
  if (["rejected", "expired"].includes(candidate.status)) await recordCandidateLearningEvent(candidate);
  return candidate;
}

export async function listSetupCandidates() {
  await expireStaleCandidates();
  return listVisibleSetupCandidates();
}

export async function markCandidatePromoted(candidate, signal) {
  if (!candidate?.id || !signal?.id) return null;
  const promoted = await promoteCandidate(candidate.id, signal.id);
  await markRelatedAvoidTradesPromoted(candidate.symbol, candidate.timeframe);
  return promoted;
}

export async function markCandidateRejected(candidate, reason) {
  if (!candidate?.id) return null;
  return rejectCandidate(candidate.id, reason || "Final signal validation failed.");
}

export async function refreshCandidateLearningOutcomes() {
  const candidates = await listCandidatesNeedingOutcome();
  let learned = 0;
  for (const candidate of candidates) {
    if (getPair(candidate.symbol)?.category !== "Crypto") continue;
    try {
      const marketData = await getOhlcv(candidate.symbol, candidate.timeframe);
      const candles = (marketData.candles || []).filter((candle) =>
        Number(candle.time) * 1000 >= new Date(candidate.firstDetectedAt).getTime()
      );
      await recordCandidateLearningEvent(candidate, evaluateCandidateOutcome(candidate, candles));
      learned += 1;
    } catch (error) {
      console.warn(`[crypto-watch] candidate_learning_skipped id=${candidate.id} reason=${error.message}`);
    }
  }
  return learned;
}

export async function runCandidateMarketWatch() {
  const markets = listScannerPairs().filter((pair) => pair.category === "Crypto");
  if (!markets.length) return { scanned: 0, createdOrUpdated: 0 };
  const batchSize = Math.min(markets.length, Math.max(1, appConfig.candidates.marketsPerCycle));
  const selected = Array.from({ length: batchSize }, (_, index) => markets[(marketCursor + index) % markets.length]);
  marketCursor = (marketCursor + batchSize) % markets.length;
  let scanned = 0; let createdOrUpdated = 0;
  const briefObservations = [];
  for (const pair of selected) {
    for (const timeframe of watcherTimeframes.filter((item) => pair.supportedTimeframes.includes(item))) {
      try {
        const marketData = await getMultiTimeframeMarketData(pair.symbol, timeframe);
        scanned += 1;
        const result = generateMarketDataSetup(marketData, timeframe);
        const readiness = result.valid ? evaluateSetupReadiness(result.signal, marketData) : null;
        const candidate = result.valid ? await observeSetupCandidate(result.signal, marketData, readiness) : null;
        if (candidate) createdOrUpdated += 1;
        const resultType = result.valid
          ? readiness?.ready ? "ready_signal" : readiness?.rejected ? "avoid_trade" : "watching_setup"
          : "avoid_trade";
        briefObservations.push(buildMarketBriefObservation({
          symbol: pair.symbol,
          timeframe,
          marketData,
          result,
          readiness,
          candidate,
          resultType
        }));
      } catch (error) {
        console.warn(`[crypto-watch] ${pair.symbol} ${timeframe} skipped: ${error.message}`);
      }
    }
  }
  let marketBrief = null;
  if (briefObservations.length) {
    try {
      marketBrief = await refreshDailyMarketBrief({ observations: briefObservations });
    } catch (error) {
      console.warn(`[market-brief] watcher_refresh_failed reason=${error.message}`);
    }
  }
  return { scanned, createdOrUpdated, marketBrief };
}

export function evaluateCandidateOutcome(candidate, candles = []) {
  const entry = midpoint(candidate.idealEntryZone) || Number(candidate.currentPrice);
  const stop = Number(candidate.potentialStopLoss || candidate.invalidationLevel);
  const target = Number(candidate.potentialTakeProfit);
  const direction = candidate.direction === "short" ? -1 : 1;
  let maxFavorable = 0;
  let maxAdverse = 0;
  let entryTouched = false;
  let tp = false;
  let sl = false;
  for (const candle of candles) {
    const low = Number(candle.low); const high = Number(candle.high);
    if (![low, high, entry, stop, target].every(Number.isFinite)) continue;
    if (!entryTouched) entryTouched = low <= entry && high >= entry;
    if (!entryTouched) continue;
    const favorable = direction > 0 ? high - entry : entry - low;
    const adverse = direction > 0 ? entry - low : high - entry;
    maxFavorable = Math.max(maxFavorable, favorable);
    maxAdverse = Math.max(maxAdverse, adverse);
    const hitTarget = direction > 0 ? high >= target : low <= target;
    const hitStop = direction > 0 ? low <= stop : high >= stop;
    if (hitStop || hitTarget) { sl = hitStop; tp = !hitStop && hitTarget; break; }
  }
  const risk = Math.abs(entry - stop) || 1;
  return {
    wouldHaveHitTp: tp,
    wouldHaveHitSl: sl,
    wentNowhere: !tp && !sl,
    entryNeverFilled: !entryTouched,
    maxFavorableExcursion: Number((maxFavorable / risk).toFixed(3)),
    maxAdverseExcursion: Number((maxAdverse / risk).toFixed(3)),
    reasonNotPromoted: !entryTouched ? "Entry never filled." : candidate.rejectionReason
  };
}

export { expireStaleCandidates, getCandidateQualitySummary };

function candidateSetupKey(signal) {
  const bucketMs = (timeframeExpiryHours[signal.timeframe] || 12) * 3600000;
  const timestamp = new Date(signal.generatedAt || Date.now()).getTime();
  const windowKey = Math.floor((Number.isFinite(timestamp) ? timestamp : Date.now()) / bucketMs);
  return [signal.symbol, signal.timeframe, signal.direction, signal.setupType, windowKey]
    .map((value) => String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-"))
    .join(":");
}

function confidenceCap(signal, readiness) {
  if (readiness.entryQuality === "fair") return 85;
  if (readiness.missingConfirmations.some((item) => /volume/i.test(item))) return 82;
  if (String(signal?.indicators?.sessionLiquidity || signal?.session?.liquidity || "").toLowerCase() === "low") return 84;
  if (signal.alignmentBadge !== "Full Alignment") return 88;
  if (!Number(signal.learningInsight?.sampleSize || signal.indicators?.learningSampleSize || 0)) return 92;
  return 99;
}

function isCryptoMarket(signal, marketData) {
  return marketData?.pair?.category === "Crypto" ||
    String(signal?.marketSource || marketData?.source || "").toLowerCase().includes("coinbase") ||
    /^[A-Z0-9]+-USD$/i.test(String(signal?.symbol || ""));
}

function displayPair(symbol) {
  return String(symbol || "").toUpperCase().replace(/[-/]/g, "");
}

function sanitizePatternContext(pattern) {
  if (!pattern?.pattern) return null;
  return {
    pattern: pattern.pattern,
    label: pattern.label,
    bias: pattern.bias,
    category: pattern.category,
    confidence: Number(pattern.confidence || 0),
    strength: pattern.strength,
    detectedAt: pattern.detectedAt,
    reasons: Array.isArray(pattern.reasons) ? pattern.reasons.slice(0, 4) : [],
    warnings: Array.isArray(pattern.warnings) ? pattern.warnings.slice(0, 4) : [],
    shadowMode: true,
    confidenceModifier: 0,
    minimumSamplesForWeighting: 30
  };
}

export function buildNextConditions(reasons = [], missingConfirmations = [], timeframe = "current") {
  const text = [...reasons, ...missingConfirmations].join(" ").toLowerCase();
  const conditions = [];
  if (/far from|outside the ideal entry/.test(text)) conditions.push("Waiting for price to return closer to the ideal entry zone.");
  if (/volume/.test(text)) conditions.push("Waiting for volume to rise above its recent average.");
  if (/candle/.test(text)) conditions.push(`Waiting for the ${timeframe} candle to close with directional confirmation.`);
  if (/risk\/reward|reward\/risk/.test(text)) conditions.push("Waiting for risk/reward to improve to at least the minimum threshold.");
  if (/higher timeframe|alignment|confluence/.test(text)) conditions.push("Waiting for higher-timeframe structure to align.");
  if (/overextended/.test(text)) conditions.push("Waiting for the move to cool down or pull back.");
  if (/stop/.test(text)) conditions.push("Waiting for volatility and structure to support a safer stop distance.");
  if (/trend/.test(text)) conditions.push("Waiting for trend confirmation to strengthen.");
  if (/vwap/.test(text)) conditions.push("Waiting for price to reclaim or reject VWAP with confirmation.");
  if (/volatility|atr/.test(text)) conditions.push("Waiting for volatility to return to a tradable range.");
  return [...new Set(conditions)].slice(0, 4).length
    ? [...new Set(conditions)].slice(0, 4)
    : ["Waiting for the remaining rule confirmations to align."];
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value || 0))); }
function midpoint(zone = {}) {
  const low = Number(zone.low); const high = Number(zone.high);
  return Number.isFinite(low) && Number.isFinite(high) ? (low + high) / 2 : 0;
}
