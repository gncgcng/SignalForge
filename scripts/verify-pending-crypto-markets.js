import { getPool, verifyDatabaseConnection } from "../src/db/client.js";
import { runPendingMigrations } from "../src/db/migrations.js";
import { initializeCryptoMarketSettings, listCryptoMarketSettings } from "../src/modules/markets/cryptoMarketService.js";
import { verifyPendingCryptoMarkets } from "../src/modules/markets/cryptoMarketMonitor.js";

try {
  await verifyDatabaseConnection();
  await runPendingMigrations();
  await initializeCryptoMarketSettings();

  const beforePending = listCryptoMarketSettings().filter((market) => {
    const values = [market.marketStatus, market.verificationStatus, market.statusLabel]
      .map((value) => String(value || "").trim().toLowerCase());
    return market.enabled !== false && values.some((value) =>
      ["pending", "pending verification", "unverified", "unknown"].includes(value)
    );
  }).length;
  console.log(`Before:`);
  console.log(`Pending markets: ${beforePending}`);
  console.log("");

  const summary = await verifyPendingCryptoMarkets({
    logger: {
      info(message) {
        console.log(String(message));
      },
      warn(message) {
        console.warn(String(message));
      }
    }
  });

  console.log("");
  console.log("After:");
  console.log(`Ready: ${summary.ready}`);
  console.log(`Unavailable: ${summary.unavailable}`);
  console.log(`Provider error: ${summary.providerError}`);
  console.log(`Legacy: ${summary.legacy}`);
  console.log(`Still pending: ${summary.stillPending}`);

  if (summary.stillPending > 0) {
    console.warn("Warning: Some markets are still pending. Re-run the script or inspect DB rows with verificationStatus pending.");
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
