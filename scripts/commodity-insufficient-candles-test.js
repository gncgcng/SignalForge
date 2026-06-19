process.env.TWELVEDATA_API_KEY = "test-key";

globalThis.fetch = async () => {
  const values = Array.from({ length: 12 }, (_, index) => ({
    datetime: `2026-01-01 00:${String(index).padStart(2, "0")}:00`,
    open: "100",
    high: "101",
    low: "99",
    close: "100.5"
  }));

  return new Response(JSON.stringify({ status: "ok", values }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

const { twelveDataMarketDataProvider } = await import("../src/modules/market-data/twelveDataMarketDataProvider.js");

let caught;

try {
  await twelveDataMarketDataProvider.getCandles("XAU/USD", "4h");
} catch (error) {
  caught = error;
}

const result = {
  rejected: caught?.code === "INSUFFICIENT_OHLCV",
  identifiesProvider: caught?.message.includes("Twelve Data"),
  includesUsableCount: caught?.message.includes("12 usable"),
  includesRequiredCount: caught?.message.includes("at least 60")
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}
