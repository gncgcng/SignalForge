import { readJson, sendError, sendJson } from "../../shared/http.js";
import { isAdminUser } from "../auth/authService.js";
import {
  createPromoCode,
  getPromoCodeRedemptions,
  listPromoCodes,
  setPromoCodeActiveState
} from "./promoCodeService.js";

export async function handlePromoCodeRoutes(req, res, pathname) {
  // Unlock credits are retired with the single plan, so credit-grant codes can no longer be redeemed.
  if (pathname === "/api/promo-codes/redeem" && req.method === "POST") {
    if (!req.user) return sendError(res, 401, "Authentication required.");
    return sendError(res, 410, "Promo codes for unlock credits are no longer available. SignalForge now has one plan with a 7-day free trial.", { code: "PROMO_CREDITS_RETIRED" });
  }

  if (!pathname.startsWith("/api/admin/promo-codes")) return false;
  if (!req.user) return sendError(res, 401, "Authentication required.");
  if (!isAdminUser(req.user)) return sendError(res, 403, "Admin access required.");

  try {
    if (pathname === "/api/admin/promo-codes" && req.method === "POST") {
      const body = await readJson(req);
      const promoCode = await createPromoCode(req.user, body);
      return sendJson(res, 201, { promoCode: toAdminPromoCode(promoCode) });
    }

    if (pathname === "/api/admin/promo-codes" && req.method === "GET") {
      return sendJson(res, 200, { promoCodes: (await listPromoCodes()).map(toAdminPromoCode) });
    }

    const redemptionsMatch = pathname.match(/^\/api\/admin\/promo-codes\/([^/]+)\/redemptions$/);
    if (redemptionsMatch && req.method === "GET") {
      const redemptions = await getPromoCodeRedemptions(redemptionsMatch[1]);
      return sendJson(res, 200, { redemptions: redemptions.map(({ id, email, redeemedAt }) => ({ id, email, redeemedAt })) });
    }

    const detailMatch = pathname.match(/^\/api\/admin\/promo-codes\/([^/]+)$/);
    if (detailMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const promoCode = await setPromoCodeActiveState(detailMatch[1], Boolean(body.active));
      return sendJson(res, 200, { promoCode: toAdminPromoCode(promoCode) });
    }
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message);
  }

  return false;
}

// Admin responses never carry Stripe object ids or internal user ids; the UI has no use for
// them and they'd otherwise be visible in the browser's network panel.
function toAdminPromoCode(promo) {
  if (!promo) return null;
  return {
    id: promo.id,
    code: promo.code,
    type: promo.type,
    maxRedemptions: promo.maxRedemptions,
    redemptionCount: promo.redemptionCount ?? 0,
    expiresAt: promo.expiresAt,
    active: promo.active,
    createdAt: promo.createdAt,
    discountPercentOff: promo.discountPercentOff,
    discountAmountOffCents: promo.discountAmountOffCents,
    creditQuantity: promo.creditQuantity
  };
}
