export const signalValidityMsByTimeframe = Object.freeze({
  "1m": 30 * 60 * 1000,
  "5m": 2 * 60 * 60 * 1000,
  "15m": 6 * 60 * 60 * 1000,
  "1h": 24 * 60 * 60 * 1000,
  "4h": 48 * 60 * 60 * 1000
});

export function getSignalValidityMs(timeframe) {
  return signalValidityMsByTimeframe[timeframe] || signalValidityMsByTimeframe["15m"];
}

export function getSignalValidUntil(signal) {
  const persisted = new Date(signal?.validUntil || signal?.valid_until || 0).getTime();
  if (Number.isFinite(persisted) && persisted > 0) return new Date(persisted).toISOString();
  const generatedAt = new Date(signal?.generatedAt || signal?.generated_at || Date.now()).getTime();
  return new Date(generatedAt + getSignalValidityMs(signal?.timeframe)).toISOString();
}

export function withSignalValidity(signal) {
  return {
    ...signal,
    validUntil: getSignalValidUntil(signal),
    validityDurationMs: getSignalValidityMs(signal?.timeframe)
  };
}

export function isSignalExpired(signal, now = Date.now()) {
  const status = String(signal?.status || "Active").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["hit-tp", "hit-sl", "closed", "manually-closed", "expired"].includes(status)) {
    return status === "expired";
  }
  return new Date(getSignalValidUntil(signal)).getTime() <= Number(now);
}

export function assertSignalFresh(signal, now = Date.now()) {
  if (!isSignalExpired(signal, now)) return;
  const error = new Error("This signal has expired and is no longer valid as a fresh setup.");
  error.code = "SIGNAL_EXPIRED";
  error.statusCode = 410;
  throw error;
}

export function formatSignalValidityWindow(timeframe) {
  const minutes = getSignalValidityMs(timeframe) / 60000;
  if (minutes < 60) return `${minutes}m`;
  return `${minutes / 60}h`;
}
