// Track-record statistics for the setup cards. Pure: no I/O, no clock, seeded randomness only.
// Inputs are replay-harness records (scripts/replay on research/replay-harness): one resolved signal each, with
// { strategy, direction, timeframe, createdAtMs, entryPrice, stopLoss, riskReward, outcome: { status, realizedR } }.
import {
  BOOTSTRAP,
  LABELS,
  MIN_CASES,
  monthBlockBootstrap,
  seededRandom,
  trackRecordLabel,
  wilsonInterval
} from "../../../public/trackRecordStats.js";

// The label rules, Wilson interval and month-block bootstrap live in public/trackRecordStats.js so the browser can
// measure a user's own trades ("My trades") with exactly the same rules. Re-exported here unchanged.
export { BOOTSTRAP, LABELS, MIN_CASES, monthBlockBootstrap, seededRandom, trackRecordLabel };

export const SCHEMA = "signalforge.track-records";
export const SCHEMA_VERSION = 1;
export const ALL_SETUPS_KEY = "all-setups";
export const FEES = Object.freeze({
  headlineRoundTrip: 0.002, // the harness's higher fee setting
  retailRoundTrip: 0.012 // Coinbase retail taker, about 0.6% per side
});

// A round-trip fee as a fraction of price, in R: fee / stop distance (both as fractions of entry). Same formula as
// the harness's feeInR. Returns null when the stop distance is unusable.
export function feeInR({ entryPrice, stopLoss }, roundTrip) {
  const entry = Number(entryPrice);
  const stopFraction = Math.abs(entry - Number(stopLoss)) / entry;
  return Number.isFinite(stopFraction) && stopFraction > 0 ? roundTrip / stopFraction : null;
}

// ---- record statistics ----

const round = (value, digits = 3) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const monthOf = (record) => new Date(record.createdAtMs).toISOString().slice(0, 7);
const yearOf = (record) => new Date(record.createdAtMs).getUTCFullYear();

export function isResolved(record) {
  return Boolean(record?.outcome) && ["Hit TP", "Hit SL", "Expired"].includes(record.outcome.status) &&
    Number.isFinite(Number(record.outcome.realizedR));
}

function netR(record, roundTrip) {
  const fee = feeInR(record, roundTrip);
  return fee == null ? null : Number(record.outcome.realizedR) - fee;
}

// n = TP + SL (decided cases). Expired setups are counted separately, but every resolved setup (expired included,
// which pays fees and earns 0R) is part of the per-trade average, as in the harness.
export function summarizeRecord(records, { bootstrap = BOOTSTRAP } = {}) {
  const tp = records.filter((record) => record.outcome.status === "Hit TP").length;
  const sl = records.filter((record) => record.outcome.status === "Hit SL").length;
  const expired = records.filter((record) => record.outcome.status === "Expired").length;
  const n = tp + sl;
  const headline = records.map((record) => netR(record, FEES.headlineRoundTrip));
  const retail = records.map((record) => netR(record, FEES.retailRoundTrip));
  const stopsAvailable = headline.every((value) => value != null);
  const planned = records.map((record) => Number(record.riskReward)).filter((value) => Number.isFinite(value) && value > 0);
  const avgPlannedR = mean(planned);
  const winRate95 = wilsonInterval(tp, n);
  const interval = stopsAvailable
    ? monthBlockBootstrap(records.map((record, index) => ({ month: monthOf(record), r: headline[index] })), bootstrap)
    : null;
  const avgR95 = interval ? { low: round(interval.low), high: round(interval.high), months: interval.months } : null;
  const years = [...new Set(records.map(yearOf))].sort((a, b) => a - b);
  const summary = {
    n,
    tp,
    sl,
    expired,
    resolved: records.length,
    winRate: n ? round((tp / n) * 100, 1) : null,
    winRate95,
    avgPlannedR: round(avgPlannedR, 2),
    breakEvenWinRate: avgPlannedR ? round(100 / (1 + avgPlannedR), 1) : null,
    grossAvgR: round(mean(records.map((record) => Number(record.outcome.realizedR)))),
    avgR: stopsAvailable ? round(mean(headline)) : null,
    avgR95,
    retailAvgR: retail.every((value) => value != null) ? round(mean(retail)) : null,
    byYear: years.map((year) => {
      const members = records.filter((record) => yearOf(record) === year);
      const values = members.map((record) => netR(record, FEES.headlineRoundTrip));
      return {
        year,
        n: members.filter((record) => record.outcome.status !== "Expired").length,
        expired: members.filter((record) => record.outcome.status === "Expired").length,
        avgR: values.every((value) => value != null) ? round(mean(values)) : null
      };
    })
  };
  return { ...summary, label: trackRecordLabel(summary) };
}

export function recordKey(strategy, direction, timeframe) {
  return `${String(strategy).trim().toLowerCase()}|${String(direction).trim().toLowerCase()}|${String(timeframe).trim().toLowerCase()}`;
}

// One record per strategy x direction x timeframe, plus one "All setups" roll-up of everything included.
export function buildTrackRecordEntries(records, { approximateTimeframes = [], bootstrap = BOOTSTRAP } = {}) {
  const resolved = records.filter(isResolved);
  const groups = new Map();
  for (const record of resolved) {
    const key = recordKey(record.strategy, record.direction, record.timeframe);
    if (!groups.has(key)) groups.set(key, { strategy: record.strategy, direction: record.direction, timeframe: record.timeframe, members: [] });
    groups.get(key).members.push(record);
  }
  const timeframeRank = { "5m": 0, "15m": 1, "1h": 2, "4h": 3 };
  const cells = [...groups.entries()]
    .sort(([, a], [, b]) => a.strategy.localeCompare(b.strategy) || a.direction.localeCompare(b.direction) ||
      (timeframeRank[a.timeframe] ?? 9) - (timeframeRank[b.timeframe] ?? 9))
    .map(([key, group]) => ({
      key,
      scope: "setup",
      strategy: group.strategy,
      direction: group.direction,
      timeframe: group.timeframe,
      approximate: approximateTimeframes.includes(group.timeframe),
      ...summarizeRecord(group.members, { bootstrap })
    }));
  const allSetups = {
    key: ALL_SETUPS_KEY,
    scope: "all",
    strategy: "All setups",
    direction: [...new Set(resolved.map((record) => record.direction))].sort().join("+") || null,
    timeframe: "all",
    approximate: false,
    ...summarizeRecord(resolved, { bootstrap })
  };
  return { records: [allSetups, ...cells], unresolvedExcluded: records.length - resolved.length };
}

// The published file. Everything that varies between runs is passed in, so the same inputs give the same bytes.
export function buildTrackRecordsFile(records, meta, { bootstrap = BOOTSTRAP } = {}) {
  const { records: entries, unresolvedExcluded } = buildTrackRecordEntries(records, {
    approximateTimeframes: meta.approximateTimeframes || [],
    bootstrap
  });
  const resolved = records.filter(isResolved);
  const created = resolved.map((record) => record.createdAtMs);
  const labelCounts = Object.fromEntries(Object.values(LABELS).map((label) => [label, 0]));
  for (const entry of entries) if (entry.scope === "setup") labelCounts[entry.label] += 1;
  return {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    generated_at: meta.generatedAt,
    harness: meta.harness,
    variant: meta.variant,
    period: {
      from: created.length ? new Date(Math.min(...created)).toISOString().slice(0, 10) : null,
      to: created.length ? new Date(Math.max(...created)).toISOString().slice(0, 10) : null,
      holdoutIncluded: true,
      note: "Every replayed month is included, the research hold-out too. This describes history; it is not a test."
    },
    pairs: [...meta.pairs].sort(),
    timeframes: meta.timeframes,
    approximateTimeframes: meta.approximateTimeframes || [],
    directions: meta.directions,
    fees: {
      headlineRoundTrip: FEES.headlineRoundTrip,
      retailRoundTrip: FEES.retailRoundTrip,
      retailAvailable: entries.every((entry) => entry.retailAvgR != null),
      method: "Fee in R = round-trip fee / stop distance, both as a fraction of the entry price. Applied to every resolved setup, expired ones included."
    },
    statistics: {
      n: "TP + SL. Expired setups are reported separately.",
      winRate: "TP / (TP + SL), with a Wilson 95% interval.",
      breakEvenWinRate: "1 / (1 + the record's average planned reward-to-risk).",
      avgR: "Average R per resolved setup after the headline fee, expired ones included (TP = planned R, SL = -1R, expired = 0R).",
      avgR95: `95% interval from a block bootstrap by calendar month (${bootstrap.samples} samples, seed ${bootstrap.seed}).`
    },
    labelRules: [
      `n < ${MIN_CASES}: "${LABELS.notEnoughHistory}"`,
      `upper 95% bound of average R after fees < 0: "${LABELS.lostMoney}"`,
      `lower 95% bound > 0: "${LABELS.madeMoney}"`,
      `otherwise: "${LABELS.noClearEdge}"`
    ],
    labelCounts,
    fidelity: meta.fidelity,
    counts: { resolvedSetups: resolved.length, unresolvedExcluded, records: entries.length },
    records: entries
  };
}
