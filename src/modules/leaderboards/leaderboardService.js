import { appConfig } from "../../config/appConfig.js";
import {
  getLeaderboardEligibilityByUser,
  listLeaderboardPerformanceRows
} from "../../db/repositories.js";

const closedStatuses = new Set(["Hit TP", "Hit SL", "Expired", "Closed", "Manually closed"]);

export async function getLeaderboards(viewerId = null) {
  const rows = await listLeaderboardPerformanceRows();
  const leaderboards = buildLeaderboards(rows);
  leaderboards.viewerEligibility = viewerId
    ? await getLeaderboardEligibilityByUser(viewerId)
    : null;
  return leaderboards;
}

export async function recalculateLeaderboardStats() {
  const rows = await listLeaderboardPerformanceRows();
  const profiles = getRankableProfiles(rows);
  const users = new Set(rows.map((row) => row.userId).filter(Boolean)).size;
  const ranked = profiles.filter((profile) => profile.closedSignals > 0).length;
  const summary = { users, ranked, skipped: Math.max(0, users - ranked) };
  console.info(
    `[leaderboard] recalculated users=${summary.users} ranked=${summary.ranked} skipped=${summary.skipped}`
  );
  return summary;
}

export function buildLeaderboards(rows, now = new Date()) {
  const profiles = getRankableProfiles(rows).map((profile) => sanitizeProfile(profile));

  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  return {
    generatedAt: now.toISOString(),
    tabs: {
      topRMultiple: rankRows(
        profiles.filter((profile) => profile.closedSignals > 0),
        (a, b) => b.netR - a.netR || b.winRate - a.winRate || b.closedSignals - a.closedSignals
      ),
      bestWinRate: rankRows(
        profiles.filter((profile) => profile.closedSignals >= 3),
        (a, b) => b.winRate - a.winRate || b.netR - a.netR || b.closedSignals - a.closedSignals
      ),
      mostActive: rankRows(
        profiles.filter((profile) => profile.closedSignals > 0),
        (a, b) => b.closedSignals - a.closedSignals || b.netR - a.netR || b.winRate - a.winRate
      ),
      longestWinStreak: rankRows(
        profiles.filter((profile) => profile.longestWinStreak > 0),
        (a, b) => b.longestWinStreak - a.longestWinStreak || b.netR - a.netR || b.winRate - a.winRate
      ),
      monthlyChampions: rankRows(
        profiles
          .map((profile) => ({
            ...profile,
            netR: round(profile.monthly[currentMonth]?.netR || 0),
            winRate: profile.monthly[currentMonth]?.winRate || 0,
            closedSignals: profile.monthly[currentMonth]?.closedSignals || 0,
            totalSignals: profile.monthly[currentMonth]?.totalSignals || 0
          }))
          .filter((profile) => profile.closedSignals > 0),
        (a, b) => b.netR - a.netR || b.winRate - a.winRate || b.closedSignals - a.closedSignals
      )
    }
  };
}

function getRankableProfiles(rows) {
  return aggregateProfiles(rows)
    .filter((profile) => profile.publicProfileEnabled && profile.publicLeaderboardEnabled)
    .filter((profile) => !appConfig.adminEmails.has(String(profile.email || "").toLowerCase()));
}

function aggregateProfiles(rows) {
  const profiles = new Map();
  const seen = new Set();

  for (const row of rows) {
    if (!row.userId) continue;
    const username = row.username || fallbackUsername(row.userId);
    const profile = profiles.get(row.userId) || {
      userId: row.userId,
      username,
      hasUsername: Boolean(row.username),
      publicProfileEnabled: Boolean(row.publicProfileEnabled),
      publicLeaderboardEnabled: Boolean(row.publicLeaderboardEnabled),
      avatarInitial: username.slice(0, 1).toUpperCase(),
      plan: ["pro", "elite"].includes(String(row.plan || "").toLowerCase())
        ? String(row.plan).toLowerCase()
        : "free",
      email: row.email,
      totalSignals: 0,
      closedSignals: 0,
      hitTpCount: 0,
      hitSlCount: 0,
      expiredCount: 0,
      wins: 0,
      losses: 0,
      netR: 0,
      byMarket: new Map(),
      byTimeframe: new Map(),
      closedOutcomes: [],
      monthly: {}
    };
    profiles.set(row.userId, profile);

    if (!row.signalId) continue;
    const setupKey = row.setupKey || row.signalId;
    const dedupeKey = `${row.userId}:${setupKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (closedStatuses.has(row.status)) {
      const resultR = getResultR(row);
      profile.totalSignals += 1;
      profile.closedSignals += 1;
      profile.netR += resultR;
      if (row.status === "Hit TP") profile.hitTpCount += 1;
      if (row.status === "Hit SL") profile.hitSlCount += 1;
      if (row.status === "Expired") profile.expiredCount += 1;
      if (resultR > 0) profile.wins += 1;
      if (resultR < 0) profile.losses += 1;
      addGroup(profile.byMarket, row.symbol, resultR, row.status);
      addGroup(profile.byTimeframe, row.timeframe, resultR, row.status);
      profile.closedOutcomes.push({
        status: row.status,
        resultR,
        closedAt: row.resolvedAt || row.generatedAt || row.createdAt
      });
      addMonthly(profile.monthly, row, resultR);
    }

  }

  return [...profiles.values()].map((profile) => {
    const resolved = profile.wins + profile.losses;
    const streaks = calculateStreaks(profile.closedOutcomes);
    return {
      ...profile,
      netR: round(profile.netR),
      averageR: profile.closedSignals ? round(profile.netR / profile.closedSignals) : 0,
      winRate: resolved ? Math.round((profile.wins / resolved) * 1000) / 10 : 0,
      bestMarket: bestGroup(profile.byMarket),
      bestTimeframe: bestGroup(profile.byTimeframe),
      currentStreak: streaks.current,
      longestWinStreak: streaks.longestWinStreak
    };
  });
}

function sanitizeProfile(profile) {
  return {
    username: profile.username,
    profileUrl: profile.hasUsername ? `/u/${profile.username}` : null,
    avatarInitial: profile.avatarInitial,
    plan: profile.plan,
    netR: profile.netR,
    winRate: profile.winRate,
    totalSignals: profile.totalSignals,
    closedSignals: profile.closedSignals,
    hitTpCount: profile.hitTpCount,
    hitSlCount: profile.hitSlCount,
    expiredCount: profile.expiredCount,
    averageR: profile.averageR,
    bestMarket: profile.bestMarket,
    bestTimeframe: profile.bestTimeframe,
    currentStreak: profile.currentStreak,
    longestWinStreak: profile.longestWinStreak,
    monthly: profile.monthly
  };
}

function rankRows(rows, sorter) {
  return rows
    .sort((a, b) => sorter(a, b) || a.username.localeCompare(b.username))
    .slice(0, 50)
    .map((row, index) => ({
      rank: index + 1,
      ...row,
      monthly: undefined
    }));
}

function getResultR(row) {
  if (row.resultR !== null && row.resultR !== undefined && Number.isFinite(Number(row.resultR))) {
    return Number(row.resultR);
  }
  if (row.status === "Hit TP") return Number(row.riskRewardRatio || 0);
  if (row.status === "Hit SL") return -1;
  return 0;
}

function fallbackUsername(userId) {
  let hash = 2166136261;
  for (const character of String(userId || "anonymous")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `Trader ${String(hash >>> 0).slice(-4).padStart(4, "0")}`;
}

function addGroup(groups, label, resultR, status) {
  const key = label || "Unknown";
  const group = groups.get(key) || { label: key, netR: 0, wins: 0, losses: 0, total: 0 };
  group.total += 1;
  group.netR += resultR;
  if (resultR > 0) group.wins += 1;
  if (resultR < 0) group.losses += 1;
  groups.set(key, group);
}

function bestGroup(groups) {
  return [...groups.values()]
    .map((group) => {
      const resolved = group.wins + group.losses;
      return {
        label: group.label,
        netR: round(group.netR),
        winRate: resolved ? Math.round((group.wins / resolved) * 1000) / 10 : 0,
        total: group.total
      };
    })
    .sort((a, b) => b.netR - a.netR || b.winRate - a.winRate || b.total - a.total || a.label.localeCompare(b.label))[0] || null;
}

function addMonthly(monthly, row, resultR) {
  const date = new Date(row.resolvedAt || row.generatedAt || row.createdAt);
  if (Number.isNaN(date.getTime())) return;
  const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  const month = monthly[key] || { totalSignals: 0, closedSignals: 0, wins: 0, losses: 0, netR: 0 };
  month.totalSignals += 1;
  month.closedSignals += 1;
  month.netR += resultR;
  if (resultR > 0) month.wins += 1;
  if (resultR < 0) month.losses += 1;
  const resolved = month.wins + month.losses;
  month.winRate = resolved ? Math.round((month.wins / resolved) * 1000) / 10 : 0;
  month.netR = round(month.netR);
  monthly[key] = month;
}

function calculateStreaks(outcomes) {
  const ordered = outcomes
    .filter((outcome) => outcome.status === "Hit TP" || outcome.status === "Hit SL")
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  let currentType = null;
  let current = 0;
  let longestWinStreak = 0;

  for (const outcome of ordered) {
    const type = outcome.status === "Hit TP" ? "win" : "loss";
    current = type === currentType ? current + 1 : 1;
    currentType = type;
    if (type === "win") longestWinStreak = Math.max(longestWinStreak, current);
  }

  return {
    current: currentType ? `${current} ${currentType}${current === 1 ? "" : "s"}` : "No closed trades",
    longestWinStreak
  };
}

function round(value) {
  return Number(Number(value || 0).toFixed(2));
}
