// "My trades" (pivot phase 2c): pure fixtures for the maths, totals, labels, prefill, CSV export, validation and the
// privacy line. The DB-backed half (ownership, cascade, cap, migration) is scripts/my-trades-db-test.js.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMPARISON_MIN_TRADES,
  DEFAULT_FEE_RATE_PCT,
  EMPTY_STATE,
  TOO_FEW_MONTHS,
  comparisonLine,
  describeSummary,
  journalStats,
  myTradesPrefill,
  myTradesPrefillFromParams,
  renderJournalStatsHtml,
  summarizeTrades,
  tradeMetrics
} from "../public/journalStats.js";
import { checkTrade, tradeCheckPrefill } from "../public/tradeCheck.js";
import { BOOTSTRAP, LABELS, monthBlockBootstrap, trackRecordLabel, wilsonInterval } from "../public/trackRecordStats.js";
import { indexTrackRecords } from "../public/trackRecords.js";
import { wilsonInterval as weeklyWilsonInterval } from "./weekly-realized-r-decomposition.js";
import { csvCell, tradesToCsv, validateRealTrade } from "../src/modules/real-trades/realTradeService.js";
import { loadTrackRecords } from "../src/modules/track-records/trackRecordService.js";

const trackRecords = loadTrackRecords();
const index = indexTrackRecords(trackRecords);
const results = {};
const check = (name, fn) => { fn(); results[name] = true; };
const close = (actual, expected, digits = 10) => assert.equal(Number(actual.toFixed(digits)), expected);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);

const LONG = { status: "closed", direction: "long", entryPrice: 100, stopPrice: 99, exitPrice: 102, sizeUnits: 10, feesPaid: null, feeRatePct: 0.6, openedAt: "2026-01-05T10:00:00.000Z", closedAt: "2026-01-05T12:00:00.000Z" };

// n closed trades spread over `months` calendar months; `winner(i)` decides each one's exit.
function trades(n, months, winner = () => true, extra = {}) {
  return Array.from({ length: n }, (_, i) => {
    const month = String((i % months) + 1).padStart(2, "0");
    return { ...LONG, id: `t${i}`, exitPrice: winner(i) ? 103 : 98, feesPaid: 0, openedAt: `2025-${month}-10T10:00:00.000Z`, closedAt: `2025-${month}-11T10:00:00.000Z`, ...extra };
  });
}

check("maths 1. long: entry 100, stop 99, exit 102, size 10, fees estimated at 0.60% per side", () => {
  const m = tradeMetrics(LONG);
  close(m.riskPerUnit, 1);
  close(m.fees, 12.12); // 10 x (100 + 102) x 0.006
  assert.equal(m.feesEstimated, true);
  close(m.feesR, 1.212); // 12.12 / (10 x 1)
  close(m.grossR, 2);
  close(m.netR, 0.788);
  close(m.grossPnl, 20);
  close(m.pnl, 7.88); // 20 - 12.12
  // No rate on the trade: the default 0.60% per side (from feeCost.js) is used.
  assert.equal(DEFAULT_FEE_RATE_PCT, 0.6);
  close(tradeMetrics({ ...LONG, feeRatePct: null }).fees, 12.12);
});

check("maths 2. short: the mirror case gives the same net R", () => {
  const short = tradeMetrics({ ...LONG, direction: "short", entryPrice: 102, stopPrice: 103, exitPrice: 100 });
  const long = tradeMetrics(LONG);
  for (const key of ["riskPerUnit", "fees", "feesR", "grossR", "netR", "grossPnl", "pnl"]) close(short[key], Number(long[key].toFixed(10)));
  close(short.netR, 0.788);
});

check("maths 3. fees_paid given: the estimate is ignored", () => {
  const m = tradeMetrics({ ...LONG, feesPaid: 5, feeRatePct: 99 });
  assert.equal(m.feesEstimated, false);
  close(m.fees, 5);
  close(m.feesR, 0.5);
  close(m.netR, 1.5);
  close(m.pnl, 15);
  close(tradeMetrics({ ...LONG, feesPaid: 0 }).netR, 2); // zero fees is a real value, not "missing"
});

check("totals 1. open trades are listed but never counted", () => {
  const open = { ...LONG, id: "open", status: "open", exitPrice: null, closedAt: null, entryPrice: 50, stopPrice: 40 };
  const stats = journalStats([open, { ...LONG, id: "c1" }]);
  assert.equal(stats.totalTrades, 2);
  assert.equal(stats.openTrades, 1);
  assert.equal(stats.overall.n, 1);
  close(stats.overall.avgNetR, 0.788);
  assert.equal(stats.overall.totalPnl, 7.88);
  assert.deepEqual(summarizeTrades([open]).n, 0);
  assert.match(renderJournalStatsHtml(stats, escapeHtml), /1 open trade is listed below and not counted\./);
});

check("totals 2. Wilson interval on a known fixture, same as the existing helper", () => {
  assert.deepEqual(wilsonInterval(5, 10), { low: 23.7, high: 76.3 });
  assert.deepEqual(wilsonInterval(0, 10), { low: 0, high: 27.8 });
  for (let n = 1; n <= 60; n += 1) for (let k = 0; k <= n; k += 1) assert.deepEqual(wilsonInterval(k, n), weeklyWilsonInterval(k, n));
  const summary = summarizeTrades(trades(10, 2, (i) => i < 5));
  assert.equal(summary.wins, 5);
  assert.equal(summary.winRate, 50);
  assert.deepEqual(summary.winRate95, { low: 23.7, high: 76.3 });
});

check("totals 3. the month-block bootstrap is deterministic with its seed", () => {
  const sample = trades(40, 8, (i) => (i * 7) % 11 < 4);
  const a = summarizeTrades(sample);
  const b = summarizeTrades(sample);
  assert.ok(a.avgNetR95, "8 months gives a range");
  assert.deepEqual(a.avgNetR95, b.avgNetR95);
  const rows = sample.map((trade) => ({ month: trade.openedAt.slice(0, 7), r: tradeMetrics(trade).netR }));
  assert.deepEqual(monthBlockBootstrap(rows), monthBlockBootstrap(rows));
  assert.deepEqual(monthBlockBootstrap(rows, { seed: BOOTSTRAP.seed }), monthBlockBootstrap(rows));
  assert.notDeepEqual(monthBlockBootstrap(rows, { seed: 7 }), monthBlockBootstrap(rows));
  assert.equal(a.avgNetR95.months, 8);
});

check("totals 4. below 6 months: \"Too few months for a range\"", () => {
  const five = summarizeTrades(trades(40, 5));
  assert.equal(five.months, 5);
  assert.equal(five.avgNetR95, null);
  assert.equal(five.rangeNote, TOO_FEW_MONTHS);
  assert.equal(describeSummary(five).rangeLine, `Average R: ${TOO_FEW_MONTHS}`);
  const six = summarizeTrades(trades(40, 6));
  assert.equal(six.months, 6);
  assert.ok(six.avgNetR95);
  assert.equal(six.rangeNote, null);
  assert.match(describeSummary(six).rangeLine, /^Average R: 95% range \+\d\.\d\dR to \+\d\.\d\dR$/);
});

check("totals 5. label boundaries: 29 vs 30 closed trades, same function as the track records", () => {
  const at29 = summarizeTrades(trades(29, 7));
  const at30 = summarizeTrades(trades(30, 7));
  assert.equal(at29.label, LABELS.notEnoughHistory);
  assert.equal(at30.label, LABELS.madeMoney);
  assert.equal(at30.label, trackRecordLabel({ n: 30, avgR95: at30.avgNetR95 }));
  assert.equal(summarizeTrades(trades(30, 7, () => false)).label, LABELS.lostMoney);
  assert.equal(summarizeTrades(trades(30, 7, (i) => i % 5 < 2)).label, LABELS.noClearEdge); // 40% at +3R / -2R: average 0R
  // 30 trades but under 6 months: no interval, so never "made money" or "lost money".
  assert.equal(summarizeTrades(trades(30, 3)).label, LABELS.noClearEdge);
  // Green only for "Has made money".
  assert.equal(describeSummary(at30).tone, "gain");
  assert.equal(describeSummary(at29).tone, "neutral");
  assert.equal(describeSummary(summarizeTrades(trades(30, 7, () => false))).tone, "loss");
});

check("totals 6. breakdowns by setup type and direction; under 30 says \"Not enough history yet\"", () => {
  const sample = [
    ...trades(30, 7, () => true, { setupKey: "momentum breakout|long|15m", timeframe: "15m" }),
    ...trades(4, 2, () => false, { direction: "short", entryPrice: 100, stopPrice: 101, exitPrice: 102, setupKey: null })
  ];
  const stats = journalStats(sample, { trackRecords, index });
  const momentum = stats.bySetup.find((group) => group.key === "momentum breakout|long|15m");
  assert.equal(momentum.name, "Momentum breakout · 15m");
  assert.equal(momentum.label, LABELS.madeMoney);
  const own = stats.bySetup.find((group) => group.key === null);
  assert.equal(own.name, "My own setup");
  assert.equal(own.label, LABELS.notEnoughHistory);
  assert.deepEqual(stats.byDirection.map((group) => [group.direction, group.n, group.label]),
    [["long", 30, LABELS.madeMoney], ["short", 4, LABELS.notEnoughHistory]]);
  // Totals: fees as a share of gross losses (losses before fees).
  const withFees = summarizeTrades([{ ...LONG, exitPrice: 98, feesPaid: 4 }, { ...LONG, feesPaid: 6 }]);
  assert.equal(withFees.totalGrossPnl, 0); // -20 + 20
  assert.equal(withFees.totalFees, 10);
  assert.equal(withFees.feesShareOfGrossLosses, 0.5); // 10 / 20
  close(withFees.totalFeesR, 1);
});

check("comparison: >= 10 closed trades of a long setup with a record; facts only", () => {
  const momentum = trackRecords.records.find((record) => record.key === "momentum breakout|long|15m");
  const sample = trades(12, 3, (i) => i < 4, { setupKey: "momentum breakout|long|15m", timeframe: "15m" });
  const stats = journalStats(sample, { trackRecords, index });
  assert.deepEqual(stats.comparisons, [
    `Your Momentum breakout · 15m trades: won 33% (12 trades). Historical record for this setup: ${Math.round(momentum.winRate)}% (${momentum.n.toLocaleString("en-US")} cases).`
  ]);
  assert.equal(journalStats(sample.slice(0, COMPARISON_MIN_TRADES - 1), { trackRecords, index }).comparisons.length, 0, "9 trades: no line");
  assert.equal(comparisonLine({ key: null, n: 50, winRate: 40 }, index), null, "own setup: no line");
  const shortKey = trackRecords.records.find((record) => record.scope === "setup" && record.direction === "short")?.key;
  if (shortKey) assert.equal(comparisonLine({ key: shortKey, n: 50, winRate: 40 }, index), null, "short setups: no line");
});

check("prefill: trade checker -> Save to My trades fills an open trade with the planned levels and size", () => {
  const input = { direction: "long", symbol: "eth-usd", entry: "2400", stop: "2380", targetMode: "price", target: "2450", accountSize: "10000",
    riskPercent: "1", feePerSidePct: "0.60", slippagePerSidePct: "0.05", setupType: "Momentum breakout", timeframe: "15m" };
  const result = checkTrade(input, { trackRecords, index });
  const prefill = myTradesPrefill(input, result, index);
  assert.deepEqual(prefill, {
    direction: "long", market: "ETH-USD", entry: "2400", stop: "2380", target: "2450",
    size: String(Number(result.units.toPrecision(6))), setupKey: "momentum breakout|long|15m", timeframe: "15m", feeRate: "0.60"
  });
  assert.deepEqual(myTradesPrefillFromParams(new URLSearchParams(new URLSearchParams(prefill).toString())), prefill);
  // From a setup card: Check this trade -> Save to My trades keeps the card's levels and setup.
  const card = { id: "sig", symbol: "BTC-USD", timeframe: "1h", direction: "long", setupType: "Momentum breakout", entryPrice: 62000, stopLoss: 61380, takeProfit: 63240 };
  const fromCard = tradeCheckPrefill(card);
  const cardInput = { ...fromCard, accountSize: "5000", riskPercent: "1", feePerSidePct: "0.25", slippagePerSidePct: "0.05" };
  const cardPrefill = myTradesPrefill(cardInput, checkTrade(cardInput, { trackRecords, index }), index);
  assert.equal(cardPrefill.market, "BTC-USD");
  assert.equal(cardPrefill.entry, "62000");
  assert.equal(cardPrefill.stop, "61380");
  assert.equal(cardPrefill.target, "63240");
  assert.equal(cardPrefill.setupKey, index.has("momentum breakout|long|1h") ? "momentum breakout|long|1h" : undefined);
  // My own setup, or an invalid check, carries no setup key / nothing at all.
  assert.equal(myTradesPrefill({ ...input, setupType: "own" }, result, index).setupKey, undefined);
  assert.equal(myTradesPrefill(input, { ok: false, message: "x" }, index), null);
});

check("CSV: formula-injection prefix, commas and quotes escaped", () => {
  assert.equal(csvCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-5"), "'-5");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("\tx"), "'\tx");
  assert.equal(csvCell("He said \"hi\", ok"), "\"He said \"\"hi\"\", ok\"");
  assert.equal(csvCell("line1\nline2"), "\"line1\nline2\"");
  assert.equal(csvCell("BTC-USD"), "BTC-USD");
  assert.equal(csvCell(null), "");
  const csv = tradesToCsv([{ ...LONG, id: "rt_1", market: "BTC-USD", setupKey: null, timeframe: null, targetPrice: null, notes: "=cmd|' /C calc'!A0, \"x\"" }]);
  const [header, row] = csv.trimEnd().split("\r\n");
  assert.ok(header.startsWith("id,status,market,direction,setup_key,timeframe,entry_price"));
  assert.match(row, /^rt_1,closed,BTC-USD,long,,,100,99,,10,2026-01-05T10:00:00.000Z,102,2026-01-05T12:00:00.000Z,,0.6,12.12,yes,2.000,0.788,7.88,/);
  assert.ok(row.endsWith(",\"'=cmd|' /C calc'!A0, \"\"x\"\"\""), row);
  // A losing trade's negative R is prefixed too, so no cell can start a formula.
  assert.match(tradesToCsv([{ ...LONG, id: "rt_2", market: "X", exitPrice: 98, notes: "" }]), /,'-3\.\d{3},'-/);
});

check("validation: clear 400 messages", () => {
  const setupRecords = new Map(trackRecords.records.filter((record) => record.scope === "setup").map((record) => [record.key, record]));
  const base = { status: "open", market: "btc-usd", direction: "long", entryPrice: 100, stopPrice: 99, sizeUnits: 1, openedAt: "2026-01-05T10:00:00Z" };
  const fails = (input, message) => assert.throws(() => validateRealTrade({ ...base, ...input }, { setupRecords }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, message);
    return true;
  });
  fails({ stopPrice: 101 }, "For a long trade, the stop must be below the entry price.");
  fails({ direction: "short", stopPrice: 99 }, "For a short trade, the stop must be above the entry price.");
  fails({ status: "closed" }, "A closed trade needs its exit price and close time.");
  fails({ status: "closed", exitPrice: 102 }, "A closed trade needs its exit price and close time.");
  fails({ status: "closed", exitPrice: 102, closedAt: "2026-01-05T09:59:00Z" }, "The close time can't be before the open time.");
  fails({ exitPrice: 102 }, "An open trade has no exit price or close time. Mark it closed to add them.");
  fails({ market: "X".repeat(33) }, "The market name must be 32 characters or fewer.");
  fails({ market: " " }, "Enter the market, for example BTC-USD.");
  fails({ sizeUnits: 0 }, "The position size must be above zero.");
  fails({ entryPrice: "abc" }, "Enter the entry price.");
  fails({ openedAt: "" }, "Enter when the trade was opened.");
  fails({ setupKey: "made up|long|15m" }, "Choose a setup type from the list, or My own setup.");
  fails({ direction: "short", stopPrice: 101, setupKey: "momentum breakout|long|15m" }, "That setup type is for long trades. Choose My own setup or change the direction.");
  fails({ setupKey: "momentum breakout|long|15m", timeframe: "4h" }, "The timeframe doesn't match the chosen setup type.");
  fails({ notes: "n".repeat(2001) }, "Notes must be 2,000 characters or fewer.");
  fails({ feesPaid: -1 }, "Fees paid can't be negative.");
  fails({ status: "maybe" }, "Choose whether the trade is open or closed.");
  const ok = validateRealTrade({ ...base, setupKey: "Momentum breakout|long|15m", status: "closed", exitPrice: "102.5", closedAt: "2026-01-05T10:00:00Z" }, { setupRecords });
  assert.equal(ok.market, "BTC-USD");
  assert.equal(ok.setupKey, "momentum breakout|long|15m");
  assert.equal(ok.timeframe, "15m"); // taken from the setup key
  assert.equal(ok.exitPrice, 102.5);
  assert.equal(ok.closedAt, "2026-01-05T10:00:00.000Z"); // closing at the open time is allowed
});

check("privacy policy and empty state copy", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(app, /<p>Trades you log in My trades are stored only to show your own statistics\. They are never sold or shared\. You can export them at any time, and deleting your account deletes them\.<\/p>/);
  assert.equal(EMPTY_STATE, "Log your trades to see your real track record. Nothing here is shared or sold.");
  assert.match(html, /<a href="#my-trades" data-view-link="my-trades">My trades<\/a>/);
  assert.match(html, /<a href="#journal" data-view-link="journal">Paper journal<\/a>/);
  assert.match(html, /"#my-trades"/, "the boot guard protects #my-trades");
  assert.match(app, /data-save-to-my-trades>Save to My trades<\/button>/);
  const myTradesBlock = app.slice(app.indexOf("// ---- My trades"), app.indexOf("async function loadMarketBrief"));
  assert.ok(myTradesBlock.length > 1000);
  assert.doesNotMatch(myTradesBlock, /\bconfirm\(/, "no browser confirm() dialog");
});

console.log(JSON.stringify(results, null, 2));
