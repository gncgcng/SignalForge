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
  const scannerReadyPairs = listScannerCryptoMarkets().map((market) => ({
    symbol: market.symbol,
    liquidityTier: market.liquidityTier || null,
    scannerTimeframes: market.scannerTimeframes || market.supportedTimeframes || null
  }));
  const adminDisabled = (await query(`
    SELECT group_key, updated_at FROM signal_strategy_statuses WHERE status = 'disabled_by_admin' ORDER BY updated_at
  `)).rows;

  process.stdout.write(`${JSON.stringify({ exportedAt: new Date().toISOString(), days, signals, scannerReadyPairs, adminDisabled }, null, 1)}\n`, () => process.exit(0));
} catch (error) {
  process.stderr.write(`Export failed: ${error.message}\n`);
  process.exit(1);
}
