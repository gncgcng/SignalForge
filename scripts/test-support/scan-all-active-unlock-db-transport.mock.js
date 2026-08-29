import {
  getReadySignalPersistence,
  query as readyQuery,
  resetReadySignalTransport
} from "./ready-signal-db-transport.mock.js";

const savedSignals = new Map();
const users = new Map();
const creditTransactions = new Set();

const unlockState = {
  creditDebits: 0,
  savedSignalInserts: 0
};

export function resetActiveScanUnlockTransport() {
  resetReadySignalTransport();
  savedSignals.clear();
  users.clear();
  creditTransactions.clear();
  unlockState.creditDebits = 0;
  unlockState.savedSignalInserts = 0;
}

export function seedActiveScanUnlockUser(user) {
  users.set(user.id, {
    role: user.role || "user",
    email_verified_at: user.emailVerifiedAt || new Date().toISOString(),
    unlock_credits_balance: Number(user.unlockCreditsBalance || 0)
  });
}

export function getActiveScanUnlockPersistence() {
  return {
    ...getReadySignalPersistence(),
    creditDebits: unlockState.creditDebits,
    savedSignalInserts: unlockState.savedSignalInserts,
    savedSignals: structuredClone([...savedSignals.values()])
  };
}

export async function query(sql, params = []) {
  const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();

  if (normalized.includes("from saved_signals s") && normalized.includes("s.user_id = $1") && normalized.includes("s.setup_key = $2")) {
    const row = savedSignals.get(savedKey(params[0], params[1]));
    return { rows: row ? [structuredClone(row)] : [] };
  }
  if (normalized.includes("select pg_advisory_xact_lock")) return { rows: [] };
  if (normalized.includes("select u.role, u.email_verified_at, c.unlock_credits_balance")) {
    const row = users.get(params[0]);
    return { rows: row ? [structuredClone(row)] : [] };
  }
  if (normalized.includes("insert into saved_signals")) {
    const row = savedRow(params);
    savedSignals.set(savedKey(params[1], params[2]), row);
    unlockState.savedSignalInserts += 1;
    return { rows: [] };
  }
  if (normalized.includes("insert into unlocked_signals") || normalized.includes("insert into signal_outcomes")) {
    return { rows: [] };
  }
  if (normalized.includes("with charge_transaction as") && normalized.includes("insert into signal_credit_transactions")) {
    const idempotencyKey = params[1];
    const user = users.get(params[2]);
    if (!user || user.unlock_credits_balance <= 0 || creditTransactions.has(idempotencyKey)) return { rows: [] };
    creditTransactions.add(idempotencyKey);
    user.unlock_credits_balance -= 1;
    unlockState.creditDebits += 1;
    return { rows: [{ user_id: params[2], unlock_credits_balance: user.unlock_credits_balance }] };
  }
  if (normalized.includes("update credit_balances") && normalized.includes("unlock_credits_balance = unlock_credits_balance - 1")) {
    const user = users.get(params[0]);
    if (user) user.unlock_credits_balance -= 1;
    unlockState.creditDebits += 1;
    return { rows: [] };
  }
  if (normalized.includes("update users") || normalized.includes("update device_trial_history")) return { rows: [] };
  if (normalized.includes("from saved_signals s") && normalized.includes("s.id = $1") && normalized.includes("s.user_id = $2")) {
    const row = [...savedSignals.values()].find((item) => item.id === params[0] && item.user_id === params[1]);
    return { rows: row ? [structuredClone(row)] : [] };
  }

  return readyQuery(sql, params);
}

export async function transaction(callback) {
  return callback({ query });
}

function savedRow(params) {
  return {
    id: params[0],
    user_id: params[1],
    setup_key: params[2],
    symbol: params[3],
    timeframe: params[4],
    direction: params[5],
    entry_price: params[6],
    stop_loss: params[7],
    take_profit: params[8],
    risk_reward_ratio: params[9],
    confidence_score: params[10],
    quality_score: params[11],
    setup_type: params[12],
    reasoning: params[13],
    confirmations: JSON.parse(params[14]),
    indicators: JSON.parse(params[15]),
    market_source: params[16],
    generated_at: params[17],
    validation_score: params[18],
    validation_passed: params[19],
    valid_until: params[20],
    status: "Active",
    status_updated_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  };
}

function savedKey(userId, setupKey) {
  return `${userId}|${setupKey}`;
}
