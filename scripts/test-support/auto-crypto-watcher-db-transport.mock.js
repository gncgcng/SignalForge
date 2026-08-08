import {
  getReadySignalPersistence,
  query as readyQuery,
  resetReadySignalTransport,
  transaction as readyTransaction
} from "./ready-signal-db-transport.mock.js";
import {
  getTelegramQueueRows,
  setTelegramSettings,
  transportState
} from "./signal-pipeline-db-transport.mock.js";

const users = new Map();
const watchlists = new Map();
const alertPreferences = [];
const detectedAlerts = [];
let avoidLearningCleanupBarrier = null;

export function resetAutoCryptoWatcherTransport() {
  avoidLearningCleanupBarrier?.release();
  avoidLearningCleanupBarrier = null;
  resetReadySignalTransport();
  users.clear();
  watchlists.clear();
  alertPreferences.length = 0;
  detectedAlerts.length = 0;
}

export function holdNextAvoidLearningCleanup() {
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  avoidLearningCleanupBarrier = { markStarted, released, release };
  return { started, release };
}

export function configureWatcherUser({
  userId = "watcher-user",
  minimumConfidence = 90,
  symbols = [],
  timeframes = ["15m"],
  chatId = "10001",
  enabled = true,
  favoriteMarketsOnly = true
} = {}) {
  users.set(userId, {
    id: userId,
    name: "Watcher Fixture",
    email: "watcher@example.test",
    role: "tester",
    plan: "tester",
    account_status: "active",
    email_verified_at: new Date().toISOString(),
    free_signal_allowance: 0,
    paid_credits: 0,
    unlock_credits_balance: 0,
    lifetime_unlocks_used: 0,
    discoveries_today: 0,
    discoveries_period: 0
  });
  watchlists.set(userId, [...symbols]);
  setTelegramSettings(userId, {
    chat_id: chatId,
    enabled,
    favorite_markets_only: favoriteMarketsOnly,
    timeframes: [...timeframes],
    direction: "both",
    minimum_confidence: minimumConfidence
  });
  return userId;
}

export function configureAlertPreference({
  id,
  userId,
  symbol,
  timeframe,
  enabled = true,
  direction = "both",
  minimumConfidence = 0
}) {
  alertPreferences.push({
    id: id || `pref-${alertPreferences.length + 1}`,
    user_id: userId,
    symbol,
    timeframe,
    enabled,
    direction,
    minimum_confidence: minimumConfidence
  });
}

export function getAutoCryptoWatcherState() {
  return {
    calls: structuredClone(transportState.calls),
    generatedRows: structuredClone([...transportState.generatedSignals.values()]),
    queueRows: getTelegramQueueRows(),
    settings: structuredClone([...transportState.telegramSettings.values()]),
    watchlists: structuredClone([...watchlists.entries()]),
    candidates: getReadySignalPersistence().candidates,
    detectedAlerts: structuredClone(detectedAlerts)
  };
}

export async function query(sql, params = []) {
  const normalized = normalizeSql(sql);

  if (normalized.includes("delete from avoid_trade_learning_events") && avoidLearningCleanupBarrier) {
    const barrier = avoidLearningCleanupBarrier;
    avoidLearningCleanupBarrier = null;
    barrier.markStarted();
    await barrier.released;
  }

  if (normalized.includes("from alert_preferences p") && normalized.includes("join users u")) {
    transportState.calls.push({ sql: normalized, params: structuredClone(params) });
    return {
      rows: alertPreferences
        .filter((preference) => preference.enabled)
        .map((preference) => ({
          ...structuredClone(preference),
          role: users.get(preference.user_id)?.role || "user",
          email_verified_at: users.get(preference.user_id)?.email_verified_at || null
        }))
    };
  }

  if (normalized.includes("from detected_alerts") && normalized.includes("setup_id = $2")) {
    transportState.calls.push({ sql: normalized, params: structuredClone(params) });
    const row = detectedAlerts.find((alert) => alert.user_id === params[0] && alert.setup_id === params[1]);
    return { rows: row ? [{ id: row.id }] : [] };
  }

  if (normalized.includes("insert into detected_alerts")) {
    transportState.calls.push({ sql: normalized, params: structuredClone(params) });
    const duplicate = detectedAlerts.find((alert) =>
      alert.user_id === params[1] && alert.preference_id === params[2] && alert.setup_id === params[3]
    );
    if (duplicate) return { rows: [] };
    const row = {
      id: params[0],
      user_id: params[1],
      preference_id: params[2],
      setup_id: params[3],
      symbol: params[4],
      timeframe: params[5],
      direction: params[6]
    };
    detectedAlerts.push(row);
    return { rows: [structuredClone(row)] };
  }

  if (normalized.includes("from telegram_notification_settings s") && normalized.includes("join users u")) {
    transportState.calls.push({ sql: normalized, params: structuredClone(params) });
    const rows = [...transportState.telegramSettings.values()]
      .filter((row) => row.enabled && row.chat_id)
      .map((row) => ({ ...structuredClone(row), role: users.get(row.user_id)?.role || "user" }));
    return { rows };
  }

  if (normalized.includes("from users u") && normalized.includes("where u.id = $1")) {
    transportState.calls.push({ sql: normalized, params: structuredClone(params) });
    const row = users.get(params[0]);
    return { rows: row ? [structuredClone(row)] : [] };
  }

  if (normalized.includes("from watchlist_markets w")) {
    transportState.calls.push({ sql: normalized, params: structuredClone(params) });
    const rows = (watchlists.get(params[0]) || []).map((symbol, index) => ({
      symbol,
      created_at: new Date(Date.now() - index * 1000).toISOString(),
      preference_id: null
    }));
    return { rows };
  }

  return readyQuery(sql, params);
}

export async function transaction(callback) {
  return readyTransaction(async () => callback({ query }));
}

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}
