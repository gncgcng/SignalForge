import { coinbaseMarketDataProvider } from "./coinbaseMarketDataProvider.js";
import { twelveDataMarketDataProvider } from "./twelveDataMarketDataProvider.js";
import { MarketDataProviderError } from "./marketDataProviderError.js";

const providers = new Map([
  ["coinbase-exchange", coinbaseMarketDataProvider],
  ["twelve-data", twelveDataMarketDataProvider]
]);

export function getMarketDataProvider(pair) {
  const provider = providers.get(pair.provider);

  if (!provider) {
    throw new MarketDataProviderError(`No market data provider is registered for ${pair.symbol}.`, {
      statusCode: 503,
      code: "PROVIDER_NOT_REGISTERED"
    });
  }

  return provider;
}

export function isPairProviderConfigured(pair) {
  const provider = providers.get(pair.provider);
  return Boolean(provider?.isConfigured());
}

export function getPairProviderAvailability(pair) {
  if (!pair.provider) {
    return {
      configured: false,
      code: "MARKET_COMING_SOON",
      message: "Coming Soon"
    };
  }

  const provider = providers.get(pair.provider);

  if (!provider) {
    return {
      configured: false,
      code: "PROVIDER_NOT_REGISTERED",
      message: "Data provider not available"
    };
  }

  if (!provider.isConfigured()) {
    return {
      configured: false,
      code: "PROVIDER_NOT_CONFIGURED",
      message: pair.category === "Commodities"
        ? "Data provider not configured"
        : "Coming Soon"
    };
  }

  return {
    configured: true,
    code: "LIVE",
    message: "Live"
  };
}
