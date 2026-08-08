import {
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

export function resetAutoCryptoWatcherTransport() {
  resetReadySignalTransport();
  users.clear();
  watchlists.clear();
}

export function configureWatcherUser({
  userId = "watcher-user",
  minimumConfidence = 90,
  symbols = [],
  timeframes = ["15m"]
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
    chat_id: "10001",
    enabled: true,
    favorite_markets_only: true,
    timeframes: [...timeframes],
    direction: "both",
    minimum_confidence: minimumConfidence
  });
  return userId;
}

export function getAutoCryptoWatcherState() {
  return {
    calls: structuredClone(transportState.calls),
    generatedRows: structuredClone([...transportState.generatedSignals.values()]),
    queueRows: getTelegramQueueRows(),
    settings: structuredClone([...transportState.telegramSettings.values()]),
    watchlists: structuredClone([...watchlists.entries()])
  };
}

export async function query(sql, params = []) {
  const normalized = normalizeSql(sql);

  if (normalized.includes("from alert_preferences p") && normalized.includes("join users u")) {
    transportState.calls.push({ sql: normalized, params: structuredClone(params) });
    return { rows: [] };
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
