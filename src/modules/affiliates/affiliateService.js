import { isAdminUser } from "../auth/authService.js";
import {
  createAffiliatePayoutRequest,
  getAffiliateAdminDashboard,
  getAffiliateDashboard,
  recordAffiliateClick,
  reviewAffiliatePayout,
  setAffiliateDisabled,
  setAffiliateReferralSuspicious
} from "./affiliateRepository.js";

const payoutMethods = new Set(["paypal", "wise", "usdt"]);

export async function getMyAffiliateDashboard(user) {
  return { affiliate: await getAffiliateDashboard(user.id) };
}

export async function trackAffiliateClick({ affiliateCode, visitorId }) {
  return {
    tracked: await recordAffiliateClick(
      sanitizeAffiliateCode(affiliateCode),
      sanitizeVisitorId(visitorId)
    )
  };
}

export async function requestAffiliatePayout(user, body) {
  const payoutMethod = String(body.payoutMethod || "").toLowerCase();
  const payoutDestination = String(body.payoutDestination || "").trim();
  if (!payoutMethods.has(payoutMethod)) {
    throw affiliateError("Choose PayPal, Wise, or USDT.", 400);
  }
  if (payoutDestination.length < 3 || payoutDestination.length > 240) {
    throw affiliateError("Enter a valid payout destination.", 400);
  }
  return {
    payout: await createAffiliatePayoutRequest(user.id, {
      payoutMethod,
      payoutDestination
    }),
    affiliate: await getAffiliateDashboard(user.id)
  };
}

export async function getAffiliateAdmin(user) {
  assertAdmin(user);
  return { affiliateAdmin: await getAffiliateAdminDashboard() };
}

export async function decideAffiliatePayout(user, requestId, decision) {
  assertAdmin(user);
  if (!["approved", "rejected"].includes(decision)) {
    throw affiliateError("Decision must be approved or rejected.", 400);
  }
  const payout = await reviewAffiliatePayout(requestId, user.id, decision);
  if (!payout) throw affiliateError("Pending payout request not found.", 404);
  return { payout, affiliateAdmin: await getAffiliateAdminDashboard() };
}

export async function flagAffiliateReferral(user, referralId, body) {
  assertAdmin(user);
  const referral = await setAffiliateReferralSuspicious(
    referralId,
    body.suspicious !== false,
    String(body.reason || "").trim().slice(0, 240)
  );
  if (!referral) throw affiliateError("Affiliate referral not found.", 404);
  return { referral, affiliateAdmin: await getAffiliateAdminDashboard() };
}

export async function disableAffiliate(user, affiliateUserId, disabled) {
  assertAdmin(user);
  const account = await setAffiliateDisabled(affiliateUserId, disabled);
  if (!account) throw affiliateError("Affiliate account not found.", 404);
  return { account, affiliateAdmin: await getAffiliateAdminDashboard() };
}

function assertAdmin(user) {
  if (!isAdminUser(user)) throw affiliateError("Admin access required.", 403);
}

function sanitizeAffiliateCode(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

function sanitizeVisitorId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
}

function affiliateError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
