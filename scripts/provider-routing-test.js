process.env.TWELVEDATA_API_KEY = "test-key";

const providerCalls = [];

globalThis.fetch = async (url) => {
  const requestUrl = new URL(url);
  const provider = requestUrl.hostname.includes("coinbase") ? "coinbase-exchange" : "twelve-data";
  providerCalls.push({ provider, url: requestUrl.toString() });

  if (provider === "coinbase-exchange") {
    const now = Math.floor(Date.now() / 1000);
    const candles = Array.from({ length: 120 }, (_, index) => {
      const price = 100 + index * 0.1;
      return [now - index * 300, price - 0.5, price + 0.5, price, price + 0.2, 1000 + index];
    });
    return jsonResponse(candles);
  }

  const values = Array.from({ length: 120 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1, 0, index * 5));
    const price = 100 + index * 0.1;
    return {
      datetime: date.toISOString().replace("T", " ").slice(0, 19),
      open: String(price),
      high: String(price + 0.5),
      low: String(price - 0.5),
      close: String(price + 0.2),
      volume: String(1000 + index)
    };
  });
  return jsonResponse({ status: "ok", values });
};

const { getOhlcv } = await import("../src/modules/market-data/marketDataService.js");

const crypto = await getOhlcv("BTC-USD", "5m");
const commodity = await getOhlcv("XAU/USD", "5m");
const result = {
  cryptoUsesCoinbase: crypto.source === "coinbase-exchange" && providerCalls[0]?.provider === "coinbase-exchange",
  commodityUsesTwelveData: commodity.source === "twelve-data" && providerCalls[1]?.provider === "twelve-data",
  noCommodityCoinbaseFallback: !providerCalls
    .filter((call) => call.provider === "coinbase-exchange")
    .some((call) => call.url.includes("XAU"))
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
