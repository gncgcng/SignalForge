import { appConfig } from "../../config/appConfig.js";
import {
  findUserById,
  hasRecentDetectedAlert,
  listAllEnabledAlertPreferences,
  saveDetectedAlert
} from "../../db/repositories.js";
import { getPair } from "../market-data/marketDataService.js";
import { enqueueMatchingTelegramNotifications } from "../notifications/notificationService.js";
import { scanMarketSetupDetailed } from "../signals/signalService.js";
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
  let skippedDuplicates = 0;
  const users = new Map();

  try {
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
        await enqueueMatchingTelegramNotifications(user, [setup]);
      } catch (error) {
        console.warn(`[auto-scan] ${preference.symbol} ${preference.timeframe} skipped: ${error.message}`);
      }
    }

    console.log(`[auto-scan] markets scanned ${scanned}`);
    console.log(`[auto-scan] alerts created ${alertsCreated}`);
    console.log(`[auto-scan] skipped duplicates ${skippedDuplicates}`);

    return { scanned, alertsCreated, skippedDuplicates };
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
