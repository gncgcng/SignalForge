import { appConfig } from "../../config/appConfig.js";
import {
  findUserById,
  hasRecentDetectedAlert,
  listAllEnabledAlertPreferences,
  listAllEnabledTelegramSettings,
  listWatchlistByUser,
  saveDetectedAlert
} from "../../db/repositories.js";
import { getPair, listActivePairs } from "../market-data/marketDataService.js";
import {
  enqueueMatchingTelegramNotifications,
  telegramPreferenceMatchesSetup
} from "../notifications/notificationService.js";
import { scanMarketSetupDetailed } from "../signals/signalService.js";
import { expireStaleCandidates, getCandidateQualitySummary, refreshCandidateLearningOutcomes, runCandidateMarketWatch } from "../signals/setupCandidateService.js";
import { preferenceMatchesSetup } from "./alertService.js";

let autoScanTimer = null;
let autoScanRunning = false;

export function startAutoCryptoAlertScanner() {
  if (!appConfig.autoScan.enabled || autoScanTimer) {
    return;
  }

  const intervalMs = Math.max(60_000, Number(appConfig.autoScan.intervalMs || 900_000));
  console.log(`[auto-scan] started interval_ms=${intervalMs}`);

  setTimeout(() => {
    runAutoCryptoAlertScan().catch((error) => {
      console.warn(`[auto-scan] failed ${error.message}`);
    });
  }, 1000);

  autoScanTimer = setInterval(() => {
    runAutoCryptoAlertScan().catch((error) => {
      console.warn(`[auto-scan] failed ${error.message}`);
    });
  }, intervalMs);
}

export async function runAutoCryptoAlertScan() {
  if (autoScanRunning) {
    console.log("[auto-scan] skipped duplicates running_cycle=true");
    return { scanned: 0, alertsCreated: 0, skippedDuplicates: 1 };
  }

  autoScanRunning = true;
  let scanned = 0;
  let alertsCreated = 0;
  let telegramAlertsQueued = 0;
  let skippedDuplicates = 0;
  const users = new Map();

  try {
    const before = await getCandidateQualitySummary();
    const expiredThisCycle = await expireStaleCandidates();
    const watched = await runCandidateMarketWatch();
    const preferences = (await listAllEnabledAlertPreferences()).filter((preference) => {
      const pair = getPair(preference.symbol);
      return pair?.category === "Crypto" && pair.status === "active";
    });

    for (const preference of preferences) {
      const user = await getPreferenceUser(preference.user_id, users);
      if (!user) continue;

      scanned += 1;

      try {
        const detailed = await scanMarketSetupDetailed(user, {
          symbol: preference.symbol,
          timeframe: preference.timeframe
        });
        const setup = detailed.fullSetup;

        if (!setup || !preferenceMatchesSetup(preference, setup)) {
          continue;
        }

        if (await hasRecentDetectedAlert(user.id, setup, appConfig.autoScan.duplicateCooldownMs)) {
          skippedDuplicates += 1;
          continue;
        }

        const alert = await saveDetectedAlert(user.id, preference, setup);
        if (!alert) {
          skippedDuplicates += 1;
          continue;
        }

        alertsCreated += 1;
        console.log(`[auto-scan] matched alert user=${user.id} symbol=${setup.symbol} timeframe=${setup.timeframe} direction=${setup.direction}`);
        const queuedTelegramAlerts = await enqueueMatchingTelegramNotifications(user, [setup]);
        if (!queuedTelegramAlerts.length) {
          console.log(`[auto-scan] matched alert telegram_queued=0 user=${user.id} symbol=${setup.symbol} timeframe=${setup.timeframe}`);
        } else {
          telegramAlertsQueued += queuedTelegramAlerts.length;
          console.log(`[auto-scan] telegram alert sent user=${user.id} symbol=${setup.symbol} timeframe=${setup.timeframe}`);
        }
      } catch (error) {
        console.warn(`[auto-scan] ${preference.symbol} ${preference.timeframe} skipped: ${error.message}`);
      }
    }

    const telegramSettings = await listAllEnabledTelegramSettings();
    const cryptoSymbols = listActivePairs()
      .filter((pair) => pair.category === "Crypto")
      .map((pair) => pair.symbol);

    for (const settings of telegramSettings) {
      const user = await getPreferenceUser(settings.userId, users);
      if (!user) continue;

      const watchlist = settings.favoriteMarketsOnly
        ? await listWatchlistByUser(user.id)
        : [];
      const favoriteSymbols = new Set(watchlist.map((item) => item.symbol));
      const selectedSymbols = settings.favoriteMarketsOnly
        ? cryptoSymbols.filter((symbol) => favoriteSymbols.has(symbol))
        : cryptoSymbols;
      const scope = settings.favoriteMarketsOnly ? "watchlist" : "all_crypto";

      console.log(`[auto-scan] scope=${scope} user=${user.id}`);
      console.log(`[auto-scan] markets selected user=${user.id} count=${selectedSymbols.length}`);

      for (const symbol of selectedSymbols) {
        for (const timeframe of settings.timeframes) {
          scanned += 1;

          try {
            const detailed = await scanMarketSetupDetailed(user, { symbol, timeframe });
            const setup = detailed.fullSetup;

            if (!setup || !telegramPreferenceMatchesSetup(settings, favoriteSymbols, setup)) {
              continue;
            }

            const queuedTelegramAlerts = await enqueueMatchingTelegramNotifications(user, [setup]);

            if (queuedTelegramAlerts.length) {
              telegramAlertsQueued += queuedTelegramAlerts.length;
              console.log(`[auto-scan] matched alert user=${user.id} symbol=${setup.symbol} timeframe=${setup.timeframe} direction=${setup.direction}`);
              console.log(`[auto-scan] telegram alert sent user=${user.id} symbol=${setup.symbol} timeframe=${setup.timeframe}`);
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
    await refreshCandidateLearningOutcomes();
    console.log(
      `[crypto-watch] scanned=${watched.scanned} ` +
      `candidates_created=${Math.max(0, after.candidatesCreatedToday - before.candidatesCreatedToday)} ` +
      `updated=${watched.createdOrUpdated} promoted=${Math.max(0, after.candidatesPromoted - before.candidatesPromoted)} ` +
      `rejected=${Math.max(0, after.candidatesRejected - before.candidatesRejected)} expired=${expiredThisCycle}`
    );

    return { scanned, alertsCreated, telegramAlertsQueued, skippedDuplicates };
  } finally {
    autoScanRunning = false;
  }
}

async function getPreferenceUser(userId, cache) {
  if (!cache.has(userId)) {
    cache.set(userId, await findUserById(userId));
  }
  return cache.get(userId);
}
