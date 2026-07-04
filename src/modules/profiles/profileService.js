import {
  findUserById,
  findUserByUsername,
  listPerformanceSignalsByUser,
  updateUserProfileSettings
} from "../../db/repositories.js";
import { appConfig } from "../../config/appConfig.js";
import { calculateSignalStats } from "../signals/signalOutcomeService.js";

export function validateUsername(username) {
  const value = String(username || "").trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(value)) {
    const error = new Error("Username must be 3-20 characters using only letters, numbers, and underscores.");
    error.code = "INVALID_USERNAME";
    error.statusCode = 400;
    throw error;
  }
  return value;
}

export async function getMyProfile(user) {
  const freshUser = await findUserById(user.id);
  const signals = await listPerformanceSignalsByUser(user.id);
  return buildProfile(freshUser, signals, { privateView: true });
}

export async function updateMyProfile(user, input) {
  const username = Object.hasOwn(input, "username")
    ? validateUsername(input.username)
    : undefined;
  const updated = await updateUserProfileSettings(user.id, {
    username,
    publicProfileEnabled: Object.hasOwn(input, "publicProfileEnabled")
      ? input.publicProfileEnabled === true
      : undefined
  });
  const signals = await listPerformanceSignalsByUser(user.id);
  return buildProfile(updated, signals, { privateView: true });
}

export async function getPublicProfile(username) {
  const user = await findUserByUsername(username);
  if (!user || !user.publicProfileEnabled || !user.username) {
    const error = new Error("Public profile not found.");
    error.statusCode = 404;
    throw error;
  }

  const signals = await listPerformanceSignalsByUser(user.id);
  return buildProfile(user, signals, { privateView: false });
}

function buildProfile(user, signals, { privateView }) {
  const stats = calculateSignalStats(signals);
  const closed = signals.filter((signal) => ["Hit TP", "Hit SL", "Expired"].includes(signal.status));
  const resolved = signals.filter((signal) => ["Hit TP", "Hit SL"].includes(signal.status));
  const netR = resolved.reduce((sum, signal) => sum + realizedR(signal), 0);
  const byMarket = bestGroup(closed, (signal) => signal.symbol);
  const byTimeframe = bestGroup(closed, (signal) => signal.timeframe);
  const streaks = calculateStreaks(signals);

  return {
    username: user.username,
    usernameRequired: !user.username,
    avatarInitial: (user.username || user.name || "S").slice(0, 1).toUpperCase(),
    joinedAt: user.createdAt,
    publicProfileEnabled: Boolean(user.publicProfileEnabled),
    publicProfileUrl: user.username ? `${appConfig.appUrl || ""}/u/${user.username}` : null,
    plan: user.plan || "free",
    stats: {
      signalsUnlocked: signals.length,
      closedSignals: closed.length,
      winRate: stats.winRate,
      netR: Number(netR.toFixed(2)),
      averageR: resolved.length ? Number((netR / resolved.length).toFixed(2)) : 0,
      favoriteMarket: byMarket?.label || null,
      bestTimeframe: byTimeframe?.label || null,
      currentStreak: streaks.current,
      bestStreak: streaks.best
    },
    private: privateView ? {
      usernameUpdatedAt: user.usernameUpdatedAt,
      canChangeUsernameAt: user.usernameUpdatedAt
        ? new Date(new Date(user.usernameUpdatedAt).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
        : null
    } : undefined
  };
}

function realizedR(signal) {
  if (signal.status === "Hit TP") return Number(signal.riskRewardRatio || 0);
  if (signal.status === "Hit SL") return -1;
  return 0;
}

function bestGroup(signals, keyFn) {
  const groups = new Map();
  for (const signal of signals) {
    const key = keyFn(signal) || "Unknown";
    const group = groups.get(key) || { label: key, wins: 0, losses: 0, netR: 0, total: 0 };
    group.total += 1;
    if (signal.status === "Hit TP") group.wins += 1;
    if (signal.status === "Hit SL") group.losses += 1;
    group.netR += realizedR(signal);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      winRate: group.wins + group.losses ? group.wins / (group.wins + group.losses) : 0
    }))
    .sort((a, b) => b.winRate - a.winRate || b.netR - a.netR || b.total - a.total)[0] || null;
}

function calculateStreaks(signals) {
  const ordered = signals
    .filter((signal) => ["Hit TP", "Hit SL"].includes(signal.status))
    .sort((a, b) => new Date(a.resolvedAt || a.generatedAt) - new Date(b.resolvedAt || b.generatedAt));
  let current = 0;
  let currentType = null;
  let best = 0;

  for (const signal of ordered) {
    const type = signal.status === "Hit TP" ? "win" : "loss";
    current = type === currentType ? current + 1 : 1;
    currentType = type;
    if (type === "win") best = Math.max(best, current);
  }

  return {
    current: currentType ? `${current} ${currentType}${current === 1 ? "" : "s"}` : "No closed trades",
    best: best ? `${best} win${best === 1 ? "" : "s"}` : "No wins yet"
  };
}
