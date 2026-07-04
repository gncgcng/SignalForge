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
const controller = readFileSync(new URL("../src/modules/performance/performanceController.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

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
  confluencePerformanceCorrect: analytics.confluencePerformance.find((item) => item.label === "80-100")?.winRate === 100 &&
    analytics.summary.bestConfluenceRange?.label === "80-100",
  monthlyPerformanceCorrect: analytics.monthlyPerformance[0].netR === 1 &&
    analytics.monthlyPerformance[1].netR === 2.5,
  premiumPerformanceTables:
    analytics.marketPerformance.find((item) => item.label === "BTC-USD")?.netR === 1 &&
    analytics.marketPerformance.find((item) => item.label === "BTC-USD")?.bestTimeframe?.label === "1h" &&
    analytics.timeframePerformance.find((item) => item.label === "1h")?.totalSignals === 3 &&
    analytics.recentClosedSignals.length === 4 &&
    analytics.recentClosedSignals[0].status === "Expired",
  chartsPresent: analytics.charts.winRateOverTime.length === 2 &&
    analytics.charts.outcomes[0].value === 2 &&
    analytics.charts.outcomes[2].value === 1 &&
    analytics.charts.marketDistribution.length === 3,
  repositoryUserScoped: repositories.includes('const clauses = ["s.user_id = $1"]') &&
    repositories.includes("s.generated_at >= $") &&
    repositories.includes("s.symbol = $") &&
    repositories.includes("COALESCE(o.status, 'Active') = $"),
  performanceTabPresent: html.includes('data-view-link="performance"') &&
    html.includes('data-view="performance"'),
  filtersPresent: ["performance-from", "performance-to", "performance-market", "performance-timeframe", "performance-direction", "performance-outcome"]
    .every((id) => html.includes(`id="${id}"`)),
  premiumUiPresent:
    html.includes("Performance Dashboard") &&
    html.includes("Total unlocked signals") &&
    html.includes("Net R") &&
    html.includes("Recent closed signals") &&
    html.includes('data-performance-range="30"') &&
    html.includes('id="equity-curve-chart"') &&
    styles.includes(".performance-hero") &&
    styles.includes(".performance-data-table") &&
    styles.includes("@media (max-width: 560px)"),
  outcomeFilterWired:
    controller.includes('status: url.searchParams.get("status")') &&
    app.includes('params.set("status", performanceOutcome.value)') &&
    app.includes('performanceOutcome.value = ""'),
  requiredChartsRendered: app.includes("renderWinRateChart") &&
    app.includes("renderAnalyticsBars") &&
    app.includes("renderMonthlyPerformance") &&
    app.includes("renderEquityCurve") &&
    app.includes("renderRecentClosedSignals"),
  cryptoAndCommoditiesRemainFilterable: app.includes('pair.category === "Crypto" || pair.category === "Commodities"')
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}

function signal(symbol, timeframe, status, riskRewardRatio, generatedAt, regime) {
  const confluenceScores = {
    "Trend Up": 86,
    Range: 48,
    "High Volatility": 68
  };
  return {
    symbol,
    timeframe,
    status,
    riskRewardRatio,
    generatedAt,
    indicators: {
      regime,
      confluenceScore: confluenceScores[regime] || 55
    }
  };
}
