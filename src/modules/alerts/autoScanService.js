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
let autoScanRunning = false;
const scheduledCanaryCycleToken = Symbol("scheduled-canary-cycle");

export function startAutoCryptoAlertScanner() {
  if (!appConfig.autoScan.cryptoWatcherEnabled) {
    console.log("[crypto-watch] disabled by CRYPTO_WATCHER_ENABLED=false");
    return;
  }
  if (!appConfig.autoScan.enabled || autoScanTimer) {
    return;
  }

  const scheduledCanary = resolveScheduledAutoScanScope();
  if (scheduledCanary.error) {
    console.warn(scheduledCanary.error);
    return;
  }

  const intervalMs = Math.max(60_000, Number(appConfig.autoScan.intervalMs || 900_000));
  console.log(`[auto-scan] started interval_ms=${intervalMs}`);
  if (scheduledCanary.scopes?.length === 1 && !scheduledCanary.listMode) {
    console.log(
      `[crypto-watch] canary scheduler enabled user=${scheduledCanary.scopes[0].userId} ` +
      `symbol=${scheduledCanary.scopes[0].symbol} timeframe=${scheduledCanary.scopes[0].timeframe}`
    );
  } else if (scheduledCanary.scopes?.length) {
    console.log(
      `[crypto-watch] canary scheduler enabled user=${scheduledCanary.scopes[0].userId} ` +
      `symbols=${scheduledCanary.scopes.map((scope) => scope.symbol).join(",")} ` +
      `timeframe=${scheduledCanary.scopes[0].timeframe}`
    );
  }

  setTimeout(() => {
    runScheduledAutoScanCycle(scheduledCanary).catch((error) => {
      console.warn(`[auto-scan] failed ${error.message}`);
    });
  }, 1000);

  autoScanTimer = setInterval(() => {
    runScheduledAutoScanCycle(scheduledCanary).catch((error) => {
      console.warn(`[auto-scan] failed ${error.message}`);
    });
  }, intervalMs);
}

function resolveScheduledAutoScanScope() {
  const canary = appConfig.autoScan.canary || {};
  const configured = canary.configured || {};
  const configuredCount = Object.values(configured).filter(Boolean).length;
  if (configuredCount === 0) return { scopes: undefined, listMode: false, error: null };
  if (configured.symbol && configured.symbols) {
    return {
      scopes: null,
      listMode: false,
      error: "[crypto-watch] canary symbol configuration conflicts; scheduler disabled"
    };
  }
  const usesSingleSymbol = configured.symbol && !configured.symbols;
  const usesSymbolList = configured.symbols && !configured.symbol;
  if (!configured.userId || !configured.timeframe || (!usesSingleSymbol && !usesSymbolList) ||
    !canary.userId || !canary.timeframe) {
    return {
      scopes: null,
      listMode: usesSymbolList,
      error: "[crypto-watch] canary configuration incomplete; scheduler disabled"
    };
  }
  if (!appConfig.supportedTimeframes.includes(canary.timeframe)) {
    return {
      scopes: null,
      listMode: usesSymbolList,
      error: `[crypto-watch] canary timeframe invalid (${canary.timeframe}); scheduler disabled`
    };
  }

  let symbols;
  if (usesSingleSymbol) {
    if (!canary.symbol) {
      return {
        scopes: null,
        listMode: false,
        error: "[crypto-watch] canary configuration incomplete; scheduler disabled"
      };
    }
    symbols = [canary.symbol];
  } else {
    const entries = String(canary.symbols || "").split(",").map((symbol) => symbol.trim().toUpperCase());
    if (!entries.length || entries.some((symbol) => !symbol)) {
      return {
        scopes: null,
        listMode: true,
        error: "[crypto-watch] canary symbol list empty or invalid; scheduler disabled"
      };
    }
    symbols = [...new Set(entries)];
    if (symbols.length > 10) {
      return {
        scopes: null,
        listMode: true,
        error: `[crypto-watch] canary symbol limit exceeded (${symbols.length}/10); scheduler disabled`
      };
    }
  }

  return {
    scopes: symbols.map((symbol) => ({
      userId: canary.userId,
      symbol,
      timeframe: canary.timeframe
    })),
    listMode: usesSymbolList,
    error: null
  };
}

async function runScheduledAutoScanCycle({ scopes, listMode }) {
  if (!scopes?.length) return runAutoCryptoAlertScan();
  if (!listMode) return runAutoCryptoAlertScan(scopes[0]);
  if (autoScanRunning) {
    console.log("[auto-scan] skipped duplicates running_cycle=true");
    return { scanned: 0, alertsCreated: 0, telegramAlertsQueued: 0, skippedDuplicates: 1 };
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
    return { scanned: 0, alertsCreated: 0, skippedDuplicates: 1 };
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
