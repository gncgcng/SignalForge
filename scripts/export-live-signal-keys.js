// Disposable, read-only export for the replay harness fidelity check. Prints JSON on stdout:
//   - signals: live generated_signals keys (setup_key, symbol, timeframe, direction, strategy, created_at, status,
//     source) created in the last --days days, current engine only. No ids, no user data.
//   - scannerReadyPairs: the production scanner-ready crypto pairs, from the app's own listScannerCryptoMarkets.
//   - adminDisabled: disabled_by_admin override rows (group_key, updated_at), to explain signals live suppressed.
// Every session is forced read-only (default_transaction_read_only=on) before any app module connects.
//
// Runs from the repo or pasted standalone into /tmp inside the Railway container (loads /app; APP_ROOT overrides).
//
//   node scripts/export-live-signal-keys.js [--days 75] > live-signal-keys.json
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const MARKETS_MODULE = "src/modules/markets/cryptoMarketService.js";
const APP_ROOT = process.env.APP_ROOT || (existsSync(join(scriptDirectory, "..", MARKETS_MODULE)) ? join(scriptDirectory, "..") : "/app");

const daysIndex = process.argv.indexOf("--days");
const days = daysIndex >= 0 ? Number(process.argv[daysIndex + 1]) : 75;
if (!Number.isInteger(days) || days < 1 || days > 400) {
  console.error("--days must be a whole number between 1 and 400.");
  process.exit(1);
}
const rawUrl = String(process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || "").trim();
if (!rawUrl) {
  console.error("Export failed: DATABASE_URL is required.");
  process.exit(1);
}
const readOnlyUrl = new URL(rawUrl);
readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
process.env.DATABASE_URL = readOnlyUrl.toString();

// stdout carries only the JSON; app logging goes to stderr.
for (const method of ["log", "info", "warn", "debug"]) console[method] = (...args) => process.stderr.write(`${args.join(" ")}\n`);

try {
  const appModule = (path) => import(pathToFileURL(join(APP_ROOT, path)).href);
  const { query } = await appModule("src/db/client.js");
  const { reloadCryptoMarketSettings, listScannerCryptoMarkets } = await appModule(MARKETS_MODULE);

  const signals = (await query(`
    SELECT setup_key, pair AS symbol, timeframe, direction, strategy, created_at, status, source
    FROM generated_signals
    WHERE created_at >= now() - ($1::integer * interval '1 day')
      AND source NOT IN ('legacy_saved_signal', 'legacy_unlocked_signal', 'backtest_shadow', 'admin_test')
    ORDER BY created_at ASC
  `, [days])).rows;
  await reloadCryptoMarketSettings();
  // With the liquidity ranking deployed, load stored 24h volumes so listScannerCryptoMarkets ranks as the app does.
  let liquidity = null;
  try {
    liquidity = await appModule("src/modules/markets/marketLiquidityService.js");
    await liquidity.loadMarketLiquidity();
  } catch (error) {
    console.warn(`liquidity ranking unavailable: ${error.message}`);
    liquidity = null;
  }
  const scannerReadyPairs = listScannerCryptoMarkets().map((market) => ({
    symbol: market.symbol,
    liquidityTier: market.liquidityTier || null,
    scannerTimeframes: market.scannerTimeframes || market.supportedTimeframes || null,
    volume24hUsd: liquidity?.getMarketLiquidity(market.symbol)?.volume24hUsd ?? null
  }));
  const adminDisabled = (await query(`
    SELECT group_key, updated_at FROM signal_strategy_statuses WHERE status = 'disabled_by_admin' ORDER BY updated_at
  `)).rows;

  // Per-scan evidence for the fidelity check: every record that proves a pair/timeframe was scanned at a time.
  // Each query is independent; a failure is reported in evidenceErrors instead of failing the export.
  const evidenceErrors = {};
  const evidence = async (name, sql) => {
    try {
      return (await query(sql, [days])).rows;
    } catch (error) {
      evidenceErrors[name] = error.message;
      return [];
    }
  };
  const since = "now() - ($1::integer * interval '1 day')";
  const scanEvidence = {
    analyticsScans: await evidence("analyticsScans", `SELECT symbol, timeframe, created_at, metadata->>'mode' AS mode,
      COALESCE((metadata->>'cached')::boolean, false) AS cached
      FROM product_analytics_events WHERE event_type = 'scan' AND symbol IS NOT NULL AND timeframe IS NOT NULL AND created_at >= ${since}`),
    validationRejections: await evidence("validationRejections", `SELECT symbol, timeframe, source, created_at
      FROM signal_validation_rejections WHERE created_at >= ${since}`),
    candidates: await evidence("candidates", `SELECT symbol, timeframe, first_detected_at, last_checked_at
      FROM setup_candidates WHERE last_checked_at >= ${since} OR first_detected_at >= ${since}`),
    avoidTradeEvents: await evidence("avoidTradeEvents", `SELECT market AS symbol, timeframe, created_at, last_observed_at
      FROM avoid_trade_learning_events WHERE last_observed_at >= ${since}`),
    discoveryUsage: await evidence("discoveryUsage", `SELECT scan_key, created_at FROM setup_discovery_usage WHERE created_at >= ${since}`),
    scanResultCache: await evidence("scanResultCache", `SELECT scan_key, created_at FROM scan_result_cache WHERE created_at >= ${since}`),
    detectedAlerts: await evidence("detectedAlerts", `SELECT symbol, timeframe, detected_at FROM detected_alerts WHERE detected_at >= ${since}`),
    telegramQueue: await evidence("telegramQueue", `SELECT setup_key, created_at FROM telegram_notification_queue WHERE created_at >= ${since}`)
  };
  // What the auto watcher scans: per Telegram setting (no user ids) its timeframes and, when favourites-only, the
  // watchlist; plus alert preferences. These are current values; updated_at shows whether they changed recently.
  const watcherScope = {
    telegramSettings: await evidence("telegramSettings", `SELECT s.enabled, s.favorite_markets_only, s.timeframes, s.updated_at,
        COALESCE(array_agg(w.symbol ORDER BY w.symbol) FILTER (WHERE w.symbol IS NOT NULL), '{}') AS watchlist
      FROM telegram_notification_settings s LEFT JOIN watchlist_markets w ON w.user_id = s.user_id
      WHERE $1::integer > 0
      GROUP BY s.user_id, s.enabled, s.favorite_markets_only, s.timeframes, s.updated_at`),
    alertPreferences: await evidence("alertPreferences", `SELECT symbol, timeframe, enabled, updated_at FROM alert_preferences WHERE $1::integer > 0`)
  };

  process.stdout.write(`${JSON.stringify({
    exportedAt: new Date().toISOString(), days, signals, scannerReadyPairs,
    liquidityRankingActive: liquidity ? liquidity.isLiquidityRankingActive() : false,
    adminDisabled, scanEvidence, watcherScope, evidenceErrors
  }, null, 1)}\n`, () => process.exit(0));
} catch (error) {
  process.stderr.write(`Export failed: ${error.message}\n`);
  process.exit(1);
}
