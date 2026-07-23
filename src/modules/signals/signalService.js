import {
  cacheScanResult,
  findActiveDuplicateSignal,
  findSignalBySetupKey,
  findTelegramNotificationPayload,
  getLearningContextForSignal,
  getCachedScanResult,
  listSignalsByUser,
  recordSignalValidationRejection,
  saveSignalSnapshot,
  saveUnlockedSignal
} from "../../db/repositories.js";
import { createId } from "../../shared/ids.js";
import { getManualScannerUniverse } from "../market-data/marketDataService.js";
import { appConfig } from "../../config/appConfig.js";
import { getMultiTimeframeMarketData } from "../market-data/multiTimeframeService.js";
import {
  canDiscoverSetups,
  getSubscriptionSummary,
  recordDiscoveryUsage
} from "../subscriptions/subscriptionService.js";
import { generateMarketDataSetup } from "./signalGenerator.js";
import {
  applyValidationToSignal,
  validateSignalPipeline,
  validationNoSetupAnalysis
} from "./signalValidationService.js";
import { calculateSignalStats, updateSignalsForUser } from "./signalOutcomeService.js";
import { buildAnalystProfile } from "../analyst/signalAnalystService.js";
import { trackProductEvent } from "../analytics/productAnalyticsService.js";
import {
  applyLearningAdjustment,
  recordLearningSnapshot
} from "./signalLearningService.js";
import { evaluateSetupReadiness, markCandidatePromoted, markCandidateRejected, observeSetupCandidate } from "./setupCandidateService.js";
import {
  assertSignalFresh,
  isSignalExpired,
  withSignalValidity
} from "./signalValidityService.js";
import { toLockedSignalQuality, withSignalQuality } from "./signalQualityService.js";
import {
  applyConfidenceCalibration,
  isSignalBlockedByCalibration
} from "./signalConfidenceCalibrationService.js";
import {
  SCANNER_RESULT_TYPES,
  buildAvoidTradeResult,
  classifyScannerResult
} from "./avoidTradeService.js";
import { recordAvoidTradeLearningEvent } from "./setupCandidateRepository.js";
import { saveGeneratedSignal } from "../admin-signals/generatedSignalService.js";
import {
  buildMarketBriefObservation,
  getLatestDailyMarketBrief,
  refreshDailyMarketBrief
} from "./dailyMarketBriefService.js";

const scanTimeframes = ["1h", "4h", "15m", "5m"];
const scanAllJobs = new Map();
const SCAN_JOB_TTL_MS = 60 * 60 * 1000;

export async function createSignal(user, { symbol, timeframe, setupKey }) {
  const scanKey = `single:${symbol}:${timeframe}`;
  const cached = await getCachedScanResult(user.id, scanKey);
  let result = cached;

  if (!result) {
    assertDiscoveryAvailable(user);
    result = await scanMarketSetupDetailed(user, { symbol, timeframe });
    result.marketBrief = await refreshMarketBriefSafely([result.briefObservation]);
    await recordDiscoveryUsage(user, result.publicResult.valid ? 1 : 0, scanKey);
    await cacheScanResult(user.id, scanKey, result);
  }

  if (!result.publicResult.valid) {
    return {
      signal: null,
      analysis: {
        ...(result.publicResult.analysis || {}),
        avoidTrade: result.publicResult.avoidTrade || null,
        resultType: result.publicResult.resultType
      },
      subscription: getSubscriptionSummary(user)
    };
  }

  const requestedSetupKey = String(setupKey || "").trim();
  if (requestedSetupKey) {
    const existing = await findSignalBySetupKey(user.id, requestedSetupKey);
    if (existing) {
      existing.alreadyUnlocked = true;
      return {
        signal: toUserSignal(existing),
        alreadyUnlocked: true,
        analysis: result.analysis,
        subscription: getSubscriptionSummary(user)
      };
    }
    if (result.fullSetup?.setupKey !== requestedSetupKey) {
      const error = new Error("This setup is no longer the current scanner result. Run a fresh scan.");
      error.statusCode = 409;
      throw error;
    }
  }

  const fullSetup = withSignalValidity(result.fullSetup);
  assertSignalFresh(fullSetup);

  const freshMarketData = await getMultiTimeframeMarketData(symbol, timeframe);
  const unlockValidation = await validateSignalForPublication(fullSetup, freshMarketData, user, {
    source: "unlock",
    duplicate: false
  });

  if (!unlockValidation.passed) {
    return {
      signal: null,
      analysis: validationNoSetupAnalysis(result.fullSetup, unlockValidation),
      subscription: getSubscriptionSummary(user)
    };
  }

  const learningAdjusted = await applyLearningToValidatedSignal(
    applyValidationToSignal(fullSetup, unlockValidation)
  );
  const signal = {
    ...withSignalQuality(withSignalValidity(learningAdjusted)),
    id: createId("sig"),
    userId: user.id,
    status: "Active",
    statusUpdatedAt: new Date().toISOString()
  };

  await saveGeneratedSignal(signal, { source: "manual_scan", generatedBy: user.id });

  const savedSignal = await saveUnlockedSignal(user.id, signal);
  if (!savedSignal?.alreadyUnlocked) {
    await recordLearningSnapshot({ saveSignalSnapshot }, user.id, signal, freshMarketData);
  }
  if (!savedSignal?.alreadyUnlocked) {
    await trackProductEvent({
      eventType: "unlock",
      userId: user.id,
      symbol,
      timeframe
    });
  }
  if (user.role !== "tester" && !savedSignal?.alreadyUnlocked) {
    user.unlockCreditsBalance = Math.max(0, Number(user.unlockCreditsBalance || 0) - 1);
    user.lifetimeUnlocksUsed = Number(user.lifetimeUnlocksUsed || 0) + 1;
    user.trialSignalsUsed = Number(user.trialSignalsUsed || 0) +
      (user.plan === "free" || user.plan === "trial" ? 1 : 0);
  }

  return {
    signal: toUserSignal(savedSignal),
    alreadyUnlocked: Boolean(savedSignal?.alreadyUnlocked),
    analysis: result.analysis,
    subscription: getSubscriptionSummary(user)
  };
}

export async function unlockTelegramSignal(user, { setupKey }) {
  const key = String(setupKey || "").trim();

  if (!key) {
    const error = new Error("Telegram setup link is missing.");
    error.statusCode = 400;
    throw error;
  }

  const queuedSetup = await findTelegramNotificationPayload(user.id, key);

  if (!queuedSetup) {
    const error = new Error("Telegram setup link expired or is not available for this account.");
    error.statusCode = 404;
    throw error;
  }


  const existing = await findSignalBySetupKey(user.id, key);
  if (existing) {
    existing.alreadyUnlocked = true;
    return {
      signal: toUserSignal(existing),
      alreadyUnlocked: true,
      subscription: getSubscriptionSummary(user)
    };
  }

  const queuedSignal = withSignalValidity(queuedSetup);
  if (isSignalExpired(queuedSignal)) {
    return {
      signal: null,
      expired: true,
      message: "This signal has expired and is no longer valid as a fresh setup.",
      historicalAnalysis: toScanPreview(queuedSignal),
      subscription: getSubscriptionSummary(user)
    };
  }

  const signal = {
    ...queuedSignal,
    id: queuedSetup.id || createId("sig"),
    userId: user.id,
    status: "Active",
    statusUpdatedAt: new Date().toISOString()
  };
  const freshMarketData = await getMultiTimeframeMarketData(signal.symbol, signal.timeframe);
  const validation = await validateSignalForPublication(signal, freshMarketData, user, {
    source: "telegram_unlock",
    duplicate: false
  });

  if (!validation.passed) {
    return {
      signal: null,
      analysis: validationNoSetupAnalysis(signal, validation),
      subscription: getSubscriptionSummary(user)
    };
  }

  const learningAdjustedSignal = await applyLearningToValidatedSignal(
    applyValidationToSignal(signal, validation)
  );
  const validatedSignal = withSignalQuality(withSignalValidity(learningAdjustedSignal));
  await saveGeneratedSignal(validatedSignal, { source: "telegram_alert", generatedBy: user.id });
  const savedSignal = await saveUnlockedSignal(user.id, validatedSignal);
  if (!savedSignal?.alreadyUnlocked) {
    await recordLearningSnapshot({ saveSignalSnapshot }, user.id, validatedSignal, freshMarketData);
  }

  if (!savedSignal?.alreadyUnlocked) {
    await trackProductEvent({
      eventType: "unlock",
      userId: user.id,
      symbol: validatedSignal.symbol,
      timeframe: validatedSignal.timeframe,
      metadata: { source: "telegram" }
    });
  }

  if (user.role !== "tester" && !savedSignal?.alreadyUnlocked) {
    user.unlockCreditsBalance = Math.max(0, Number(user.unlockCreditsBalance || 0) - 1);
    user.lifetimeUnlocksUsed = Number(user.lifetimeUnlocksUsed || 0) + 1;
    user.trialSignalsUsed = Number(user.trialSignalsUsed || 0) +
      (user.plan === "free" || user.plan === "trial" ? 1 : 0);
  }

  return {
    signal: toUserSignal(savedSignal),
    alreadyUnlocked: Boolean(savedSignal?.alreadyUnlocked),
    subscription: getSubscriptionSummary(user)
  };
}

export async function scanMarketSetup(user, { symbol, timeframe }) {
  const scanKey = `single:${symbol}:${timeframe}`;
  const cached = await getCachedScanResult(user.id, scanKey);
  if (cached) {
    await trackProductEvent({
      eventType: "scan",
      userId: user.id,
      symbol,
      timeframe,
      metadata: { cached: true, mode: "single" }
    });
    return {
      ...cached.publicResult,
      marketBrief: await refreshMarketBriefSafely([]),
      cached: true,
      subscription: getSubscriptionSummary(user)
    };
  }
  assertDiscoveryAvailable(user);
  const result = await scanMarketSetupDetailed(user, { symbol, timeframe });
  const marketBrief = await refreshMarketBriefSafely([result.briefObservation]);
  const quantity = result.publicResult.valid ? 1 : 0;
  const subscription = await recordDiscoveryUsage(user, quantity, scanKey);
  await cacheScanResult(user.id, scanKey, result);
  await trackProductEvent({
    eventType: "scan",
    userId: user.id,
    symbol,
    timeframe,
    metadata: { cached: false, mode: "single", valid: result.publicResult.valid }
  });
  return {
    ...result.publicResult,
    marketBrief,
    cached: false,
    subscription
  };
}

export async function scanMarketSetupDetailed(user, { symbol, timeframe }, analystProfile = null, generationContext = {}) {
  const marketData = await getMultiTimeframeMarketData(symbol, timeframe);
  const profile = analystProfile || await getUserAnalystProfile(user);
  const result = generateMarketDataSetup(marketData, timeframe, { analystProfile: profile });
  const readiness = result.valid ? evaluateSetupReadiness(result.signal, marketData) : null;
  let candidate = result.valid ? await observeSetupCandidate(result.signal, marketData, readiness) : null;
  const readySignal = result.valid && readiness?.ready
    ? {
      ...result.signal,
      confidenceScore: Math.min(Number(result.signal.confidenceScore || 0), Number(candidate?.confidenceEstimate || 99)),
      entryQuality: readiness.entryQuality,
      readinessScore: readiness.readinessScore,
      indicators: {
        ...(result.signal.indicators || {}),
        entryQuality: readiness.entryQuality,
        readinessScore: readiness.readinessScore
      }
    }
    : null;
  const validation = readySignal
    ? await validateSignalForPublication(readySignal, marketData, user, {
      source: "scanner",
      duplicate: true
    })
    : null;
  const valid = Boolean(readySignal && validation?.passed);
  const learnedSignal = valid
    ? withSignalValidity(await applyLearningToValidatedSignal(applyValidationToSignal(readySignal, validation)))
    : null;
  const calibrationBlocked = isSignalBlockedByCalibration(learnedSignal);
  const signal = learnedSignal && !calibrationBlocked
    ? withSignalQuality({ ...learnedSignal, confidenceScore: Math.min(learnedSignal.confidenceScore, candidate?.confidenceEstimate || 99) })
    : null;
  if (signal && candidate) {
    candidate = await markCandidatePromoted(candidate, signal) || { ...candidate, status: "promoted_to_signal" };
  }
  if (signal) {
    await saveGeneratedSignal(signal, {
      source: generationContext.source || "manual_scan",
      generatedBy: generationContext.generatedBy || user?.id || "system",
      candidateId: candidate?.id || null
    });
    if (candidate?.id) {
      await saveGeneratedSignal(signal, {
        source: "candidate_promotion",
        generatedBy: generationContext.generatedBy || user?.id || "system",
        candidateId: candidate.id
      });
    }
  }
  if (readySignal && validation && (!validation.passed || calibrationBlocked) && candidate) {
    const rejectionReason = calibrationBlocked
      ? "Performance calibration quarantined or disabled this group."
      : validation.reasons?.[0]?.reason || "Final signal validation failed.";
    candidate = await markCandidateRejected(candidate, rejectionReason) || {
      ...candidate,
      status: "rejected",
      rejectionReason
    };
  }
  const analysis = result.valid && !readiness?.ready
    ? {
      ...(result.analysis || {}),
      message: readiness.rejected ? "Setup rejected because entry quality is poor." : "Promising setup is being watched for a better entry.",
      rejectionSummary: readiness.reasons.join(" "),
      rejectionReasons: readiness.reasons,
      rejectionReasonCodes: readiness.reasons.map((reason) => reason.includes("entry") ? "entry_not_ready" : "readiness_pending"),
      candidate: candidate ? toCandidatePreview(candidate) : null
    }
    : result.valid && validation && !validation.passed
      ? validationNoSetupAnalysis(readySignal, validation)
      : result.analysis;
  const resultType = classifyScannerResult({ valid, candidate, analysis });
  const avoidTrade = resultType === SCANNER_RESULT_TYPES.AVOID
    ? buildAvoidTradeResult({ symbol, timeframe, analysis, candidate })
    : null;
  if (avoidTrade) await recordAvoidTradeSafely(avoidTrade);
  const briefObservation = buildMarketBriefObservation({
    symbol,
    timeframe,
    marketData,
    result,
    readiness,
    candidate,
    avoidTrade,
    resultType
  });

  return {
    publicResult: {
      symbol,
      timeframe,
      valid,
      resultType,
      setup: valid ? toScanPreview(signal) : null,
      analysis,
      candidate: candidate ? toCandidatePreview(candidate) : null,
      avoidTrade
    },
    fullSetup: signal,
    analysis,
    briefObservation
  };
}

function toCandidatePreview(candidate) {
  return {
    id: candidate.id,
    symbol: candidate.symbol,
    timeframe: candidate.timeframe,
    direction: candidate.direction,
    setupType: candidate.setupType,
    status: candidate.status,
    candidateScore: candidate.candidateScore,
    setupQualityScore: candidate.setupQualityScore,
    readinessScore: candidate.readinessScore,
    entryReadinessScore: candidate.entryReadinessScore,
    entryQuality: candidate.entryQuality,
    reasonsForWatching: candidate.reasonsForWatching,
    missingConfirmations: candidate.missingConfirmations,
    nextConditions: candidate.nextConditions,
    patternContext: candidate.patternContext,
    rejectionReason: candidate.rejectionReason,
    lastCheckedAt: candidate.lastCheckedAt,
    expiresAt: candidate.expiresAt,
    resultType: candidate.status === "expired"
      ? SCANNER_RESULT_TYPES.EXPIRED
      : candidate.status === "rejected"
        ? SCANNER_RESULT_TYPES.REJECTED
        : SCANNER_RESULT_TYPES.WATCHING
  };
}

export async function scanAllMarkets(user, options = {}) {
  const universe = getManualScannerUniverse(options);
  const scanKey = `scan-all:${universe.signature}:5m-15m-1h-4h`;
  const cached = await getCachedScanResult(user.id, scanKey);
  if (cached) {
    return getCachedScanAllResult(user, cached);
  }
  assertDiscoveryAvailable(user);
  const result = await scanAllMarketsDetailed(user, { ...options, universe });
  return meterScanAllResult(user, result, scanKey);
}

export async function startScanAllJob(user, options = {}, hooks = {}) {
  cleanupScanAllJobs();
  const universe = getManualScannerUniverse(options);
  const scanKey = `scan-all:${universe.signature}:5m-15m-1h-4h`;
  const jobId = createId("scanjob");
  const cached = await getCachedScanResult(user.id, scanKey);
  const job = {
    id: jobId,
    userId: user.id,
    status: cached ? "completed" : "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    marketType: universe.marketType,
    totalMarkets: universe.markets.length,
    scannedMarkets: cached ? universe.markets.length : 0,
    totalTasks: universe.summary.scanTasks || 0,
    scannedTasks: cached?.publicResult?.scanned?.length || 0,
    currentMarket: null,
    currentTimeframe: null,
    batchSize: appConfig.manualScan.batchSize,
    cancelRequested: false,
    selectedMarketsCount: universe.summary.selectedMarkets || universe.markets.length,
    skippedMarketsCount: universe.skipped.length,
    skippedByReason: universe.summary.skippedByReason || {},
    result: null,
    privateFullSetups: [],
    detectedAlerts: [],
    queuedTelegramAlerts: 0,
    error: null
  };
  scanAllJobs.set(jobId, job);

  if (cached) {
    job.result = await getCachedScanAllResult(user, cached);
    job.privateFullSetups = cached.fullSetups || [];
    if (hooks.onComplete) {
      const hookResult = await hooks.onComplete(job.result);
      job.detectedAlerts = hookResult?.detectedAlerts || [];
      job.queuedTelegramAlerts = Number(hookResult?.queuedTelegramAlerts || 0);
    }
    job.updatedAt = new Date().toISOString();
    return toScanAllJobStatus(job);
  }

  try {
    assertDiscoveryAvailable(user);
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    job.subscription = error.subscription || getSubscriptionSummary(user);
    job.updatedAt = new Date().toISOString();
    return toScanAllJobStatus(job);
  }

  Promise.resolve().then(() => runScanAllJob(job, user, { ...options, universe, scanKey }, hooks));
  return toScanAllJobStatus(job);
}

export function getScanAllJobStatus(user, jobId) {
  cleanupScanAllJobs();
  const job = scanAllJobs.get(String(jobId || ""));
  if (!job || job.userId !== user.id) {
    const error = new Error("Scan job not found.");
    error.statusCode = 404;
    throw error;
  }
  return toScanAllJobStatus(job);
}

export function cancelScanAllJob(user, jobId) {
  const job = scanAllJobs.get(String(jobId || ""));
  if (!job || job.userId !== user.id) {
    const error = new Error("Scan job not found.");
    error.statusCode = 404;
    throw error;
  }
  if (!["completed", "failed", "cancelled"].includes(job.status)) {
    job.cancelRequested = true;
    job.status = "cancelling";
    job.updatedAt = new Date().toISOString();
  }
  return toScanAllJobStatus(job);
}

async function runScanAllJob(job, user, options = {}, hooks = {}) {
  try {
    const context = await createManualScanContext(user, options);
    job.status = "running";
    job.totalMarkets = context.marketsToScan.length;
    job.totalTasks = context.marketsToScan.reduce((total, market) =>
      total + scanTimeframes.filter((timeframe) => (market.scannerTimeframes || scanTimeframes).includes(timeframe)).length,
      0
    );
    job.scanUniverse = context.universe.summary;
    job.updatedAt = new Date().toISOString();
    updateScanJobSnapshot(job, context);

    const batchSize = Math.max(1, appConfig.manualScan.batchSize);
    for (let index = 0; index < context.marketsToScan.length; index += batchSize) {
      if (job.cancelRequested) {
        job.status = "cancelled";
        job.updatedAt = new Date().toISOString();
        updateScanJobSnapshot(job, context);
        return;
      }

      const batch = context.marketsToScan.slice(index, index + batchSize);
      job.currentBatch = {
        index: Math.floor(index / batchSize) + 1,
        total: Math.ceil(context.marketsToScan.length / batchSize),
        size: batch.length
      };
      await processManualScanMarkets(context, batch, (market, marketScanned, timeframe) => {
        job.currentMarket = market?.symbol || null;
        job.currentTimeframe = timeframe || null;
        if (marketScanned) job.scannedMarkets += 1;
        job.scannedTasks = context.scanned.length;
        job.updatedAt = new Date().toISOString();
        updateScanJobSnapshot(job, context);
      }, () => job.cancelRequested);
      updateScanJobSnapshot(job, context);
    }

    const rawResult = await finalizeManualScanContext(context);
    const metered = await meterScanAllResult(user, rawResult, options.scanKey);
    job.privateFullSetups = metered.fullSetups || [];
    const { fullSetups, ...publicResult } = metered;
    job.result = publicResult;
    job.subscription = metered.subscription;
    job.status = "completed";
    job.currentMarket = null;
    job.currentTimeframe = null;
    job.scannedMarkets = context.marketsToScan.length;
    job.scannedTasks = context.scanned.length;
    if (hooks.onComplete) {
      const hookResult = await hooks.onComplete(metered);
      job.detectedAlerts = hookResult?.detectedAlerts || [];
      job.queuedTelegramAlerts = Number(hookResult?.queuedTelegramAlerts || 0);
    }
    job.updatedAt = new Date().toISOString();
  } catch (error) {
    job.status = job.cancelRequested ? "cancelled" : "failed";
    job.error = error.message;
    job.subscription = error.subscription || getSubscriptionSummary(user);
    job.updatedAt = new Date().toISOString();
    console.warn(`[manual-scan-job] failed job_id=${job.id} reason=${error.message}`);
  }
}

async function getCachedScanAllResult(user, cached) {
  await trackScanAllAnalytics(user, cached.publicResult.scanned, true);
  return {
    ...cached.publicResult,
    fullSetups: cached.fullSetups,
    cached: true,
    subscription: getSubscriptionSummary(user)
  };
}

async function meterScanAllResult(user, result, scanKey) {
  const summary = getSubscriptionSummary(user);
  const remaining = user.role === "tester"
    ? result.publicResult.setups.length
    : summary.setupDiscoveries.remaining;
  const allowedSetups = result.publicResult.setups.slice(0, remaining);
  const allowedIds = new Set(allowedSetups.map((setup) => setup.id));
  const meteredResult = {
    publicResult: {
      ...result.publicResult,
      setups: allowedSetups,
      limitedByCredits: allowedSetups.length < result.publicResult.setups.length
    },
    fullSetups: result.fullSetups.filter((setup) => allowedIds.has(setup.id))
  };
  const subscription = await recordDiscoveryUsage(
    user,
    allowedSetups.length,
    scanKey
  );
  await cacheScanResult(user.id, scanKey, meteredResult);
  await trackScanAllAnalytics(user, meteredResult.publicResult.scanned, false);
  return {
    ...meteredResult.publicResult,
    fullSetups: meteredResult.fullSetups,
    cached: false,
    subscription
  };
}

async function trackScanAllAnalytics(user, scanned = [], cached = false) {
  await Promise.all(
    scanned.map((item) => trackProductEvent({
      eventType: "scan",
      userId: user.id,
      symbol: item.symbol,
      timeframe: item.timeframe,
      metadata: { cached, mode: "scan_all", valid: Boolean(item.valid) }
    }))
  );
}

export async function scanAllMarketsDetailed(user, options = {}) {
  const context = await createManualScanContext(user, options);
  await processManualScanMarkets(context, context.marketsToScan);
  return finalizeManualScanContext(context);
}

async function createManualScanContext(user, options = {}) {
  const scanned = [];
  const setups = [];
  const fullSetups = [];
  const candidatesById = new Map();
  const avoidTrades = [];
  const briefObservations = [];
  const errors = [];
  const diagnostics = {
    rejectionReasonCodes: {},
    rejectionReasons: {},
    samples: []
  };
  const universe = options.universe || getManualScannerUniverse(options);
  const scanMarkets = universe.markets;
  const marketsToScan = scanMarkets.slice(0, appConfig.manualScan.maxMarkets);
  const analystProfile = await getUserAnalystProfile(user);
  const activeCounts = universe.summary.activeMarkets || {};
  const scannerCounts = universe.summary.scannerEnabledMarkets || {};
  console.info(
    `[manual-scan] selectedFilter=${universe.marketType}`
  );
  console.info(
    `[manual-scan] activeMarkets total=${activeCounts.total || 0} crypto=${activeCounts.crypto || 0} commodities=${activeCounts.commodities || 0}`
  );
  console.info(
    `[manual-scan] scannerEnabled total=${scannerCounts.total || 0} crypto=${scannerCounts.crypto || 0} commodities=${scannerCounts.commodities || 0}`
  );
  console.info(
    `[manual-scan] selectedMarkets total=${universe.summary.selectedMarkets || scanMarkets.length} crypto=${universe.summary.crypto} commodities=${universe.summary.commodities}`
  );
  console.info(
    `[manual-scan] marketsToScan total=${marketsToScan.length} max=${appConfig.manualScan.maxMarkets}`
  );
  console.info(
    `[manual-scan] scannedMarkets total=${marketsToScan.length} skipped=${universe.skipped.length}`
  );
  console.info(
    `[manual-scan] skippedReasons=${Object.entries(universe.summary.skippedByReason || {}).map(([reason, count]) => `${reason}:${count}`).join(",") || "none"}`
  );
  console.info(
    `[manual-scan] firstSymbols=${marketsToScan.slice(0, 20).map((market) => market.symbol).join(",") || "none"}`
  );
  console.info(
    `[manual-scan] providerRoutes=${marketsToScan.slice(0, 20).map((market) => `${market.symbol}:${market.provider || "missing"}`).join(",") || "none"}`
  );
  console.info(
    `[scanner] manual_universe market_type=${universe.marketType} selected=${universe.summary.selectedMarkets || scanMarkets.length} ` +
    `markets_to_scan=${marketsToScan.length} ` +
    `skipped=${universe.skipped.length} crypto=${universe.summary.crypto} commodities=${universe.summary.commodities}`
  );

  return {
    user,
    universe,
    scanMarkets,
    marketsToScan,
    analystProfile,
    scanned,
    setups,
    fullSetups,
    candidatesById,
    avoidTrades,
    briefObservations,
    errors,
    diagnostics
  };
}

async function processManualScanMarkets(context, markets, onProgress = null, shouldCancel = null) {
  await runManualScanMarkets(markets, async (market) => {
    if (shouldCancel?.()) return;
    await scanManualMarket(context, market, onProgress, shouldCancel);
    onProgress?.(market, true, null);
  });
}

async function scanManualMarket(context, market, onProgress = null, shouldCancel = null) {
  const symbol = market.symbol;
  const supportedTimeframes = market.scannerTimeframes || scanTimeframes;
  for (const timeframe of scanTimeframes.filter((item) => supportedTimeframes.includes(item))) {
    if (shouldCancel?.()) return;
    onProgress?.(market, false, timeframe);
    try {
      const detailed = await scanMarketSetupDetailed(
        context.user,
        { symbol, timeframe },
        context.analystProfile
      );
      const result = detailed.publicResult;
      const analysis = result.analysis || {};
      if (detailed.briefObservation) context.briefObservations.push(detailed.briefObservation);
      context.scanned.push({
        symbol,
        timeframe,
        valid: result.valid,
        resultType: result.resultType,
        rejectionReasonCodes: analysis.rejectionReasonCodes || [],
        rejectionReasons: analysis.rejectionReasons || []
      });

      if (result.candidate && !result.valid) {
        context.candidatesById.set(result.candidate.id, result.candidate);
      }

      if (result.valid) {
        context.setups.push(result.setup);
        context.fullSetups.push(detailed.fullSetup);
      } else {
        if (result.avoidTrade) {
          context.avoidTrades.push(result.avoidTrade);
        }
        recordScanDiagnostics(context.diagnostics, symbol, timeframe, analysis);
      }
    } catch (error) {
      const publicReason = humanizeScanFailure(error);
      const code = failureDiagnosticCode(error);
      const failureAnalysis = {
        message: publicReason,
        rejectionSummary: publicReason,
        rejectionReasonCodes: [code],
        rejectionReasons: [publicReason]
      };
      const resultType = classifyScannerResult({
        valid: false,
        analysis: failureAnalysis,
        providerError: true
      });
      context.scanned.push({
        symbol,
        timeframe,
        valid: false,
        providerError: true,
        resultType,
        rejectionReasonCodes: [code],
        rejectionReasons: [publicReason]
      });
      if (resultType === SCANNER_RESULT_TYPES.AVOID) {
        const avoidTrade = buildAvoidTradeResult({ symbol, timeframe, analysis: failureAnalysis });
        if (avoidTrade) {
          context.avoidTrades.push(avoidTrade);
          await recordAvoidTradeSafely(avoidTrade);
        }
      }
      recordScanDiagnostics(context.diagnostics, symbol, timeframe, failureAnalysis);
      context.errors.push({
        symbol,
        timeframe,
        message: publicReason
      });
    }
  }
}

async function finalizeManualScanContext(context) {
  rankSetups(context.setups);
  const candidates = [...context.candidatesById.values()];
  const finalizedDiagnostics = finalizeScanDiagnostics(context.diagnostics);
  const scanSummary = summarizeScanBatch(
    context.scanned,
    context.setups,
    candidates,
    finalizedDiagnostics,
    context.avoidTrades,
    context.universe.skipped
  );
  const marketBrief = await refreshMarketBriefSafely(context.briefObservations, scanSummary);
  console.info(
    `[scanner] ready=${scanSummary.ready} watching=${scanSummary.watching} ` +
    `avoid=${scanSummary.avoidTrade} rejected=${scanSummary.rejected} expired=${scanSummary.expired}`
  );
  console.info(`[scanner] top_rejection_reason=${scanSummary.topRejectionCode}`);

  return {
    publicResult: {
      setups: context.setups,
      candidates,
      avoidTrades: context.avoidTrades,
      scanned: context.scanned,
      errors: context.errors,
      diagnostics: finalizedDiagnostics,
      scanSummary,
      scanUniverse: context.universe.summary,
      skippedMarkets: context.universe.skipped,
      marketBrief,
      message: context.setups.length ? "Valid setups found." : "No high-probability setups right now"
    },
    fullSetups: context.fullSetups
  };
}

function updateScanJobSnapshot(job, context) {
  const candidates = [...context.candidatesById.values()];
  const diagnostics = finalizeScanDiagnostics(context.diagnostics);
  const scanSummary = summarizeScanBatch(
    context.scanned,
    context.setups,
    candidates,
    diagnostics,
    context.avoidTrades,
    context.universe.skipped
  );
  job.result = {
    setups: rankSetups([...context.setups]),
    candidates,
    avoidTrades: context.avoidTrades,
    scanned: context.scanned,
    errors: context.errors,
    diagnostics,
    scanSummary,
    scanUniverse: {
      ...context.universe.summary,
      scannedMarkets: job.scannedMarkets,
      scanTasks: job.totalTasks,
      batchSize: job.batchSize
    },
    skippedMarkets: context.universe.skipped,
    marketBrief: null,
    message: context.setups.length ? "Valid setups found." : "Scanning markets..."
  };
}

function toScanAllJobStatus(job) {
  const result = job.result || {};
  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: {
      selectedMarkets: job.selectedMarketsCount || job.totalMarkets || 0,
      scannedMarkets: job.scannedMarkets || 0,
      totalMarkets: job.totalMarkets || 0,
      skippedMarkets: job.skippedMarketsCount || 0,
      scannedTasks: job.scannedTasks || result.scanned?.length || 0,
      totalTasks: job.totalTasks || 0,
      currentMarket: job.currentMarket,
      currentTimeframe: job.currentTimeframe,
      currentBatch: job.currentBatch || null,
      batchSize: job.batchSize || appConfig.manualScan.batchSize,
      skippedByReason: job.skippedByReason || {}
    },
    setups: result.setups || [],
    candidates: result.candidates || [],
    avoidTrades: result.avoidTrades || [],
    scanned: result.scanned || [],
    errors: result.errors || [],
    diagnostics: result.diagnostics || finalizeScanDiagnostics({
      rejectionReasonCodes: {},
      rejectionReasons: {},
      samples: []
    }),
    scanSummary: result.scanSummary || {
      ready: 0,
      watching: 0,
      avoidTrade: 0,
      rejected: 0,
      expired: 0,
      skipped: job.skippedMarketsCount || 0,
      providerErrors: 0,
      noData: 0
    },
    scanUniverse: result.scanUniverse || job.scanUniverse || {
      selectedMarkets: job.selectedMarketsCount || 0,
      scannedMarkets: job.scannedMarkets || 0,
      skipped: job.skippedMarketsCount || 0,
      skippedByReason: job.skippedByReason || {}
    },
    skippedMarkets: result.skippedMarkets || [],
    marketBrief: result.marketBrief || null,
    subscription: job.subscription || result.subscription || null,
    detectedAlerts: job.detectedAlerts || [],
    queuedTelegramAlerts: job.queuedTelegramAlerts || 0,
    cached: Boolean(result.cached),
    cancelled: job.status === "cancelled" || job.cancelRequested,
    error: job.error,
    message: result.message || (
      job.status === "completed"
        ? "Market scan complete"
        : job.status === "failed"
          ? "Market scan failed"
          : job.status === "cancelled"
            ? "Market scan cancelled"
            : "Market scan running"
    )
  };
}

function cleanupScanAllJobs() {
  const now = Date.now();
  for (const [jobId, job] of scanAllJobs.entries()) {
    const updatedAt = new Date(job.updatedAt || job.createdAt || 0).getTime();
    if (Number.isFinite(updatedAt) && now - updatedAt > SCAN_JOB_TTL_MS) {
      scanAllJobs.delete(jobId);
    }
  }
}

export function summarizeScanBatch(scanned, setups, candidates, diagnostics, avoidTrades = [], skippedMarkets = []) {
  const watching = candidates.filter((candidate) => ["watching", "almost_ready"].includes(candidate.status)).length;
  const expired = candidates.filter((candidate) => candidate.status === "expired").length;
  const hasTypedResults = scanned.some((item) => item.resultType);
  const rejected = hasTypedResults
    ? scanned.filter((item) => item.resultType === SCANNER_RESULT_TYPES.REJECTED).length
    : Math.max(
      candidates.filter((candidate) => candidate.status === "rejected").length,
      scanned.filter((item) => !item.valid && !item.providerError).length - watching - expired
    );
  const avoidTrade = avoidTrades.length || scanned.filter((item) => item.resultType === SCANNER_RESULT_TYPES.AVOID).length;
  const topReason = diagnostics.topReasons?.[0]?.reason || "strategy not matched";
  const avoidReasonCounts = avoidTrades.reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {});
  const topAvoidReason = Object.entries(avoidReasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    ready: setups.length,
    watching,
    almostReady: candidates.filter((candidate) => candidate.status === "almost_ready").length,
    avoidTrade,
    rejected,
    expired,
    topAvoidReason,
    topRejectionReason: topReason,
    topRejectionCode: diagnostics.topCodes?.[0]?.code || slugDiagnostic(topReason),
    skipped: skippedMarkets.length,
    providerErrors: scanned.filter((item) => item.providerError).length,
    noData: scanned.filter((item) => (item.rejectionReasonCodes || []).some((code) =>
      ["invalid_market_data", "stale_data"].includes(code)
    )).length
  };
}

async function runManualScanMarkets(markets, scanMarket) {
  const concurrency = Math.max(1, appConfig.manualScan.concurrency);
  let cursor = 0;

  async function worker() {
    while (cursor < markets.length) {
      const index = cursor;
      cursor += 1;
      if (index > 0 && appConfig.manualScan.providerDelayMs > 0) {
        await delay(appConfig.manualScan.providerDelayMs);
      }
      await scanMarket(markets[index], index);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, markets.length || 1) },
    () => worker()
  ));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugDiagnostic(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function humanizeScanFailure(error) {
  const message = String(error?.message || "").toLowerCase();
  if (/stale|outdated|last candle/.test(message)) return "Data is stale.";
  if (/rate limit|too many requests|429/.test(message)) return "Provider rate limit reached.";
  if (/not enough|insufficient.*candle/.test(message)) return "Not enough current candle data.";
  if (/unsupported|does not support/.test(message)) return "Market or timeframe is not supported by the provider.";
  return "Provider unavailable.";
}

function failureDiagnosticCode(error) {
  const message = String(error?.message || "").toLowerCase();
  if (/stale|outdated|last candle/.test(message)) return "stale_data";
  if (/rate limit|too many requests|429/.test(message)) return "provider_rate_limit";
  if (/unsupported|does not support/.test(message)) return "unsupported_market";
  if (/not enough|insufficient.*candle/.test(message)) return "invalid_market_data";
  return "provider_unavailable";
}

async function recordAvoidTradeSafely(avoidTrade) {
  try {
    await recordAvoidTradeLearningEvent(avoidTrade);
  } catch (error) {
    console.warn(`[scanner] avoid_learning_failed market=${avoidTrade.symbol} timeframe=${avoidTrade.timeframe} reason=${error.message}`);
  }
}

async function refreshMarketBriefSafely(observations, scanSummary = null) {
  try {
    const clean = (observations || []).filter(Boolean);
    return clean.length
      ? await refreshDailyMarketBrief({ observations: clean, scanSummary })
      : await getLatestDailyMarketBrief();
  } catch (error) {
    console.warn(`[market-brief] refresh_failed reason=${error.message}`);
    return null;
  }
}

function recordScanDiagnostics(diagnostics, symbol, timeframe, analysis = {}) {
  for (const code of analysis.rejectionReasonCodes || []) {
    diagnostics.rejectionReasonCodes[code] = (diagnostics.rejectionReasonCodes[code] || 0) + 1;
  }
  for (const reason of analysis.rejectionReasons || []) {
    diagnostics.rejectionReasons[reason] = (diagnostics.rejectionReasons[reason] || 0) + 1;
  }
  if (diagnostics.samples.length < 8) {
    diagnostics.samples.push({
      symbol,
      timeframe,
      message: analysis.rejectionSummary || analysis.message || "No setup met the active filters.",
      reasons: analysis.rejectionReasons || []
    });
  }
}

function finalizeScanDiagnostics(diagnostics) {
  const topReasons = Object.entries(diagnostics.rejectionReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
  const topCodes = Object.entries(diagnostics.rejectionReasonCodes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([code, count]) => ({ code, count }));

  return {
    topReasons,
    topCodes,
    samples: diagnostics.samples,
    summary: topReasons.length
      ? `No setup found because: ${topReasons.slice(0, 3).map((item) => item.reason).join(", ")}.`
      : "No setup found because: strategy not matched."
  };
}

export function rankSetups(setups) {
  return setups.sort((a, b) => {
    return b.qualityScore - a.qualityScore ||
      b.confidenceScore - a.confidenceScore ||
      b.riskRewardRatio - a.riskRewardRatio;
  });
}

export async function listUserSignals(user) {
  await updateSignalsForUser(user);
  const signals = await listSignalsByUser(user.id);

  return {
    signals: signals.map(toUserSignal),
    stats: calculateSignalStats(signals)
  };
}

function toUserSignal(signal) {
  if (!signal?.signalQuality) return signal;
  const signalQuality = { ...signal.signalQuality, debug: undefined };
  const indicators = { ...(signal.indicators || {}), confidenceCalibration: undefined };
  return {
    ...signal,
    confidenceCalibration: undefined,
    signalQuality,
    indicators: { ...indicators, signalQuality }
  };
}

function toScanPreview(signal) {
  return {
    id: signal.id,
    setupKey: signal.setupKey,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    setupType: signal.setupType,
    confluenceScore: signal.confluenceScore,
    alignmentBadge: signal.alignmentBadge,
    session: signal.session,
    newsRisk: signal.newsRisk,
    smc: signal.smc,
    riskPlan: signal.riskPlan,
    marketStructure: signal.marketStructure,
    patternContext: signal.patternContext,
    correlation: signal.correlation,
    analyst: signal.analyst,
    riskRewardRatio: signal.riskRewardRatio,
    confidenceScore: signal.confidenceScore,
    confidenceBand: signal.confidenceBand,
    qualityScore: signal.qualityScore,
    signalQuality: toLockedSignalQuality(signal.signalQuality),
    validationPassed: signal.validationPassed,
    validationScore: signal.validationScore,
    rejectedReasons: signal.rejectedReasons || [],
    reasoning: signal.reasoning,
    confirmations: signal.confirmations,
    indicators: { ...(signal.indicators || {}), signalQuality: undefined, confidenceCalibration: undefined },
    generatedAt: signal.generatedAt,
    validUntil: signal.validUntil,
    validityDurationMs: signal.validityDurationMs,
    locked: true
  };
}

async function validateSignalForPublication(signal, marketData, user, options = {}) {
  return validateSignalPipeline(signal, {
    userId: user?.id,
    marketData,
    source: options.source,
    findActiveDuplicateSignal: options.duplicate === false ? null : findActiveDuplicateSignal,
    recordValidationRejection: recordSignalValidationRejection
  });
}

async function applyLearningToValidatedSignal(signal) {
  if (!signal) return signal;
  if (signal.indicators?.learningApplied) {
    return signal.indicators?.confidenceCalibrationApplied ? signal : applyConfidenceCalibration(signal);
  }
  const learning = await getLearningContextForSignal(signal);
  return applyConfidenceCalibration(applyLearningAdjustment(signal, learning));
}

async function getUserAnalystProfile(user) {
  if (!user?.id) return buildAnalystProfile([]);
  const signals = await listSignalsByUser(user.id);
  return buildAnalystProfile(signals);
}

function assertDiscoveryAvailable(user) {
  if (canDiscoverSetups(user)) return;
  const verificationRequired = !user.emailVerifiedAt && user.role !== "tester";
  const error = new Error(verificationRequired
    ? "Verify your email before using setup discovery credits."
    : "Setup discovery credit limit reached.");
  error.code = verificationRequired ? "EMAIL_VERIFICATION_REQUIRED" : "DISCOVERY_LIMIT";
  error.statusCode = 402;
  error.subscription = getSubscriptionSummary(user);
  throw error;
}
