import {
  listJournalEntriesByUser,
  upsertTradeJournal
} from "../../db/repositories.js";
import { getPair } from "../market-data/marketDataService.js";
import { updateSignalsForUser } from "../signals/signalOutcomeService.js";

export const journalEmotions = [
  "Confident",
  "Fear",
  "FOMO",
  "Impatient",
  "Disciplined"
];

const emotionSet = new Set(journalEmotions);
const timeframes = new Set(["5m", "15m", "1h", "4h"]);

export async function getTradeJournal(user, input = {}) {
  const filters = normalizeFilters(input);
  await updateSignalsForUser(user);
  const entries = await listJournalEntriesByUser(user.id, filters);

  return {
    entries,
    stats: calculateJournalStats(entries),
    filters,
    emotions: journalEmotions
  };
}

export async function saveTradeJournal(user, paperTradeId, input) {
  const journal = validateJournal(input);
  const saved = await upsertTradeJournal(user.id, paperTradeId, journal);

  if (!saved) {
    const error = new Error("Paper trade not found.");
    error.statusCode = 404;
    throw error;
  }

  return getTradeJournal(user);
}

export function calculateJournalStats(entries) {
  const rated = entries.filter((entry) => Number.isInteger(entry.journal?.rating));
  const emotionCounts = new Map();

  for (const entry of entries) {
    for (const emotion of entry.journal?.emotionTags || []) {
      emotionCounts.set(emotion, (emotionCounts.get(emotion) || 0) + 1);
    }
  }

  const mostCommonEmotion = [...emotionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  return {
    averageTradeRating: rated.length
      ? round(rated.reduce((sum, entry) => sum + entry.journal.rating, 0) / rated.length)
      : 0,
    mostCommonEmotion: mostCommonEmotion
      ? { label: mostCommonEmotion[0], count: mostCommonEmotion[1] }
      : null,
    bestPerformingMarket: findBestGroup(entries, (entry) => entry.symbol),
    bestPerformingTimeframe: findBestGroup(entries, (entry) => entry.timeframe)
  };
}

function validateJournal(input) {
  const notesBeforeEntry = String(input.notesBeforeEntry || "").trim();
  const notesAfterExit = String(input.notesAfterExit || "").trim();
  const emotionTags = Array.isArray(input.emotionTags)
    ? [...new Set(input.emotionTags)]
    : [];
  const rating = input.rating === null || input.rating === "" || input.rating === undefined
    ? null
    : Number(input.rating);
  const screenshotUrl = String(input.screenshotUrl || "").trim();

  if (notesBeforeEntry.length > 4000 || notesAfterExit.length > 4000) {
    throw validationError("Journal notes must be 4,000 characters or fewer.");
  }

  if (emotionTags.some((emotion) => !emotionSet.has(emotion))) {
    throw validationError("Choose only supported emotion tags.");
  }

  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    throw validationError("Trade rating must be between 1 and 5 stars.");
  }

  if (screenshotUrl) {
    let parsed;
    try {
      parsed = new URL(screenshotUrl);
    } catch {
      throw validationError("Screenshot URL must be a valid web address.");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw validationError("Screenshot URL must use HTTP or HTTPS.");
    }
  }

  return {
    notesBeforeEntry,
    notesAfterExit,
    emotionTags,
    rating,
    screenshotUrl: screenshotUrl || null
  };
}

function normalizeFilters(input) {
  const filters = {};

  if (input.symbol) {
    const pair = getPair(input.symbol);
    if (!pair) throw validationError("Unknown journal market.");
    filters.symbol = pair.symbol;
  }

  if (input.timeframe) {
    if (!timeframes.has(input.timeframe)) {
      throw validationError("Unsupported journal timeframe.");
    }
    filters.timeframe = input.timeframe;
  }

  if (input.emotion) {
    if (!emotionSet.has(input.emotion)) {
      throw validationError("Unsupported journal emotion.");
    }
    filters.emotion = input.emotion;
  }

  if (input.from) {
    filters.from = parseDate(input.from, "start").toISOString();
  }

  if (input.to) {
    const to = parseDate(input.to, "end");
    to.setUTCDate(to.getUTCDate() + 1);
    filters.to = to.toISOString();
  }

  if (filters.from && filters.to && new Date(filters.from) >= new Date(filters.to)) {
    throw validationError("Journal start date must be before the end date.");
  }

  return filters;
}

function findBestGroup(entries, keyFn) {
  const groups = new Map();

  for (const entry of entries) {
    if (!["Hit TP", "Hit SL"].includes(entry.status)) continue;
    const key = keyFn(entry);
    const group = groups.get(key) || { label: key, trades: 0, netR: 0 };
    group.trades += 1;
    group.netR += Number(entry.realizedR || 0);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, netR: round(group.netR) }))
    .sort((a, b) => b.netR - a.netR || b.trades - a.trades || a.label.localeCompare(b.label))[0] || null;
}

function parseDate(value, name) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) {
    throw validationError(`Invalid journal ${name} date.`);
  }
  return date;
}

function round(value) {
  return Number(Number(value).toFixed(2));
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
