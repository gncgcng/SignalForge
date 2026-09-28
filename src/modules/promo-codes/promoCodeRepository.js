import { query, transaction } from "../../db/client.js";
import { createId } from "../../shared/ids.js";
import { grantUnlockCredits } from "../../db/repositories.js";

export async function createPromoCode(promo) {
  const result = await query(`
    INSERT INTO promo_codes (
      id, code, type, max_redemptions, expires_at, created_by_admin_id,
      stripe_coupon_id, stripe_promotion_code_id, discount_percent_off, discount_amount_off_cents,
      credit_quantity
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *
  `, [
    promo.id, promo.code, promo.type, promo.maxRedemptions, promo.expiresAt, promo.createdByAdminId,
    promo.stripeCouponId || null, promo.stripePromotionCodeId || null,
    promo.discountPercentOff || null, promo.discountAmountOffCents || null,
    promo.creditQuantity || null
  ]);
  return mapPromoCode(result.rows[0]);
}

export async function getPromoCodeById(id) {
  const result = await query("SELECT * FROM promo_codes WHERE id = $1", [id]);
  return mapPromoCode(result.rows[0]);
}

export async function setPromoCodeActive(id, active) {
  const result = await query(`
    UPDATE promo_codes SET active = $2 WHERE id = $1 RETURNING *
  `, [id, active]);
  return mapPromoCode(result.rows[0]);
}

export async function listPromoCodesWithCounts() {
  const result = await query(`
    SELECT pc.*, COUNT(r.id)::integer AS redemption_count
    FROM promo_codes pc
    LEFT JOIN promo_code_redemptions r ON r.promo_code_id = pc.id
    GROUP BY pc.id
    ORDER BY pc.created_at DESC
  `);
  return result.rows.map((row) => ({
    ...mapPromoCode(row),
    redemptionCount: Number(row.redemption_count || 0)
  }));
}

export async function listRedemptions(promoCodeId) {
  const result = await query(`
    SELECT r.id, r.user_id, r.redeemed_at, u.email
    FROM promo_code_redemptions r
    JOIN users u ON u.id = r.user_id
    WHERE r.promo_code_id = $1
    ORDER BY r.redeemed_at DESC
  `, [promoCodeId]);
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    email: row.email,
    redeemedAt: row.redeemed_at
  }));
}

// Race-safe redemption for credit_grant codes.
//
// This has to be at least two statements, not one. A single
// `WITH locked_code AS (SELECT ... FOR UPDATE) INSERT ... WHERE (SELECT COUNT(*) ...) < cap`
// looks atomic but isn't: it's one statement, so under READ COMMITTED it runs
// against one snapshot taken at statement start. When two transactions race, the
// loser blocks on the FOR UPDATE; once the winner commits and the loser is
// unblocked, Postgres's EvalPlanQual re-fetches only the specific locked
// promo_codes row, not the whole statement's snapshot -- the COUNT(*) subquery
// over promo_code_redemptions is a separate part of that same statement and
// still sees the pre-block snapshot, which doesn't yet include the winner's
// just-committed redemption row. Both transactions see count=0 and both insert.
// (Caught by scripts/promo-code-redemption-race-test.js: failed 20/20 runs, not
// flaky -- this was a systematic bug, not an occasional race.)
//
// The fix is to make the count its own statement, issued only after the lock is
// confirmed held: each statement gets its own fresh READ COMMITTED snapshot, so
// by the time this transaction gets the lock, its COUNT is guaranteed to see
// everything the previous lock-holder committed.
export async function redeemCreditGrantCode({ code, userId }) {
  return transaction(async (client) => {
    const lockedCode = await client.query(`
      SELECT id, credit_quantity, max_redemptions
      FROM promo_codes
      WHERE code = $1
        AND type = 'credit_grant'
        AND active = true
        AND (expires_at IS NULL OR expires_at > now())
      FOR UPDATE
    `, [code]);

    const promo = lockedCode.rows[0];
    if (!promo) {
      return { redeemed: false, reason: await classifyRedemptionFailure(client, code) };
    }

    // Checked before the cap so a user retrying a code they already hold is told that,
    // not "limit reached", when their own redemption is what filled the code. Runs under
    // the lock, so it sees every redemption committed by previous lock-holders.
    const existingRedemption = await client.query(
      "SELECT 1 FROM promo_code_redemptions WHERE promo_code_id = $1 AND user_id = $2",
      [promo.id, userId]
    );
    if (existingRedemption.rows[0]) {
      return { redeemed: false, reason: "already_redeemed" };
    }

    const countResult = await client.query(
      "SELECT COUNT(*)::int AS count FROM promo_code_redemptions WHERE promo_code_id = $1",
      [promo.id]
    );
    if (Number(countResult.rows[0].count) >= Number(promo.max_redemptions)) {
      return { redeemed: false, reason: "redemption_cap_reached" };
    }

    const insertResult = await client.query(`
      INSERT INTO promo_code_redemptions (id, promo_code_id, user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (promo_code_id, user_id) DO NOTHING
      RETURNING id
    `, [createId("promor"), promo.id, userId]);

    if (!insertResult.rows[0]) {
      return { redeemed: false, reason: "already_redeemed" };
    }

    const quantity = Number(promo.credit_quantity);
    await grantUnlockCredits(
      userId, quantity, `promo:${promo.id}:${userId}`, "promo_code", client
    );

    return { redeemed: true, quantity, redemptionId: insertResult.rows[0].id, promoCodeId: promo.id };
  });
}

export async function recordStripeDiscountRedemption({ stripePromotionCodeId, userId }) {
  const result = await query(`
    INSERT INTO promo_code_redemptions (id, promo_code_id, user_id)
    SELECT $1, pc.id, $2
    FROM promo_codes pc
    WHERE pc.stripe_promotion_code_id = $3 AND pc.type = 'stripe_discount'
    ON CONFLICT (promo_code_id, user_id) DO NOTHING
    RETURNING id
  `, [createId("promor"), userId, stripePromotionCodeId]);
  return Boolean(result.rows[0]);
}

// Only called when the FOR UPDATE lookup above found no matching row, so the
// cap/already-redeemed cases (which need that row) can't apply here -- this is
// purely distinguishing invalid/disabled/expired for the user-facing message.
async function classifyRedemptionFailure(client, code) {
  const codeResult = await client.query(`
    SELECT type, active, expires_at FROM promo_codes WHERE code = $1
  `, [code]);
  const promo = codeResult.rows[0];
  if (!promo || promo.type !== "credit_grant") return "invalid_code";
  if (!promo.active) return "code_disabled";
  if (promo.expires_at && new Date(promo.expires_at).getTime() <= Date.now()) return "code_expired";
  return "invalid_code";
}

function mapPromoCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    maxRedemptions: Number(row.max_redemptions),
    expiresAt: row.expires_at,
    active: row.active,
    createdByAdminId: row.created_by_admin_id,
    createdAt: row.created_at,
    stripeCouponId: row.stripe_coupon_id,
    stripePromotionCodeId: row.stripe_promotion_code_id,
    discountPercentOff: row.discount_percent_off !== null ? Number(row.discount_percent_off) : null,
    discountAmountOffCents: row.discount_amount_off_cents !== null ? Number(row.discount_amount_off_cents) : null,
    creditQuantity: row.credit_quantity !== null ? Number(row.credit_quantity) : null
  };
}
