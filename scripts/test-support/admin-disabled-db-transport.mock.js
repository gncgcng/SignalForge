// Layers the admin-disabled test's boundaries over the auto-crypto-watcher transport: the
// signal_strategy_statuses override loader, validation-rejection capture, the scan cache and Telegram payload
// lookups used by the unlock paths, and a sentinel at the unlock save so a test can see a flow get past the gate.
import {
  getTelegramQueueRows
} from "./signal-pipeline-db-transport.mock.js";
import { query as watcherQuery } from "./auto-crypto-watcher-db-transport.mock.js";

export * from "./auto-crypto-watcher-db-transport.mock.js";

export const UNLOCK_SAVE_REACHED = "UNLOCK_SAVE_REACHED";

let overrideRows = [];
let overrideLoads = 0;
let groupStats = new Map();
let aggregateRows = [];
const rejections = [];
const scanCache = new Map();
const statusWrites = [];

export function setAdminOverrideRows(rows) { overrideRows = structuredClone(rows); }
export function getAdminOverrideLoads() { return overrideLoads; }
export function setGroupStats(where, value, row) { groupStats.set(`${where}|${value}`, row); }
export function clearGroupStats() { groupStats = new Map(); }
export function getValidationRejections() { return structuredClone(rejections); }
export function clearValidationRejections() { rejections.length = 0; }
export function setCachedScanResult(userId, scanKey, result) { scanCache.set(`${userId}|${scanKey}`, structuredClone(result)); }
export function setAggregateRows(rows) { aggregateRows = structuredClone(rows); }
export function getStatusWrites() { return structuredClone(statusWrites); }
export function clearStatusWrites() { statusWrites.length = 0; }

export async function query(sql, params = []) {
  const normalized = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.includes("from signal_strategy_statuses where status = 'disabled_by_admin'")) {
    overrideLoads += 1;
    return { rows: structuredClone(overrideRows.filter((row) => row.status === "disabled_by_admin")) };
  }
  if (normalized.includes(" as group_value,") && normalized.includes("group by group_value")) {
    return { rows: structuredClone(aggregateRows) };
  }
  if (normalized.includes("insert into signal_strategy_statuses")) {
    statusWrites.push({ groupKey: params[0], groupType: params[1], status: params[3] });
    return { rows: [{ group_key: params[0], group_type: params[1], group_value: params[2], status: params[3] }] };
  }
  if (normalized.includes("insert into signal_validation_rejections")) {
    rejections.push({ symbol: params[3], timeframe: params[4], direction: params[5], strategy: params[6], reasons: JSON.parse(params[10]), source: params[11] });
    return { rows: [] };
  }
  if (normalized.includes("from generated_signals where direction = $1") && normalized.includes("total_signals")) {
    const row = groupStats.get(`direction|${params[0]}`);
    if (row) return { rows: [structuredClone(row)] };
  }
  if (normalized.includes("from telegram_notification_queue") && normalized.includes("setup_key = $2")) {
    const row = getTelegramQueueRows().find((item) => String(item.user_id) === String(params[0]) && item.setup_key === params[1]);
    return { rows: row ? [{ payload: structuredClone(row.payload) }] : [] };
  }
  if (normalized.includes("from scan_result_cache") && normalized.includes("scan_key = $2")) {
    const result = scanCache.get(`${params[0]}|${params[1]}`);
    return { rows: result ? [{ result_json: structuredClone(result) }] : [] };
  }
  if (normalized.includes("pg_advisory_xact_lock")) {
    const error = new Error("unlock reached saveUnlockedSignal");
    error.code = UNLOCK_SAVE_REACHED;
    throw error;
  }
  return watcherQuery(sql, params);
}

export async function transaction(callback) {
  return callback({ query });
}
