import { readFileSync } from "node:fs";
import { buildPerformanceAnalytics } from "../src/modules/performance/performanceService.js";

const signals = [
  signal("BTC-USD", "1h", "Hit TP", 2, "2026-01-05T00:00:00.000Z", "Trend Up"),
  signal("BTC-USD", "4h", "Hit SL", 1.8, "2026-01-12T00:00:00.000Z", "Range"),
  signal("XAU/USD", "1h", "Hit TP", 2.5, "2026-02-03T00:00:00.000Z", "Trend Up"),
  signal("XAU/USD", "15m", "Expired", 1.5, "2026-02-14T00:00:00.000Z", "High Volatility"),
  signal("ETH-USD", "1h", "Active", 2, "2026-02-20T00:00:00.000Z", "Range")
];

const analytics = buildPerformanceAnalytics(signals);
const repositories = readFileSync(new URL("../src/db/repositories.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const result = {
  summaryCorrect: analytics.summary.totalSignals === 5 &&
    analytics.summary.hitTpCount === 2 &&
    analytics.summary.hitSlCount === 1 &&
    analytics.summary.expiredCount === 1 &&
    analytics.summary.winRate === 67 &&
    analytics.summary.averageRiskReward === 1.96,
  marketBreakdownCorrect: analytics.signalsByMarket.find((item) => item.label === "BTC-USD")?.value === 2 &&
    analytics.signalsByMarket.find((item) => item.label === "XAU/USD")?.value === 2,
  timeframeBreakdownCorrect: analytics.signalsByTimeframe.find((item) => item.label === "1h")?.value === 3,
  regimePerformanceCorrect: analytics.regimePerformance.find((item) => item.label === "Trend Up")?.winRate === 100 &&
    analytics.summary.bestRegime?.label === "Trend Up",
  monthlyPerformanceCorrect: analytics.monthlyPerformance[0].netR === 1 &&
    analytics.monthlyPerformance[1].netR === 2.5,
  chartsPresent: analytics.charts.winRateOverTime.length === 2 &&
    analytics.charts.outcomes[0].value === 2 &&
    analytics.charts.outcomes[2].value === 1 &&
    analytics.charts.marketDistribution.length === 3,
  repositoryUserScoped: repositories.includes('const clauses = ["s.user_id = $1"]') &&
    repositories.includes("s.generated_at >= $") &&
    repositories.includes("s.symbol = $"),
  performanceTabPresent: html.includes('data-view-link="performance"') &&
    html.includes('data-view="performance"'),
  filtersPresent: ["performance-from", "performance-to", "performance-market", "performance-timeframe", "performance-direction"]
    .every((id) => html.includes(`id="${id}"`)),
  requiredChartsRendered: app.includes("renderWinRateChart") &&
    app.includes("renderAnalyticsBars") &&
    app.includes("renderMonthlyPerformance"),
  cryptoAndCommoditiesRemainFilterable: app.includes('pair.category === "Crypto" || pair.category === "Commodities"')
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}

function signal(symbol, timeframe, status, riskRewardRatio, generatedAt, regime) {
  return {
    symbol,
    timeframe,
    status,
    riskRewardRatio,
    generatedAt,
    indicators: { regime }
  };
}
