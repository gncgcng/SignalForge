import { coinbaseMarketDataProvider } from "./coinbaseMarketDataProvider.js";
import { commoditiesMarketDataProvider } from "./commoditiesMarketDataProvider.js";
import { MarketDataProviderError } from "./marketDataProviderError.js";

const providers = new Map([
  ["coinbase-exchange", coinbaseMarketDataProvider],
  ["twelve-data", commoditiesMarketDataProvider]
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
