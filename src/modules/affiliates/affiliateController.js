import { readJson, sendError, sendJson } from "../../shared/http.js";
import {
  decideAffiliatePayout,
  disableAffiliate,
  flagAffiliateReferral,
  getAffiliateAdmin,
  getMyAffiliateDashboard,
  requestAffiliatePayout,
  trackAffiliateClick
} from "./affiliateService.js";

export async function handleAffiliateRoutes(req, res, pathname) {
  if (pathname === "/api/affiliates/click" && req.method === "POST") {
    try {
      return sendJson(res, 200, await trackAffiliateClick(await readJson(req)));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (!pathname.startsWith("/api/affiliates") && !pathname.startsWith("/api/admin/affiliates")) {
    return false;
  }
  if (!req.user) return sendError(res, 401, "Authentication required.");

  try {
    if (pathname === "/api/affiliates/me" && req.method === "GET") {
      return sendJson(res, 200, await getMyAffiliateDashboard(req.user));
    }
    if (pathname === "/api/affiliates/payouts" && req.method === "POST") {
      return sendJson(res, 201, await requestAffiliatePayout(req.user, await readJson(req)));
    }
    if (pathname === "/api/admin/affiliates" && req.method === "GET") {
      return sendJson(res, 200, await getAffiliateAdmin(req.user));
    }

    const payoutMatch = pathname.match(/^\/api\/admin\/affiliates\/payouts\/([^/]+)$/);
    if (payoutMatch && req.method === "POST") {
      const body = await readJson(req);
      return sendJson(
        res,
        200,
        await decideAffiliatePayout(req.user, payoutMatch[1], body.decision)
      );
    }

    const referralMatch = pathname.match(/^\/api\/admin\/affiliates\/referrals\/([^/]+)$/);
    if (referralMatch && req.method === "POST") {
      return sendJson(
        res,
        200,
        await flagAffiliateReferral(req.user, referralMatch[1], await readJson(req))
      );
    }

    const accountMatch = pathname.match(/^\/api\/admin\/affiliates\/accounts\/([^/]+)$/);
    if (accountMatch && req.method === "POST") {
      const body = await readJson(req);
      return sendJson(
        res,
        200,
        await disableAffiliate(req.user, accountMatch[1], body.disabled !== false)
      );
    }
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message);
  }

  return false;
}
