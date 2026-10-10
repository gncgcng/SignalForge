// Disposable, read-only diagnostic. Answers one question with signals that already resolved in production:
// do signals that went against the higher-timeframe trend explain the losses, or do signals that agreed
// with it lose just as much? SELECTs from generated_signals plus public Coinbase Exchange daily candle GETs.
// Writes nothing, changes no strategy, threshold or confluence logic. Prints aggregates only; no ids, no user data.
//
// Runs from the repo (node scripts/htf-alignment-outcome-report.js ...) or pasted standalone into /tmp inside the
// Railway container, where it loads pg and the app modules from /app (APP_ROOT overrides).
//
//   node scripts/htf-alignment-outcome-report.js --range 30d --timezone America/Los_Angeles
//   node scripts/htf-alignment-outcome-report.js --range all --timezone America/Los_Angeles --strategy momentum-breakout --direction short
//
// Population: terminal signals (Hit TP / Hit SL / Expired) whose canonical outcome timestamp is in the window
// (the admin Performance tab's membership rule, checked against buildGeneratedSignalPerformance), and that carry a
// realized_r stamped with FORWARD_OUTCOME_R_VERSION (terminal_v1_tp_rr_sl_minus1_expired_zero: TP = planned R,
// SL = -1, Expired = 0). Terminal rows without that realized R and still-Active signals are counted, not analysed.
//
// Options:
//   --range <key>      today | 7d | 30d | 90d | ytd | all | custom. Default 30d. "all" = every signal with the
//                      versioned realized R, i.e. all data since that version began (the start date is printed).
//   --from/--to <date> YYYY-MM-DD local dates, inclusive. Implies --range custom.
//   --timezone <zone>  IANA zone for the local-day window and the coverage months. Default UTC.
//   --now <ISO>        Reference time (default: now).
//   --strategy <name>  Keep only this strategy: its name, any case, with any separators (momentum-breakout).
//   --direction <dir>  Keep only long or short signals.
//   --json             Emit the report as JSON instead of text.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PERFORMANCE_MODULE = "src/modules/admin-signals/generatedSignalPerformance.js";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.APP_ROOT || (existsSync(join(scriptDirectory, "..", PERFORMANCE_MODULE)) ? join(scriptDirectory, "..") : "/app");
if (!existsSync(join(APP_ROOT, PERFORMANCE_MODULE))) {
  console.error(`HTF alignment outcome report failed: app not found at ${APP_ROOT} (set APP_ROOT to the deployed app directory).`);
  process.exit(1);
}
const appModule = (path) => import(pathToFileURL(join(APP_ROOT, path)).href);
const { Client } = createRequire(join(APP_ROOT, "package.json"))("pg");
const { buildGeneratedSignalPerformance, normalizePerformanceTimezone, summarizeRecords } = await appModule(PERFORMANCE_MODULE);
const { toPerformanceRecord, wilsonInterval } = await appModule("scripts/weekly-realized-r-decomposition.js");
const { FORWARD_OUTCOME_R_VERSION } = await appModule("src/modules/admin-signals/generatedSignalRepository.js");
const { inferMultiTimeframeDirection } = await appModule("src/modules/market-data/multiTimeframeService.js");
const { ema } = await appModule("src/modules/market-data/marketRegimeService.js");

const terminalStatuses = new Set(["Hit TP", "Hit SL", "Expired"]);
const RANGES = ["today", "7d", "30d", "90d", "ytd", "all", "custom"];
const DIRECTIONS = ["long", "short"];
const TRENDS = new Set(["long", "short", "neutral"]);
const VALUE_ARGUMENTS = ["--range", "--from", "--to", "--timezone", "--now", "--strategy", "--direction"];
const LOWER_TIMEFRAMES = new Set(["5m", "15m", "1h"]);
const NO_HIGHER_TIMEFRAME = "4h";
const BADGE_BUCKETS = { "Full Alignment": "badge_full", "Partial Alignment": "badge_partial", Countertrend: "badge_countertrend" };
const ALL = "All strategies";
const BOTH = "both";
const MIN_DECIDED = 30;
const CLEAR_AVG_R_MARGIN = 0.3;
const Z95 = 1.96;
const DAY_SECONDS = 86400;
const DAY_MS = DAY_SECONDS * 1000;
const DAILY_WARMUP_DAYS = 300;
const DAILY_STALE_MS = 3 * DAY_MS;
const COINBASE_PAGE_DAYS = 300;
const REQUEST_DELAY_MS = 350;
const RATE_LIMIT_RETRY_MS = [2000, 5000];
const BTC_PAIR = "BTC-USD";
const COINBASE_USD_PRODUCT = /^[A-Z0-9]{1,20}-USD$/;

export const BUCKET_ORDER = {
  fourHour: ["4h_agrees", "4h_opposes", "4h_opposes_but_passed", "4h_neutral", "4h_unknown"],
  badge: ["badge_full", "badge_partial", "badge_countertrend", "badge_unknown", "no_higher_timeframe"],
  daily: ["daily_agrees", "daily_opposes", "daily_neutral", "daily_unknown"],
  btcDaily: ["btc_daily_agrees", "btc_daily_opposes", "btc_daily_neutral", "btc_daily_unknown"]
};
const COMPARISONS = [
  { family: "fourHour", label: "4h trend (primary)", agree: "4h_agrees", oppose: "4h_opposes" },
  { family: "daily", label: "daily trend", agree: "daily_agrees", oppose: "daily_opposes" },
  { family: "btcDaily", label: "BTC daily trend (non-BTC pairs)", agree: "btc_daily_agrees", oppose: "btc_daily_opposes" }
];
const COUNTERFACTUALS = [
  { family: "fourHour", bucket: "4h_opposes" },
  { family: "fourHour", bucket: "4h_opposes_but_passed" },
  { family: "daily", bucket: "daily_opposes" },
  { family: "btcDaily", bucket: "btc_daily_opposes" }
];

export function parseArguments(argv) {
  const options = { range: null, from: null, to: null, timezone: "UTC", now: null, strategy: null, direction: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { options.json = true; continue; }
    if (!VALUE_ARGUMENTS.includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    index += 1;
    if (argument === "--range") {
      if (!RANGES.includes(value)) throw new Error(`--range must be one of ${RANGES.join(", ")}.`);
      options.range = value;
    } else if (argument === "--from" || argument === "--to") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${argument} must be a YYYY-MM-DD date.`);
      options[argument.slice(2)] = value;
    } else if (argument === "--strategy") {
      if (!value.trim()) throw new Error("--strategy requires a strategy name.");
      options.strategy = value.trim();
    } else if (argument === "--direction") {
      if (!DIRECTIONS.includes(value.toLowerCase())) throw new Error(`--direction must be one of ${DIRECTIONS.join(", ")}.`);
      options.direction = value.toLowerCase();
    } else if (argument === "--timezone") {
      const zone = normalizePerformanceTimezone(value);
      if (zone === "UTC" && !/^(etc\/)?(utc|gmt|zulu)$/i.test(value)) throw new Error(`Unrecognized timezone: ${value}`);
      options.timezone = zone;
    } else {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) throw new Error("--now must be an ISO timestamp.");
      options.now = date;
    }
  }
  if (options.from || options.to) {
    if (!options.from || !options.to) throw new Error("--from and --to must be given together.");
    if (options.range && options.range !== "custom") throw new Error("--from/--to set a custom range; drop --range or use --range custom.");
    options.range = "custom";
  }
  if (options.range === "custom" && !options.from) throw new Error("--range custom needs --from and --to.");
  options.range = options.range || "30d";
  return options;
}

// The decomposition script's columns, plus planned R, the realized-R version and only the full_analysis fields
// this report reads (serializeIndicators writes indicators.*; toFullAnalysis also keeps the confluence object).
export async function queryAlignmentRows(client) {
  const result = await client.query(`
    SELECT g.id, g.pair, g.display_pair, g.timeframe, g.direction, g.strategy, g.pattern,
      g.source, g.confidence, g.calibrated_confidence, g.confidence_version, g.status,
      g.realized_r, g.outcome_evaluated_at, g.hit_tp_at, g.hit_sl_at, g.expired_at, g.created_at,
      g.risk_reward, g.outcome_r_version,
      g.full_analysis->'indicators'->>'alignmentBadge' AS indicator_badge,
      g.full_analysis->'indicators'->>'confluenceScore' AS indicator_confluence_score,
      g.full_analysis->'indicators'->'higherTimeframes' AS indicator_higher_timeframes,
      g.full_analysis->'confluence'->>'badge' AS confluence_badge,
      g.full_analysis->'confluence'->'higherTimeframes' AS confluence_higher_timeframes
    FROM generated_signals g
    ORDER BY g.outcome_evaluated_at ASC NULLS LAST, g.id ASC
  `);
  return result.rows;
}

export function toAlignmentRecord(row) {
  const fromIndicators = Array.isArray(row.indicator_higher_timeframes) ? row.indicator_higher_timeframes : null;
  const fromConfluence = Array.isArray(row.confluence_higher_timeframes) ? row.confluence_higher_timeframes : null;
  const higherTimeframes = fromIndicators?.length ? fromIndicators : fromConfluence?.length ? fromConfluence : fromIndicators ?? fromConfluence;
  const plannedR = Number(row.risk_reward);
  return {
    ...toPerformanceRecord(row),
    plannedR: row.risk_reward != null && Number.isFinite(plannedR) && plannedR > 0 ? plannedR : null,
    outcomeRVersion: row.outcome_r_version || null,
    alignment: {
      badge: row.indicator_badge || row.confluence_badge || null,
      badgePath: row.indicator_badge ? "indicators.alignmentBadge" : row.confluence_badge ? "confluence.badge" : null,
      confluenceScore: row.indicator_confluence_score == null ? null : Number(row.indicator_confluence_score),
      higherTimeframes,
      higherTimeframesPath: higherTimeframes == null ? null : higherTimeframes === fromIndicators ? "indicators.higherTimeframes" : "confluence.higherTimeframes"
    }
  };
}

// ---------- population ----------

export function selectPopulation(records, options = {}) {
  const timezone = normalizePerformanceTimezone(options.timezone);
  const now = options.now ? new Date(options.now) : new Date();
  const rangeKey = options.range || "30d";
  const rangeOptions = rangeKey === "custom" ? { range: "custom", from: options.from, to: options.to } : { range: rangeKey };
  const filter = resolveFilter(records, options);
  const filtered = records.filter(filter.matches);

  const tab = buildGeneratedSignalPerformance(filtered, { ...rangeOptions, timezone, now, grouping: "day" });
  const range = tab.range;
  const from = range.from ? new Date(range.from) : null;
  const to = new Date(range.to);
  const inWindow = (date) => Boolean(date) && (!from || date >= from) && (range.toExclusive ? date < to : date <= to);

  // The tab's membership rule, reconstructed so each member keeps its full_analysis fields; checked against the tab.
  const terminal = filtered
    .map((record) => ({ ...record, outcomeAt: outcomeTimestamp(record) }))
    .filter((record) => terminalStatuses.has(record.status) && (range.key === "all" || inWindow(record.outcomeAt)));
  const check = summarizeRecords(terminal.map((record) => ({ ...record, confidence: record.calibratedConfidence })));
  for (const field of ["signals", "wins", "losses", "expired", "netRealizedR"]) {
    if (check[field] !== tab.metrics[field]) {
      throw new Error(`Membership reconstruction diverged from the Performance tab on ${field} (${check[field]} vs ${tab.metrics[field]}); refusing to report.`);
    }
  }

  const resolved = terminal.filter(hasVersionedRealizedR);
  const unversioned = terminal.filter((record) => !hasVersionedRealizedR(record));
  const versionStart = records.filter(hasVersionedRealizedR).map(outcomeTimestamp).filter(Boolean).sort((a, b) => a - b)[0] || null;
  return {
    range: { key: range.key, label: rangeKey === "custom" ? `custom ${options.from}..${options.to}` : rangeKey, from: range.from, to: range.to, toExclusive: range.toExclusive, timezone },
    now: now.toISOString(),
    filter: { strategy: filter.strategy, direction: filter.direction, records: records.length, kept: filtered.length },
    realizedRVersion: FORWARD_OUTCOME_R_VERSION,
    realizedRVersionStart: versionStart?.toISOString() || null,
    tabCheck: { signals: tab.metrics.signals, tp: tab.metrics.wins, sl: tab.metrics.losses, expired: tab.metrics.expired, netRealizedR: tab.metrics.netRealizedR },
    excluded: {
      terminalWithoutVersionedR: unversioned.length,
      withoutRealizedR: unversioned.filter((record) => record.realizedR == null).length,
      otherRVersion: unversioned.filter((record) => record.realizedR != null).length,
      stillActive: filtered.filter((record) => record.status === "Active" && (range.key === "all" || inWindow(validDate(record.createdAt)))).length
    },
    resolved
  };
}

function hasVersionedRealizedR(record) {
  return terminalStatuses.has(record.status) && record.realizedR != null && record.outcomeRVersion === FORWARD_OUTCOME_R_VERSION;
}

function resolveFilter(records, options) {
  let strategy = null;
  if (options.strategy) {
    const known = [...new Set(records.map(strategyOf))].sort();
    const matches = known.filter((name) => slug(name) === slug(options.strategy));
    if (matches.length > 1) throw new Error(`--strategy "${options.strategy}" is ambiguous: ${matches.join(", ")}.`);
    strategy = matches[0];
    if (!strategy) throw new Error(`No signals with strategy "${options.strategy}". Known strategies: ${known.join(", ") || "none"}.`);
  }
  const direction = options.direction || null;
  return {
    strategy,
    direction,
    matches: (record) => (!strategy || strategyOf(record) === strategy) && (!direction || directionOf(record) === direction)
  };
}

// ---------- Part A: 4h agreement ----------

// Applies to 5m/15m/1h only; returns null for 4h (no higher timeframe) and any other timeframe.
export function classifyFourHour(record) {
  if (!LOWER_TIMEFRAMES.has(record.timeframe)) return null;
  const list = record.alignment?.higherTimeframes;
  const unknown = (reason) => ({ bucket: "4h_unknown", reason, trend: null, trendSource: null, opposesButPassed: false });
  if (!Array.isArray(list)) return unknown("no higherTimeframes array");
  const entry = list.find((item) => item?.timeframe === "4h");
  if (!entry) return unknown("no 4h entry");
  if (entry.available === false) return unknown("4h entry unavailable");
  let trend = TRENDS.has(entry.trend) ? entry.trend : null;
  let trendSource = trend ? "trend" : null;
  if (!trend && entry.regime && typeof entry.regime === "object") {
    trend = inferMultiTimeframeDirection(entry.regime);
    trendSource = "regime";
  }
  if (!TRENDS.has(trend)) return unknown("4h entry unreadable");
  const direction = directionOf(record);
  if (!DIRECTIONS.includes(direction)) return unknown("signal direction unreadable");
  const bucket = trend === direction ? "4h_agrees" : trend === "neutral" ? "4h_neutral" : "4h_opposes";
  // The averaging let it through: the 4h opposes, yet the blended badge was Full or Partial, not Countertrend.
  const opposesButPassed = bucket === "4h_opposes" && ["Full Alignment", "Partial Alignment"].includes(record.alignment?.badge);
  return { bucket, reason: null, trend, trendSource, opposesButPassed };
}

// ---------- Part B: badge ----------

export function classifyBadge(record) {
  if (record.timeframe === NO_HIGHER_TIMEFRAME) return "no_higher_timeframe";
  return BADGE_BUCKETS[record.alignment?.badge] || "badge_unknown";
}

// ---------- Part C: daily trend ----------

export function classifyDailyTrend(close, ema20, ema50) {
  if (close > ema50 && ema20 > ema50) return "long";
  if (close < ema50 && ema20 < ema50) return "short";
  return "neutral";
}

// Candles are Coinbase daily buckets ({ time: open in epoch seconds, close }); a candle is usable for a signal only
// once it had fully CLOSED (time + 1 day <= created_at). EMAs at index i read candles 0..i only, so no look-ahead.
export function buildDailyTrendLookup(candles) {
  const byTime = new Map();
  for (const candle of candles || []) {
    if (Number.isFinite(candle?.time) && Number.isFinite(candle?.close)) byTime.set(candle.time, candle);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  const closes = sorted.map((candle) => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  return (createdAt) => {
    const at = validDate(createdAt)?.getTime();
    if (at == null) return { trend: null, reason: "signal created_at unreadable" };
    let low = 0;
    let high = sorted.length - 1;
    let index = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((sorted[middle].time + DAY_SECONDS) * 1000 <= at) { index = middle; low = middle + 1; } else { high = middle - 1; }
    }
    if (index < 0) return { trend: null, reason: "no closed daily candle before the signal" };
    const candle = sorted[index];
    const candleDate = new Date(candle.time * 1000).toISOString().slice(0, 10);
    if (at - (candle.time + DAY_SECONDS) * 1000 > DAILY_STALE_MS) return { trend: null, reason: "latest closed daily candle is stale", candleDate };
    if (ema50[index] == null) return { trend: null, reason: "fewer than 50 closed daily candles", candleDate };
    return { trend: classifyDailyTrend(candle.close, ema20[index], ema50[index]), candleDate };
  };
}

function directionalBucket(prefix, trend, direction) {
  if (!trend || !DIRECTIONS.includes(direction)) return `${prefix}_unknown`;
  return trend === direction ? `${prefix}_agrees` : trend === "neutral" ? `${prefix}_neutral` : `${prefix}_opposes`;
}

export function classifyDaily(record, daily) {
  const pair = symbolOf(record);
  const lookup = daily?.lookups?.get(pair);
  if (!lookup) return { bucket: "daily_unknown", reason: daily?.failures?.get(pair) || "no daily candles" };
  const result = lookup(record.createdAt);
  return { bucket: directionalBucket("daily", result.trend, directionOf(record)), reason: result.reason || null, candleDate: result.candleDate || null };
}

// Non-BTC Coinbase USD pairs only (do altcoins fail when Bitcoin's daily trend disagrees?); null otherwise.
export function classifyBtcDaily(record, daily) {
  const pair = symbolOf(record);
  if (pair === BTC_PAIR || !COINBASE_USD_PRODUCT.test(pair)) return null;
  const lookup = daily?.lookups?.get(BTC_PAIR);
  if (!lookup) return { bucket: "btc_daily_unknown", reason: daily?.failures?.get(BTC_PAIR) || "no BTC daily candles" };
  const result = lookup(record.createdAt);
  return { bucket: directionalBucket("btc_daily", result.trend, directionOf(record)), reason: result.reason || null };
}

// One request at a time with a short pause; 300 daily candles per page (Coinbase's per-request maximum).
export async function fetchDailyCandles(pair, { fromMs, toMs, baseUrl, fetchImpl = fetch, sleep = defaultSleep, delayMs = REQUEST_DELAY_MS }) {
  const candles = new Map();
  let cursor = Math.floor(fromMs / DAY_MS) * DAY_MS;
  while (cursor <= toMs) {
    const pageEnd = Math.min(toMs, cursor + (COINBASE_PAGE_DAYS - 1) * DAY_MS);
    const url = new URL(`/products/${encodeURIComponent(pair)}/candles`, baseUrl);
    url.searchParams.set("granularity", String(DAY_SECONDS));
    url.searchParams.set("start", new Date(cursor).toISOString());
    url.searchParams.set("end", new Date(pageEnd).toISOString());
    for (const [time, , , , close] of await getCandlePage(url, fetchImpl, sleep)) {
      if (Number.isFinite(Number(time)) && Number.isFinite(Number(close))) candles.set(Number(time), { time: Number(time), close: Number(close) });
    }
    await sleep(delayMs);
    cursor = pageEnd + DAY_MS;
  }
  return [...candles.values()].sort((a, b) => a.time - b.time);
}

async function getCandlePage(url, fetchImpl, sleep) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "SignalForge/0.1" } });
    if ((response.status === 429 || response.status >= 500) && attempt < RATE_LIMIT_RETRY_MS.length) {
      await sleep(RATE_LIMIT_RETRY_MS[attempt]);
      continue;
    }
    if (!response.ok) throw new Error(`Coinbase returned HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Coinbase returned a malformed candle response");
    return rows;
  }
}

// Sequential per pair, cached in memory for the run. A failed pair is recorded, never silently dropped.
export async function loadDailyTrends(resolved, { baseUrl, fetchImpl, sleep, log = () => {} } = {}) {
  const windowByPair = new Map();
  const widen = (pair, at) => {
    const current = windowByPair.get(pair) || { fromMs: Infinity, toMs: -Infinity };
    windowByPair.set(pair, { fromMs: Math.min(current.fromMs, at - DAILY_WARMUP_DAYS * DAY_MS), toMs: Math.max(current.toMs, at) });
  };
  for (const record of resolved) {
    const at = validDate(record.createdAt)?.getTime();
    if (at == null) continue;
    widen(symbolOf(record), at);
    if (symbolOf(record) !== BTC_PAIR && COINBASE_USD_PRODUCT.test(symbolOf(record))) widen(BTC_PAIR, at);
  }
  const lookups = new Map();
  const failures = new Map();
  const pairs = [...windowByPair.keys()].sort((a, b) => (a === BTC_PAIR ? -1 : b === BTC_PAIR ? 1 : a.localeCompare(b)));
  for (const [index, pair] of pairs.entries()) {
    if (!COINBASE_USD_PRODUCT.test(pair)) { failures.set(pair, "not a Coinbase USD product symbol"); continue; }
    log(`daily candles ${index + 1}/${pairs.length} ${pair}`);
    try {
      const candles = await fetchDailyCandles(pair, { ...windowByPair.get(pair), baseUrl, fetchImpl, sleep });
      if (!candles.length) { failures.set(pair, "Coinbase returned no daily candles"); continue; }
      lookups.set(pair, buildDailyTrendLookup(candles));
    } catch (error) {
      failures.set(pair, error.message);
    }
  }
  return { baseUrl: baseUrl ? String(baseUrl) : null, pairsRequested: pairs.length, lookups, failures };
}

function defaultSleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

// ---------- metrics ----------

export function summarizeBucket(records) {
  const tp = records.filter((record) => record.status === "Hit TP").length;
  const sl = records.filter((record) => record.status === "Hit SL").length;
  const expired = records.filter((record) => record.status === "Expired").length;
  const n = records.length;
  const decided = tp + sl;
  const values = records.map((record) => record.realizedR);
  const netR = sum(values);
  const avgR = n ? netR / n : null;
  const sd = n > 1 ? Math.sqrt(sum(values.map((value) => (value - avgR) ** 2)) / (n - 1)) : null;
  const planned = records.map((record) => record.plannedR).filter((value) => value != null);
  const avgPlannedR = planned.length ? sum(planned) / planned.length : null;
  return {
    n, tp, sl, expired, decided,
    winRate: decided ? round((tp / decided) * 100, 1) : null,
    winRate95: wilsonInterval(tp, decided),
    netR: round(netR),
    avgR: avgR == null ? null : round(avgR),
    avgR95: sd == null ? null : { low: round(avgR - (Z95 * sd) / Math.sqrt(n)), high: round(avgR + (Z95 * sd) / Math.sqrt(n)) },
    avgPlannedR: avgPlannedR == null ? null : round(avgPlannedR),
    breakEvenWinRate: avgPlannedR == null ? null : round(100 / (1 + avgPlannedR), 1),
    smallSample: decided < MIN_DECIDED
  };
}

// Group by strategy x direction x bucket, plus All strategies x direction and All strategies x both.
function groupBuckets(entries, order) {
  const groups = new Map();
  const add = (strategy, direction, bucket, record) => {
    const key = `${strategy}\u0000${direction}\u0000${bucket}`;
    if (!groups.has(key)) groups.set(key, { strategy, direction, bucket, records: [] });
    groups.get(key).records.push(record);
  };
  for (const { record, buckets } of entries) {
    for (const bucket of buckets) {
      add(strategyOf(record), directionOf(record), bucket, record);
      add(ALL, directionOf(record), bucket, record);
      add(ALL, BOTH, bucket, record);
    }
  }
  const strategyRank = (name) => (name === ALL ? 1 : 0);
  const directionRank = (name) => (name === BOTH ? 2 : DIRECTIONS.includes(name) ? DIRECTIONS.indexOf(name) : 1.5);
  return [...groups.values()]
    .sort((a, b) => strategyRank(a.strategy) - strategyRank(b.strategy) || a.strategy.localeCompare(b.strategy) ||
      directionRank(a.direction) - directionRank(b.direction) || order.indexOf(a.bucket) - order.indexOf(b.bucket))
    .map(({ strategy, direction, bucket, records }) => ({ strategy, direction, bucket, ...summarizeBucket(records) }));
}

// ---------- decision rule (fixed before seeing results) ----------

export function decide(agree, oppose) {
  const facts = {
    agreeDecided: agree?.decided || 0,
    opposeDecided: oppose?.decided || 0
  };
  if (!agree || !oppose || agree.decided < MIN_DECIDED || oppose.decided < MIN_DECIDED) {
    return { verdict: "INCONCLUSIVE", text: `Inconclusive: TP+SL is ${facts.agreeDecided} agreeing / ${facts.opposeDecided} opposing (need >= ${MIN_DECIDED} each). Go to the replay harness.`, facts };
  }
  const opposeBelowBreakEven = oppose.winRate95 != null && oppose.breakEvenWinRate != null && oppose.winRate95.high < oppose.breakEvenWinRate;
  const intervalsOverlap = !(agree.avgR95 && oppose.avgR95) || !(agree.avgR95.low > oppose.avgR95.high || oppose.avgR95.low > agree.avgR95.high);
  const agreeClearlyHigher = (agree.avgR95 && oppose.avgR95 && agree.avgR95.low > oppose.avgR95.high) || agree.avgR - oppose.avgR >= CLEAR_AVG_R_MARGIN;
  Object.assign(facts, {
    opposeWilsonHigh: oppose.winRate95?.high ?? null,
    opposeBreakEvenWinRate: oppose.breakEvenWinRate,
    opposeBelowBreakEven,
    agreeAvgR: agree.avgR,
    opposeAvgR: oppose.avgR,
    avgRGap: round(agree.avgR - oppose.avgR),
    intervalsOverlap,
    agreeClearlyHigher
  });
  if (opposeBelowBreakEven && agreeClearlyHigher) {
    return { verdict: "CONFIRMED", text: "Confirmed. The direction gate is the priority fix: build it next and test it in the replay harness.", facts };
  }
  if (agree.avgR < 0 && oppose.avgR < 0 && intervalsOverlap) {
    return { verdict: "NO_EDGE", text: "The trigger itself has no edge: agreeing and opposing both lose, with overlapping intervals. A gate alone won't fix it; the replay harness comes first.", facts };
  }
  const missed = [
    !opposeBelowBreakEven ? `opposing Wilson upper ${fmtPct(facts.opposeWilsonHigh)} is not below its break-even ${fmtPct(facts.opposeBreakEvenWinRate)}` : null,
    !agreeClearlyHigher ? `agreeing avg R is not clearly higher (gap ${fmtR(facts.avgRGap)}, intervals ${intervalsOverlap ? "overlap" : "do not overlap"})` : null,
    !(agree.avgR < 0 && oppose.avgR < 0) ? `not both negative (agree ${fmtR(agree.avgR)}, oppose ${fmtR(oppose.avgR)})` : null
  ].filter(Boolean);
  return { verdict: "NO_ROW_APPLIES", text: `No row of the decision table applies: ${missed.join("; ")}.`, facts };
}

// ---------- coverage ----------

function buildCoverage(resolved, timezone) {
  const groups = new Map();
  for (const record of resolved) {
    const month = localMonth(validDate(record.createdAt), timezone);
    const key = `${record.timeframe}\u0000${month}`;
    if (!groups.has(key)) groups.set(key, { timeframe: record.timeframe, month, records: [] });
    groups.get(key).records.push(record);
  }
  const timeframeRank = (timeframe) => { const index = ["5m", "15m", "1h", "4h"].indexOf(timeframe); return index < 0 ? 9 : index; };
  const rows = [...groups.values()]
    .sort((a, b) => timeframeRank(a.timeframe) - timeframeRank(b.timeframe) || a.timeframe.localeCompare(b.timeframe) || a.month.localeCompare(b.month))
    .map(({ timeframe, month, records }) => {
      const entries = records.map((record) => (Array.isArray(record.alignment.higherTimeframes) ? record.alignment.higherTimeframes.find((item) => item?.timeframe === "4h") : null));
      return {
        timeframe,
        month,
        resolved: records.length,
        htfPopulated: records.filter((record) => Array.isArray(record.alignment.higherTimeframes) && record.alignment.higherTimeframes.length > 0).length,
        has4hEntry: entries.filter(Boolean).length,
        fourHourAvailable: entries.filter((entry) => entry && entry.available !== false).length,
        fourHourTrendField: entries.filter((entry) => entry && TRENDS.has(entry.trend)).length,
        fourHourRegimeOnly: entries.filter((entry) => entry && !TRENDS.has(entry.trend) && entry.regime && typeof entry.regime === "object").length,
        badgePresent: records.filter((record) => record.alignment.badge).length
      };
    });
  const paths = {
    higherTimeframes: Object.fromEntries(countBy(resolved, (record) => record.alignment.higherTimeframesPath || "missing")),
    badge: Object.fromEntries(countBy(resolved, (record) => record.alignment.badgePath || "missing"))
  };
  return { rows, paths };
}

// ---------- report ----------

export function buildAlignmentReport(population, daily = { lookups: new Map(), failures: new Map() }) {
  const resolved = population.resolved;
  const classified = resolved.map((record) => ({
    record,
    fourHour: classifyFourHour(record),
    badge: classifyBadge(record),
    daily: classifyDaily(record, daily),
    btcDaily: classifyBtcDaily(record, daily)
  }));

  const families = {
    fourHour: groupBuckets(classified.filter((item) => item.fourHour).map((item) => ({
      record: item.record,
      buckets: [item.fourHour.bucket, ...(item.fourHour.opposesButPassed ? ["4h_opposes_but_passed"] : [])]
    })), BUCKET_ORDER.fourHour),
    badge: groupBuckets(classified.map((item) => ({ record: item.record, buckets: [item.badge] })), BUCKET_ORDER.badge),
    daily: groupBuckets(classified.map((item) => ({ record: item.record, buckets: [item.daily.bucket] })), BUCKET_ORDER.daily),
    btcDaily: groupBuckets(classified.filter((item) => item.btcDaily).map((item) => ({ record: item.record, buckets: [item.btcDaily.bucket] })), BUCKET_ORDER.btcDaily)
  };
  const bucketsOf = (item, family) => {
    if (family === "fourHour") return item.fourHour ? [item.fourHour.bucket, ...(item.fourHour.opposesButPassed ? ["4h_opposes_but_passed"] : [])] : [];
    if (family === "btcDaily") return item.btcDaily ? [item.btcDaily.bucket] : [];
    return [item[family].bucket];
  };

  const totalNetR = sum(resolved.map((record) => record.realizedR));
  const scopes = [{ strategy: ALL, direction: BOTH }, ...uniqueScopes(resolved)];
  const counterfactuals = COUNTERFACTUALS.map(({ family, bucket }) => ({
    family,
    bucket,
    scopes: scopes.map(({ strategy, direction }) => {
      const inScope = classified.filter((item) => (strategy === ALL || strategyOf(item.record) === strategy) && (direction === BOTH || directionOf(item.record) === direction));
      const removed = inScope.filter((item) => bucketsOf(item, family).includes(bucket));
      const scopeNet = sum(inScope.map((item) => item.record.realizedR));
      const removedNet = sum(removed.map((item) => item.record.realizedR));
      return { strategy, direction, signals: inScope.length, removed: removed.length, removedNetR: round(removedNet), totalNetR: round(scopeNet), newTotalNetR: round(scopeNet - removedNet) };
    }).filter((row) => row.signals > 0)
  }));

  const decisions = [];
  for (const comparison of COMPARISONS) {
    const rows = families[comparison.family];
    const keys = [...new Map(rows.map((row) => [`${row.strategy}\u0000${row.direction}`, { strategy: row.strategy, direction: row.direction }])).values()];
    for (const { strategy, direction } of keys) {
      const find = (bucket) => rows.find((row) => row.strategy === strategy && row.direction === direction && row.bucket === bucket) || null;
      decisions.push({ comparison: comparison.label, family: comparison.family, strategy, direction, ...decide(find(comparison.agree), find(comparison.oppose)) });
    }
  }

  const reasons = (items) => Object.fromEntries([...countBy(items, (reason) => reason)].sort((a, b) => b[1] - a[1]));
  return {
    window: population.range,
    now: population.now,
    filter: population.filter,
    realizedR: {
      version: population.realizedRVersion,
      versionStart: population.realizedRVersionStart,
      definition: "TP = planned R (risk_reward), SL = -1, Expired = 0",
      tabCheck: population.tabCheck,
      report: { signals: resolved.length, netRealizedR: round(totalNetR) }
    },
    excluded: {
      ...population.excluded,
      partA: Object.fromEntries(countBy(classified.filter((item) => !item.fourHour), (item) => (item.record.timeframe === NO_HIGHER_TIMEFRAME ? "4h (no higher timeframe)" : `timeframe ${item.record.timeframe}`))),
      btcDailyNotApplicable: classified.filter((item) => !item.btcDaily).length
    },
    unknownReasons: {
      fourHour: reasons(classified.filter((item) => item.fourHour?.bucket === "4h_unknown").map((item) => item.fourHour.reason)),
      daily: reasons(classified.filter((item) => item.daily.bucket === "daily_unknown").map((item) => item.daily.reason || "unknown")),
      btcDaily: reasons(classified.filter((item) => item.btcDaily?.bucket === "btc_daily_unknown").map((item) => item.btcDaily.reason || "unknown"))
    },
    fourHourTrendSource: Object.fromEntries(countBy(classified.filter((item) => item.fourHour?.trendSource), (item) => item.fourHour.trendSource)),
    coverage: buildCoverage(resolved, population.range.timezone),
    dailyCandles: {
      source: daily.baseUrl ? `${daily.baseUrl} /products/{pair}/candles granularity ${DAY_SECONDS}` : null,
      pairsRequested: daily.pairsRequested ?? null,
      pairsLoaded: daily.lookups.size,
      failedPairs: [...daily.failures.entries()].map(([pair, reason]) => ({ pair, reason })),
      trendRule: "long if close > EMA50 and EMA20 > EMA50; short if close < EMA50 and EMA20 < EMA50; else neutral; only candles closed before created_at"
    },
    families,
    counterfactuals,
    decisions
  };
}

function uniqueScopes(records) {
  const scopes = new Map();
  for (const record of records) {
    scopes.set(`${ALL}\u0000${directionOf(record)}`, { strategy: ALL, direction: directionOf(record) });
    scopes.set(`${strategyOf(record)}\u0000${directionOf(record)}`, { strategy: strategyOf(record), direction: directionOf(record) });
  }
  return [...scopes.values()].sort((a, b) => (a.strategy === ALL ? -1 : b.strategy === ALL ? 1 : a.strategy.localeCompare(b.strategy)) || a.direction.localeCompare(b.direction));
}

function outcomeTimestamp(record) {
  const canonical = record.status === "Hit TP" ? record.hitTpAt : record.status === "Hit SL" ? record.hitSlAt : record.status === "Expired" ? record.expiredAt : null;
  return validDate(record.outcomeEvaluatedAt) || validDate(canonical);
}
function symbolOf(record) { return String(record.pair || record.symbol || "Unknown"); }
function strategyOf(record) { return String(record.strategy || "Unknown"); }
function directionOf(record) { return String(record.direction || "Unknown").toLowerCase(); }
function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) || 0) + 1);
  return counts;
}
function localMonth(date, timezone) {
  if (!date) return "undated";
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).format(date).slice(0, 7);
}
function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function round(value, digits = 3) { return Number(Number(value || 0).toFixed(digits)); }

// ---------- text rendering ----------

export function renderText(report) {
  const lines = [];
  const w = report.window;
  const r = report.realizedR;
  lines.push("== HTF alignment vs outcomes (read-only) ==");
  lines.push(`window ${w.label} | ${w.from || "beginning"} -> ${w.to}${w.toExclusive ? " (exclusive)" : ""} | timezone ${w.timezone} | now ${report.now}`);
  lines.push(`filter strategy ${report.filter.strategy || "all"} | direction ${report.filter.direction || "both"} | ${report.filter.kept}/${report.filter.records} signals kept`);
  lines.push(`realized R ${r.version} (${r.definition}); first outcome with this version ${r.versionStart || "none"}`);
  lines.push(`Performance tab check (same window/filter): ${r.tabCheck.signals} finished, net ${formatSignedR(r.tabCheck.netRealizedR)} | this report: ${r.report.signals} resolved with versioned R, net ${formatSignedR(r.report.netRealizedR)}`);
  const x = report.excluded;
  lines.push(`excluded: ${x.stillActive} still Active (by created_at), ${x.terminalWithoutVersionedR} finished without versioned realized R (${x.withoutRealizedR} missing R, ${x.otherRVersion} other version)`);

  lines.push("", "== Coverage: resolved signals by timeframe x created month ==");
  lines.push(`   higherTimeframes path: ${fmtCounts(report.coverage.paths.higherTimeframes)} | badge path: ${fmtCounts(report.coverage.paths.badge)}`);
  lines.push("   tf    month    resolved  htf[]>0  4h entry  4h avail  4h .trend  4h regime-only  badge");
  for (const row of report.coverage.rows) {
    lines.push(`   ${row.timeframe.padEnd(5)} ${row.month.padEnd(8)} ${pad(row.resolved, 8)} ${pad(row.htfPopulated, 8)} ${pad(row.has4hEntry, 9)} ${pad(row.fourHourAvailable, 9)} ${pad(row.fourHourTrendField, 10)} ${pad(row.fourHourRegimeOnly, 15)} ${pad(row.badgePresent, 6)}`);
  }
  if (!report.coverage.rows.length) lines.push("   (no resolved signals)");
  lines.push(`   4h trend read from: ${fmtCounts(report.fourHourTrendSource) || "none"} ("regime" = trend field absent, recomputed with inferMultiTimeframeDirection)`);

  const legend = "   n = resolved; win% = TP/(TP+SL) with 95% Wilson; BE = break-even win% = 1/(1+avg planned R); avgR = net R / n with 95% normal interval; * = TP+SL < 30";
  lines.push("", "== Part A: 4h agreement (5m, 15m, 1h) ==", legend);
  lines.push(`   not in Part A: ${fmtCounts(x.partA) || "none"}`);
  lines.push(`   4h_unknown reasons: ${fmtCounts(report.unknownReasons.fourHour) || "none"}`);
  lines.push("   4h_opposes_but_passed is a subset of 4h_opposes: 4h opposes but the badge was Full/Partial, not Countertrend.");
  lines.push(...bucketTable(report.families.fourHour));
  lines.push("", "== Part B: alignment badge ==", legend);
  lines.push(...bucketTable(report.families.badge));
  lines.push("", "== Part C: daily trend (pair) ==", legend);
  const d = report.dailyCandles;
  lines.push(`   source ${d.source || "n/a"} | pairs loaded ${d.pairsLoaded}/${d.pairsRequested ?? "n/a"}`);
  lines.push(`   rule: ${d.trendRule}`);
  if (d.failedPairs.length) lines.push(`   FAILED pairs (their signals are daily_unknown): ${d.failedPairs.map((f) => `${f.pair} (${f.reason})`).join(", ")}`);
  lines.push(`   daily_unknown reasons: ${fmtCounts(report.unknownReasons.daily) || "none"}`);
  lines.push(...bucketTable(report.families.daily));
  lines.push("", "== Part C: BTC daily trend (non-BTC Coinbase pairs only) ==", legend);
  lines.push(`   not applicable (BTC-USD itself or non-Coinbase symbol): ${x.btcDailyNotApplicable} | btc_daily_unknown reasons: ${fmtCounts(report.unknownReasons.btcDaily) || "none"}`);
  lines.push(...bucketTable(report.families.btcDaily));

  lines.push("", "== Counterfactuals (filtering only, no re-simulation) ==");
  for (const cf of report.counterfactuals) {
    const overall = cf.scopes.find((row) => row.strategy === ALL && row.direction === BOTH);
    lines.push(overall
      ? `If signals in ${cf.bucket} had been blocked: ${overall.removed} removed, net R removed ${formatSignedR(overall.removedNetR)}, new total net R ${formatSignedR(overall.newTotalNetR)} (was ${formatSignedR(overall.totalNetR)})`
      : `If signals in ${cf.bucket} had been blocked: no signals in the window.`);
    for (const row of cf.scopes.filter((item) => !(item.strategy === ALL && item.direction === BOTH) && item.removed > 0)) {
      lines.push(`     ${`${row.strategy} / ${row.direction}`.padEnd(40)} ${pad(row.removed, 4)} removed ${pad(formatSignedR(row.removedNetR), 9)} -> ${pad(formatSignedR(row.newTotalNetR), 9)} (was ${formatSignedR(row.totalNetR)})`);
    }
  }

  lines.push("", "== Decision (rule fixed before results) ==");
  lines.push(`   CONFIRMED: opposing TP+SL >= 30, its Wilson upper < its break-even, and agreeing avg R clearly higher (avg-R intervals do not overlap, or >= +${CLEAR_AVG_R_MARGIN}R per signal).`);
  lines.push("   NO_EDGE: agreeing and opposing both have negative avg R with overlapping intervals.");
  lines.push(`   INCONCLUSIVE: agreeing or opposing TP+SL < ${MIN_DECIDED}.`);
  for (const comparison of COMPARISONS) {
    lines.push("", `   -- ${comparison.label}: ${comparison.agree} vs ${comparison.oppose} --`);
    for (const decision of report.decisions.filter((item) => item.family === comparison.family)) {
      lines.push(`   ${`${decision.strategy} / ${decision.direction}`.padEnd(40)} ${decision.verdict.padEnd(14)} ${decision.text}`);
    }
  }
  return lines.join("\n");
}

function bucketTable(rows) {
  if (!rows.length) return ["   (none)"];
  const scopeWidth = Math.max(24, ...rows.map((row) => `${row.strategy} / ${row.direction}`.length));
  const header = `   ${"strategy / direction".padEnd(scopeWidth)} ${"bucket".padEnd(22)}    n   TP   SL  Exp    win%  Wilson95       BE%      netR      avgR  avgR95`;
  const out = [header];
  let previous = null;
  for (const row of rows) {
    const scope = `${row.strategy} / ${row.direction}`;
    if (previous && previous !== scope) out.push("");
    previous = scope;
    out.push(`   ${scope.padEnd(scopeWidth)} ${row.bucket.padEnd(22)} ${pad(row.n, 4)} ${pad(row.tp, 4)} ${pad(row.sl, 4)} ${pad(row.expired, 4)} ${pad(fmtPct(row.winRate), 7)}  ${fmtCi(row.winRate95).padEnd(12)} ${pad(fmtPct(row.breakEvenWinRate), 6)} ${pad(formatSignedR(row.netR), 9)} ${pad(fmtR(row.avgR), 9)}  ${fmtRange(row.avgR95)}${row.smallSample ? " *" : ""}`);
  }
  return out;
}
function pad(value, width) { return String(value).padStart(width); }
function fmtPct(value) { return value == null ? "n/a" : `${Number(value).toFixed(1)}%`; }
function fmtCi(ci) { return ci ? `${ci.low.toFixed(1)}-${ci.high.toFixed(1)}%` : "n/a"; }
function fmtR(value) { return value == null ? "n/a" : `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(3)}R`; }
function fmtRange(range) { return range ? `${fmtR(range.low)}..${fmtR(range.high)}` : "n/a"; }
function formatSignedR(value) { const number = Number(value || 0); return `${number > 0 ? "+" : ""}${number.toFixed(2)}R`; }
function fmtCounts(object) { return Object.entries(object || {}).map(([key, count]) => `${key} ${count}`).join(", "); }

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const connectionString = String(process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const client = new Client({ connectionString, options: "-c default_transaction_read_only=on" });
  await client.connect();
  let rows;
  try {
    await client.query("BEGIN READ ONLY");
    rows = await queryAlignmentRows(client);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
  const population = selectPopulation(rows.map(toAlignmentRecord), options);
  const { appConfig } = await appModule("src/config/appConfig.js");
  const daily = await loadDailyTrends(population.resolved, {
    baseUrl: appConfig.marketData.baseUrl,
    log: (message) => process.stderr.write(`${message}\n`)
  });
  const report = buildAlignmentReport(population, daily);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`);
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(`HTF alignment outcome report failed: ${error.message}`);
    process.exitCode = 1;
  });
}
