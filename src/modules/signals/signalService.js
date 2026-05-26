import { listSignalsByUser, saveUnlockedSignal } from "../../db/repositories.js";
import { getOhlcv } from "../market-data/marketDataService.js";
import { canGenerateSignal, getSubscriptionSummary, recordSignalUsage } from "../subscriptions/subscriptionService.js";
import { generateMarketDataSetup } from "./signalGenerator.js";
import { calculateSignalStats, updateSignalsForUser } from "./signalOutcomeService.js";

const scanSymbols = ["BTC-USD", "ETH-USD", "SOL-USD"];
const scanTimeframes = ["5m", "15m", "1h", "4h"];

export async function createSignal(user, { symbol, timeframe }) {
  if (!canGenerateSignal(user)) {
    const summary = getSubscriptionSummary(user);
    const error = new Error("Free trial limit reached. Connect Stripe checkout to unlock more signals.");
    error.code = "TRIAL_LIMIT";
    error.subscription = summary;
    throw error;
  }

  const marketData = await getOhlcv(symbol, timeframe);
  const result = generateMarketDataSetup(marketData, timeframe);

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

export async function scanMarketSetup({ symbol, timeframe }) {
  const marketData = await getOhlcv(symbol, timeframe);
  const result = generateMarketDataSetup(marketData, timeframe);

  return {
    symbol,
    timeframe,
    valid: result.valid,
    setup: result.valid ? toScanPreview(result.signal) : null,
    analysis: result.analysis
  };
}

export async function scanAllMarkets() {
  const scanned = [];
  const setups = [];
  const errors = [];

  for (const symbol of scanSymbols) {
    for (const timeframe of scanTimeframes) {
      try {
        const result = await scanMarketSetup({ symbol, timeframe });
        scanned.push({ symbol, timeframe, valid: result.valid });

        if (result.valid) {
          setups.push(result.setup);
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

  setups.sort((a, b) => {
    return b.confidenceScore - a.confidenceScore || b.riskRewardRatio - a.riskRewardRatio;
  });

  return {
    setups,
    scanned,
    errors,
    message: setups.length ? "Valid setups found." : "No high-probability setups right now"
  };
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
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    riskRewardRatio: signal.riskRewardRatio,
    confidenceScore: signal.confidenceScore,
    reasoning: signal.reasoning,
    confirmations: signal.confirmations,
    generatedAt: signal.generatedAt,
    locked: true
  };
}
