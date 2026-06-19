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

export async function getTelegramSettingsByUser(userId) {
  const result = await query(`
    SELECT *
    FROM telegram_notification_settings
    WHERE user_id = $1
  `, [userId]);
  return result.rows[0] ? mapTelegramSettings(result.rows[0]) : null;
}

export async function upsertTelegramSettings(userId, settings) {
  return transaction(async (client) => {
    const result = await client.query(`
      INSERT INTO telegram_notification_settings (
        user_id, chat_id, enabled, favorite_markets_only, timeframes,
        direction, minimum_confidence
      )
      VALUES ($1,$2,$3,true,$4,$5,$6)
      ON CONFLICT (user_id)
      DO UPDATE SET
        chat_id = EXCLUDED.chat_id,
        enabled = EXCLUDED.enabled,
        favorite_markets_only = true,
        timeframes = EXCLUDED.timeframes,
        direction = EXCLUDED.direction,
        minimum_confidence = EXCLUDED.minimum_confidence,
        updated_at = now()
      RETURNING *
    `, [
      userId,
      settings.chatId,
      settings.enabled,
      settings.timeframes,
      settings.direction,
      settings.minimumConfidence
    ]);

    await client.query(`
      UPDATE telegram_notification_queue
      SET chat_id = $2, updated_at = now()
      WHERE user_id = $1 AND status = 'queued'
    `, [userId, settings.chatId]);

    return mapTelegramSettings(result.rows[0]);
  });
}

export async function setTelegramNotificationsEnabled(userId, enabled) {
  return transaction(async (client) => {
    const result = await client.query(`
      UPDATE telegram_notification_settings
      SET enabled = $2, updated_at = now()
      WHERE user_id = $1
      RETURNING *
    `, [userId, enabled]);

    if (!enabled) {
      await client.query(`
        UPDATE telegram_notification_queue
        SET status = 'failed',
          last_error = 'Notifications disabled by user.',
          next_attempt_at = 'infinity'::timestamptz,
          updated_at = now()
        WHERE user_id = $1 AND status IN ('queued', 'failed')
      `, [userId]);
    }

    return result.rows[0] ? mapTelegramSettings(result.rows[0]) : null;
  });
}

export async function enqueueTelegramNotification(userId, settings, setup) {
  const result = await query(`
    INSERT INTO telegram_notification_queue (
      id, user_id, setup_key, chat_id, payload
    )
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (user_id, setup_key) DO NOTHING
    RETURNING id
  `, [
    createId("tgq"),
    userId,
    setup.setupKey,
    settings.chatId,
    JSON.stringify(setup)
  ]);
  return result.rows[0] || null;
}

export async function claimNextTelegramNotification() {
  return transaction(async (client) => {
    const result = await client.query(`
      SELECT q.*
      FROM telegram_notification_queue q
      JOIN telegram_notification_settings s ON s.user_id = q.user_id
      WHERE s.enabled = true
        AND (
          (q.status IN ('queued', 'failed') AND q.next_attempt_at <= now())
          OR (q.status = 'sending' AND q.updated_at < now() - interval '5 minutes')
        )
      ORDER BY q.created_at
      LIMIT 1
      FOR UPDATE OF q SKIP LOCKED
    `);
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    await client.query(`
      UPDATE telegram_notification_queue
      SET status = 'sending', attempts = attempts + 1, updated_at = now()
      WHERE id = $1
    `, [row.id]);

    return {
      id: row.id,
      userId: row.user_id,
      chatId: row.chat_id,
      payload: row.payload,
      attempts: Number(row.attempts) + 1
    };
  });
}

export async function markTelegramNotificationSent(id) {
  await query(`
    UPDATE telegram_notification_queue
    SET status = 'sent', sent_at = now(), last_error = null, updated_at = now()
    WHERE id = $1
  `, [id]);
}

export async function markTelegramNotificationFailed(id, error, retry) {
  await query(`
    UPDATE telegram_notification_queue
    SET status = 'failed',
      last_error = $2,
      next_attempt_at = CASE
        WHEN $3 THEN now() + interval '1 minute'
        ELSE 'infinity'::timestamptz
      END,
      updated_at = now()
    WHERE id = $1
  `, [id, error, retry]);
}

export async function createTelegramConnectionCode(userId, code, expiresAt) {
  return transaction(async (client) => {
    await client.query(`
      UPDATE telegram_connection_codes
      SET status = 'expired'
      WHERE user_id = $1 AND status = 'pending'
    `, [userId]);
    await client.query(`
      INSERT INTO telegram_connection_codes (code, user_id, expires_at)
      VALUES ($1, $2, $3)
    `, [code, userId, expiresAt]);
  });
}

export async function getTelegramConnectionCodeByUser(userId) {
  const result = await query(`
    SELECT *
    FROM telegram_connection_codes
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId]);
  return result.rows[0] || null;
}

export async function confirmTelegramConnectionCode(code, chatId) {
  return transaction(async (client) => {
    const result = await client.query(`
      SELECT *
      FROM telegram_connection_codes
      WHERE code = $1
      FOR UPDATE
    `, [code]);
    const connection = result.rows[0];

    if (!connection || connection.status !== "pending") {
      return { status: "invalid" };
    }

    if (new Date(connection.expires_at).getTime() <= Date.now()) {
      await client.query(`
        UPDATE telegram_connection_codes
        SET status = 'expired'
        WHERE code = $1
      `, [code]);
      return { status: "expired" };
    }

    await client.query(`
      UPDATE telegram_connection_codes
      SET status = 'connected', chat_id = $2, confirmed_at = now()
      WHERE code = $1
    `, [code, chatId]);
    await client.query(`
      INSERT INTO telegram_notification_settings (
        user_id, chat_id, enabled, favorite_markets_only, timeframes,
        direction, minimum_confidence
      )
      VALUES ($1,$2,false,true,ARRAY['1h','4h']::text[],'both',75)
      ON CONFLICT (user_id)
      DO UPDATE SET
        chat_id = EXCLUDED.chat_id,
        enabled = false,
        updated_at = now()
    `, [connection.user_id, chatId]);

    return {
      status: "connected",
      userId: connection.user_id,
      chatId
    };
  });
}

export async function getTelegramBotOffset() {
  const result = await query(`
    SELECT last_update_id
    FROM telegram_bot_state
    WHERE id = 'primary'
  `);
  return Number(result.rows[0]?.last_update_id || 0);
}

export async function saveTelegramBotOffset(updateId) {
  await query(`
    UPDATE telegram_bot_state
    SET last_update_id = GREATEST(last_update_id, $1), updated_at = now()
    WHERE id = 'primary'
  `, [updateId]);
}

export async function acquireTelegramBotPollLease(owner) {
  const result = await query(`
    UPDATE telegram_bot_state
    SET poll_lease_owner = $1,
      poll_lease_until = now() + interval '20 seconds',
      updated_at = now()
    WHERE id = 'primary'
      AND (poll_lease_until IS NULL OR poll_lease_until < now() OR poll_lease_owner = $1)
    RETURNING id
  `, [owner]);
  return Boolean(result.rows[0]);
}

export async function releaseTelegramBotPollLease(owner) {
  await query(`
    UPDATE telegram_bot_state
    SET poll_lease_until = now(), updated_at = now()
    WHERE id = 'primary' AND poll_lease_owner = $1
  `, [owner]);
}

export async function createTesterAccessRequest(userId) {
  const result = await query(`
    INSERT INTO tester_access_requests (id, user_id, status)
    VALUES ($1, $2, 'pending')
    ON CONFLICT (user_id) WHERE status = 'pending'
    DO NOTHING
    RETURNING *
  `, [createId("tstreq"), userId]);

  if (result.rows[0]) {
    return mapTesterRequest(result.rows[0]);
  }

  return getLatestTesterAccessRequest(userId);
}

export async function getLatestTesterAccessRequest(userId) {
  const result = await query(`
    SELECT *
    FROM tester_access_requests
    WHERE user_id = $1
    ORDER BY requested_at DESC
    LIMIT 1
  `, [userId]);
  return result.rows[0] ? mapTesterRequest(result.rows[0]) : null;
}

export async function listPendingTesterAccessRequests() {
  const result = await query(`
    SELECT r.*, u.name, u.email, u.role
    FROM tester_access_requests r
    JOIN users u ON u.id = r.user_id
    WHERE r.status = 'pending'
    ORDER BY r.requested_at ASC
  `);
  return result.rows.map((row) => ({
    ...mapTesterRequest(row),
    user: {
      id: row.user_id,
      name: row.name,
      email: row.email,
      role: row.role
    }
  }));
}

export async function reviewTesterAccessRequest(requestId, adminUserId, decision) {
  return transaction(async (client) => {
    const result = await client.query(`
      SELECT *
      FROM tester_access_requests
      WHERE id = $1 AND status = 'pending'
      FOR UPDATE
    `, [requestId]);
    const request = result.rows[0];

    if (!request) {
      return null;
    }

    await client.query(`
      UPDATE tester_access_requests
      SET status = $2, reviewed_by = $3, reviewed_at = now()
      WHERE id = $1
    `, [requestId, decision, adminUserId]);

    if (decision === "approved") {
      await client.query(`
        UPDATE users
        SET role = 'tester', plan = 'tester', updated_at = now()
        WHERE id = $1
      `, [request.user_id]);
      await client.query(`
        UPDATE credit_balances
        SET paid_credits = GREATEST(paid_credits, $2), updated_at = now()
        WHERE user_id = $1
      `, [request.user_id, appConfig.testerCreditAllowance]);
    }

    return {
      ...mapTesterRequest(request),
      status: decision,
      reviewedBy: adminUserId,
      reviewedAt: new Date().toISOString()
    };
  });
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

function mapTelegramSettings(row) {
  return {
    chatId: row.chat_id,
    enabled: row.enabled,
    favoriteMarketsOnly: row.favorite_markets_only,
    timeframes: row.timeframes || [],
    direction: row.direction,
    minimumConfidence: Number(row.minimum_confidence),
    connectedAt: row.connected_at,
    updatedAt: row.updated_at
  };
}

function mapTesterRequest(row) {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    requestedAt: row.requested_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at
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
    role: row.role || "user",
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
