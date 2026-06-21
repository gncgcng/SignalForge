import { listSignalsByUser, saveUnlockedSignal } from "../../db/repositories.js";
import { listActivePairs } from "../market-data/marketDataService.js";
import { getMultiTimeframeMarketData } from "../market-data/multiTimeframeService.js";
import { canGenerateSignal, getSubscriptionSummary, recordSignalUsage } from "../subscriptions/subscriptionService.js";
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

  const marketData = await getMultiTimeframeMarketData(symbol, timeframe);
  const analystProfile = await getUserAnalystProfile(user);
  const result = generateMarketDataSetup(marketData, timeframe, { analystProfile });

  if (!result.valid) {
    return {
      signal: null,
      analysis: result.analysis,
      subscription: getSubscriptionSummary(user)
    };
  }

  const signal = {
    ...result.signal,
    userId: user.id,
    status: "Active",
    statusUpdatedAt: new Date().toISOString()
  };

  const savedSignal = await saveUnlockedSignal(user.id, signal);
  await recordSignalUsage(user);

  return {
    signal: savedSignal,
    analysis: result.analysis,
    subscription: getSubscriptionSummary(user)
  };
}

export async function scanMarketSetup(user, { symbol, timeframe }) {
  const result = await scanMarketSetupDetailed(user, { symbol, timeframe });
  return result.publicResult;
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
  const result = await scanAllMarketsDetailed(user);
  return result.publicResult;
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
