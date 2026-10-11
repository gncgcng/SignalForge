// The auto-scan canary can no longer silently disable auto-scanning: empty values are unset, canary mode needs
// AUTO_SCAN_MODE=canary, any bad canary configuration logs an ERROR and runs the full scan, and a heartbeat warns
// when no cycle has completed for 30 minutes. Mocked DB and candles; no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

// ---------- configuration resolution (pure) ----------
const { resolveScheduledAutoScanScope } = await import("../src/modules/alerts/autoScanService.js");
const resolve = (mode, canary) => resolveScheduledAutoScanScope({ mode, canary: { userId: "", symbol: "", symbols: "", timeframe: "", ...canary } });
const FULL_SCAN = { scopes: undefined, listMode: false, error: null };

await check("no canary values, or only empty/whitespace ones: plain full scan, no error", () => {
  assert.deepEqual(resolve("full", {}), FULL_SCAN);
  assert.deepEqual(resolve("full", { userId: "  ", symbol: "", symbols: " ", timeframe: "" }), FULL_SCAN);
  assert.deepEqual(resolve("", {}), FULL_SCAN, "an empty AUTO_SCAN_MODE means full");
});
await check("canary values without AUTO_SCAN_MODE=canary: full scan plus an ERROR (the 2026-09-28 situation)", () => {
  const partial = resolve("full", { userId: "user-a", symbol: "BTC-USD" });
  assert.equal(partial.scopes, undefined);
  assert.match(partial.error, /^\[crypto-watch\] ERROR AUTO_SCAN_CANARY_\* is set but AUTO_SCAN_MODE is not canary; running the full scan instead$/);
  assert.equal(resolve("full", { userId: "user-a", symbol: "BTC-USD", timeframe: "15m" }).scopes, undefined, "even a complete canary needs the mode");
});
await check("AUTO_SCAN_MODE=canary with a bad configuration: full scan plus an ERROR naming the problem", () => {
  for (const [canary, problem] of [
    [{ userId: "user-a", symbol: "BTC-USD" }, /canary configuration incomplete/],
    [{ userId: "user-a", timeframe: "15m" }, /canary configuration incomplete/],
    [{ userId: "user-a", symbol: "BTC-USD", symbols: "ETH-USD", timeframe: "15m" }, /symbol configuration conflicts/],
    [{ userId: "user-a", symbol: "BTC-USD", timeframe: "2h" }, /canary timeframe invalid \(2h\)/],
    [{ userId: "user-a", symbols: "BTC-USD,,ETH-USD", timeframe: "15m" }, /symbol list empty or invalid/],
    [{ userId: "user-a", symbols: Array.from({ length: 11 }, (_, index) => `C${index}-USD`).join(","), timeframe: "15m" }, /symbol limit exceeded \(11\/10\)/]
  ]) {
    const result = resolve("canary", canary);
    assert.equal(result.scopes, undefined);
    assert.match(result.error, problem);
    assert.match(result.error, /running the full scan instead$/);
  }
  assert.match(resolve("canery", {}).error, /AUTO_SCAN_MODE=canery is not "full" or "canary"/);
});
await check("AUTO_SCAN_MODE=canary with a complete configuration: the canary scope (single symbol or list)", () => {
  assert.deepEqual(resolve("canary", { userId: " user-a ", symbol: "btc-usd", timeframe: "15M" }),
    { scopes: [{ userId: "user-a", symbol: "BTC-USD", timeframe: "15m" }], listMode: false, error: null });
  const list = resolve("canary", { userId: "user-a", symbols: "btc-usd, ETH-USD,BTC-USD", timeframe: "1h" });
  assert.deepEqual([list.listMode, list.scopes.map((scope) => scope.symbol)], [true, ["BTC-USD", "ETH-USD"]]);
});

// ---------- the real scheduler, one process per environment ----------
function scenario(env, argument = "cycle") {
  const child = spawnSync(process.execPath, ["--import", "./scripts/register-admin-disabled-group-block-loader.js", "./scripts/auto-scan-canary-hardening-scenario.js", argument], {
    env: { ...cleanEnv(), ...env },
    encoding: "utf8",
    timeout: 120000
  });
  const line = String(child.stdout || "").trim().split("\n").filter((entry) => entry.startsWith("{")).at(-1);
  assert.ok(line, `scenario produced no result: ${String(child.stderr || "").slice(-800)}`);
  return JSON.parse(line);
}
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AUTO_SCAN_CANARY_") || key === "AUTO_SCAN_MODE") delete env[key];
  return env;
}
const CANARY_ETH = { AUTO_SCAN_CANARY_USER_ID: "user-a", AUTO_SCAN_CANARY_SYMBOL: "ETH-USD", AUTO_SCAN_CANARY_TIMEFRAME: "15m" };

await check("scheduler: empty canary values run the full scan (both watched pairs) with no error", () => {
  const result = scenario({ AUTO_SCAN_CANARY_USER_ID: "", AUTO_SCAN_CANARY_SYMBOL: "", AUTO_SCAN_CANARY_TIMEFRAME: "" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual([result.timeouts, result.intervals], [[1000], [300000, 300000]], "scan cycle scheduled, plus the 5-minute heartbeat check");
  assert.match(result.startedLine, /mode=full/);
  assert.deepEqual(result.generatedPairs, ["BTC-USD", "ETH-USD"]);
  assert.equal(result.health.mode, "full");
});
await check("scheduler: a partial canary logs an ERROR and still runs the full scan", () => {
  const result = scenario({ AUTO_SCAN_CANARY_USER_ID: "user-a", AUTO_SCAN_CANARY_SYMBOL: "ETH-USD" });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /\[crypto-watch\] ERROR .*running the full scan instead/);
  assert.deepEqual(result.generatedPairs, ["BTC-USD", "ETH-USD"]);
  assert.equal(result.health.configurationError, result.errors[0], "the error is visible in the admin health view");
  const partialCanaryMode = scenario({ AUTO_SCAN_MODE: "canary", AUTO_SCAN_CANARY_USER_ID: "user-a", AUTO_SCAN_CANARY_SYMBOL: "ETH-USD" });
  assert.match(partialCanaryMode.errors[0], /canary configuration incomplete/);
  assert.deepEqual(partialCanaryMode.generatedPairs, ["BTC-USD", "ETH-USD"]);
});
await check("scheduler: AUTO_SCAN_MODE=canary with a complete configuration scans only the canary scope", () => {
  const result = scenario({ AUTO_SCAN_MODE: "canary", ...CANARY_ETH });
  assert.deepEqual(result.errors, []);
  assert.match(result.startedLine, /mode=canary/);
  assert.deepEqual(result.generatedPairs, ["ETH-USD"]);
  assert.equal(result.health.mode, "canary");
  assert.ok(result.health.lastCompletedCycleAt, "the completed cycle is recorded");
  assert.equal(result.heartbeatAfterCycle.warned, false, "a cycle 10 minutes ago keeps the heartbeat quiet");
});
await check("heartbeat: quiet until 30 minutes without a completed cycle, then one warning per 30 minutes, visible as stale", () => {
  const result = scenario({}, "heartbeat");
  assert.deepEqual(result.heartbeat.map((entry) => [entry.minutes, entry.warned]), [[29, false], [31, true], [45, false], [62, true]]);
  assert.match(result.heartbeat[1].warning, /\[auto-scan\] heartbeat: no auto-scan cycle completed in 31 minutes \(last completed never; last error none\)/);
  assert.deepEqual([result.healthAt31.stale, result.healthAt31.schedulerRunning, result.healthAt31.lastCompletedCycleAt], [true, true, null]);
});

console.log(`Auto-scan canary hardening tests passed (${passed.length} checks):\n${passed.map((name) => `  ok ${name}`).join("\n")}`);
