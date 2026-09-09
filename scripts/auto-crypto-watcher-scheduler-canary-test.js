import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSmokeScope } from "./run-auto-crypto-watcher-smoke.js";

const loader = new URL("./register-auto-crypto-watcher-e2e-loader.js", import.meta.url).href;
const scenarioScript = fileURLToPath(new URL("./auto-crypto-watcher-scheduler-canary-scenario.js", import.meta.url));
const cases = [
  { name: "disabled", env: { CRYPTO_WATCHER_ENABLED: "false", AUTO_SCAN_ENABLED: "true" } },
  { name: "auto-disabled", env: { CRYPTO_WATCHER_ENABLED: "true", AUTO_SCAN_ENABLED: "false" } },
  { name: "broad", env: { CRYPTO_WATCHER_ENABLED: "true", AUTO_SCAN_ENABLED: "true" } },
  {
    name: "canary",
    env: {
      CRYPTO_WATCHER_ENABLED: "true",
      AUTO_SCAN_ENABLED: "true",
      AUTO_SCAN_CANARY_USER_ID: "user-a",
      AUTO_SCAN_CANARY_SYMBOL: " btc-usd ",
      AUTO_SCAN_CANARY_TIMEFRAME: "15M"
    }
  },
  {
    name: "partial",
    env: {
      CRYPTO_WATCHER_ENABLED: "true",
      AUTO_SCAN_ENABLED: "true",
      AUTO_SCAN_CANARY_USER_ID: "user-a",
      AUTO_SCAN_CANARY_SYMBOL: "BTC-USD"
    }
  },
  {
    name: "empty",
    env: {
      CRYPTO_WATCHER_ENABLED: "true",
      AUTO_SCAN_ENABLED: "true",
      AUTO_SCAN_CANARY_USER_ID: "",
      AUTO_SCAN_CANARY_SYMBOL: "",
      AUTO_SCAN_CANARY_TIMEFRAME: ""
    }
  },
  {
    name: "invalid",
    env: {
      CRYPTO_WATCHER_ENABLED: "true",
      AUTO_SCAN_ENABLED: "true",
      AUTO_SCAN_CANARY_USER_ID: "user-a",
      AUTO_SCAN_CANARY_SYMBOL: "BTC-USD",
      AUTO_SCAN_CANARY_TIMEFRAME: "2h"
    }
  },
  {
    name: "overlap",
    env: {
      CRYPTO_WATCHER_ENABLED: "true",
      AUTO_SCAN_ENABLED: "true",
      AUTO_SCAN_CANARY_USER_ID: "user-a",
      AUTO_SCAN_CANARY_SYMBOL: "BTC-USD",
      AUTO_SCAN_CANARY_TIMEFRAME: "15m"
    }
  }
];

const results = {};
for (const testCase of cases) results[testCase.name] = runScenario(testCase);

assert.equal(results.disabled.scheduled, false);
assert.equal(results["auto-disabled"].scheduled, false);
assert.equal(results.broad.scheduled, true);
assert.ok(results.broad.users.includes("user-a") && results.broad.users.includes("user-b"));
assert.ok(results.broad.providerContextSymbols.includes("BTC-USD") && results.broad.providerContextSymbols.includes("ETH-USD"));
assert.equal(results.broad.marketBriefRefreshed, true);
assert.deepEqual(results.canary.users, ["user-a"]);
assert.deepEqual(results.canary.generatedScopes, ["BTC-USD:15m"]);
assert.deepEqual(results.canary.candidateScopes, ["BTC-USD:15m"]);
assert.deepEqual(results.canary.queuedUsers, ["user-a"]);
assert.equal(results.canary.marketBriefRefreshed, false);
assert.equal(results.partial.failedClosed, "incomplete");
assert.equal(results.empty.failedClosed, "empty");
assert.equal(results.invalid.failedClosed, "invalid_timeframe");
assert.equal(results.overlap.overlapSkipped, true);
assert.deepEqual(
  parseSmokeScope(["--symbol", "btc-usd", "--timeframe", "15M", "--user-id", "user-a"]),
  { symbol: "BTC-USD", timeframe: "15m", userId: "user-a" }
);

console.log(JSON.stringify({
  tests: { passed: 13, failed: 0 },
  disabledFlagsScheduleNothing: {
    cryptoWatcherDisabled: true,
    autoScanDisabled: true
  },
  unconfiguredPreservesBroadMode: results.broad,
  configuredCanaryIsExact: results.canary,
  partialConfigurationFailsClosed: true,
  blankConfigurationFailsClosed: true,
  invalidTimeframeFailsClosed: true,
  overlappingCycleSkipped: true,
  scopedMarketBriefSkipped: true,
  smokeScopeUnchanged: true
}, null, 2));

function runScenario(testCase) {
  const env = {
    ...process.env,
    MARKET_VERIFICATION_ENABLED: "false",
    CANDIDATE_SCAN_MARKETS_PER_CYCLE: "1",
    TELEGRAM_BOT_TOKEN: "fixture-token",
    ...testCase.env
  };
  for (const key of ["AUTO_SCAN_CANARY_USER_ID", "AUTO_SCAN_CANARY_SYMBOL", "AUTO_SCAN_CANARY_TIMEFRAME"]) {
    if (!(key in testCase.env)) delete env[key];
  }
  const child = spawnSync(process.execPath, ["--import", loader, scenarioScript, testCase.name], {
    env,
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(child.status, 0, `${testCase.name} failed:\n${child.stdout}\n${child.stderr}`);
  const line = child.stdout.split(/\r?\n/).find((value) => value.startsWith("SCHEDULER_CANARY_RESULT="));
  assert.ok(line, `${testCase.name} did not report a result:\n${child.stdout}`);
  return JSON.parse(line.slice("SCHEDULER_CANARY_RESULT=".length)).result;
}
