import { createId } from "../../shared/ids.js";
import {
  createPromoCode as insertPromoCode,
  getPromoCodeById,
  listPromoCodesWithCounts,
  listRedemptions,
  redeemCreditGrantCode,
  setPromoCodeActive
} from "./promoCodeRepository.js";
import {
  createPromoCoupon,
  createPromoPromotionCode,
  deletePromoCoupon,
  updatePromoPromotionCodeActive
} from "../subscriptions/stripeService.js";

const redemptionFailureMessages = {
  invalid_code: "That promo code doesn't exist.",
  code_disabled: "That promo code is no longer active.",
  code_expired: "That promo code has expired.",
  already_redeemed: "You've already redeemed this code.",
  redemption_cap_reached: "That promo code has reached its redemption limit."
};

export async function createPromoCode(admin, input) {
  const code = normalizeCode(input.code);
  if (!code) throw validationError("A promo code string is required.");

  const maxRedemptions = Number(input.maxRedemptions);
  if (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0) {
    throw validationError("Max redemptions must be a positive integer.");
  }
  const expiresAt = parseExpiresAt(input.expiresAt);

  if (input.type === "stripe_discount") {
    return createStripeDiscountCode(admin, { code, maxRedemptions, expiresAt, input });
  }
  if (input.type === "credit_grant") {
    return createCreditGrantCode(admin, { code, maxRedemptions, expiresAt, input });
  }
  throw validationError("Promo code type must be 'stripe_discount' or 'credit_grant'.");
}

async function createStripeDiscountCode(admin, { code, maxRedemptions, expiresAt, input }) {
  const percentOff = numberOrNull(input.discountPercentOff);
  const amountOffCents = numberOrNull(input.discountAmountOffCents);
  if (!percentOff && !amountOffCents) {
    throw validationError("Provide either a percent-off or amount-off discount.");
  }
  if (percentOff && amountOffCents) {
    throw validationError("Provide only one of percent-off or amount-off, not both.");
  }

  const coupon = await createPromoCoupon({ percentOff, amountOffCents, maxRedemptions, expiresAt });
  let promotionCode;
  try {
    promotionCode = await createPromoPromotionCode({
      couponId: coupon.id, code, maxRedemptions, expiresAt
    });
  } catch (error) {
    await deleteOrphanedCoupon(coupon.id, error);
    throw error;
  }

  return insertPromoCode({
    id: createId("promo"), code, type: "stripe_discount", maxRedemptions, expiresAt,
    createdByAdminId: admin.id,
    stripeCouponId: coupon.id, stripePromotionCodeId: promotionCode.id,
    discountPercentOff: percentOff, discountAmountOffCents: amountOffCents,
    creditQuantity: null
  });
}

// Best-effort: the coupon is useless without its promotion code. A failed cleanup is
// logged and swallowed so the admin still sees why the promotion code failed.
async function deleteOrphanedCoupon(couponId, cause) {
  try {
    await deletePromoCoupon(couponId);
    console.warn(`[promo-codes] deleted orphaned Stripe coupon=${couponId} after promotion code failure: ${cause.message}`);
  } catch (cleanupError) {
    console.error(
      `[promo-codes] orphaned Stripe coupon=${couponId} could not be deleted; remove it in the Stripe dashboard. ` +
      `promotion_code_error=${cause.message} cleanup_error=${cleanupError.message}`
    );
  }
}

async function createCreditGrantCode(admin, { code, maxRedemptions, expiresAt, input }) {
  const creditQuantity = Number(input.creditQuantity);
  if (!Number.isInteger(creditQuantity) || creditQuantity <= 0) {
    throw validationError("Credit quantity must be a positive integer.");
  }

  return insertPromoCode({
    id: createId("promo"), code, type: "credit_grant", maxRedemptions, expiresAt,
    createdByAdminId: admin.id,
    stripeCouponId: null, stripePromotionCodeId: null,
    discountPercentOff: null, discountAmountOffCents: null,
    creditQuantity
  });
}

export async function listPromoCodes() {
  return listPromoCodesWithCounts();
}

export async function getPromoCodeRedemptions(id) {
  const promo = await getPromoCodeById(id);
  if (!promo) throw notFoundError("Promo code not found.");
  return listRedemptions(id);
}

export async function setPromoCodeActiveState(id, active) {
  const promo = await getPromoCodeById(id);
  if (!promo) throw notFoundError("Promo code not found.");

  // Toggle Stripe's own object first: if that fails, the DB row is left untouched
  // rather than showing an active state Stripe itself disagrees with.
  if (promo.type === "stripe_discount" && promo.stripePromotionCodeId) {
    await updatePromoPromotionCodeActive(promo.stripePromotionCodeId, active);
  }
  return setPromoCodeActive(id, active);
}

export async function redeemPromoCode(user, codeInput) {
  const code = normalizeCode(codeInput);
  if (!code) throw validationError("Enter a promo code.");

  const result = await redeemCreditGrantCode({ code, userId: user.id });
  if (!result.redeemed) {
    throw validationError(redemptionFailureMessages[result.reason] || "This promo code can't be redeemed.");
  }
  return result;
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().slice(0, 40);
}

function parseExpiresAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw validationError("Invalid expiry date.");
  return date;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function notFoundError(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}
