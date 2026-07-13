import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertSignalFresh,
  getSignalValidityMs,
  getSignalValidUntil,
  isSignalExpired,
  withSignalValidity
} from "../src/modules/signals/signalValidityService.js";
import { formatSignalCountdown, getSignalValidityState } from "../public/signalValidity.js";
import { filterAndSortSignals, getSignalStatusCounts } from "../public/signalFilters.js";

const generatedAt = "2026-07-13T12:00:00.000Z";
const expectedValidity = {
  "1m": 30 * 60 * 1000,
  "5m": 2 * 60 * 60 * 1000,
  "15m": 6 * 60 * 60 * 1000,
  "1h": 24 * 60 * 60 * 1000,
  "4h": 48 * 60 * 60 * 1000
};

for (const [timeframe, duration] of Object.entries(expectedValidity)) {
  assert.equal(getSignalValidityMs(timeframe), duration);
  const signal = withSignalValidity({ timeframe, generatedAt, status: "Active" });
  assert.equal(new Date(signal.validUntil).getTime(), new Date(generatedAt).getTime() + duration);
  assert.equal(signal.validityDurationMs, duration);
}

const active = withSignalValidity({ timeframe: "5m", generatedAt, status: "Active" });
assert.equal(getSignalValidityState(active, new Date(generatedAt).getTime() + 30 * 60 * 1000).status, "active");
assert.equal(formatSignalCountdown(active, new Date(generatedAt).getTime() + 30 * 60 * 1000), "1h 30m");
assert.equal(getSignalValidityState(active, new Date(generatedAt).getTime() + 95 * 60 * 1000).status, "expiring-soon");
assert.equal(getSignalValidityState(active, new Date(active.validUntil).getTime()).status, "expired");
assert.equal(isSignalExpired(active, new Date(active.validUntil).getTime()), true);
assert.throws(() => assertSignalFresh(active, new Date(active.validUntil).getTime()), (error) => {
  assert.equal(error.code, "SIGNAL_EXPIRED");
  assert.equal(error.statusCode, 410);
  return true;
});
assert.equal(isSignalExpired({ ...active, status: "Hit TP" }, Date.parse(active.validUntil) + 1), false);
assert.equal(isSignalExpired({ ...active, status: "Hit SL" }, Date.parse(active.validUntil) + 1), false);
assert.equal(getSignalValidUntil({ ...active, validUntil: active.validUntil }), active.validUntil);

const now = Date.now();
const filtersFixture = [
  signal("active", "Active", now + 4 * 60 * 60 * 1000, 6 * 60 * 60 * 1000),
  signal("soon", "Active", now + 20 * 60 * 1000, 6 * 60 * 60 * 1000),
  signal("expired", "Active", now - 1, 6 * 60 * 60 * 1000),
  signal("tp", "Hit TP", now - 1, 6 * 60 * 60 * 1000),
  signal("sl", "Hit SL", now - 1, 6 * 60 * 60 * 1000)
];
assert.deepEqual(getSignalStatusCounts(filtersFixture), {
  all: 5,
  active: 2,
  "expiring-soon": 1,
  "hit-tp": 1,
  "hit-sl": 1,
  expired: 1,
  closed: 3
});
assert.deepEqual(filterAndSortSignals(filtersFixture, { status: "expiring-soon" }).map((item) => item.id), ["soon"]);
assert.deepEqual(filterAndSortSignals(filtersFixture, { status: "closed" }).map((item) => item.id).sort(), ["expired", "sl", "tp"]);

const migration = readFileSync("migrations/037_signal_validity.sql", "utf8");
const repository = readFileSync("src/db/repositories.js", "utf8");
const signalService = readFileSync("src/modules/signals/signalService.js", "utf8");
const outcomeService = readFileSync("src/modules/signals/signalOutcomeService.js", "utf8");
const appConfig = readFileSync("src/config/appConfig.js", "utf8");
const paperService = readFileSync("src/modules/paper-trading/paperTradingService.js", "utf8");
const telegramService = readFileSync("src/modules/notifications/notificationService.js", "utf8");
const telegramQueue = readFileSync("src/modules/notifications/notificationQueue.js", "utf8");
const app = readFileSync("public/app.js", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const sw = readFileSync("public/service-worker.js", "utf8");

assert.match(migration, /ADD COLUMN IF NOT EXISTS valid_until/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS expired_at/);
assert.match(migration, /o\.status = 'Expired'[\s\S]*s\.expired_at IS NULL/);
for (const value of ["30 minutes", "2 hours", "6 hours", "24 hours", "48 hours"]) assert.ok(migration.includes(value));
assert.match(repository, /o\.status = 'Active'[\s\S]*s\.valid_until <= now\(\)/);
assert.match(repository, /COALESCE\(o\.status, 'Active'\) = 'Active'[\s\S]*s\.valid_until > now\(\)/);
assert.match(repository, /SET expired_at = COALESCE/);
const unlockTransaction = repository.slice(repository.indexOf("export async function saveUnlockedSignal"), repository.indexOf("export async function listSignalsByUser"));
assert.ok(unlockTransaction.indexOf("if (!signal.validUntil") < unlockTransaction.indexOf("unlock_credits_balance = unlock_credits_balance - 1"));
assert.match(signalService, /assertSignalFresh/);
assert.match(outcomeService, /\[signals\] expired=\$\{expiredSignals\.length\}/);
assert.doesNotMatch(appConfig, /SIGNAL_EXPIRATION_HOURS|expirationHours/);
assert.match(paperService, /function expiredSignalError\(\)[\s\S]*error\.statusCode = 410/);
assert.match(telegramService, /Valid for: \$\{formatSignalValidityWindow/);
assert.match(telegramQueue, /isSignalExpired\(delivery\.payload\)/);
assert.match(app, /This signal has expired and is no longer valid as a fresh setup/);
assert.match(app, /This signal is close to expiring\. Price conditions may have changed/);
assert.match(app, /data-expired-history/);
assert.match(app, /refreshSignalValidityTimers/);
assert.match(css, /\.status-expiring-soon/);
assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.signal-validity/);
assert.match(sw, /"\/signalValidity\.js"/);

const candidateMigration = readFileSync("migrations/032_setup_candidates.sql", "utf8");
assert.match(candidateMigration, /CREATE TABLE IF NOT EXISTS setup_candidates/);
assert.match(candidateMigration, /expires_at/);
assert.doesNotMatch(migration, /ALTER TABLE setup_candidates/);

console.log("Signal validity and expiration tests passed.");

function signal(id, status, validUntil, validityDurationMs) {
  return {
    id,
    symbol: "BTC-USD",
    timeframe: "15m",
    direction: "long",
    status,
    generatedAt: new Date(validUntil - validityDurationMs).toISOString(),
    validUntil: new Date(validUntil).toISOString(),
    validityDurationMs,
    confidenceScore: 80,
    riskRewardRatio: 2
  };
}
