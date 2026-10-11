// Every transactional email, rendered with sample data. Used by `npm run email:preview`,
// `npm run email:send-test` and scripts/email-templates-test.js.
import {
  appLink,
  buildAdminSupportNoticeEmail,
  buildAffiliateCommissionEmail,
  buildFailedPaymentEmail,
  buildPasswordResetEmail,
  buildSubscriptionConfirmationEmail,
  buildSupportConfirmationEmail,
  buildVerifyEmail,
  buildWelcomeEmail
} from "../../src/modules/notifications/emailTemplates.js";

export const TEMPLATE_NAMES = [
  "verify",
  "welcome",
  "password-reset",
  "subscription-confirmation",
  "failed-payment",
  "affiliate-commission",
  "support-confirmation",
  "admin-support-notice"
];

// One entry per template, plus the copy variants a user can actually receive.
export function emailSamples({ username = "trader_204815", ticketSubject = "Unlock didn't show the stop level" } = {}) {
  const token = "sample-verification-token";
  return [
    { name: "verify", template: "verify", email: buildVerifyEmail({ verificationUrl: appLink(`/?verify=${token}`), trialAvailable: true }) },
    { name: "verify-no-trial", template: "verify", email: buildVerifyEmail({ verificationUrl: appLink(`/?verify=${token}`), trialAvailable: false }) },
    { name: "welcome", template: "welcome", email: buildWelcomeEmail({ username, trialGranted: true }) },
    { name: "welcome-no-trial", template: "welcome", email: buildWelcomeEmail({ username, trialGranted: false }) },
    { name: "password-reset", template: "password-reset", email: buildPasswordResetEmail({ resetUrl: appLink("/?reset=sample-reset-token") }) },
    { name: "subscription-confirmation", template: "subscription-confirmation", email: buildSubscriptionConfirmationEmail({ planName: "Pro", monthlyUnlockGrant: 100 }) },
    { name: "failed-payment", template: "failed-payment", email: buildFailedPaymentEmail() },
    { name: "affiliate-commission", template: "affiliate-commission", email: buildAffiliateCommissionEmail({ planName: "Elite", commissionCents: 1980 }) },
    { name: "support-confirmation", template: "support-confirmation", email: buildSupportConfirmationEmail({ username, ticketId: "sup_8f2k1x", ticketSubject }) },
    { name: "admin-support-notice", template: "admin-support-notice", email: buildAdminSupportNoticeEmail({ ticketId: "sup_8f2k1x", ticketSubject, topic: "Billing", priority: "urgent" }) }
  ];
}
