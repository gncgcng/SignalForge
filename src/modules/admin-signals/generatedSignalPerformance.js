const terminalStatuses = new Set(["Hit TP", "Hit SL", "Expired"]);
const groupings = new Set(["day", "week", "month"]);
const categoryDimensions = new Set(["strategy", "timeframe", "direction", "pattern", "confidence", "source", "symbol"]);

export function buildGeneratedSignalPerformance(records = [], options = {}) {
  const now = validDate(options.now) || new Date();
  const timezone = normalizePerformanceTimezone(options.timezone);
  const grouping = groupings.has(options.grouping) ? options.grouping : "day";
  const category = categoryDimensions.has(options.category) ? options.category : "strategy";
  const range = resolvePerformanceRange(options.range || "30d", options.from, options.to, now, timezone);
  const terminal = records.map(normalizeRecord).filter((record) => terminalStatuses.has(record.status));
  const missingOutcomeTimestamp = terminal.filter((record) => !record.outcomeAt).length;
  const datedInRange = terminal.filter((record) => record.outcomeAt && inRange(record.outcomeAt, range));
  const performanceRecords = range.key === "all" ? terminal : datedInRange;
  const timeline = groupRecords(datedInRange, grouping, timezone);
  let cumulativeR = 0;
  const timelineWithCumulative = timeline.map((period) => {
    cumulativeR += period.netRealizedR;
    return { ...period, cumulativeRealizedR: round(cumulativeR) };
  });

  return {
    range: { key: range.key, from: range.from?.toISOString() || null, to: range.to?.toISOString() || null, toExclusive: Boolean(range.toExclusive), timezone },
    grouping,
    category,
    semantics: {
      outcomeTimestamp: `Canonical terminal timestamp grouped in ${timezone}; undated legacy outcomes remain in All totals only`,
      winRate: "Hit TP / (Hit TP + Hit SL); Expired excluded",
      netRealizedR: "Sum of available canonical realized_r values",
      expectancy: "Net realized R / terminal outcomes with available realized_r"
    },
    metrics: summarizeRecords(performanceRecords),
    dataQuality: {
      terminalRecordsConsidered: performanceRecords.length,
      timelineRecordsConsidered: datedInRange.length,
      missingOutcomeTimestamp,
      missingRealizedR: performanceRecords.filter((record) => record.realizedR == null).length
    },
    timeline: timelineWithCumulative,
    categories: groupCategories(performanceRecords, category),
    bestWorst: {
      day: rankPeriods(groupRecords(datedInRange, "day", timezone), 5),
      week: rankPeriods(groupRecords(datedInRange, "week", timezone), 10),
      month: rankPeriods(groupRecords(datedInRange, "month", timezone), 20)
    }
  };
}

export function resolvePerformanceRange(rangeKey, from, to, now = new Date(), requestedTimezone = "UTC") {
  const current = validDate(now);
  if (!current) throw new Error("Invalid performance reference time.");
  const timezone = normalizePerformanceTimezone(requestedTimezone);
  const key = String(rangeKey || "30d").toLowerCase();
  if (key === "all") return { key, from: null, to: current, toExclusive: false, timezone };
  if (key === "custom") {
    const startParts = parseDateParts(from);
    const endParts = parseDateParts(to);
    if (!startParts || !endParts || compareDateParts(startParts, endParts) > 0) throw new Error("A valid custom performance date range is required.");
    return {
      key,
      from: zonedDateTimeToUtc(startParts, timezone),
      to: zonedDateTimeToUtc(addLocalDays(endParts, 1), timezone),
      toExclusive: true,
      timezone
    };
  }
  const currentLocalDate = datePartsInTimezone(current, timezone);
  if (key === "ytd") return { key, from: zonedDateTimeToUtc({ year: currentLocalDate.year, month: 1, day: 1 }, timezone), to: current, toExclusive: false, timezone };
  const days = { today: 1, "7d": 7, "30d": 30, "90d": 90 }[key];
  if (!days) throw new Error("Unsupported performance date range.");
  const startParts = addLocalDays(currentLocalDate, -(days - 1));
  return {
    key,
    from: zonedDateTimeToUtc(startParts, timezone),
    to: zonedDateTimeToUtc(addLocalDays(currentLocalDate, 1), timezone),
    toExclusive: true,
    timezone
  };
}

export function normalizePerformanceTimezone(value) {
  const requested = String(value || "UTC").trim() || "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: requested }).resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function summarizeRecords(records = []) {
  const wins = records.filter((record) => record.status === "Hit TP");
  const losses = records.filter((record) => record.status === "Hit SL");
  const expired = records.filter((record) => record.status === "Expired");
  const closedSignals = wins.length + losses.length;
  const withRealizedR = records.filter((record) => record.realizedR != null);
  const winnerR = wins.filter((record) => record.realizedR != null);
  const loserR = losses.filter((record) => record.realizedR != null);
  const netRealizedR = withRealizedR.reduce((total, record) => total + record.realizedR, 0);
  const averageConfidence = records.length
    ? records.reduce((total, record) => total + record.confidence, 0) / records.length
    : null;
  return {
    signals: records.length,
    closedSignals,
    wins: wins.length,
    losses: losses.length,
    expired: expired.length,
    winRate: closedSignals ? round((wins.length / closedSignals) * 100, 1) : null,
    netRealizedR: round(netRealizedR),
    expectancyR: withRealizedR.length ? round(netRealizedR / withRealizedR.length) : null,
    averageWinnerR: winnerR.length ? round(average(winnerR.map((record) => record.realizedR))) : null,
    averageLoserR: loserR.length ? round(average(loserR.map((record) => record.realizedR))) : null,
    averageConfidence: averageConfidence == null ? null : round(averageConfidence, 1),
    realizedRObservations: withRealizedR.length,
    missingRealizedR: records.length - withRealizedR.length
  };
}

export function groupRecords(records, grouping, requestedTimezone = "UTC") {
  const timezone = normalizePerformanceTimezone(requestedTimezone);
  const buckets = new Map();
  for (const record of records) {
    const key = periodKey(record.outcomeAt, grouping, timezone);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(record);
  }
  return [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([period, items]) => ({ period, ...summarizeRecords(items) }));
}

export function rankPeriods(periods, minimumTerminalSignals) {
  const eligible = periods.filter((period) => period.signals >= minimumTerminalSignals && period.realizedRObservations >= minimumTerminalSignals);
  if (!eligible.length) return { minimumTerminalSignals, best: null, worst: null };
  const ranked = [...eligible].sort((left, right) => right.netRealizedR - left.netRealizedR || (right.expectancyR || 0) - (left.expectancyR || 0));
  return { minimumTerminalSignals, best: ranked[0], worst: ranked[ranked.length - 1] };
}

function groupCategories(records, dimension) {
  const buckets = new Map();
  for (const record of records) {
    const value = categoryValue(record, dimension);
    if (!buckets.has(value)) buckets.set(value, []);
    buckets.get(value).push(record);
  }
  return [...buckets.entries()]
    .map(([value, items]) => ({ value, filterValue: value, ...summarizeRecords(items) }))
    .sort((left, right) => right.signals - left.signals || left.value.localeCompare(right.value));
}

function normalizeRecord(record) {
  const rawRealizedR = record.realizedR ?? record.realized_r;
  const parsedR = rawRealizedR === null || rawRealizedR === undefined || rawRealizedR === "" ? null : Number(rawRealizedR);
  const rawConfidence = record.calibratedConfidence ?? record.calibrated_confidence ?? record.confidence;
  const status = String(record.status || "");
  const canonicalStatusTimestamp = status === "Hit TP"
    ? record.hitTpAt ?? record.hit_tp_at
    : status === "Hit SL"
      ? record.hitSlAt ?? record.hit_sl_at
      : status === "Expired"
        ? record.expiredAt ?? record.expired_at
        : null;
  return {
    id: record.id,
    symbol: String(record.pair || record.symbol || "Unknown"),
    timeframe: String(record.timeframe || "Unknown"),
    direction: String(record.direction || "Unknown"),
    strategy: String(record.strategy || "Unknown"),
    pattern: String(record.pattern || "No pattern"),
    source: String(record.source || "Unknown"),
    confidence: Number.isFinite(Number(rawConfidence)) ? Number(rawConfidence) : 0,
    engineVersion: String(record.confidenceVersion || record.confidence_version || "Unknown"),
    status,
    realizedR: Number.isFinite(parsedR) ? parsedR : null,
    outcomeAt: validDate(record.outcomeEvaluatedAt ?? record.outcome_evaluated_at) || validDate(canonicalStatusTimestamp)
  };
}

function categoryValue(record, dimension) {
  if (dimension === "confidence") return confidenceBucket(record.confidence);
  if (dimension === "symbol") return record.symbol;
  return record[dimension] || "Unknown";
}

function confidenceBucket(confidence) {
  if (confidence < 60) return "Below 60";
  if (confidence < 70) return "60-69";
  if (confidence < 80) return "70-79";
  if (confidence < 85) return "80-84";
  if (confidence < 90) return "85-89";
  return "90-100";
}

function periodKey(date, grouping, timezone) {
  const local = datePartsInTimezone(date, timezone);
  if (grouping === "month") return `${local.year}-${String(local.month).padStart(2, "0")}`;
  if (grouping === "week") {
    const calendarDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
    const day = calendarDate.getUTCDay() || 7;
    return formatDateParts(addLocalDays(local, -day + 1));
  }
  return formatDateParts(local);
}

function inRange(date, range) {
  const beforeEnd = !range.to || (range.toExclusive ? date < range.to : date <= range.to);
  return (!range.from || date >= range.from) && beforeEnd;
}

function parseDateParts(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return date.getUTCFullYear() === parts.year && date.getUTCMonth() === parts.month - 1 && date.getUTCDate() === parts.day ? parts : null;
}

function datePartsInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA-u-hc-h23", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}

function zonedDateTimeToUtc(parts, timezone) {
  const target = { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour || 0, minute: parts.minute || 0, second: parts.second || 0 };
  const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  let timestamp = targetAsUtc;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actual = datePartsInTimezone(new Date(timestamp), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const adjustment = targetAsUtc - actualAsUtc;
    timestamp += adjustment;
    if (adjustment === 0) return new Date(timestamp);
  }
  return new Date(timestamp);
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function compareDateParts(left, right) { return formatDateParts(left).localeCompare(formatDateParts(right)); }
function formatDateParts(parts) { return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`; }

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function average(values) { return values.reduce((total, value) => total + value, 0) / values.length; }
function round(value, digits = 3) { return Number(Number(value || 0).toFixed(digits)); }
