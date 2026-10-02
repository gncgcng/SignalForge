import "./test-support/require-local-database.js"; // must stay first: refuses non-local DATABASE_URL
// Generic `markets` table (migration 059) on a real local Postgres:
// 1. Runs 059 against a copy of the production crypto_markets shape inside an isolated schema in a
//    rolled-back transaction: every crypto row is copied with its operational state, commodity/stock entries are
//    seeded with the right asset_class and provider symbol, re-running is a no-op, and the
//    transitional mirror trigger keeps crypto_markets in sync without ever failing a primary write.
// 2. Against the migrated database: the runtime registry loads from the table, Twelve Data requests
//    use markets.provider_symbol, and markets.scanner_enabled gates commodity scanning.
// 3. Static guards: nothing in src/ reads crypto_markets or keeps its own commodity symbol list.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.TWELVEDATA_API_KEY = "markets-registry-test-key";

const { query, getPool } = await import("../src/db/client.js");
const { runPendingMigrations } = await import("../src/db/migrations.js");
const { loadMarketRegistry, getNonCryptoMarket, resetMarketRegistryForTest } = await import("../src/modules/markets/marketRegistry.js");
const { getManualScannerUniverse, getPair, getOhlcv } = await import("../src/modules/market-data/marketDataService.js");
// Closed markets are skipped from the scan universe; pin a Wednesday so commodities are in session.
(await import("../src/modules/markets/sessionService.js")).setSessionClockForTest("2026-01-14T15:00:00Z");

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const migration = (name) => readFileSync(join(rootDir, "migrations", name), "utf8");
const results = {};

// ---------------------------------------------------------------- 1. migration replay (isolated)
{
  const client = await getPool().connect();
  const schema = `markets_test_${Date.now().toString(36)}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    // The production crypto_markets shape (044-048 applied), with every column, default, CHECK and
    // UNIQUE constraint. Replaying 044-048 here is not possible: 048 probes pg_constraint by name
    // without a schema filter and would see public.crypto_markets.
    await client.query(`CREATE TABLE ${schema}.crypto_markets (LIKE public.crypto_markets INCLUDING ALL)`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(`INSERT INTO crypto_markets (symbol, display_symbol, provider_symbol, name, liquidity_tier,
        enabled, scanner_enabled, provider_status, supported_timeframes, unsupported_timeframes,
        last_successful_candle_at, failure_code, cooldown_until, consecutive_failures, market_status,
        verification_status, status, verification_details, base_asset, quote_asset)
      VALUES
        ('BTC-USD','BTCUSD','BTC-USD','Bitcoin','major',true,true,'available','{5m,15m,1h,4h}','{}',
          '2026-09-30T12:00:00Z',NULL,NULL,0,'active','verified','active','{"finalStatus":"active"}','BTC','USD'),
        ('AUDIO-USD','AUDIOUSD','AUDIO-USD','Audius','standard',true,false,'unavailable','{}','{5m,15m,1h,4h}',
          NULL,'EMPTY_CANDLES','2026-10-03T00:00:00Z',3,'unavailable','failed','unavailable','{"lastError":"x"}','AUDIO','USD'),
        ('MATIC-USD','MATICUSD','MATIC-USD','Polygon (legacy)','standard',false,false,'unavailable','{}','{}',
          NULL,'LEGACY_MARKET',NULL,0,'legacy','legacy','legacy','{}','MATIC','USD')`);
    await client.query(migration("059_markets.sql"));

    const byClass = Object.fromEntries((await client.query(
      "SELECT asset_class, count(*)::int AS n FROM markets GROUP BY asset_class")).rows.map((r) => [r.asset_class, r.n]));
    const mismatched = (await client.query(`SELECT c.symbol FROM crypto_markets c
      LEFT JOIN markets m ON m.symbol = c.symbol
      WHERE m.id IS DISTINCT FROM 'crypto:' || c.symbol OR m.asset_class <> 'crypto'
        OR m.provider_symbol <> c.provider_symbol OR m.status <> c.status OR m.market_status <> c.market_status
        OR m.verification_status <> c.verification_status OR m.enabled <> c.enabled
        OR m.scanner_enabled <> c.scanner_enabled OR m.supported_timeframes <> c.supported_timeframes
        OR m.unsupported_timeframes <> c.unsupported_timeframes OR m.failure_code IS DISTINCT FROM c.failure_code
        OR m.cooldown_until IS DISTINCT FROM c.cooldown_until OR m.consecutive_failures <> c.consecutive_failures
        OR m.last_successful_candle_at IS DISTINCT FROM c.last_successful_candle_at
        OR m.verification_details <> c.verification_details OR m.liquidity_tier IS DISTINCT FROM c.liquidity_tier
        OR m.session_calendar_id IS NOT NULL OR m.exchange_timezone IS NOT NULL`)).rows;
    const seeded = Object.fromEntries((await client.query(
      "SELECT symbol, asset_class, provider, provider_symbol, scanner_enabled FROM markets WHERE asset_class <> 'crypto'"
    )).rows.map((r) => [r.symbol, r]));

    await client.query(migration("059_markets.sql"));
    const afterRerun = (await client.query("SELECT count(*)::int AS n FROM markets")).rows[0].n;

    await client.query("UPDATE markets SET consecutive_failures = 42, last_error = 'mirror' WHERE symbol = 'BTC-USD'");
    const mirrored = (await client.query("SELECT consecutive_failures, last_error FROM crypto_markets WHERE symbol = 'BTC-USD'")).rows[0];
    await client.query(`INSERT INTO markets (id, symbol, asset_class, provider, provider_symbol, name, display_symbol, liquidity_tier)
      VALUES ('crypto:NEW-USD', 'NEW-USD', 'crypto', 'coinbase-exchange', 'NEW-USD', 'New', 'NEWUSD', 'standard')`);
    const mirroredInsert = (await client.query("SELECT count(*)::int AS n FROM crypto_markets WHERE symbol = 'NEW-USD'")).rows[0].n;
    // crypto_markets.provider_symbol is UNIQUE on its own, so this row cannot be mirrored.
    await client.query(`INSERT INTO markets (id, symbol, asset_class, provider, provider_symbol, name, display_symbol)
      VALUES ('crypto:BTC2-USD', 'BTC2-USD', 'crypto', 'another-exchange', 'BTC-USD', 'Clash', 'BTC2USD')`);
    const primarySurvived = (await client.query("SELECT count(*)::int AS n FROM markets WHERE symbol = 'BTC2-USD'")).rows[0].n;
    await client.query("UPDATE markets SET name = 'Gold (probe)' WHERE symbol = 'XAU/USD'");
    const commodityLeaked = (await client.query("SELECT count(*)::int AS n FROM crypto_markets WHERE symbol = 'XAU/USD'")).rows[0].n;

    results.migration = {
      assetClassCounts: byClass.crypto === 3 && byClass.commodity === 5 && byClass.stock === 4,
      cryptoStateCopiedExactly: mismatched.length === 0 || mismatched,
      commodityProviderSymbols: seeded.WTI?.provider_symbol === "XTI/USD" && seeded.BRENT?.provider_symbol === "XBR/USD" &&
        seeded.NATGAS?.provider_symbol === "XNG/USD" && seeded["XAU/USD"]?.provider === "twelve-data",
      stocksHaveNoProvider: ["NVDA", "TSLA", "AAPL", "SPY"].every((s) => seeded[s]?.provider === "none" && seeded[s]?.scanner_enabled === false),
      rerunIsNoOp: afterRerun === 12,
      mirrorPropagatesUpdate: mirrored.consecutive_failures === 42 && mirrored.last_error === "mirror",
      mirrorPropagatesInsert: mirroredInsert === 1,
      mirrorFailureNeverBlocksPrimary: primarySurvived === 1,
      mirrorIgnoresNonCrypto: commodityLeaked === 0
    };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

// ---------------------------------------------------------------- 2. live database registry
await runPendingMigrations();
const realFetch = globalThis.fetch;
const requestedSymbols = [];
globalThis.fetch = async (url) => {
  const requestUrl = new URL(url);
  requestedSymbols.push(requestUrl.searchParams.get("symbol"));
  const values = Array.from({ length: 120 }, (_, index) => {
    const price = 70 + index * 0.05;
    return {
      datetime: new Date(Date.now() - (120 - index) * 3600_000).toISOString().replace("T", " ").slice(0, 19),
      open: String(price), high: String(price + 0.3), low: String(price - 0.3), close: String(price + 0.1)
    };
  });
  return new Response(JSON.stringify({ status: "ok", values }), { status: 200, headers: { "content-type": "application/json" } });
};

const original = (await query("SELECT provider_symbol, scanner_enabled FROM markets WHERE symbol = 'WTI'")).rows[0];
try {
  await loadMarketRegistry();
  const fromDb = getNonCryptoMarket("WTI");
  await query("UPDATE markets SET provider_symbol = 'XTI/USD:PROBE', scanner_enabled = false WHERE symbol = 'WTI'");
  await loadMarketRegistry();
  await getOhlcv("WTI", "1h");
  const universe = getManualScannerUniverse({ marketType: "commodities" });

  results.registry = {
    loadsFromTable: fromDb?.id === "commodity:WTI" && fromDb.assetClassKey === "commodity",
    pairRoutesToTwelveData: getPair("XAU/USD")?.provider === "twelve-data" && getPair("XAU/USD")?.status === "active",
    stockStaysComingSoon: getPair("NVDA")?.provider === null && getPair("NVDA")?.status === "coming-soon",
    providerSymbolFromDatabase: requestedSymbols.at(-1) === "XTI/USD:PROBE",
    scannerEnabledGatesCommodity: !universe.markets.some((m) => m.symbol === "WTI") &&
      universe.skipped.some((m) => m.symbol === "WTI" && m.reasonCode === "scanner_disabled") &&
      universe.markets.some((m) => m.symbol === "XAU/USD")
  };
} finally {
  await query("UPDATE markets SET provider_symbol = $1, scanner_enabled = $2 WHERE symbol = 'WTI'",
    [original.provider_symbol, original.scanner_enabled]);
  globalThis.fetch = realFetch;
  resetMarketRegistryForTest();
}

// ---------------------------------------------------------------- 3. static guards
const srcFiles = walk(join(rootDir, "src")).filter((file) => file.endsWith(".js"));
const readsLegacyTable = srcFiles.filter((file) => readFileSync(file, "utf8").includes("crypto_markets"));
// correlationService keeps a deliberate cross-asset peer list (crypto + metals + oil), not a catalog.
const commodityListAllowed = new Set(["marketRegistry.js", "correlationService.js"]);
const hardcodedCommodityLists = srcFiles.filter((file) =>
  !commodityListAllowed.has(file.split(/[\\/]/).at(-1)) && /"XAG\/USD"|"NATGAS"|"XBR\/USD"/.test(readFileSync(file, "utf8")));
results.staticGuards = {
  noSourceReadsCryptoMarkets: readsLegacyTable.length === 0 || readsLegacyTable,
  noHardcodedCommodityLists: hardcodedCommodityLists.length === 0 || hardcodedCommodityLists
};

await getPool().end();
console.log(JSON.stringify(results, null, 2));
for (const [group, checks] of Object.entries(results)) {
  for (const [name, value] of Object.entries(checks)) {
    assert.equal(value, true, `${group}.${name} failed: ${JSON.stringify(value)}`);
  }
}
console.log("markets registry checks passed");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
