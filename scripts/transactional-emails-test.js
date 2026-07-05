import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const emailService = readFileSync(
  new URL("../src/modules/notifications/transactionalEmailService.js", import.meta.url),
  "utf8"
);
const authService = readFileSync(
  new URL("../src/modules/auth/authService.js", import.meta.url),
  "utf8"
);
const authController = readFileSync(
  new URL("../src/modules/auth/authController.js", import.meta.url),
  "utf8"
);
const googleOAuth = readFileSync(
  new URL("../src/modules/auth/googleOAuthService.js", import.meta.url),
  "utf8"
);
const repositories = readFileSync(
  new URL("../src/db/repositories.js", import.meta.url),
  "utf8"
);
const stripeService = readFileSync(
  new URL("../src/modules/subscriptions/stripeService.js", import.meta.url),
  "utf8"
);
const affiliateRepository = readFileSync(
  new URL("../src/modules/affiliates/affiliateRepository.js", import.meta.url),
  "utf8"
);
const frontend = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/028_transactional_emails_password_reset.sql", import.meta.url),
  "utf8"
);

const result = {
  resendProviderConfiguredByEnv:
    envExample.includes("RESEND_API_KEY=") &&
    envExample.includes("EMAIL_FROM=") &&
    emailService.includes("https://api.resend.com/emails") &&
    emailService.includes("appConfig.abuseProtection.resendApiKey"),
  safeFailureLogging:
    emailService.includes("provider_not_configured") &&
    emailService.includes("maskEmail") &&
    emailService.includes("return { delivered: false") &&
    !emailService.includes("unsubscribe"),
  transactionalTemplatesOnly:
    emailService.includes("sendWelcomeEmail") &&
    emailService.includes("sendPasswordResetEmail") &&
    emailService.includes("sendSubscriptionConfirmationEmail") &&
    emailService.includes("sendFailedPaymentEmail") &&
    emailService.includes("sendAffiliateCommissionEmail") &&
    emailService.includes("Educational tool only. Not financial advice."),
  passwordResetStorageAndHashing:
    migration.includes("CREATE TABLE IF NOT EXISTS password_reset_tokens") &&
    repositories.includes("createPasswordResetToken") &&
    repositories.includes("resetPasswordWithToken") &&
    authService.includes("hashPasswordResetToken") &&
    authService.includes("createHmac"),
  passwordResetRoutesAndUi:
    authController.includes("/api/auth/password-reset/request") &&
    authController.includes("/api/auth/password-reset/confirm") &&
    html.includes("password-reset-request-form") &&
    html.includes("password-reset-confirm-form") &&
    frontend.includes("/api/auth/password-reset/request") &&
    frontend.includes("/api/auth/password-reset/confirm") &&
    frontend.includes("getPasswordResetToken"),
  welcomeEmailOnSignup:
    authService.includes("sendWelcomeEmail(user)") &&
    googleOAuth.includes("sendWelcomeEmail(user)") &&
    authService.includes("trackProductEvent") &&
    googleOAuth.includes("authProvider: \"google\""),
  stripeTransactionalEmails:
    stripeService.includes("invoice.payment_failed") &&
    stripeService.includes("sendSubscriptionConfirmationEmail(user, planId)") &&
    stripeService.includes("sendFailedPaymentEmail(user)") &&
    stripeService.includes("sendAffiliateCommissionEmail") &&
    stripeService.includes("processInvoicePaymentFailed"),
  affiliateCommissionEmailHasRecipient:
    affiliateRepository.includes("affiliate.email AS affiliate_email") &&
    affiliateRepository.includes("affiliateUser") &&
    affiliateRepository.includes("commission_amount_cents")
};

for (const [name, passed] of Object.entries(result)) {
  assert.equal(passed, true, `Transactional email check failed: ${name}`);
}

console.log(JSON.stringify(result, null, 2));
