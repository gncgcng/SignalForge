// "My trades": real trades a user logs so SignalForge can show their own track record. Separate from paper trading.
import { tradeMetrics } from "../../../public/journalStats.js";
import { getTrackRecords } from "../track-records/trackRecordService.js";
import {
  deleteRealTrade,
  findRealTrade,
  insertRealTrade,
  listRealTrades,
  updateRealTrade
} from "./realTradeRepository.js";

export const MAX_TRADES_PER_USER = 5000;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_MARKET_LENGTH = 32;

const FIELDS = ["status", "market", "direction", "setupKey", "timeframe", "entryPrice", "stopPrice", "targetPrice",
  "sizeUnits", "openedAt", "exitPrice", "closedAt", "feesPaid", "feeRatePct", "notes"];

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const invalid = (message) => httpError(400, message);
const notFound = () => httpError(404, "Trade not found.");
const blank = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");

function number(value, { required, message }) {
  if (blank(value)) {
    if (required) throw invalid(message);
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw invalid(message);
  return parsed;
}

function timestamp(value, { required, message }) {
  if (blank(value)) {
    if (required) throw invalid(message);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(message);
  return date.toISOString();
}

// Setup keys the API accepts: the setup records in the published track-records file.
export function setupRecordIndex(file = getTrackRecords()) {
  const index = new Map();
  for (const record of file?.available ? file.records : []) {
    if (record.scope === "setup") index.set(record.key, record);
  }
  return index;
}

// Full validation of one trade. Throws a 400 with a plain message; returns the normalized row.
export function validateRealTrade(input = {}, { setupRecords = setupRecordIndex() } = {}) {
  const status = String(input.status || "").trim().toLowerCase();
  if (status !== "open" && status !== "closed") throw invalid("Choose whether the trade is open or closed.");

  const market = String(input.market ?? "").trim().toUpperCase();
  if (!market) throw invalid("Enter the market, for example BTC-USD.");
  if (market.length > MAX_MARKET_LENGTH) throw invalid(`The market name must be ${MAX_MARKET_LENGTH} characters or fewer.`);
  if (/[\u0000-\u001f\u007f]/.test(market)) throw invalid("The market name contains characters that aren't allowed.");

  const direction = String(input.direction || "").trim().toLowerCase();
  if (direction !== "long" && direction !== "short") throw invalid("Choose long or short.");

  const entryPrice = number(input.entryPrice, { required: true, message: "Enter the entry price." });
  const stopPrice = number(input.stopPrice, { required: true, message: "Enter the stop price." });
  if (entryPrice <= 0 || stopPrice <= 0) throw invalid("Entry and stop prices must be above zero.");
  if (direction === "long" && stopPrice >= entryPrice) throw invalid("For a long trade, the stop must be below the entry price.");
  if (direction === "short" && stopPrice <= entryPrice) throw invalid("For a short trade, the stop must be above the entry price.");

  const targetPrice = number(input.targetPrice, { required: false, message: "The target price must be a number." });
  if (targetPrice !== null && targetPrice <= 0) throw invalid("The target price must be above zero.");

  const sizeUnits = number(input.sizeUnits, { required: true, message: "Enter the position size in units." });
  if (sizeUnits <= 0) throw invalid("The position size must be above zero.");

  const openedAt = timestamp(input.openedAt, { required: true, message: "Enter when the trade was opened." });

  let exitPrice = null;
  let closedAt = null;
  if (status === "closed") {
    if (blank(input.exitPrice) || blank(input.closedAt)) throw invalid("A closed trade needs its exit price and close time.");
    exitPrice = number(input.exitPrice, { required: true, message: "The exit price must be a number." });
    if (exitPrice <= 0) throw invalid("The exit price must be above zero.");
    closedAt = timestamp(input.closedAt, { required: true, message: "The close time isn't a valid date." });
    if (new Date(closedAt) < new Date(openedAt)) throw invalid("The close time can't be before the open time.");
  } else if (!blank(input.exitPrice) || !blank(input.closedAt)) {
    throw invalid("An open trade has no exit price or close time. Mark it closed to add them.");
  }

  const feesPaid = number(input.feesPaid, { required: false, message: "Fees paid must be a number." });
  if (feesPaid !== null && feesPaid < 0) throw invalid("Fees paid can't be negative.");
  const feeRatePct = number(input.feeRatePct, { required: false, message: "The fee rate must be a number." });
  if (feeRatePct !== null && (feeRatePct < 0 || feeRatePct >= 100)) throw invalid("The fee rate must be between 0% and 100%.");

  let setupKey = blank(input.setupKey) ? null : String(input.setupKey).trim().toLowerCase();
  let timeframe = blank(input.timeframe) ? null : String(input.timeframe).trim();
  if (timeframe && timeframe.length > 8) throw invalid("Choose a timeframe from the list.");
  if (setupKey) {
    const record = setupRecords.get(setupKey);
    if (!record) throw invalid("Choose a setup type from the list, or My own setup.");
    if (record.direction !== direction) throw invalid(`That setup type is for ${record.direction} trades. Choose My own setup or change the direction.`);
    if (timeframe && timeframe !== record.timeframe) throw invalid("The timeframe doesn't match the chosen setup type.");
    timeframe = record.timeframe;
  }

  const notes = String(input.notes ?? "");
  if (notes.length > MAX_NOTES_LENGTH) throw invalid(`Notes must be ${MAX_NOTES_LENGTH.toLocaleString("en-US")} characters or fewer.`);

  return { status, market, direction, setupKey, timeframe, entryPrice, stopPrice, targetPrice, sizeUnits, openedAt,
    exitPrice, closedAt, feesPaid, feeRatePct, notes };
}

export async function listTrades(user) {
  return { trades: await listRealTrades(user.id), limit: MAX_TRADES_PER_USER };
}

export async function createTrade(user, input, options) {
  const trade = validateRealTrade(input, options);
  const result = await insertRealTrade(user.id, trade, { maxTrades: MAX_TRADES_PER_USER });
  if (result.limitReached) {
    throw invalid(`You've reached the limit of ${MAX_TRADES_PER_USER.toLocaleString("en-US")} logged trades. Delete or export older trades to add more.`);
  }
  return { trade: result.trade };
}

// Partial update: the patch is merged onto the stored trade and the whole result is validated again.
export async function patchTrade(user, id, patch = {}, options) {
  const existing = await findRealTrade(user.id, id);
  if (!existing) throw notFound();
  const merged = { ...existing };
  for (const field of FIELDS) if (Object.hasOwn(patch, field)) merged[field] = patch[field];
  if (merged.status === "open" && patch.status === "open") {
    merged.exitPrice = null;
    merged.closedAt = null;
  }
  const trade = validateRealTrade(merged, options);
  const saved = await updateRealTrade(user.id, id, trade);
  if (!saved) throw notFound();
  return { trade: saved };
}

export async function removeTrade(user, id) {
  if (!(await deleteRealTrade(user.id, id))) throw notFound();
  return { deleted: true, id };
}

// ---- CSV export ----

// Cells starting with = + - @ (or a tab / carriage return) are prefixed with ' so a spreadsheet can't run them as
// formulas. Then the usual CSV quoting: wrap in quotes when the cell holds a comma, quote or line break.
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll("\"", "\"\"")}"`;
  return text;
}

export const CSV_COLUMNS = [
  "id", "status", "market", "direction", "setup_key", "timeframe", "entry_price", "stop_price", "target_price",
  "size_units", "opened_at", "exit_price", "closed_at", "fees_paid", "fee_rate_pct", "fees_used", "fees_estimated",
  "gross_r", "net_r", "pnl_after_fees", "notes"
];

const fixed = (value, digits) => (value === null || value === undefined || !Number.isFinite(value) ? "" : value.toFixed(digits));

export function tradesToCsv(trades) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const trade of trades) {
    const metrics = tradeMetrics(trade);
    lines.push([
      trade.id, trade.status, trade.market, trade.direction, trade.setupKey, trade.timeframe, trade.entryPrice,
      trade.stopPrice, trade.targetPrice, trade.sizeUnits, trade.openedAt, trade.exitPrice, trade.closedAt,
      trade.feesPaid, trade.feeRatePct,
      metrics.closed ? fixed(metrics.fees, 2) : "",
      metrics.closed ? (metrics.feesEstimated ? "yes" : "no") : "",
      metrics.closed ? fixed(metrics.grossR, 3) : "",
      metrics.closed ? fixed(metrics.netR, 3) : "",
      metrics.closed ? fixed(metrics.pnl, 2) : "",
      trade.notes
    ].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export async function exportTradesCsv(user) {
  return tradesToCsv(await listRealTrades(user.id));
}
