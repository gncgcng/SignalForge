import { appConfig } from "../../config/appConfig.js";
import {
  findUserById,
  hasRecentDetectedAlert,
  listAllEnabledAlertPreferences,
  listAllEnabledTelegramSettings,
  listWatchlistByUser,
  saveDetectedAlert
} from "../../db/repositories.js";
import { getPair, listAutoScannerPairs, listEligibleAutoScannerCryptoPairs } from "../market-data/marketDataService.js";
import { preserveDownstreamConfidence } from "../signals/signalConfidenceCalibrationService.js";
import {
  enqueueMatchingTelegramNotifications,
  telegramPreferenceMatchesSetup
} from "../notifications/notificationService.js";
import { scanMarketSetupDetailed } from "../signals/signalService.js";
import { saveGeneratedSignal } from "../admin-signals/generatedSignalService.js";
import { expireStaleCandidates, getCandidateQualitySummary, refreshCandidateLearningOutcomes, runCandidateMarketWatch } from "../signals/setupCandidateService.js";
import { waitForPendingAvoidTradeLearningCleanup } from "../signals/setupCandidateRepository.js";
import { preferenceMatchesSetup } from "./alertService.js";

let autoScanTimer = null;
let heartbeatTimer = null;
let autoScanRunning = false;
const scheduledCanaryCycleToken = Symbol("scheduled-canary-cycle");
export const AUTO_SCAN_HEARTBEAT_STALE_MS = 30 * 60 * 1000;
const AUTO_SCAN_HEARTBEAT_CHECK_MS = 5 * 60 * 1000;
const autoScanHealth = {
  mode: "off",
  schedulerStartedAt: null,
  lastCompletedCycleAt: null,
  lastCycleError: null,
  configurationError: null,
  lastHeartbeatWarningAt: null
};

export function startAutoCryptoAlertScanner() {
  if (!appConfig.autoScan.cryptoWatcherEnabled) {
    console.log("[crypto-watch] disabled by CRYPTO_WATCHER_ENABLED=false");
    return;
  }
  if (!appConfig.autoScan.enabled || autoScanTimer) {
    return;
  }

  // A bad canary configuration never disables auto-scanning: it is logged as an error and the full scan runs.
  const schedule = resolveScheduledAutoScanScope();
  if (schedule.error) console.error(schedule.error);
  autoScanHealth.configurationError = schedule.error;
  autoScanHealth.mode = schedule.scopes?.length ? "canary" : "full";
  autoScanHealth.schedulerStartedAt = Date.now();

  const intervalMs = Math.max(60_000, Number(appConfig.autoScan.intervalMs || 900_000));
  console.log(`[auto-scan] started interval_ms=${intervalMs} mode=${autoScanHealth.mode}`);
  if (schedule.scopes?.length === 1 && !schedule.listMode) {
    console.log(
      `[crypto-watch] canary scheduler enabled user=${schedule.scopes[0].userId} ` +
      `symbol=${schedule.scopes[0].symbol} timeframe=${schedule.scopes[0].timeframe}`
    );
  } else if (schedule.scopes?.length) {
    console.log(
      `[crypto-watch] canary scheduler enabled user=${schedule.scopes[0].userId} ` +
      `symbols=${schedule.scopes.map((scope) => scope.symbol).join(",")} ` +
      `timeframe=${schedule.scopes[0].timeframe}`
    );
  }

  setTimeout(() => {
    runScheduledAutoScanCycle(schedule).catch((error) => {
      console.warn(`[auto-scan] failed ${error.message}`);
    });
  }, 1000);

  autoScanTimer = setInterval(() => {
    runScheduledAutoScanCycle(schedule).catch((error) => {
      console.warn(`[auto-scan] failed ${error.message}`);
    });
  }, intervalMs);
  heartbeatTimer = setInterval(() => checkAutoScanHeartbeat(), AUTO_SCAN_HEARTBEAT_CHECK_MS);
}

// Canary mode only with an explicit AUTO_SCAN_MODE=canary and a complete, valid AUTO_SCAN_CANARY_* scope. Anything
// else that mentions a canary (leftover or partial variables, an unknown mode) returns the full scan with an error.
export function resolveScheduledAutoScanScope(config = appConfig.autoScan) {
  const canary = config.canary || {};
  const mode = String(config.mode || "full").trim().toLowerCase() || "full";
  const values = {
    userId: String(canary.userId || "").trim(),
    symbol: String(canary.symbol || "").trim().toUpperCase(),
    symbols: String(canary.symbols || "").trim(),
    timeframe: String(canary.timeframe || "").trim().toLowerCase()
  };
  const anyCanaryValue = Object.values(values).some(Boolean);
  const fullScan = (problem = null) => ({
    scopes: undefined,
    listMode: false,
    error: problem ? `[crypto-watch] ERROR ${problem}; running the full scan instead` : null
  });

  if (mode !== "canary") {
    if (mode !== "full") return fullScan(`AUTO_SCAN_MODE=${mode} is not "full" or "canary"`);
    return anyCanaryValue ? fullScan("AUTO_SCAN_CANARY_* is set but AUTO_SCAN_MODE is not canary") : fullScan();
  }
  if (values.symbol && values.symbols) {
    return fullScan("canary symbol configuration conflicts (both AUTO_SCAN_CANARY_SYMBOL and AUTO_SCAN_CANARY_SYMBOLS are set)");
  }
  if (!values.userId || !values.timeframe || (!values.symbol && !values.symbols)) {
    return fullScan("canary configuration incomplete (AUTO_SCAN_MODE=canary needs AUTO_SCAN_CANARY_USER_ID, AUTO_SCAN_CANARY_TIMEFRAME and AUTO_SCAN_CANARY_SYMBOL or AUTO_SCAN_CANARY_SYMBOLS)");
  }
  if (!appConfig.supportedTimeframes.includes(values.timeframe)) {
    return fullScan(`canary timeframe invalid (${values.timeframe})`);
  }

  let symbols = [values.symbol];
  const listMode = Boolean(values.symbols);
  if (listMode) {
    const entries = values.symbols.split(",").map((symbol) => symbol.trim().toUpperCase());
    if (entries.some((symbol) => !symbol)) return fullScan("canary symbol list empty or invalid");
    symbols = [...new Set(entries)];
    if (symbols.length > 10) return fullScan(`canary symbol limit exceeded (${symbols.length}/10)`);
  }

  return {
    scopes: symbols.map((symbol) => ({ userId: values.userId, symbol, timeframe: values.timeframe })),
    listMode,
    error: null
  };
}

// Last completed cycle, last error and staleness, for the admin Crypto Markets view.
export function getAutoScanHealth(nowMs = Date.now()) {
  const reference = autoScanHealth.lastCompletedCycleAt ?? autoScanHealth.schedulerStartedAt;
  const iso = (value) => (value == null ? null : new Date(value).toISOString());
  return {
    mode: autoScanHealth.mode,
    schedulerRunning: autoScanHealth.schedulerStartedAt != null,
    schedulerStartedAt: iso(autoScanHealth.schedulerStartedAt),
    lastCompletedCycleAt: iso(autoScanHealth.lastCompletedCycleAt),
    lastCycleError: autoScanHealth.lastCycleError
      ? { message: autoScanHealth.lastCycleError.message, at: iso(autoScanHealth.lastCycleError.at) }
      : null,
    configurationError: autoScanHealth.configurationError,
    stale: reference != null && nowMs - reference > AUTO_SCAN_HEARTBEAT_STALE_MS,
    staleAfterMinutes: AUTO_SCAN_HEARTBEAT_STALE_MS / 60000
  };
}

// Warns when no auto-scan cycle has completed for 30 minutes (at most once per 30 minutes).
export function checkAutoScanHeartbeat(nowMs = Date.now()) {
  const health = getAutoScanHealth(nowMs);
  if (!health.stale) return health;
  if (autoScanHealth.lastHeartbeatWarningAt != null && nowMs - autoScanHealth.lastHeartbeatWarningAt < AUTO_SCAN_HEARTBEAT_STALE_MS) return health;
  autoScanHealth.lastHeartbeatWarningAt = nowMs;
  const since = autoScanHealth.lastCompletedCycleAt ?? autoScanHealth.schedulerStartedAt;
  console.warn(
    `[auto-scan] heartbeat: no auto-scan cycle completed in ${Math.round((nowMs - since) / 60000)} minutes ` +
    `(last completed ${health.lastCompletedCycleAt || "never"}; last error ${health.lastCycleError?.message || "none"})`
  );
  return health;
}

async function runScheduledAutoScanCycle(schedule) {
  try {
    const result = await runScheduledCycleScopes(schedule);
    if (!result?.skippedRunningCycle) autoScanHealth.lastCompletedCycleAt = Date.now();
    return result;
  } catch (error) {
    autoScanHealth.lastCycleError = { message: error.message, at: Date.now() };
    throw error;
  }
}

async function runScheduledCycleScopes({ scopes, listMode }) {
  if (!scopes?.length) return runAutoCryptoAlertScan();
  if (!listMode) return runAutoCryptoAlertScan(scopes[0]);
  if (autoScanRunning) {
    console.log("[auto-scan] skipped duplicates running_cycle=true");
    return { scanned: 0, alertsCreated: 0, telegramAlertsQueued: 0, skippedDuplicates: 1, skippedRunningCycle: true };
  }

  autoScanRunning = true;
  const totals = { scanned: 0, alertsCreated: 0, telegramAlertsQueued: 0, skippedDuplicates: 0 };
  let scannedSymbols = 0;
  try {
    for (const scope of scopes) {
      try {
        const result = await runAutoCryptoAlertScan(scope, scheduledCanaryCycleToken);
        scannedSymbols += 1;
        for (const key of Object.keys(totals)) totals[key] += Number(result?.[key] || 0);
      } catch (error) {
        autoScanHealth.lastCycleError = { message: `${scope.symbol} ${scope.timeframe}: ${error.message}`, at: Date.now() };
        console.warn(`[auto-scan] ${scope.symbol} ${scope.timeframe} skipped: ${error.message}`);
      }
    }
  } finally {
    autoScanRunning = false;
  }
  console.log(
    `[crypto-watch] canary cycle requested_symbols=${scopes.length} ` +
    `scanned=${scannedSymbols} failed=${scopes.length - scannedSymbols}`
  );
  return { ...totals, requestedSymbols: scopes.length, scannedSymbols };
}

export async function runAutoCryptoAlertScan(scope = undefined, cycleToken = null) {
  const ownsAutoScanLock = cycleToken !== scheduledCanaryCycleToken;
  const normalizedScope = normalizeAutoScanScope(scope);
  const scopedContext = normalizedScope
    ? await resolveAutoScanScope(normalizedScope)
    : null;

  if (ownsAutoScanLock && autoScanRunning) {
    console.log("[auto-scan] skipped duplicates running_cycle=true");
    return { scanned: 0, alertsCreated: 0, skippedDuplicates: 1, skippedRunningCycle: true };
  }

  if (ownsAutoScanLock) autoScanRunning = true;
  let scanned = 0;
  let alertsCreated = 0;
  let telegramAlertsQueued = 0;
  let skippedDuplicates = 0;
  const users = new Map();

  try {
    const before = await getCandidateQualitySummary();
    const expiredThisCycle = await expireStaleCandidates(normalizedScope);
    const watched = await runCandidateMarketWatch(normalizedScope);
    const preferences = (await listAllEnabledAlertPreferences()).filter((preference) => {
      const pair = getPair(preference.symbol);
      return pair?.category === "Crypto" && pair.effectiveScannerEnabled && pair.supportedTimeframes.includes(preference.timeframe);
    }).filter((preference) => !normalizedScope || (
      String(preference.user_id) === normalizedScope.userId &&
      preference.symbol === normalizedScope.symbol &&
      preference.timeframe === normalizedScope.timeframe
    ));

    for (const preference of preferences) {
      const user = await getPreferenceUser(preference.user_id, users);
      if (!user) continue;

      scanned += 1;

      try {
        const detailed = await scanMarketSetupDetailed(user, {
          symbol: preference.symbol,
          timeframe: preference.timeframe
        }, null, { source: "auto_crypto_watcher", generatedBy: "auto_crypto_watcher" });
        const setup = detailed.fullSetup;

        const telegramSetup = setup ? await calibrateTelegramAlertSetup(setup) : null;

        if (!telegramSetup || !preferenceMatchesSetup(preference, telegramSetup)) {
          continue;
        }

        if (await hasRecentDetectedAlert(user.id, telegramSetup, appConfig.autoScan.duplicateCooldownMs)) {
          skippedDuplicates += 1;
          continue;
        }

        const alert = await saveDetectedAlert(user.id, preference, telegramSetup);
        if (!alert) {
          skippedDuplicates += 1;
          continue;
        }

        alertsCreated += 1;
        console.log(`[auto-scan] matched alert user=${user.id} symbol=${telegramSetup.symbol} timeframe=${telegramSetup.timeframe} direction=${telegramSetup.direction}`);
        const queuedTelegramAlerts = await enqueueMatchingTelegramNotifications(user, [telegramSetup]);
        if (!queuedTelegramAlerts.length) {
          console.log(`[auto-scan] matched alert telegram_queued=0 user=${user.id} symbol=${telegramSetup.symbol} timeframe=${telegramSetup.timeframe}`);
        } else {
          telegramAlertsQueued += queuedTelegramAlerts.length;
          await saveGeneratedSignal(telegramSetup, { source: "telegram_alert", generatedBy: "auto_crypto_watcher" });
          console.log(`[auto-scan] telegram alert queued user=${user.id} symbol=${telegramSetup.symbol} timeframe=${telegramSetup.timeframe}`);
        }
      } catch (error) {
        console.warn(`[auto-scan] ${preference.symbol} ${preference.timeframe} skipped: ${error.message}`);
      }
    }

    const telegramSettings = scopedContext
      ? [scopedContext.settings]
      : await listAllEnabledTelegramSettings();
    const cryptoMarkets = scopedContext
      ? [scopedContext.market]
      : listAutoScannerPairs().filter((pair) => pair.category === "Crypto");
    const cryptoSymbols = cryptoMarkets.map((pair) => pair.symbol);

    for (const settings of telegramSettings) {
      const user = await getPreferenceUser(settings.userId, users);
      if (!user) continue;

      const watchlist = settings.favoriteMarketsOnly
        ? await listWatchlistByUser(user.id)
        : [];
      const favoriteSymbols = new Set(watchlist.map((item) => item.symbol));
      const availableSymbols = settings.favoriteMarketsOnly
        ? cryptoSymbols.filter((symbol) => favoriteSymbols.has(symbol))
        : cryptoSymbols;
      const selectedSymbols = normalizedScope
        ? availableSymbols.filter((symbol) => symbol === normalizedScope.symbol)
        : availableSymbols;
      const scope = settings.favoriteMarketsOnly ? "watchlist" : "all_crypto";

      console.log(`[auto-scan] scope=${scope} user=${user.id}`);
      console.log(`[auto-scan] markets selected user=${user.id} count=${selectedSymbols.length}`);

      for (const symbol of selectedSymbols) {
        const market = cryptoMarkets.find((item) => item.symbol === symbol);
        const selectedTimeframes = settings.timeframes.filter((item) =>
          market?.supportedTimeframes.includes(item) &&
          (!normalizedScope || item === normalizedScope.timeframe)
        );
        for (const timeframe of selectedTimeframes) {
          scanned += 1;

          try {
            const detailed = await scanMarketSetupDetailed(user, { symbol, timeframe }, null, { source: "auto_crypto_watcher", generatedBy: "auto_crypto_watcher" });
            const setup = detailed.fullSetup;

            const telegramSetup = setup ? await calibrateTelegramAlertSetup(setup) : null;

            if (!telegramSetup || !telegramPreferenceMatchesSetup(settings, favoriteSymbols, telegramSetup)) {
              continue;
            }

            const queuedTelegramAlerts = await enqueueMatchingTelegramNotifications(user, [telegramSetup]);

            if (queuedTelegramAlerts.length) {
              telegramAlertsQueued += queuedTelegramAlerts.length;
              await saveGeneratedSignal(telegramSetup, { source: "telegram_alert", generatedBy: "auto_crypto_watcher" });
              console.log(`[auto-scan] matched alert user=${user.id} symbol=${telegramSetup.symbol} timeframe=${telegramSetup.timeframe} direction=${telegramSetup.direction}`);
              console.log(`[auto-scan] telegram alert queued user=${user.id} symbol=${telegramSetup.symbol} timeframe=${telegramSetup.timeframe}`);
            } else {
              skippedDuplicates += 1;
            }
          } catch (error) {
            console.warn(`[auto-scan] ${symbol} ${timeframe} skipped: ${error.message}`);
          }
        }
      }
    }

    console.log(`[auto-scan] markets scanned ${scanned}`);
    console.log(`[auto-scan] alerts created ${alertsCreated}`);
    console.log(`[auto-scan] telegram alerts queued ${telegramAlertsQueued}`);
    console.log(`[auto-scan] skipped duplicates ${skippedDuplicates}`);
    const after = await getCandidateQualitySummary();
    await refreshCandidateLearningOutcomes(normalizedScope);
    console.log(
      `[crypto-watch] scanned=${watched.scanned} ` +
      `candidates_created=${Math.max(0, after.candidatesCreatedToday - before.candidatesCreatedToday)} ` +
      `updated=${watched.createdOrUpdated} promoted=${Math.max(0, after.candidatesPromoted - before.candidatesPromoted)} ` +
      `rejected=${Math.max(0, after.candidatesRejected - before.candidatesRejected)} expired=${expiredThisCycle}`
    );

    return { scanned, alertsCreated, telegramAlertsQueued, skippedDuplicates };
  } finally {
    try {
      if (normalizedScope) await waitForPendingAvoidTradeLearningCleanup();
    } finally {
      if (ownsAutoScanLock) autoScanRunning = false;
    }
  }
}

function normalizeAutoScanScope(scope) {
  if (scope === undefined) return null;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw autoScanScopeError("Scoped auto scan requires symbol, timeframe, and userId.", "AUTO_SCAN_SCOPE_INCOMPLETE");
  }

  const symbol = String(scope.symbol || "").trim().toUpperCase();
  const timeframe = String(scope.timeframe || "").trim().toLowerCase();
  const userId = String(scope.userId || "").trim();
  if (!symbol || !timeframe || !userId) {
    throw autoScanScopeError("Scoped auto scan requires symbol, timeframe, and userId.", "AUTO_SCAN_SCOPE_INCOMPLETE");
  }
  if (!appConfig.supportedTimeframes.includes(timeframe)) {
    throw autoScanScopeError(`Unsupported scoped auto-scan timeframe: ${timeframe}.`, "AUTO_SCAN_SCOPE_UNSUPPORTED_TIMEFRAME");
  }
  return { symbol, timeframe, userId };
}

async function resolveAutoScanScope(scope) {
  const markets = listEligibleAutoScannerCryptoPairs();
  const market = markets.find((pair) => pair.symbol === scope.symbol);
  if (!market) {
    throw autoScanScopeError(`${scope.symbol} is not an eligible auto-scanner market.`, "AUTO_SCAN_SCOPE_INELIGIBLE_MARKET");
  }
  if (!market.supportedTimeframes.includes(scope.timeframe)) {
    throw autoScanScopeError(
      `${scope.symbol} does not support ${scope.timeframe} for auto scanning.`,
      "AUTO_SCAN_SCOPE_UNSUPPORTED_TIMEFRAME"
    );
  }

  const settings = (await listAllEnabledTelegramSettings())
    .find((item) => String(item.userId) === scope.userId);
  if (!settings) {
    throw autoScanScopeError(
      `User ${scope.userId} does not have enabled Telegram settings.`,
      "AUTO_SCAN_SCOPE_TELEGRAM_DISABLED"
    );
  }
  return { market, settings };
}

function autoScanScopeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function calibrateTelegramAlertSetup(setup) {
  const preserved = preserveDownstreamConfidence(setup);
  return Number.isFinite(preserved?.confidenceScore) && !preserved?.confidenceCalibration?.technicalError
    ? preserved
    : null;
}

async function getPreferenceUser(userId, cache) {
  if (!cache.has(userId)) {
    cache.set(userId, await findUserById(userId));
  }
  return cache.get(userId);
}
