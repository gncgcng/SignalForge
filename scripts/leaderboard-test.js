import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLeaderboards } from "../src/modules/leaderboards/leaderboardService.js";

const repositories = readFileSync("src/db/repositories.js", "utf8");
const migration = readFileSync("migrations/025_leaderboards.sql", "utf8");
const html = readFileSync("public/index.html", "utf8");
const app = readFileSync("public/app.js", "utf8");

assert.match(migration, /public_leaderboard_enabled boolean NOT NULL DEFAULT false/);
assert.match(repositories, /u\.public_profile_enabled = true/);
assert.match(repositories, /u\.public_leaderboard_enabled = true/);
assert.match(repositories, /u\.username_normalized IS NOT NULL/);
assert.match(repositories, /COALESCE\(u\.role, 'user'\) <> 'tester'/);
assert.match(html, /data-view-link="leaderboard"/);
assert.match(html, /settings-public-leaderboard/);
assert.match(app, /Show me on public leaderboards|settingsPublicLeaderboard|renderLeaderboards/);

const now = new Date("2026-07-15T12:00:00.000Z");
const rows = [
  ...makeOutcomes("usr_alpha", "Alpha", [2, 2.2, -1, 1.8, 2.4], "2026-07", "BTC-USD"),
  ...makeOutcomes("usr_beta", "Beta", [1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.1, 2.2, 2.3, -1], "2026-07", "ETH-USD"),
  ...makeOutcomes("usr_gamma", "Gamma", [3, 3, 3], "2026-06", "SOL-USD"),
  ...makeOutcomes("usr_blank", "", [5], "2026-07", "XRP-USD"),
  duplicate("usr_alpha", "Alpha")
];

const leaderboards = buildLeaderboards(rows, now);

assert.equal(leaderboards.tabs.topRMultiple[0].username, "Beta");
assert.equal(leaderboards.tabs.topRMultiple[1].username, "Gamma");
assert.equal(leaderboards.tabs.topRMultiple[2].username, "Alpha");
assert.equal(leaderboards.tabs.bestWinRate.length, 1);
assert.equal(leaderboards.tabs.bestWinRate[0].username, "Beta");
assert.equal(leaderboards.tabs.monthlyChampions[0].username, "Beta");
assert.equal(leaderboards.tabs.monthlyChampions.some((row) => row.username === "Gamma"), false);
assert.equal(leaderboards.tabs.mostActive[0].username, "Beta");
assert.equal(leaderboards.tabs.longestWinStreak[0].username, "Beta");

const serialized = JSON.stringify(leaderboards);
assert.doesNotMatch(serialized, /alpha@example\.com|beta@example\.com|email|userId|telegram|billing|affiliate/i);
assert.equal(serialized.includes("usr_blank"), false);

console.log("Leaderboard tests passed.");

function makeOutcomes(userId, username, results, month, symbol) {
  return results.map((result, index) => {
    const win = result > 0;
    return {
      userId,
      username,
      plan: userId === "usr_beta" ? "pro" : "free",
      role: "user",
      email: `${username || "blank"}@example.com`,
      signalId: `${userId}_${index}`,
      setupKey: `${symbol}:1h:${index}`,
      symbol,
      timeframe: index % 2 ? "4h" : "1h",
      riskRewardRatio: win ? result : 2,
      generatedAt: `${month}-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      createdAt: `${month}-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      status: win ? "Hit TP" : "Hit SL",
      resolvedAt: `${month}-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`,
      paperTradeId: index % 2 ? `paper_${userId}_${index}` : null
    };
  });
}

function duplicate(userId, username) {
  return {
    userId,
    username,
    plan: "free",
    role: "user",
    email: "alpha@example.com",
    signalId: "duplicate_signal",
    setupKey: "BTC-USD:1h:0",
    symbol: "BTC-USD",
    timeframe: "1h",
    riskRewardRatio: 99,
    generatedAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "Hit TP",
    resolvedAt: "2026-07-01T01:00:00.000Z",
    paperTradeId: null
  };
}
