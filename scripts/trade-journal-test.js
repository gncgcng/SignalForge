import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  calculateJournalStats,
  journalEmotions
} from "../src/modules/journal/journalService.js";

const entries = [
  entry("BTC-USD", "1h", "Hit TP", 2, 5, ["Confident", "Disciplined"]),
  entry("BTC-USD", "4h", "Hit SL", -1, 2, ["FOMO"]),
  entry("ETH-USD", "1h", "Hit TP", 2.5, 4, ["Confident"]),
  entry("SOL-USD", "15m", "Expired", 0, null, ["Impatient"]),
  entry("XAU/USD", "4h", "Open", 0, 5, ["Fear"])
];
const stats = calculateJournalStats(entries);

assert.equal(stats.averageTradeRating, 4);
assert.deepEqual(stats.mostCommonEmotion, { label: "Confident", count: 2 });
assert.equal(stats.bestPerformingMarket.label, "ETH-USD");
assert.equal(stats.bestPerformingTimeframe.label, "1h");
assert.deepEqual(journalEmotions, [
  "Confident",
  "Fear",
  "FOMO",
  "Impatient",
  "Disciplined"
]);

const migration = readFileSync(
  new URL("../migrations/010_trade_journals.sql", import.meta.url),
  "utf8"
);
const repositories = readFileSync(
  new URL("../src/db/repositories.js", import.meta.url),
  "utf8"
);
const service = readFileSync(
  new URL("../src/modules/journal/journalService.js", import.meta.url),
  "utf8"
);
const controller = readFileSync(
  new URL("../src/modules/journal/journalController.js", import.meta.url),
  "utf8"
);
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

const result = {
  schemaLinkedToPaperTrades: migration.includes("REFERENCES paper_trades(id) ON DELETE CASCADE") &&
    migration.includes("user_id text NOT NULL REFERENCES users(id)") &&
    migration.includes("rating integer CHECK (rating BETWEEN 1 AND 5)") &&
    migration.includes("emotion_tags text[]"),
  repositoryUserScoped: repositories.includes('"p.user_id = $1", "s.user_id = $1"') &&
    repositories.includes("WHERE p.id = $2 AND p.user_id = $1") &&
    repositories.includes("LEFT JOIN signal_outcomes o"),
  filtersImplemented: ["filters.symbol", "filters.timeframe", "filters.from", "filters.to", "filters.emotion"]
    .every((filter) => repositories.includes(filter)),
  inputValidation: service.includes("4,000 characters or fewer") &&
    service.includes("between 1 and 5 stars") &&
    service.includes('["http:", "https:"]') &&
    service.includes("Choose only supported emotion tags"),
  statsCorrect: stats.averageTradeRating === 4 &&
    stats.mostCommonEmotion.label === "Confident" &&
    stats.bestPerformingMarket.label === "ETH-USD" &&
    stats.bestPerformingTimeframe.label === "1h",
  apiProtected: controller.includes("Authentication required.") &&
    server.includes("handleJournalRoutes"),
  uiPresent: html.includes('data-view-link="journal"') &&
    html.includes('data-view="journal"') &&
    app.includes("notesBeforeEntry") &&
    app.includes("notesAfterExit") &&
    app.includes("screenshotUrl"),
  linkedToPaperHistory: repositories.includes("JOIN saved_signals s ON s.id = p.saved_signal_id") &&
    app.includes("data-journal-paper-trade"),
  signalGenerationUntouched: !service.includes("generateMarketDataSetup") &&
    !controller.includes("/api/signals/generate")
};

console.log(JSON.stringify(result, null, 2));

if (Object.values(result).some((value) => value !== true)) {
  process.exitCode = 1;
}

function entry(symbol, timeframe, status, realizedR, rating, emotionTags) {
  return {
    symbol,
    timeframe,
    status,
    realizedR,
    journal: { rating, emotionTags }
  };
}
