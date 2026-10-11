import { appConfig } from "../../config/appConfig.js";
import { BILLING_PLANS } from "../subscriptions/subscriptionService.js";
import {
  buildAdminSupportNoticeEmail,
  buildAffiliateCommissionEmail,
  buildFailedPaymentEmail,
  buildPasswordResetEmail,
  buildSubscriptionConfirmationEmail,
  buildSupportConfirmationEmail,
  buildWelcomeEmail
} from "./emailTemplates.js";

const resendEmailEndpoint = "https://api.resend.com/emails";

export async function sendTransactionalEmail({ to, subject, html, text, category = "transactional" }) {
  const recipient = String(to || "").trim().toLowerCase();
  if (!recipient || !subject || (!html && !text)) {
    return { delivered: false, skipped: true, reason: "missing_email_fields" };
  }

  if (!appConfig.email.featuresEnabled) {
    console.info(`[email] skipped category=${safeCategory(category)} features_enabled=false`);
    return { delivered: false, skipped: true, reason: "email_features_disabled" };
  }

  if (!appConfig.abuseProtection.resendApiKey) {
    if (!appConfig.isProduction) {
      console.info(`[email] Development ${category} email to=${maskEmail(recipient)} subject=${safeSubject(subject)}`);
    } else {
      console.warn(`[email] Transactional email provider missing category=${safeCategory(category)} to=${maskEmail(recipient)}`);
    }
    return { delivered: false, skipped: true, reason: "provider_not_configured" };
  }

  try {
    const response = await fetch(resendEmailEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appConfig.abuseProtection.resendApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: appConfig.abuseProtection.emailFrom,
        to: [recipient],
        subject,
        html,
        text
      })
    });

    if (!response.ok) {
      console.warn(
        `[email] Send failed category=${safeCategory(category)} to=${maskEmail(recipient)} ` +
        `status=${response.status}`
      );
      return { delivered: false, skipped: false, reason: "provider_error" };
    }

    console.info(`[email] Sent category=${safeCategory(category)} to=${maskEmail(recipient)}`);
    return { delivered: true, skipped: false, reason: null };
  } catch (error) {
    console.warn(
      `[email] Send failed category=${safeCategory(category)} to=${maskEmail(recipient)} ` +
      `error=${safeError(error)}`
    );
    return { delivered: false, skipped: false, reason: "send_failed" };
  }
}

function sendTemplate(to, category, email) {
  return sendTransactionalEmail({ to, category, ...email });
}

// Only once the account is verified: after the verification link (email signups) or at signup
// (Google). trialGranted picks the copy, so it never promises unlocks the account doesn't have.
export function sendWelcomeEmail(user, { trialGranted = true } = {}) {
  return sendTemplate(user.email, "welcome", buildWelcomeEmail({ username: user.username, trialGranted }));
}

export function sendPasswordResetEmail(user, resetUrl, { expiresInMinutes = 60 } = {}) {
  return sendTemplate(user.email, "password_reset", buildPasswordResetEmail({ resetUrl, expiresInMinutes }));
}

export function sendSubscriptionConfirmationEmail(user, plan) {
  const details = BILLING_PLANS[plan];
  return sendTemplate(user.email, "subscription_confirmation", buildSubscriptionConfirmationEmail({
    planName: details?.name || planLabel(plan),
    monthlyUnlockGrant: details?.monthlyUnlockGrant || 0
  }));
}

export function sendFailedPaymentEmail(user) {
  return sendTemplate(user.email, "failed_payment", buildFailedPaymentEmail());
}

export function sendAffiliateCommissionEmail(user, { plan, commissionCents }) {
  return sendTemplate(user.email, "affiliate_commission", buildAffiliateCommissionEmail({
    planName: BILLING_PLANS[plan]?.name || planLabel(plan),
    commissionCents
  }));
}

export function sendSupportConfirmationEmail(user, ticket) {
  return sendTemplate(user.email, "support_confirmation", buildSupportConfirmationEmail({
    username: user.username,
    ticketId: ticket.id,
    ticketSubject: ticket.subject
  }));
}

export function sendSupportAdminNotificationEmail(email, ticket) {
  return sendTemplate(email, "support_admin_notification", buildAdminSupportNoticeEmail({
    ticketId: ticket.id,
    ticketSubject: ticket.subject,
    topic: ticket.topic,
    priority: ticket.priority
  }));
}

function planLabel(plan) {
  const value = String(plan || "paid");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function maskEmail(email = "") {
  const [name, domain] = String(email).split("@");
  if (!domain) return "***";
  return `${name.slice(0, 2)}***@${domain}`;
}

function safeSubject(subject) {
  return String(subject || "").replace(/[^\w .:!?-]/g, "").slice(0, 120);
}

function safeCategory(category) {
  return String(category || "transactional").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
}

function safeError(error) {
  return String(error?.message || "unknown")
    .replace(/\b(?:re|r)_[A-Za-z0-9_]+\b/g, "[redacted-key]")
    .slice(0, 180);
}
