const terminalStatuses = new Set(["hit-tp", "hit-sl", "expired", "closed", "manually-closed"]);

export function getSignalValidityState(signal, now = Date.now()) {
  const outcome = normalizeStatus(signal?.status ?? signal?.outcome);
  if (terminalStatuses.has(outcome)) return { status: outcome, remainingMs: 0, expiringSoon: false };

  const validUntilMs = new Date(signal?.validUntil || 0).getTime();
  if (!Number.isFinite(validUntilMs) || validUntilMs <= 0) {
    return { status: "active", remainingMs: null, expiringSoon: false };
  }
  const remainingMs = validUntilMs - Number(now);
  if (remainingMs <= 0) return { status: "expired", remainingMs: 0, expiringSoon: false };
  const durationMs = Number(signal?.validityDurationMs) || Math.max(0, validUntilMs - new Date(signal?.generatedAt || 0).getTime());
  const thresholdMs = Math.max(30 * 60 * 1000, durationMs * 0.2);
  const expiringSoon = remainingMs <= thresholdMs;
  return { status: expiringSoon ? "expiring-soon" : "active", remainingMs, expiringSoon };
}

export function formatSignalCountdown(signal, now = Date.now()) {
  const validity = getSignalValidityState(signal, now);
  if (validity.status === "expired") return "Expired";
  if (validity.remainingMs === null) return "Validity unavailable";
  const totalMinutes = Math.max(1, Math.ceil(validity.remainingMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function normalizeStatus(value) {
  const status = String(value || "active").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["hit-tp", "tp", "take-profit", "takeprofit"].includes(status)) return "hit-tp";
  if (["hit-sl", "sl", "stop-loss", "stoploss"].includes(status)) return "hit-sl";
  if (["expired", "expire", "timed-out", "timeout"].includes(status)) return "expired";
  if (["manually-closed", "manual-close", "manual-closed"].includes(status)) return "manually-closed";
  return status === "closed" ? "closed" : "active";
}
