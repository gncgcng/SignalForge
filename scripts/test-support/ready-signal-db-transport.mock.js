import {
  query as baseQuery,
  resetDatabaseTransport,
  transportState
} from "./signal-pipeline-db-transport.mock.js";

const candidates = new Map();

export function resetReadySignalTransport() {
  resetDatabaseTransport();
  candidates.clear();
}

export function getReadySignalPersistence() {
  return {
    generatedRows: structuredClone([...transportState.generatedSignals.values()]),
    generatedSaveCalls: structuredClone(transportState.calls.filter((call) =>
      call.sql.includes("insert into generated_signals")
    )),
    candidates: structuredClone([...candidates.values()])
  };
}

export async function query(sql, params = []) {
  const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();

  if (normalized.includes("insert into setup_candidates")) {
    return upsertCandidate(params);
  }
  if (normalized.includes("update setup_candidates") && normalized.includes("set status = 'promoted_to_signal'")) {
    return promoteCandidate(params);
  }
  if (normalized.includes("update setup_candidates") && normalized.includes("set status = 'rejected'")) {
    return rejectCandidate(params);
  }

  return baseQuery(sql, params);
}

export async function transaction(callback) {
  return callback({ query });
}

function upsertCandidate(params) {
  const incoming = {
    id: params[0],
    setup_key: params[1],
    symbol: params[2],
    display_pair: params[3],
    provider: params[4],
    timeframe: params[5],
    direction: params[6],
    setup_type: params[7],
    status: params[8],
    expires_at: params[9],
    candidate_score: params[10],
    setup_quality_score: params[11],
    readiness_score: params[12],
    entry_readiness_score: params[13],
    confidence_estimate: params[14],
    entry_quality: params[15],
    current_price: params[16],
    ideal_entry: params[17],
    ideal_entry_zone: parseJson(params[18]),
    ideal_entry_zone_low: params[19],
    ideal_entry_zone_high: params[20],
    invalidation_level: params[21],
    potential_stop_loss: params[22],
    potential_take_profit: params[23],
    potential_rr: params[24],
    reasons_for_watching: parseJson(params[25]),
    missing_confirmations: parseJson(params[26]),
    next_conditions: parseJson(params[27]),
    rejection_reason: params[28],
    promoted_signal_id: params[29],
    metadata: parseJson(params[30]),
    first_detected_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const existing = candidates.get(incoming.setup_key);
  const row = existing
    ? { ...existing, ...incoming, id: existing.id, first_detected_at: existing.first_detected_at }
    : incoming;
  candidates.set(row.setup_key, row);
  return { rows: [structuredClone(row)] };
}

function promoteCandidate([candidateId, signalId]) {
  const row = [...candidates.values()].find((candidate) => candidate.id === candidateId);
  if (!row || !["watching", "almost_ready", "ready"].includes(row.status)) return { rows: [] };
  row.status = "promoted_to_signal";
  row.promoted_signal_id = signalId;
  row.last_checked_at = new Date().toISOString();
  row.updated_at = row.last_checked_at;
  return { rows: [structuredClone(row)] };
}

function rejectCandidate([candidateId, reason]) {
  const row = [...candidates.values()].find((candidate) => candidate.id === candidateId);
  if (!row || !["watching", "almost_ready", "ready"].includes(row.status)) return { rows: [] };
  row.status = "rejected";
  row.rejection_reason = reason;
  row.last_checked_at = new Date().toISOString();
  row.updated_at = row.last_checked_at;
  return { rows: [structuredClone(row)] };
}

function parseJson(value) {
  if (value == null || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
