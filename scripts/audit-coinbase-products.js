import { getPool, verifyDatabaseConnection } from "../src/db/client.js";
import { runPendingMigrations } from "../src/db/migrations.js";
import { getProductsFromCoinbase } from "../src/modules/market-data/coinbaseMarketDataProvider.js";
import { initializeCryptoMarketSettings, listCryptoMarketSettings, normalizeCoinbaseProducts } from "../src/modules/markets/cryptoMarketService.js";

try {
  const products = await getProductsFromCoinbase();
  const coinbaseUsd = normalizeCoinbaseProducts(products);

  await verifyDatabaseConnection();
  await runPendingMigrations();
  await initializeCryptoMarketSettings();

  const markets = listCryptoMarketSettings();
  const dbSymbols = new Set(markets.map((market) => market.providerSymbol));
  const coinbaseSymbols = new Set(coinbaseUsd.map((product) => product.providerSymbol));
  const missingFromDb = coinbaseUsd.filter((product) => !dbSymbols.has(product.providerSymbol));
  const notFoundOnCoinbase = markets.filter((market) => !coinbaseSymbols.has(market.providerSymbol));

  console.log("Coinbase product audit");
  console.log(`Coinbase total products: ${products.length}`);
  console.log(`Coinbase USD crypto products: ${coinbaseUsd.length}`);
  console.log(`SignalForge crypto markets: ${markets.length}`);
  console.log(`Missing from DB: ${missingFromDb.length}`);
  console.log(`DB pairs not found on Coinbase: ${notFoundOnCoinbase.length}`);
  console.log("");
  console.log("Missing Coinbase USD pairs not in DB:");
  console.log(missingFromDb.slice(0, 100).map((product) => product.providerSymbol).join(", ") || "None");
  console.log("");
  console.log("DB pairs not found on Coinbase:");
  console.log(notFoundOnCoinbase.slice(0, 100).map((market) => market.providerSymbol).join(", ") || "None");
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
