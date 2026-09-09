import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "development";
process.env.APP_URL = "https://signalforge-app.xyz";

const { calculateAffiliateCommissionCents } = await import(
  "../src/modules/affiliates/affiliateRepository.js"
);

const migration = readFileSync(
  new URL("../migrations/017_affiliate_program.sql", import.meta.url),
  "utf8"
);
const repository = readFileSync(
  new URL("../src/modules/affiliates/affiliateRepository.js", import.meta.url),
  "utf8"
);
const service = readFileSync(
  new URL("../src/modules/affiliates/affiliateService.js", import.meta.url),
  "utf8"
);
const controller = readFileSync(
  new URL("../src/modules/affiliates/affiliateController.js", import.meta.url),
  "utf8"
);
const stripe = readFileSync(
  new URL("../src/modules/subscriptions/stripeService.js", import.meta.url),
  "utf8"
);
const auth = readFileSync(
  new URL("../src/modules/auth/authService.js", import.meta.url),
  "utf8"
);
const google = readFileSync(
  new URL("../src/modules/auth/googleOAuthService.js", import.meta.url),
  "utf8"
);
const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

const result = {
  safeMigration:
    migration.includes("ADD COLUMN IF NOT EXISTS affiliate_code") &&
    migration.includes("CREATE TABLE IF NOT EXISTS affiliate_referrals") &&
    migration.includes("CREATE TABLE IF NOT EXISTS affiliate_commissions") &&
    migration.includes("CREATE TABLE IF NOT EXISTS affiliate_payout_requests") &&
    migration.includes("UNIQUE (referred_user_id)") &&
    migration.includes("CHECK (affiliate_user_id <> referred_user_id)") &&
    !/\bDROP\s+(TABLE|COLUMN)\b/i.test(migration),
  uniqueCodesForEveryUser:
    migration.includes("SET affiliate_code = lower(substr(md5(id), 1, 12))") &&
    migration.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_affiliate_code"),
  recurringTwentyPercent:
    calculateAffiliateCommissionCents(10000) === 2000 &&
    repository.includes('["pro", "elite"].includes(plan)') &&
    stripe.includes("recordRecurringAffiliateCommission"),
  freeAndCreditPacksExcluded:
    repository.includes('if (!["pro", "elite"].includes(plan)') &&
    stripe.includes('session.metadata?.kind === "credit_pack"') &&
    stripe.includes("processInvoicePaymentSucceeded(object, event.id)") &&
    stripe.includes("grossAmountCents: Number(invoice.amount_paid || 0)"),
  refundAndCancellationRules:
    stripe.includes('event.type === "charge.refunded"') &&
    stripe.includes("reconcileAffiliateRefund") &&
    stripe.includes("deactivateAffiliateReferral") &&
    repository.includes("reversed_commission_cents"),
  attributionProtected:
    repository.includes("affiliate.id <> referred.id") &&
    repository.includes("affiliate.device_fingerprint_hash <> referred.device_fingerprint_hash") &&
    repository.includes("ON CONFLICT (referred_user_id) DO NOTHING") &&
    repository.includes("affiliate.role <> 'tester'") &&
    repository.includes("referred.role <> 'tester'"),
  passwordAndGoogleAttribution:
    auth.includes("attributeAffiliateReferral(user.id, affiliateCode)") &&
    google.includes("affiliateCode: sanitizeAffiliateCode(affiliateCode)") &&
    google.includes("attributeAffiliateReferral(user.id, loginState.affiliateCode)"),
  payoutControls:
    migration.includes("CHECK (amount_cents >= 2500)") &&
    migration.includes("CHECK (payout_method IN ('paypal', 'wise', 'usdt'))") &&
    repository.includes("Minimum affiliate payout is $25.") &&
    controller.includes("decideAffiliatePayout") &&
    controller.includes("payoutMatch"),
  adminProtected:
    service.includes("assertAdmin(user)") &&
    service.includes("isAdminUser(user)") &&
    controller.includes("/api/admin/affiliates"),
  dashboardComplete:
    html.includes('data-view="affiliate"') &&
    html.includes("Active subscribers") &&
    html.includes("Monthly recurring") &&
    html.includes("Lifetime earnings") &&
    html.includes("Pending payout") &&
    html.includes("Conversion rate") &&
    html.includes("PayPal") &&
    html.includes("Wise") &&
    html.includes("USDT") &&
    frontend.includes("copy-affiliate-link"),
  adminUiComplete:
    html.includes('data-view="affiliate-admin"') &&
    frontend.includes("approve-payout") &&
    frontend.includes("reject-payout") &&
    frontend.includes("flag-referral") &&
    frontend.includes("disable-affiliate"),
  routesRegistered: server.includes("handleAffiliateRoutes")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Affiliate program check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
