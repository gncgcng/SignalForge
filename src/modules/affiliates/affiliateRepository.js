import { randomBytes } from "node:crypto";
import { appConfig } from "../../config/appConfig.js";
import { query, transaction } from "../../db/client.js";
import { createId } from "../../shared/ids.js";

export async function ensureAffiliateCode(userId) {
  const current = await query(
    "SELECT affiliate_code FROM users WHERE id = $1",
    [userId]
  );
  if (current.rows[0]?.affiliate_code) return current.rows[0].affiliate_code;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomBytes(6).toString("base64url");
    try {
      const result = await query(`
        UPDATE users
        SET affiliate_code = $2, updated_at = now()
        WHERE id = $1 AND affiliate_code IS NULL
        RETURNING affiliate_code
      `, [userId, code]);
      if (result.rows[0]?.affiliate_code) return result.rows[0].affiliate_code;
      return (await query(
        "SELECT affiliate_code FROM users WHERE id = $1",
        [userId]
      )).rows[0]?.affiliate_code;
    } catch (error) {
      if (error.code !== "23505") throw error;
    }
  }
  throw new Error("Affiliate code could not be generated.");
}

export async function recordAffiliateClick(affiliateCode, visitorId) {
  if (!affiliateCode || !visitorId) return false;
  const result = await query(`
    INSERT INTO affiliate_clicks (id, affiliate_user_id, visitor_id)
    SELECT $1, id, $3
    FROM users
    WHERE affiliate_code = $2
      AND affiliate_disabled = false
      AND role <> 'tester'
    ON CONFLICT (affiliate_user_id, visitor_id) DO NOTHING
    RETURNING id
  `, [createId("afclk"), affiliateCode, visitorId]);
  return Boolean(result.rows[0]);
}

export async function attributeAffiliateReferral(referredUserId, affiliateCode) {
  if (!referredUserId || !affiliateCode) return null;
  const result = await query(`
    INSERT INTO affiliate_referrals (
      id, affiliate_user_id, referred_user_id
    )
    SELECT $1, affiliate.id, referred.id
    FROM users affiliate
    JOIN users referred ON referred.id = $2
    WHERE affiliate.affiliate_code = $3
      AND affiliate.id <> referred.id
      AND affiliate.affiliate_disabled = false
      AND affiliate.role <> 'tester'
      AND referred.role <> 'tester'
      AND (
        affiliate.device_fingerprint_hash IS NULL OR
        referred.device_fingerprint_hash IS NULL OR
        affiliate.device_fingerprint_hash <> referred.device_fingerprint_hash
      )
    ON CONFLICT (referred_user_id) DO NOTHING
    RETURNING *
  `, [createId("afref"), referredUserId, affiliateCode]);
  return result.rows[0] || null;
}

export async function getAffiliateDashboard(userId) {
  const code = await ensureAffiliateCode(userId);
  const [summary, referrals, payouts] = await Promise.all([
    query(`
      SELECT
        COUNT(DISTINCT r.id)::integer AS referred_accounts,
        COUNT(DISTINCT r.id) FILTER (WHERE r.active)::integer AS active_subscribers,
        COALESCE(SUM(r.monthly_commission_cents) FILTER (WHERE r.active), 0)::integer
          AS monthly_commission_cents,
        COALESCE(SUM(r.lifetime_commission_cents), 0)::integer AS lifetime_earnings_cents,
        (SELECT COUNT(*)::integer FROM affiliate_clicks c
          WHERE c.affiliate_user_id = $1) AS clicks,
        COALESCE((SELECT SUM(p.amount_cents) FROM affiliate_payout_requests p
          WHERE p.affiliate_user_id = $1 AND p.status IN ('pending', 'approved')), 0)::integer
          AS reserved_payout_cents
      FROM affiliate_referrals r
      WHERE r.affiliate_user_id = $1
    `, [userId]),
    query(`
      SELECT r.id, u.email, r.subscription_plan, r.monthly_commission_cents,
        r.lifetime_commission_cents, r.active, r.suspicious, r.created_at
      FROM affiliate_referrals r
      JOIN users u ON u.id = r.referred_user_id
      WHERE r.affiliate_user_id = $1
      ORDER BY r.created_at DESC
      LIMIT 100
    `, [userId]),
    query(`
      SELECT id, amount_cents, payout_method, payout_destination, status, created_at
      FROM affiliate_payout_requests
      WHERE affiliate_user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [userId])
  ]);
  const row = summary.rows[0] || {};
  const lifetime = Number(row.lifetime_earnings_cents || 0);
  const reserved = Number(row.reserved_payout_cents || 0);
  const clicks = Number(row.clicks || 0);
  const referred = Number(row.referred_accounts || 0);

  return {
    affiliateCode: code,
    affiliateLink: `${appConfig.affiliate.publicAppUrl}/?ref=${encodeURIComponent(code)}`,
    activeSubscribers: Number(row.active_subscribers || 0),
    monthlyCommissionCents: Number(row.monthly_commission_cents || 0),
    lifetimeEarningsCents: lifetime,
    pendingPayoutCents: Math.max(0, lifetime - reserved),
    conversionRate: clicks > 0
      ? Math.min(100, Math.round((referred / clicks) * 1000) / 10)
      : 0,
    minimumPayoutCents: appConfig.affiliate.minimumPayoutCents,
    disabled: await isAffiliateDisabled(userId),
    referrals: referrals.rows,
    payouts: payouts.rows
  };
}

export async function createAffiliatePayoutRequest(
  userId,
  { payoutMethod, payoutDestination }
) {
  return transaction(async (client) => {
    const account = await client.query(`
      SELECT affiliate_disabled, role
      FROM users
      WHERE id = $1
      FOR UPDATE
    `, [userId]);
    if (!account.rows[0] || account.rows[0].affiliate_disabled) {
      throw affiliateError("Affiliate account is disabled.", 403);
    }
    if (account.rows[0].role === "tester") {
      throw affiliateError("Tester accounts are not eligible for affiliate payouts.", 403);
    }

    const balance = await client.query(`
      SELECT
        COALESCE(SUM(lifetime_commission_cents), 0)::integer AS lifetime,
        COALESCE((SELECT SUM(amount_cents) FROM affiliate_payout_requests
          WHERE affiliate_user_id = $1 AND status IN ('pending', 'approved')), 0)::integer
          AS reserved
      FROM affiliate_referrals
      WHERE affiliate_user_id = $1
    `, [userId]);
    const available = Number(balance.rows[0].lifetime || 0) -
      Number(balance.rows[0].reserved || 0);
    if (available < appConfig.affiliate.minimumPayoutCents) {
      throw affiliateError("Minimum affiliate payout is $25.", 400);
    }

    const result = await client.query(`
      INSERT INTO affiliate_payout_requests (
        id, affiliate_user_id, amount_cents, payout_method, payout_destination
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [
      createId("afpay"),
      userId,
      available,
      payoutMethod,
      payoutDestination
    ]);
    return result.rows[0];
  });
}

export async function recordRecurringAffiliateCommission({
  referredUserId,
  plan,
  grossAmountCents,
  stripeInvoiceId,
  stripeEventId,
  periodStart
}) {
  if (!["pro", "elite"].includes(plan) || grossAmountCents <= 0) return null;
  const commissionCents = calculateAffiliateCommissionCents(grossAmountCents);

  return transaction(async (client) => {
    const referralResult = await client.query(`
      SELECT r.*, affiliate.role AS affiliate_role,
        affiliate.affiliate_disabled, referred.role AS referred_role
      FROM affiliate_referrals r
      JOIN users affiliate ON affiliate.id = r.affiliate_user_id
      JOIN users referred ON referred.id = r.referred_user_id
      WHERE r.referred_user_id = $1
      FOR UPDATE OF r
    `, [referredUserId]);
    const referral = referralResult.rows[0];
    if (
      !referral ||
      referral.affiliate_disabled ||
      referral.affiliate_role === "tester" ||
      referral.referred_role === "tester"
    ) return null;

    const inserted = await client.query(`
      INSERT INTO affiliate_commissions (
        id, referral_id, stripe_invoice_id, stripe_event_id, subscription_plan,
        gross_amount_cents, commission_amount_cents, period_start
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (stripe_invoice_id) DO NOTHING
      RETURNING *
    `, [
      createId("afcom"),
      referral.id,
      stripeInvoiceId,
      stripeEventId,
      plan,
      grossAmountCents,
      commissionCents,
      periodStart
    ]);
    if (!inserted.rows[0]) return null;

    await client.query(`
      UPDATE affiliate_referrals
      SET subscription_plan = $2,
        monthly_commission_cents = $3,
        lifetime_commission_cents = lifetime_commission_cents + $3,
        active = true,
        updated_at = now()
      WHERE id = $1
    `, [referral.id, plan, commissionCents]);
    return inserted.rows[0];
  });
}

export function calculateAffiliateCommissionCents(grossAmountCents) {
  return Math.round(
    Math.max(0, Number(grossAmountCents || 0)) * appConfig.affiliate.commissionRate
  );
}

export async function reconcileAffiliateRefund(stripeInvoiceId, refundedGrossCents) {
  if (!stripeInvoiceId || refundedGrossCents <= 0) return null;

  return transaction(async (client) => {
    const result = await client.query(`
      SELECT c.*, r.id AS affiliate_referral_id
      FROM affiliate_commissions c
      JOIN affiliate_referrals r ON r.id = c.referral_id
      WHERE c.stripe_invoice_id = $1
      FOR UPDATE OF c, r
    `, [stripeInvoiceId]);
    const commission = result.rows[0];
    if (!commission) return null;

    const newReversal = Math.min(
      Number(commission.commission_amount_cents),
      calculateAffiliateCommissionCents(refundedGrossCents)
    );
    const previousReversal = Number(commission.reversed_commission_cents || 0);
    const delta = Math.max(0, newReversal - previousReversal);
    if (delta <= 0) return commission;
    const commissionDate = new Date(commission.period_start || commission.created_at);
    const now = new Date();
    const currentMonth = commissionDate.getUTCFullYear() === now.getUTCFullYear() &&
      commissionDate.getUTCMonth() === now.getUTCMonth();

    await client.query(`
      UPDATE affiliate_commissions
      SET refunded_amount_cents = GREATEST(refunded_amount_cents, $2),
        reversed_commission_cents = $3,
        status = CASE
          WHEN $3 >= commission_amount_cents THEN 'refunded'
          ELSE 'partially_refunded'
        END,
        updated_at = now()
      WHERE id = $1
    `, [commission.id, refundedGrossCents, newReversal]);
    await client.query(`
      UPDATE affiliate_referrals
      SET lifetime_commission_cents = GREATEST(0, lifetime_commission_cents - $2),
        monthly_commission_cents = GREATEST(
          0,
          monthly_commission_cents - CASE WHEN $3 THEN $2 ELSE 0 END
        ),
        updated_at = now()
      WHERE id = $1
    `, [commission.affiliate_referral_id, delta, currentMonth]);
    return { ...commission, reversedCommissionCents: newReversal };
  });
}

export async function deactivateAffiliateReferral(referredUserId) {
  await query(`
    UPDATE affiliate_referrals
    SET active = false, subscription_plan = 'free',
      monthly_commission_cents = 0, updated_at = now()
    WHERE referred_user_id = $1
  `, [referredUserId]);
}

export async function getAffiliateAdminDashboard() {
  const [affiliates, referrals, payouts] = await Promise.all([
    query(`
      SELECT u.id, u.email, u.affiliate_code, u.affiliate_disabled,
        COUNT(r.id)::integer AS referrals,
        COUNT(r.id) FILTER (WHERE r.active)::integer AS active_referrals,
        COALESCE(SUM(r.lifetime_commission_cents), 0)::integer AS lifetime_earnings_cents
      FROM users u
      LEFT JOIN affiliate_referrals r ON r.affiliate_user_id = u.id
      WHERE u.affiliate_code IS NOT NULL AND u.role <> 'tester'
      GROUP BY u.id
      ORDER BY lifetime_earnings_cents DESC, u.created_at DESC
    `),
    query(`
      SELECT r.id, affiliate.email AS affiliate_email, referred.email AS referred_email,
        r.subscription_plan, r.monthly_commission_cents, r.lifetime_commission_cents,
        r.active, r.suspicious, r.suspicious_reason, r.created_at
      FROM affiliate_referrals r
      JOIN users affiliate ON affiliate.id = r.affiliate_user_id
      JOIN users referred ON referred.id = r.referred_user_id
      ORDER BY r.created_at DESC
      LIMIT 250
    `),
    query(`
      SELECT p.*, u.email
      FROM affiliate_payout_requests p
      JOIN users u ON u.id = p.affiliate_user_id
      ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, p.created_at DESC
      LIMIT 250
    `)
  ]);
  return { affiliates: affiliates.rows, referrals: referrals.rows, payouts: payouts.rows };
}

export async function reviewAffiliatePayout(requestId, adminUserId, decision) {
  const result = await query(`
    UPDATE affiliate_payout_requests
    SET status = $3, reviewed_by = $2, reviewed_at = now(), updated_at = now()
    WHERE id = $1 AND status = 'pending'
    RETURNING *
  `, [requestId, adminUserId, decision]);
  return result.rows[0] || null;
}

export async function setAffiliateReferralSuspicious(referralId, suspicious, reason) {
  const result = await query(`
    UPDATE affiliate_referrals
    SET suspicious = $2, suspicious_reason = $3, updated_at = now()
    WHERE id = $1
    RETURNING *
  `, [referralId, suspicious, suspicious ? reason || "Flagged by admin" : null]);
  return result.rows[0] || null;
}

export async function setAffiliateDisabled(userId, disabled, adminUserId) {
  return transaction(async (client) => {
    const result = await client.query(`
      UPDATE users
      SET affiliate_disabled = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, affiliate_disabled
    `, [userId, disabled]);
    if (disabled) {
      await client.query(`
        UPDATE affiliate_referrals
        SET active = false, monthly_commission_cents = 0, updated_at = now()
        WHERE affiliate_user_id = $1
      `, [userId]);
      await client.query(`
        UPDATE affiliate_payout_requests
        SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), updated_at = now()
        WHERE affiliate_user_id = $1 AND status = 'pending'
      `, [userId, adminUserId]);
    }
    return result.rows[0] || null;
  });
}

async function isAffiliateDisabled(userId) {
  const result = await query(
    "SELECT affiliate_disabled FROM users WHERE id = $1",
    [userId]
  );
  return Boolean(result.rows[0]?.affiliate_disabled);
}

function affiliateError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
