import { getSignalValidityState } from "./signalValidity.js";

export const SIGNAL_STATUS_FILTERS = Object.freeze([
  ["all", "All"],
  ["active", "Active"],
  ["expiring-soon", "Expiring Soon"],
  ["hit-tp", "Hit TP"],
  ["hit-sl", "Hit SL"],
  ["expired", "Expired"],
  ["closed", "Closed"]
]);

const terminalStatuses = new Set(["hit-tp", "hit-sl", "expired", "closed", "manually-closed"]);
const validStatuses = new Set(SIGNAL_STATUS_FILTERS.map(([value]) => value));
const validDateRanges = new Set(["all", "today", "7d", "30d", "90d"]);
const validSorts = new Set(["newest", "oldest", "confidence", "risk-reward", "best-result", "worst-result"]);
const validTimeframes = new Set(["all", "1m", "5m", "15m", "1h", "4h"]);

export function createSignalFilters(overrides = {}) {
  return {
    status: validStatuses.has(overrides.status) ? overrides.status : "all",
    pair: String(overrides.pair || "all"),
    timeframe: validTimeframes.has(overrides.timeframe) ? overrides.timeframe : "all",
    direction: ["long", "short"].includes(overrides.direction) ? overrides.direction : "all",
    strategy: String(overrides.strategy || "all"),
    dateRange: validDateRanges.has(overrides.dateRange) ? overrides.dateRange : "all",
    sort: validSorts.has(overrides.sort) ? overrides.sort : "newest",
    search: String(overrides.search || "").trim()
  };
}

export function getSignalStatusKey(signal) {
  if (signal?.statusKey && terminalStatuses.has(signal.statusKey)) return signal.statusKey;
  const outcome = normalizeSignalStatus(signal?.status ?? signal?.outcome);
  if (terminalStatuses.has(outcome)) return outcome;
  return getSignalValidityState(signal).status;
}

export function normalizeSignalStatus(value) {
  const normalized = String(value || "active")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (["hit-tp", "tp", "take-profit", "takeprofit"].includes(normalized)) return "hit-tp";
  if (["hit-sl", "sl", "stop-loss", "stoploss"].includes(normalized)) return "hit-sl";
  if (["expired", "expire", "timed-out", "timeout"].includes(normalized)) return "expired";
  if (["manually-closed", "manual-close", "manual-closed"].includes(normalized)) return "manually-closed";
  if (normalized === "closed") return "closed";
  return "active";
}

export function normalizeSignal(signal = {}) {
  return { ...signal, statusKey: getSignalStatusKey(signal) };
}

export function getSignalStatusCounts(signals = []) {
  const counts = { all: signals.length, active: 0, "expiring-soon": 0, "hit-tp": 0, "hit-sl": 0, expired: 0, closed: 0 };
  for (const signal of signals) {
    const status = getSignalStatusKey(signal);
    if (["active", "expiring-soon"].includes(status)) counts.active += 1;
    if (status === "expiring-soon") counts["expiring-soon"] += 1;
    if (status === "hit-tp") counts["hit-tp"] += 1;
    if (status === "hit-sl") counts["hit-sl"] += 1;
    if (status === "expired") counts.expired += 1;
    if (terminalStatuses.has(status)) counts.closed += 1;
  }
  return counts;
}

export function getSignalSummary(signals = []) {
  const counts = getSignalStatusCounts(signals);
  return {
    totalSignals: counts.all,
    winRate: counts.closed ? Math.round((counts["hit-tp"] / counts.closed) * 100) : 0,
    hitTpCount: counts["hit-tp"],
    hitSlCount: counts["hit-sl"],
    expiredCount: counts.expired,
    closedCount: counts.closed
  };
}

export function filterAndSortSignals(signals = [], filters = {}, markets = [], now = new Date()) {
  const normalized = createSignalFilters(filters);
  const cutoff = getDateCutoff(normalized.dateRange, now);
  const query = normalizeSearch(normalized.search);
  const filtered = signals.filter((signal) => {
    const status = getSignalStatusKey(signal);
    const createdAt = getSignalTimestamp(signal);
    return matchesStatus(status, normalized.status) &&
      (normalized.pair === "all" || signal.symbol === normalized.pair) &&
      (normalized.timeframe === "all" || signal.timeframe === normalized.timeframe) &&
      (normalized.direction === "all" || String(signal.direction).toLowerCase() === normalized.direction) &&
      (normalized.strategy === "all" || String(signal.setupType || "") === normalized.strategy) &&
      (!cutoff || createdAt >= cutoff) &&
      (!query || buildSearchText(signal, markets).includes(query));
  });

  return filtered.sort(getSignalSorter(normalized.sort));
}

export function filtersFromSignalParams(params, signals = []) {
  const activeDefault = signals.some((signal) => ["active", "expiring-soon"].includes(getSignalStatusKey(signal))) ? "active" : "all";
  return createSignalFilters({
    status: params.has("status") ? normalizeStatusFilter(params.get("status")) : activeDefault,
    pair: params.get("pair") || "all",
    timeframe: params.get("timeframe") || "all",
    direction: params.get("direction") || "all",
    strategy: params.get("strategy") || "all",
    dateRange: params.get("date") || "all",
    sort: params.get("sort") || "newest",
    search: params.get("q") || ""
  });
}

export function signalFiltersToParams(filters, existing = new URLSearchParams()) {
  const params = new URLSearchParams(existing);
  for (const key of ["status", "pair", "timeframe", "direction", "strategy", "date", "sort", "q"]) {
    params.delete(key);
  }
  const normalized = createSignalFilters(filters);
  // Keep status=all explicit so route re-processing never reapplies the initial Active default.
  params.set("status", normalized.status.replaceAll("-", "_"));
  if (normalized.pair !== "all") params.set("pair", normalized.pair);
  if (normalized.timeframe !== "all") params.set("timeframe", normalized.timeframe);
  if (normalized.direction !== "all") params.set("direction", normalized.direction);
  if (normalized.strategy !== "all") params.set("strategy", normalized.strategy);
  if (normalized.dateRange !== "all") params.set("date", normalized.dateRange);
  if (normalized.sort !== "newest") params.set("sort", normalized.sort);
  if (normalized.search) params.set("q", normalized.search);
  return params;
}

function normalizeStatusFilter(value) {
  const normalized = String(value || "").trim().toLowerCase().replaceAll("_", "-");
  return validStatuses.has(normalized) ? normalized : "all";
}

export function getSignalResultR(signal) {
  for (const value of [signal?.resultR, signal?.realizedR, signal?.rMultiple]) {
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) return Number(value);
  }
  const status = getSignalStatusKey(signal);
  if (status === "hit-tp") return Number(signal?.riskRewardRatio || 0);
  if (status === "hit-sl") return -1;
  return 0;
}

function matchesStatus(status, filter) {
  if (filter === "all") return true;
  if (filter === "active") return ["active", "expiring-soon"].includes(status);
  if (filter === "closed") return terminalStatuses.has(status);
  return status === filter;
}

function getSignalSorter(sort) {
  const newest = (a, b) => getSignalTimestamp(b) - getSignalTimestamp(a);
  if (sort === "oldest") return (a, b) => getSignalTimestamp(a) - getSignalTimestamp(b);
  if (sort === "confidence") return (a, b) => Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0) || newest(a, b);
  if (sort === "risk-reward") return (a, b) => Number(b.riskRewardRatio || 0) - Number(a.riskRewardRatio || 0) || newest(a, b);
  if (sort === "best-result") return (a, b) => getSignalResultR(b) - getSignalResultR(a) || newest(a, b);
  if (sort === "worst-result") return (a, b) => getSignalResultR(a) - getSignalResultR(b) || newest(a, b);
  return newest;
}

function getSignalTimestamp(signal) {
  const value = new Date(signal?.generatedAt || signal?.createdAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function getDateCutoff(range, now) {
  const end = new Date(now);
  if (range === "today") {
    return Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  }
  const days = { "7d": 7, "30d": 30, "90d": 90 }[range];
  return days ? end.getTime() - days * 24 * 60 * 60 * 1000 : null;
}

function buildSearchText(signal, markets) {
  const market = markets.find((item) => item.symbol === signal.symbol) || {};
  return normalizeSearch([
    signal.symbol,
    String(signal.symbol || "").replaceAll("-", "").replaceAll("/", ""),
    market.displaySymbol,
    market.name,
    market.providerLabel,
    market.provider === "coinbase-exchange" ? `Coinbase ${signal.symbol}` : "",
    signal.setupType,
    signal.notes,
    signal.reasoning,
    signal.shortReason,
    signal.aiAnalysis?.summary,
    signal.aiExplanation
  ].filter(Boolean).join(" "));
}

function normalizeSearch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
