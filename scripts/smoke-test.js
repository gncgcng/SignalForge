const baseUrl = process.env.SIGNALFORGE_URL || "http://localhost:4173";
let cookie = "";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {})
    },
    ...options
  });
  const setCookie = response.headers.get("set-cookie");

  if (setCookie) {
    cookie = setCookie.split(";")[0];
  }

  return {
    status: response.status,
    body: await response.json()
  };
}

const login = await request("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({
    name: "Demo Trader",
    email: `demo-${Date.now()}@signalforge.app`,
    password: "signal123"
  })
});

const activeSymbols = ["BTC-USD", "ETH-USD", "SOL-USD"];
const timeframes = ["5m", "15m", "1h", "4h"];
const pairs = await request("/api/market-data/pairs");
const subscriptionBeforeScan = await request("/api/subscriptions/me");
const candleChecks = [];

for (const symbol of activeSymbols) {
  for (const timeframe of timeframes) {
    const response = await request(`/api/market-data/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`);
    candleChecks.push({
      symbol,
      timeframe,
      status: response.status,
      count: response.body.marketData?.candles?.length || 0,
      source: response.body.marketData?.source
    });
  }
}

const scanAll = await request("/api/signals/scan-all", {
  method: "POST",
  body: JSON.stringify({})
});
const subscriptionAfterScan = await request("/api/subscriptions/me");
const generated = [];

for (const symbol of activeSymbols) {
  generated.push(await request("/api/signals/generate", {
    method: "POST",
    body: JSON.stringify({
      symbol,
      timeframe: "15m"
    })
  }));
}

const signals = await request("/api/signals");

const result = {
  login: login.status,
  activeSymbols: pairs.body.pairs.filter((pair) => pair.status === "active").map((pair) => pair.symbol),
  soonSymbols: pairs.body.pairs.filter((pair) => pair.status !== "active").map((pair) => pair.symbol),
  candleChecks,
  scanAllStatus: scanAll.status,
  scanAllCount: scanAll.body.setups?.length || 0,
  scanAllMessage: scanAll.body.message,
  scanAllSorted: (scanAll.body.setups || []).every((setup, index, setups) => {
    if (index === 0) return true;
    const previous = setups[index - 1];
    return previous.confidenceScore > setup.confidenceScore ||
      (previous.confidenceScore === setup.confidenceScore && previous.riskRewardRatio >= setup.riskRewardRatio);
  }),
  remainingBeforeScan: subscriptionBeforeScan.body.subscription?.trialSignalsRemaining,
  remainingAfterScanAll: subscriptionAfterScan.body.subscription?.trialSignalsRemaining,
  generateChecks: generated.map((item, index) => ({
    symbol: activeSymbols[index],
    status: item.status,
    generatedSignal: Boolean(item.body.signal),
    remaining: item.body.subscription?.trialSignalsRemaining,
    message: item.body.analysis?.message
  })),
  stats: signals.body.stats,
  signalsReturned: signals.body.signals.length
};

const generatedCount = result.generateChecks.filter((item) => item.generatedSignal).length;

console.log(JSON.stringify(result, null, 2));

if (
  result.login !== 200 ||
  !activeSymbols.every((symbol) => result.activeSymbols.includes(symbol)) ||
  result.soonSymbols.length < 1 ||
  result.candleChecks.some((check) => check.status !== 200 || check.count < 20 || check.source !== "coinbase-exchange") ||
  result.scanAllStatus !== 200 ||
  result.scanAllSorted !== true ||
  result.remainingBeforeScan !== result.remainingAfterScanAll ||
  result.generateChecks.some((check) => ![200, 201].includes(check.status)) ||
  typeof result.stats?.totalSignals !== "number" ||
  result.signalsReturned !== generatedCount
) {
  process.exitCode = 1;
}
