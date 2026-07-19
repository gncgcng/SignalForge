import { getPool, verifyDatabaseConnection } from "../src/db/client.js";
import { runPendingMigrations } from "../src/db/migrations.js";
import { initializeCryptoMarketSettings, listCryptoMarketSettings } from "../src/modules/markets/cryptoMarketService.js";
import { verifyPendingCryptoMarkets } from "../src/modules/markets/cryptoMarketMonitor.js";

const options = parseArgs(process.argv.slice(2));

try {
  await verifyDatabaseConnection();
  await runPendingMigrations();
  await initializeCryptoMarketSettings();

  const before = summarize(listCryptoMarketSettings());
  console.log(`Before:`);
  printSummary(before);
  console.log("");

  const summary = await verifyPendingCryptoMarkets({
    ...options,
    logger: {
      info(message) {
        console.log(String(message));
      },
      warn(message) {
        console.warn(String(message));
      }
    }
  });

  const after = summary.after || summarize(listCryptoMarketSettings());
  const changed = summary.changed || diff(before, after);
  console.log("");
  console.log("After:");
  printSummary(after);
  console.log("");
  console.log("Changed:");
  printChanged(changed);

  if (summary.stillPending > 0) {
    console.warn("Remaining pending markets:");
    for (const market of summary.remainingPending || []) {
      console.warn(`${market.displaySymbol} (${market.providerSymbol}) status=${market.status} verificationStatus=${market.verificationStatus} lastAttempt=${market.lastVerificationAttemptAt || "never"} error=${market.lastError || "none"}`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    await getPool().end();
  } catch {
    // Pool may not exist if DATABASE_URL validation failed.
  }
}

function parseArgs(args) {
  const parsed = { includeErrors: false, forceResolvePending: false, limit: 0, symbol: "" };
  for (const arg of args) {
    if (arg === "--include-errors") parsed.includeErrors = true;
    else if (arg === "--force-resolve-pending") parsed.forceResolvePending = true;
    else if (arg.startsWith("--limit=")) parsed.limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--symbol=")) parsed.symbol = arg.slice("--symbol=".length);
  }
  return parsed;
}

function summarize(markets) {
  return {
    total: markets.length,
    ready: markets.filter((market) => market.status === "active").length,
    pending: markets.filter((market) => [market.status, market.marketStatus, market.verificationStatus]
      .some((value) => String(value || "").toLowerCase().includes("pending"))).length,
    unavailable: markets.filter((market) => market.status === "unavailable").length,
    providerError: markets.filter((market) => market.status === "provider_error").length,
    legacy: markets.filter((market) => market.status === "legacy").length,
    disabled: markets.filter((market) => market.status === "disabled" || market.enabled === false && market.status !== "legacy").length,
    scannerEnabled: markets.filter((market) => market.effectiveScannerEnabled).length,
    paperTradingEnabled: markets.filter((market) => market.effectivePaperTradingEnabled).length
  };
}

function diff(before, after) {
  return Object.fromEntries(["ready", "pending", "unavailable", "providerError", "legacy", "disabled"].map((key) => [
    key,
    Number(after[key] || 0) - Number(before[key] || 0)
  ]));
}

function printSummary(summary) {
  console.log(`Total: ${summary.total}`);
  console.log(`Active: ${summary.ready}`);
  console.log(`Pending-like rows: ${summary.pending}`);
  console.log(`Unavailable: ${summary.unavailable}`);
  console.log(`Provider error: ${summary.providerError}`);
  console.log(`Legacy: ${summary.legacy}`);
  console.log(`Disabled: ${summary.disabled}`);
  console.log(`Scanner enabled: ${summary.scannerEnabled}`);
  console.log(`Paper trading enabled: ${summary.paperTradingEnabled}`);
}

function printChanged(changed) {
  for (const key of ["ready", "pending", "unavailable", "providerError", "legacy", "disabled"]) {
    const value = Number(changed[key] || 0);
    console.log(`${key}: ${value >= 0 ? "+" : ""}${value}`);
  }
}
