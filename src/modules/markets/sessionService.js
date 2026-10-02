// Trading-session service: is a market open, and when does it next open or close.
//
// A market's `sessionCalendarId` (markets.session_calendar_id) selects a calendar; NULL means the
// market trades 24/7 (crypto). Calendars are defined here in exchange-local time and converted
// through the IANA timezone database, so DST is handled by construction. The trading_session_calendars
// table (migration 060) holds the same ids for referential integrity.
//
// Adding a calendar = adding an entry to `calendars` whose sessionForTradingDate() returns the
// session for one trading date. Everything else (isMarketOpen, nextOpen, nextClose, open-time
// arithmetic for signal expiry) is calendar-agnostic.
import { getNonCryptoMarket } from "./marketRegistry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Longest closure any calendar can produce (a holiday weekend is ~4 days); searches stop well past it.
const SEARCH_DAYS = 21;

const calendars = new Map();

// ---------------------------------------------------------------- US commodity week
// The week SignalForge has always used for Twelve Data commodities (spot metals and oil proxies):
// open Sunday 17:00 New York, close Friday 17:00 New York, no daily break. In winter that is
// exactly the old hardcoded Sunday 22:00 -> Friday 22:00 UTC; in summer (EDT) it is 21:00 UTC.
//
// Trading date D runs from 17:00 ET on D-1 to 17:00 ET on D (so Monday's session opens Sunday).
// Holidays follow CME Globex practice for US metals/energy:
//   closed all day: New Year's Day, Good Friday, Christmas Day
//   early halt at 13:00 ET: MLK Day, Presidents Day, Memorial Day, Juneteenth, Independence Day,
//     Labor Day, Thanksgiving
//   early halt at 13:45 ET: day after Thanksgiving, Christmas Eve
defineCalendar({
  id: "us_commodity_week",
  name: "US commodity week (17:00 New York, Sunday-Friday)",
  timezone: "America/New_York",
  sessionForTradingDate(date) {
    if (date.weekday === 0 || date.weekday === 6) return null;
    const holiday = usCommodityHolidays(date.year).get(date.key);
    if (holiday?.closed) return null;
    const previous = addCivilDays(date, -1);
    return {
      open: zonedTimeToUtcMs(previous, 17, 0, this.timezone),
      close: holiday?.earlyClose
        ? zonedTimeToUtcMs(date, holiday.earlyClose[0], holiday.earlyClose[1], this.timezone)
        : zonedTimeToUtcMs(date, 17, 0, this.timezone),
      holiday: holiday?.name || null
    };
  },
  // Trading date for an instant: at or after 17:00 New York it is already the next day's session.
  tradingDateFor(ms) {
    const local = zonedParts(ms, this.timezone);
    const date = civilDate(local.year, local.month, local.day);
    return local.hour >= 17 ? addCivilDays(date, 1) : date;
  }
});

// ---------------------------------------------------------------- public interface

// Clock used where a caller has no explicit time (e.g. building the scan universe). Tests pin it so
// session-dependent behaviour doesn't change with the day of the week the suite happens to run.
let clockOverrideMs = null;

export function sessionNow() {
  return clockOverrideMs === null ? new Date() : new Date(clockOverrideMs);
}

export function setSessionClockForTest(value) {
  clockOverrideMs = value === null || value === undefined ? null : new Date(value).getTime();
}

export function listSessionCalendarIds() {
  return [...calendars.keys()];
}

export function getSessionCalendar(id) {
  return id ? calendars.get(id) || null : null;
}

// `market` is a market object (anything with sessionCalendarId) or a symbol string.
export function isMarketOpen(market, atTime = sessionNow()) {
  const calendar = resolveCalendar(market);
  if (!calendar) return true;
  const ms = toMs(atTime);
  const session = calendar.sessionForTradingDate(calendar.tradingDateFor(ms));
  return Boolean(session && session.open <= ms && ms < session.close);
}

// Start of the next session that opens strictly after `afterTime`. Null for 24/7 markets.
export function nextOpen(market, afterTime = sessionNow()) {
  const calendar = resolveCalendar(market);
  if (!calendar) return null;
  const ms = toMs(afterTime);
  const session = sessionsFrom(calendar, ms).find((item) => item.open > ms);
  return session ? new Date(session.open) : null;
}

// End of the current session if open, otherwise of the next session. Null for 24/7 markets.
export function nextClose(market, afterTime = sessionNow()) {
  const calendar = resolveCalendar(market);
  if (!calendar) return null;
  const ms = toMs(afterTime);
  const session = sessionsFrom(calendar, ms).find((item) => item.close > ms);
  return session ? new Date(session.close) : null;
}

// Open-market milliseconds in [from, to). For 24/7 markets this is wall-clock time.
export function openMarketMsBetween(market, from, to) {
  const calendar = resolveCalendar(market);
  const fromMs = toMs(from);
  const toMsValue = toMs(to);
  if (toMsValue <= fromMs) return 0;
  if (!calendar) return toMsValue - fromMs;
  let total = 0;
  for (const session of sessionsFrom(calendar, fromMs, toMsValue)) {
    total += Math.max(0, Math.min(session.close, toMsValue) - Math.max(session.open, fromMs));
  }
  return total;
}

// The instant at which `durationMs` of open-market time has elapsed since `from`: a clock that
// pauses while the market is closed. Starting while closed, the clock starts at the next open.
// For 24/7 markets this is plain addition.
export function addOpenMarketTime(market, from, durationMs) {
  const calendar = resolveCalendar(market);
  const fromMs = toMs(from);
  if (!calendar || !(durationMs > 0)) return new Date(fromMs + Math.max(0, durationMs || 0));
  let remaining = durationMs;
  let cursor = fromMs;
  // Bounded walk: generous enough for any validity window, finite even for a broken calendar.
  for (let guard = 0; guard < 400; guard += 1) {
    const session = sessionsFrom(calendar, cursor).find((item) => item.close > cursor);
    if (!session) break;
    const start = Math.max(cursor, session.open);
    const available = session.close - start;
    if (remaining <= available) return new Date(start + remaining);
    remaining -= available;
    cursor = session.close;
  }
  // No sessions found (should not happen): fall back to wall-clock rather than never expiring.
  return new Date(fromMs + durationMs);
}

// Human-readable instant for user-facing messages, e.g. "Sun 19 Jul 21:00 UTC".
const readableFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
export function formatSessionTime(value) {
  if (!value) return null;
  return `${readableFormatter.format(new Date(value)).replace(",", "")} UTC`;
}

export function describeMarketSession(market, atTime = sessionNow()) {
  const calendar = resolveCalendar(market);
  if (!calendar) return { calendarId: null, alwaysOpen: true, open: true, nextOpen: null, nextClose: null };
  const ms = toMs(atTime);
  return {
    calendarId: calendar.id,
    timezone: calendar.timezone,
    alwaysOpen: false,
    open: isMarketOpen(market, ms),
    nextOpen: nextOpen(market, ms)?.toISOString() || null,
    nextClose: nextClose(market, ms)?.toISOString() || null
  };
}

// ---------------------------------------------------------------- internals

function defineCalendar(definition) {
  calendars.set(definition.id, Object.freeze({ ...definition }));
}

function resolveCalendar(market) {
  if (!market) return null;
  // A symbol, or a partial pair object that doesn't carry calendar fields, is looked up in the registry.
  const carriesCalendar = typeof market === "object" && ("sessionCalendarId" in market || "session_calendar_id" in market);
  const resolved = typeof market === "string"
    ? getNonCryptoMarket(market)
    : carriesCalendar ? market : getNonCryptoMarket(market.symbol);
  const id = resolved?.sessionCalendarId ?? resolved?.session_calendar_id ?? null;
  if (!id) return null;
  const calendar = calendars.get(id);
  if (!calendar) {
    // An unknown calendar id must not silently become "always open".
    throw new Error(`Unknown trading session calendar "${id}".`);
  }
  return calendar;
}

// Open periods overlapping [fromMs, toMs] (or the search horizon), in chronological order.
// Back-to-back trading-date sessions are merged, so Monday-Friday of the commodity week is one
// period and "next close" means the market actually stops trading, not a trading-date rollover.
function sessionsFrom(calendar, fromMs, toMs = fromMs + SEARCH_DAYS * DAY_MS) {
  const sessions = [];
  let date = addCivilDays(calendar.tradingDateFor(fromMs), -1);
  const lastDate = addCivilDays(calendar.tradingDateFor(toMs), 1);
  while (date.utcMs <= lastDate.utcMs) {
    const session = calendar.sessionForTradingDate(date);
    if (session) {
      const previous = sessions.at(-1);
      if (previous && previous.close === session.open) previous.close = session.close;
      else sessions.push({ open: session.open, close: session.close });
    }
    date = addCivilDays(date, 1);
  }
  return sessions.filter((session) => session.close > fromMs && session.open < toMs);
}

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Invalid session time: ${value}`);
  return ms;
}

// Civil (calendar) dates, anchored at UTC midnight so day arithmetic never meets DST.
function civilDate(year, month, day) {
  const utcMs = Date.UTC(year, month - 1, day);
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return { year: y, month: m, day: dd, weekday: d.getUTCDay(), utcMs, key: `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}` };
}

function addCivilDays(date, days) {
  return civilDate(date.year, date.month, date.day + days);
}

const partFormatters = new Map();
function zonedParts(ms, timeZone) {
  if (!partFormatters.has(timeZone)) {
    partFormatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric"
    }));
  }
  const parts = Object.fromEntries(partFormatters.get(timeZone).formatToParts(new Date(ms))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

function timeZoneOffsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000;
}

// UTC instant of a wall-clock time in `timeZone`. Session boundaries (13:00, 13:45, 17:00) never
// fall inside a DST gap or overlap, so the two-pass offset correction is exact for them.
function zonedTimeToUtcMs(date, hour, minute, timeZone) {
  const naive = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let utc = naive - timeZoneOffsetMs(naive, timeZone);
  utc = naive - timeZoneOffsetMs(utc, timeZone);
  return utc;
}

const holidayCache = new Map();
function usCommodityHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const holidays = new Map();
  const add = (date, entry) => { if (date) holidays.set(date.key, entry); };
  const closed = (name) => ({ name, closed: true });
  const early = (name, time = [13, 0]) => ({ name, earlyClose: time });

  // New Year's Day: a Saturday holiday is not moved back into the previous year (NYSE/CME rule).
  const newYear = civilDate(year, 1, 1);
  add(newYear.weekday === 6 ? null : observed(newYear), closed("New Year's Day"));
  add(addCivilDays(easterSunday(year), -2), closed("Good Friday"));
  add(observed(civilDate(year, 12, 25)), closed("Christmas Day"));

  add(nthWeekday(year, 1, 1, 3), early("Martin Luther King Jr. Day"));
  add(nthWeekday(year, 2, 1, 3), early("Presidents Day"));
  add(lastWeekday(year, 5, 1), early("Memorial Day"));
  if (year >= 2022) add(observed(civilDate(year, 6, 19)), early("Juneteenth"));
  add(observed(civilDate(year, 7, 4)), early("Independence Day"));
  add(nthWeekday(year, 9, 1, 1), early("Labor Day"));
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  add(thanksgiving, early("Thanksgiving"));
  add(addCivilDays(thanksgiving, 1), early("Day after Thanksgiving", [13, 45]));
  const christmasEve = civilDate(year, 12, 24);
  if (christmasEve.weekday >= 1 && christmasEve.weekday <= 5 && !holidays.has(christmasEve.key)) {
    add(christmasEve, early("Christmas Eve", [13, 45]));
  }

  holidayCache.set(year, holidays);
  return holidays;
}

// Saturday holidays are observed Friday, Sunday holidays Monday.
function observed(date) {
  if (date.weekday === 6) return addCivilDays(date, -1);
  if (date.weekday === 0) return addCivilDays(date, 1);
  return date;
}

function nthWeekday(year, month, weekday, n) {
  const first = civilDate(year, month, 1);
  return civilDate(year, month, 1 + ((weekday - first.weekday + 7) % 7) + (n - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const last = civilDate(year, month + 1, 0);
  return civilDate(year, month, last.day - ((last.weekday - weekday + 7) % 7));
}

// Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return civilDate(year, month, day);
}
