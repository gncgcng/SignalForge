import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const repository = readFileSync(new URL("src/modules/signals/setupCandidateRepository.js", root), "utf8");
const appConfig = readFileSync(new URL("src/config/appConfig.js", root), "utf8");
const server = readFileSync(new URL("src/server.js", root), "utf8");
const envExample = readFileSync(new URL(".env.example", root), "utf8");
const migration = readFileSync(new URL("migrations/049_avoid_trade_learning_retention.sql", root), "utf8");

assert.match(appConfig, /AVOID_TRADE_EVENT_RETENTION_DAYS \|\| 7/);
assert.match(appConfig, /AVOID_TRADE_EVENT_MAX_ROWS \|\| 25000/);
assert.match(appConfig, /AVOID_TRADE_EVENT_DEDUP_MINUTES \|\| 60/);

assert.match(envExample, /^AVOID_TRADE_EVENT_RETENTION_DAYS=7$/m);
assert.match(envExample, /^AVOID_TRADE_EVENT_MAX_ROWS=25000$/m);
assert.match(envExample, /^AVOID_TRADE_EVENT_DEDUP_MINUTES=60$/m);

assert.match(migration, /CREATE TABLE IF NOT EXISTS avoid_trade_learning_stats/);
assert.match(migration, /UNIQUE \(market, timeframe, reason, day, result\)/);
assert.match(migration, /INSERT INTO avoid_trade_learning_stats/);
assert.match(migration, /GROUP BY market, timeframe, reason, created_at::date/);
assert.match(migration, /count = GREATEST\(avoid_trade_learning_stats\.count, EXCLUDED\.count\)/);
assert.match(migration, /DELETE FROM avoid_trade_learning_events[\s\S]*interval '7 days'/);
assert.match(migration, /row_number\(\) OVER \(ORDER BY created_at DESC, id DESC\)/);
assert.match(migration, /r\.row_number > 25000/);
assert.match(migration, /ANALYZE avoid_trade_learning_events/);

assert.match(repository, /const dedupMinutes = appConfig\.avoidTradeLearning\.dedupMinutes/);
assert.match(repository, /dedupMinutes \* 60 \* 1000/);
assert.match(repository, /ON CONFLICT \(event_key\) DO UPDATE/);
assert.doesNotMatch(repository, /5 \* 60 \* 1000/);

assert.match(repository, /async function recordAvoidTradeLearningStat/);
assert.match(repository, /ON CONFLICT \(market, timeframe, reason, day, result\) DO UPDATE SET/);
assert.match(repository, /count = avoid_trade_learning_stats\.count \+ 1/);

assert.match(repository, /export async function cleanupAvoidTradeLearningEvents/);
assert.match(repository, /make_interval\(days => \$1::int\)/);
assert.match(repository, /r\.row_number > \$1/);
assert.match(repository, /VACUUM \(ANALYZE\) avoid_trade_learning_events/);
assert.match(repository, /AVOID_TRADE_CLEANUP_INTERVAL_MS = 24 \* 60 \* 60 \* 1000/);

assert.match(server, /startAvoidTradeLearningCleanupJob/);
assert.match(server, /startAvoidTradeLearningCleanupJob\(\)/);

assert.match(repository, /FROM avoid_trade_learning_stats[\s\S]*day >= current_date - interval '7 days'/);
assert.match(repository, /SUM\(count\)::integer AS count/);

console.log("Avoid-trade learning storage retention, dedupe, aggregate, cleanup, and env tests passed.");
