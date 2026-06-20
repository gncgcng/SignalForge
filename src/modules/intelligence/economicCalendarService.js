import { appConfig } from "../../config/appConfig.js";

const majorPatterns = [
  { type: "CPI", pattern: /\b(cpi|consumer price|inflation rate)\b/i },
  { type: "FOMC", pattern: /\b(fomc|federal reserve|fed interest rate|fed rate decision)\b/i },
  { type: "NFP", pattern: /\b(nonfarm payroll|non farm payroll|nfp)\b/i },
  { type: "GDP", pattern: /\b(gdp|gross domestic product)\b/i },
  { type: "Interest Rate Decision", pattern: /\b(interest rate decision|rate decision|monetary policy decision)\b/i }
];
const cache = new Map();

export async function getEconomicCalendarContext(at = new Date()) {
  if (!appConfig.economicCalendar.apiKey) {
    return {
      configured: false,
      provider: "Trading Economics",
      upcomingEvents: [],
      newsRisk: unknownRisk("Economic calendar is not configured.")
    };
  }

  const date = at instanceof Date ? at : new Date(at);
  const start = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  const end = new Date(date.getTime() + 7 * 24 * 60 * 60 * 1000);
  const events = await fetchMajorEvents(start, end);

  return {
    configured: true,
    provider: "Trading Economics",
    upcomingEvents: events
      .filter((event) => event.date.getTime() >= Date.now())
      .slice(0, 8)
      .map(serializeEvent),
    newsRisk: assessNewsRisk(events, date)
  };
}

export function assessNewsRisk(events, at) {
  const target = at instanceof Date ? at : new Date(at);
  const candidates = events
    .map((event) => ({
      ...event,
      minutesAway: Math.round((event.date.getTime() - target.getTime()) / 60000)
    }))
    .filter((event) => event.minutesAway >= -45 && event.minutesAway <= 240)
    .sort((a, b) => Math.abs(a.minutesAway) - Math.abs(b.minutesAway));
  const nearest = candidates[0];

  if (!nearest) {
    return {
      level: "Clear",
      badge: "No News Risk",
      blockSignal: false,
      confidenceAdjustment: 0,
      explanation: "No configured high-impact event is within the four-hour risk window.",
      event: null
    };
  }

  const dangerous = nearest.minutesAway >= -30 && nearest.minutesAway <= 60;
  return {
    level: dangerous ? "Danger" : "Elevated",
    badge: "News Risk",
    blockSignal: dangerous,
    confidenceAdjustment: dangerous ? -20 : -8,
    explanation: dangerous
      ? `${nearest.type} is ${formatDistance(nearest.minutesAway)}. SignalForge blocks new setups through the high-impact event window.`
      : `${nearest.type} is ${formatDistance(nearest.minutesAway)}. Confidence is reduced ahead of the event.`,
    event: serializeEvent(nearest)
  };
}

async function fetchMajorEvents(start, end) {
  const startDate = formatDate(start);
  const endDate = formatDate(end);
  const key = `${startDate}:${endDate}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.cachedAt < appConfig.economicCalendar.cacheTtlMs) {
    return cached.events;
  }

  const url = new URL(
    `/calendar/country/All/${startDate}/${endDate}`,
    appConfig.economicCalendar.baseUrl
  );
  url.searchParams.set("c", appConfig.economicCalendar.apiKey);
  url.searchParams.set("f", "json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appConfig.marketData.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (response.status === 429) throw calendarError("Economic calendar rate limit reached.", 429);
    if (!response.ok) throw calendarError(`Economic calendar returned ${response.status}.`, response.status);
    const body = await response.json();
    if (!Array.isArray(body)) throw calendarError("Economic calendar returned an invalid response.", 502);
    const events = body.map(parseEvent).filter(Boolean)
      .sort((a, b) => a.date - b.date);
    cache.set(key, { cachedAt: Date.now(), events });
    return events;
  } finally {
    clearTimeout(timeout);
  }
}

function parseEvent(item) {
  const text = `${item.Category || ""} ${item.Event || ""}`;
  const match = majorPatterns.find((candidate) => candidate.pattern.test(text));
  const date = new Date(item.Date);
  if (!match || Number(item.Importance || 0) < 2 || Number.isNaN(date.getTime())) return null;
  return {
    id: String(item.CalendarId || `${item.Country}:${item.Event}:${item.Date}`),
    type: match.type,
    title: item.Event || item.Category || match.type,
    country: item.Country || "Unknown",
    importance: Number(item.Importance || 0),
    date,
    source: item.Source || ""
  };
}

function serializeEvent(event) {
  return event ? {
    id: event.id,
    type: event.type,
    title: event.title,
    country: event.country,
    importance: event.importance,
    date: event.date.toISOString(),
    source: event.source
  } : null;
}

function unknownRisk(explanation) {
  return {
    level: "Unknown",
    badge: "Calendar Unavailable",
    blockSignal: false,
    confidenceAdjustment: 0,
    explanation,
    event: null
  };
}

function formatDistance(minutes) {
  if (minutes === 0) return "happening now";
  if (minutes < 0) return `${Math.abs(minutes)} minutes ago`;
  return `in ${minutes} minutes`;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function calendarError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
