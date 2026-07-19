import { getCandlesFromCoinbase, getProductFromCoinbase } from "../src/modules/market-data/coinbaseMarketDataProvider.js";
import { cryptoTimeframes } from "../src/modules/markets/cryptoMarkets.js";
import { legacyCryptoReplacements } from "../src/modules/markets/cryptoMarketService.js";

const symbol = String(process.argv[2] || process.env.MARKET_SYMBOL || "").trim().toUpperCase();

if (!symbol) {
  console.error("Usage: node scripts/test-coinbase-market.js BTC-USD");
  process.exitCode = 1;
} else {
  await run(symbol);
}

async function run(providerSymbol) {
  console.log(`Provider symbol: ${providerSymbol}`);
  if (legacyCryptoReplacements[providerSymbol]) {
    console.log(`Legacy / migrated: Yes - try ${legacyCryptoReplacements[providerSymbol]}`);
  }

  const product = await checkProduct(providerSymbol);
  console.log(`Product exists: ${product.exists ? "yes" : product.providerError ? "unknown" : "no"}`);
  console.log(`Product trading enabled: ${formatMaybe(product.tradingEnabled)}`);
  if (product.error) console.log(`Product error: ${product.error}`);

  let latestCandleTime = null;
  for (const timeframe of cryptoTimeframes) {
    const result = await checkCandles(providerSymbol, timeframe);
    if (result.latestCandleAt && (!latestCandleTime || new Date(result.latestCandleAt) > new Date(latestCandleTime))) {
      latestCandleTime = result.latestCandleAt;
    }
    console.log(`${timeframe} candles: ${result.pass ? "pass" : "fail"}${result.detail ? ` - ${result.detail}` : ""}`);
  }
  console.log(`Latest candle time: ${latestCandleTime || "none"}`);
}

async function checkProduct(providerSymbol) {
  try {
    const product = await getProductFromCoinbase(providerSymbol);
    const status = String(product.status || "online").toLowerCase();
    const tradingEnabled = product.trading_disabled !== true && !["offline", "delisted", "disabled"].includes(status);
    return { exists: true, tradingEnabled, status };
  } catch (error) {
    const providerError = ["PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_ERROR", "MARKET_DATA_TIMEOUT", "RATE_LIMITED", "BAD_PROVIDER_RESPONSE"].includes(error.code);
    return {
      exists: false,
      providerError,
      tradingEnabled: null,
      error: `${error.code || "PROVIDER_ERROR"}: ${error.message}`
    };
  }
}

async function checkCandles(providerSymbol, timeframe) {
  try {
    const data = await getCandlesFromCoinbase(providerSymbol, timeframe);
    const latest = validateCandles(data.candles, timeframe);
    return { pass: true, latestCandleAt: latest, detail: `${data.candles.length} candles, latest ${latest}` };
  } catch (error) {
    return { pass: false, detail: `${error.code || "PROVIDER_ERROR"}: ${error.message}` };
  }
}

function validateCandles(candles, timeframe) {
  if (!Array.isArray(candles) || candles.length === 0) throw new Error("No candle data returned.");
  if (candles.length < 60) throw new Error("Insufficient candle data returned.");
  const latest = candles[candles.length - 1];
  const latestMs = Number(latest?.time) * 1000;
  const expectedMs = ({ "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 })[timeframe];
  if (!Number.isFinite(latestMs)) throw new Error("Latest candle time is invalid.");
  if (Date.now() - latestMs > expectedMs * 2.5) throw new Error("Latest candle is stale.");
  return new Date(latestMs).toISOString();
}

function formatMaybe(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}
