import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runAutoCryptoWatcherSmokeCli({
  argv = process.argv.slice(2),
  env = process.env,
  write = (value) => console.log(value),
  loadRuntime = loadProductionRuntime
} = {}) {
  if (String(env.CRYPTO_WATCHER_ENABLED || "").trim().toLowerCase() !== "false") {
    throw cliError(
      "CRYPTO_WATCHER_ENABLED must be explicitly false for a one-run watcher smoke test.",
      "AUTO_SCAN_SMOKE_WATCHER_NOT_DISABLED"
    );
  }

  const scope = parseSmokeScope(argv);
  write(JSON.stringify({
    symbol: scope.symbol,
    timeframe: scope.timeframe,
    userId: scope.userId,
    watcherScheduled: false,
    singleRun: true
  }));

  const runtime = await loadRuntime();
  try {
    const result = await runtime.runAutoCryptoAlertScan(scope);
    write(JSON.stringify({ scope, result }));
    return result;
  } finally {
    await runtime.close();
  }
}

export function parseSmokeScope(argv = []) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--symbol", "--timeframe", "--user-id"].includes(argument)) {
      throw cliError(`Unknown smoke-test argument: ${argument}.`, "AUTO_SCAN_SMOKE_INVALID_ARGUMENT");
    }
    const value = String(argv[index + 1] || "").trim();
    if (!value || value.startsWith("--")) {
      throw cliError(`Missing value for ${argument}.`, "AUTO_SCAN_SMOKE_MISSING_ARGUMENT");
    }
    values.set(argument, value);
    index += 1;
  }

  const symbol = String(values.get("--symbol") || "").trim().toUpperCase();
  const timeframe = String(values.get("--timeframe") || "").trim().toLowerCase();
  const userId = String(values.get("--user-id") || "").trim();
  if (!symbol || !timeframe || !userId) {
    throw cliError(
      "Required arguments: --symbol, --timeframe, and --user-id.",
      "AUTO_SCAN_SMOKE_MISSING_ARGUMENT"
    );
  }
  return { symbol, timeframe, userId };
}

async function loadProductionRuntime() {
  const [{ runAutoCryptoAlertScan }, { getPool }] = await Promise.all([
    import("../src/modules/alerts/autoScanService.js"),
    import("../src/db/client.js")
  ]);
  return {
    runAutoCryptoAlertScan,
    close: async () => getPool().end()
  };
}

function cliError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runAutoCryptoWatcherSmokeCli().catch((error) => {
    console.error(`[auto-scan-smoke] ${error.code || "FAILED"}: ${error.message}`);
    process.exitCode = 1;
  });
}
