import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const loader = new URL("./register-auto-crypto-watcher-e2e-loader.js", import.meta.url).href;
const scenarioScript = fileURLToPath(new URL("./auto-crypto-watcher-scheduler-canary-scenario.js", import.meta.url));
const fiveSymbols = "BTC-USD,ETH-USD,SOL-USD,XRP-USD,DOGE-USD";
const base = {
  CRYPTO_WATCHER_ENABLED: "true",
  AUTO_SCAN_ENABLED: "true",
  AUTO_SCAN_CANARY_USER_ID: "user-a",
  AUTO_SCAN_CANARY_TIMEFRAME: "15m",
  CRYPTO_MAX_ACTIVE_SCANNER_PAIRS: "1"
};
const cases = [
  { name: "multi", env: { ...base, AUTO_SCAN_CANARY_SYMBOLS: fiveSymbols } },
  {
    name: "dedupe",
    env: { ...base, AUTO_SCAN_CANARY_SYMBOLS: `${fiveSymbols}, BTC-USD,ETH-USD` }
  },
  {
    name: "multi-invalid",
    env: { ...base, AUTO_SCAN_CANARY_SYMBOLS: "BTC-USD,NOTREAL-USD,ETH-USD" }
  },
  { name: "multi-overlap", env: { ...base, AUTO_SCAN_CANARY_SYMBOLS: fiveSymbols } },
  {
    name: "both-symbol-modes",
    env: { ...base, AUTO_SCAN_CANARY_SYMBOL: "BTC-USD", AUTO_SCAN_CANARY_SYMBOLS: fiveSymbols }
  },
  {
    name: "list-too-many",
    env: {
      ...base,
      AUTO_SCAN_CANARY_SYMBOLS: Array.from({ length: 11 }, (_, index) => `TEST${index + 1}-USD`).join(",")
    }
  },
  {
    name: "list-partial",
    env: {
      CRYPTO_WATCHER_ENABLED: "true",
      AUTO_SCAN_ENABLED: "true",
      AUTO_SCAN_CANARY_USER_ID: "user-a",
      AUTO_SCAN_CANARY_SYMBOLS: fiveSymbols
    }
  },
  { name: "list-empty", env: { ...base, AUTO_SCAN_CANARY_SYMBOLS: "" } }
];

const results = Object.fromEntries(cases.map((testCase) => [testCase.name, runScenario(testCase)]));
const expectedScopes = fiveSymbols.split(",").map((symbol) => `${symbol}:15m`);

assert.equal(results.multi.requestedSymbols, 5);
assert.equal(results.multi.scannedSymbols, 5);
assert.deepEqual(results.multi.users, ["user-a"]);
assert.deepEqual(results.multi.generatedScopes, expectedScopes);
assert.deepEqual(results.multi.candidateScopes, expectedScopes);
assert.deepEqual(results.multi.queuedUsers, ["user-a"]);
assert.equal(results.multi.marketBriefRefreshed, false);
assert.equal(results.dedupe.requestedSymbols, 5);
assert.equal(results.dedupe.scannedSymbols, 5);
assert.deepEqual(results.dedupe.generatedScopes, expectedScopes);
assert.equal(results["multi-invalid"].requestedSymbols, 3);
assert.equal(results["multi-invalid"].scannedSymbols, 2);
assert.deepEqual(results["multi-invalid"].generatedScopes, ["BTC-USD:15m", "ETH-USD:15m"]);
assert.deepEqual(results["multi-invalid"].skippedSymbols, ["NOTREAL-USD"]);
assert.equal(results["multi-overlap"].overlapSkipped, true);
assert.equal(results["multi-overlap"].requestedSymbols, 5);
assert.equal(results["multi-overlap"].scannedSymbols, 5);
assert.equal(results["both-symbol-modes"].failedClosed, "symbol_conflict");
assert.equal(results["list-too-many"].failedClosed, "symbol_limit");
assert.equal(results["list-partial"].failedClosed, "incomplete");
assert.equal(results["list-empty"].failedClosed, "empty_symbol_list");

console.log(JSON.stringify({
  tests: { passed: 15, failed: 0 },
  exactFiveSymbolCycle: results.multi,
  duplicateInputDeduped: results.dedupe,
  invalidSymbolIsolated: results["multi-invalid"],
  overlapProtectedForWholeCycle: results["multi-overlap"].overlapSkipped,
  configurationFailures: {
    bothSymbolModes: results["both-symbol-modes"].failedClosed,
    overLimit: results["list-too-many"].failedClosed,
    partial: results["list-partial"].failedClosed,
    empty: results["list-empty"].failedClosed
  }
}, null, 2));

function runScenario(testCase) {
  const env = {
    ...process.env,
    MARKET_VERIFICATION_ENABLED: "false",
    CANDIDATE_SCAN_MARKETS_PER_CYCLE: "1",
    TELEGRAM_BOT_TOKEN: "fixture-token",
    ...testCase.env
  };
  for (const key of ["AUTO_SCAN_CANARY_USER_ID", "AUTO_SCAN_CANARY_SYMBOL", "AUTO_SCAN_CANARY_SYMBOLS", "AUTO_SCAN_CANARY_TIMEFRAME"]) {
    if (!(key in testCase.env)) delete env[key];
  }
  const child = spawnSync(process.execPath, ["--import", loader, scenarioScript, testCase.name], {
    env,
    encoding: "utf8",
    timeout: 60_000
  });
  assert.equal(child.status, 0, `${testCase.name} failed:\n${child.stdout}\n${child.stderr}`);
  const line = child.stdout.split(/\r?\n/).find((value) => value.startsWith("SCHEDULER_CANARY_RESULT="));
  assert.ok(line, `${testCase.name} did not report a result:\n${child.stdout}`);
  return JSON.parse(line.slice("SCHEDULER_CANARY_RESULT=".length)).result;
}
