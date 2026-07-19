import { getPool, verifyDatabaseConnection } from "../src/db/client.js";
import { runPendingMigrations } from "../src/db/migrations.js";
import { initializeCryptoMarketSettings, listCryptoMarketSettings } from "../src/modules/markets/cryptoMarketService.js";

try {
  await verifyDatabaseConnection();
  await runPendingMigrations();
  await initializeCryptoMarketSettings();

  const markets = listCryptoMarketSettings();
  const counts = summarize(markets);
  console.log("Crypto market verification audit");
  console.log(`Total crypto markets: ${counts.total}`);
  console.log(`Active markets: ${counts.active}`);
  console.log(`Legacy pending-like rows: ${counts.pendingLike}`);
  console.log(`Unavailable markets: ${counts.unavailable}`);
  console.log(`Provider error markets: ${counts.providerError}`);
  console.log(`Legacy markets: ${counts.legacy}`);
  console.log(`Disabled markets: ${counts.disabled}`);
  console.log(`Scanner enabled: ${counts.scannerEnabled}`);
  console.log(`Paper trading enabled: ${counts.paperTradingEnabled}`);
  console.log("");
  console.log("First 50 pending-like rows:");

  const pending = markets.filter(isPendingLike).slice(0, 50);
  if (!pending.length) {
    console.log("None");
  }

  for (const market of pending) {
    console.log([
      market.displaySymbol,
      `provider=${market.providerSymbol}`,
      `status=${market.status}`,
      `marketStatus=${market.marketStatus}`,
      `verificationStatus=${market.verificationStatus}`,
      `lastVerifiedAt=${market.lastVerifiedAt || "never"}`,
      `lastVerificationAttemptAt=${market.lastVerificationAttemptAt || "never"}`,
      `lastError=${market.lastError || "none"}`
    ].join(" | "));
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

function summarize(markets) {
  return {
    total: markets.length,
    active: markets.filter((market) => market.status === "active").length,
    pendingLike: markets.filter(isPendingLike).length,
    unavailable: markets.filter((market) => market.status === "unavailable").length,
    providerError: markets.filter((market) => market.status === "provider_error").length,
    legacy: markets.filter((market) => market.status === "legacy").length,
    disabled: markets.filter((market) => market.status === "disabled" || market.enabled === false && market.status !== "legacy").length,
    scannerEnabled: markets.filter((market) => market.effectiveScannerEnabled).length,
    paperTradingEnabled: markets.filter((market) => market.effectivePaperTradingEnabled).length
  };
}

function isPendingLike(market) {
  return [market.status, market.marketStatus, market.verificationStatus]
    .some((value) => String(value || "").toLowerCase().includes("pending"));
}
