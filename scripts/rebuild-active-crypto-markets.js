import { getPool, verifyDatabaseConnection } from "../src/db/client.js";
import { runPendingMigrations } from "../src/db/migrations.js";
import { initializeCryptoMarketSettings } from "../src/modules/markets/cryptoMarketService.js";
import { rebuildActiveCryptoMarkets } from "../src/modules/markets/cryptoMarketRebuildService.js";

try {
  await verifyDatabaseConnection();
  await runPendingMigrations();
  await initializeCryptoMarketSettings();

  const summary = await rebuildActiveCryptoMarkets({
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
  console.log(`Coinbase USD crypto products found: ${summary.usdCryptoProducts}`);
  console.log(`Active markets with candles: ${summary.active}`);
  console.log(`Unavailable/no candles: ${summary.unavailable}`);
  console.log(`Provider error: ${summary.providerError}`);
  console.log(`Legacy/removed: ${summary.legacy}`);
  console.log(`Disabled preserved: ${summary.disabledPreserved}`);
  console.log(`Total discovered: ${summary.totalDiscovered}`);
  console.log("");
  console.log("First unavailable examples:");
  if (!summary.unavailableExamples.length) {
    console.log("None");
  }
  for (const example of summary.unavailableExamples) {
    console.log(`${example.providerSymbol} ${example.status}: product_found=${example.productFound ? "yes" : "no"} candle_test=${example.candleTestResult} reason=${example.reason}`);
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
