import { appConfig } from "../config/appConfig.js";
import { createId } from "../shared/ids.js";
import { query, transaction } from "./client.js";

export async function findUserByEmail(email) {
  const result = await query(`
    SELECT u.*, s.status AS subscription_status, s.provider, s.provider_customer_id,
      s.provider_subscription_id, s.price_id, s.current_period_start, s.current_period_end,
      s.cancel_at_period_end, s.stripe_mode, c.free_signal_allowance, c.paid_credits,
      c.unlock_credits_balance, c.lifetime_unlocks_used,
      COALESCE((
        SELECT SUM(d.quantity) FROM setup_discovery_usage d
        WHERE d.user_id = u.id AND d.created_at >= date_trunc('day', now())
      ), 0) AS discoveries_today,
      COALESCE((
        SELECT SUM(d.quantity) FROM setup_discovery_usage d
        WHERE d.user_id = u.id
          AND d.created_at >= COALESCE(s.current_period_start, date_trunc('month', now()))
      ), 0) AS discoveries_period
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    LEFT JOIN credit_balances c ON c.user_id = u.id
    WHERE u.email = $1
  `, [email]);

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserByUsername(username) {
  const normalized = normalizeUsernameForLookup(username);
  if (!normalized) return null;
  const result = await query(`
    SELECT u.*, s.status AS subscription_status, s.provider, s.provider_customer_id,
      s.provider_subscription_id, s.price_id, s.current_period_start, s.current_period_end,
      s.cancel_at_period_end, s.stripe_mode, c.free_signal_allowance, c.paid_credits,
      c.unlock_credits_balance, c.lifetime_unlocks_used,
      COALESCE((
        SELECT SUM(d.quantity) FROM setup_discovery_usage d
        WHERE d.user_id = u.id AND d.created_at >= date_trunc('day', now())
      ), 0) AS discoveries_today,
      COALESCE((
        SELECT SUM(d.quantity) FROM setup_discovery_usage d
        WHERE d.user_id = u.id
          AND d.created_at >= COALESCE(s.current_period_start, date_trunc('month', now()))
      ), 0) AS discoveries_period
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    LEFT JOIN credit_balances c ON c.user_id = u.id
    WHERE u.username_normalized = $1
  `, [normalized]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserById(id) {
  const result = await query(`
    SELECT u.*, s.status AS subscription_status, s.provider, s.provider_customer_id,
      s.provider_subscription_id, s.price_id, s.current_period_start, s.current_period_end,
      s.cancel_at_period_end, s.stripe_mode, c.free_signal_allowance, c.paid_credits,
      c.unlock_credits_balance, c.lifetime_unlocks_used,
      COALESCE((
        SELECT SUM(d.quantity) FROM setup_discovery_usage d
        WHERE d.user_id = u.id AND d.created_at >= date_trunc('day', now())
      ), 0) AS discoveries_today,
      COALESCE((
        SELECT SUM(d.quantity) FROM setup_discovery_usage d
        WHERE d.user_id = u.id
          AND d.created_at >= COALESCE(s.current_period_start, date_trunc('month', now()))
      ), 0) AS discoveries_period
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    LEFT JOIN credit_balances c ON c.user_id = u.id
    WHERE u.id = $1
  `, [id]);

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function createUser({
  id,
  name,
  email,
  password,
  emailVerifiedAt = null,
  freeSignalAllowance = 0,
  signupIpHash = null,
  deviceFingerprintHash = null,
  abuseScore = 0,
  abuseFlags = [],
  abuseReviewStatus = "clear",
  username = null,
  publicProfileEnabled = false,
  publicLeaderboardEnabled = false
}) {
  const usernameNormalized = normalizeUsernameForLookup(username);
  await transaction(async (client) => {
    await client.query(`
      INSERT INTO users (
        id, name, email, password_salt, password_hash, plan, email_verified_at,
        signup_ip_hash, device_fingerprint_hash, abuse_score, abuse_flags,
        abuse_review_status, affiliate_code, username, username_normalized,
        username_updated_at, public_profile_enabled, public_leaderboard_enabled
      )
      VALUES ($1,$2,$3,$4,$5,'free',$6,$7,$8,$9,$10,$11,lower(substr(md5($1),1,12)),$12,$13,CASE WHEN $13 IS NULL THEN NULL ELSE now() END,$14,$15)
    `, [
      id,
      name,
      email,
      password.salt,
      password.hash,
      emailVerifiedAt,
      signupIpHash,
      deviceFingerprintHash,
      abuseScore,
      JSON.stringify(abuseFlags),
      abuseReviewStatus,
      usernameNormalized ? username : null,
      usernameNormalized,
      Boolean(publicProfileEnabled),
      Boolean(publicProfileEnabled && publicLeaderboardEnabled)
    ]);

    await client.query(`
      INSERT INTO subscriptions (id, user_id, status, provider)
      VALUES ($1, $2, 'trialing', 'stripe')
    `, [createId("sub"), id]);

    await client.query(`
      INSERT INTO credit_balances (
        user_id, trial_signals_used, free_signal_allowance, paid_credits,
        unlock_credits_balance
      )
      VALUES ($1, 0, $2, 0, $3)
    `, [id, freeSignalAllowance, freeSignalAllowance]);
  });

  return findUserById(id);
}

export async function updateUserProfileSettings(userId, {
  username = undefined,
  publicProfileEnabled = undefined,
  publicLeaderboardEnabled = undefined
}) {
  return transaction(async (client) => {
    const currentResult = await client.query(`
      SELECT id, username, username_normalized, username_updated_at,
        public_profile_enabled, public_leaderboard_enabled
      FROM users
      WHERE id = $1
      FOR UPDATE
    `, [userId]);
    const current = currentResult.rows[0];
    if (!current) return null;

    let nextUsername = current.username;
    let nextNormalized = current.username_normalized;
    let updateUsernameTimestamp = false;

    if (username !== undefined) {
      nextUsername = String(username || "").trim();
      nextNormalized = normalizeUsernameForLookup(nextUsername);

      if (!nextNormalized) {
        const error = new Error("Username must be 3-20 characters using only letters, numbers, and underscores.");
        error.code = "INVALID_USERNAME";
        error.statusCode = 400;
        throw error;
      }

      if (nextNormalized !== current.username_normalized) {
        if (
          current.username_updated_at &&
          Date.now() - new Date(current.username_updated_at).getTime() < 30 * 24 * 60 * 60 * 1000
        ) {
          const error = new Error("You can change your username once every 30 days.");
          error.code = "USERNAME_CHANGE_COOLDOWN";
          error.statusCode = 429;
          throw error;
        }

        const duplicate = await client.query(`
          SELECT id
          FROM users
          WHERE username_normalized = $1 AND id <> $2
          LIMIT 1
        `, [nextNormalized, userId]);

        if (duplicate.rows[0]) {
          const error = new Error("Username is already taken.");
          error.code = "USERNAME_TAKEN";
          error.statusCode = 409;
          throw error;
        }

        updateUsernameTimestamp = true;
      }
    }

    await client.query(`
      UPDATE users
      SET username = $2,
        username_normalized = $3,
        username_updated_at = CASE WHEN $4 THEN now() ELSE username_updated_at END,
        public_profile_enabled = COALESCE($5, public_profile_enabled),
        public_leaderboard_enabled = CASE
          WHEN COALESCE($5, public_profile_enabled) = false THEN false
          ELSE COALESCE($6, public_leaderboard_enabled)
        END,
        updated_at = now()
      WHERE id = $1
    `, [
      userId,
      nextUsername,
      nextNormalized,
      updateUsernameTimestamp,
      publicProfileEnabled === undefined ? null : Boolean(publicProfileEnabled),
      publicLeaderboardEnabled === undefined ? null : Boolean(publicLeaderboardEnabled)
    ]);
  });

  return findUserById(userId);
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

export async function refreshSession(sessionId, expiresAt) {
  const result = await query(`
    UPDATE sessions
    SET expires_at = $2
    WHERE id = $1 AND expires_at > now()
    RETURNING id
  `, [sessionId, expiresAt]);
  return Boolean(result.rows[0]);
}

export async function storeAuthRestoreToken({
  userId,
  tokenHash,
  deviceFingerprintHash,
  expiresAt
}) {
  return transaction(async (client) => {
    const result = await client.query(`
      INSERT INTO auth_restore_tokens (
        id, user_id, token_hash, device_fingerprint_hash, expires_at
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, expires_at
    `, [
      createId("restore"),
      userId,
      tokenHash,
      deviceFingerprintHash,
      expiresAt
    ]);

    return result.rows[0];
  });
}

export async function findAuthRestoreToken(tokenHash, deviceFingerprintHash) {
  const result = await query(`
    SELECT id, user_id, expires_at
    FROM auth_restore_tokens
    WHERE token_hash = $1
      AND device_fingerprint_hash = $2
      AND revoked_at IS NULL
      AND expires_at > now()
  `, [tokenHash, deviceFingerprintHash]);
  return result.rows[0] || null;
}

export async function markAuthRestoreTokenUsed(id) {
  await query(`
    UPDATE auth_restore_tokens
    SET last_used_at = now(), updated_at = now()
    WHERE id = $1
  `, [id]);
}

export async function revokeAuthRestoreToken(tokenHash) {
  await query(`
    UPDATE auth_restore_tokens
    SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
    WHERE token_hash = $1
  `, [tokenHash]);
}

export async function revokeAuthRestoreTokensForUserDevice(userId, deviceFingerprintHash) {
  await query(`
    UPDATE auth_restore_tokens
    SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
    WHERE user_id = $1
      AND device_fingerprint_hash = $2
      AND revoked_at IS NULL
  `, [userId, deviceFingerprintHash]);
}

export async function deleteSession(sessionId) {
  await query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export async function deleteExpiredSessions() {
  await query("DELETE FROM sessions WHERE expires_at <= now()");
}

export async function recordProductAnalyticsEvent({
  eventType,
  userId = null,
  authProvider = null,
  symbol = null,
  timeframe = null,
  plan = null,
  amountCents = 0,
  metadata = {}
}) {
  await query(`
    INSERT INTO product_analytics_events (
      id, event_type, user_id, auth_provider, symbol, timeframe, plan,
      amount_cents, metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [
    createId("pae"),
    eventType,
    userId,
    authProvider,
    symbol,
    timeframe,
    plan,
    Math.max(0, Number(amountCents || 0)),
    JSON.stringify(metadata || {})
  ]);
}

export async function getAdminProductAnalytics() {
  const [
    userSummary,
    eventSummary,
    mostScanned,
    mostUnlocked,
    affiliateSummary
  ] = await Promise.all([
    query(`
      SELECT
        COUNT(*)::integer AS total_users,
        COUNT(*) FILTER (
          WHERE COALESCE(s.status, '') IN ('active', 'trialing')
            AND COALESCE(u.plan, 'free') IN ('pro', 'elite')
        )::integer AS paid_users,
        COALESCE(SUM(
          CASE
            WHEN COALESCE(s.status, '') IN ('active', 'trialing') AND u.plan = 'pro' THEN 2900
            WHEN COALESCE(s.status, '') IN ('active', 'trialing') AND u.plan = 'elite' THEN 9900
            ELSE 0
          END
        ), 0)::integer AS monthly_recurring_revenue_cents
      FROM users u
      LEFT JOIN subscriptions s ON s.user_id = u.id
      WHERE u.role <> 'tester'
    `),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'signup')::integer AS signups,
        COUNT(*) FILTER (WHERE event_type = 'signup' AND auth_provider = 'google')::integer
          AS google_signups,
        COUNT(*) FILTER (WHERE event_type = 'signup' AND auth_provider = 'email')::integer
          AS email_signups,
        COUNT(*) FILTER (WHERE event_type = 'scan')::integer AS scans,
        COUNT(*) FILTER (WHERE event_type = 'unlock')::integer AS unlocks,
        COUNT(*) FILTER (WHERE event_type = 'subscription')::integer AS subscriptions,
        COUNT(*) FILTER (WHERE event_type = 'affiliate_conversion')::integer
          AS affiliate_conversions,
        COUNT(*) FILTER (WHERE event_type = 'checkout_started')::integer AS checkout_started,
        COUNT(*) FILTER (WHERE event_type = 'checkout_completed')::integer
          AS checkout_completed
      FROM product_analytics_events
    `),
    query(`
      SELECT symbol, COUNT(*)::integer AS count
      FROM product_analytics_events
      WHERE event_type = 'scan'
        AND symbol IS NOT NULL
      GROUP BY symbol
      ORDER BY count DESC, symbol ASC
      LIMIT 8
    `),
    query(`
      SELECT symbol, COUNT(*)::integer AS count
      FROM product_analytics_events
      WHERE event_type = 'unlock'
        AND symbol IS NOT NULL
      GROUP BY symbol
      ORDER BY count DESC, symbol ASC
      LIMIT 8
    `),
    query(`
      SELECT
        COALESCE((SELECT SUM(lifetime_commission_cents)
          FROM affiliate_referrals), 0)::integer AS lifetime_commission_cents,
        COALESCE((SELECT SUM(amount_cents)
          FROM affiliate_payout_requests
          WHERE status IN ('pending', 'approved')), 0)::integer AS reserved_payout_cents
    `)
  ]);
  const users = userSummary.rows[0] || {};
  const events = eventSummary.rows[0] || {};
  const affiliate = affiliateSummary.rows[0] || {};
  const totalUsers = Number(users.total_users || 0);
  const paidUsers = Number(users.paid_users || 0);
  const affiliateOwed = Math.max(
    0,
    Number(affiliate.lifetime_commission_cents || 0) -
      Number(affiliate.reserved_payout_cents || 0)
  );

  return {
    totalUsers,
    paidUsers,
    conversionRate: totalUsers > 0
      ? Math.round((paidUsers / totalUsers) * 1000) / 10
      : 0,
    monthlyRecurringRevenueCents: Number(users.monthly_recurring_revenue_cents || 0),
    affiliateRevenueOwedCents: affiliateOwed,
    signups: Number(events.signups || 0),
    googleSignups: Number(events.google_signups || 0),
    emailSignups: Number(events.email_signups || 0),
    scans: Number(events.scans || 0),
    unlocks: Number(events.unlocks || 0),
    subscriptions: Number(events.subscriptions || 0),
    affiliateConversions: Number(events.affiliate_conversions || 0),
    checkoutStarted: Number(events.checkout_started || 0),
    checkoutCompleted: Number(events.checkout_completed || 0),
    mostScannedMarkets: mostScanned.rows,
    mostUnlockedMarkets: mostUnlocked.rows
  };
}

export async function getAdminOperationsDashboard() {
  const [
    overview,
    signals,
    rejectedSignals,
    rejectionReasons,
    strategyAnalytics,
    marketAnalytics,
    telegram,
    telegramFailures,
    affiliates,
    topAffiliates,
    stripe,
    latestSubscriptions,
    stripeFailures,
    errorLogs,
    systemActivity
  ] = await Promise.all([
    query(`
      SELECT
        (SELECT COUNT(*)::integer FROM users WHERE COALESCE(role, 'user') <> 'tester') AS total_users,
        (SELECT COUNT(DISTINCT user_id)::integer FROM product_analytics_events
          WHERE created_at >= date_trunc('day', now()) AND user_id IS NOT NULL) AS active_today,
        (SELECT COUNT(DISTINCT user_id)::integer FROM product_analytics_events
          WHERE created_at >= now() - interval '7 days' AND user_id IS NOT NULL) AS active_week,
        (SELECT COUNT(*)::integer FROM users
          WHERE created_at >= date_trunc('day', now()) AND COALESCE(role, 'user') <> 'tester') AS new_users_today,
        (SELECT COUNT(*)::integer FROM users
          WHERE plan = 'pro' AND updated_at >= date_trunc('day', now()) AND COALESCE(role, 'user') <> 'tester') AS new_pro,
        (SELECT COUNT(*)::integer FROM users
          WHERE plan = 'elite' AND updated_at >= date_trunc('day', now()) AND COALESCE(role, 'user') <> 'tester') AS new_elite,
        COALESCE((SELECT SUM(CASE WHEN u.plan = 'pro' THEN 2900 WHEN u.plan = 'elite' THEN 9900 ELSE 0 END)
          FROM users u
          LEFT JOIN subscriptions s ON s.user_id = u.id
          WHERE COALESCE(s.status, '') IN ('active', 'trialing')
            AND u.plan IN ('pro', 'elite')
            AND COALESCE(u.role, 'user') <> 'tester'), 0)::integer AS mrr_cents,
        COALESCE((SELECT SUM(amount_cents) FROM product_analytics_events
          WHERE event_type IN ('subscription', 'checkout_completed')
            AND created_at >= date_trunc('day', now())), 0)::integer AS revenue_today_cents,
        COALESCE((SELECT SUM(amount_cents) FROM product_analytics_events
          WHERE event_type IN ('subscription', 'checkout_completed')
            AND created_at >= date_trunc('month', now())), 0)::integer AS revenue_month_cents,
        (SELECT COUNT(*)::integer FROM stripe_webhook_events
          WHERE (event_type = 'invoice.payment_failed' OR status = 'failed')
            AND received_at >= date_trunc('month', now())) AS failed_payments,
        (SELECT COUNT(*)::integer FROM stripe_webhook_events
          WHERE event_type = 'invoice.payment_succeeded'
            AND received_at >= date_trunc('day', now())) AS renewals_today,
        (SELECT COUNT(*)::integer FROM saved_signals
          WHERE created_at >= date_trunc('day', now())) AS signals_generated_today,
        (SELECT COUNT(*)::integer FROM saved_signals
          WHERE validation_passed = true AND created_at >= date_trunc('day', now())) AS signals_validated_today,
        (SELECT COUNT(*)::integer FROM signal_validation_rejections
          WHERE created_at >= date_trunc('day', now())) AS signals_rejected_today,
        (SELECT COUNT(*)::integer FROM telegram_notification_queue
          WHERE status = 'sent' AND sent_at >= date_trunc('day', now())) AS telegram_sent_today,
        (SELECT COUNT(*)::integer FROM unlocked_signals
          WHERE created_at >= date_trunc('day', now())) AS unlocks_today,
        COALESCE((SELECT AVG(confidence_score) FROM saved_signals
          WHERE validation_passed = true AND created_at >= date_trunc('day', now())), 0)::numeric AS average_confidence_today,
        COALESCE((SELECT AVG(risk_reward_ratio) FROM saved_signals
          WHERE validation_passed = true AND created_at >= date_trunc('day', now())), 0)::numeric AS average_rr_today
    `),
    query(`
      SELECT s.id, s.symbol, s.timeframe, s.direction, s.setup_type AS strategy,
        s.confidence_score, s.risk_reward_ratio, s.validation_score,
        s.validation_passed, COALESCE(o.status, 'Active') AS status,
        NULL::jsonb AS rejected_reasons, s.created_at
      FROM saved_signals s
      LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
      ORDER BY s.created_at DESC
      LIMIT 40
    `),
    query(`
      SELECT id, symbol, timeframe, direction, strategy,
        confidence_score, risk_reward_ratio, validation_score,
        false AS validation_passed, 'Rejected' AS status, reasons AS rejected_reasons,
        created_at
      FROM signal_validation_rejections
      ORDER BY created_at DESC
      LIMIT 40
    `),
    query(`
      SELECT reason->>'reason' AS reason, COUNT(*)::integer AS count
      FROM signal_validation_rejections r
      CROSS JOIN LATERAL jsonb_array_elements(r.reasons) AS reason
      GROUP BY reason
      ORDER BY count DESC, reason ASC
      LIMIT 10
    `),
    query(`
      WITH generated AS (
        SELECT setup_type AS strategy, COUNT(*)::integer AS generated,
          COUNT(*) FILTER (WHERE validation_passed = true)::integer AS passed,
          COALESCE(AVG(confidence_score), 0)::numeric AS average_confidence,
          COALESCE(AVG(risk_reward_ratio), 0)::numeric AS average_rr,
          COUNT(*) FILTER (WHERE o.status = 'Hit TP')::integer AS tp,
          COUNT(*) FILTER (WHERE o.status IN ('Hit TP', 'Hit SL'))::integer AS closed
        FROM saved_signals s
        LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
        GROUP BY setup_type
      ),
      rejected AS (
        SELECT strategy, COUNT(*)::integer AS rejected
        FROM signal_validation_rejections
        GROUP BY strategy
      )
      SELECT COALESCE(g.strategy, r.strategy, 'Unknown') AS strategy,
        COALESCE(g.generated, 0)::integer AS generated,
        COALESCE(g.passed, 0)::integer AS passed,
        COALESCE(r.rejected, 0)::integer AS rejected,
        COALESCE(g.average_confidence, 0)::numeric AS average_confidence,
        COALESCE(g.average_rr, 0)::numeric AS average_rr,
        CASE WHEN COALESCE(g.closed, 0) > 0
          THEN ROUND((g.tp::numeric / g.closed::numeric) * 100, 1)
          ELSE 0
        END AS win_rate
      FROM generated g
      FULL OUTER JOIN rejected r ON r.strategy = g.strategy
      ORDER BY generated DESC, passed DESC, strategy ASC
      LIMIT 20
    `),
    query(`
      SELECT s.symbol,
        COUNT(*)::integer AS signals,
        COALESCE(AVG(s.risk_reward_ratio), 0)::numeric AS average_rr,
        COALESCE(AVG(s.confidence_score), 0)::numeric AS average_confidence,
        COUNT(*) FILTER (WHERE o.status = 'Hit TP')::integer AS tp,
        COUNT(*) FILTER (WHERE o.status IN ('Hit TP', 'Hit SL'))::integer AS closed,
        CASE WHEN COUNT(*) FILTER (WHERE o.status IN ('Hit TP', 'Hit SL')) > 0
          THEN ROUND((COUNT(*) FILTER (WHERE o.status = 'Hit TP')::numeric /
            COUNT(*) FILTER (WHERE o.status IN ('Hit TP', 'Hit SL'))::numeric) * 100, 1)
          ELSE 0
        END AS win_rate
      FROM saved_signals s
      LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
      WHERE s.validation_passed = true
      GROUP BY s.symbol
      ORDER BY signals DESC, s.symbol ASC
      LIMIT 60
    `),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent')::integer AS messages_sent,
        COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed_sends,
        COUNT(*) FILTER (WHERE status IN ('queued', 'sending'))::integer AS pending_queue,
        COALESCE(AVG(EXTRACT(EPOCH FROM (sent_at - created_at))) FILTER (WHERE sent_at IS NOT NULL), 0)::numeric
          AS average_delivery_seconds,
        COALESCE(SUM(GREATEST(attempts - 1, 0)), 0)::integer AS retry_count
      FROM telegram_notification_queue
    `),
    query(`
      SELECT id, user_id, setup_key, status, attempts, last_error, created_at, updated_at
      FROM telegram_notification_queue
      WHERE status = 'failed' OR last_error IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 8
    `),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE active)::integer AS active_referrals,
        COALESCE(SUM(monthly_commission_cents) FILTER (WHERE active), 0)::integer AS monthly_commissions_cents,
        COALESCE((SELECT SUM(amount_cents) FROM affiliate_payout_requests WHERE status = 'pending'), 0)::integer
          AS pending_payouts_cents,
        COALESCE((SELECT SUM(amount_cents) FROM affiliate_payout_requests WHERE status = 'approved'), 0)::integer
          AS paid_payouts_cents,
        (SELECT COUNT(*)::integer FROM affiliate_clicks) AS clicks,
        COUNT(*)::integer AS referrals
      FROM affiliate_referrals
    `),
    query(`
      SELECT u.id, u.email, u.username, u.affiliate_code,
        COUNT(r.id)::integer AS referrals,
        COUNT(r.id) FILTER (WHERE r.active)::integer AS active_referrals,
        COALESCE(SUM(r.monthly_commission_cents) FILTER (WHERE r.active), 0)::integer AS monthly_commissions_cents,
        COALESCE(SUM(r.lifetime_commission_cents), 0)::integer AS lifetime_earnings_cents
      FROM users u
      LEFT JOIN affiliate_referrals r ON r.affiliate_user_id = u.id
      WHERE u.affiliate_code IS NOT NULL AND COALESCE(u.role, 'user') <> 'tester'
      GROUP BY u.id
      ORDER BY lifetime_earnings_cents DESC, active_referrals DESC
      LIMIT 8
    `),
    query(`
      SELECT
        (SELECT COUNT(*)::integer
          FROM users u
          LEFT JOIN subscriptions s ON s.user_id = u.id
          WHERE u.plan IN ('pro', 'elite')
            AND COALESCE(s.status, '') IN ('active', 'trialing')) AS active_subscriptions,
        (SELECT COUNT(*)::integer FROM stripe_webhook_events
          WHERE event_type = 'invoice.payment_succeeded') AS renewals,
        (SELECT COUNT(*)::integer FROM stripe_webhook_events
          WHERE event_type = 'invoice.payment_failed') AS failed_renewals,
        (SELECT COUNT(*)::integer FROM stripe_webhook_events
          WHERE event_type LIKE '%refund%') AS refunds,
        (SELECT COUNT(*)::integer FROM stripe_webhook_events
          WHERE status = 'failed') AS webhook_failures
    `),
    query(`
      SELECT u.id AS user_id, u.email, u.username, u.plan, s.status,
        s.provider_subscription_id, s.current_period_end, s.updated_at
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      WHERE u.plan IN ('pro', 'elite')
      ORDER BY s.updated_at DESC
      LIMIT 8
    `),
    query(`
      SELECT event_id, event_type, stripe_object_id, status, attempts, last_error, received_at
      FROM stripe_webhook_events
      WHERE status = 'failed' OR last_error IS NOT NULL
      ORDER BY received_at DESC
      LIMIT 8
    `),
    query(`
      SELECT 'Telegram' AS area, id AS id, COALESCE(last_error, 'Telegram delivery failed') AS message,
        updated_at AS created_at
      FROM telegram_notification_queue
      WHERE status = 'failed' OR last_error IS NOT NULL
      UNION ALL
      SELECT 'Stripe' AS area, event_id AS id, COALESCE(last_error, 'Stripe webhook failed') AS message,
        received_at AS created_at
      FROM stripe_webhook_events
      WHERE status = 'failed' OR last_error IS NOT NULL
      UNION ALL
      SELECT 'Scanner' AS area, id AS id,
        COALESCE((reasons->0->>'reason'), 'Signal rejected by validation') AS message,
        created_at
      FROM signal_validation_rejections
      ORDER BY created_at DESC
      LIMIT 25
    `),
    query(`
      SELECT
        (SELECT COUNT(*)::integer FROM setup_discovery_usage
          WHERE created_at >= now() - interval '20 minutes') AS recent_scans,
        (SELECT COUNT(*)::integer FROM telegram_notification_queue
          WHERE status IN ('queued', 'sending')) AS telegram_pending,
        (SELECT COUNT(*)::integer FROM signal_outcomes
          WHERE status = 'Active') AS active_tracking
    `)
  ]);

  const row = overview.rows[0] || {};
  const affiliateRow = affiliates.rows[0] || {};
  const stripeRow = stripe.rows[0] || {};
  const systemRow = systemActivity.rows[0] || {};

  return {
    overview: {
      users: {
        totalUsers: Number(row.total_users || 0),
        activeToday: Number(row.active_today || 0),
        activeThisWeek: Number(row.active_week || 0),
        newUsersToday: Number(row.new_users_today || 0),
        newPro: Number(row.new_pro || 0),
        newElite: Number(row.new_elite || 0)
      },
      revenue: {
        monthlyRecurringRevenueCents: Number(row.mrr_cents || 0),
        revenueTodayCents: Number(row.revenue_today_cents || 0),
        revenueThisMonthCents: Number(row.revenue_month_cents || 0),
        failedPayments: Number(row.failed_payments || 0),
        renewalsToday: Number(row.renewals_today || 0)
      },
      signals: {
        generatedToday: Number(row.signals_generated_today || 0),
        validatedToday: Number(row.signals_validated_today || 0),
        rejectedToday: Number(row.signals_rejected_today || 0),
        telegramAlertsSentToday: Number(row.telegram_sent_today || 0),
        unlocksToday: Number(row.unlocks_today || 0),
        averageConfidence: Number(row.average_confidence_today || 0),
        averageRiskReward: Number(row.average_rr_today || 0)
      },
      system: {
        serverUptimeSeconds: Math.round(process.uptime()),
        databaseStatus: "ok",
        coinbaseStatus: "configured",
        commodityProviderStatus: appConfig.twelveData?.apiKey ? "configured" : "not_configured",
        telegramBotStatus: appConfig.telegram?.botToken ? "configured" : "not_configured",
        stripeStatus: appConfig.stripe?.secretKey ? "configured" : "not_configured",
        scannerStatus: Number(systemRow.recent_scans || 0) > 0 ? "active" : "idle",
        autoScanStatus: appConfig.autoScan?.enabled ? "enabled" : "disabled"
      }
    },
    signalMonitor: [...signals.rows, ...rejectedSignals.rows]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 60)
      .map(mapAdminSignalMonitorRow),
    rejectionAnalytics: rejectionReasons.rows.map((item) => ({
      reason: item.reason || "Unknown",
      count: Number(item.count || 0)
    })),
    strategyAnalytics: strategyAnalytics.rows.map((item) => ({
      strategy: item.strategy || "Unknown",
      generated: Number(item.generated || 0),
      passed: Number(item.passed || 0),
      rejected: Number(item.rejected || 0),
      averageConfidence: Number(item.average_confidence || 0),
      averageRiskReward: Number(item.average_rr || 0),
      winRate: Number(item.win_rate || 0)
    })),
    marketAnalytics: marketAnalytics.rows.map((item) => ({
      market: item.symbol,
      signals: Number(item.signals || 0),
      winRate: Number(item.win_rate || 0),
      averageRiskReward: Number(item.average_rr || 0),
      averageConfidence: Number(item.average_confidence || 0)
    })),
    telegram: {
      messagesSent: Number(telegram.rows[0]?.messages_sent || 0),
      failedSends: Number(telegram.rows[0]?.failed_sends || 0),
      pendingQueue: Number(telegram.rows[0]?.pending_queue || 0),
      averageDeliverySeconds: Number(telegram.rows[0]?.average_delivery_seconds || 0),
      retryCount: Number(telegram.rows[0]?.retry_count || 0),
      latestFailures: telegramFailures.rows.map((item) => ({
        id: item.id,
        userId: item.user_id,
        setupKey: item.setup_key,
        status: item.status,
        attempts: Number(item.attempts || 0),
        error: safeAdminMessage(item.last_error),
        createdAt: item.created_at,
        updatedAt: item.updated_at
      }))
    },
    affiliates: {
      activeReferrals: Number(affiliateRow.active_referrals || 0),
      monthlyCommissionsCents: Number(affiliateRow.monthly_commissions_cents || 0),
      pendingPayoutsCents: Number(affiliateRow.pending_payouts_cents || 0),
      paidPayoutsCents: Number(affiliateRow.paid_payouts_cents || 0),
      conversionRate: Number(affiliateRow.clicks || 0) > 0
        ? Math.round((Number(affiliateRow.referrals || 0) / Number(affiliateRow.clicks || 1)) * 1000) / 10
        : 0,
      topAffiliates: topAffiliates.rows.map((item) => ({
        userId: item.id,
        email: item.email,
        username: item.username,
        affiliateCode: item.affiliate_code,
        referrals: Number(item.referrals || 0),
        activeReferrals: Number(item.active_referrals || 0),
        monthlyCommissionsCents: Number(item.monthly_commissions_cents || 0),
        lifetimeEarningsCents: Number(item.lifetime_earnings_cents || 0)
      }))
    },
    stripe: {
      activeSubscriptions: Number(stripeRow.active_subscriptions || 0),
      renewals: Number(stripeRow.renewals || 0),
      failedRenewals: Number(stripeRow.failed_renewals || 0),
      refunds: Number(stripeRow.refunds || 0),
      webhookFailures: Number(stripeRow.webhook_failures || 0),
      latestSubscriptions: latestSubscriptions.rows.map((item) => ({
        userId: item.user_id,
        email: item.email,
        username: item.username,
        plan: item.plan,
        status: item.status,
        subscriptionId: item.provider_subscription_id,
        currentPeriodEnd: item.current_period_end,
        updatedAt: item.updated_at
      })),
      webhookFailuresLatest: stripeFailures.rows.map((item) => ({
        eventId: item.event_id,
        eventType: item.event_type,
        stripeObjectId: item.stripe_object_id,
        status: item.status,
        attempts: Number(item.attempts || 0),
        error: safeAdminMessage(item.last_error),
        receivedAt: item.received_at
      }))
    },
    errorLogs: errorLogs.rows.map((item) => ({
      area: item.area,
      id: item.id,
      message: safeAdminMessage(item.message),
      createdAt: item.created_at
    })),
    health: buildAdminHealth(systemRow)
  };
}

export async function searchAdminUsers(searchTerm) {
  const normalized = String(searchTerm || "").trim();
  if (normalized.length < 2) return [];

  const like = `%${normalized.toLowerCase()}%`;
  const result = await query(`
    SELECT u.id, u.name, u.email, u.username, u.plan, u.role, u.created_at,
      u.email_verified_at, u.public_profile_enabled, u.public_leaderboard_enabled,
      u.affiliate_code, u.affiliate_disabled, u.abuse_score, u.abuse_review_status,
      s.status AS subscription_status, s.provider, s.provider_subscription_id,
      s.current_period_end, c.unlock_credits_balance, c.lifetime_unlocks_used,
      COALESCE(sig.signals, 0)::integer AS signals,
      COALESCE(sig.closed_signals, 0)::integer AS closed_signals,
      COALESCE(af.active_referrals, 0)::integer AS active_referrals,
      COALESCE(af.lifetime_commission_cents, 0)::integer AS lifetime_commission_cents,
      t.enabled AS telegram_enabled, t.connected_at AS telegram_connected_at
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    LEFT JOIN credit_balances c ON c.user_id = u.id
    LEFT JOIN telegram_notification_settings t ON t.user_id = u.id
    LEFT JOIN (
      SELECT s.user_id,
        COUNT(*)::integer AS signals,
        COUNT(*) FILTER (WHERE COALESCE(o.status, 'Active') <> 'Active')::integer AS closed_signals
      FROM saved_signals s
      LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
      GROUP BY s.user_id
    ) sig ON sig.user_id = u.id
    LEFT JOIN (
      SELECT affiliate_user_id,
        COUNT(*) FILTER (WHERE active)::integer AS active_referrals,
        COALESCE(SUM(lifetime_commission_cents), 0)::integer AS lifetime_commission_cents
      FROM affiliate_referrals
      GROUP BY affiliate_user_id
    ) af ON af.affiliate_user_id = u.id
    WHERE lower(u.id) = lower($1)
      OR lower(u.email) LIKE $2
      OR lower(COALESCE(u.username, '')) LIKE $2
    ORDER BY u.created_at DESC
    LIMIT 20
  `, [normalized, like]);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username,
    plan: row.plan,
    role: row.role || "user",
    createdAt: row.created_at,
    emailVerified: Boolean(row.email_verified_at),
    subscription: {
      status: row.subscription_status,
      provider: row.provider,
      subscriptionId: row.provider_subscription_id,
      currentPeriodEnd: row.current_period_end
    },
    credits: {
      unlockCreditsBalance: Number(row.unlock_credits_balance || 0),
      lifetimeUnlocksUsed: Number(row.lifetime_unlocks_used || 0)
    },
    signals: {
      unlocked: Number(row.signals || 0),
      closed: Number(row.closed_signals || 0)
    },
    affiliate: {
      code: row.affiliate_code,
      disabled: Boolean(row.affiliate_disabled),
      activeReferrals: Number(row.active_referrals || 0),
      lifetimeCommissionCents: Number(row.lifetime_commission_cents || 0)
    },
    telegram: {
      connected: Boolean(row.telegram_connected_at),
      enabled: Boolean(row.telegram_enabled),
      connectedAt: row.telegram_connected_at
    },
    profile: {
      publicProfileEnabled: Boolean(row.public_profile_enabled),
      publicLeaderboardEnabled: Boolean(row.public_leaderboard_enabled),
      abuseScore: Number(row.abuse_score || 0),
      abuseReviewStatus: row.abuse_review_status || "clear"
    }
  }));
}

export async function listLeaderboardPerformanceRows() {
  const result = await query(`
    SELECT
      u.id AS user_id,
      u.username,
      u.plan,
      u.role,
      u.email,
      s.id AS signal_id,
      s.setup_key,
      s.symbol,
      s.timeframe,
      s.risk_reward_ratio,
      s.generated_at,
      s.created_at AS signal_created_at,
      COALESCE(o.status, 'Active') AS status,
      o.resolved_at,
      p.id AS paper_trade_id
    FROM users u
    JOIN saved_signals s ON s.user_id = u.id
    LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
    LEFT JOIN paper_trades p ON p.saved_signal_id = s.id AND p.user_id = u.id
    WHERE u.public_profile_enabled = true
      AND u.public_leaderboard_enabled = true
      AND u.username_normalized IS NOT NULL
      AND COALESCE(u.role, 'user') <> 'tester'
    ORDER BY u.username_normalized ASC, s.generated_at ASC
  `);

  return result.rows.map((row) => ({
    userId: row.user_id,
    username: row.username,
    plan: row.plan || "free",
    role: row.role || "user",
    email: row.email,
    signalId: row.signal_id,
    setupKey: row.setup_key,
    symbol: row.symbol,
    timeframe: row.timeframe,
    riskRewardRatio: Number(row.risk_reward_ratio || 0),
    generatedAt: row.generated_at,
    createdAt: row.signal_created_at,
    status: row.status || "Active",
    resolvedAt: row.resolved_at,
    paperTradeId: row.paper_trade_id
  }));
}

export async function incrementTrialSignalsUsed(userId) {
  await transaction(async (client) => {
    await client.query(`
      UPDATE users
      SET trial_signals_used = trial_signals_used + 1,
        trial_used = true,
        updated_at = now()
      WHERE id = $1
    `, [userId]);
    await client.query(`
      UPDATE credit_balances SET trial_signals_used = trial_signals_used + 1, updated_at = now()
      WHERE user_id = $1
    `, [userId]);
    await client.query(`
      UPDATE device_trial_history d
      SET trial_used = true, trial_used_at = COALESCE(trial_used_at, now()), updated_at = now()
      FROM users u
      WHERE u.id = $1
        AND u.device_fingerprint_hash = d.device_fingerprint_hash
    `, [userId]);
  });
}

export async function recordSignupAttempt(attempt) {
  await query(`
    INSERT INTO signup_attempts (
      id, ip_hash, device_fingerprint_hash, email_domain,
      disposable_email, successful, reason
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [
    createId("signup"),
    attempt.ipHash,
    attempt.deviceHash,
    attempt.emailDomain,
    attempt.disposableEmail,
    attempt.successful,
    attempt.reason || null
  ]);
}

export async function getSignupVelocity(ipHash) {
  const result = await query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= now() - interval '1 hour') AS attempts_last_hour,
      COUNT(*) FILTER (
        WHERE successful = true AND created_at >= now() - interval '1 day'
      ) AS accounts_last_day,
      COUNT(*) FILTER (
        WHERE successful = true AND created_at >= now() - interval '7 days'
      ) AS accounts_last_week
    FROM signup_attempts
    WHERE ip_hash = $1
      AND created_at >= now() - interval '7 days'
  `, [ipHash]);
  const row = result.rows[0] || {};
  return {
    attemptsLastHour: Number(row.attempts_last_hour || 0),
    accountsLastDay: Number(row.accounts_last_day || 0),
    accountsLastWeek: Number(row.accounts_last_week || 0)
  };
}

export async function getDeviceTrialHistory(deviceHash) {
  if (!deviceHash) return null;
  const result = await query(`
    SELECT *
    FROM device_trial_history
    WHERE device_fingerprint_hash = $1
  `, [deviceHash]);
  return result.rows[0] || null;
}

export async function createEmailVerificationToken(
  userId,
  tokenHash,
  expiresAt,
  cooldownSeconds = 0
) {
  await transaction(async (client) => {
    if (cooldownSeconds > 0) {
      const latest = await client.query(`
        SELECT created_at
        FROM email_verification_tokens
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `, [userId]);
      const createdAt = latest.rows[0]?.created_at
        ? new Date(latest.rows[0].created_at).getTime()
        : 0;
      const retryAfterSeconds = Math.ceil(
        (createdAt + cooldownSeconds * 1000 - Date.now()) / 1000
      );

      if (retryAfterSeconds > 0) {
        const error = new Error(
          `Please wait ${retryAfterSeconds} seconds before requesting another verification email.`
        );
        error.code = "VERIFICATION_RESEND_LIMIT";
        error.statusCode = 429;
        error.retryAfterSeconds = retryAfterSeconds;
        throw error;
      }
    }

    await client.query(`
      DELETE FROM email_verification_tokens
      WHERE user_id = $1 AND used_at IS NULL
    `, [userId]);
    await client.query(`
      INSERT INTO email_verification_tokens (token_hash, user_id, expires_at)
      VALUES ($1, $2, $3)
    `, [tokenHash, userId, expiresAt]);
  });
}

export async function verifyEmailToken(tokenHash) {
  return transaction(async (client) => {
    const result = await client.query(`
      SELECT t.*, u.device_fingerprint_hash, u.trial_used, u.email_verified_at
      FROM email_verification_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1
      FOR UPDATE OF t, u
    `, [tokenHash]);
    const token = result.rows[0];

    if (!token || token.used_at || new Date(token.expires_at).getTime() <= Date.now()) {
      return null;
    }

    await client.query(`
      UPDATE email_verification_tokens SET used_at = now() WHERE token_hash = $1
    `, [tokenHash]);
    await client.query(`
      UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
      WHERE id = $1
    `, [token.user_id]);

    let trialGranted = false;
    if (!token.trial_used && token.device_fingerprint_hash) {
      const reservation = await client.query(`
        INSERT INTO device_trial_history (device_fingerprint_hash, first_user_id)
        VALUES ($1, $2)
        ON CONFLICT (device_fingerprint_hash) DO NOTHING
        RETURNING device_fingerprint_hash
      `, [token.device_fingerprint_hash, token.user_id]);
      trialGranted = Boolean(reservation.rows[0]);
    } else if (!token.trial_used && !token.device_fingerprint_hash) {
      trialGranted = true;
    }

    if (trialGranted) {
      await client.query(`
        UPDATE credit_balances
        SET free_signal_allowance = $2,
          unlock_credits_balance = GREATEST(unlock_credits_balance, $2),
          updated_at = now()
        WHERE user_id = $1
      `, [token.user_id, appConfig.freeSignalAllowance]);
    } else {
      await client.query(`
        UPDATE users
        SET abuse_score = LEAST(100, abuse_score + 50),
          abuse_flags = (
            SELECT jsonb_agg(DISTINCT value)
            FROM jsonb_array_elements(abuse_flags || '["repeated_trial_device"]'::jsonb)
          ),
          abuse_review_status = 'flagged',
          updated_at = now()
        WHERE id = $1
      `, [token.user_id]);
    }

    return { userId: token.user_id, trialGranted };
  });
}

export async function createPasswordResetToken(userId, tokenHash, expiresAt) {
  await transaction(async (client) => {
    await client.query(`
      DELETE FROM password_reset_tokens
      WHERE user_id = $1 AND used_at IS NULL
    `, [userId]);
    await client.query(`
      INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
      VALUES ($1, $2, $3)
    `, [tokenHash, userId, expiresAt]);
  });
}

export async function resetPasswordWithToken(tokenHash, password) {
  return transaction(async (client) => {
    const result = await client.query(`
      SELECT t.*, u.email
      FROM password_reset_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1
      FOR UPDATE OF t, u
    `, [tokenHash]);
    const token = result.rows[0];

    if (!token || token.used_at || new Date(token.expires_at).getTime() <= Date.now()) {
      return null;
    }

    await client.query(`
      UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1
    `, [tokenHash]);
    await client.query(`
      UPDATE users
      SET password_salt = $2, password_hash = $3, updated_at = now()
      WHERE id = $1
    `, [token.user_id, password.salt, password.hash]);

    return { userId: token.user_id, email: token.email };
  });
}

export async function createOAuthLoginState({
  stateHash,
  provider,
  nonce,
  signupIpHash,
  deviceFingerprintHash,
  affiliateCode,
  expiresAt
}) {
  await query(`
    INSERT INTO oauth_login_states (
      state_hash, provider, nonce, signup_ip_hash,
      device_fingerprint_hash, affiliate_code, expires_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    stateHash,
    provider,
    nonce,
    signupIpHash,
    deviceFingerprintHash,
    affiliateCode,
    expiresAt
  ]);
}

export async function consumeOAuthLoginState(stateHash, provider) {
  return transaction(async (client) => {
    const result = await client.query(`
      SELECT *
      FROM oauth_login_states
      WHERE state_hash = $1 AND provider = $2
      FOR UPDATE
    `, [stateHash, provider]);
    const state = result.rows[0];

    if (
      !state ||
      state.used_at ||
      new Date(state.expires_at).getTime() <= Date.now()
    ) {
      return null;
    }

    await client.query(`
      UPDATE oauth_login_states SET used_at = now() WHERE state_hash = $1
    `, [stateHash]);
    return {
      nonce: state.nonce,
      signupIpHash: state.signup_ip_hash,
      deviceFingerprintHash: state.device_fingerprint_hash,
      affiliateCode: state.affiliate_code
    };
  });
}

export async function findUserByOAuthIdentity(provider, providerSubject) {
  const result = await query(`
    SELECT user_id
    FROM oauth_accounts
    WHERE provider = $1 AND provider_subject = $2
  `, [provider, providerSubject]);
  return result.rows[0] ? findUserById(result.rows[0].user_id) : null;
}

export async function linkOAuthIdentity({
  provider,
  providerSubject,
  userId,
  providerEmail
}) {
  return transaction(async (client) => {
    const existing = await client.query(`
      SELECT user_id
      FROM oauth_accounts
      WHERE provider = $1 AND provider_subject = $2
      FOR UPDATE
    `, [provider, providerSubject]);

    if (existing.rows[0] && existing.rows[0].user_id !== userId) {
      const error = new Error("This Google identity is already linked to another account.");
      error.statusCode = 409;
      throw error;
    }

    await client.query(`
      INSERT INTO oauth_accounts (
        provider, provider_subject, user_id, provider_email
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (provider, provider_subject) DO UPDATE
      SET provider_email = EXCLUDED.provider_email, updated_at = now()
    `, [provider, providerSubject, userId, providerEmail]);
    await client.query(`
      UPDATE users
      SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
      WHERE id = $1
    `, [userId]);
  });

  return findUserById(userId);
}

export async function grantOAuthFreeTrial(userId, deviceFingerprintHash) {
  return transaction(async (client) => {
    let trialGranted = !deviceFingerprintHash;

    if (deviceFingerprintHash) {
      const reservation = await client.query(`
        INSERT INTO device_trial_history (device_fingerprint_hash, first_user_id)
        VALUES ($1, $2)
        ON CONFLICT (device_fingerprint_hash) DO NOTHING
        RETURNING device_fingerprint_hash
      `, [deviceFingerprintHash, userId]);
      trialGranted = Boolean(reservation.rows[0]);
    }

    if (trialGranted) {
      await client.query(`
        UPDATE credit_balances
        SET free_signal_allowance = $2,
          unlock_credits_balance = GREATEST(unlock_credits_balance, $2),
          updated_at = now()
        WHERE user_id = $1
      `, [userId, appConfig.freeSignalAllowance]);
    } else {
      await client.query(`
        UPDATE users
        SET abuse_score = LEAST(100, abuse_score + 50),
          abuse_flags = (
            SELECT jsonb_agg(DISTINCT value)
            FROM jsonb_array_elements(
              abuse_flags || '["repeated_trial_device"]'::jsonb
            )
          ),
          abuse_review_status = 'flagged',
          updated_at = now()
        WHERE id = $1
      `, [userId]);
    }

    return trialGranted;
  });
}

export async function getCachedScanResult(userId, scanKey) {
  const result = await query(`
    SELECT result_json
    FROM scan_result_cache
    WHERE user_id = $1 AND scan_key = $2 AND expires_at > now()
  `, [userId, scanKey]);
  return result.rows[0]?.result_json || null;
}

export async function cacheScanResult(userId, scanKey, result, ttlSeconds = 300) {
  await query(`
    INSERT INTO scan_result_cache (user_id, scan_key, result_json, expires_at)
    VALUES ($1, $2, $3, now() + ($4 * interval '1 second'))
    ON CONFLICT (user_id, scan_key) DO UPDATE
    SET result_json = EXCLUDED.result_json,
      expires_at = EXCLUDED.expires_at,
      created_at = now()
  `, [userId, scanKey, JSON.stringify(result), ttlSeconds]);
}

export async function consumeDiscoveryCredits(userId, {
  quantity,
  limit,
  periodStart,
  scanKey
}) {
  if (quantity <= 0) return { used: 0, remaining: limit };

  return transaction(async (client) => {
    const account = await client.query(`
      SELECT u.role, u.email_verified_at
      FROM users u
      JOIN credit_balances c ON c.user_id = u.id
      WHERE u.id = $1
      FOR UPDATE OF c
    `, [userId]);

    if (account.rows[0]?.role === "tester") {
      return { used: 0, remaining: null };
    }
    if (!account.rows[0]?.email_verified_at) {
      const error = new Error("Verify your email before using setup discovery credits.");
      error.code = "EMAIL_VERIFICATION_REQUIRED";
      error.statusCode = 403;
      throw error;
    }

    const usage = await client.query(`
      SELECT COALESCE(SUM(quantity), 0) AS used
      FROM setup_discovery_usage
      WHERE user_id = $1 AND created_at >= $2
    `, [userId, periodStart]);
    const used = Number(usage.rows[0].used || 0);

    if (used + quantity > limit) {
      const error = new Error("Setup discovery credit limit reached.");
      error.code = "DISCOVERY_LIMIT";
      error.statusCode = 402;
      error.remaining = Math.max(0, limit - used);
      throw error;
    }

    await client.query(`
      INSERT INTO setup_discovery_usage (id, user_id, scan_key, quantity)
      VALUES ($1, $2, $3, $4)
    `, [createId("disc"), userId, scanKey, quantity]);

    return { used: used + quantity, remaining: Math.max(0, limit - used - quantity) };
  });
}

export async function updateStripeCustomer(userId, customerId, stripeMode, resetModeBoundData = false) {
  await query(`
    UPDATE subscriptions
    SET provider_customer_id = $2,
      stripe_mode = $3,
      provider_subscription_id = CASE WHEN $4 THEN NULL ELSE provider_subscription_id END,
      price_id = CASE WHEN $4 THEN NULL ELSE price_id END,
      current_period_start = CASE WHEN $4 THEN NULL ELSE current_period_start END,
      current_period_end = CASE WHEN $4 THEN NULL ELSE current_period_end END,
      cancel_at_period_end = CASE WHEN $4 THEN false ELSE cancel_at_period_end END,
      updated_at = now()
    WHERE user_id = $1
  `, [userId, customerId, stripeMode, resetModeBoundData]);
}

export async function findUserByStripeCustomer(customerId, stripeMode) {
  const result = await query(`
    SELECT user_id
    FROM subscriptions
    WHERE provider_customer_id = $1 AND stripe_mode = $2
  `, [customerId, stripeMode]);
  return result.rows[0] ? findUserById(result.rows[0].user_id) : null;
}

export async function updateStripeSubscription({
  userId,
  customerId,
  subscriptionId,
  status,
  plan,
  priceId,
  periodStart,
  periodEnd,
  stripeMode,
  cancelAtPeriodEnd = false
}) {
  await transaction(async (client) => {
    await client.query(`
      UPDATE users SET plan = $2, updated_at = now() WHERE id = $1
    `, [userId, plan]);
    await client.query(`
      UPDATE subscriptions
      SET provider_customer_id = COALESCE($2, provider_customer_id),
        provider_subscription_id = $3,
        status = $4,
        price_id = $5,
        current_period_start = $6,
        current_period_end = $7,
        cancel_at_period_end = $8,
        stripe_mode = $9,
        updated_at = now()
      WHERE user_id = $1
    `, [
      userId,
      customerId,
      subscriptionId,
      status,
      priceId,
      periodStart,
      periodEnd,
      cancelAtPeriodEnd,
      stripeMode
    ]);
  });
}

export async function grantUnlockCredits(userId, quantity, externalReference, source) {
  return transaction(async (client) => {
    const grant = await client.query(`
      INSERT INTO billing_credit_grants (
        id, user_id, external_reference, source, quantity
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (external_reference) DO NOTHING
      RETURNING id
    `, [createId("grant"), userId, externalReference, source, quantity]);

    if (!grant.rows[0]) return false;

    await client.query(`
      UPDATE credit_balances
      SET unlock_credits_balance = unlock_credits_balance + $2,
        paid_credits = paid_credits + CASE WHEN $3 = 'credit_pack' THEN $2 ELSE 0 END,
        updated_at = now()
      WHERE user_id = $1
    `, [userId, quantity, source]);
    return true;
  });
}

export async function grantSubscriptionEntitlements({
  userId,
  plan,
  scanCredits,
  unlockCredits,
  externalReference
}) {
  return transaction(async (client) => {
    const grant = await client.query(`
      INSERT INTO billing_entitlement_grants (
        id, user_id, external_reference, plan, scan_credits, unlock_credits
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (external_reference) DO NOTHING
      RETURNING id
    `, [
      createId("ent"),
      userId,
      externalReference,
      plan,
      scanCredits,
      unlockCredits
    ]);

    if (!grant.rows[0]) return false;

    await client.query(`
      UPDATE credit_balances
      SET unlock_credits_balance = unlock_credits_balance + $2,
        updated_at = now()
      WHERE user_id = $1
    `, [userId, unlockCredits]);
    return true;
  });
}

export async function claimStripeWebhookEvent({
  eventId,
  eventType,
  stripeObjectId = null,
  payload = null
}) {
  const result = await query(`
    INSERT INTO stripe_webhook_events (
      event_id, event_type, stripe_object_id, payload_json, status, attempts,
      received_at, processing_started_at, processed_at
    )
    VALUES ($1, $2, $3, $4, 'processing', 1, now(), now(), now())
    ON CONFLICT (event_id) DO UPDATE
    SET status = 'processing',
      attempts = stripe_webhook_events.attempts + 1,
      last_error = NULL,
      event_type = EXCLUDED.event_type,
      stripe_object_id = COALESCE(EXCLUDED.stripe_object_id, stripe_webhook_events.stripe_object_id),
      payload_json = COALESCE(EXCLUDED.payload_json, stripe_webhook_events.payload_json),
      result_json = NULL,
      processing_started_at = now(),
      completed_at = NULL,
      processed_at = now()
    WHERE stripe_webhook_events.status = 'failed'
      OR (
        stripe_webhook_events.status = 'processing'
        AND stripe_webhook_events.processing_started_at < now() - interval '10 minutes'
      )
    RETURNING event_id
  `, [eventId, eventType, stripeObjectId, payload ? JSON.stringify(payload) : null]);
  return Boolean(result.rows[0]);
}

export async function completeStripeWebhookEvent(eventId, {
  userId = null,
  result = null
} = {}) {
  await query(`
    UPDATE stripe_webhook_events
    SET status = 'processed',
      user_id = COALESCE($2, user_id),
      result_json = $3,
      last_error = NULL,
      completed_at = now(),
      processed_at = now()
    WHERE event_id = $1
  `, [eventId, userId, result ? JSON.stringify(result) : null]);
}

export async function failStripeWebhookEvent(eventId, safeError) {
  await query(`
    UPDATE stripe_webhook_events
    SET status = 'failed', last_error = $2, completed_at = now(), processed_at = now()
    WHERE event_id = $1
  `, [eventId, safeError]);
}

export async function listStripeWebhookEvents({ status = null, limit = 100 } = {}) {
  const result = await query(`
    SELECT event_id, event_type, stripe_object_id, user_id, status, attempts,
      last_error, result_json, received_at, processing_started_at, completed_at
    FROM stripe_webhook_events
    WHERE ($1::text IS NULL OR status = $1)
    ORDER BY received_at DESC
    LIMIT $2
  `, [status, Math.min(200, Math.max(1, Number(limit) || 100))]);
  return result.rows;
}

export async function getRetryableStripeWebhookEvent(eventId) {
  const result = await query(`
    SELECT event_id, event_type, payload_json, status
    FROM stripe_webhook_events
    WHERE event_id = $1 AND status = 'failed'
  `, [eventId]);
  return result.rows[0] || null;
}

export async function listAbuseReviewDashboard() {
  const [flagged, ips, devices, disposable] = await Promise.all([
    query(`
      SELECT id, name, email, abuse_score, abuse_flags, abuse_review_status,
        email_verified_at, trial_used, created_at
      FROM users
      WHERE abuse_review_status = 'flagged' OR abuse_score > 0
      ORDER BY abuse_score DESC, created_at DESC
      LIMIT 100
    `),
    query(`
      SELECT ip_hash, COUNT(*) FILTER (WHERE successful) AS accounts,
        COUNT(*) AS attempts, MAX(created_at) AS last_seen
      FROM signup_attempts
      WHERE created_at >= now() - interval '7 days'
      GROUP BY ip_hash
      HAVING COUNT(*) FILTER (WHERE successful) > 1
      ORDER BY accounts DESC, attempts DESC
      LIMIT 50
    `),
    query(`
      SELECT device_fingerprint_hash, COUNT(DISTINCT user_id) AS accounts,
        BOOL_OR(trial_used) AS trial_used, MAX(created_at) AS last_seen
      FROM users
      WHERE device_fingerprint_hash IS NOT NULL
      GROUP BY device_fingerprint_hash
      HAVING COUNT(DISTINCT user_id) > 1
      ORDER BY accounts DESC
      LIMIT 50
    `),
    query(`
      SELECT email_domain, COUNT(*) AS attempts, MAX(created_at) AS last_seen
      FROM signup_attempts
      WHERE disposable_email = true
      GROUP BY email_domain
      ORDER BY attempts DESC
      LIMIT 50
    `)
  ]);

  return {
    flaggedAccounts: flagged.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      abuseScore: Number(row.abuse_score),
      abuseFlags: row.abuse_flags || [],
      reviewStatus: row.abuse_review_status,
      emailVerified: Boolean(row.email_verified_at),
      trialUsed: row.trial_used,
      createdAt: row.created_at
    })),
    accountsPerIp: ips.rows.map((row) => ({
      ipHash: row.ip_hash.slice(0, 12),
      accounts: Number(row.accounts),
      attempts: Number(row.attempts),
      lastSeen: row.last_seen
    })),
    repeatedDevices: devices.rows.map((row) => ({
      deviceHash: row.device_fingerprint_hash.slice(0, 12),
      accounts: Number(row.accounts),
      trialUsed: row.trial_used,
      lastSeen: row.last_seen
    })),
    disposableEmails: disposable.rows.map((row) => ({
      domain: row.email_domain,
      attempts: Number(row.attempts),
      lastSeen: row.last_seen
    }))
  };
}

export async function saveUnlockedSignal(userId, signal) {
  return transaction(async (client) => {
    const setupKey = signal.setupKey ||
      `${signal.symbol}:${signal.timeframe}:${signal.direction}:${Math.floor(new Date(signal.generatedAt).getTime() / 1000)}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [userId, setupKey]);
    const existing = await client.query(
      signalSelectSql("WHERE s.user_id = $1 AND s.setup_key = $2 LIMIT 1"),
      [userId, setupKey]
    );

    if (existing.rows[0]) {
      const mapped = mapSignal(existing.rows[0]);
      mapped.alreadyUnlocked = true;
      return mapped;
    }

    const account = await client.query(`
      SELECT u.role, u.email_verified_at, c.unlock_credits_balance
      FROM users u
      JOIN credit_balances c ON c.user_id = u.id
      WHERE u.id = $1
      FOR UPDATE OF c
    `, [userId]);
    const billing = account.rows[0];

    if (billing?.role !== "tester" && !billing?.email_verified_at) {
      const error = new Error("Verify your email before using signal unlock credits.");
      error.code = "EMAIL_VERIFICATION_REQUIRED";
      error.statusCode = 403;
      throw error;
    }

    if (billing?.role !== "tester" && Number(billing?.unlock_credits_balance || 0) <= 0) {
      const error = new Error("Unlock credit limit reached.");
      error.code = "UNLOCK_LIMIT";
      error.statusCode = 402;
      throw error;
    }

    await client.query(`
      INSERT INTO saved_signals (
        id, user_id, setup_key, symbol, timeframe, direction, entry_price, stop_loss, take_profit,
        risk_reward_ratio, confidence_score, quality_score, setup_type, reasoning,
        confirmations, indicators, market_source, generated_at, validation_score, validation_passed
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    `, [
      signal.id,
      userId,
      setupKey,
      signal.symbol,
      signal.timeframe,
      signal.direction,
      signal.entryPrice,
      signal.stopLoss,
      signal.takeProfit,
      signal.riskRewardRatio,
      signal.confidenceScore,
      signal.qualityScore,
      signal.setupType,
      signal.reasoning,
      JSON.stringify(signal.confirmations || []),
      JSON.stringify(signal.indicators || {}),
      signal.marketSource,
      signal.generatedAt,
      signal.validationScore ?? signal.validation?.score ?? 100,
      signal.validationPassed !== false
    ]);

    await client.query(`
      INSERT INTO unlocked_signals (id, user_id, saved_signal_id)
      VALUES ($1, $2, $3)
    `, [createId("unlk"), userId, signal.id]);

    await client.query(`
      INSERT INTO signal_outcomes (saved_signal_id, status, updated_at)
      VALUES ($1, 'Active', now())
    `, [signal.id]);

    if (billing.role !== "tester") {
      await client.query(`
        UPDATE credit_balances
        SET unlock_credits_balance = unlock_credits_balance - 1,
          lifetime_unlocks_used = lifetime_unlocks_used + 1,
          trial_signals_used = trial_signals_used + CASE
            WHEN (SELECT plan FROM users WHERE id = $1) = 'free' THEN 1 ELSE 0
          END,
          updated_at = now()
        WHERE user_id = $1
      `, [userId]);
      await client.query(`
        UPDATE users
        SET trial_signals_used = trial_signals_used + CASE WHEN plan = 'free' THEN 1 ELSE 0 END,
          trial_used = true,
          updated_at = now()
        WHERE id = $1
      `, [userId]);
      await client.query(`
        UPDATE device_trial_history d
        SET trial_used = true,
          trial_used_at = COALESCE(trial_used_at, now()),
          updated_at = now()
        FROM users u
        WHERE u.id = $1
          AND u.device_fingerprint_hash = d.device_fingerprint_hash
      `, [userId]);
    }

    const saved = await client.query(
      signalSelectSql("WHERE s.id = $1 AND s.user_id = $2"),
      [signal.id, userId]
    );
    return saved.rows[0] ? mapSignal(saved.rows[0]) : null;
  });
}

export async function findActiveDuplicateSignal(userId, signal) {
  const result = await query(`
    SELECT s.id, s.setup_key
    FROM saved_signals s
    LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
    WHERE s.user_id = $1
      AND s.symbol = $2
      AND s.timeframe = $3
      AND s.direction = $4
      AND s.setup_type = $5
      AND s.setup_key = $6
      AND COALESCE(o.status, 'Active') = 'Active'
    LIMIT 1
  `, [
    userId,
    signal.symbol,
    signal.timeframe,
    signal.direction,
    signal.setupType,
    signal.setupKey || signal.id || null
  ]);

  return result.rows[0] || null;
}

export async function recordSignalValidationRejection(rejection) {
  await query(`
    INSERT INTO signal_validation_rejections (
      id, user_id, setup_key, symbol, timeframe, direction, strategy,
      validation_score, confidence_score, risk_reward_ratio, reasons, source
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `, [
    createId("valrej"),
    rejection.userId,
    rejection.setupKey,
    rejection.symbol,
    rejection.timeframe,
    rejection.direction,
    rejection.strategy,
    rejection.validationScore,
    rejection.confidenceScore,
    rejection.riskRewardRatio,
    JSON.stringify(rejection.reasons || []),
    rejection.source
  ]);
}

export async function getSignalValidationDashboard() {
  const [
    totals,
    topReasons,
    strategies,
    markets
  ] = await Promise.all([
    query(`
      SELECT
        (SELECT COUNT(*) FROM saved_signals WHERE validation_passed = true) AS generated,
        (SELECT COUNT(*) FROM signal_validation_rejections) AS rejected,
        (SELECT COALESCE(AVG(confidence_score), 0) FROM saved_signals WHERE validation_passed = true) AS average_confidence,
        (SELECT COALESCE(AVG(risk_reward_ratio), 0) FROM saved_signals WHERE validation_passed = true) AS average_rr
    `),
    query(`
      SELECT reason->>'stage' AS stage, reason->>'reason' AS reason, COUNT(*) AS count
      FROM signal_validation_rejections r
      CROSS JOIN LATERAL jsonb_array_elements(r.reasons) AS reason
      GROUP BY stage, reason
      ORDER BY count DESC
      LIMIT 8
    `),
    query(`
      SELECT setup_type AS strategy, COUNT(*) AS count
      FROM saved_signals
      WHERE validation_passed = true
      GROUP BY setup_type
      ORDER BY count DESC
      LIMIT 8
    `),
    query(`
      SELECT symbol, COUNT(*) AS count
      FROM saved_signals
      WHERE validation_passed = true
      GROUP BY symbol
      ORDER BY count DESC
      LIMIT 8
    `)
  ]);

  const row = totals.rows[0] || {};
  const generated = Number(row.generated || 0);
  const rejected = Number(row.rejected || 0);
  const total = generated + rejected;

  return {
    signalsGenerated: generated,
    signalsRejected: rejected,
    validationPassRate: total ? Number(((generated / total) * 100).toFixed(1)) : 0,
    averageConfidence: Number(Number(row.average_confidence || 0).toFixed(1)),
    averageRiskReward: Number(Number(row.average_rr || 0).toFixed(2)),
    topRejectionReasons: topReasons.rows.map((item) => ({
      stage: item.stage,
      reason: item.reason,
      count: Number(item.count)
    })),
    strategiesPassingMost: strategies.rows.map((item) => ({
      strategy: item.strategy,
      count: Number(item.count)
    })),
    marketsPassingMost: markets.rows.map((item) => ({
      symbol: item.symbol,
      count: Number(item.count)
    }))
  };
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

export async function listPerformanceSignalsByUser(userId, filters = {}) {
  const values = [userId];
  const clauses = ["s.user_id = $1"];

  if (filters.from) {
    values.push(filters.from);
    clauses.push(`s.generated_at >= $${values.length}`);
  }

  if (filters.to) {
    values.push(filters.to);
    clauses.push(`s.generated_at < $${values.length}`);
  }

  if (filters.symbol) {
    values.push(filters.symbol);
    clauses.push(`s.symbol = $${values.length}`);
  }

  if (filters.timeframe) {
    values.push(filters.timeframe);
    clauses.push(`s.timeframe = $${values.length}`);
  }

  if (filters.direction) {
    values.push(filters.direction);
    clauses.push(`s.direction = $${values.length}`);
  }

  if (filters.status) {
    values.push(filters.status);
    clauses.push(`COALESCE(o.status, 'Active') = $${values.length}`);
  }

  if (filters.session) {
    values.push(filters.session);
    clauses.push(`COALESCE(s.indicators->>'session', 'Unknown') = $${values.length}`);
  }

  if (filters.newsRisk) {
    values.push(filters.newsRisk);
    clauses.push(`CASE
      WHEN COALESCE(s.indicators->>'newsRiskLevel', 'Unknown') IN ('Danger', 'Elevated')
        THEN 'with-news-risk'
      ELSE 'without-news-risk'
    END = $${values.length}`);
  }

  const result = await query(
    signalSelectSql(`WHERE ${clauses.join(" AND ")} ORDER BY s.generated_at ASC`),
    values
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

export async function saveSignalSnapshot(userId, signalId, snapshot) {
  await query(`
    INSERT INTO signal_snapshots (saved_signal_id, user_id, snapshot)
    VALUES ($1, $2, $3)
    ON CONFLICT (saved_signal_id) DO NOTHING
  `, [signalId, userId, JSON.stringify(snapshot || {})]);
}

export async function getLearningContextForSignal(signal) {
  const [strategy, market, factors] = await Promise.all([
    query(`
      SELECT *
      FROM strategy_learning_stats
      WHERE strategy = $1 AND market = $2 AND timeframe = $3
    `, [signal.setupType || "Unknown strategy", signal.symbol, signal.timeframe]),
    query(`
      SELECT *
      FROM market_timeframe_learning_stats
      WHERE market = $1 AND timeframe = $2
    `, [signal.symbol, signal.timeframe]),
    query(`
      SELECT factor_name, factor_value, sample_size, confidence_adjustment
      FROM factor_learning_stats
      WHERE factor_name = ANY($1)
      ORDER BY confidence_adjustment ASC, sample_size DESC
      LIMIT 6
    `, [[
      `strategy:${signal.setupType || "Unknown strategy"}`,
      `market:${signal.symbol}`,
      `timeframe:${signal.timeframe}`,
      `regime:${signal.indicators?.regime || "Unknown"}`,
      `session:${signal.indicators?.session || "Unknown"}`,
      `confluence:${signal.alignmentBadge || signal.indicators?.alignmentBadge || "Unknown"}`,
      `vwap:${signal.indicators?.vwapAligned ? "aligned" : "not_aligned"}`,
      `correlation:${signal.indicators?.correlationConflict ? "conflict" : "neutral"}`
    ]])
  ]);

  return {
    strategy: strategy.rows[0] ? mapLearningStats(strategy.rows[0]) : null,
    marketTimeframe: market.rows[0] ? mapLearningStats(market.rows[0]) : null,
    factorPenalty: factors.rows.reduce((sum, row) => {
      if (Number(row.sample_size || 0) < 10) return sum;
      return sum + Math.min(0, Number(row.confidence_adjustment || 0));
    }, 0),
    factors: factors.rows.map((row) => ({
      name: row.factor_name,
      value: row.factor_value,
      sampleSize: Number(row.sample_size || 0),
      confidenceAdjustment: Number(row.confidence_adjustment || 0)
    }))
  };
}

export async function recordSignalLearningEvent(event) {
  await query(`
    INSERT INTO signal_learning_events (
      id, signal_id, user_id, pair, timeframe, direction, strategy,
      outcome, net_r, post_mortem_tags, created_at, closed_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (signal_id) DO NOTHING
  `, [
    createId("learn"),
    event.signalId,
    event.userId,
    event.pair,
    event.timeframe,
    event.direction,
    event.strategy,
    event.outcome,
    event.netR,
    JSON.stringify(event.postMortemTags || []),
    event.createdAt,
    event.closedAt
  ]);
}

export async function refreshLearningStats(event) {
  await transaction(async (client) => {
    await refreshStrategyLearningStats(client, event.strategy, event.pair, event.timeframe);
    await refreshMarketTimeframeLearningStats(client, event.pair, event.timeframe);
    await refreshFactorLearningStats(client, event);
  });
}

export async function getAdminLearningDashboard(filters = {}) {
  const values = [];
  const clauses = [];

  if (filters.market) {
    values.push(filters.market);
    clauses.push(`pair = $${values.length}`);
  }
  if (filters.timeframe) {
    values.push(filters.timeframe);
    clauses.push(`timeframe = $${values.length}`);
  }
  if (filters.strategy) {
    values.push(filters.strategy);
    clauses.push(`strategy = $${values.length}`);
  }
  if (filters.from) {
    values.push(filters.from);
    clauses.push(`closed_at >= $${values.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [
    strategies,
    markets,
    timeframes,
    slReasons,
    expiredReasons,
    bands,
    outcomes,
    activeAdjustments
  ] = await Promise.all([
    query(`
      SELECT strategy, market, timeframe, sample_size, win_rate, avg_r
      FROM strategy_learning_stats
      ORDER BY avg_r DESC, win_rate DESC, sample_size DESC
      LIMIT 8
    `),
    query(`
      SELECT market, timeframe, sample_size, win_rate, avg_r, best_strategy, worst_strategy
      FROM market_timeframe_learning_stats
      ORDER BY avg_r DESC, win_rate DESC, sample_size DESC
      LIMIT 8
    `),
    query(`
      SELECT timeframe, COUNT(*)::integer AS sample_size,
        COALESCE(AVG(CASE WHEN outcome = 'Hit TP' THEN 100 ELSE 0 END), 0)::numeric AS win_rate,
        COALESCE(AVG(net_r), 0)::numeric AS avg_r
      FROM signal_learning_events
      ${where}
      GROUP BY timeframe
      ORDER BY avg_r DESC
    `, values),
    query(`
      SELECT tag.value AS reason, COUNT(*)::integer AS count
      FROM signal_learning_events e
      CROSS JOIN LATERAL jsonb_array_elements_text(e.post_mortem_tags) tag(value)
      WHERE e.outcome = 'Hit SL'
      GROUP BY tag.value
      ORDER BY count DESC
      LIMIT 8
    `),
    query(`
      SELECT tag.value AS reason, COUNT(*)::integer AS count
      FROM signal_learning_events e
      CROSS JOIN LATERAL jsonb_array_elements_text(e.post_mortem_tags) tag(value)
      WHERE e.outcome = 'Expired'
      GROUP BY tag.value
      ORDER BY count DESC
      LIMIT 8
    `),
    query(`
      SELECT COALESCE(s.snapshot->>'confidenceBand', 'Unknown') AS band,
        COUNT(*)::integer AS sample_size,
        COALESCE(AVG(CASE WHEN e.outcome = 'Hit TP' THEN 100 ELSE 0 END), 0)::numeric AS win_rate,
        COALESCE(AVG(e.net_r), 0)::numeric AS avg_r
      FROM signal_learning_events e
      LEFT JOIN signal_snapshots s ON s.saved_signal_id = e.signal_id
      ${where ? where.replaceAll("pair", "e.pair").replaceAll("timeframe", "e.timeframe").replaceAll("strategy", "e.strategy").replaceAll("closed_at", "e.closed_at") : ""}
      GROUP BY band
      ORDER BY band ASC
    `, values),
    query(`
      SELECT outcome, COUNT(*)::integer AS count, COALESCE(AVG(net_r), 0)::numeric AS avg_r
      FROM signal_learning_events
      ${where}
      GROUP BY outcome
      ORDER BY count DESC
    `, values),
    query(`
      SELECT factor_name, factor_value, sample_size, confidence_adjustment
      FROM factor_learning_stats
      WHERE sample_size >= 10 AND confidence_adjustment <> 0
      ORDER BY ABS(confidence_adjustment) DESC, sample_size DESC
      LIMIT 12
    `)
  ]);

  return {
    bestStrategies: strategies.rows.slice(0, 5).map(mapStrategyLearningRow),
    worstStrategies: [...strategies.rows].reverse().slice(0, 5).map(mapStrategyLearningRow),
    bestMarkets: markets.rows.slice(0, 5).map(mapMarketLearningRow),
    worstMarkets: [...markets.rows].reverse().slice(0, 5).map(mapMarketLearningRow),
    bestTimeframes: timeframes.rows.map((row) => ({
      timeframe: row.timeframe,
      sampleSize: Number(row.sample_size || 0),
      winRate: Number(Number(row.win_rate || 0).toFixed(1)),
      avgR: Number(Number(row.avg_r || 0).toFixed(2))
    })),
    mostCommonSlReasons: slReasons.rows.map(mapReasonCount),
    mostCommonExpiredReasons: expiredReasons.rows.map(mapReasonCount),
    confidenceBandPerformance: bands.rows.map((row) => ({
      band: row.band,
      sampleSize: Number(row.sample_size || 0),
      winRate: Number(Number(row.win_rate || 0).toFixed(1)),
      avgR: Number(Number(row.avg_r || 0).toFixed(2))
    })),
    signalsByOutcome: outcomes.rows.map((row) => ({
      outcome: row.outcome,
      count: Number(row.count || 0),
      avgR: Number(Number(row.avg_r || 0).toFixed(2))
    })),
    learningAdjustments: activeAdjustments.rows.map((row) => ({
      factorName: row.factor_name,
      factorValue: row.factor_value,
      sampleSize: Number(row.sample_size || 0),
      confidenceAdjustment: Number(row.confidence_adjustment || 0)
    }))
  };
}

async function refreshStrategyLearningStats(client, strategy, market, timeframe) {
  const result = await client.query(`
    SELECT
      COUNT(*)::integer AS sample_size,
      COALESCE(AVG(CASE WHEN outcome = 'Hit TP' THEN 100 ELSE 0 END), 0)::numeric AS win_rate,
      COALESCE(AVG(net_r), 0)::numeric AS avg_r,
      COALESCE(AVG(CASE WHEN outcome = 'Expired' THEN 100 ELSE 0 END), 0)::numeric AS expired_rate,
      COALESCE(AVG(CASE WHEN outcome = 'Hit SL' THEN 100 ELSE 0 END), 0)::numeric AS stop_loss_rate
    FROM signal_learning_events
    WHERE strategy = $1 AND pair = $2 AND timeframe = $3
  `, [strategy, market, timeframe]);
  const row = result.rows[0] || {};
  const tags = await learningTagsFor(client, "strategy = $1 AND pair = $2 AND timeframe = $3", [strategy, market, timeframe]);

  await client.query(`
    INSERT INTO strategy_learning_stats (
      strategy, market, timeframe, sample_size, win_rate, avg_r,
      expired_rate, stop_loss_rate, best_conditions, worst_conditions, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
    ON CONFLICT (strategy, market, timeframe)
    DO UPDATE SET
      sample_size = EXCLUDED.sample_size,
      win_rate = EXCLUDED.win_rate,
      avg_r = EXCLUDED.avg_r,
      expired_rate = EXCLUDED.expired_rate,
      stop_loss_rate = EXCLUDED.stop_loss_rate,
      best_conditions = EXCLUDED.best_conditions,
      worst_conditions = EXCLUDED.worst_conditions,
      updated_at = now()
  `, [
    strategy,
    market,
    timeframe,
    Number(row.sample_size || 0),
    Number(row.win_rate || 0),
    Number(row.avg_r || 0),
    Number(row.expired_rate || 0),
    Number(row.stop_loss_rate || 0),
    JSON.stringify(tags.best),
    JSON.stringify(tags.worst)
  ]);
}

async function refreshMarketTimeframeLearningStats(client, market, timeframe) {
  const result = await client.query(`
    SELECT
      COUNT(*)::integer AS sample_size,
      COALESCE(AVG(CASE WHEN outcome = 'Hit TP' THEN 100 ELSE 0 END), 0)::numeric AS win_rate,
      COALESCE(AVG(net_r), 0)::numeric AS avg_r
    FROM signal_learning_events
    WHERE pair = $1 AND timeframe = $2
  `, [market, timeframe]);
  const strategies = await client.query(`
    SELECT strategy, COALESCE(AVG(net_r), 0)::numeric AS avg_r, COUNT(*)::integer AS sample_size
    FROM signal_learning_events
    WHERE pair = $1 AND timeframe = $2
    GROUP BY strategy
    ORDER BY avg_r DESC, sample_size DESC
  `, [market, timeframe]);
  const row = result.rows[0] || {};

  await client.query(`
    INSERT INTO market_timeframe_learning_stats (
      market, timeframe, sample_size, win_rate, avg_r, best_strategy, worst_strategy, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,now())
    ON CONFLICT (market, timeframe)
    DO UPDATE SET
      sample_size = EXCLUDED.sample_size,
      win_rate = EXCLUDED.win_rate,
      avg_r = EXCLUDED.avg_r,
      best_strategy = EXCLUDED.best_strategy,
      worst_strategy = EXCLUDED.worst_strategy,
      updated_at = now()
  `, [
    market,
    timeframe,
    Number(row.sample_size || 0),
    Number(row.win_rate || 0),
    Number(row.avg_r || 0),
    strategies.rows[0]?.strategy || null,
    strategies.rows[strategies.rows.length - 1]?.strategy || null
  ]);
}

async function refreshFactorLearningStats(client, event) {
  const factors = [
    [`strategy:${event.strategy}`, event.strategy],
    [`market:${event.pair}`, event.pair],
    [`timeframe:${event.timeframe}`, event.timeframe],
    ...event.postMortemTags.map((tag) => [`tag:${tag}`, tag])
  ];

  for (const [factorName, factorValue] of factors) {
    const result = await client.query(`
      SELECT
        COUNT(*)::integer AS sample_size,
        COALESCE(AVG(CASE WHEN outcome = 'Hit TP' THEN 100 ELSE 0 END), 0)::numeric AS win_rate,
        COALESCE(AVG(net_r), 0)::numeric AS avg_r,
        COALESCE(AVG(CASE WHEN outcome = 'Hit SL' THEN 100 ELSE 0 END), 0)::numeric AS stop_loss_rate,
        COALESCE(AVG(CASE WHEN outcome = 'Expired' THEN 100 ELSE 0 END), 0)::numeric AS expired_rate
      FROM signal_learning_events
      WHERE post_mortem_tags ? $1 OR strategy = $2 OR pair = $2 OR timeframe = $2
    `, [factorValue, factorValue]);
    const row = result.rows[0] || {};
    const sampleSize = Number(row.sample_size || 0);
    const avgR = Number(row.avg_r || 0);
    const winRate = Number(row.win_rate || 0);
    const confidenceAdjustment = sampleSize < 10
      ? 0
      : avgR > 0.25 && winRate >= 58
        ? 1
        : avgR < 0 || winRate < 42
          ? -1
          : 0;

    await client.query(`
      INSERT INTO factor_learning_stats (
        factor_name, factor_value, sample_size, win_rate, avg_r,
        stop_loss_rate, expired_rate, confidence_adjustment, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
      ON CONFLICT (factor_name, factor_value)
      DO UPDATE SET
        sample_size = EXCLUDED.sample_size,
        win_rate = EXCLUDED.win_rate,
        avg_r = EXCLUDED.avg_r,
        stop_loss_rate = EXCLUDED.stop_loss_rate,
        expired_rate = EXCLUDED.expired_rate,
        confidence_adjustment = EXCLUDED.confidence_adjustment,
        updated_at = now()
    `, [
      factorName,
      factorValue,
      sampleSize,
      winRate,
      avgR,
      Number(row.stop_loss_rate || 0),
      Number(row.expired_rate || 0),
      confidenceAdjustment
    ]);
  }
}

async function learningTagsFor(client, whereClause, params) {
  const best = await client.query(`
    SELECT tag.value, COUNT(*)::integer AS count
    FROM signal_learning_events e
    CROSS JOIN LATERAL jsonb_array_elements_text(e.post_mortem_tags) tag(value)
    WHERE ${whereClause} AND e.outcome = 'Hit TP'
    GROUP BY tag.value
    ORDER BY count DESC
    LIMIT 5
  `, params);
  const worst = await client.query(`
    SELECT tag.value, COUNT(*)::integer AS count
    FROM signal_learning_events e
    CROSS JOIN LATERAL jsonb_array_elements_text(e.post_mortem_tags) tag(value)
    WHERE ${whereClause} AND e.outcome IN ('Hit SL', 'Expired')
    GROUP BY tag.value
    ORDER BY count DESC
    LIMIT 5
  `, params);
  return {
    best: best.rows.map(mapReasonCount),
    worst: worst.rows.map(mapReasonCount)
  };
}

export async function createPaperTrade(userId, signalId, sizing) {
  const result = await query(`
    INSERT INTO paper_trades (
      id, user_id, saved_signal_id, account_size, requested_risk_percent,
      effective_risk_percent, risk_amount, position_size, potential_profit
    )
    SELECT $1, $2, s.id, $4, $5, $6, $7, $8, $9
    FROM saved_signals s
    JOIN unlocked_signals u
      ON u.saved_signal_id = s.id AND u.user_id = $2
    WHERE s.id = $3 AND s.user_id = $2
    ON CONFLICT (user_id, saved_signal_id) DO NOTHING
    RETURNING id
  `, [
    createId("paper"),
    userId,
    signalId,
    sizing.accountSize,
    sizing.requestedRiskPercent,
    sizing.effectiveRiskPercent,
    sizing.riskAmount,
    sizing.positionSize,
    sizing.potentialProfit
  ]);

  return result.rows[0] || null;
}

export async function listPaperTradesByUser(userId) {
  const result = await query(`
    SELECT p.id AS paper_trade_id, p.entered_at, p.account_size,
      p.requested_risk_percent, p.effective_risk_percent, p.risk_amount,
      p.position_size, p.potential_profit,
      s.*, o.status, o.status_reason, o.resolved_at,
      o.updated_at AS status_updated_at
    FROM paper_trades p
    JOIN saved_signals s ON s.id = p.saved_signal_id
    LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
    WHERE p.user_id = $1 AND s.user_id = $1
    ORDER BY p.entered_at DESC
    LIMIT 100
  `, [userId]);

  return result.rows.map(mapPaperTrade);
}

export async function listJournalEntriesByUser(userId, filters = {}) {
  const values = [userId];
  const clauses = ["p.user_id = $1", "s.user_id = $1"];

  if (filters.symbol) {
    values.push(filters.symbol);
    clauses.push(`s.symbol = $${values.length}`);
  }

  if (filters.timeframe) {
    values.push(filters.timeframe);
    clauses.push(`s.timeframe = $${values.length}`);
  }

  if (filters.from) {
    values.push(filters.from);
    clauses.push(`p.entered_at >= $${values.length}`);
  }

  if (filters.to) {
    values.push(filters.to);
    clauses.push(`p.entered_at < $${values.length}`);
  }

  if (filters.emotion) {
    values.push(filters.emotion);
    clauses.push(`$${values.length} = ANY(COALESCE(j.emotion_tags, ARRAY[]::text[]))`);
  }

  const result = await query(`
    SELECT p.id AS paper_trade_id, p.entered_at, p.account_size,
      p.requested_risk_percent, p.effective_risk_percent, p.risk_amount,
      p.position_size, p.potential_profit,
      s.*, o.status, o.status_reason, o.resolved_at,
      o.updated_at AS status_updated_at,
      j.notes_before_entry, j.notes_after_exit, j.emotion_tags,
      j.rating, j.screenshot_url, j.updated_at AS journal_updated_at
    FROM paper_trades p
    JOIN saved_signals s ON s.id = p.saved_signal_id
    LEFT JOIN signal_outcomes o ON o.saved_signal_id = s.id
    LEFT JOIN trade_journals j
      ON j.paper_trade_id = p.id AND j.user_id = p.user_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY p.entered_at DESC
    LIMIT 100
  `, values);

  return result.rows.map(mapJournalEntry);
}

export async function upsertTradeJournal(userId, paperTradeId, journal) {
  const result = await query(`
    INSERT INTO trade_journals (
      paper_trade_id, user_id, notes_before_entry, notes_after_exit,
      emotion_tags, rating, screenshot_url
    )
    SELECT p.id, p.user_id, $3, $4, $5, $6, $7
    FROM paper_trades p
    WHERE p.id = $2 AND p.user_id = $1
    ON CONFLICT (paper_trade_id)
    DO UPDATE SET
      notes_before_entry = EXCLUDED.notes_before_entry,
      notes_after_exit = EXCLUDED.notes_after_exit,
      emotion_tags = EXCLUDED.emotion_tags,
      rating = EXCLUDED.rating,
      screenshot_url = EXCLUDED.screenshot_url,
      updated_at = now()
    RETURNING paper_trade_id
  `, [
    userId,
    paperTradeId,
    journal.notesBeforeEntry,
    journal.notesAfterExit,
    journal.emotionTags,
    journal.rating,
    journal.screenshotUrl
  ]);

  return result.rows[0] || null;
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

export async function listAllEnabledAlertPreferences() {
  const result = await query(`
    SELECT p.*, u.role, u.email_verified_at
    FROM alert_preferences p
    JOIN users u ON u.id = p.user_id
    WHERE p.enabled = true
    ORDER BY p.user_id, p.symbol, p.timeframe
  `);
  return result.rows;
}

export async function hasRecentDetectedAlert(userId, setup, cooldownMs) {
  const cooldownSeconds = Math.max(1, Math.floor(Number(cooldownMs || 0) / 1000));
  const setupId = setup.setupKey || setup.id;
  const result = await query(`
    SELECT id
    FROM detected_alerts
    WHERE user_id = $1
      AND setup_id = $2
      AND detected_at >= now() - ($3::text || ' seconds')::interval
    LIMIT 1
  `, [
    userId,
    setupId,
    String(cooldownSeconds)
  ]);
  return Boolean(result.rows[0]);
}

export async function saveDetectedAlert(userId, preference, setup) {
  const setupId = setup.setupKey || setup.id;
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
    setupId,
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

export async function listAllEnabledTelegramSettings() {
  const result = await query(`
    SELECT s.*, u.role, u.email_verified_at
    FROM telegram_notification_settings s
    JOIN users u ON u.id = s.user_id
    WHERE s.enabled = true
      AND s.chat_id IS NOT NULL
    ORDER BY s.user_id
  `);
  return result.rows.map((row) => ({
    ...mapTelegramSettings(row),
    userId: row.user_id
  }));
}

export async function upsertTelegramSettings(userId, settings) {
  return transaction(async (client) => {
    const result = await client.query(`
      INSERT INTO telegram_notification_settings (
        user_id, chat_id, enabled, favorite_markets_only, timeframes,
        direction, minimum_confidence
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (user_id)
      DO UPDATE SET
        chat_id = EXCLUDED.chat_id,
        enabled = EXCLUDED.enabled,
        favorite_markets_only = EXCLUDED.favorite_markets_only,
        timeframes = EXCLUDED.timeframes,
        direction = EXCLUDED.direction,
        minimum_confidence = EXCLUDED.minimum_confidence,
        updated_at = now()
      RETURNING *
    `, [
      userId,
      settings.chatId,
      settings.enabled,
      Boolean(settings.favoriteMarketsOnly),
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
  const setupKey = setup.setupKey || setup.id;
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
    setupKey,
    settings.chatId,
    JSON.stringify(setup)
  ]);
  return result.rows[0] || null;
}

export async function findTelegramNotificationPayload(userId, setupKey) {
  const result = await query(`
    SELECT payload
    FROM telegram_notification_queue
    WHERE user_id = $1 AND setup_key = $2
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId, setupKey]);
  return result.rows[0]?.payload || null;
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
      VALUES ($1,$2,false,false,ARRAY['1h','4h']::text[],'both',80)
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
        SET paid_credits = GREATEST(paid_credits, $2),
          unlock_credits_balance = GREATEST(unlock_credits_balance, $2),
          updated_at = now()
        WHERE user_id = $1
      `, [request.user_id, appConfig.testerCreditAllowance]);
      await client.query(`
        UPDATE affiliate_referrals
        SET active = false, monthly_commission_cents = 0, updated_at = now()
        WHERE affiliate_user_id = $1 OR referred_user_id = $1
      `, [request.user_id]);
      await client.query(`
        UPDATE affiliate_payout_requests
        SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), updated_at = now()
        WHERE affiliate_user_id = $1 AND status = 'pending'
      `, [request.user_id, adminUserId]);
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

function mapPaperTrade(row) {
  const signal = mapSignal(row);
  const status = signal.status === "Active" ? "Open" : signal.status;
  const realizedR = status === "Hit TP"
    ? signal.riskRewardRatio
    : status === "Hit SL"
      ? -1
      : 0;

  return {
    id: row.paper_trade_id,
    signalId: signal.id,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    direction: signal.direction,
    setupType: signal.setupType,
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    riskRewardRatio: signal.riskRewardRatio,
    confidenceScore: signal.confidenceScore,
    qualityScore: signal.qualityScore,
    status,
    realizedR,
    accountSize: Number(row.account_size || 0),
    requestedRiskPercent: Number(row.requested_risk_percent || 0),
    effectiveRiskPercent: Number(row.effective_risk_percent || 0),
    riskAmount: Number(row.risk_amount || 0),
    positionSize: Number(row.position_size || 0),
    potentialProfit: Number(row.potential_profit || 0),
    realizedPnl: realizedR * Number(row.risk_amount || 0),
    enteredAt: row.entered_at,
    resolvedAt: signal.resolvedAt,
    statusReason: signal.statusReason
  };
}

function mapJournalEntry(row) {
  return {
    ...mapPaperTrade(row),
    journal: {
      notesBeforeEntry: row.notes_before_entry || "",
      notesAfterExit: row.notes_after_exit || "",
      emotionTags: row.emotion_tags || [],
      rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
      screenshotUrl: row.screenshot_url || "",
      updatedAt: row.journal_updated_at || null
    }
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

function mapAdminSignalMonitorRow(row) {
  const rejectedReasons = Array.isArray(row.rejected_reasons) ? row.rejected_reasons : [];
  return {
    id: row.id,
    market: row.symbol,
    timeframe: row.timeframe,
    direction: row.direction,
    strategy: row.strategy || "Unknown",
    confidence: Number(row.confidence_score || 0),
    riskReward: Number(row.risk_reward_ratio || 0),
    validationScore: Number(row.validation_score || 0),
    validationPassed: row.validation_passed !== false,
    status: row.status || (row.validation_passed === false ? "Rejected" : "Generated"),
    rejectedReason: rejectedReasons[0]?.reason || null,
    rejectedReasons,
    createdAt: row.created_at
  };
}

function buildAdminHealth(systemRow = {}) {
  const telegramPending = Number(systemRow.telegram_pending || 0);
  const activeTracking = Number(systemRow.active_tracking || 0);
  return [
    { key: "database", label: "Database", status: "green", detail: "Query OK" },
    {
      key: "telegram",
      label: "Telegram",
      status: appConfig.telegram?.botToken ? "green" : "red",
      detail: appConfig.telegram?.botToken ? `${telegramPending} queued` : "Bot token missing"
    },
    {
      key: "coinbase",
      label: "Coinbase",
      status: appConfig.marketData?.baseUrl ? "green" : "red",
      detail: appConfig.marketData?.baseUrl ? "Provider configured" : "Provider URL missing"
    },
    {
      key: "stripe",
      label: "Stripe",
      status: appConfig.stripe?.secretKey ? "green" : "red",
      detail: appConfig.stripe?.secretKey ? "Secret configured" : "Secret key missing"
    },
    {
      key: "scanner",
      label: "Scanner",
      status: "green",
      detail: `${Number(systemRow.recent_scans || 0)} scans in last 20m`
    },
    {
      key: "auto_scan",
      label: "Auto Scan",
      status: appConfig.autoScan?.enabled ? "green" : "red",
      detail: appConfig.autoScan?.enabled
        ? `Enabled every ${Math.round(Number(appConfig.autoScan.intervalMs || 0) / 60000)}m`
        : "Disabled"
    },
    {
      key: "outcome_tracker",
      label: "Outcome Tracker",
      status: appConfig.signalTracking?.enabled ? "green" : "red",
      detail: appConfig.signalTracking?.enabled ? `${activeTracking} active signals` : "Disabled"
    },
    {
      key: "commodities",
      label: "Twelve Data",
      status: appConfig.twelveData?.apiKey ? "green" : "red",
      detail: appConfig.twelveData?.apiKey ? "Commodity provider configured" : "API key missing"
    }
  ];
}

function safeAdminMessage(message) {
  return String(message || "")
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+\b/g, "[redacted-key]")
    .replace(/\bwhsec_[A-Za-z0-9_]+\b/g, "[redacted-webhook-secret]")
    .replace(/\b[A-Fa-f0-9]{64,}\b/g, "[redacted-token]")
    .slice(0, 240);
}

function mapLearningStats(row = {}) {
  return {
    sampleSize: Number(row.sample_size || 0),
    winRate: Number(row.win_rate || 0),
    avgR: Number(row.avg_r || 0),
    expiredRate: Number(row.expired_rate || 0),
    stopLossRate: Number(row.stop_loss_rate || 0)
  };
}

function mapStrategyLearningRow(row = {}) {
  return {
    strategy: row.strategy,
    market: row.market,
    timeframe: row.timeframe,
    sampleSize: Number(row.sample_size || 0),
    winRate: Number(Number(row.win_rate || 0).toFixed(1)),
    avgR: Number(Number(row.avg_r || 0).toFixed(2))
  };
}

function mapMarketLearningRow(row = {}) {
  return {
    market: row.market,
    timeframe: row.timeframe,
    sampleSize: Number(row.sample_size || 0),
    winRate: Number(Number(row.win_rate || 0).toFixed(1)),
    avgR: Number(Number(row.avg_r || 0).toFixed(2)),
    bestStrategy: row.best_strategy || null,
    worstStrategy: row.worst_strategy || null
  };
}

function mapReasonCount(row = {}) {
  return {
    reason: row.reason || row.value || "unknown",
    count: Number(row.count || 0)
  };
}

function mapUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username || null,
    usernameNormalized: row.username_normalized || null,
    usernameUpdatedAt: row.username_updated_at || null,
    publicProfileEnabled: Boolean(row.public_profile_enabled),
    publicLeaderboardEnabled: Boolean(row.public_leaderboard_enabled),
    role: row.role || "user",
    password: {
      salt: row.password_salt,
      hash: row.password_hash
    },
    plan: row.plan,
    emailVerifiedAt: row.email_verified_at,
    trialUsed: Boolean(row.trial_used),
    signupIpHash: row.signup_ip_hash,
    deviceFingerprintHash: row.device_fingerprint_hash,
    abuseScore: Number(row.abuse_score || 0),
    abuseFlags: row.abuse_flags || [],
    abuseReviewStatus: row.abuse_review_status || "clear",
    trialSignalsUsed: Number(row.trial_signals_used || 0),
    freeSignalAllowance: row.free_signal_allowance === null || row.free_signal_allowance === undefined
      ? appConfig.freeSignalAllowance
      : Number(row.free_signal_allowance),
    paidCredits: Number(row.paid_credits || 0),
    unlockCreditsBalance: Number(row.unlock_credits_balance || 0),
    lifetimeUnlocksUsed: Number(row.lifetime_unlocks_used || 0),
    discoveriesToday: Number(row.discoveries_today || 0),
    discoveriesPeriod: Number(row.discoveries_period || 0),
    subscription: {
      status: row.subscription_status || "trialing",
      provider: row.provider || "stripe",
      providerCustomerId: row.provider_customer_id,
      stripeMode: row.stripe_mode,
      providerSubscriptionId: row.provider_subscription_id,
      priceId: row.price_id,
      currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
      createdAt: row.created_at
    },
    createdAt: row.created_at
  };
}

function normalizeUsernameForLookup(username) {
  const value = String(username || "").trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(value)) return "";
  return value.toLowerCase();
}

function mapSignal(row) {
  return {
    id: row.id,
    userId: row.user_id,
    setupKey: row.setup_key,
    symbol: row.symbol,
    timeframe: row.timeframe,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    riskRewardRatio: Number(row.risk_reward_ratio),
    confidenceScore: Number(row.confidence_score),
    qualityScore: Number(row.quality_score || 0),
    validationPassed: row.validation_passed !== false,
    validationScore: Number(row.validation_score || row.indicators?.validationScore || 100),
    confidenceBand: row.indicators?.validationConfidenceBand || null,
    rejectedReasons: row.indicators?.validationRejectedReasons || [],
    setupType: row.setup_type || "Qualified setup",
    confluenceScore: Number(row.indicators?.confluenceScore || 0),
    alignmentBadge: row.indicators?.alignmentBadge || "Partial Alignment",
    session: row.indicators?.session || "Unknown",
    newsRisk: {
      level: row.indicators?.newsRiskLevel || "Unknown",
      badge: row.indicators?.newsRiskBadge || "Calendar Unavailable",
      explanation: row.indicators?.newsRiskExplanation || "",
      event: row.indicators?.newsEvent || null
    },
    smc: {
      score: Number(row.indicators?.smcScore || 0),
      conflict: Boolean(row.indicators?.smcConflict),
      explanation: row.indicators?.smcExplanation || "SMC unavailable.",
      factors: row.indicators?.smcFactors || []
    },
    riskPlan: {
      stopStyle: row.indicators?.stopStyle || "ATR regime",
      stopMultiplier: Number(row.indicators?.stopMultiplier || 0),
      targetStyle: row.indicators?.targetStyle || "Regime dynamic",
      targetMultiple: Number(row.indicators?.targetMultiple || row.risk_reward_ratio || 0),
      riskTier: row.indicators?.riskTier || "Unknown",
      recommendedRiskPercent: Number(row.indicators?.recommendedRiskPercent || 0),
      explanation: row.indicators?.riskExplanation || ""
    },
    marketStructure: {
      available: Boolean(row.indicators?.vwapAvailable),
      vwapAligned: Boolean(row.indicators?.vwapAligned),
      volumeProfileAligned: Boolean(row.indicators?.volumeProfileAligned),
      factors: row.indicators?.marketStructureFactors || [],
      explanation: row.indicators?.marketStructureExplanation || "",
      vwap: {
        session: { value: row.indicators?.sessionVwap ?? null },
        anchored: { value: row.indicators?.anchoredVwap ?? null },
        event: row.indicators?.vwapEvent || "None"
      },
      volumeProfile: row.indicators?.volumeProfile || null
    },
    correlation: {
      available: Boolean(row.indicators?.correlationAvailable),
      aligned: Boolean(row.indicators?.correlationAligned),
      conflict: Boolean(row.indicators?.correlationConflict),
      breakdown: Boolean(row.indicators?.correlationBreakdown),
      explanation: row.indicators?.correlationExplanation || "",
      peers: row.indicators?.correlationPeers || []
    },
    analyst: {
      strategyVersion: row.indicators?.strategyVersion || "legacy",
      overallQuality: row.indicators?.analystOverallQuality || null,
      strengths: row.indicators?.analystStrengths || [],
      weaknesses: row.indicators?.analystWeaknesses || [],
      sections: row.indicators?.analystSections || {},
      adaptive: {
        adjustment: Number(row.indicators?.analystAdaptiveAdjustment || 0),
        factors: row.indicators?.analystAdaptiveFactors || []
      },
      summary: row.reasoning
    },
    learningInsight: {
      mode: row.indicators?.learningMode || "neutral",
      message: row.indicators?.learningInsight ||
        "This market/timeframe has limited completed-signal history, so learning adjustment is neutral.",
      adjustment: Number(row.indicators?.learningAdjustment || 0),
      sampleSize: Number(row.indicators?.learningSampleSize || 0)
    },
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
