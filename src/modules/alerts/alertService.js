import {
  addWatchlistMarket,
  listDetectedAlertsByUser,
  listEnabledAlertPreferences,
  listWatchlistByUser,
  markDetectedAlertRead,
  removeWatchlistMarket,
  saveDetectedAlert,
  upsertAlertPreference
} from "../../db/repositories.js";
import { createId } from "../../shared/ids.js";
import { getPair } from "../market-data/marketDataService.js";

const directions = new Set(["long", "short", "both"]);
const timeframes = new Set(["5m", "15m", "1h", "4h"]);

export async function getWatchlist(user) {
  return { watchlist: await listWatchlistByUser(user.id) };
}

export async function favoriteMarket(user, symbol) {
  assertActiveMarket(symbol);
  await addWatchlistMarket(user.id, symbol);
  return getWatchlist(user);
}

export async function unfavoriteMarket(user, symbol) {
  await removeWatchlistMarket(user.id, symbol);
  return getWatchlist(user);
}

export async function saveAlertPreference(user, input) {
  assertActiveMarket(input.symbol);

  if (!timeframes.has(input.timeframe)) {
    throw validationError("Choose a supported alert timeframe.");
  }

  if (!directions.has(input.direction)) {
    throw validationError("Alert direction must be long, short, or both.");
  }

  const minimumConfidence = Number(input.minimumConfidence);

  if (!Number.isInteger(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 100) {
    throw validationError("Minimum confidence must be between 0 and 100.");
  }

  await addWatchlistMarket(user.id, input.symbol);
  await upsertAlertPreference(user.id, {
    id: createId("pref"),
    symbol: input.symbol,
    timeframe: input.timeframe,
    direction: input.direction,
    minimumConfidence
  });
  return getWatchlist(user);
}

export async function detectMatchingAlerts(user, setups) {
  const preferences = await listEnabledAlertPreferences(user.id);
  const detected = [];

  for (const setup of setups) {
    const preference = preferences.find((item) => preferenceMatchesSetup(item, setup));

    if (!preference) {
      continue;
    }

    const alert = await saveDetectedAlert(user.id, preference, setup);

    if (alert) {
      detected.push(alert);
    }
  }

  return detected;
}

export function preferenceMatchesSetup(preference, setup) {
  return Boolean(
    setup?.id &&
    preference.symbol === setup.symbol &&
    preference.timeframe === setup.timeframe &&
    (preference.direction === "both" || preference.direction === setup.direction) &&
    Number(setup.confidenceScore) >= Number(preference.minimum_confidence)
  );
}

export async function getAlerts(user) {
  const alerts = await listDetectedAlertsByUser(user.id);
  return {
    alerts,
    unreadCount: alerts.filter((alert) => !alert.readAt).length
  };
}

export async function markAlertRead(user, alertId) {
  await markDetectedAlertRead(user.id, alertId);
  return getAlerts(user);
}

function assertActiveMarket(symbol) {
  const pair = getPair(symbol);

  if (!pair || pair.status !== "active" || pair.category === "Crypto" && !pair.effectiveWatchlistEnabled) {
    throw validationError("Only active crypto and commodity markets can be added to the watchlist.");
  }
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
