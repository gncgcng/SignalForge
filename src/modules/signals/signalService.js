import {
  cacheScanResult,
  findActiveDuplicateSignal,
  findTelegramNotificationPayload,
  getLearningContextForSignal,
  getCachedScanResult,
  listSignalsByUser,
  recordSignalValidationRejection,
  saveSignalSnapshot,
  saveUnlockedSignal
} from "../../db/repositories.js";
import { createId } from "../../shared/ids.js";
import { listActivePairs } from "../market-data/marketDataService.js";
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

const scanTimeframes = ["1h", "4h", "15m", "5m"];

export async function createSignal(user, { symbol, timeframe }) {
  const scanKey = `single:${symbol}:${timeframe}`;
  const cached = await getCachedScanResult(user.id, scanKey);
  let result = cached;

  if (!result) {
    assertDiscoveryAvailable(user);
    result = await scanMarketSetupDetailed(user, { symbol, timeframe });
    await recordDiscoveryUsage(user, result.publicResult.valid ? 1 : 0, scanKey);
    await cacheScanResult(user.id, scanKey, result);
  }

  if (!result.publicResult.valid) {
    return {
      signal: null,
      analysis: result.publicResult.analysis,
      subscription: getSubscriptionSummary(user)
    };
  }

  const freshMarketData = await getMultiTimeframeMarketData(symbol, timeframe);
  const unlockValidation = await validateSignalForPublication(result.fullSetup, freshMarketData, user, {
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
    applyValidationToSignal(result.fullSetup, unlockValidation)
  );
  const signal = {
    ...learningAdjusted,
    id: createId("sig"),
    userId: user.id,
    status: "Active",
    statusUpdatedAt: new Date().toISOString()
  };

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
    signal: savedSignal,
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

  const signal = {
    ...queuedSetup,
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

  const validatedSignal = await applyLearningToValidatedSignal(
    applyValidationToSignal(signal, validation)
  );
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
    signal: savedSignal,
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
      cached: true,
      subscription: getSubscriptionSummary(user)
    };
  }
  assertDiscoveryAvailable(user);
  const result = await scanMarketSetupDetailed(user, { symbol, timeframe });
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
    cached: false,
    subscription
  };
}

export async function scanMarketSetupDetailed(user, { symbol, timeframe }, analystProfile = null) {
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
    ? await applyLearningToValidatedSignal(applyValidationToSignal(readySignal, validation))
    : null;
  const signal = learnedSignal
    ? { ...learnedSignal, confidenceScore: Math.min(learnedSignal.confidenceScore, candidate?.confidenceEstimate || 99) }
    : null;
  if (signal && candidate) {
    candidate = await markCandidatePromoted(candidate, signal) || { ...candidate, status: "promoted_to_signal" };
  }
  if (readySignal && validation && !validation.passed && candidate) {
    candidate = await markCandidateRejected(candidate, validation.reasons?.[0]?.reason || "Final signal validation failed.") || {
      ...candidate,
      status: "rejected",
      rejectionReason: validation.reasons?.[0]?.reason || "Final signal validation failed."
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

  return {
    publicResult: {
      symbol,
      timeframe,
      valid,
      setup: valid ? toScanPreview(signal) : null,
      analysis,
      candidate: candidate ? toCandidatePreview(candidate) : null
    },
    fullSetup: signal,
    analysis
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
    rejectionReason: candidate.rejectionReason,
    lastCheckedAt: candidate.lastCheckedAt,
    expiresAt: candidate.expiresAt
  };
}

export async function scanAllMarkets(user) {
  const scanKey = "scan-all:active-markets:5m-15m-1h-4h";
  const cached = await getCachedScanResult(user.id, scanKey);
  if (cached) {
    await trackScanAllAnalytics(user, cached.publicResult.scanned, true);
    return {
      ...cached.publicResult,
      fullSetups: cached.fullSetups,
      cached: true,
      subscription: getSubscriptionSummary(user)
    };
  }
  assertDiscoveryAvailable(user);
  const result = await scanAllMarketsDetailed(user);
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

export async function scanAllMarketsDetailed(user) {
  const scanned = [];
  const setups = [];
  const fullSetups = [];
  const candidatesById = new Map();
  const errors = [];
  const diagnostics = {
    rejectionReasonCodes: {},
    rejectionReasons: {},
    samples: []
  };
  const scanSymbols = listActivePairs().map((pair) => pair.symbol);
  const analystProfile = await getUserAnalystProfile(user);

  for (const symbol of scanSymbols) {
    for (const timeframe of scanTimeframes) {
      try {
        const detailed = await scanMarketSetupDetailed(
          user,
          { symbol, timeframe },
          analystProfile
        );
        const result = detailed.publicResult;
        const analysis = result.analysis || {};
        scanned.push({
          symbol,
          timeframe,
          valid: result.valid,
          rejectionReasonCodes: analysis.rejectionReasonCodes || [],
          rejectionReasons: analysis.rejectionReasons || []
        });

        if (result.candidate && !result.valid) {
          candidatesById.set(result.candidate.id, result.candidate);
        }

        if (result.valid) {
          setups.push(result.setup);
          fullSetups.push(detailed.fullSetup);
        } else {
          recordScanDiagnostics(diagnostics, symbol, timeframe, analysis);
        }
      } catch (error) {
        const publicReason = humanizeScanFailure(error);
        scanned.push({
          symbol,
          timeframe,
          valid: false,
          providerError: true,
          rejectionReasonCodes: ["provider_unavailable"],
          rejectionReasons: [publicReason]
        });
        recordScanDiagnostics(diagnostics, symbol, timeframe, {
          message: publicReason,
          rejectionSummary: publicReason,
          rejectionReasonCodes: ["provider_unavailable"],
          rejectionReasons: [publicReason]
        });
        errors.push({
          symbol,
          timeframe,
          message: publicReason
        });
      }
    }
  }

  rankSetups(setups);
  const candidates = [...candidatesById.values()];
  const finalizedDiagnostics = finalizeScanDiagnostics(diagnostics);
  const scanSummary = summarizeScanBatch(scanned, setups, candidates, finalizedDiagnostics);
  console.info(
    `[scanner] ready=${scanSummary.ready} watching=${scanSummary.watching} ` +
    `rejected=${scanSummary.rejected} expired=${scanSummary.expired}`
  );
  console.info(`[scanner] top_rejection_reason=${scanSummary.topRejectionCode}`);

  return {
    publicResult: {
      setups,
      candidates,
      scanned,
      errors,
      diagnostics: finalizedDiagnostics,
      scanSummary,
      message: setups.length ? "Valid setups found." : "No high-probability setups right now"
    },
    fullSetups
  };
}

export function summarizeScanBatch(scanned, setups, candidates, diagnostics) {
  const watching = candidates.filter((candidate) => ["watching", "almost_ready"].includes(candidate.status)).length;
  const expired = candidates.filter((candidate) => candidate.status === "expired").length;
  const explicitlyRejected = candidates.filter((candidate) => candidate.status === "rejected").length;
  const evaluatedWithoutSignal = scanned.filter((item) => !item.valid && !item.providerError).length;
  const rejected = Math.max(explicitlyRejected, evaluatedWithoutSignal - watching - expired);
  const topReason = diagnostics.topReasons?.[0]?.reason || "strategy not matched";
  return {
    ready: setups.length,
    watching,
    almostReady: candidates.filter((candidate) => candidate.status === "almost_ready").length,
    rejected,
    expired,
    topRejectionReason: topReason,
    topRejectionCode: diagnostics.topCodes?.[0]?.code || slugDiagnostic(topReason)
  };
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
    signals,
    stats: calculateSignalStats(signals)
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
    correlation: signal.correlation,
    analyst: signal.analyst,
    riskRewardRatio: signal.riskRewardRatio,
    confidenceScore: signal.confidenceScore,
    confidenceBand: signal.confidenceBand,
    qualityScore: signal.qualityScore,
    validationPassed: signal.validationPassed,
    validationScore: signal.validationScore,
    rejectedReasons: signal.rejectedReasons || [],
    reasoning: signal.reasoning,
    confirmations: signal.confirmations,
    indicators: signal.indicators,
    generatedAt: signal.generatedAt,
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
  if (signal.indicators?.learningApplied) return signal;
  const learning = await getLearningContextForSignal(signal);
  return applyLearningAdjustment(signal, learning);
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
