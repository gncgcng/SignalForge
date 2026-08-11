const scanCache = new Map();
const savedSignals = new Map();
const users = new Map();

export const unlockTransportState = {
  calls: [],
  creditDebits: 0,
  savedSignalInserts: 0
};

export function resetUnlockTransport() {
  scanCache.clear();
  savedSignals.clear();
  users.clear();
  unlockTransportState.calls.length = 0;
  unlockTransportState.creditDebits = 0;
  unlockTransportState.savedSignalInserts = 0;
}

export function seedUnlockUser(user) {
  users.set(user.id, {
    role: user.role || "user",
    email_verified_at: user.emailVerifiedAt || new Date().toISOString(),
    unlock_credits_balance: Number(user.unlockCreditsBalance || 0)
  });
}

export function seedScanAllCache(userId, scanKey, result) {
  scanCache.set(cacheKey(userId, scanKey), structuredClone(result));
}

export function getUnlockPersistence() {
  return {
    creditDebits: unlockTransportState.creditDebits,
    savedSignalInserts: unlockTransportState.savedSignalInserts,
    savedSignals: structuredClone([...savedSignals.values()]),
    calls: structuredClone(unlockTransportState.calls)
  };
}

export async function query(sql, params = []) {
  const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
  unlockTransportState.calls.push({ sql: normalized, params: structuredClone(params) });

  if (normalized.includes("select result_json") && normalized.includes("from scan_result_cache") && normalized.includes("scan_key = $2")) {
    const result = scanCache.get(cacheKey(params[0], params[1]));
    return { rows: result ? [{ result_json: structuredClone(result) }] : [] };
  }
  if (normalized.includes("jsonb_array_elements") && normalized.includes("from scan_result_cache")) {
    const setup = findCachedSetup(params[0], params[1]);
    return { rows: setup ? [{ setup }] : [] };
  }
  if (normalized.includes("insert into scan_result_cache")) {
    scanCache.set(cacheKey(params[0], params[1]), JSON.parse(params[2]));
    return { rows: [] };
  }
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
    unlockTransportState.savedSignalInserts += 1;
    return { rows: [] };
  }
  if (normalized.includes("insert into unlocked_signals") || normalized.includes("insert into signal_outcomes")) {
    return { rows: [] };
  }
  if (normalized.includes("update credit_balances") && normalized.includes("unlock_credits_balance = unlock_credits_balance - 1")) {
    const user = users.get(params[0]);
    if (user) user.unlock_credits_balance -= 1;
    unlockTransportState.creditDebits += 1;
    return { rows: [] };
  }
  if (normalized.includes("update users") || normalized.includes("update device_trial_history")) return { rows: [] };
  if (normalized.includes("from saved_signals s") && normalized.includes("s.id = $1") && normalized.includes("s.user_id = $2")) {
    const row = [...savedSignals.values()].find((item) => item.id === params[0] && item.user_id === params[1]);
    return { rows: row ? [structuredClone(row)] : [] };
  }
  return { rows: [] };
}

export async function transaction(callback) {
  return callback({ query });
}

function findCachedSetup(userId, setupKey) {
  for (const [key, value] of scanCache.entries()) {
    if (!key.startsWith(`${userId}|scan-all:`)) continue;
    const setup = (value.fullSetups || []).find((item) => item.setupKey === setupKey);
    if (setup) return structuredClone(setup);
  }
  return null;
}

function savedRow(params) {
  return {
    id: params[0], user_id: params[1], setup_key: params[2], symbol: params[3], timeframe: params[4],
    direction: params[5], entry_price: params[6], stop_loss: params[7], take_profit: params[8],
    risk_reward_ratio: params[9], confidence_score: params[10], quality_score: params[11], setup_type: params[12],
    reasoning: params[13], confirmations: JSON.parse(params[14]), indicators: JSON.parse(params[15]),
    market_source: params[16], generated_at: params[17], validation_score: params[18], validation_passed: params[19],
    valid_until: params[20], status: "Active", status_updated_at: new Date().toISOString(), created_at: new Date().toISOString()
  };
}

function cacheKey(userId, scanKey) {
  return `${userId}|${scanKey}`;
}

function savedKey(userId, setupKey) {
  return `${userId}|${setupKey}`;
}
