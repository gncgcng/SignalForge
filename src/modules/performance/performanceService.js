import { listPerformanceSignalsByUser } from "../../db/repositories.js";
import { getPair } from "../market-data/marketDataService.js";
import { calculateSignalStats, updateSignalsForUser } from "../signals/signalOutcomeService.js";

const timeframes = new Set(["5m", "15m", "1h", "4h"]);
const directions = new Set(["long", "short"]);
const sessions = new Set(["Asia", "London", "New York", "London/New York Overlap", "Low Liquidity"]);
const newsRiskFilters = new Set(["with-news-risk", "without-news-risk"]);

export async function getPerformance(user, input) {
  const filters = normalizeFilters(input);
  await updateSignalsForUser(user);
  const signals = await listPerformanceSignalsByUser(user.id, filters);
  return buildPerformanceAnalytics(signals, filters);
}

export function buildPerformanceAnalytics(signals, filters = {}) {
  const stats = calculateSignalStats(signals);
  const averageRiskReward = signals.length
    ? round(signals.reduce((sum, signal) => sum + signal.riskRewardRatio, 0) / signals.length)
    : 0;
  const byMarket = aggregateCounts(signals, (signal) => signal.symbol);
  const byTimeframe = aggregateCounts(signals, (signal) => signal.timeframe);
  const monthly = aggregateMonthly(signals);
  const bestMarket = findBestPerformer(signals, (signal) => signal.symbol);
  const bestTimeframe = findBestPerformer(signals, (signal) => signal.timeframe);
  const regimePerformance = aggregateRegimePerformance(signals);
  const bestRegime = findBestPerformer(signals, getSignalRegime);
  const confluencePerformance = aggregateConfluencePerformance(signals);
  const bestConfluenceRange = confluencePerformance
    .filter((item) => item.label !== "Unknown" && item.hitTpCount + item.hitSlCount > 0)
    .sort(rankPerformanceGroup)[0] || null;
  const sessionPerformance = aggregatePerformance(signals, getSignalSession);
  const newsRiskPerformance = aggregatePerformance(signals, getNewsRiskGroup);
  const bestSessionByMarket = aggregateBestSessionByMarket(signals);
  const smcPerformance = aggregateSmcPerformance(signals);
  const expectancyByRiskLevel = aggregateRiskExpectancy(signals, (signal) => (
    signal.riskPlan?.riskTier || signal.indicators?.riskTier || "Unknown"
  ));
  const stopStylePerformance = aggregateRiskExpectancy(signals, (signal) => (
    signal.riskPlan?.stopStyle || signal.indicators?.stopStyle || "Unknown"
  ));
  const targetStylePerformance = aggregateRiskExpectancy(signals, (signal) => (
    signal.riskPlan?.targetStyle || signal.indicators?.targetStyle || "Unknown"
  ));
  const vwapPerformance = aggregateEvidencePerformance(
    signals,
    (signal) => Boolean(signal.marketStructure?.vwapAligned ?? signal.indicators?.vwapAligned),
    "With VWAP alignment",
    "Without VWAP alignment"
  );
  const volumeProfilePerformance = aggregateEvidencePerformance(
    signals,
    (signal) => Boolean(
      signal.marketStructure?.volumeProfileAligned ?? signal.indicators?.volumeProfileAligned
    ),
    "With Volume Profile",
    "Without Volume Profile"
  );
  const correlationPerformance = aggregateEvidencePerformance(
    signals,
    (signal) => Boolean(
      (signal.correlation?.aligned ?? signal.indicators?.correlationAligned) &&
      !(signal.correlation?.conflict ?? signal.indicators?.correlationConflict)
    ),
    "Correlation filter aligned",
    "Without correlation alignment"
  );

  return {
    filters,
    summary: {
      ...stats,
      averageRiskReward,
      bestMarket,
      bestTimeframe,
      bestRegime,
      bestConfluenceRange
    },
    signalsByMarket: byMarket,
    signalsByTimeframe: byTimeframe,
    regimePerformance,
    confluencePerformance,
    sessionPerformance,
    newsRiskPerformance,
    bestSessionByMarket,
    smcPerformance,
    expectancyByRiskLevel,
    stopStylePerformance,
    targetStylePerformance,
    vwapPerformance,
    volumeProfilePerformance,
    correlationPerformance,
    monthlyPerformance: monthly,
    charts: {
      winRateOverTime: monthly.map((item) => ({
        label: item.label,
        winRate: item.winRate
      })),
      outcomes: [
        { label: "Hit TP", value: stats.hitTpCount },
        { label: "Hit SL", value: stats.hitSlCount },
        { label: "Expired", value: stats.expiredCount }
      ],
      marketDistribution: byMarket
    }
  };
}

function aggregateEvidencePerformance(signals, predicate, withLabel, withoutLabel) {
  return aggregatePerformance(signals, (signal) => predicate(signal) ? withLabel : withoutLabel);
}

function aggregateRiskExpectancy(signals, keyFn) {
  const completed = signals.filter((signal) => signal.status !== "Active");
  return aggregatePerformance(completed, keyFn).map((item) => ({
    ...item,
    expectancy: item.totalSignals ? round(item.netR / item.totalSignals) : 0
  }));
}

function aggregateSmcPerformance(signals) {
  const names = ["Liquidity sweep", "Fair value gap", "Order block", "BOS / CHoCH"];
  return names.map((name) => {
    const matching = signals.filter((signal) => getSmcFactors(signal).some(
      (factor) => factor.name === name && factor.passed
    ));
    return aggregatePerformance(matching, () => name)[0] || {
      label: name,
      totalSignals: 0,
      hitTpCount: 0,
      hitSlCount: 0,
      expiredCount: 0,
      netR: 0,
      winRate: 0
    };
  });
}

function getSmcFactors(signal) {
  return signal.smc?.factors || signal.indicators?.smcFactors || [];
}

function aggregatePerformance(signals, keyFn) {
  const groups = new Map();
  for (const signal of signals) {
    const key = keyFn(signal);
    const group = groups.get(key) || {
      label: key, totalSignals: 0, hitTpCount: 0, hitSlCount: 0, expiredCount: 0, netR: 0
    };
    group.totalSignals += 1;
    if (signal.status === "Hit TP") {
      group.hitTpCount += 1;
      group.netR += signal.riskRewardRatio;
    }
    if (signal.status === "Hit SL") {
      group.hitSlCount += 1;
      group.netR -= 1;
    }
    if (signal.status === "Expired") group.expiredCount += 1;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const resolved = group.hitTpCount + group.hitSlCount;
    return {
      ...group,
      netR: round(group.netR),
      winRate: resolved ? Math.round((group.hitTpCount / resolved) * 100) : 0
    };
  }).sort(rankPerformanceGroup);
}

function aggregateBestSessionByMarket(signals) {
  const markets = [...new Set(signals.map((signal) => signal.symbol))];
  return markets.map((symbol) => {
    const sessionsForMarket = aggregatePerformance(
      signals.filter((signal) => signal.symbol === symbol),
      getSignalSession
    ).filter((item) => item.hitTpCount + item.hitSlCount > 0);
    return {
      symbol,
      bestSession: sessionsForMarket[0] || null
    };
  }).filter((item) => item.bestSession);
}

function getSignalSession(signal) {
  return signal.session || signal.indicators?.session || "Unknown";
}

function getNewsRiskGroup(signal) {
  const level = signal.newsRisk?.level || signal.indicators?.newsRiskLevel || "Unknown";
  return ["Danger", "Elevated"].includes(level) ? "With news risk" : "Without news risk";
}

function aggregateConfluencePerformance(signals) {
  const groups = new Map();

  for (const signal of signals) {
    const label = getConfluenceRange(signal);
    const group = groups.get(label) || {
      label,
      totalSignals: 0,
      hitTpCount: 0,
      hitSlCount: 0,
      expiredCount: 0,
      netR: 0
    };
    group.totalSignals += 1;
    if (signal.status === "Hit TP") {
      group.hitTpCount += 1;
      group.netR += signal.riskRewardRatio;
    }
    if (signal.status === "Hit SL") {
      group.hitSlCount += 1;
      group.netR -= 1;
    }
    if (signal.status === "Expired") group.expiredCount += 1;
    groups.set(label, group);
  }

  return [...groups.values()].map((group) => {
    const resolved = group.hitTpCount + group.hitSlCount;
    return {
      ...group,
      netR: round(group.netR),
      winRate: resolved ? Math.round((group.hitTpCount / resolved) * 100) : 0
    };
  }).sort(rankPerformanceGroup);
}

function aggregateRegimePerformance(signals) {
  const groups = new Map();

  for (const signal of signals) {
    const label = getSignalRegime(signal);
    const group = groups.get(label) || {
      label,
      totalSignals: 0,
      hitTpCount: 0,
      hitSlCount: 0,
      expiredCount: 0,
      netR: 0
    };
    group.totalSignals += 1;
    if (signal.status === "Hit TP") {
      group.hitTpCount += 1;
      group.netR += signal.riskRewardRatio;
    }
    if (signal.status === "Hit SL") {
      group.hitSlCount += 1;
      group.netR -= 1;
    }
    if (signal.status === "Expired") group.expiredCount += 1;
    groups.set(label, group);
  }

  return [...groups.values()]
    .map((group) => {
      const resolved = group.hitTpCount + group.hitSlCount;
      return {
        ...group,
        netR: round(group.netR),
        winRate: resolved ? Math.round((group.hitTpCount / resolved) * 100) : 0
      };
    })
    .sort((a, b) => b.winRate - a.winRate || b.netR - a.netR || a.label.localeCompare(b.label));
}

function getSignalRegime(signal) {
  return signal.indicators?.regime || "Unknown";
}

function getConfluenceRange(signal) {
  const score = Number(signal.confluenceScore ?? signal.indicators?.confluenceScore);
  if (!Number.isFinite(score)) return "Unknown";
  if (score < 40) return "0-39";
  if (score < 60) return "40-59";
  if (score < 80) return "60-79";
  return "80-100";
}

function rankPerformanceGroup(a, b) {
  return b.winRate - a.winRate ||
    b.netR - a.netR ||
    b.totalSignals - a.totalSignals ||
    a.label.localeCompare(b.label);
}

function normalizeFilters(input) {
  const filters = {};

  if (input.from) {
    const from = parseDate(input.from, "from");
    filters.from = from.toISOString();
  }

  if (input.to) {
    const to = parseDate(input.to, "to");
    to.setUTCDate(to.getUTCDate() + 1);
    filters.to = to.toISOString();
  }

  if (input.symbol) {
    const pair = getPair(input.symbol);

    if (!pair) {
      throw validationError("Unknown performance market.");
    }

    filters.symbol = pair.symbol;
  }

  if (input.timeframe) {
    if (!timeframes.has(input.timeframe)) {
      throw validationError("Unsupported performance timeframe.");
    }
    filters.timeframe = input.timeframe;
  }

  if (input.direction) {
    if (!directions.has(input.direction)) {
      throw validationError("Unsupported performance direction.");
    }
    filters.direction = input.direction;
  }

  if (input.session) {
    if (!sessions.has(input.session)) throw validationError("Unsupported performance session.");
    filters.session = input.session;
  }

  if (input.newsRisk) {
    if (!newsRiskFilters.has(input.newsRisk)) throw validationError("Unsupported news-risk filter.");
    filters.newsRisk = input.newsRisk;
  }

  if (filters.from && filters.to && new Date(filters.from) >= new Date(filters.to)) {
    throw validationError("Performance start date must be before the end date.");
  }

  return filters;
}

function parseDate(value, name) {
  const date = new Date(`${value}T00:00:00.000Z`);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) {
    throw validationError(`Invalid ${name} date.`);
  }

  return date;
}

function aggregateCounts(signals, keyFn) {
  const counts = new Map();

  for (const signal of signals) {
    const key = keyFn(signal);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

function aggregateMonthly(signals) {
  const months = new Map();

  for (const signal of signals) {
    const date = new Date(signal.generatedAt);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const month = months.get(key) || {
      month: key,
      label: new Intl.DateTimeFormat("en-US", {
        month: "short",
        year: "2-digit",
        timeZone: "UTC"
      }).format(date),
      totalSignals: 0,
      hitTpCount: 0,
      hitSlCount: 0,
      expiredCount: 0,
      netR: 0
    };

    month.totalSignals += 1;
    if (signal.status === "Hit TP") {
      month.hitTpCount += 1;
      month.netR += signal.riskRewardRatio;
    }
    if (signal.status === "Hit SL") {
      month.hitSlCount += 1;
      month.netR -= 1;
    }
    if (signal.status === "Expired") {
      month.expiredCount += 1;
    }
    months.set(key, month);
  }

  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((month) => {
      const resolved = month.hitTpCount + month.hitSlCount;
      return {
        ...month,
        netR: round(month.netR),
        winRate: resolved ? Math.round((month.hitTpCount / resolved) * 100) : 0
      };
    });
}

function findBestPerformer(signals, keyFn) {
  const groups = new Map();

  for (const signal of signals) {
    const key = keyFn(signal);
    const group = groups.get(key) || {
      label: key,
      totalSignals: 0,
      hitTpCount: 0,
      hitSlCount: 0,
      netR: 0
    };

    group.totalSignals += 1;
    if (signal.status === "Hit TP") {
      group.hitTpCount += 1;
      group.netR += signal.riskRewardRatio;
    }
    if (signal.status === "Hit SL") {
      group.hitSlCount += 1;
      group.netR -= 1;
    }
    groups.set(key, group);
  }

  const ranked = [...groups.values()]
    .map((group) => {
      const resolved = group.hitTpCount + group.hitSlCount;
      return {
        ...group,
        netR: round(group.netR),
        winRate: resolved ? Math.round((group.hitTpCount / resolved) * 100) : 0
      };
    })
    .filter((group) => group.hitTpCount + group.hitSlCount > 0)
    .sort((a, b) => {
      return b.netR - a.netR ||
        b.winRate - a.winRate ||
        b.totalSignals - a.totalSignals ||
        a.label.localeCompare(b.label);
    });

  return ranked[0] || null;
}

function round(value) {
  return Number(value.toFixed(2));
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
