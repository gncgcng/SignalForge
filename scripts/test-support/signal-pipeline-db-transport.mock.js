const nowIso = () => new Date().toISOString();

export const transportState = {
  calls: [],
  generatedSignals: new Map(),
  telegramSettings: new Map(),
  telegramQueue: [],
  claimable: true
};

export function resetDatabaseTransport() {
  transportState.calls.length = 0;
  transportState.generatedSignals.clear();
  transportState.telegramSettings.clear();
  transportState.telegramQueue.length = 0;
  transportState.claimable = true;
}

export function setTelegramSettings(userId, overrides = {}) {
  transportState.telegramSettings.set(userId, {
    user_id: userId,
    chat_id: "10001",
    enabled: true,
    favorite_markets_only: false,
    timeframes: ["15m"],
    direction: "both",
    minimum_confidence: 90,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides
  });
}

export function getGeneratedTransportRow(dedupeKey) {
  return clone(transportState.generatedSignals.get(String(dedupeKey).toLowerCase()) || null);
}

export function getTelegramQueueRows() {
  return clone(transportState.telegramQueue);
}

export async function query(sql, params = []) {
  const normalized = normalizeSql(sql);
  transportState.calls.push({ sql: normalized, params: clone(params) });

  if (normalized.includes("insert into generated_signals")) {
    return upsertGeneratedSignal(params, normalized);
  }
  if (normalized.includes("update generated_signals set") && normalized.includes("status = case") && normalized.includes("where id = $1 returning *")) {
    return updateGeneratedSignalStatus(params);
  }
  if (normalized.includes("insert into signal_confidence_adjustments")) {
    return { rows: [] };
  }
  if (normalized.includes("from telegram_notification_settings") && normalized.includes("where user_id = $1")) {
    const row = transportState.telegramSettings.get(params[0]);
    return { rows: row ? [clone(row)] : [] };
  }
  if (normalized.includes("from user_watchlists")) {
    return { rows: [] };
  }
  if (normalized.includes("insert into telegram_notification_queue")) {
    const duplicate = transportState.telegramQueue.find((row) => row.user_id === params[1] && row.setup_key === params[2]);
    if (duplicate) return { rows: [] };
    const row = {
      id: params[0],
      user_id: params[1],
      setup_key: params[2],
      chat_id: params[3],
      payload: parseJson(params[4]),
      status: "queued",
      attempts: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
      next_attempt_at: nowIso(),
      sent_at: null,
      last_error: null
    };
    transportState.telegramQueue.push(row);
    transportState.claimable = true;
    return { rows: [{ id: row.id }] };
  }
  if (normalized.includes("select q.*") && normalized.includes("telegram_notification_queue q")) {
    if (!transportState.claimable) return { rows: [] };
    const row = transportState.telegramQueue.find((item) => ["queued", "failed"].includes(item.status));
    return { rows: row ? [clone(row)] : [] };
  }
  if (normalized.includes("set status = 'sending'")) {
    updateQueue(params[0], (row) => {
      row.status = "sending";
      row.attempts += 1;
      row.updated_at = nowIso();
    });
    return { rows: [] };
  }
  if (normalized.includes("set status = 'sent'")) {
    updateQueue(params[0], (row) => {
      row.status = "sent";
      row.sent_at = nowIso();
      row.last_error = null;
      row.updated_at = nowIso();
    });
    transportState.claimable = false;
    return { rows: [] };
  }
  if (normalized.includes("set status = 'failed'") && normalized.includes("last_error = $2")) {
    updateQueue(params[0], (row) => {
      row.status = "failed";
      row.last_error = params[1];
      row.updated_at = nowIso();
    });
    transportState.claimable = false;
    return { rows: [] };
  }

  return { rows: [] };
}

export async function transaction(callback) {
  return callback({ query });
}

function upsertGeneratedSignal(params, sql) {
  const incoming = {
    id: params[0],
    signal_id: params[1],
    dedupe_key: params[2],
    setup_key: params[3],
    pair: params[4],
    display_pair: params[5],
    provider: params[6],
    timeframe: params[7],
    direction: params[8],
    strategy: params[9],
    pattern: params[10],
    pattern_context: parseJson(params[11]),
    entry: params[12],
    stop_loss: params[13],
    take_profit: params[14],
    risk_reward: params[15],
    confidence: params[16],
    original_confidence: params[17],
    confidence_calibration: parseJson(params[18]),
    calibrated_confidence: params[19],
    confidence_version: params[20],
    calibration_reason: params[21],
    setup_quality_score: params[22],
    entry_readiness_score: params[23],
    status: params[24],
    valid_until: params[25],
    source: params[26],
    source_history: [params[26]],
    generated_by: params[27],
    promoted_from_candidate_id: params[28],
    validation_summary: parseJson(params[29]),
    warning_reasons: parseJson(params[30]),
    quality_breakdown: parseJson(params[31]),
    full_analysis: parseJson(params[32]),
    result_reason: params[33],
    created_at: params[34],
    updated_at: nowIso()
  };
  const key = String(incoming.dedupe_key).toLowerCase();
  const existing = transportState.generatedSignals.get(key);

  if (!existing) {
    transportState.generatedSignals.set(key, incoming);
    return { rows: [clone(incoming)] };
  }

  const updated = {
    ...existing,
    source_history: [...new Set([...(existing.source_history || []), incoming.source])],
    promoted_from_candidate_id: existing.promoted_from_candidate_id || incoming.promoted_from_candidate_id,
    source: conflictValue(sql, "source", existing, incoming),
    status: conflictValue(sql, "status", existing, incoming),
    entry: conflictValue(sql, "entry", existing, incoming),
    stop_loss: conflictValue(sql, "stop_loss", existing, incoming),
    take_profit: conflictValue(sql, "take_profit", existing, incoming),
    risk_reward: conflictValue(sql, "risk_reward", existing, incoming),
    valid_until: conflictValue(sql, "valid_until", existing, incoming),
    confidence: conflictValue(sql, "confidence", existing, incoming),
    original_confidence: existing.original_confidence ?? incoming.original_confidence,
    confidence_calibration: conflictValue(sql, "confidence_calibration", existing, incoming),
    calibrated_confidence: conflictValue(sql, "calibrated_confidence", existing, incoming),
    confidence_version: conflictValue(sql, "confidence_version", existing, incoming),
    calibration_reason: conflictValue(sql, "calibration_reason", existing, incoming),
    validation_summary: conflictValue(sql, "validation_summary", existing, incoming),
    warning_reasons: conflictValue(sql, "warning_reasons", existing, incoming),
    quality_breakdown: conflictValue(sql, "quality_breakdown", existing, incoming),
    full_analysis: conflictValue(sql, "full_analysis", existing, incoming),
    result_reason: incoming.result_reason ?? existing.result_reason,
    updated_at: nowIso()
  };
  transportState.generatedSignals.set(key, updated);
  return { rows: [clone(updated)] };
}

function conflictValue(sql, column, existing, incoming) {
  const pattern = new RegExp(`(?:set|,) ${column} = excluded\\.${column}(?:,| )`);
  return pattern.test(sql) ? incoming[column] : existing[column];
}

function updateGeneratedSignalStatus(params) {
  const [id, requestedStatus, requestedPriority, resolvedAt, reason] = params;
  const row = [...transportState.generatedSignals.values()].find((item) => item.id === id);
  if (!row) return { rows: [] };

  const priority = { "Hit TP": 6, "Hit SL": 5, "Manually closed": 4, Expired: 3, Active: 2 };
  const existingPriority = priority[row.status] || 2;
  if (existingPriority <= Number(requestedPriority || 2)) row.status = requestedStatus;
  if (requestedStatus === "Hit TP" && !row.hit_tp_at) row.hit_tp_at = resolvedAt;
  if (requestedStatus === "Hit SL" && !row.hit_sl_at) row.hit_sl_at = resolvedAt;
  if (requestedStatus === "Manually closed" && !row.manually_closed_at) row.manually_closed_at = resolvedAt;
  if (requestedStatus === "Expired" && !["Hit TP", "Hit SL", "Manually closed"].includes(row.status) && !row.expired_at) {
    row.expired_at = resolvedAt;
  }
  if (reason != null) row.result_reason = reason;
  row.updated_at = nowIso();
  return { rows: [clone(row)] };
}

function updateQueue(id, update) {
  const row = transportState.telegramQueue.find((item) => item.id === id);
  if (row) update(row);
}

function normalizeSql(value) {
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function parseJson(value) {
  if (value == null || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}
