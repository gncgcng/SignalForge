// "My trades": the user's own track record from the real trades they log, measured the same way as the setup track
// records (fees counted in R, Wilson interval on the win rate, month-block bootstrap on average R, same labels).
// Facts only. Pure, so tests can import it; the #my-trades view renders it.
import { DEFAULTS as FEE_DEFAULTS } from "./feeCost.js";
import { formatCount, formatPercent, formatR, indexTrackRecords, LABEL_TONES, trackRecordKey } from "./trackRecords.js";
import { BOOTSTRAP, LABELS, MIN_CASES, monthBlockBootstrap, trackRecordLabel, wilsonInterval } from "./trackRecordStats.js";

export const DEFAULT_FEE_RATE_PCT = FEE_DEFAULTS.feePerSidePct; // 0.60% per side
export const MIN_MONTHS_FOR_RANGE = 6;
export const COMPARISON_MIN_TRADES = 10;
export const OWN_SETUP_LABEL = "My own setup";
export const TOO_FEW_MONTHS = "Too few months for a range";
export const EMPTY_STATE = "Log your trades to see your real track record. Nothing here is shared or sold.";

const num = (value) => (value === null || value === undefined || value === "" ? NaN : Number(value));
const round = (value, digits = 3) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));
const monthOf = (iso) => new Date(iso).toISOString().slice(0, 7);

export function isClosed(trade) {
  return trade?.status === "closed";
}

// Per closed trade. Fees: what the user entered, otherwise an estimate of size x (entry + exit) x rate per side.
export function tradeMetrics(trade) {
  const entry = num(trade.entryPrice);
  const stop = num(trade.stopPrice);
  const size = num(trade.sizeUnits);
  const riskPerUnit = Math.abs(entry - stop);
  if (!isClosed(trade)) return { closed: false, riskPerUnit, riskAmount: size * riskPerUnit };
  const exit = num(trade.exitPrice);
  const grossR = trade.direction === "short" ? (entry - exit) / riskPerUnit : (exit - entry) / riskPerUnit;
  const feesEstimated = trade.feesPaid === null || trade.feesPaid === undefined || trade.feesPaid === "";
  const feeRatePct = Number.isFinite(num(trade.feeRatePct)) ? num(trade.feeRatePct) : DEFAULT_FEE_RATE_PCT;
  const fees = feesEstimated ? size * (entry + exit) * (feeRatePct / 100) : num(trade.feesPaid);
  const feesR = fees / (size * riskPerUnit);
  const grossPnl = trade.direction === "short" ? (entry - exit) * size : (exit - entry) * size;
  return {
    closed: true,
    riskPerUnit,
    riskAmount: size * riskPerUnit,
    grossR,
    fees,
    feesEstimated,
    feesR,
    netR: grossR - feesR,
    grossPnl,
    pnl: grossPnl - fees
  };
}

// Totals over closed trades only. Open trades are listed elsewhere and never counted here.
export function summarizeTrades(trades, { bootstrap = BOOTSTRAP } = {}) {
  const closed = trades.filter(isClosed).map((trade) => ({ trade, metrics: tradeMetrics(trade) }));
  const n = closed.length;
  const wins = closed.filter(({ metrics }) => metrics.netR > 0).length;
  const months = new Set(closed.map(({ trade }) => monthOf(trade.openedAt))).size;
  const interval = n && months >= MIN_MONTHS_FOR_RANGE
    ? monthBlockBootstrap(closed.map(({ trade, metrics }) => ({ month: monthOf(trade.openedAt), r: metrics.netR })), bootstrap)
    : null;
  const avgNetR95 = interval ? { low: round(interval.low), high: round(interval.high), months: interval.months } : null;
  const sum = (pick) => closed.reduce((total, entry) => total + pick(entry), 0);
  const grossLosses = sum(({ metrics }) => (metrics.grossPnl < 0 ? -metrics.grossPnl : 0));
  const totalFees = sum(({ metrics }) => metrics.fees);
  const summary = {
    n,
    wins,
    losses: n - wins,
    months,
    winRate: n ? round((wins / n) * 100, 1) : null,
    winRate95: wilsonInterval(wins, n),
    avgNetR: n ? round(sum(({ metrics }) => metrics.netR) / n) : null,
    avgNetR95,
    rangeNote: n && !avgNetR95 ? TOO_FEW_MONTHS : null,
    totalPnl: round(sum(({ metrics }) => metrics.pnl), 2),
    totalGrossPnl: round(sum(({ metrics }) => metrics.grossPnl), 2),
    totalFees: round(totalFees, 2),
    totalFeesR: round(sum(({ metrics }) => metrics.feesR)),
    feesShareOfGrossLosses: grossLosses > 0 ? round(totalFees / grossLosses, 4) : null,
    estimatedFeeTrades: closed.filter(({ metrics }) => metrics.feesEstimated).length
  };
  // Same label function and thresholds as the setup track records.
  return { ...summary, label: trackRecordLabel({ n, avgR95: avgNetR95 }) };
}

// "momentum breakout|long|15m" -> the record's own name when the file has it, else a readable fallback.
export function setupParts(setupKey, index = new Map()) {
  if (!setupKey) return null;
  const [strategy = "", direction = "", timeframe = ""] = String(setupKey).split("|");
  const record = index.get(setupKey);
  const name = record?.strategy || (strategy ? strategy.charAt(0).toUpperCase() + strategy.slice(1) : setupKey);
  return { name, direction, timeframe: record?.timeframe || timeframe, record: record || null };
}

export function setupLabel(setupKey, index = new Map()) {
  const parts = setupParts(setupKey, index);
  return parts ? `${parts.name} · ${parts.timeframe}` : OWN_SETUP_LABEL;
}

function groupBy(trades, keyOf) {
  const groups = new Map();
  for (const trade of trades) {
    const key = keyOf(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return groups;
}

export function journalStats(trades = [], { trackRecords = null, index = indexTrackRecords(trackRecords), bootstrap = BOOTSTRAP } = {}) {
  const closed = trades.filter(isClosed);
  const overall = summarizeTrades(closed, { bootstrap });
  const bySetup = [...groupBy(closed, (trade) => trade.setupKey || "").entries()]
    .map(([key, members]) => ({ key: key || null, name: setupLabel(key || null, index), ...summarizeTrades(members, { bootstrap }) }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const byDirection = ["long", "short"]
    .map((direction) => ({ direction, name: direction === "long" ? "Long" : "Short", ...summarizeTrades(closed.filter((trade) => trade.direction === direction), { bootstrap }) }))
    .filter((group) => group.n > 0);
  const comparisons = bySetup
    .map((group) => comparisonLine(group, index))
    .filter(Boolean);
  return {
    totalTrades: trades.length,
    openTrades: trades.length - closed.length,
    overall,
    bySetup,
    byDirection,
    comparisons
  };
}

// Only for a setup type with at least 10 of the user's closed trades and a matching long track record. Facts only.
export function comparisonLine(group, index = new Map()) {
  if (!group?.key || group.n < COMPARISON_MIN_TRADES) return null;
  const parts = setupParts(group.key, index);
  if (!parts?.record || parts.direction !== "long" || parts.record.direction !== "long") return null;
  const record = parts.record;
  return `Your ${parts.name} · ${parts.timeframe} trades: won ${formatPercent(group.winRate)} (${formatCount(group.n)} trade${group.n === 1 ? "" : "s"}). ` +
    `Historical record for this setup: ${formatPercent(record.winRate)} (${formatCount(record.n)} case${record.n === 1 ? "" : "s"}).`;
}

// ---- display ----

export function formatMoneySigned(value) {
  if (value == null || !Number.isFinite(Number(value))) return "n/a";
  const amount = Number(value);
  const text = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(amount));
  if (Number(Math.abs(amount).toFixed(2)) === 0) return text;
  return `${amount < 0 ? "−" : "+"}${text}`;
}

function intervalText(interval, unit) {
  if (!interval) return null;
  return unit === "R"
    ? `95% range ${formatR(interval.low)} to ${formatR(interval.high)}`
    : `95% range ${Math.round(interval.low)}–${Math.round(interval.high)}%`;
}

// View model for a summary: the same heading and tone rules as the setup track-record block.
export function describeSummary(summary) {
  const tone = LABEL_TONES[summary.label] || "neutral";
  const lowered = summary.label.charAt(0).toLowerCase() + summary.label.slice(1);
  return {
    tone,
    label: summary.label,
    heading: `Your record: ${lowered}`,
    tradesLine: summary.n
      ? [
        `${formatCount(summary.n)} closed trade${summary.n === 1 ? "" : "s"}`,
        `won ${formatPercent(summary.winRate)} (${intervalText(summary.winRate95, "%")})`,
        `average ${formatR(summary.avgNetR)} per trade after fees`
      ].join(" · ")
      : "No closed trades yet.",
    rangeLine: summary.n ? (summary.avgNetR95 ? `Average R: ${intervalText(summary.avgNetR95, "R")}` : `Average R: ${TOO_FEW_MONTHS}`) : null,
    pnlLine: summary.n ? `Total P&L after fees: ${formatMoneySigned(summary.totalPnl)}` : null,
    feesLine: summary.n
      ? `Fees: ${formatMoneySigned(-summary.totalFees)} in total, ${formatR(-summary.totalFeesR)} across all trades` +
        (summary.feesShareOfGrossLosses != null ? `, equal to ${formatPercent(summary.feesShareOfGrossLosses * 100)} of your gross losses` : "") +
        (summary.estimatedFeeTrades ? ` (estimated on ${formatCount(summary.estimatedFeeTrades)} trade${summary.estimatedFeeTrades === 1 ? "" : "s"})` : "") + "."
      : null,
    needsMore: summary.n < MIN_CASES
  };
}

export function renderJournalStatsHtml(stats, escapeHtml) {
  const view = describeSummary(stats.overall);
  const row = (group) => {
    const groupView = describeSummary(group);
    return `<tr>
      <th scope="row">${escapeHtml(group.name)}</th>
      <td data-label="Trades">${formatCount(group.n)}</td>
      <td data-label="Won">${formatPercent(group.winRate)}</td>
      <td data-label="Avg R after fees">${escapeHtml(formatR(group.avgNetR))}</td>
      <td data-label="Label"><span class="track-record-label track-record-${escapeHtml(groupView.tone)}">${escapeHtml(group.label)}</span></td>
    </tr>`;
  };
  const table = (title, groups) => groups.length ? `
    <div class="journal-breakdown">
      <h3>${escapeHtml(title)}</h3>
      <div class="track-records-table-wrap"><table class="track-records-table journal-breakdown-table">
        <thead><tr><th scope="col">${escapeHtml(title.replace(/^By /, "").replace(/^./, (c) => c.toUpperCase()))}</th><th scope="col">Trades</th><th scope="col">Won</th><th scope="col">Avg R after fees</th><th scope="col">Label</th></tr></thead>
        <tbody>${groups.map(row).join("")}</tbody>
      </table></div>
    </div>` : "";
  return `
    <section class="track-record track-record-${escapeHtml(view.tone)} journal-stats" aria-label="Your track record" data-journal-label="${escapeHtml(view.label)}">
      <strong class="track-record-heading">${escapeHtml(view.heading)}</strong>
      <p class="track-record-detail">${escapeHtml(view.tradesLine)}</p>
      ${view.rangeLine ? `<p class="track-record-detail">${escapeHtml(view.rangeLine)}</p>` : ""}
      ${view.pnlLine ? `<p class="track-record-detail">${escapeHtml(view.pnlLine)}</p>` : ""}
      ${view.feesLine ? `<p class="track-record-detail">${escapeHtml(view.feesLine)}</p>` : ""}
      ${stats.openTrades ? `<p class="track-record-note">${formatCount(stats.openTrades)} open trade${stats.openTrades === 1 ? " is" : "s are"} listed below and not counted.</p>` : ""}
      ${view.needsMore && stats.overall.n ? `<p class="track-record-note">Labels need at least ${MIN_CASES} closed trades.</p>` : ""}
      <p class="track-record-detail"><a class="track-record-link" href="#track-records">How we measure this</a></p>
    </section>
    ${stats.comparisons.map((line) => `<p class="journal-comparison">${escapeHtml(line)}</p>`).join("")}
    ${table("By setup type", stats.bySetup)}
    ${table("By direction", stats.byDirection)}`;
}

// ---- "Save to My trades" from the trade checker ----

export const MY_TRADES_PREFILL_KEYS = ["direction", "market", "entry", "stop", "target", "size", "setupKey", "timeframe", "feeRate"];

// The trade checker's planned levels and size become an open trade in the form. The setup type only carries over
// when the track-records file has that exact setup (strategy, direction, timeframe); otherwise "My own setup".
export function myTradesPrefill(input, result, index = new Map()) {
  if (!result?.ok) return null;
  const key = trackRecordKeyOf(input.setupType, result.direction, input.timeframe);
  const record = key ? index.get(key) : null;
  const prefill = {
    direction: result.direction,
    market: String(input.symbol || "").trim().toUpperCase().slice(0, 32),
    entry: String(result.entry),
    stop: String(result.stop),
    target: String(Number(result.target.toPrecision(10))),
    size: String(Number(result.units.toPrecision(6))),
    setupKey: record ? record.key : "",
    timeframe: record ? record.timeframe : String(input.timeframe || ""),
    feeRate: String(input.feePerSidePct ?? "")
  };
  return Object.fromEntries(Object.entries(prefill).filter(([, value]) => value !== ""));
}

function trackRecordKeyOf(setupType, direction, timeframe) {
  return !setupType || setupType === "own" || !timeframe ? null : trackRecordKey(setupType, direction, timeframe);
}

export function myTradesPrefillFromParams(params) {
  const prefill = {};
  for (const key of MY_TRADES_PREFILL_KEYS) {
    const value = params?.get?.(key);
    if (value !== null && value !== undefined && value !== "") prefill[key] = value;
  }
  return prefill;
}

export { LABELS, MIN_CASES };
