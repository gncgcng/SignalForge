import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLeaderboards } from "../src/modules/leaderboards/leaderboardService.js";

const repositories = readFileSync("src/db/repositories.js", "utf8");
const migration = readFileSync("migrations/025_leaderboards.sql", "utf8");
const service = readFileSync("src/modules/leaderboards/leaderboardService.js", "utf8");
const server = readFileSync("src/server.js", "utf8");
const html = readFileSync("public/index.html", "utf8");
const app = readFileSync("public/app.js", "utf8");
const leaderboardRepository = repositories.slice(
  repositories.indexOf("export async function listLeaderboardPerformanceRows"),
  repositories.indexOf("export async function incrementTrialSignalsUsed")
);

assert.match(migration, /public_leaderboard_enabled boolean NOT NULL DEFAULT false/);
assert.match(leaderboardRepository, /u\.public_profile_enabled = true/);
assert.match(leaderboardRepository, /u\.public_leaderboard_enabled = true/);
assert.doesNotMatch(leaderboardRepository, /COALESCE\(u\.role, 'user'\) <> 'tester'/);
assert.doesNotMatch(leaderboardRepository, /u\.username_normalized IS NOT NULL/);
assert.match(leaderboardRepository, /LEFT JOIN LATERAL/);
assert.match(leaderboardRepository, /paper_orders/);
assert.match(leaderboardRepository, /status IN \('Hit TP', 'Hit SL', 'Expired', 'Closed'\)/);
assert.match(repositories, /getLeaderboardEligibilityByUser/);
assert.match(service, /closedSignals >= 3/);
assert.match(service, /\[leaderboard\] recalculated users=/);
assert.match(server, /recalculateLeaderboardStats\(\)/);
assert.match(html, /data-view-link="leaderboard"/);
assert.match(html, /Completed tracked signals/);
assert.match(html, /Linked paper trades/);
assert.match(app, /Open Profile Settings/);
assert.match(app, /Completed tracked signal or linked paper trade/);

const now = new Date("2026-07-15T12:00:00.000Z");
const rows = [
  ...makeOutcomes("usr_alpha", "Alpha", [2, 2.2, -1], "2026-07", "BTC-USD"),
  ...makeOutcomes("usr_beta", "Beta", [1.5, 1.6, 1.7, -1], "2026-07", "ETH-USD"),
  ...makeOutcomes("usr_gamma", "Gamma", [3, 3, 3], "2026-06", "SOL-USD"),
  ...makeOutcomes("usr_free", "FreeTrader", [1.8], "2026-07", "XRP-USD", { plan: "free" }),
  ...makeOutcomes("usr_test_7391", "EarlyAccess", [2.5], "2026-07", "LTC-USD", { role: "tester", plan: "tester" }),
  makePaperOutcome("usr_paper", "PaperTrader"),
  makePaperOutcome("usr_fallback_4827", ""),
  { ...makePaperOutcome("usr_private", "PrivateTrader"), publicProfileEnabled: false },
  { ...makePaperOutcome("usr_optout", "OptedOutTrader"), publicLeaderboardEnabled: false },
  duplicate("usr_alpha", "Alpha")
];

const leaderboards = buildLeaderboards(rows, now);
const topR = leaderboards.tabs.topRMultiple;

assert.equal(topR[0].username, "Gamma");
assert.equal(topR[1].username, "Beta");
assert.equal(topR[2].username, "Alpha");
assert.ok(topR.some((row) => row.username === "FreeTrader"), "eligible free user should appear");
assert.ok(topR.some((row) => row.username === "EarlyAccess"), "opted-in tester should appear");
assert.ok(topR.some((row) => row.username === "PaperTrader"), "closed linked paper trade should appear");
assert.equal(topR.some((row) => row.username === "PrivateTrader"), false);
assert.equal(topR.some((row) => row.username === "OptedOutTrader"), false);
const fallback = topR.find((row) => /^Trader \d{4}$/.test(row.username));
assert.ok(fallback, "missing usernames should receive a safe public fallback");
assert.equal(fallback.profileUrl, null);
assert.equal(fallback.username.includes("4827"), false, "fallback must not reveal an internal ID suffix");

assert.equal(leaderboards.tabs.bestWinRate.some((row) => row.username === "Alpha"), true);
assert.equal(leaderboards.tabs.bestWinRate.some((row) => row.username === "FreeTrader"), false);
assert.equal(leaderboards.tabs.monthlyChampions.some((row) => row.username === "Gamma"), false);
assert.equal(leaderboards.tabs.mostActive[0].username, "Beta");
assert.equal(leaderboards.tabs.longestWinStreak[0].username, "Gamma");

const alpha = topR.find((row) => row.username === "Alpha");
assert.equal(alpha.closedSignals, 3, "duplicate setup keys must not inflate recalculated stats");
assert.equal(alpha.hitTpCount, 2);
assert.equal(alpha.hitSlCount, 1);
assert.equal(alpha.netR, 3.2);
assert.equal(alpha.averageR, 1.07);

const tester = topR.find((row) => row.username === "EarlyAccess");
assert.equal(tester.plan, "free", "tester status must not be exposed as a public badge");

const serialized = JSON.stringify(leaderboards);
assert.doesNotMatch(serialized, /alpha@example\.com|beta@example\.com|email|userId|telegram|billing|affiliate|role/i);

console.log("Leaderboard eligibility and ranking tests passed.");

function makeOutcomes(userId, username, results, month, symbol, overrides = {}) {
  return results.map((result, index) => ({
    userId,
    username,
    plan: overrides.plan || (userId === "usr_beta" ? "pro" : "free"),
    role: overrides.role || "user",
    email: `${username || "blank"}@example.com`,
    publicProfileEnabled: true,
    publicLeaderboardEnabled: true,
    signalId: `${userId}_${index}`,
    setupKey: `${symbol}:1h:${index}`,
    symbol,
    timeframe: index % 2 ? "4h" : "1h",
    riskRewardRatio: result > 0 ? result : 2,
    resultR: result,
    generatedAt: `${month}-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    createdAt: `${month}-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    status: result > 0 ? "Hit TP" : "Hit SL",
    resolvedAt: `${month}-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`,
    paperTradeId: null
  }));
}

function makePaperOutcome(userId, username) {
  return {
    userId,
    username,
    plan: "free",
    role: "user",
    email: `${userId}@example.com`,
    publicProfileEnabled: true,
    publicLeaderboardEnabled: true,
    signalId: `${userId}_signal`,
    setupKey: `${userId}:paper`,
    symbol: "XLM-USD",
    timeframe: "1h",
    riskRewardRatio: 2,
    resultR: 0.75,
    generatedAt: "2026-07-10T00:00:00.000Z",
    createdAt: "2026-07-10T00:00:00.000Z",
    status: "Closed",
    resolvedAt: "2026-07-10T01:00:00.000Z",
    paperTradeId: `${userId}_paper`
  };
}

function duplicate(userId, username) {
  return {
    ...makeOutcomes(userId, username, [99], "2026-07", "BTC-USD")[0],
    signalId: "duplicate_signal",
    setupKey: "BTC-USD:1h:0"
  };
}
