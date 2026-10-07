// Disposable, read-only diagnostic. Decomposes the admin Signals > Performance net realized R for a
// tab range using the SAME population, window and math as the tab: the same generated_signals SELECT
// (no categorical filters, the tab's default) fed through buildGeneratedSignalPerformance.
// Prints aggregates and symbols only; no ids, no user data.
//
// Runs from the repo (node scripts/weekly-realized-r-decomposition.js ...) or pasted standalone into
// /tmp inside the Railway container, where it loads pg and the tab module from /app (APP_ROOT overrides).
//
//   node scripts/weekly-realized-r-decomposition.js --range 30d --timezone <IANA zone of the browser> --expect -44.71
//   node scripts/weekly-realized-r-decomposition.js --range 90d --timezone <zone> --strategy "Momentum breakout" --direction short --generated-since 2026-08-10
//
// Options:
//   --range <key>      Tab range: today | 7d | 30d | 90d | ytd | all | custom. Default 7d.
//   --from/--to <date> YYYY-MM-DD local dates, inclusive (the tab's custom range). Implies --range custom.
//   --timezone <zone>  Browser timezone the tab used (the tab sends Intl's resolved zone). Default UTC.
//   --now <ISO>        Reference time (default: now). Preset ranges are local calendar days, so they move daily.
//   --expect <R>       Figure seen in the tab (e.g. -44.71). If it does not reproduce, the script prints why
//                      and stops before the breakdown (exit code 2) unless --force is given.
//   --force            Print the breakdown even when --expect does not reproduce.
//   --strategy <name>  Keep only this strategy (case-insensitive exact name, e.g. "Momentum breakout").
//   --direction <dir>  Keep only long or short signals.
//                      Both filters apply after the --expect gate (which always checks the unfiltered tab
//                      figure) and before every breakdown below it.
//   --generated-since <date>
//                      YYYY-MM-DD local date. Adds signals generated (by created_at) per strategy per local
//                      week since that date, across ALL strategies and directions (the filters do not apply),
//                      with each strategy's last generation date, so strategies that stopped firing show as zeros.
//   --json             Emit the report as JSON instead of text.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PERFORMANCE_MODULE = "src/modules/admin-signals/generatedSignalPerformance.js";
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.APP_ROOT || (existsSync(join(scriptDirectory, "..", PERFORMANCE_MODULE)) ? join(scriptDirectory, "..") : "/app");
if (!existsSync(join(APP_ROOT, PERFORMANCE_MODULE))) {
  console.error(`Weekly realized R decomposition failed: app not found at ${APP_ROOT} (set APP_ROOT to the deployed app directory).`);
  process.exit(1);
}
const { Client } = createRequire(join(APP_ROOT, "package.json"))("pg");
const {
  buildGeneratedSignalPerformance,
  normalizePerformanceTimezone,
  summarizeRecords
} = await import(pathToFileURL(join(APP_ROOT, PERFORMANCE_MODULE)).href);

const terminalStatuses = new Set(["Hit TP", "Hit SL", "Expired"]);
const RANGES = ["today", "7d", "30d", "90d", "ytd", "all", "custom"];
const PRESET_DAYS = { today: 1, "7d": 7, "30d": 30, "90d": 90 };
const MAJOR_BASES = ["BTC", "ETH", "SOL", "XRP", "DOGE"];
const MAJORS_GROUP = `Majors (${MAJOR_BASES.join(", ")})`;
const OTHERS_GROUP = "Everything else";
const DIRECTIONS = ["long", "short"];
const VALUE_ARGUMENTS = ["--range", "--from", "--to", "--timezone", "--now", "--expect", "--strategy", "--direction", "--generated-since"];
const BY_DAY_MAX_DAYS = 14;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CLUSTER_WINDOW_MS = 60 * 60 * 1000;
const WILSON_Z = 1.96;
const DIAGNOSTIC_TIMEZONES = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Manila", "Asia/Singapore", "Australia/Sydney"];

export function parseArguments(argv) {
  const options = {
    range: null, from: null, to: null, timezone: "UTC", now: null, expect: null, force: false, json: false,
    strategy: null, direction: null, generatedSince: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") { options.force = true; continue; }
    if (argument === "--json") { options.json = true; continue; }
    if (!VALUE_ARGUMENTS.includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value == null || (value.startsWith("--") && argument !== "--expect")) throw new Error(`${argument} requires a value.`);
    index += 1;
    if (argument === "--range") {
      if (!RANGES.includes(value)) throw new Error(`--range must be one of ${RANGES.join(", ")}.`);
      options.range = value;
    } else if (argument === "--from" || argument === "--to" || argument === "--generated-since") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${argument} must be a YYYY-MM-DD date.`);
      options[argument === "--generated-since" ? "generatedSince" : argument.slice(2)] = value;
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
    } else if (argument === "--now") {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) throw new Error("--now must be an ISO timestamp.");
      options.now = date;
    } else {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error("--expect must be a number such as -44.71.");
      options.expect = number;
    }
  }
  if (options.from || options.to) {
    if (!options.from || !options.to) throw new Error("--from and --to must be given together.");
    if (options.range && options.range !== "custom") throw new Error("--from/--to set a custom range; drop --range or use --range custom.");
    options.range = "custom";
  }
  if (options.range === "custom" && !options.from) throw new Error("--range custom needs --from and --to.");
  options.range = options.range || "7d";
  return options;
}

// Same columns and ordering as listGeneratedSignalPerformanceRecords with no filters, plus created_at
// (needed for Active counts and the duplicate check; not used by the tab's math).
export async function queryPerformanceRows(client) {
  const result = await client.query(`
    SELECT g.id, g.pair, g.display_pair, g.timeframe, g.direction, g.strategy, g.pattern,
      g.source, g.confidence, g.calibrated_confidence, g.confidence_version, g.status,
      g.realized_r, g.outcome_evaluated_at, g.hit_tp_at, g.hit_sl_at, g.expired_at, g.created_at
    FROM generated_signals g
    ORDER BY g.outcome_evaluated_at ASC NULLS LAST, g.id ASC
  `);
  return result.rows;
}

// Mirrors the repository's row mapping so buildGeneratedSignalPerformance sees identical records.
export function toPerformanceRecord(row) {
  return {
    id: row.id,
    pair: row.pair,
    displayPair: row.display_pair,
    timeframe: row.timeframe,
    direction: row.direction,
    strategy: row.strategy,
    pattern: row.pattern,
    source: row.source,
    confidence: Number(row.confidence),
    calibratedConfidence: row.calibrated_confidence == null ? Number(row.confidence) : Number(row.calibrated_confidence),
    confidenceVersion: row.confidence_version,
    status: row.status,
    realizedR: row.realized_r == null ? null : Number(row.realized_r),
    outcomeEvaluatedAt: row.outcome_evaluated_at || null,
    hitTpAt: row.hit_tp_at || null,
    hitSlAt: row.hit_sl_at || null,
    expiredAt: row.expired_at || null,
    createdAt: row.created_at || null
  };
}

export function buildDecomposition(records, options = {}) {
  const timezone = normalizePerformanceTimezone(options.timezone);
  const now = options.now ? new Date(options.now) : new Date();
  const today = localDate(now, timezone);
  const rangeKey = options.range || "7d";
  const rangeOptions = rangeKey === "custom" ? { range: "custom", from: options.from, to: options.to } : { range: rangeKey };
  const windows = {
    current: { label: `Selected window (tab range ${describeRange(rangeOptions)})`, rangeOptions }
  };
  // The week-over-week comparison is kept for the original 7d use only; other ranges are reported on their own.
  if (rangeKey === "7d") {
    windows.prior = { label: "Prior 7 days", rangeOptions: { range: "custom", from: addDays(today, -13), to: addDays(today, -7) } };
  }
  const filter = resolveFilter(records, options);

  // The gate always checks the unfiltered tab figure; --strategy/--direction only narrow what follows.
  const tab =buildGeneratedSignalPerformance(records, { ...rangeOptions, timezone, now, grouping: "day" });
  const reproduction = {
    range: describeRange(rangeOptions),
    timezone,
    now: now.toISOString(),
    window: tab.range,
    netRealizedR: tab.metrics.netRealizedR,
    displayed: formatSignedR(tab.metrics.netRealizedR),
    expected: options.expect ?? null,
    reproduced: options.expect == null ? null : Number(Number(tab.metrics.netRealizedR).toFixed(2)) === Number(options.expect.toFixed(2))
  };
  if (reproduction.reproduced === false) reproduction.diagnostics = explainMismatch(records, options.expect, rangeOptions, timezone, now, today);

  const report = { reproduction, filter: null, windows: {}, generation: null };
  if (reproduction.reproduced === false && !options.force) return report;

  const filtered = records.filter(filter.matches);
  report.filter = { strategy: filter.strategy, direction: filter.direction, records: records.length, kept: filtered.length };
  for (const [key, window] of Object.entries(windows)) {
    report.windows[key] = decomposeWindow(filtered, window, timezone, now);
  }
  if (options.generatedSince) report.generation = generationByStrategyWeek(records, options.generatedSince, filter.strategy, timezone, today);
  return report;
}

// Resolves --strategy against the strategies actually present (a typo would otherwise report an empty window).
function resolveFilter(records, options) {
  let strategy = null;
  if (options.strategy) {
    const known = [...new Set(records.map(strategyOf))].sort();
    strategy = known.find((name) => name.toLowerCase() === options.strategy.toLowerCase());
    if (!strategy) throw new Error(`No signals with strategy "${options.strategy}". Known strategies: ${known.join(", ") || "none"}.`);
  }
  const direction = options.direction || null;
  return {
    strategy,
    direction,
    matches: (record) => (!strategy || strategyOf(record) === strategy) && (!direction || directionOf(record) === direction)
  };
}

// Signals generated per strategy per local Monday-start week, by created_at, over every strategy ever seen.
function generationByStrategyWeek(records, since, focusStrategy, timezone, today) {
  const firstWeek = weekStart(since);
  const weeks = [];
  for (let week = firstWeek; week <= weekStart(today); week = addDays(week, 7)) weeks.push(week);
  const lastGenerated = new Map();
  const counts = new Map();
  let undated = 0;
  for (const record of records) {
    const strategy = strategyOf(record);
    if (!counts.has(strategy)) counts.set(strategy, new Map());
    const created = validDate(record.createdAt);
    if (!created) { undated += 1; continue; }
    const day = localDate(created, timezone);
    if (!lastGenerated.has(strategy) || day > lastGenerated.get(strategy)) lastGenerated.set(strategy, day);
    if (day < since || day > today) continue;
    const week = weekStart(day);
    counts.get(strategy).set(week, (counts.get(strategy).get(week) || 0) + 1);
  }
  const rows = [...counts.entries()].map(([strategy, byWeek]) => {
    const perWeek = weeks.map((week) => byWeek.get(week) || 0);
    return { strategy, perWeek, total: sum(perWeek), lastGenerated: lastGenerated.get(strategy) || null };
  }).sort((a, b) => b.total - a.total || String(b.lastGenerated).localeCompare(String(a.lastGenerated)) || a.strategy.localeCompare(b.strategy));
  const totals = weeks.map((_, index) => sum(rows.map((row) => row.perWeek[index])));
  const focus = focusStrategy ? rows.find((row) => row.strategy === focusStrategy) : null;
  return {
    since,
    timezone,
    weeks: weeks.map((week) => ({ week, partial: week < since || addDays(week, 6) > today })),
    rows,
    totals,
    total: sum(totals),
    silentSince: rows.filter((row) => row.total === 0).map((row) => ({ strategy: row.strategy, lastGenerated: row.lastGenerated })),
    focus: focus ? { strategy: focus.strategy, sharePerWeek: weeks.map((_, index) => pct(focus.perWeek[index], totals[index])), share: pct(focus.total, sum(totals)) } : null,
    undatedSignals: undated
  };
}

function decomposeWindow(records, window, timezone, now) {
  const run = (category, grouping = "day") => buildGeneratedSignalPerformance(records, { ...window.rangeOptions, timezone, now, grouping, category });
  const base = run("strategy");
  const range = base.range;
  const from = range.from ? new Date(range.from) : null;
  const to = new Date(range.to);
  const inWindow = (date) => Boolean(date) && (!from || date >= from) && (range.toExclusive ? date < to : date <= to);

  // Same membership rule as the tab (terminal status with the canonical outcome timestamp inside the range;
  // "all" also keeps undated legacy outcomes), reconstructed so clustering, duplicates and symbol groups
  // can use fields the tab does not return.
  const members = records
    .map((record) => ({ ...record, outcomeAt: outcomeTimestamp(record) }))
    .filter((record) => terminalStatuses.has(record.status) && (range.key === "all" || inWindow(record.outcomeAt)));
  const check = summarize(members);
  for (const field of ["signals", "wins", "losses", "expired", "netRealizedR"]) {
    if (check[field] !== base.metrics[field]) {
      throw new Error(`Membership reconstruction diverged from the tab on ${field} (${check[field]} vs ${base.metrics[field]}); refusing to report.`);
    }
  }

  const createdInWindow = records.filter((record) => range.key === "all" || inWindow(validDate(record.createdAt)));
  const createdStatus = countBy(createdInWindow, (record) => record.status || "Unknown");
  const m = base.metrics;
  const symbols = run("symbol").categories;
  const worst = [...symbols].sort((a, b) => a.netRealizedR - b.netRealizedR).slice(0, 10);
  const top3 = worst.slice(0, 3).filter((row) => row.netRealizedR < 0);
  const top3Net = sum(top3.map((row) => row.netRealizedR));
  const losingSymbolsNet = sum(symbols.filter((row) => row.netRealizedR < 0).map((row) => row.netRealizedR));
  const grossSlR = sum(members.filter((r) => r.status === "Hit SL" && r.realizedR != null).map((r) => r.realizedR));
  const top3GrossSlR = sum(members.filter((r) => r.status === "Hit SL" && r.realizedR != null && top3.some((s) => s.value === symbolOf(r))).map((r) => r.realizedR));

  const localFrom = from ? localDate(from, timezone) : null;
  const localTo = localDate(new Date(to.getTime() - (range.toExclusive ? 1 : 0)), timezone);
  const windowDays = from ? Math.round((to - from) / DAY_MS) : Infinity;
  const groupMembers = [MAJORS_GROUP, OTHERS_GROUP].map((group) => ({ group, items: members.filter((record) => symbolGroup(symbolOf(record)) === group) }));

  return {
    label: window.label,
    range,
    headline: {
      signals: m.signals,
      tp: m.wins,
      sl: m.losses,
      expired: m.expired,
      decided: m.wins + m.losses,
      winRate: m.winRate,
      winRate95: wilsonInterval(m.wins, m.wins + m.losses),
      netRealizedR: m.netRealizedR,
      expectancyR: m.expectancyR,
      averageWinnerR: m.averageWinnerR,
      averageLoserR: m.averageLoserR,
      realizedRObservations: m.realizedRObservations,
      missingRealizedR: m.missingRealizedR
    },
    createdInWindow: {
      generated: createdInWindow.length,
      active: createdStatus.get("Active") || 0,
      statusBreakdown: Object.fromEntries([...createdStatus.entries()].sort((a, b) => b[1] - a[1]))
    },
    byStrategy: slim(base.categories),
    byDirection: slim(run("direction").categories),
    byTimeframe: slim(run("timeframe").categories),
    bySymbolGroup: groupMembers.map(({ group, items }) => ({ value: group, ...pick(summarize(items)) })),
    byDirectionAndSymbolGroup: [...new Set([...DIRECTIONS, ...members.map(directionOf)])].flatMap((direction) =>
      groupMembers.map(({ group, items }) => ({ value: `${direction} x ${group}`, ...pick(summarize(items.filter((record) => directionOf(record) === direction))) })))
      .filter((row) => row.signals > 0),
    symbolGroupMembers: Object.fromEntries(groupMembers.map(({ group, items }) => [group, [...new Set(items.map(symbolOf))].sort()])),
    byWeek: run("strategy", "week").timeline.map((week) => ({
      value: `${week.period}${isPartialWeek(week.period, localFrom, localTo) ? " (partial)" : ""}`,
      ...pick(week),
      cumulativeRealizedR: week.cumulativeRealizedR
    })),
    byDay: windowDays <= BY_DAY_MAX_DAYS
      ? base.timeline.map((day) => ({ value: day.period, ...pick(day), cumulativeRealizedR: day.cumulativeRealizedR }))
      : null,
    symbols: {
      distinctSymbols: symbols.length,
      losingSymbols: symbols.filter((row) => row.netRealizedR < 0).length,
      worst10: slim(worst),
      top3: top3.map((row) => row.value),
      top3NetR: round(top3Net),
      shareOfTotalNetR: m.netRealizedR < 0 ? pct(top3Net, m.netRealizedR) : null,
      shareOfLosingSymbolsNetR: losingSymbolsNet < 0 ? pct(top3Net, losingSymbolsNet) : null,
      shareOfGrossSlR: grossSlR < 0 ? pct(top3GrossSlR, grossSlR) : null
    },
    slClustering: {
      byMarketHitTime: clusterStopLosses(members, (record) => validDate(record.hitSlAt) || record.outcomeAt),
      byEvaluationTime: clusterStopLosses(members, (record) => record.outcomeAt)
    },
    duplicates: findDuplicates(members)
  };
}

// 95% Wilson score interval for a binomial proportion, in percent.
export function wilsonInterval(successes, trials, z = WILSON_Z) {
  if (!trials) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  return { low: round(Math.max(0, center - halfWidth) * 100, 1), high: round(Math.min(1, center + halfWidth) * 100, 1) };
}

// BTC-USD, BTC/USDT, BTCUSDT and BTC all map to BTC.
export function symbolGroup(symbol) {
  const upper = String(symbol || "").toUpperCase().trim();
  const parts = upper.split(/[-/:_ ]/);
  const base = parts.length > 1 ? parts[0] : upper.replace(/(USDT|USDC|USD|PERP)$/, "") || upper;
  return MAJOR_BASES.includes(base) ? MAJORS_GROUP : OTHERS_GROUP;
}

function clusterStopLosses(members, timeOf) {
  const stops = members
    .filter((record) => record.status === "Hit SL")
    .map((record) => ({ record, at: timeOf(record) }))
    .filter((entry) => entry.at)
    .sort((a, b) => a.at - b.at);
  const clustered = stops.filter((entry, index) =>
    (index > 0 && entry.at - stops[index - 1].at <= CLUSTER_WINDOW_MS) ||
    (index < stops.length - 1 && stops[index + 1].at - entry.at <= CLUSTER_WINDOW_MS));

  // Greedy: largest 60-minute window, remove its members, repeat — gives the top non-overlapping clusters.
  const clusters = [];
  let remaining = [...stops];
  while (remaining.length && clusters.length < 3) {
    let best = { start: 0, end: 0 };
    for (let start = 0, end = 0; start < remaining.length; start += 1) {
      while (end + 1 < remaining.length && remaining[end + 1].at - remaining[start].at <= CLUSTER_WINDOW_MS) end += 1;
      if (end - start > best.end - best.start) best = { start, end };
    }
    const window = remaining.slice(best.start, best.end + 1);
    if (window.length < 2) break;
    clusters.push({
      from: window[0].at.toISOString(),
      to: window[window.length - 1].at.toISOString(),
      stopLosses: window.length,
      netR: round(sum(window.map((entry) => entry.record.realizedR ?? 0))),
      directions: Object.fromEntries(countBy(window, (entry) => entry.record.direction || "Unknown")),
      timeframes: Object.fromEntries(countBy(window, (entry) => entry.record.timeframe || "Unknown")),
      symbols: [...new Set(window.map((entry) => symbolOf(entry.record)))].sort()
    });
    remaining = remaining.filter((entry, index) => index < best.start || index > best.end);
  }
  return {
    stopLosses: stops.length,
    inAnyClusterOf2Plus: clustered.length,
    largestClusterSize: clusters[0]?.stopLosses || (stops.length ? 1 : 0),
    topClusters: clusters
  };
}

function findDuplicates(members) {
  const groups = new Map();
  for (const record of members) {
    const created = validDate(record.createdAt);
    if (!created) continue;
    const hour = new Date(Math.floor(created.getTime() / HOUR_MS) * HOUR_MS).toISOString();
    const key = `${symbolOf(record)}|${record.direction}|${hour}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const duplicated = [...groups.values()].filter((group) => group.length > 1);
  const sameSetup = duplicated.filter((group) => new Set(group.map((r) => `${r.strategy}|${r.timeframe}`)).size < group.length);
  const signalsInGroups = duplicated.flat();
  return {
    hourBucket: "UTC clock hour of created_at",
    groups: duplicated.length,
    signalsInGroups: signalsInGroups.length,
    redundantSignals: sum(duplicated.map((group) => group.length - 1)),
    netRInGroups: round(sum(signalsInGroups.map((r) => r.realizedR ?? 0))),
    groupsWithRepeatedStrategyAndTimeframe: sameSetup.length,
    largestGroup: duplicated.reduce((max, group) => Math.max(max, group.length), 0),
    topSymbols: [...countBy(duplicated, (group) => symbolOf(group[0])).entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([symbol, count]) => ({ symbol, groups: count }))
  };
}

function explainMismatch(records, expect, rangeOptions, timezone, now, today) {
  const net = (options) => buildGeneratedSignalPerformance(records, { ...options, now, grouping: "day" }).metrics.netRealizedR;
  const target = Number(expect.toFixed(2));
  const otherRanges = ["today", "7d", "30d", "90d", "ytd", "all"].map((range) => ({ range, timezone, netRealizedR: net({ range, timezone }) }));
  const otherTimezones = DIAGNOSTIC_TIMEZONES.filter((zone) => zone !== timezone)
    .map((zone) => ({ range: describeRange(rangeOptions), timezone: zone, netRealizedR: net({ ...rangeOptions, timezone: zone }) }));

  // Walk the selected window as it stood on each of the last few days (preset ranges move daily; custom,
  // ytd and all are walked once) and find when its running total showed the target.
  const days = PRESET_DAYS[rangeOptions.range];
  const walks = days
    ? [0, 1, 2, 3].map((offset) => {
      const anchor = addDays(today, -offset);
      return { label: `window ending ${anchor}`, options: { range: "custom", from: addDays(anchor, -(days - 1)), to: anchor } };
    })
    : [{ label: `selected window (${describeRange(rangeOptions)})`, options: rangeOptions }];
  const sightings = walks.map(({ label, options }) => {
    const performance = buildGeneratedSignalPerformance(records, { ...options, timezone, now, grouping: "day" });
    const series = performance.realizedRSeries;
    const hits = series.map((point, index) => ({ point, next: series[index + 1] })).filter(({ point }) => Number(point.cumulativeRealizedR.toFixed(2)) === target);
    return {
      window: label,
      finalNetRealizedR: performance.metrics.netRealizedR,
      showedTargetDuring: hits.map(({ point, next }) => ({ from: point.outcomeAt, until: next ? next.outcomeAt : "end of window" }))
    };
  });
  const matches = [
    ...otherRanges.filter((row) => Number(row.netRealizedR.toFixed(2)) === target),
    ...otherTimezones.filter((row) => Number(row.netRealizedR.toFixed(2)) === target)
  ];
  return { otherRanges, otherTimezones, sightings, exactMatches: matches };
}

function outcomeTimestamp(record) {
  const canonical = record.status === "Hit TP" ? record.hitTpAt : record.status === "Hit SL" ? record.hitSlAt : record.status === "Expired" ? record.expiredAt : null;
  return validDate(record.outcomeEvaluatedAt) || validDate(canonical);
}

function summarize(records) { return summarizeRecords(records.map((record) => ({ ...record, confidence: record.calibratedConfidence }))); }
function slim(rows) { return rows.map((row) => ({ value: row.value, ...pick(row) })); }
function pick(row) {
  const decided = row.wins + row.losses;
  return {
    signals: row.signals, tp: row.wins, sl: row.losses, expired: row.expired, decided,
    winRate: row.winRate, winRate95: wilsonInterval(row.wins, decided), netRealizedR: row.netRealizedR, expectancyR: row.expectancyR
  };
}
function describeRange(rangeOptions) { return rangeOptions.range === "custom" ? `custom ${rangeOptions.from}..${rangeOptions.to}` : rangeOptions.range; }
function isPartialWeek(weekStart, localFrom, localTo) {
  return Boolean((localFrom && weekStart < localFrom) || addDays(weekStart, 6) > localTo);
}
function symbolOf(record) { return String(record.pair || record.symbol || "Unknown"); }
// Same fallbacks as the tab's normalizeRecord; direction is lowercased so Long/long compare equal.
function strategyOf(record) { return String(record.strategy || "Unknown"); }
function directionOf(record) { return String(record.direction || "Unknown").toLowerCase(); }
function weekStart(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return addDays(isoDate, -((new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7) - 1));
}
function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) || 0) + 1);
  return counts;
}
function localDate(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function round(value, digits = 3) { return Number(Number(value || 0).toFixed(digits)); }
function pct(part, whole) { return whole ? round((part / whole) * 100, 1) : null; }
function formatSignedR(value) { const number = Number(value || 0); return `${number > 0 ? "+" : ""}${number.toFixed(2)}R`; }

// ---------- text rendering ----------

export function renderText(report) {
  const lines = [];
  const r = report.reproduction;
  lines.push(`== Reproduction (admin Signals > Performance, range ${r.range}, no categorical filters) ==`);
  lines.push(`timezone ${r.timezone} | now ${r.now}`);
  lines.push(`window   ${r.window.from || "(start of data)"} -> ${r.window.to}${r.window.toExclusive ? " (exclusive)" : ""}, keyed on outcome timestamp`);
  lines.push(`net realized R ${r.displayed}${r.expected == null ? "" : ` | expected ${formatSignedR(r.expected)} -> ${r.reproduced ? "REPRODUCED" : "DOES NOT REPRODUCE"}`}`);
  if (r.diagnostics) {
    const d = r.diagnostics;
    lines.push("", "-- Why it may differ --");
    lines.push("Same timezone, other ranges:");
    for (const row of d.otherRanges) lines.push(`  ${row.range.padEnd(6)} ${formatSignedR(row.netRealizedR)}`);
    lines.push(`${r.range} in other timezones:`);
    for (const row of d.otherTimezones) lines.push(`  ${row.timezone.padEnd(22)} ${formatSignedR(row.netRealizedR)}`);
    lines.push(`${r.range} window as it stood on recent days (running total sightings of the expected figure):`);
    for (const s of d.sightings) {
      const seen = s.showedTargetDuring.length ? s.showedTargetDuring.map((w) => `${w.from} until ${w.until}`).join("; ") : "never";
      lines.push(`  ${s.window}: final ${formatSignedR(s.finalNetRealizedR)} | showed expected: ${seen}`);
    }
    lines.push(d.exactMatches.length ? `Exact matches: ${d.exactMatches.map((m) => `${m.range}@${m.timezone}`).join(", ")}` : "No range/timezone combination matches exactly.");
    if (!Object.keys(report.windows).length) {
      lines.push("", "Stopping before the breakdown. Re-run with the matching --range/--timezone/--now, or --force to proceed anyway.");
      return lines.join("\n");
    }
  }

  const f = report.filter;
  if (f && (f.strategy || f.direction)) {
    lines.push("", `== Filter for every breakdown below: strategy ${f.strategy || "all"} | direction ${f.direction || "all"} ==`);
    lines.push(`kept ${f.kept} of ${f.records} generated signals (any status). The reproduction above stays on the unfiltered tab figure.`);
  }

  for (const w of Object.values(report.windows)) {
    const h = w.headline;
    lines.push("", `== ${w.label}${f && (f.strategy || f.direction) ? `, filtered` : ""}: ${w.range.from || "(start of data)"} -> ${w.range.to} ==`);
    lines.push("Headline");
    lines.push(`   finished ${h.signals} | TP ${h.tp} | SL ${h.sl} | Expired ${h.expired} | decided (TP+SL) ${h.decided}`);
    lines.push(`   win rate TP/(TP+SL) ${fmtPct(h.winRate)} | 95% Wilson ${fmtCi(h.winRate95)}`);
    lines.push(`   net R ${formatSignedR(h.netRealizedR)} | expectancy/finished ${fmtR(h.expectancyR)} | avg winner ${fmtR(h.averageWinnerR)} | avg loser ${fmtR(h.averageLoserR)} | missing realized R ${h.missingRealizedR}`);
    lines.push(`   created in window: ${w.createdInWindow.generated} generated, ${w.createdInWindow.active} still Active (${Object.entries(w.createdInWindow.statusBreakdown).map(([s, c]) => `${s} ${c}`).join(", ") || "none"})`);
    lines.push(`   note: the tab windows on outcome time, so Active signals never appear in its counts; the line above is by created_at.`);
    lines.push("", "By symbol group"); lines.push(...table(w.bySymbolGroup));
    for (const [group, members] of Object.entries(w.symbolGroupMembers)) lines.push(`   ${group}: ${members.join(", ") || "none"}`);
    lines.push("", "By direction x symbol group"); lines.push(...table(w.byDirectionAndSymbolGroup));
    lines.push("", "By week (local, weeks start Monday)"); lines.push(...table(w.byWeek, true));
    if (w.byDay) { lines.push("", "By day (local)"); lines.push(...table(w.byDay, true)); }
    lines.push("", "By strategy"); lines.push(...table(w.byStrategy));
    lines.push("", "By direction"); lines.push(...table(w.byDirection));
    lines.push("   (Reported only. A single window's direction split is not evidence; see cross-strategy-direction-watch-report for the gated comparison.)");
    lines.push("", "By timeframe"); lines.push(...table(w.byTimeframe));
    const s = w.symbols;
    lines.push("", `Worst 10 symbols by net R (${s.distinctSymbols} symbols, ${s.losingSymbols} net-negative)`);
    lines.push(...table(s.worst10));
    lines.push(`   top 3 (${s.top3.join(", ") || "none"}) net ${formatSignedR(s.top3NetR)} = ${fmtPct(s.shareOfTotalNetR)} of total net R, ${fmtPct(s.shareOfLosingSymbolsNetR)} of net R across losing symbols, ${fmtPct(s.shareOfGrossSlR)} of gross SL R`);
    lines.push("", "SL clustering (60-minute windows)");
    for (const [label, c] of [["market hit time (hit_sl_at = open of the bar that touched SL)", w.slClustering.byMarketHitTime], ["evaluation time (outcome_evaluated_at)", w.slClustering.byEvaluationTime]]) {
      lines.push(`   by ${label}: ${c.stopLosses} SL, ${c.inAnyClusterOf2Plus} within 60m of another SL, largest cluster ${c.largestClusterSize}`);
      for (const cl of c.topClusters) {
        lines.push(`     ${cl.from} -> ${cl.to}: ${cl.stopLosses} SL, ${formatSignedR(cl.netR)} | ${fmtCounts(cl.directions)} | ${fmtCounts(cl.timeframes)} | ${cl.symbols.join(", ")}`);
      }
    }
    const dup = w.duplicates;
    lines.push("", `Duplicates (same symbol + direction + ${dup.hourBucket}, among finished signals in window)`);
    lines.push(`   ${dup.groups} groups, ${dup.signalsInGroups} signals in them, ${dup.redundantSignals} beyond the first, net R inside groups ${formatSignedR(dup.netRInGroups)}, largest group ${dup.largestGroup}`);
    lines.push(`   ${dup.groupsWithRepeatedStrategyAndTimeframe} groups repeat the same strategy+timeframe (rest are different strategies/timeframes agreeing)`);
    if (dup.topSymbols.length) lines.push(`   most-duplicated: ${dup.topSymbols.map((t) => `${t.symbol} (${t.groups})`).join(", ")}`);
  }
  if (report.generation) lines.push("", ...renderGeneration(report.generation));
  return lines.join("\n");
}

function renderGeneration(g) {
  const lines = [`== Signals generated per strategy per week since ${g.since} (by created_at, ${g.timezone} weeks starting Monday; all strategies and directions, filters not applied) ==`];
  if (!g.weeks.length) return [...lines, "   (no weeks: --generated-since is after today)"];
  const width = Math.max(10, ...g.rows.map((row) => row.strategy.length), "total generated".length);
  const columns = g.weeks.map(({ week, partial }) => `${week.slice(5)}${partial ? "*" : ""}`);
  lines.push(`   ${"".padEnd(width)} ${columns.map((c) => pad(c, 6)).join(" ")}  ${pad("total", 6)}  last generated`);
  for (const row of g.rows) {
    lines.push(`   ${row.strategy.padEnd(width)} ${row.perWeek.map((n) => pad(n, 6)).join(" ")}  ${pad(row.total, 6)}  ${row.lastGenerated || "never"}`);
  }
  lines.push(`   ${"total generated".padEnd(width)} ${g.totals.map((n) => pad(n, 6)).join(" ")}  ${pad(g.total, 6)}`);
  if (g.focus) lines.push(`   ${`${g.focus.strategy} share`.padEnd(width)} ${g.focus.sharePerWeek.map((v) => pad(v == null ? "n/a" : `${v.toFixed(0)}%`, 6)).join(" ")}  ${pad(g.focus.share == null ? "n/a" : `${g.focus.share.toFixed(0)}%`, 6)}`);
  lines.push("   * partial week (starts before --generated-since or runs past today)");
  lines.push(g.silentSince.length
    ? `   no signals since ${g.since}: ${g.silentSince.map((row) => `${row.strategy} (last ${row.lastGenerated || "never"})`).join(", ")}`
    : `   every strategy seen in the data generated at least one signal since ${g.since}`);
  if (g.undatedSignals) lines.push(`   ${g.undatedSignals} signals have no created_at and are not counted`);
  return lines;
}

function table(rows, cumulative = false) {
  if (!rows.length) return ["   (none)"];
  const width = Math.max(10, ...rows.map((row) => String(row.value).length));
  const header = `   ${"".padEnd(width)}  sig   TP   SL  Exp  dec   win%      95% CI      netR   exp/sig${cumulative ? "     cumR" : ""}`;
  return [header, ...rows.map((row) =>
    `   ${String(row.value).padEnd(width)} ${pad(row.signals, 4)} ${pad(row.tp, 4)} ${pad(row.sl, 4)} ${pad(row.expired, 4)} ${pad(row.decided, 4)} ${pad(fmtPct(row.winRate), 6)} ${pad(fmtCi(row.winRate95), 11)} ${pad(formatSignedR(row.netRealizedR), 9)} ${pad(fmtR(row.expectancyR), 9)}${cumulative ? ` ${pad(formatSignedR(row.cumulativeRealizedR), 8)}` : ""}`)];
}
function pad(value, width) { return String(value).padStart(width); }
function fmtPct(value) { return value == null ? "n/a" : `${Number(value).toFixed(1)}%`; }
function fmtCi(interval) { return interval ? `${interval.low.toFixed(1)}-${interval.high.toFixed(1)}%` : "n/a"; }
function fmtR(value) { return value == null ? "n/a" : `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(3)}R`; }
function fmtCounts(object) { return Object.entries(object).map(([key, count]) => `${key} ${count}`).join(" "); }

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const connectionString = String(process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const client = new Client({ connectionString, options: "-c default_transaction_read_only=on" });
  await client.connect();
  let rows;
  try {
    await client.query("BEGIN READ ONLY");
    rows = await queryPerformanceRows(client);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
  const report = buildDecomposition(rows.map(toPerformanceRecord), options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`);
  if (report.reproduction.reproduced === false && !options.force) process.exitCode = 2;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Weekly realized R decomposition failed: ${error.message}`);
    process.exitCode = 1;
  });
}
