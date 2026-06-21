import {
  cacheScanResult,
  getCachedScanResult,
  listSignalsByUser,
  saveUnlockedSignal
} from "../../db/repositories.js";
import { createId } from "../../shared/ids.js";
import { listActivePairs } from "../market-data/marketDataService.js";
import { getMultiTimeframeMarketData } from "../market-data/multiTimeframeService.js";
import {
  canDiscoverSetups,
  canGenerateSignal,
  getSubscriptionSummary,
  recordDiscoveryUsage
} from "../subscriptions/subscriptionService.js";
import { generateMarketDataSetup } from "./signalGenerator.js";
import { calculateSignalStats, updateSignalsForUser } from "./signalOutcomeService.js";
import { buildAnalystProfile } from "../analyst/signalAnalystService.js";

const scanTimeframes = ["1h", "4h", "15m", "5m"];

export async function createSignal(user, { symbol, timeframe }) {
  if (!canGenerateSignal(user)) {
    const summary = getSubscriptionSummary(user);
    const verificationRequired = !summary.emailVerified && summary.paidCredits <= 0;
    const error = new Error(verificationRequired
      ? "Verify your email to activate your three free signals."
      : "Free trial limit reached. Connect Stripe checkout to unlock more signals.");
    error.code = verificationRequired ? "EMAIL_VERIFICATION_REQUIRED" : "TRIAL_LIMIT";
    error.subscription = summary;
    throw error;
  }

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

  const signal = {
    ...result.fullSetup,
    id: createId("sig"),
    userId: user.id,
    status: "Active",
    statusUpdatedAt: new Date().toISOString()
  };

  const savedSignal = await saveUnlockedSignal(user.id, signal);
  if (user.role !== "tester") {
    user.unlockCreditsBalance = Math.max(0, Number(user.unlockCreditsBalance || 0) - 1);
    user.lifetimeUnlocksUsed = Number(user.lifetimeUnlocksUsed || 0) + 1;
    user.trialSignalsUsed = Number(user.trialSignalsUsed || 0) +
      (user.plan === "free" || user.plan === "trial" ? 1 : 0);
  }

  return {
    signal: savedSignal,
    analysis: result.analysis,
    subscription: getSubscriptionSummary(user)
  };
}

export async function scanMarketSetup(user, { symbol, timeframe }) {
  const scanKey = `single:${symbol}:${timeframe}`;
  const cached = await getCachedScanResult(user.id, scanKey);
  if (cached) {
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

  return {
    publicResult: {
      symbol,
      timeframe,
      valid: result.valid,
      setup: result.valid ? toScanPreview(result.signal) : null,
      analysis: result.analysis
    },
    fullSetup: result.valid ? result.signal : null
  };
}

export async function scanAllMarkets(user) {
  const scanKey = "scan-all:active-markets:5m-15m-1h-4h";
  const cached = await getCachedScanResult(user.id, scanKey);
  if (cached) {
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
  return {
    ...meteredResult.publicResult,
    fullSetups: meteredResult.fullSetups,
    cached: false,
    subscription
  };
}

export async function scanAllMarketsDetailed(user) {
  const scanned = [];
  const setups = [];
  const fullSetups = [];
  const errors = [];
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
        scanned.push({ symbol, timeframe, valid: result.valid });

        if (result.valid) {
          setups.push(result.setup);
          fullSetups.push(detailed.fullSetup);
        }
      } catch (error) {
        scanned.push({ symbol, timeframe, valid: false });
        errors.push({
          symbol,
          timeframe,
          message: error.message
        });
      }
    }
  }

  rankSetups(setups);

  return {
    publicResult: {
      setups,
      scanned,
      errors,
      message: setups.length ? "Valid setups found." : "No high-probability setups right now"
    },
    fullSetups
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
    signals: signals.slice(0, 24),
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
    qualityScore: signal.qualityScore,
    reasoning: signal.reasoning,
    confirmations: signal.confirmations,
    indicators: signal.indicators,
    generatedAt: signal.generatedAt,
    locked: true
  };
}

async function getUserAnalystProfile(user) {
  if (!user?.id) return buildAnalystProfile([]);
  const signals = await listSignalsByUser(user.id);
  return buildAnalystProfile(signals);
}

function assertDiscoveryAvailable(user) {
  if (canDiscoverSetups(user)) return;
  const verificationRequired = !user.emailVerifiedAt &&
    (user.plan === "free" || user.plan === "trial") &&
    Number(user.paidCredits || 0) <= 0;
  const error = new Error(verificationRequired
    ? "Verify your email to activate free setup discoveries."
    : "Setup discovery credit limit reached.");
  error.code = verificationRequired ? "EMAIL_VERIFICATION_REQUIRED" : "DISCOVERY_LIMIT";
  error.statusCode = 402;
  error.subscription = getSubscriptionSummary(user);
  throw error;
}
