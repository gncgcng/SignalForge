// Disposable, read-only diagnostic. Decomposes the admin Signals > Performance "7d" net realized R
// (and the prior 7 days) using the SAME population, window and math as the tab: the same
// generated_signals SELECT (no categorical filters, the tab's default) fed through
// buildGeneratedSignalPerformance. Prints aggregates and symbols only; no ids, no user data.
//
//   railway ssh -- node scripts/weekly-realized-r-decomposition.js --timezone <IANA zone of the browser> --expect -22.70
//
// Options:
//   --timezone <zone>  Browser timezone the tab used (the tab sends Intl's resolved zone). Default UTC.
//   --now <ISO>        Reference time (default: now). The 7d window is local calendar days, so it moves daily.
//   --expect <R>       Figure seen in the tab (e.g. -22.70). If it does not reproduce, the script prints why
//                      and stops before the breakdown (exit code 2) unless --force is given.
//   --force            Print the breakdown even when --expect does not reproduce.
//   --json             Emit the report as JSON instead of text.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  buildGeneratedSignalPerformance,
  normalizePerformanceTimezone,
  summarizeRecords
} from "../src/modules/admin-signals/generatedSignalPerformance.js";

const terminalStatuses = new Set(["Hit TP", "Hit SL", "Expired"]);
const HOUR_MS = 60 * 60 * 1000;
const CLUSTER_WINDOW_MS = 60 * 60 * 1000;
const DIAGNOSTIC_TIMEZONES = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Manila", "Asia/Singapore", "Australia/Sydney"];

export function parseArguments(argv) {
  const options = { timezone: "UTC", now: null, expect: null, force: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") { options.force = true; continue; }
    if (argument === "--json") { options.json = true; continue; }
    if (!["--timezone", "--now", "--expect"].includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value == null || (value.startsWith("--") && argument !== "--expect")) throw new Error(`${argument} requires a value.`);
    index += 1;
    if (argument === "--timezone") {
      const zone = normalizePerformanceTimezone(value);
      if (zone === "UTC" && !/^(etc\/)?(utc|gmt|zulu)$/i.test(value)) throw new Error(`Unrecognized timezone: ${value}`);
      options.timezone = zone;
    } else if (argument === "--now") {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) throw new Error("--now must be an ISO timestamp.");
      options.now = date;
    } else {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error("--expect must be a number such as -22.70.");
      options.expect = number;
    }
  }
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
  const windows = {
    current: { label: "Last 7 days (tab 7d)", rangeOptions: { range: "7d" } },
    prior: { label: "Prior 7 days", rangeOptions: { range: "custom", from: addDays(today, -13), to: addDays(today, -7) } }
  };

  const tab = buildGeneratedSignalPerformance(records, { ...windows.current.rangeOptions, timezone, now, grouping: "day" });
  const reproduction = {
    timezone,
    now: now.toISOString(),
    window: tab.range,
    netRealizedR: tab.metrics.netRealizedR,
    displayed: formatSignedR(tab.metrics.netRealizedR),
    expected: options.expect ?? null,
    reproduced: options.expect == null ? null : Number(Number(tab.metrics.netRealizedR).toFixed(2)) === Number(options.expect.toFixed(2))
  };
  if (reproduction.reproduced === false) reproduction.diagnostics = explainMismatch(records, options.expect, timezone, now, today);

  const report = { reproduction, windows: {} };
  if (reproduction.reproduced === false && !options.force) return report;

  for (const [key, window] of Object.entries(windows)) {
    report.windows[key] = decomposeWindow(records, window, timezone, now);
  }
  return report;
}

function decomposeWindow(records, window, timezone, now) {
  const run = (category) => buildGeneratedSignalPerformance(records, { ...window.rangeOptions, timezone, now, grouping: "day", category });
  const base = run("strategy");
  const from = new Date(base.range.from);
  const to = new Date(base.range.to);
  const inWindow = (date) => date && date >= from && (base.range.toExclusive ? date < to : date <= to);

  // Same membership rule as the tab (terminal status, canonical outcome timestamp inside the range),
  // reconstructed so clustering and duplicates can use fields the tab does not return.
  const members = records
    .map((record) => ({ ...record, outcomeAt: outcomeTimestamp(record) }))
    .filter((record) => terminalStatuses.has(record.status) && inWindow(record.outcomeAt));
  const check = summarizeRecords(members.map((record) => ({ ...record, confidence: record.calibratedConfidence })));
  for (const field of ["signals", "wins", "losses", "expired", "netRealizedR"]) {
    if (check[field] !== base.metrics[field]) {
      throw new Error(`Membership reconstruction diverged from the tab on ${field} (${check[field]} vs ${base.metrics[field]}); refusing to report.`);
    }
  }

  const createdInWindow = records.filter((record) => inWindow(validDate(record.createdAt)));
  const createdStatus = countBy(createdInWindow, (record) => record.status || "Unknown");
  const m = base.metrics;
  const symbols = run("symbol").categories;
  const worst = [...symbols].sort((a, b) => a.netRealizedR - b.netRealizedR).slice(0, 10);
  const top3 = worst.slice(0, 3).filter((row) => row.netRealizedR < 0);
  const top3Net = sum(top3.map((row) => row.netRealizedR));
  const losingSymbolsNet = sum(symbols.filter((row) => row.netRealizedR < 0).map((row) => row.netRealizedR));
  const grossSlR = sum(members.filter((r) => r.status === "Hit SL" && r.realizedR != null).map((r) => r.realizedR));
  const top3GrossSlR = sum(members.filter((r) => r.status === "Hit SL" && r.realizedR != null && top3.some((s) => s.value === symbolOf(r))).map((r) => r.realizedR));

  return {
    label: window.label,
    range: base.range,
    headline: {
      signals: m.signals,
      tp: m.wins,
      sl: m.losses,
      expired: m.expired,
      winRate: m.winRate,
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
    byDay: base.timeline.map((day) => ({ value: day.period, ...pick(day), cumulativeRealizedR: day.cumulativeRealizedR })),
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

function explainMismatch(records, expect, timezone, now, today) {
  const net = (options) => buildGeneratedSignalPerformance(records, { ...options, now, grouping: "day" }).metrics.netRealizedR;
  const target = Number(expect.toFixed(2));
  const otherRanges = ["today", "7d", "30d", "90d", "ytd", "all"].map((range) => ({ range, timezone, netRealizedR: net({ range, timezone }) }));
  const otherTimezones = DIAGNOSTIC_TIMEZONES.filter((zone) => zone !== timezone)
    .map((zone) => ({ range: "7d", timezone: zone, netRealizedR: net({ range: "7d", timezone: zone }) }));

  // Walk the 7d window as it stood on each of the last few days and find when its running total showed the target.
  const sightings = [];
  for (let offset = 0; offset <= 3; offset += 1) {
    const anchor = addDays(today, -offset);
    const performance = buildGeneratedSignalPerformance(records, { range: "custom", from: addDays(anchor, -6), to: anchor, timezone, now, grouping: "day" });
    const series = performance.realizedRSeries;
    const hits = series.map((point, index) => ({ point, next: series[index + 1] })).filter(({ point }) => Number(point.cumulativeRealizedR.toFixed(2)) === target);
    sightings.push({
      windowEndingLocalDay: anchor,
      finalNetRealizedR: performance.metrics.netRealizedR,
      showedTargetDuring: hits.map(({ point, next }) => ({ from: point.outcomeAt, until: next ? next.outcomeAt : "end of window" }))
    });
  }
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

function slim(rows) { return rows.map((row) => ({ value: row.value, ...pick(row) })); }
function pick(row) {
  return { signals: row.signals, tp: row.wins, sl: row.losses, expired: row.expired, winRate: row.winRate, netRealizedR: row.netRealizedR, expectancyR: row.expectancyR };
}
function symbolOf(record) { return String(record.pair || record.symbol || "Unknown"); }
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
  lines.push("== Reproduction (admin Signals > Performance, range 7d, no categorical filters) ==");
  lines.push(`timezone ${r.timezone} | now ${r.now}`);
  lines.push(`window   ${r.window.from} -> ${r.window.to} (exclusive), keyed on outcome timestamp`);
  lines.push(`net realized R ${r.displayed}${r.expected == null ? "" : ` | expected ${formatSignedR(r.expected)} -> ${r.reproduced ? "REPRODUCED" : "DOES NOT REPRODUCE"}`}`);
  if (r.diagnostics) {
    const d = r.diagnostics;
    lines.push("", "-- Why it may differ --");
    lines.push("Same timezone, other ranges:");
    for (const row of d.otherRanges) lines.push(`  ${row.range.padEnd(6)} ${formatSignedR(row.netRealizedR)}`);
    lines.push("7d in other timezones:");
    for (const row of d.otherTimezones) lines.push(`  ${row.timezone.padEnd(22)} ${formatSignedR(row.netRealizedR)}`);
    lines.push("7d window as it stood on recent days (running total sightings of the expected figure):");
    for (const s of d.sightings) {
      const seen = s.showedTargetDuring.length ? s.showedTargetDuring.map((w) => `${w.from} until ${w.until}`).join("; ") : "never";
      lines.push(`  window ending ${s.windowEndingLocalDay}: final ${formatSignedR(s.finalNetRealizedR)} | showed expected: ${seen}`);
    }
    lines.push(d.exactMatches.length ? `Exact matches: ${d.exactMatches.map((m) => `${m.range}@${m.timezone}`).join(", ")}` : "No range/timezone combination matches exactly.");
    if (!Object.keys(report.windows).length) {
      lines.push("", "Stopping before the breakdown. Re-run with the matching --timezone/--now, or --force to proceed anyway.");
      return lines.join("\n");
    }
  }

  for (const w of Object.values(report.windows)) {
    const h = w.headline;
    lines.push("", `== ${w.label}: ${w.range.from} -> ${w.range.to} ==`);
    lines.push(`1. finished signals ${h.signals} | TP ${h.tp} | SL ${h.sl} | Expired ${h.expired} | win rate TP/(TP+SL) ${fmtPct(h.winRate)}`);
    lines.push(`   net R ${formatSignedR(h.netRealizedR)} | expectancy/finished ${fmtR(h.expectancyR)} | avg winner ${fmtR(h.averageWinnerR)} | avg loser ${fmtR(h.averageLoserR)} | missing realized R ${h.missingRealizedR}`);
    lines.push(`   created in window: ${w.createdInWindow.generated} generated, ${w.createdInWindow.active} still Active (${Object.entries(w.createdInWindow.statusBreakdown).map(([s, c]) => `${s} ${c}`).join(", ") || "none"})`);
    lines.push(`   note: the tab windows on outcome time, so Active signals never appear in its counts; the line above is by created_at.`);
    lines.push("", "2. By strategy"); lines.push(...table(w.byStrategy));
    lines.push("", "   By direction"); lines.push(...table(w.byDirection));
    lines.push("   (Reported only. One week of direction split is not evidence; see cross-strategy-direction-watch-report for the gated comparison.)");
    lines.push("", "   By timeframe"); lines.push(...table(w.byTimeframe));
    lines.push("", "   By day (local)"); lines.push(...table(w.byDay, true));
    const s = w.symbols;
    lines.push("", `3. Worst 10 symbols by net R (${s.distinctSymbols} symbols, ${s.losingSymbols} net-negative)`);
    lines.push(...table(s.worst10));
    lines.push(`   top 3 (${s.top3.join(", ") || "none"}) net ${formatSignedR(s.top3NetR)} = ${fmtPct(s.shareOfTotalNetR)} of total net R, ${fmtPct(s.shareOfLosingSymbolsNetR)} of net R across losing symbols, ${fmtPct(s.shareOfGrossSlR)} of gross SL R`);
    lines.push("", "4. SL clustering (60-minute windows)");
    for (const [label, c] of [["market hit time (hit_sl_at = open of the bar that touched SL)", w.slClustering.byMarketHitTime], ["evaluation time (outcome_evaluated_at)", w.slClustering.byEvaluationTime]]) {
      lines.push(`   by ${label}: ${c.stopLosses} SL, ${c.inAnyClusterOf2Plus} within 60m of another SL, largest cluster ${c.largestClusterSize}`);
      for (const cl of c.topClusters) {
        lines.push(`     ${cl.from} -> ${cl.to}: ${cl.stopLosses} SL, ${formatSignedR(cl.netR)} | ${fmtCounts(cl.directions)} | ${fmtCounts(cl.timeframes)} | ${cl.symbols.join(", ")}`);
      }
    }
    const dup = w.duplicates;
    lines.push("", `5. Duplicates (same symbol + direction + ${dup.hourBucket}, among finished signals in window)`);
    lines.push(`   ${dup.groups} groups, ${dup.signalsInGroups} signals in them, ${dup.redundantSignals} beyond the first, net R inside groups ${formatSignedR(dup.netRInGroups)}, largest group ${dup.largestGroup}`);
    lines.push(`   ${dup.groupsWithRepeatedStrategyAndTimeframe} groups repeat the same strategy+timeframe (rest are different strategies/timeframes agreeing)`);
    if (dup.topSymbols.length) lines.push(`   most-duplicated: ${dup.topSymbols.map((t) => `${t.symbol} (${t.groups})`).join(", ")}`);
  }
  return lines.join("\n");
}

function table(rows, cumulative = false) {
  if (!rows.length) return ["   (none)"];
  const width = Math.max(10, ...rows.map((row) => String(row.value).length));
  const header = `   ${"".padEnd(width)}  sig   TP   SL  Exp   win%      netR   exp/sig${cumulative ? "     cumR" : ""}`;
  return [header, ...rows.map((row) =>
    `   ${String(row.value).padEnd(width)} ${pad(row.signals, 4)} ${pad(row.tp, 4)} ${pad(row.sl, 4)} ${pad(row.expired, 4)} ${pad(fmtPct(row.winRate), 6)} ${pad(formatSignedR(row.netRealizedR), 9)} ${pad(fmtR(row.expectancyR), 9)}${cumulative ? ` ${pad(formatSignedR(row.cumulativeRealizedR), 8)}` : ""}`)];
}
function pad(value, width) { return String(value).padStart(width); }
function fmtPct(value) { return value == null ? "n/a" : `${Number(value).toFixed(1)}%`; }
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
