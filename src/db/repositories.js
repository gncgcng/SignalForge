import { appConfig } from "../config/appConfig.js";
import { createId } from "../shared/ids.js";
import { query, transaction } from "./client.js";

export async function findUserByEmail(email) {
  const result = await query(`
    SELECT u.*, s.status AS subscription_status, s.provider, s.provider_customer_id, s.current_period_end,
      c.free_signal_allowance, c.paid_credits
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    LEFT JOIN credit_balances c ON c.user_id = u.id
    WHERE u.email = $1
  `, [email]);

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserById(id) {
  const result = await query(`
    SELECT u.*, s.status AS subscription_status, s.provider, s.provider_customer_id, s.current_period_end,
      c.free_signal_allowance, c.paid_credits
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    LEFT JOIN credit_balances c ON c.user_id = u.id
    WHERE u.id = $1
  `, [id]);

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function createUser({ id, name, email, password }) {
  await transaction(async (client) => {
    await client.query(`
      INSERT INTO users (id, name, email, password_salt, password_hash, plan)
      VALUES ($1, $2, $3, $4, $5, 'trial')
    `, [id, name, email, password.salt, password.hash]);

    await client.query(`
      INSERT INTO subscriptions (id, user_id, status, provider)
      VALUES ($1, $2, 'trialing', 'stripe')
    `, [createId("sub"), id]);

    await client.query(`
      INSERT INTO credit_balances (user_id, trial_signals_used, free_signal_allowance, paid_credits)
      VALUES ($1, 0, $2, 0)
    `, [id, appConfig.freeSignalAllowance]);
  });

  return findUserById(id);
}

export async function createSession({ id, userId, expiresAt }) {
  await query(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)",
    [id, userId, expiresAt]
  );
}

export async function findSessionUser(sessionId) {
  const result = await query(`
    SELECT user_id
    FROM sessions
    WHERE id = $1 AND expires_at > now()
  `, [sessionId]);

  return result.rows[0] ? findUserById(result.rows[0].user_id) : null;
}

export async function deleteSession(sessionId) {
  await query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export async function deleteExpiredSessions() {
  await query("DELETE FROM sessions WHERE expires_at <= now()");
}

export async function incrementTrialSignalsUsed(userId) {
  await transaction(async (client) => {
    await client.query(`
      UPDATE users SET trial_signals_used = trial_signals_used + 1, updated_at = now()
      WHERE id = $1
    `, [userId]);
    await client.query(`
      UPDATE credit_balances SET trial_signals_used = trial_signals_used + 1, updated_at = now()
      WHERE user_id = $1
    `, [userId]);
  });
}

export async function saveUnlockedSignal(userId, signal) {
  return transaction(async (client) => {
    await client.query(`
      INSERT INTO saved_signals (
        id, user_id, symbol, timeframe, direction, entry_price, stop_loss, take_profit,
        risk_reward_ratio, confidence_score, reasoning, confirmations, indicators,
        market_source, generated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    `, [
      signal.id,
      userId,
      signal.symbol,
      signal.timeframe,
      signal.direction,
      signal.entryPrice,
      signal.stopLoss,
      signal.takeProfit,
      signal.riskRewardRatio,
      signal.confidenceScore,
      signal.reasoning,
      JSON.stringify(signal.confirmations || []),
      JSON.stringify(signal.indicators || {}),
      signal.marketSource,
      signal.generatedAt
    ]);

    await client.query(`
      INSERT INTO unlocked_signals (id, user_id, saved_signal_id)
      VALUES ($1, $2, $3)
    `, [createId("unlk"), userId, signal.id]);

    await client.query(`
      INSERT INTO signal_outcomes (saved_signal_id, status, updated_at)
      VALUES ($1, 'Active', now())
    `, [signal.id]);
  });

  return findSignalById(signal.id, userId);
}

export async function findSignalById(signalId, userId) {
  const result = await query(
    signalSelectSql("WHERE s.id = $1 AND s.user_id = $2"),
    [signalId, userId]
  );
  return result.rows[0] ? mapSignal(result.rows[0]) : null;
}

export async function listSignalsByUser(userId, executeQuery = query) {
  const result = await executeQuery(
    signalSelectSql("WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 100"),
    [userId]
  );
  return result.rows.map(mapSignal);
}

export async function listActiveSignals() {
  const result = await query(signalSelectSql("WHERE COALESCE(o.status, 'Active') = 'Active' ORDER BY s.created_at DESC"), []);
  return result.rows.map(mapSignal);
}

export async function updateSignalOutcome(signal) {
  await query(`
    INSERT INTO signal_outcomes (
      saved_signal_id, status, status_reason, resolved_at, last_tracking_error,
      last_tracking_attempt_at, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (saved_signal_id)
    DO UPDATE SET
      status = EXCLUDED.status,
      status_reason = EXCLUDED.status_reason,
      resolved_at = EXCLUDED.resolved_at,
      last_tracking_error = EXCLUDED.last_tracking_error,
      last_tracking_attempt_at = EXCLUDED.last_tracking_attempt_at,
      updated_at = now()
  `, [
    signal.id,
    signal.status || "Active",
    signal.statusReason || null,
    signal.resolvedAt || null,
    signal.lastTrackingError || null,
    signal.lastTrackingAttemptAt || null
  ]);
}

export async function listWatchlistByUser(userId) {
  const result = await query(`
    SELECT w.symbol, w.created_at, p.id AS preference_id, p.timeframe,
      p.direction, p.minimum_confidence, p.enabled
    FROM watchlist_markets w
    LEFT JOIN alert_preferences p
      ON p.user_id = w.user_id AND p.symbol = w.symbol
    WHERE w.user_id = $1
    ORDER BY w.created_at DESC
  `, [userId]);

  return result.rows.map((row) => ({
    symbol: row.symbol,
    createdAt: row.created_at,
    preference: row.preference_id ? {
      id: row.preference_id,
      timeframe: row.timeframe,
      direction: row.direction,
      minimumConfidence: Number(row.minimum_confidence),
      enabled: row.enabled
    } : null
  }));
}

export async function addWatchlistMarket(userId, symbol) {
  await query(`
    INSERT INTO watchlist_markets (user_id, symbol)
    VALUES ($1, $2)
    ON CONFLICT (user_id, symbol) DO NOTHING
  `, [userId, symbol]);
}

export async function removeWatchlistMarket(userId, symbol) {
  await transaction(async (client) => {
    await client.query(
      "DELETE FROM alert_preferences WHERE user_id = $1 AND symbol = $2",
      [userId, symbol]
    );
    await client.query(
      "DELETE FROM watchlist_markets WHERE user_id = $1 AND symbol = $2",
      [userId, symbol]
    );
  });
}

export async function upsertAlertPreference(userId, preference) {
  const result = await query(`
    INSERT INTO alert_preferences (
      id, user_id, symbol, timeframe, direction, minimum_confidence, enabled
    )
    VALUES ($1,$2,$3,$4,$5,$6,true)
    ON CONFLICT (user_id, symbol)
    DO UPDATE SET
      timeframe = EXCLUDED.timeframe,
      direction = EXCLUDED.direction,
      minimum_confidence = EXCLUDED.minimum_confidence,
      enabled = true,
      updated_at = now()
    RETURNING *
  `, [
    preference.id,
    userId,
    preference.symbol,
    preference.timeframe,
    preference.direction,
    preference.minimumConfidence
  ]);

  return result.rows[0];
}

export async function listEnabledAlertPreferences(userId) {
  const result = await query(`
    SELECT *
    FROM alert_preferences
    WHERE user_id = $1 AND enabled = true
  `, [userId]);
  return result.rows;
}

export async function saveDetectedAlert(userId, preference, setup) {
  const result = await query(`
    INSERT INTO detected_alerts (
      id, user_id, preference_id, setup_id, symbol, timeframe, direction,
      confidence_score, risk_reward_ratio, reasoning, confirmations
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (user_id, preference_id, setup_id) DO NOTHING
    RETURNING *
  `, [
    createId("alrt"),
    userId,
    preference.id,
    setup.id,
    setup.symbol,
    setup.timeframe,
    setup.direction,
    setup.confidenceScore,
    setup.riskRewardRatio,
    setup.reasoning,
    JSON.stringify(setup.confirmations || [])
  ]);

  return result.rows[0] || null;
}

export async function listDetectedAlertsByUser(userId) {
  const result = await query(`
    SELECT *
    FROM detected_alerts
    WHERE user_id = $1
    ORDER BY detected_at DESC
    LIMIT 100
  `, [userId]);
  return result.rows.map(mapDetectedAlert);
}

export async function markDetectedAlertRead(userId, alertId) {
  await query(`
    UPDATE detected_alerts
    SET read_at = COALESCE(read_at, now())
    WHERE id = $1 AND user_id = $2
  `, [alertId, userId]);
}

function mapDetectedAlert(row) {
  return {
    id: row.id,
    setupId: row.setup_id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    direction: row.direction,
    confidenceScore: Number(row.confidence_score),
    riskRewardRatio: Number(row.risk_reward_ratio),
    reasoning: row.reasoning,
    confirmations: row.confirmations || [],
    detectedAt: row.detected_at,
    readAt: row.read_at
  };
}

function signalSelectSql(whereClause) {
  return `
    SELECT s.*, o.status, o.status_reason, o.resolved_at, o.last_tracking_error,
      o.last_tracking_attempt_at, o.updated_at AS status_updated_at
    FROM saved_signals s
    LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
    ${whereClause}
  `;
}

function mapUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    password: {
      salt: row.password_salt,
      hash: row.password_hash
    },
    plan: row.plan,
    trialSignalsUsed: Number(row.trial_signals_used || 0),
    freeSignalAllowance: Number(row.free_signal_allowance || appConfig.freeSignalAllowance),
    paidCredits: Number(row.paid_credits || 0),
    subscription: {
      status: row.subscription_status || "trialing",
      provider: row.provider || "stripe",
      providerCustomerId: row.provider_customer_id,
      currentPeriodEnd: row.current_period_end,
      createdAt: row.created_at
    },
    createdAt: row.created_at
  };
}

function mapSignal(row) {
  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    riskRewardRatio: Number(row.risk_reward_ratio),
    confidenceScore: Number(row.confidence_score),
    reasoning: row.reasoning,
    confirmations: row.confirmations || [],
    indicators: row.indicators || {},
    marketSource: row.market_source,
    generatedAt: row.generated_at,
    status: row.status || "Active",
    statusReason: row.status_reason,
    resolvedAt: row.resolved_at,
    statusUpdatedAt: row.status_updated_at,
    lastTrackingError: row.last_tracking_error,
    lastTrackingAttemptAt: row.last_tracking_attempt_at
  };
}
